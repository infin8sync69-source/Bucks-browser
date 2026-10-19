/**
 * Chat threads: separate conversations with the agent, kept in the chrome's storage so they work
 * the same with every provider. Pure helpers; swarmStore.ts owns the state.
 */

export const MAX_THREADS = 50;
export const MAX_MESSAGES = 200;
const HISTORY_TURNS = 12;

/** The fields of a chat message these helpers rely on (swarmStore's Message has more). */
export interface ThreadMessage {
    role: 'user' | 'agent' | 'error';
    content: string;
    ts: number;
    [key: string]: unknown;
}

export interface ChatThread<M extends ThreadMessage = ThreadMessage> {
    id: string;
    title: string;
    createdAt: number;
    updatedAt: number;
    messages: M[];
}

let seq = 0;
export function newThread<M extends ThreadMessage>(now = Date.now()): ChatThread<M> {
    seq += 1;
    return { id: `th-${now.toString(36)}-${seq.toString(36)}${Math.random().toString(36).slice(2, 6)}`, title: 'New chat', createdAt: now, updatedAt: now, messages: [] };
}

/** A thread title from the first question: one line, at most 48 characters. */
export function titleFrom(text: string): string {
    const line = text.replace(/^\/[a-z-]+\s*/i, '').split('\n').find((l) => l.trim())?.trim() ?? '';
    if (!line) return 'New chat';
    return line.length > 48 ? `${line.slice(0, 47).trimEnd()}…` : line;
}

/** Earlier turns to send with a question: answers and questions only, newest last. */
export function historyFor(messages: ThreadMessage[], limit = HISTORY_TURNS): { role: 'user' | 'assistant'; content: string }[] {
    return messages
        .filter((m) => (m.role === 'user' || m.role === 'agent') && typeof m.content === 'string' && m.content.trim())
        .slice(-limit)
        .map((m) => ({ role: m.role === 'user' ? 'user' : 'assistant', content: m.content.slice(0, 2000) }));
}

/** Put a changed thread first (most recently used first) and keep within the limits. */
export function upsertThread<M extends ThreadMessage>(threads: ChatThread<M>[], thread: ChatThread<M>): ChatThread<M>[] {
    const t = { ...thread, messages: thread.messages.slice(-MAX_MESSAGES) };
    return [t, ...threads.filter((x) => x.id !== t.id)].slice(0, MAX_THREADS);
}

const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);

/** Threads from untrusted storage: malformed threads and messages are dropped. */
export function sanitizeThreads<M extends ThreadMessage>(raw: unknown): ChatThread<M>[] {
    if (!Array.isArray(raw)) return [];
    const seen = new Set<string>();
    const out: ChatThread<M>[] = [];
    for (const t of raw) {
        if (!isObj(t) || typeof t.id !== 'string' || !t.id || seen.has(t.id) || !Array.isArray(t.messages)) continue;
        seen.add(t.id);
        const messages = t.messages.filter(
            (m): m is M => isObj(m) && (m.role === 'user' || m.role === 'agent' || m.role === 'error') && typeof m.content === 'string' && typeof m.ts === 'number',
        );
        out.push({
            id: t.id.slice(0, 64),
            title: typeof t.title === 'string' && t.title.trim() ? t.title.slice(0, 80) : 'New chat',
            createdAt: typeof t.createdAt === 'number' ? t.createdAt : 0,
            updatedAt: typeof t.updatedAt === 'number' ? t.updatedAt : 0,
            messages: messages.slice(-MAX_MESSAGES),
        });
    }
    return out.sort((a, b) => b.updatedAt - a.updatedAt).slice(0, MAX_THREADS);
}

/** "Today", "Yesterday", or a short date, for the thread list. */
export function threadDay(ts: number, now = Date.now()): string {
    const day = (t: number) => new Date(t).toDateString();
    if (day(ts) === day(now)) return 'Today';
    if (day(ts) === day(now - 86_400_000)) return 'Yesterday';
    return new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}
