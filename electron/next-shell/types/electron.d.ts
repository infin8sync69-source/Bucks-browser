export interface BucksAPI {
    // Window Controls
    minimize: () => void;
    maximize: () => void;
    close: () => void;

    // Settings
    getSettings: () => Promise<any>;
    saveSettings: (s: any) => Promise<any>;

    // Ad-blocker & Platform
    getBlockedCount: () => Promise<number>;
    toggleAdBlock: (enabled: boolean) => void;
    getPlatform: () => Promise<string>;

    // Wallet IPC
    onWalletAccessRequest: (callback: (data: any) => void) => void;
    respondToWalletAccess: (requestId: string, approved: boolean) => void;
    walletRPC: (params: { method: string; endpoint: string; body?: any }) => Promise<any>;

    // IPFS & Social IPC
    ipfsInfo: () => Promise<any>;
    ipfsPeers: () => Promise<any>;
    ipfsPublish: (content: any, metadata: any) => Promise<any>;
    ipfsFeed: () => Promise<any>;
    ipfsFollow: (peerId: string) => Promise<any>;
    ipfsUnfollow: (peerId: string) => Promise<any>;
    ipfsUpvote: (cid: string) => Promise<any>;
    ipfsGet: (cid: string) => Promise<any>;
    ipfsUnpin: (cid: string) => Promise<any>;
    ipfsStorageStats: () => Promise<any>;
    socialRPC: (params: any) => Promise<any>;
}

declare global {
    interface Window {
        bucksAPI?: BucksAPI;
    }
}
