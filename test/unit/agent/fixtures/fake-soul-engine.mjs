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
      return json(200, { model: 'qwen2.5:3b', mode: mode === 'ollama-down' ? 'offline' : loading ? 'loading' : 'local_llm', online: true });
    }
    if (req.headers.authorization !== `Bearer ${token}`) return json(401, { error: 'unauthorized' });
    calls.push(`${req.method} ${req.url}${body ? ` ${body}` : ''}`);
    if (req.url === '/providers') return json(200, { current: provider });
    if (req.url === '/providers/select') { provider = JSON.parse(body).provider; return json(200, { ok: true, provider }); }
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
