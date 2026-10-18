/** Search engine catalogue shared by the omnibox, the agent and the settings page. */
import type { SearchEngineId } from './bridge';

export interface SearchEngine {
    id: SearchEngineId;
    label: string;
    /** Query is appended URL-encoded. */
    url: string;
}

export const SEARCH_ENGINES: SearchEngine[] = [
    { id: 'duckduckgo', label: 'DuckDuckGo', url: 'https://duckduckgo.com/?q=' },
    { id: 'google', label: 'Google', url: 'https://www.google.com/search?q=' },
    { id: 'brave', label: 'Brave', url: 'https://search.brave.com/search?q=' },
    { id: 'bing', label: 'Bing', url: 'https://www.bing.com/search?q=' },
];

/** Build a search results URL for `query` with the given engine (unknown ids fall back to DuckDuckGo). */
export function buildSearchUrl(engine: string | null | undefined, query: string): string {
    const found = SEARCH_ENGINES.find((e) => e.id === engine) ?? SEARCH_ENGINES[0];
    return found.url + encodeURIComponent(query);
}
