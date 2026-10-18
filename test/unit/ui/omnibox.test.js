// The chrome's omnibox logic is plain TypeScript; Node strips the types itself.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSuggestions, looksLikeUrl, displayUrl, matchScore, securityKind } from '../../../ui/src/lib/omnibox.ts';

const resolve = (s) => (looksLikeUrl(s) ? (/^[a-z]+:/i.test(s) ? s : `https://${s}`) : `https://duckduckgo.com/?q=${encodeURIComponent(s)}`);

const sources = {
  activeTabId: 't1',
  tabs: [
    { id: 't1', url: 'https://github.com/infin8sync69-source', title: 'Active GitHub' },
    { id: 't2', url: 'https://github.com/ipfs/kubo', title: 'Kubo', customTitle: 'Kubo repo' },
    { id: 't3', url: 'https://secret.example', title: 'Secret', private: true },
    { id: 't4', url: 'bucks://newtab', title: 'Bucks' },
  ],
  bookmarks: [{ url: 'https://docs.ipfs.tech/', title: 'IPFS Docs' }, { url: 'https://github.com/ipfs/kubo', title: 'Kubo dup' }],
  history: [
    { url: 'https://news.ycombinator.com/', title: 'Hacker News' },
    { url: 'https://www.github.blog/', title: 'The GitHub Blog' },
    { url: 'https://secret.example', title: 'Secret' },
  ],
};

test('typed text first, then tabs, bookmarks, history; no duplicates or private tabs', () => {
  const out = buildSuggestions('git', sources, resolve);
  assert.equal(out[0].kind, 'search');
  assert.equal(out[0].url, 'https://duckduckgo.com/?q=git');
  const tab = out.find((s) => s.kind === 'tab');
  assert.equal(tab.tabId, 't2', 'the active tab is not offered');
  assert.equal(tab.label, 'Kubo repo', 'custom tab names are used');
  assert.ok(!out.some((s) => s.kind === 'bookmark' && s.url === 'https://github.com/ipfs/kubo'), 'already offered as a tab');
  assert.ok(out.some((s) => s.kind === 'history' && s.url === 'https://www.github.blog/'));
  assert.ok(!out.some((s) => s.url === 'https://secret.example' && s.kind === 'tab'), 'private tabs are never suggested');
  assert.deepEqual(buildSuggestions('  ', sources, resolve), []);
});

test('an address is offered as "go to"', () => {
  const out = buildSuggestions('docs.ipfs.tech', sources, resolve);
  assert.deepEqual(out[0], { kind: 'url', label: 'docs.ipfs.tech', url: 'https://docs.ipfs.tech', detail: 'Go to address' });
  assert.ok(out.some((s) => s.kind === 'bookmark' && s.label === 'IPFS Docs'));
});

test('helpers', () => {
  assert.equal(looksLikeUrl('github.com/x'), true);
  assert.equal(looksLikeUrl('ipfs://bafy'), true);
  assert.equal(looksLikeUrl('localhost:3000'), true);
  assert.equal(looksLikeUrl('what is ipfs'), false);
  assert.equal(looksLikeUrl('kubo'), false);
  assert.equal(displayUrl('https://www.example.com/a/'), 'example.com/a');
  assert.ok(matchScore('exa', { url: 'https://example.com', title: 'X' }) > matchScore('exa', { url: 'https://x.org', title: 'An example' }));
  assert.equal(matchScore('zzz', { url: 'https://example.com', title: 'X' }), 0);
  assert.equal(securityKind('https://a'), 'secure');
  assert.equal(securityKind('http://a'), 'insecure');
  assert.equal(securityKind('ipns://a'), 'ipfs');
  assert.equal(securityKind('file:///a'), 'file');
  assert.equal(securityKind('bucks://settings'), 'internal');
  assert.equal(securityKind(undefined), 'internal');
  assert.equal(securityKind('data:text/html,x'), 'other');
});
