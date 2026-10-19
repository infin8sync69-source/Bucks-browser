// Stand-in for `python -m uvicorn soul_engine:app` in the supervisor tests. Same HTTP surface the
// supervisor uses (/health open, /providers behind the bearer token), plus /_calls and /_env so a
// test can see what the supervisor did. Behaviour is chosen with FAKE_SOUL_MODE.
import http from 'node:http';

const port = Number(process.argv[process.argv.indexOf('--port') + 1]);
const mode = process.env.FAKE_SOUL_MODE || 'ok';
const token = process.env.BUCKS_SOUL_TOKEN;
const calls = [];
let provider = 'nim'; // the engine "remembers" another backend: the supervisor must fix that
let healthCalls = 0;
let currentModel = 'qwen2.5-1.5b';
const models = () => [
  { id: 'qwen2.5-1.5b', size_gb: 1.1, fits_ram: true, downloaded: true, current: currentModel === 'qwen2.5-1.5b' },
  { id: 'qwen2.5-3b', size_gb: 2.1, fits_ram: true, downloaded: false, current: currentModel === 'qwen2.5-3b' },
  { id: 'huge-70b', size_gb: 40, fits_ram: false, downloaded: false, current: false },
];
let pending = [
  { update_id: 'abc123', peer_soul_id: 'peer-soul-1', kind: 'fragment', cid: 'bafkreiexample', summary: 'Notes on Kubo GC', status: 'pending', created_at: 1760000000, decided_at: null, peer: { locality: 'Lisbon', capabilities: ['research'] } },
  { update_id: 'def456', peer_soul_id: 'peer-soul-2', kind: 'adapter', cid: 'bafkreiadapter', summary: '', status: 'pending', created_at: 1760000100, decided_at: null, peer: null },
];

if (mode === 'exit-at-start') {
  console.error('ModuleNotFoundError: No module named fastapi');
  process.exit(3);
}

const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    const json = (code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
    if (req.url === '/health') {
      healthCalls += 1;
      if (mode === 'crash-after-ready' && healthCalls === 1) setTimeout(() => process.exit(1), 500);
      const loading = mode === 'loading-then-ready' && healthCalls < 3;
      return json(200, { model: currentModel, mode: mode === 'ollama-down' ? 'offline' : loading ? 'loading' : 'local_llm', online: true });
    }
    if (req.headers.authorization !== `Bearer ${token}`) return json(401, { error: 'unauthorized' });
    calls.push(`${req.method} ${req.url}${body ? ` ${body}` : ''}`);
    if (req.url === '/providers') return json(200, { current: provider });
    if (req.url === '/providers/select') { provider = JSON.parse(body).provider; return json(200, { ok: true, provider }); }
    if (req.url === '/models') return json(200, { models: models(), current: currentModel, provider, activeModel: currentModel });
    if (req.url === '/models/select') {
      const id = JSON.parse(body).model;
      if (!models().some((m) => m.id === id)) return json(200, { ok: false, error: `unknown model id: ${id}` });
      currentModel = id;
      return json(200, { ok: true, model: id });
    }
    if (req.url === '/models/download-progress') return json(200, { active: true, model_id: 'qwen2.5-3b', downloaded_bytes: 500, total_bytes: 2000 });
    if (req.url === '/agent/pending?status=pending') return json(200, { updates: pending });
    const decide = /^\/agent\/pending\/([^/]+)\/(approve|deny)$/.exec(req.url);
    if (decide) {
      if (!pending.some((u) => u.update_id === decide[1])) return json(200, { ok: false, error: 'no such pending update' });
      pending = pending.filter((u) => u.update_id !== decide[1]);
      return json(200, { ok: true, status: decide[2] === 'approve' ? 'approved' : 'denied' });
    }
    if (req.url === '/_calls') return json(200, calls);
    if (req.url === '/_env') {
      const keys = ['BUCKS_SOUL_TOKEN', 'BUCKS_DATA_DIR', 'BUCKS_HOME', 'BUCKS_PROJECT_ROOT', 'MODEL_PROVIDER', 'OLLAMA_BASE_URL', 'BUCKS_MODEL', 'NGC_API_KEY'];
      return json(200, Object.fromEntries(keys.map((k) => [k, process.env[k] ?? null])));
    }
    return json(404, {});
  });
});
server.listen(port, '127.0.0.1', () => console.log(`fake soul engine on ${port}`));
process.on('SIGTERM', () => server.close(() => process.exit(0)));
