// The chat's slash commands and threads: plain TypeScript, run by Node directly.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSlash, suggestSlash, SLASH_COMMANDS } from '../../../ui/src/lib/agent/slash.ts';
import { newThread, titleFrom, historyFor, upsertThread, sanitizeThreads, threadDay, MAX_THREADS, MAX_MESSAGES } from '../../../ui/src/lib/agent/threads.ts';

test('parseSlash: pages, local actions, prompts, the agent, usage', () => {
  assert.equal(parseSlash('hello'), null);
  assert.equal(parseSlash('/unknown thing'), null, 'unknown commands are sent as typed');
  assert.equal(parseSlash('/etc/passwd'), null);
  assert.deepEqual(parseSlash('/wallet'), { kind: 'nav', url: 'bucks://wallet' });
  assert.deepEqual(parseSlash('  /Settings '), { kind: 'nav', url: 'bucks://settings' });
  assert.deepEqual(parseSlash('/new'), { kind: 'local', action: 'new-chat', arg: '' });
  assert.deepEqual(parseSlash('/pdf'), { kind: 'local', action: 'save-pdf', arg: '' });
  assert.deepEqual(parseSlash('/pdf solar panels'), { kind: 'prompt', prompt: 'Create a PDF about: solar panels', agentic: false });
  assert.deepEqual(parseSlash('/ipfs-upload hello world'), { kind: 'local', action: 'ipfs-upload', arg: 'hello world' });
  assert.deepEqual(parseSlash('/search ipfs pinning'), { kind: 'prompt', prompt: 'Search the web for: ipfs pinning', agentic: false });
  assert.deepEqual(parseSlash('/summarise'), { kind: 'prompt', prompt: 'Summarise the page I am on.', agentic: false });
  assert.deepEqual(parseSlash('/agent find the pricing page'), { kind: 'prompt', prompt: 'find the pricing page', agentic: true });
  assert.deepEqual(parseSlash('/ipfs-cat ipfs://bafyabc'), { kind: 'prompt', prompt: 'What does this IPFS content say?', agentic: false, cid: 'bafyabc' });
  assert.match(parseSlash('/agent').message, /^Usage: \/agent <task> — Let the agent act/);
  assert.equal(parseSlash('/research').kind, 'usage');
  assert.equal(parseSlash('/report Kubo GC\nwith charts').prompt, 'Research Kubo GC\nwith charts and create a PDF report of your findings.');
});

test('suggestSlash: prefix first, then matches in the description; none after a space', () => {
  assert.equal(suggestSlash('/').length, 8);
  assert.deepEqual(suggestSlash('/ip').map((c) => c.cmd), ['/ipfs-cat', '/ipfs-upload', '/ipfs']);
  assert.ok(suggestSlash('/pdf').some((c) => c.cmd === '/report'), 'description matches too');
  assert.deepEqual(suggestSlash('/agent '), []);
  assert.deepEqual(suggestSlash('hello'), []);
  assert.equal(new Set(SLASH_COMMANDS.map((c) => c.cmd)).size, SLASH_COMMANDS.length);
});

test('threads: titles, history, ordering and limits', () => {
  assert.equal(titleFrom('/agent find the cheapest plan on this site please, and book it'), 'find the cheapest plan on this site please, and…');
  assert.equal(titleFrom('\n\n  What is a CID?\nmore'), 'What is a CID?');
  assert.equal(titleFrom('   '), 'New chat');

  const msgs = [
    { role: 'user', content: 'Hi', ts: 1 },
    { role: 'agent', content: 'Hello!', ts: 2 },
    { role: 'error', content: 'Agent Error: boom', ts: 3 },
    { role: 'agent', content: '  ', ts: 4 },
  ];
  assert.deepEqual(historyFor(msgs), [{ role: 'user', content: 'Hi' }, { role: 'assistant', content: 'Hello!' }]);
  assert.equal(historyFor(Array.from({ length: 30 }, (_, i) => ({ role: 'user', content: `q${i}`, ts: i }))).length, 12);

  const a = newThread(1000);
  const b = newThread(2000);
  assert.notEqual(a.id, b.id);
  let list = upsertThread([], a);
  list = upsertThread(list, b);
  list = upsertThread(list, { ...a, updatedAt: 3000 });
  assert.deepEqual(list.map((t) => t.id), [a.id, b.id]);
  for (let i = 0; i < MAX_THREADS + 5; i++) list = upsertThread(list, newThread(i));
  assert.equal(list.length, MAX_THREADS);
  const big = upsertThread([], { ...a, messages: Array.from({ length: MAX_MESSAGES + 10 }, (_, i) => ({ role: 'user', content: `${i}`, ts: i })) });
  assert.equal(big[0].messages.length, MAX_MESSAGES);
  assert.equal(big[0].messages[0].content, '10', 'the oldest messages go first');
});

test('sanitizeThreads drops malformed threads and messages, newest first', () => {
  assert.deepEqual(sanitizeThreads('x'), []);
  const out = sanitizeThreads([
    { id: 't1', title: 'Old', createdAt: 1, updatedAt: 10, messages: [{ role: 'user', content: 'a', ts: 1 }, { role: 'system', content: 'x', ts: 2 }, 'junk'] },
    { id: 't1', title: 'Duplicate', updatedAt: 99, messages: [] },
    { id: 't2', title: '', updatedAt: 20, messages: [] },
    { title: 'no id', messages: [] },
    { id: 't3', messages: 'nope' },
  ]);
  assert.deepEqual(out.map((t) => [t.id, t.title, t.messages.length]), [['t2', 'New chat', 0], ['t1', 'Old', 1]]);
});

test('threadDay', () => {
  const now = new Date(2026, 9, 19, 12).getTime();
  assert.equal(threadDay(now - 3600_000, now), 'Today');
  assert.equal(threadDay(now - 86_400_000, now), 'Yesterday');
  assert.match(threadDay(now - 5 * 86_400_000, now), /Oct|14/);
});
