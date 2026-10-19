/**
 * Slash commands for the agent's composer and the command bar (Bucks Core's set, adapted): open a
 * Bucks page, do something locally (new chat, save the page as PDF, publish text to IPFS), or turn
 * a short command into a clear request for the agent. Pure: the caller acts on the result.
 */

export type SlashKind = 'nav' | 'local' | 'prompt' | 'agent';

export interface SlashCommand {
    cmd: string;
    /** Shown after the command in the menu, e.g. "<topic>"; required when it starts with "<". */
    args?: string;
    desc: string;
    kind: SlashKind;
    url?: string;
    /** Works best with (or needs) the Soul Engine's tools. */
    soul?: boolean;
}

export const SLASH_COMMANDS: SlashCommand[] = [
    { cmd: '/agent', args: '<task>', desc: 'Let the agent act in this tab. It asks before clicking, typing or opening a page.', kind: 'agent', soul: true },
    { cmd: '/search', args: '<query>', desc: 'Search the web and summarise what it finds', kind: 'prompt' },
    { cmd: '/summarize', args: '[url]', desc: 'Summarise this page, or the page at a URL', kind: 'prompt' },
    { cmd: '/research', args: '<topic>', desc: 'Research a topic from several sources', kind: 'prompt', soul: true },
    { cmd: '/report', args: '<topic>', desc: 'Research a topic and save a PDF report', kind: 'prompt', soul: true },
    { cmd: '/doc', args: '<topic>', desc: 'Write a document about a topic and save it', kind: 'prompt', soul: true },
    { cmd: '/pdf', args: '[topic]', desc: 'Save this page as a PDF, or write a PDF about a topic', kind: 'prompt' },
    { cmd: '/weather', args: '<place>', desc: 'Current weather and forecast for a place', kind: 'prompt' },
    { cmd: '/images', args: '<subject>', desc: 'Find images of something', kind: 'prompt', soul: true },
    { cmd: '/video', args: '<subject>', desc: 'Find and play a video', kind: 'prompt', soul: true },
    { cmd: '/links', args: '[url]', desc: 'List the links on this page or on a URL', kind: 'prompt', soul: true },
    { cmd: '/code', args: '<code>', desc: 'Run code in the agent\'s sandbox', kind: 'prompt', soul: true },
    { cmd: '/ipfs-cat', args: '<cid>', desc: 'Read the text at an IPFS CID', kind: 'prompt' },
    { cmd: '/ipfs-upload', args: '<text>', desc: 'Publish text to IPFS and get its CID', kind: 'local' },
    { cmd: '/new', desc: 'Start a new chat', kind: 'local' },
    { cmd: '/wallet', desc: 'Open the wallet', kind: 'nav', url: 'bucks://wallet' },
    { cmd: '/ipfs', desc: 'Open the IPFS node: files, pins, peers, devices', kind: 'nav', url: 'bucks://ipfs' },
    { cmd: '/history', desc: 'Open your browsing history', kind: 'nav', url: 'bucks://history' },
    { cmd: '/bookmarks', desc: 'Open your bookmarks', kind: 'nav', url: 'bucks://bookmarks' },
    { cmd: '/downloads', desc: 'Open your downloads', kind: 'nav', url: 'bucks://downloads' },
    { cmd: '/settings', desc: 'Open settings', kind: 'nav', url: 'bucks://settings' },
];

const ALIASES: Record<string, string> = { '/summerize': '/summarize', '/summarise': '/summarize', '/image': '/images', '/play': '/video', '/document': '/doc', '/agentic': '/agent' };

export type SlashResult =
    | { kind: 'nav'; url: string }
    | { kind: 'local'; action: 'new-chat' | 'save-pdf' | 'ipfs-upload'; arg: string }
    | { kind: 'prompt'; prompt: string; agentic: boolean; cid?: string }
    | { kind: 'usage'; message: string };

/** What a slash command means; null when `text` is not one (send it as it is). */
export function parseSlash(text: string): SlashResult | null {
    const t = text.trim();
    const m = /^(\/[a-z][a-z-]*)(?:\s+([\s\S]*))?$/i.exec(t);
    if (!m) return null;
    const name = ALIASES[m[1].toLowerCase()] ?? m[1].toLowerCase();
    const arg = (m[2] ?? '').trim();
    const c = SLASH_COMMANDS.find((x) => x.cmd === name);
    if (!c) return null;
    if (c.args?.startsWith('<') && !arg) return { kind: 'usage', message: `Usage: ${c.cmd} ${c.args} — ${c.desc}` };
    const ask = (prompt: string, agentic = false): SlashResult => ({ kind: 'prompt', prompt, agentic });
    switch (c.cmd) {
        case '/agent': return ask(arg, true);
        case '/search': return ask(`Search the web for: ${arg}`);
        case '/summarize': return ask(arg ? `Read and summarise the page at ${arg}` : 'Summarise the page I am on.');
        case '/research': return ask(`Research ${arg}`);
        case '/report': return ask(`Research ${arg} and create a PDF report of your findings.`);
        case '/doc': return ask(`Create a document about: ${arg}`);
        case '/pdf': return arg ? ask(`Create a PDF about: ${arg}`) : { kind: 'local', action: 'save-pdf', arg: '' };
        case '/weather': return ask(`What's the weather in ${arg}?`);
        case '/images': return ask(`Show me images of ${arg}`);
        case '/video': return ask(`Play ${arg}`);
        case '/links': return ask(arg ? `Extract all links from the page at ${arg}` : 'List the links on the page I am on.');
        case '/code': return ask(`Execute this code in the sandbox: ${arg}`);
        case '/ipfs-cat': return { kind: 'prompt', prompt: 'What does this IPFS content say?', agentic: false, cid: arg.replace(/^ipfs:\/\//i, '') };
        case '/ipfs-upload': return { kind: 'local', action: 'ipfs-upload', arg };
        case '/new': return { kind: 'local', action: 'new-chat', arg: '' };
        default: return c.url ? { kind: 'nav', url: c.url } : null;
    }
}

/** Commands for the menu while the user types a command name (none once they type a space). */
export function suggestSlash(text: string, limit = 8): SlashCommand[] {
    if (!/^\/[a-z-]*$/i.test(text)) return [];
    const q = text.slice(1).toLowerCase();
    const starts = SLASH_COMMANDS.filter((c) => c.cmd.slice(1).startsWith(q));
    const contains = q ? SLASH_COMMANDS.filter((c) => !starts.includes(c) && (c.cmd.includes(q) || c.desc.toLowerCase().includes(q))) : [];
    return [...starts, ...contains].slice(0, limit);
}
