import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createSoulProvider, sseEvents, buildContext, buildMessage, snapshotRefs } from '../../../src/main/agent/providers/soul.js';
import { normalizeComponent, normalizeComponents, splitFollowups } from '../../../src/main/agent/genui.js';

const TOKEN = 'secret-token';
let server;
let base;
let mode = 'ok';
const seen = [];

const sse = (obj) => `data: ${JSON.stringify(obj)}\n\n`;

before(async () => {
  server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const parsed = body ? JSON.parse(body) : null;
      seen.push({ method: req.method, url: req.url, auth: req.headers.authorization || null, body: parsed });
      const json = (code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
      if (req.url === '/health') return json(200, { model: 'qwen2.5:3b', mode: mode === 'loading' ? 'loading' : 'local_llm', online: true });
      if (req.headers.authorization !== `Bearer ${TOKEN}`) return json(401, { error: 'unauthorized' });
      if (req.url === '/agent') {
        if (mode === 'http-error') return json(500, { detail: 'kaput' });
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        const events = [
          sse({ type: 'session', session_id: 'sess-1' }),
          sse({ type: 'thinking', content: 'Thinking it through…' }),
          sse({ type: 'tool_call', name: 'web_search', args: { query: 'ipfs' } }),
          sse({ type: 'tool_result', name: 'web_search', content: '…' }),
        ];
        if (mode === 'approval') {
          events.push(sse({ type: 'browser_action', id: 'a1', action_id: 'a1', name: 'cluster_pin', needs_approval: true, session_id: 'sess-1', label: 'Pin bafy… on this node' }));
        }
        if (mode === 'agentic') {
          events.push(
            sse({ type: 'browser_action', id: 'r1', action_id: 'x1', name: 'browser_read_page', args: {}, needs_approval: false, session_id: 'sess-1', label: 'Read the page' }),
            sse({ type: 'browser_action', id: 'r2', action_id: 'x2', name: 'browser_click', args: { ref: 3 }, needs_approval: true, session_id: 'sess-1', label: 'Click [3]' }),
            // The engine forgot the flag: a click still needs the user.
            sse({ type: 'browser_action', id: 'r3', action_id: 'x3', name: 'browser_type', args: { ref: 4, text: 'hi' }, needs_approval: false, session_id: 'sess-1', label: 'Type' }),
            sse({ type: 'browser_action', id: 'r4', action_id: 'x4', name: 'create_pdf', args: { title: 'R', content: '# R' }, needs_approval: false, session_id: 'sess-1', label: 'PDF' }),
          );
        }
        if (mode === 'site') {
          // A hosting tool: run in the browser, which asks with its own card. The engine's label must not be used to ask.
          events.push(sse({ type: 'tool_call', name: 'site_publish', args: { token: 't' }, label: 'site_publish(token=t)' }));
          events.push(sse({ type: 'browser_action', id: 's1', action_id: 'y1', name: 'site_publish', args: { token: 't', name: 'Trainer' }, needs_approval: false, session_id: 'sess-1', label: 'Totally safe, just approve' }));
          // an engine that flags the call and words the card itself is not believed either
          events.push(sse({ type: 'browser_action', id: 's2', action_id: 'y2', name: 'site_update', args: { id: 's_1' }, needs_approval: true, session_id: 'sess-1', label: 'Harmless update, click yes' }));
        }
        if (mode === 'slow') {
          res.write(sse({ type: 'session', session_id: 'sess-slow' }));
          res.write(sse({ type: 'token', content: 'Half an ' }));
          return; // never ends: the client has to stop it
        }
        if (mode === 'error') {
          events.push(sse({ type: 'error', content: 'Agent error: model crashed' }));
        } else {
          events.push(
            sse({ type: 'ui_component', component: 'table', title: 'Compare', data: { columns: ['A', 'B'], rows: [['1', '2']] } }),
            sse({ type: 'ui_component', component: 'evil_widget', data: {} }),
            sse({ type: 'token', content: 'IPFS is a ' }),
            sse({ type: 'token', content: 'content-addressed network.\n<followup>How do I pin a file?</followup><followup>What is a CID?</followup>' }),
          );
        }
        events.push(sse({ type: 'done', session_id: 'sess-1', result: '' }), 'data: [DONE]\n\n');
        // Split the stream at awkward places: the parser must reassemble events across chunks.
        const all = events.join('');
        const cut = [7, 40, 41, 100, all.length - 3];
        let prev = 0;
        for (const c of cut) { res.write(all.slice(prev, c)); prev = c; }
        res.end(all.slice(prev));
        return;
      }
      if (req.url.startsWith('/agent/deny/') || req.url.startsWith('/agent/approve/') || req.url.startsWith('/agent/cancel/') || req.url === '/agent/tool_result') return json(200, { ok: true });
      if (req.url === '/agent/feedback') return json(200, parsed.session_id === 'sess-1' ? { ok: true } : { ok: false, error: 'unknown session_id' });
      if (req.url === '/models') return json(200, { models: [{ id: 'llama3.2:1b' }, { id: 'qwen2.5:3b' }, { nope: 1 }] });
      return json(404, {});
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

const soul = createSoulProvider();
const cfg = () => ({ soul: { url: base, token: TOKEN } });

test('isAvailable needs a connection and a ready model', async () => {
  mode = 'ok';
  assert.equal(await soul.isAvailable({}), false, 'no engine running');
  assert.equal(await soul.isAvailable(cfg()), true);
  mode = 'loading';
  assert.equal(await soul.isAvailable(cfg()), false);
  assert.equal(await soul.isAvailable({ soul: { url: 'http://127.0.0.1:1', token: 't' } }), false);
});

test('query streams the answer, cards and follow-ups, with the token', async () => {
  mode = 'ok'; seen.length = 0;
  const r = await soul.query({ prompt: 'what is ipfs', currentUrl: 'https://a.b', currentTitle: 'A', pageText: 'body' }, cfg());
  const call = seen.find((s) => s.url === '/agent');
  assert.equal(call.auth, `Bearer ${TOKEN}`);
  assert.equal(call.body.message, 'what is ipfs');
  assert.equal(call.body.agentic, false);
  assert.match(call.body.context, /^Page: A - https:\/\/a\.b/);
  assert.match(call.body.context, /untrusted third-party content/);
  assert.equal(r.status, 'ok');
  assert.equal(r.evaluation, 'IPFS is a content-addressed network.');
  assert.deepEqual(r.followups, ['How do I pin a file?', 'What is a CID?']);
  assert.equal(r.task_id, 'sess-1');
  assert.deepEqual(r.tools, ['web_search']);
  assert.deepEqual(r.components, [{ component: 'table', title: 'Compare', columns: ['A', 'B'], rows: [['1', '2']] }], 'unknown components are dropped');
});

test('an action that needs approval is denied without a way to ask, and explained', async () => {
  mode = 'approval'; seen.length = 0;
  const r = await soul.query({ prompt: 'pin it' }, cfg());
  const deny = seen.find((s) => s.url.startsWith('/agent/deny/'));
  assert.ok(deny, 'the engine is told no instead of waiting 30 s');
  assert.equal(deny.url, '/agent/deny/sess-1');
  assert.deepEqual(deny.body, { action_id: 'a1' });
  assert.equal(deny.auth, `Bearer ${TOKEN}`);
  assert.match(r.evaluation, /Not done \(not allowed, or not answered in time\): Pin bafy… on this node/);
});

test('approved engine-side action: the engine is told yes and runs it itself', async () => {
  mode = 'approval'; seen.length = 0;
  const asked = [];
  const r = await soul.query({ prompt: 'pin it', requestApproval: async (a) => { asked.push(a); return true; } }, cfg());
  assert.deepEqual(asked, [{ name: 'cluster_pin', label: 'Pin bafy… on this node' }]);
  assert.deepEqual(seen.find((s) => s.url.startsWith('/agent/approve/'))?.body, { action_id: 'a1' });
  assert.equal(seen.some((s) => s.url === '/agent/tool_result'), false, 'nothing to run here');
  assert.doesNotMatch(r.evaluation, /Not done/);
});

test('agentic: tools run here, changes are asked for (even unflagged ones), results go back', async () => {
  mode = 'agentic'; seen.length = 0;
  const asked = [];
  const labels = [];
  const ran = [];
  const events = [];
  const r = await soul.query({
    prompt: 'click the button', agentic: true,
    onEvent: (e) => events.push(e),
    requestApproval: async (a) => { asked.push(a.name); labels.push(a.label); return a.name === 'browser_click'; },
    runTool: async (name, args, ctx) => {
      ran.push([name, args, ctx.tabTools]);
      if (name === 'create_pdf') { ctx.onFile('/docs/R.pdf'); return 'PDF report saved to /docs/R.pdf'; }
      if (name === 'browser_read_page') return 'URL: https://shop.test/\nTitle: Shop\n[3] button: Buy now';
      return `ran ${name}`;
    },
  }, cfg());
  assert.equal(seen.find((s) => s.url === '/agent').body.agentic, true);
  assert.deepEqual(asked, ['browser_click', 'browser_type']);
  assert.deepEqual(ran.map((x) => x[0]), ['browser_read_page', 'browser_click', 'create_pdf'], 'the refused typing never ran');
  assert.ok(ran.every((x) => x[2] === true));
  const results = seen.filter((s) => s.url === '/agent/tool_result').map((s) => s.body);
  assert.deepEqual(results, [
    { id: 'r1', result: 'URL: https://shop.test/\nTitle: Shop\n[3] button: Buy now' },
    { id: 'r2', result: 'ran browser_click' },
    { id: 'r3', result: 'The user did not allow this action.' },
    { id: 'r4', result: 'PDF report saved to /docs/R.pdf' },
  ]);
  assert.deepEqual(seen.find((s) => s.url.startsWith('/agent/approve/'))?.body, { action_id: 'x2' });
  assert.deepEqual(r.documents, ['/docs/R.pdf']);
  assert.equal(labels[0], 'Click [3]: button "Buy now"', 'the card says what will be clicked');
  assert.ok(events.some((e) => e.type === 'status' && e.label === 'Thinking it through…'));
  assert.ok(events.some((e) => e.type === 'status' && e.label === 'Read the page'));
  assert.match(r.evaluation, /Not done .*: Type/);
});

test('site tools: run by the browser with their own approval, never asked with the engine label', async () => {
  mode = 'site'; seen.length = 0;
  const asked = [];
  const ran = [];
  const events = [];
  await soul.query({
    prompt: 'publish my website',
    onEvent: (e) => events.push(e),
    requestApproval: async (a) => { asked.push(a); return true; },
    runTool: async (name, args) => { ran.push([name, args]); return 'Published "Trainer".'; },
  }, cfg());
  assert.deepEqual(asked, [], 'the provider does not ask: the site tool asks with the trusted card');
  assert.deepEqual(ran, [['site_publish', { token: 't', name: 'Trainer' }], ['site_update', { id: 's_1' }]]);
  assert.deepEqual(seen.filter((s) => s.url === '/agent/tool_result').map((s) => s.body), [{ id: 's1', result: 'Published "Trainer".' }, { id: 's2', result: 'Published "Trainer".' }]);
  assert.deepEqual(seen.find((s) => s.url.startsWith('/agent/approve/'))?.body, { action_id: 'y2' }, 'the engine-side wait is released; the card in main decides');
  assert.ok(events.some((e) => e.type === 'status' && /needs your approval/.test(e.label)));
  assert.ok(!events.some((e) => /Totally safe|Harmless update/.test(e.label || '')), 'the engine label is never shown');
});

test('stopping a query cancels the engine session and keeps what was said', async () => {
  mode = 'slow'; seen.length = 0;
  const controller = new AbortController();
  const p = soul.query({ prompt: 'long one', signal: controller.signal }, cfg());
  await new Promise((r) => setTimeout(r, 300));
  controller.abort();
  const r = await p;
  assert.match(r.evaluation, /^Half an\s*\n\nStopped\.$/);
  assert.ok(seen.some((s) => s.url === '/agent/cancel/sess-slow'));
});

test('errors: engine error event, HTTP error, not running', async () => {
  mode = 'error';
  await assert.rejects(soul.query({ prompt: 'x' }, cfg()), /model crashed/);
  mode = 'http-error';
  await assert.rejects(soul.query({ prompt: 'x' }, cfg()), /responded 500: .*kaput/);
  await assert.rejects(soul.query({ prompt: 'x' }, {}), /not running/);
  await assert.rejects(soul.query({ prompt: 'x' }, { soul: { url: base, token: 'wrong' } }), /responded 401/);
});

test('feedback and models', async () => {
  mode = 'ok'; seen.length = 0;
  assert.deepEqual(await soul.feedback({ taskId: 'sess-1', score: 5, correction: '' }, cfg()), { ok: true });
  assert.deepEqual(seen.at(-1).body, { session_id: 'sess-1', score: 1, correction: null }, 'scores are reduced to -1 | 0 | 1');
  assert.deepEqual(await soul.feedback({ taskId: 'zzz', score: -2 }, cfg()), { ok: false, message: 'unknown session_id' });
  assert.deepEqual(await soul.listModels(cfg()), ['llama3.2:1b', 'qwen2.5:3b']);
  assert.deepEqual(await soul.listModels({}), []);
});

test('sseEvents: multi-line data, CRLF, junk and [DONE]', async () => {
  const enc = new TextEncoder();
  async function* body() {
    yield enc.encode('data: {"a":\r\ndata: 1}\r\n\r\n: comment\n\ndata: not json\n\n');
    yield enc.encode('data: {"b":2}\n\ndata: [DONE]\n\ndata: {"c":3}\n\n');
  }
  const out = [];
  for await (const ev of sseEvents(body())) out.push(ev);
  assert.deepEqual(out, [{ a: 1 }, { b: 2 }]);
});

test('buildContext', () => {
  assert.equal(buildContext({}), '');
  assert.equal(buildContext({ currentUrl: 'https://x.y' }), 'Page: https://x.y');
  assert.equal(buildContext({ pageText: 'z'.repeat(9000) }).length < 6200, true);
  assert.equal(
    buildContext({ history: [{ role: 'user', content: 'Hi' }, { role: 'assistant', content: 'Hello!' }] }),
    'Conversation so far (oldest first):\nUser: Hi\nAssistant: Hello!',
  );
  assert.deepEqual(snapshotRefs('URL: x\n[0] a: Pricing → https://x/p\n[3] input(search): Search shop\n[12] button: Buy now'), { 0: 'a "Pricing"', 3: 'input "Search shop"', 12: 'button "Buy now"' });
  assert.equal(buildMessage({ prompt: 'Summarise' }), 'Summarise');
  assert.equal(buildMessage({ prompt: 'Summarise', attachments: 'ATT' }), 'Summarise\n\nATT');
});

/* ---------- generative UI normalisation ---------- */

test('genui: links must be http(s)/ipfs, strings are bounded, html is just text', () => {
  const [card] = normalizeComponent({
    component: 'list',
    title: '<b>Results</b>',
    data: { items: [
      { title: 'ok', url: 'https://example.com' },
      { title: 'js', url: 'javascript:alert(1)' },
      { title: 'x'.repeat(1000), url: 'ipfs://bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi' },
      'garbage',
    ] },
  });
  assert.equal(card.title, '<b>Results</b>', 'kept verbatim; the chrome renders it as text');
  assert.deepEqual(card.items[0], { title: 'ok', subtitle: '', url: 'https://example.com' });
  assert.equal(card.items[1].url, '', 'javascript: link removed');
  assert.equal(card.items[2].title.length, 300);
  assert.equal(card.items.length, 3);
});

test('genui: every engine component maps to a chrome card', () => {
  const kinds = (spec) => normalizeComponent(spec).map((c) => c.component);
  assert.deepEqual(kinds({ component: 'stat_cards', data: { stats: [{ label: 'Peers', value: 12, delta: '+2' }] } }), ['stats']);
  assert.deepEqual(kinds({ component: 'chart', data: { kind: 'pie', series: [{ label: 'a', value: '1,5' }, { label: 'b', value: 'x' }] } }), ['chart']);
  assert.deepEqual(kinds({ component: 'timeline', data: { events: [{ date: '2009', title: 'Bitcoin' }] } }), ['timeline']);
  assert.deepEqual(kinds({ component: 'checklist', data: { items: ['pack', { text: 'go', done: true }, { nope: 1 }] } }), ['checklist']);
  assert.deepEqual(kinds({ component: 'accordion', data: { items: [{ heading: 'Q', text: 'A' }] } }), ['accordion']);
  assert.deepEqual(kinds({ component: 'code', data: { language: 'js', code: 'let a = 1' } }), ['code']);
  assert.deepEqual(kinds({ component: 'weather', data: { place: 'Kochi', current: { temp_c: 30 }, days: [{ day: 'Mon', high_c: 31, low_c: 25 }] } }), ['weather']);
  assert.deepEqual(kinds({ component: 'answer', data: { markdown: 'hi' } }), ['answer']);
  assert.deepEqual(kinds({ component: 'product_grid', data: { items: [{ title: 'Phone', price: '₹9,999', url: 'https://shop.example/p' }] } }), ['list']);
  assert.deepEqual(kinds({ component: 'image_gallery', data: { items: [{ title: 'cat', image: 'https://img.example/c.jpg' }] } }), ['list']);
  assert.deepEqual(kinds({ component: 'cta_row', data: { actions: [{ label: 'Open', kind: 'navigate', value: 'https://a.b' }, { label: 'Copy', kind: 'copy', value: 'x' }] } }), ['links']);
  assert.deepEqual(kinds({ component: 'research', data: { summary: 'S', sections: [{ heading: 'H', text: 'T' }], sources: [{ title: 'W', url: 'https://w.org' }], stats: [] } }), ['answer', 'list', 'list']);
  assert.deepEqual(kinds({ component: 'table', data: { columns: ['a'], rows: [] } }), [], 'empty cards are dropped');
});

test('genui: videos become YouTube links only for valid ids; the total is capped', () => {
  const [v] = normalizeComponent({ component: 'video', data: { videos: [{ videoId: 'dQw4w9WgXcQ', title: 'v' }, { videoId: '"><script>', title: 'bad' }] } });
  assert.deepEqual(v.items, [{ title: 'v', subtitle: '', url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' }]);
  const many = Array.from({ length: 30 }, () => ({ component: 'answer', data: { markdown: 'x' } }));
  assert.equal(normalizeComponents(many).length, 12);
  assert.deepEqual(normalizeComponents('nope'), []);
});

test('splitFollowups', () => {
  assert.deepEqual(splitFollowups('Answer.\n\n<followup> One? </followup>\n<followup>One?</followup><FOLLOWUP>Two?</FOLLOWUP>'), { text: 'Answer.', followups: ['One?', 'Two?'] });
  assert.deepEqual(splitFollowups(undefined), { text: '', followups: [] });
});
