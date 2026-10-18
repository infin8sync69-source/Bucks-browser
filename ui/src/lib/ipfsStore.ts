/**
 * IPFS state for the chrome, backed by `bucks.ipfs`. The status is fetched once on init and then
 * follows the main process' `onStatus` events (no polling).
 */
import { writable } from 'svelte/store';
import {
    bucks,
    type IpfsAddResult,
    type IpfsLsEntry,
    type IpfsNodeInfo,
    type IpfsPinEntry,
    type IpfsStats,
    type IpfsStatus,
} from './bridge';

export type { IpfsAddResult, IpfsLsEntry, IpfsNodeInfo, IpfsPinEntry, IpfsStats, IpfsStatus };
export type { IpfsNodeState } from './bridge';

interface IpfsStoreState {
    status: IpfsStatus | null;
    nodeInfo: IpfsNodeInfo | null;
    stats: IpfsStats | null;
    pins: IpfsPinEntry[];
    isLoadingPins: boolean;
}

function errorMessage(e: unknown): string {
    return e instanceof Error ? e.message : String(e);
}

/** Read a File as a data: URL (the main process accepts data URLs or raw base64). */
function readAsDataUrl(file: File): Promise<string> {
    return new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result as string);
        reader.onerror = () => reject(reader.error ?? new Error('Could not read the file'));
        reader.readAsDataURL(file);
    });
}

function base64ToBytes(b64: string): Uint8Array {
    const binary = atob(b64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
}

function createIpfsStore() {
    const { subscribe, update } = writable<IpfsStoreState>({
        status: null,
        nodeInfo: null,
        stats: null,
        pins: [],
        isLoadingPins: false,
    });

    let unsubscribe: (() => void) | null = null;
    let lastState: string | null = null;

    async function refreshNodeInfo() {
        try {
            const nodeInfo = await bucks.ipfs.nodeInfo();
            update((s) => ({ ...s, nodeInfo }));
        } catch {
            update((s) => ({ ...s, nodeInfo: null }));
        }
    }

    function applyStatus(status: IpfsStatus) {
        update((s) => ({ ...s, status }));
        if (status.state !== lastState) {
            lastState = status.state;
            if (status.state === 'ready') void refreshNodeInfo();
            else update((s) => ({ ...s, nodeInfo: null, stats: null }));
        }
    }

    async function refreshStatus() {
        try {
            applyStatus(await bucks.ipfs.status());
        } catch (e) {
            applyStatus({
                state: 'error',
                source: 'embedded_kubo',
                message: errorMessage(e),
                api_url: null,
                gateway_url: null,
                embedded: true,
                version: null,
                peer_id: null,
            });
        }
    }

    async function refreshStats(): Promise<IpfsStats | null> {
        try {
            const stats = await bucks.ipfs.stats();
            update((s) => ({ ...s, stats }));
            return stats;
        } catch {
            update((s) => ({ ...s, stats: null }));
            return null;
        }
    }

    async function listPins() {
        update((s) => ({ ...s, isLoadingPins: true }));
        try {
            const pins = await bucks.ipfs.pinLs();
            update((s) => ({ ...s, pins, isLoadingPins: false }));
        } catch {
            update((s) => ({ ...s, pins: [], isLoadingPins: false }));
        }
    }

    async function uploadFile(file: File): Promise<IpfsAddResult> {
        const dataBase64 = await readAsDataUrl(file);
        return bucks.ipfs.add({
            fileName: file.name,
            mimeType: file.type || 'application/octet-stream',
            dataBase64,
        });
    }

    function publishText(content: string, fileName?: string): Promise<IpfsAddResult> {
        return bucks.ipfs.addText(content, fileName);
    }

    async function pinCid(cid: string): Promise<void> {
        await bucks.ipfs.pinAdd(cid);
        await listPins();
    }

    async function unpinCid(cid: string): Promise<void> {
        await bucks.ipfs.pinRm(cid);
        update((s) => ({ ...s, pins: s.pins.filter((p) => p.cid !== cid) }));
    }

    /** Fetch content at an /ipfs path or CID and decode it as UTF-8 text. */
    async function catText(path: string, maxBytes?: number): Promise<string> {
        const b64 = await bucks.ipfs.cat(path, maxBytes ? { maxBytes } : undefined);
        return new TextDecoder().decode(base64ToBytes(b64));
    }

    function ls(path: string): Promise<IpfsLsEntry[]> {
        return bucks.ipfs.ls(path);
    }

    return {
        subscribe,
        /** Fetch the status once and follow `onStatus` from now on. Safe to call repeatedly. */
        init() {
            if (unsubscribe) return;
            unsubscribe = bucks.ipfs.onStatus(applyStatus);
            void refreshStatus();
        },
        refreshStatus,
        refreshNodeInfo,
        refreshStats,
        listPins,
        uploadFile,
        publishText,
        pinCid,
        unpinCid,
        catText,
        ls,
        /** Start (or restart) the embedded node. */
        start: () => bucks.ipfs.start(),
        stop: () => bucks.ipfs.stop(),
        peers: () => bucks.ipfs.peers(),
        cleanup() {
            unsubscribe?.();
            unsubscribe = null;
            lastState = null;
        },
    };
}

export const ipfsStore = createIpfsStore();
