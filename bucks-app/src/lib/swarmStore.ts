import { writable, get } from 'svelte/store';
import { isSwarmThinking, browserStore, activeTab } from './stores';

export interface A2UI {
    type: string;
    content?: string;
    url?: string;
    selector?: string;
    text?: string;
    action?: string;
    data?: any;
    language?: string;
    tabs?: { url: string; title: string }[];
    active_tab_index?: number;
    is_agent?: boolean;
}

export interface Message {
    role: "user" | "agent" | "error";
    content: string;
    a2ui?: A2UI | null;
    cid?: string | null;
    taskId?: string | null;
    ts: number;
}

declare global {
    interface Window {
        __TAURI__: {
            invoke: <T>(cmd: string, args?: any) => Promise<T>;
        };
    }
}

const invoke: (<T>(cmd: string, args?: any) => Promise<T>) | undefined = (window as any).__TAURI__?.invoke;

function isURL(text: string): boolean {
    return (
        /^(https?:\/\/|file:\/\/|ipfs:\/\/|ipns:\/\/)/i.test(text) ||
        (/^[\w-]+(\.[\w-]+)+/.test(text) && !text.includes(" "))
    );
}

function createSwarmStore() {
    const { subscribe, set, update } = writable<{
        messages: Message[];
        activeWidget: Message | null;
        isOnline: boolean | null;
    }>({
        messages: [],
        activeWidget: null,
        isOnline: null
    });

    async function checkOnline() {
        if (!invoke) return;
        try {
            const status = await invoke<boolean>("check_architect_status");
            update(s => ({ ...s, isOnline: status }));
        } catch {
            update(s => ({ ...s, isOnline: false }));
        }
    }

    async function dispatchA2UI(a2ui: A2UI) {
        const type = a2ui.type;

        if (type === "navigate" && a2ui.url) {
            if (a2ui.is_agent) {
                browserStore.createTab(a2ui.url, { isAgentTab: true });
            } else {
                browserStore.navigateActiveTab(a2ui.url.startsWith("http") ? a2ui.url : "https://" + a2ui.url);
            }
        } else if (type === "open_tab" && a2ui.url) {
            browserStore.createTab(a2ui.url, { isAgentTab: a2ui.is_agent });
        } else if (type === "search" && a2ui.content) {
            browserStore.createTab(`https://duckduckgo.com/?q=${encodeURIComponent(a2ui.content)}`, { isAgentTab: a2ui.is_agent });
        } else if (type === "scrape" && a2ui.url) {
            browserStore.createTab(a2ui.url, { isAgentTab: true });
        } else if (type === "synthesis" && a2ui.content) {
            console.log("[SwarmStore] Research Synthesis Received:", a2ui.content);
        } else if (type === "action") {
            switch (a2ui.action) {
                case "open_wallet":
                    browserStore.createOrFocusTab("bucks://wallet");
                    break;
                case "start_tor_node":
                    if (invoke) await invoke("start_tor_node");
                    break;
                case "open_ipfs":
                    browserStore.createTab("ipfs://");
                    break;
            }
        } else if (type === "multi_tab_context") {
            console.log("[SwarmStore] Agent is managing multi-tab context:", a2ui.tabs);
            if (a2ui.tabs) {
                a2ui.tabs.forEach(t => {
                    browserStore.createTab(t.url, { isAgentTab: true });
                });
            }
        }
    }

    return {
        subscribe,
        checkOnline,
        clearHistory: () => update(s => ({ ...s, messages: [], activeWidget: null })),
        closeWidget: () => update(s => ({ ...s, activeWidget: null })),
        sendQuery: async (queryStr: string) => {
            const text = queryStr.trim();
            if (!text || get(isSwarmThinking)) return;

            if (isURL(text)) {
                const url = /^https?:\/\//i.test(text) ? text : "https://" + text;
                browserStore.createTab(url);
                return;
            }

            const userMsg: Message = { role: "user", content: text, ts: Date.now() };
            update(s => ({ ...s, messages: [...s.messages, userMsg], activeWidget: null }));
            isSwarmThinking.set(true);

            try {
                const tab = get(activeTab);
                let result;
                if (invoke) {
                    const raw = await invoke<string>("query_swarm", {
                        prompt: text,
                        current_url: tab?.url || null,
                        current_title: tab?.title || null,
                    });
                    result = JSON.parse(raw);
                } else {
                    // Fallback for browser-only dev mode
                    const response = await fetch("http://localhost:3000/api/v1/swarm/task", {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({
                            prompt: text,
                            current_url: tab?.url || null,
                            current_title: tab?.title || null,
                        })
                    });
                    result = await response.json();
                }
                // Clean up the evaluation text: if it contains the JSON block we extracted, strip it
                let cleanContent = result.evaluation;
                if (result.a2ui) {
                    // Try to remove ```json ... ``` blocks
                    cleanContent = cleanContent.replace(/```json[\s\S]*?```/g, "").trim();
                    // Or if it was raw { ... }
                    if (cleanContent.includes("{") && cleanContent.includes("}")) {
                        // Very basic check to avoid over-stripping if the user was talking about JSON
                        // But usually the A2UI is at the end.
                    }
                }

                const agentMsg: Message = {
                    role: result.status === "error" || result.status === "timeout" ? "error" : "agent",
                    content: cleanContent,
                    a2ui: result.a2ui,
                    cid: result.cid,
                    taskId: result.task_id,
                    ts: Date.now()
                };

                update(s => ({
                    ...s,
                    messages: [...s.messages, agentMsg],
                    activeWidget: agentMsg,
                    isOnline: result.status !== "offline_fallback" && result.status !== "error"
                }));

                if (agentMsg.a2ui) {
                    await dispatchA2UI(agentMsg.a2ui);
                }

            } catch (err: any) {
                const errorMsg: Message = {
                    role: "error",
                    content: `Agent Error: ${err.message || err.toString()}`,
                    ts: Date.now()
                };
                update(s => ({
                    ...s,
                    messages: [...s.messages, errorMsg],
                    activeWidget: errorMsg,
                    isOnline: false
                }));
            } finally {
                isSwarmThinking.set(false);
            }
        },

        async sendFeedback(taskId: string, score: number, correction?: string) {
            if (!invoke) return;
            try {
                await invoke("handle_feedback", {
                    task_id: taskId,
                    score,
                    correction
                });
                console.log(`[SwarmStore] Feedback sent for task ${taskId}`);
            } catch (e) {
                console.error("[SwarmStore] Failed to send feedback:", e);
            }
        }
    };
}

export const swarmStore = createSwarmStore();
