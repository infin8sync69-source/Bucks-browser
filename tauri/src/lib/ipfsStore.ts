import { writable, get } from 'svelte/store';
import { invoke } from '@tauri-apps/api/core';

export type IpfsNodeState = 'idle' | 'initializing' | 'ready' | 'error';

export interface IpfsStatus {
    state: IpfsNodeState;
    source: string;
    message: string;
    api_url?: string | null;
    gateway_url?: string | null;
    embedded: boolean;
}

export interface IpfsPinEntry {
    cid: string;
    pin_type: string;
}

export interface IpfsNodeInfo {
    peer_id: string;
    addresses: string[];
    agent_version: string;
}

export interface IpfsUploadResult {
    cid: string;
    ipfs_uri: string;
    gateway_url: string;
}

interface IpfsStoreState {
    status: IpfsStatus | null;
    nodeInfo: IpfsNodeInfo | null;
    pins: IpfsPinEntry[];
    isLoadingPins: boolean;
}

function createIpfsStore() {
    const { subscribe, update } = writable<IpfsStoreState>({
        status: null,
        nodeInfo: null,
        pins: [],
        isLoadingPins: false,
    });

    let pollTimer: ReturnType<typeof setTimeout> | null = null;

    async function refreshStatus() {
        try {
            const status = await invoke<IpfsStatus>('get_ipfs_runtime_status');
            update(s => ({ ...s, status }));

            if (status.state === 'initializing') {
                pollTimer = setTimeout(refreshStatus, 1500);
            } else if (status.state === 'ready') {
                try {
                    const nodeInfo = await invoke<IpfsNodeInfo>('ipfs_node_info');
                    update(s => ({ ...s, nodeInfo }));
                } catch { /* non-critical */ }
            }
        } catch (e) {
            update(s => ({
                ...s,
                status: {
                    state: 'error',
                    source: 'unknown',
                    message: String(e),
                    embedded: true,
                },
            }));
        }
    }

    async function listPins() {
        update(s => ({ ...s, isLoadingPins: true }));
        try {
            const pins = await invoke<IpfsPinEntry[]>('ipfs_pin_ls');
            update(s => ({ ...s, pins, isLoadingPins: false }));
        } catch {
            update(s => ({ ...s, isLoadingPins: false }));
        }
    }

    async function uploadFile(file: File): Promise<IpfsUploadResult> {
        const dataUrl = await new Promise<string>((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(reader.result as string);
            reader.onerror = reject;
            reader.readAsDataURL(file);
        });

        return invoke<IpfsUploadResult>('ipfs_add_file', {
            args: {
                fileName: file.name,
                mimeType: file.type || 'application/octet-stream',
                dataBase64: dataUrl,
            },
        });
    }

    async function publishText(content: string): Promise<IpfsUploadResult & { status: string }> {
        const raw = await invoke<string>('publish_ipfs', { content });
        return JSON.parse(raw);
    }

    async function pinCid(cid: string): Promise<void> {
        await invoke('ipfs_pin_add', { cid });
        await listPins();
    }

    async function unpinCid(cid: string): Promise<void> {
        await invoke('ipfs_pin_rm', { cid });
        update(s => ({ ...s, pins: s.pins.filter(p => p.cid !== cid) }));
    }

    async function catCid(cid: string): Promise<string> {
        const b64 = await invoke<string>('ipfs_cat', { cid });
        const binary = atob(b64);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
        return new TextDecoder().decode(bytes);
    }

    return {
        subscribe,
        init() {
            refreshStatus();
        },
        refreshStatus,
        listPins,
        uploadFile,
        publishText,
        pinCid,
        unpinCid,
        catCid,
        cleanup() {
            if (pollTimer) clearTimeout(pollTimer);
        },
    };
}

export const ipfsStore = createIpfsStore();
