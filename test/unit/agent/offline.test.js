import { test } from 'node:test';
import assert from 'node:assert/strict';
import { interpretPrompt, resolveUrl, buildSearchUrl, offlineProvider } from '../../../src/main/agent/providers/offline.js';
import { CID } from 'multiformats/cid';
import * as raw from 'multiformats/codecs/raw';
import { sha256 } from 'multiformats/hashes/sha2';

const cid = CID.createV1(raw.code, await sha256.digest(new TextEncoder().encode('hello'))).toString();
const a2ui = (prompt, cfg) => interpretPrompt(prompt, cfg).a2ui;

test('resolveUrl', () => {
  assert.equal(resolveUrl('example.com'), 'https://example.com');
  assert.equal(resolveUrl('www.example.com/a?b=1.'), 'https://www.example.com/a?b=1');
  assert.equal(resolveUrl('https://example.com/x'), 'https://example.com/x');
  assert.equal(resolveUrl('ipfs://bafyabc/x'), 'ipfs://bafyabc/x');
  assert.equal(resolveUrl('ipns://docs.ipfs.tech'), 'ipns://docs.ipfs.tech');
  assert.equal(resolveUrl(cid), `ipfs://${cid}`);
  assert.equal(resolveUrl(`${cid}/readme.md`), `ipfs://${cid}/readme.md`);
  assert.equal(resolveUrl(`/ipfs/${cid}`), `ipfs://${cid}`);
  assert.equal(resolveUrl('localhost:3000'), 'http://localhost:3000');
  assert.equal(resolveUrl('192.168.1.1'), 'http://192.168.1.1');
  assert.equal(resolveUrl('javascript://x'), null);
  assert.equal(resolveUrl('file:///etc/passwd'), null);
  assert.equal(resolveUrl('hello'), null);
  assert.equal(resolveUrl(''), null);
});

test('navigation commands', () => {
  assert.deepEqual(a2ui('go to example.com'), { type: 'navigate', url: 'https://example.com', content: 'Navigating to https://example.com...' });
  assert.equal(a2ui('Open https://rust-lang.org/learn.').url, 'https://rust-lang.org/learn');
  assert.equal(a2ui('please navigate to news.ycombinator.com').url, 'https://news.ycombinator.com');
  assert.equal(a2ui('browse ipfs://bafyabc/index.html').url, 'ipfs://bafyabc/index.html');
  assert.equal(a2ui(`open ${cid}`).url, `ipfs://${cid}`);
  assert.equal(a2ui('can you open github.com in a new tab').type, 'open_tab');
  assert.equal(a2ui('visit the website example.org').url, 'https://example.org');
  assert.equal(a2ui('example.com').url, 'https://example.com');
  assert.equal(interpretPrompt('go to example.com').status, 'offline_fallback');
});

test('unresolvable navigation falls back to a search with the configured engine', () => {
  const r = a2ui('open the best pizza places', { searchEngine: 'brave' });
  assert.equal(r.type, 'navigate');
  assert.equal(r.url, 'https://search.brave.com/search?q=best%20pizza%20places');
});

test('search commands use the configured engine', () => {
  assert.equal(a2ui('search cats and dogs').url, 'https://duckduckgo.com/?q=cats%20and%20dogs');
  assert.equal(a2ui('search for rust async', { searchEngine: 'google' }).url, 'https://www.google.com/search?q=rust%20async');
  assert.equal(a2ui('look up ipfs gateways', { searchEngine: 'bing' }).url, 'https://www.bing.com/search?q=ipfs%20gateways');
  assert.equal(a2ui('search for ipfs tutorials').type, 'navigate', 'search wins over the ipfs keyword');
  assert.equal(buildSearchUrl('nope', 'a b'), 'https://duckduckgo.com/?q=a%20b');
});

test('built-in pages', () => {
  assert.equal(a2ui('wallet').action, 'open_wallet');
  assert.equal(a2ui('open my wallet').action, 'open_wallet');
  assert.equal(a2ui('what is my balance').action, 'open_wallet');
  assert.equal(a2ui('I want to pay someone').action, 'open_wallet');
  assert.equal(a2ui('ipfs').action, 'open_ipfs');
  assert.equal(a2ui('pin a file').action, 'open_ipfs');
  assert.equal(a2ui('open node').action, 'open_ipfs');
  assert.equal(a2ui('open settings').action, 'open_settings');
  assert.equal(a2ui('go to the downloads page').action, 'open_downloads');
  assert.equal(a2ui('show my downloads').action, 'open_downloads');
  assert.equal(a2ui('open ipfs.io').url, 'https://ipfs.io');
});

test('everything else gets helpful text', () => {
  const r = interpretPrompt('tell me a joke');
  assert.equal(r.a2ui.type, 'text');
  assert.match(r.evaluation, /offline/i);
  assert.match(r.evaluation, /Settings/);
  assert.equal(interpretPrompt('').a2ui.type, 'text');
});

test('never emits dangerous urls', () => {
  for (const p of ['open javascript:alert(1)', 'go to file:///etc/passwd', 'navigate to data:text/html,<script>']) {
    const r = a2ui(p);
    assert.ok(r.type !== 'navigate' || /^https:\/\/(duckduckgo\.com|www\.|search\.)/.test(r.url), p + ' -> ' + JSON.stringify(r));
  }
});

test('provider interface', async () => {
  assert.equal(offlineProvider.name, 'offline');
  assert.equal(await offlineProvider.isAvailable(), true);
  const r = await offlineProvider.query({ prompt: 'wallet' }, {});
  assert.equal(r.status, 'offline_fallback');
});
