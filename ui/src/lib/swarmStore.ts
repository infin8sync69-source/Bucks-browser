/**
 * Agent chat state. All model traffic goes through the main process (`bucks.agent.*`), which owns
 * the providers (offline | remote | ollama | soul); the chrome never talks to an agent server itself.
 *
 * Conversations are threads kept in the chrome's storage (the last turns go with each question).
 * Slash commands are handled here; a running question reports its progress and asks for approval
 * through bucks.agent.onEvent, and can be stopped.
 */
import { writable, get } from 'svelte/store';
import { bucks, type A2UIPayload, type AgentAttachment, type AgentResult, type UiComponent } from './bridge';
import { isSwarmThinking, browserStore, activeTab } from './stores';
import { settingsStore } from './settingsStore';
import { ipfsStore } from './ipfsStore';
import { matchIntent, INTENT_LABELS } from './intentMatcher';
import { parseSlash } from './agent/slash';
import { newThread, titleFrom, historyFor, upsertThread, sanitizeThreads, type ChatThread } from './agent/threads';

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
    /** Generative-UI cards (Soul Engine). */
    components?: UiComponent[];
    /** Suggested next questions (Soul Engine). */
    followups?: string[];
    /** Names of the files and CIDs attached to a question. */
    attachments?: string[];
    /** Documents the agent saved while answering (paths). */
    documents?: string[];
    ts: number;
    [key: string]: unknown;
}

/** An attachment as the composer holds it: what is sent, and a name to show. */
export type ComposerAttachment = AgentAttachment & { label: string };

/** An action the agent is waiting for the user to allow. */
export interface PendingApproval {
    requestId: string;
    name: string;
    label: string;
    expiresAt: number;
}

const THREADS_KEY = 'bucks_chat_threads_v1';

function loadThreads(): ChatThread<Message>[] {
    try {
        return sanitizeThreads<Message>(JSON.parse(localStorage.getItem(THREADS_KEY) || '[]'));
    } catch {
        return [];
    }
}

function saveThreads(threads: ChatThread<Message>[]) {
    try {
        localStorage.setItem(THREADS_KEY, JSON.stringify(threads));
    } catch {
        /* storage full or unavailable: the chat keeps working in memory */
    }
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
    /** Messages of the open thread. */
    messages: Message[];
    activeWidget: Message | null;
    /** The configured agent provider is reachable. */
    isOnline: boolean | null;
    /** A local model (Ollama provider) is connected. */
    slmReady: boolean;
    provider: string;
    model: string | null;
    /** Saved threads (the ones with messages), most recently used first. */
    threads: ChatThread<Message>[];
    /** The open thread; a new one is only saved once it has a message. */
    threadId: string;
    threadCreatedAt: number;
    /** What the running question is doing right now. */
    status: string;
    approvals: PendingApproval[];
    /** The running question (for stop and its events). */
    queryId: string | null;
}

function createSwarmStore() {
    const first = newThread<Message>();
    const { subscribe, update } = writable<SwarmState>({
        messages: [],
        activeWidget: null,
        isOnline: null,
        slmReady: false,
        provider: 'offline',
        model: null,
        threads: loadThreads(),
        threadId: first.id,
        threadCreatedAt: first.createdAt,
        status: '',
        approvals: [],
        queryId: null,
    });

    /** Append to the open thread and save it. */
    function addMessage(msg: Message, extra: Partial<SwarmState> = {}) {
        update((s) => {
            // Timestamps key the message list: keep them strictly increasing within a thread.
            const last = s.messages.at(-1)?.ts ?? 0;
            if (msg.ts <= last) msg = { ...msg, ts: last + 1 };
            if (extra.activeWidget) extra = { ...extra, activeWidget: msg }; // the widget is this message
            const messages = [...s.messages, msg];
            const saved = s.threads.find((t) => t.id === s.threadId);
            const firstQuestion = messages.find((m) => m.role === 'user')?.content ?? msg.content;
            const thread: ChatThread<Message> = {
                id: s.threadId,
                title: saved?.title && saved.title !== 'New chat' ? saved.title : titleFrom(firstQuestion),
                createdAt: s.threadCreatedAt,
                updatedAt: msg.ts,
                messages,
            };
            const threads = upsertThread(s.threads, thread);
            saveThreads(threads);
            return { ...s, ...extra, messages, threads };
        });
    }

    // Progress and approval requests of the running question.
    bucks.agent.onEvent((ev) => {
        update((s) => {
            if (ev.queryId !== s.queryId) return s;
            if (ev.type === 'status') return { ...s, status: ev.label };
            if (ev.type === 'approval') {
                return { ...s, approvals: [...s.approvals, { requestId: ev.requestId, name: ev.name, label: ev.label, expiresAt: ev.expiresAt }] };
            }
            return { ...s, approvals: s.approvals.filter((a) => a.requestId !== ev.requestId) };
        });
    });

    const agentNote = (content: string): Message => ({ role: 'agent', content, ts: Date.now() });

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

    /** Start a new, empty thread (the current one stays in the list if it has messages). */
    function newChat() {
        if (get(isSwarmThinking)) return;
        const t = newThread<Message>();
        update((s) => ({ ...s, messages: [], activeWidget: null, threadId: t.id, threadCreatedAt: t.createdAt }));
    }

    /** Commands handled in the chrome, with their outcome shown in the chat. */
    async function runLocal(action: 'save-pdf' | 'ipfs-upload', arg: string, typed: string) {
        addMessage({ role: 'user', content: typed, ts: Date.now() }, { activeWidget: null });
        try {
            if (action === 'save-pdf') {
                const tab = get(activeTab);
                if (tab?.type !== 'external') throw new Error('Open a web page first: /pdf saves the page you are on.');
                const file = await browserStore.savePdfActive();
                addMessage(agentNote(file ? `Saved the page as a PDF: ${file}` : 'Not saved.'));
            } else {
                const r = await ipfsStore.publishText(arg, 'note.txt');
                addMessage(agentNote(`Published to IPFS.\n\nCID: \`${r.cid}\`\n[Open it](${r.gateway_url}) · ${r.ipfs_uri}`));
            }
        } catch (e) {
            addMessage({ role: 'error', content: errorText(e), ts: Date.now() });
        }
    }

    return {
        subscribe,
        checkOnline,
        newChat,
        /** Kept for older callers: same as newChat(). */
        clearHistory: newChat,
        closeWidget: () => update(s => ({ ...s, activeWidget: null })),

        openThread(id: string) {
            if (get(isSwarmThinking)) return;
            update((s) => {
                const t = s.threads.find((x) => x.id === id);
                return t ? { ...s, messages: t.messages, activeWidget: null, threadId: t.id, threadCreatedAt: t.createdAt } : s;
            });
        },

        deleteThread(id: string) {
            update((s) => {
                const threads = s.threads.filter((t) => t.id !== id);
                saveThreads(threads);
                if (s.threadId !== id) return { ...s, threads };
                const t = newThread<Message>();
                return { ...s, threads, messages: [], activeWidget: null, threadId: t.id, threadCreatedAt: t.createdAt };
            });
        },

        renameThread(id: string, title: string) {
            const clean = title.trim().slice(0, 80);
            if (!clean) return;
            update((s) => {
                const threads = s.threads.map((t) => (t.id === id ? { ...t, title: clean } : t));
                saveThreads(threads);
                return { ...s, threads };
            });
        },

        /** Allow or refuse an action the agent asked for. */
        async approve(requestId: string, yes: boolean) {
            update((s) => ({ ...s, approvals: s.approvals.filter((a) => a.requestId !== requestId) }));
            await bucks.agent.approve(requestId, yes).catch(() => false);
        },

        /** Stop the running question. */
        async stop() {
            const id = get({ subscribe }).queryId;
            if (id) await bucks.agent.cancel(id).catch(() => false);
        },

        /**
         * Ask the agent. Slash commands are handled first; `agentic` lets the agent act in the
         * current tab (Soul Engine); attachments go along with the question.
         */
        sendQuery: async (queryStr: string, opts: { attachments?: ComposerAttachment[]; agentic?: boolean } = {}) => {
            const typed = queryStr.trim();
            const attached = opts.attachments ?? [];
            if ((!typed && !attached.length) || get(isSwarmThinking)) return;

            let text = typed || 'Look at the attached content and tell me what it contains.';
            let agentic = opts.agentic === true;
            const sendAttachments: AgentAttachment[] = attached.map(({ label: _label, ...a }) => a);
            const slash = parseSlash(typed);
            if (slash?.kind === 'nav') { browserStore.createOrFocusTab(slash.url); return; }
            if (slash?.kind === 'usage') { addMessage(agentNote(slash.message), { activeWidget: null }); return; }
            if (slash?.kind === 'local') {
                if (slash.action === 'new-chat') newChat();
                else await runLocal(slash.action, slash.arg, typed);
                return;
            }
            if (slash?.kind === 'prompt') {
                text = slash.prompt;
                agentic = agentic || slash.agentic;
                if (slash.cid) sendAttachments.push({ kind: 'cid', cid: slash.cid });
            } else if (!attached.length && isURL(typed)) {
                browserStore.createTab(withScheme(typed));
                return;
            }

            const before = get({ subscribe }).messages;
            const userMsg: Message = {
                role: "user",
                content: typed || text,
                ts: Date.now(),
                ...(attached.length ? { attachments: attached.map((a) => a.label) } : {}),
            };
            addMessage(userMsg, { activeWidget: null });

            const tab = get(activeTab);
            if (agentic) {
                const provider = get(settingsStore)?.agent.provider;
                const problem = provider !== 'soul'
                    ? 'Acting in a tab needs the Soul Engine. Choose it in the agent menu or in Settings → Agent, then ask again.'
                    : tab?.type !== 'external'
                      ? 'Open the web page you want me to work on in this tab, then ask again.'
                      : null;
                if (problem) { addMessage(agentNote(problem)); return; }
            }

            // ── Client-side intent match: show widget IMMEDIATELY ──
            const intent = slash ? null : matchIntent(text);
            if (intent?.type) {
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

            const queryId = `q-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
            update((s) => ({ ...s, queryId, status: agentic ? 'Looking at the page…' : 'Thinking…', approvals: [] }));
            isSwarmThinking.set(true);

            try {
                const result: AgentResult = await bucks.agent.query({
                    prompt: text,
                    currentUrl: tab?.url || null,
                    currentTitle: tab?.title || null,
                    tabId: tab?.type === 'external' ? tab.id : null,
                    queryId,
                    history: historyFor(before),
                    attachments: sendAttachments.length ? sendAttachments : undefined,
                    agentic,
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
                    components: result.components ?? [],
                    followups: result.followups ?? [],
                    ...(result.documents?.length ? { documents: result.documents } : {}),
                    ts: Date.now()
                };

                addMessage(agentMsg, { activeWidget: agentMsg, isOnline: result.status === "ok" });

                if (agentMsg.a2ui) {
                    await dispatchA2UI(agentMsg.a2ui);
                }

            } catch (err: unknown) {
                const errorMsg: Message = {
                    role: "error",
                    content: `Agent Error: ${errorText(err)}`,
                    ts: Date.now()
                };
                addMessage(errorMsg, { activeWidget: errorMsg, isOnline: false });
            } finally {
                update((s) => ({ ...s, queryId: null, status: '', approvals: [] }));
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
