/**
 * Agent chat state. All model traffic goes through the main process (`bucks.agent.*`), which owns
 * the providers (offline | remote | ollama); the chrome never talks to an agent server itself.
 */
import { writable, get } from 'svelte/store';
import { bucks, type A2UIPayload, type AgentResult } from './bridge';
import { isSwarmThinking, browserStore, activeTab } from './stores';
import { settingsStore } from './settingsStore';
import { matchIntent, INTENT_LABELS } from './intentMatcher';

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

const HAS_SCHEME = /^[a-z][a-z0-9+.-]*:/i;

function isURL(text: string): boolean {
    return (
        /^(https?:\/\/|file:\/\/|ipfs:\/\/|ipns:\/\/)/i.test(text) ||
        (/^[\w-]+(\.[\w-]+)+/.test(text) && !text.includes(" "))
    );
}

/** Add https:// to scheme-less URLs; anything that already has a scheme is kept. */
function withScheme(url: string): string {
    return HAS_SCHEME.test(url) ? url : `https://${url}`;
}

function errorText(e: unknown): string {
    return e instanceof Error ? e.message : String(e);
}

interface SwarmState {
    messages: Message[];
    activeWidget: Message | null;
    /** The configured agent provider is reachable. */
    isOnline: boolean | null;
    /** A local model (Ollama provider) is connected. */
    slmReady: boolean;
    provider: string;
    model: string | null;
}

function createSwarmStore() {
    const { subscribe, update } = writable<SwarmState>({
        messages: [],
        activeWidget: null,
        isOnline: null,
        slmReady: false,
        provider: 'offline',
        model: null,
    });

    /** Ask the main process which provider is active and whether it is reachable. */
    async function checkOnline() {
        try {
            const status = await bucks.agent.status();
            update((s) => ({
                ...s,
                isOnline: !!status.online,
                slmReady: !!status.online && status.provider === 'ollama',
                provider: status.provider,
                model: status.model ?? null,
            }));
        } catch {
            update((s) => ({ ...s, isOnline: false, slmReady: false }));
        }
    }

    async function dispatchA2UI(a2ui: A2UI) {
        const type = a2ui.type;

        if (type === "navigate" && a2ui.url) {
            if (a2ui.is_agent) {
                browserStore.createTab(withScheme(a2ui.url), { isAgentTab: true });
            } else {
                browserStore.navigateActiveTab(withScheme(a2ui.url));
            }
        } else if (type === "open_tab" && a2ui.url) {
            browserStore.createTab(withScheme(a2ui.url), { isAgentTab: a2ui.is_agent });
        } else if (type === "search" && a2ui.content) {
            browserStore.createTab(settingsStore.searchUrl(a2ui.content), { isAgentTab: a2ui.is_agent });
        } else if (type === "scrape" && a2ui.url) {
            browserStore.createTab(withScheme(a2ui.url), { isAgentTab: true });
        } else if (type === "synthesis" && a2ui.content) {
            console.log("[SwarmStore] Research Synthesis Received:", a2ui.content);
        } else if (type === "action") {
            switch (a2ui.action) {
                case "open_wallet":
                    browserStore.createOrFocusTab("bucks://wallet");
                    break;
                case "open_ipfs":
                    browserStore.createOrFocusTab("bucks://ipfs");
                    break;
            }
        } else if (type === "multi_tab_context") {
            console.log("[SwarmStore] Agent is managing multi-tab context:", a2ui.tabs);
            if (a2ui.tabs) {
                a2ui.tabs.forEach(t => {
                    browserStore.createTab(withScheme(t.url), { isAgentTab: true });
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
                browserStore.createTab(withScheme(text));
                return;
            }

            const userMsg: Message = { role: "user", content: text, ts: Date.now() };
            update(s => ({ ...s, messages: [...s.messages, userMsg], activeWidget: null }));

            // ── Client-side intent match: show widget IMMEDIATELY ──
            const intent = matchIntent(text);
            if (intent.type) {
                const meta = INTENT_LABELS[intent.type];
                const intentWidget: Message = {
                    role: "agent",
                    content: meta?.description ?? "",
                    a2ui: { type: intent.type, data: { query: text, ...intent.data } },
                    cid: null,
                    taskId: null,
                    ts: Date.now(),
                };
                update(s => ({ ...s, activeWidget: intentWidget }));
            }

            isSwarmThinking.set(true);

            try {
                const tab = get(activeTab);
                const result: AgentResult = await bucks.agent.query({
                    prompt: text,
                    currentUrl: tab?.url || null,
                    currentTitle: tab?.title || null,
                    tabId: tab?.type === 'external' ? tab.id : null,
                });

                // Strip a ```json block from the text when the model also returned it as a2ui
                let cleanContent = result.evaluation ?? "";
                if (result.a2ui) {
                    cleanContent = cleanContent.replace(/```json[\s\S]*?```/g, "").trim();
                }

                const a2ui = (result.a2ui ?? null) as (A2UIPayload & A2UI) | null;
                const agentMsg: Message = {
                    role: result.status === "error" ? "error" : "agent",
                    content: cleanContent,
                    a2ui,
                    cid: result.cid,
                    taskId: result.task_id,
                    ts: Date.now()
                };

                update(s => ({
                    ...s,
                    messages: [...s.messages, agentMsg],
                    activeWidget: agentMsg,
                    isOnline: result.status === "ok",
                }));

                if (agentMsg.a2ui) {
                    await dispatchA2UI(agentMsg.a2ui);
                }

            } catch (err: unknown) {
                const errorMsg: Message = {
                    role: "error",
                    content: `Agent Error: ${errorText(err)}`,
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
            try {
                await bucks.agent.feedback({ taskId, score, correction });
            } catch (e) {
                console.error("[SwarmStore] Failed to send feedback:", errorText(e));
            }
        },
    };
}

export const swarmStore = createSwarmStore();
