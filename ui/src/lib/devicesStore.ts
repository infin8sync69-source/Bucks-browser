/**
 * Devices state for the chrome, backed by `bucks.devices` (pairing Bucks installs over IPFS peering
 * and pubsub, see docs/IPC-CONTRACT.md). The status is fetched once on init and then follows the
 * main process' `onUpdated` events. If the status cannot be fetched (node down, handler not
 * registered, old preload) the error is kept in `loadError` and the fetch is retried with backoff.
 *
 * Every action captures its error and resolves with an {@link ActionResult} instead of throwing,
 * so components can show the message inline.
 */
import { readable, writable, get } from 'svelte/store';
import {
    bucks,
    type DevicePairRequest,
    type DeviceShareRequest,
    type DeviceShareResult,
    type DevicesStatus,
} from './bridge';
import { errorMessage } from './format';
import { ipfsStore } from './ipfsStore';

export type {
    DevicesStatus,
    DeviceSelf,
    PairedDevice,
    DiscoveredDevice,
    ReceivedShare,
    DeviceShareResult,
} from './bridge';

export type DeviceAction = 'pair' | 'unpair' | 'rename' | 'share' | 'dismiss' | 'pin';

export type ActionResult<T> = { ok: true; value: T } | { ok: false; error: string };

export interface DevicesState {
    /** Last status received from the main process; null until the first successful fetch. */
    status: DevicesStatus | null;
    /** Why the status could not be fetched (cleared once a status arrives). */
    loadError: string | null;
    /** True while the first fetch is in flight. */
    loading: boolean;
    /** Most recent failed action, for a page-level notice. */
    lastError: { action: DeviceAction; message: string } | null;
}

const RETRY_MIN_MS = 3_000;
const RETRY_MAX_MS = 30_000;

/** Peer IDs are base58btc multihashes (12D3Koo…, Qm…) or CIDv1 libp2p keys (k51…, bafz…). */
const PEER_ID_RE = /^(?:12D3Koo[1-9A-HJ-NP-Za-km-z]{40,}|Qm[1-9A-HJ-NP-Za-km-z]{44}|k51[0-9a-z]{50,}|bafz[a-z2-7]{50,})$/;

/**
 * Validate what the user typed into "Pair manually": a peer ID or a pairing address
 * (`/ip4/…/tcp/…/p2p/<id>`). Returns the trimmed value or an error message.
 */
export function parsePairInput(raw: string): { ok: true; value: string; peerId: string } | { ok: false; error: string } {
    const value = raw.trim();
    if (!value) return { ok: false, error: 'Enter a peer ID or a pairing address.' };
    if (/\s/.test(value)) return { ok: false, error: 'A peer ID or pairing address cannot contain spaces.' };
    if (value.startsWith('/')) {
        const m = /\/p2p\/([^/]+)\/?$/.exec(value);
        if (!m) return { ok: false, error: 'A pairing address must end with /p2p/<peer ID>, e.g. /ip4/192.168.1.20/tcp/4001/p2p/12D3Koo…' };
        if (!PEER_ID_RE.test(m[1])) return { ok: false, error: `"${m[1]}" is not a valid peer ID.` };
        return { ok: true, value, peerId: m[1] };
    }
    if (!PEER_ID_RE.test(value)) {
        return { ok: false, error: 'That is not a peer ID (12D3Koo…) or a pairing address (/ip4/…/p2p/12D3Koo…).' };
    }
    return { ok: true, value, peerId: value };
}

/** Ticks every 15 s so "last seen" style relative times stay fresh without per-component timers. */
export const clock = readable(Date.now(), (set) => {
    const timer = setInterval(() => set(Date.now()), 15_000);
    return () => clearInterval(timer);
});

function createDevicesStore() {
    const store = writable<DevicesState>({ status: null, loadError: null, loading: false, lastError: null });
    const { subscribe, update } = store;

    let unsubscribe: (() => void) | null = null;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let retryDelay = RETRY_MIN_MS;
    let active = false;

    function apply(status: DevicesStatus) {
        retryDelay = RETRY_MIN_MS;
        if (retryTimer) {
            clearTimeout(retryTimer);
            retryTimer = null;
        }
        update((s) => ({ ...s, status, loadError: null, loading: false }));
    }

    function scheduleRetry() {
        if (!active || retryTimer) return;
        retryTimer = setTimeout(() => {
            retryTimer = null;
            void refresh();
        }, retryDelay);
        retryDelay = Math.min(retryDelay * 2, RETRY_MAX_MS);
    }

    /** Fetch the status now. Failures land in `loadError` and schedule a retry. */
    async function refresh(): Promise<DevicesStatus | null> {
        if (!bucks.devices) {
            update((s) => ({ ...s, loading: false, loadError: 'This build of Bucks Browser has no device pairing support (the preload bridge is out of date).' }));
            return null;
        }
        try {
            const status = await bucks.devices.status();
            apply(status);
            return status;
        } catch (e) {
            update((s) => ({ ...s, loading: false, loadError: `Could not load devices: ${errorMessage(e)}` }));
            scheduleRetry();
            return null;
        }
    }

    async function run<T>(action: DeviceAction, fn: () => Promise<T>, onValue?: (v: T) => void): Promise<ActionResult<T>> {
        try {
            if (!bucks.devices) throw new Error('Device pairing is not available in this build');
            const value = await fn();
            onValue?.(value);
            update((s) => (s.lastError?.action === action ? { ...s, lastError: null } : s));
            return { ok: true, value };
        } catch (e) {
            const message = errorMessage(e);
            update((s) => ({ ...s, lastError: { action, message } }));
            return { ok: false, error: message };
        }
    }

    return {
        subscribe,
        /** Fetch the status once and follow `onUpdated` from now on. Safe to call repeatedly. */
        init() {
            if (active) return;
            active = true;
            if (bucks.devices) unsubscribe = bucks.devices.onUpdated(apply);
            update((s) => ({ ...s, loading: s.status === null }));
            void refresh();
        },
        refresh,
        /** Pair with a device by peer ID or pairing address (optionally with its name and addrs). */
        pair: (req: DevicePairRequest) => run('pair', () => bucks.devices.pair(req), apply),
        unpair: (peerId: string) => run('unpair', () => bucks.devices.unpair(peerId), apply),
        /** Rename this device; '' resets it to the computer's host name. */
        rename: (name: string) => run('rename', () => bucks.devices.rename(name), apply),
        /** Offer a CID to every paired device (queued until they come online). */
        share: (req: DeviceShareRequest) => run<DeviceShareResult>('share', () => bucks.devices.share(req)),
        dismiss: (cid: string, from: string) => run('dismiss', () => bucks.devices.dismiss({ cid, from }), apply),
        /** Pin a received file on the local node, then refresh the pin list and the devices status. */
        pin: (cid: string) =>
            run('pin', async () => {
                await ipfsStore.pinCid(cid);
                await refresh();
            }),
        /** Forget the page-level error notice. */
        clearError() {
            update((s) => ({ ...s, lastError: null }));
        },
        /** Current snapshot. */
        current: () => get(store),
        cleanup() {
            active = false;
            unsubscribe?.();
            unsubscribe = null;
            if (retryTimer) clearTimeout(retryTimer);
            retryTimer = null;
            retryDelay = RETRY_MIN_MS;
        },
    };
}

export const devicesStore = createDevicesStore();
