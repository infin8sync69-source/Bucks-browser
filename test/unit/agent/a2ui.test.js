import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractA2ui, validateA2ui, splitA2ui, isAllowedUrl } from '../../../src/main/agent/a2ui.js';

test('extracts the last fenced json block', () => {
  const text = 'Sure.\n```json\n{"type":"navigate","url":"https://a.example"}\n```\nActually:\n```json\n{"type":"navigate","url":"https://b.example/x"}\n```\n';
  assert.deepEqual(extractA2ui(text), { type: 'navigate', url: 'https://b.example/x' });
});

test('skips an invalid last block and falls back to an earlier valid one', () => {
  const text = '```json\n{"type":"action","action":"open_wallet"}\n```\n```json\n{not json}\n```';
  assert.deepEqual(extractA2ui(text), { type: 'action', action: 'open_wallet' });
});

test('accepts untagged fences and trailing bare objects', () => {
  assert.deepEqual(extractA2ui('hi\n```\n{"type":"search","content":"cats"}\n```'), { type: 'search', content: 'cats' });
  assert.deepEqual(extractA2ui('Opening it. {"type":"navigate","url":"ipfs://bafyabc/index.html"}'), { type: 'navigate', url: 'ipfs://bafyabc/index.html' });
  assert.deepEqual(extractA2ui('x {"type":"text","content":"a } b { c"} '), { type: 'text', content: 'a } b { c' });
});

test('rejects unknown types, bad urls, bad actions, non-objects', () => {
  assert.equal(extractA2ui('{"type":"eval","content":"x"}'), null);
  assert.equal(extractA2ui('{"type":"navigate","url":"javascript:alert(1)"}'), null);
  assert.equal(extractA2ui('{"type":"navigate","url":"file:///etc/passwd"}'), null);
  assert.equal(extractA2ui('{"type":"navigate","url":"bucks://wallet"}'), null);
  assert.equal(extractA2ui('{"type":"navigate","url":"not a url"}'), null);
  assert.equal(extractA2ui('{"type":"navigate"}'), null);
  assert.equal(extractA2ui('{"type":"action","action":"start_tor_node"}'), null);
  assert.equal(extractA2ui('{"type":"search","content":"  "}'), null);
  assert.equal(extractA2ui('[1,2,3]'), null);
  assert.equal(extractA2ui('no json here'), null);
  assert.equal(extractA2ui(''), null);
  assert.equal(extractA2ui(undefined), null);
  assert.equal(extractA2ui('```json\n{"type":"navigate","url":"https://a.example",\n```'), null);
});

test('drops unknown fields, keeps boolean is_agent', () => {
  assert.deepEqual(
    validateA2ui({ type: 'open_tab', url: 'https://a.example', is_agent: true, evil: '<script>', content: 'Opening' }),
    { type: 'open_tab', url: 'https://a.example', content: 'Opening', is_agent: true },
  );
  assert.equal(validateA2ui({ type: 'text', content: 'hi', is_agent: 'yes' }).is_agent, undefined);
});

test('isAllowedUrl schemes', () => {
  for (const u of ['http://a.b', 'https://a.b/x?y', 'ipfs://bafyabc', 'ipns://example.eth/x']) assert.equal(isAllowedUrl(u), true, u);
  for (const u of ['', 'ftp://a.b', 'data:text/html,hi', 'javascript:1', 'a.b', null]) assert.equal(isAllowedUrl(u), false, String(u));
});

test('splitA2ui removes the JSON from the visible text', () => {
  const { text, a2ui } = splitA2ui('Opening your wallet now.\n\n```json\n{"type":"action","action":"open_wallet"}\n```');
  assert.equal(text, 'Opening your wallet now.');
  assert.deepEqual(a2ui, { type: 'action', action: 'open_wallet' });
  assert.deepEqual(splitA2ui('Just text'), { text: 'Just text', a2ui: null });
});
