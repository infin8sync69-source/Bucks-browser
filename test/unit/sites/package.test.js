import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseManifest, parseRedirects, matchRedirect, buildDescriptor, headersFor, compilePattern, hasExtension, isSafeRelativePath,
} from '../../../src/main/sites/package.js';

test('parseManifest: defaults, the documented example, and invalid keys falling back', () => {
  assert.deepEqual(parseManifest('{}'), { manifest: { name: null, entry: 'index.html', spa: false, notFound: null, headers: [], csp: null, serviceWorker: false }, errors: [] });
  const doc = parseManifest(JSON.stringify({
    name: 'Legrand SPD trainer', entry: 'index.html', spa: true, notFound: '404.html',
    headers: { '/*': { 'X-Content-Type-Options': 'nosniff' } },
    csp: "default-src 'self'; img-src 'self' data: https:; connect-src 'self' https:",
    serviceWorker: false,
  }));
  assert.deepEqual(doc.errors, []);
  assert.equal(doc.manifest.name, 'Legrand SPD trainer');
  assert.equal(doc.manifest.spa, true);
  assert.equal(doc.manifest.notFound, '404.html');
  assert.deepEqual(doc.manifest.headers, [{ pattern: '/*', headers: { 'X-Content-Type-Options': 'nosniff' } }]);
  assert.match(doc.manifest.csp, /^default-src 'self'/);

  const bad = parseManifest(JSON.stringify({
    entry: '../../etc/passwd', spa: 'yes', notFound: '/a/../b', name: '',
    headers: { 'no-slash': { A: 'b' }, '/x': { 'Set-Cookie': 'a=1', 'Bad Name': 'v', 'X-Ok': 'fine', 'X-Newline': 'a\r\nb' } },
    csp: 42, serviceWorker: true,
  }));
  assert.equal(bad.manifest.entry, 'index.html');
  assert.equal(bad.manifest.spa, false);
  assert.equal(bad.manifest.notFound, null);
  assert.deepEqual(bad.manifest.headers, [{ pattern: '/x', headers: { 'X-Ok': 'fine' } }]);
  assert.equal(bad.manifest.csp, null);
  for (const re of [/"entry"/, /"spa"/, /"notFound"/, /"name"/, /no-slash/, /cannot set Set-Cookie/, /Bad Name/, /X-Newline/, /"csp"/, /serviceWorker/]) {
    assert.ok(bad.errors.some((e) => re.test(e)), `missing error ${re}`);
  }
  assert.match(parseManifest('{not json').errors[0], /not valid JSON/);
  assert.match(parseManifest('[1]').errors[0], /JSON object/);
  assert.equal(parseManifest(JSON.stringify({ entry: '/app.html' })).manifest.entry, 'app.html');
});

test('parseRedirects: subset, SPA rule, forced rules and bad lines', () => {
  const r = parseRedirects([
    '# comment',
    '/old        /new         301',
    '/blog/:slug /posts/:slug',
    '/docs/*     /manual/:splat  200',
    '/gone       /404.html    404',
    '/ext        https://example.com/x  302',
    '/forced     /x           200!',
    '/rewrite-out https://evil.example/  200',
    '/teapot     /x           418',
    'not-a-path  /x',
    'too many columns here',
    '/*          /index.html  200',
    '',
  ].join('\n'));
  assert.equal(r.spa, true);
  assert.equal(r.spaEntry, 'index.html');
  assert.deepEqual(r.rules, [
    { from: '/old', to: '/new', status: 301 },
    { from: '/blog/:slug', to: '/posts/:slug', status: 301 },
    { from: '/docs/*', to: '/manual/:splat', status: 200 },
    { from: '/gone', to: '/404.html', status: 404 },
    { from: '/ext', to: 'https://example.com/x', status: 302 },
  ]);
  assert.equal(r.warnings.length, 5);
  assert.ok(r.warnings.some((w) => /line 7: forced rules/.test(w)));
  assert.ok(r.warnings.some((w) => /line 8: .*must be a path in the site$/.test(w)));
  assert.ok(r.warnings.some((w) => /status 418/.test(w)));

  const many = parseRedirects(Array.from({ length: 150 }, (_, i) => `/a${i} /b${i}`).join('\n'));
  assert.equal(many.rules.length, 100);
  assert.ok(many.warnings.some((w) => /first 100 rules/.test(w)));
});

test('matchRedirect: first match wins, placeholders substituted, trailing slash tolerated', () => {
  const { rules } = parseRedirects('/blog/:slug /posts/:slug 301\n/docs/* /manual/:splat 200\n/docs/special /nope 200');
  assert.deepEqual(matchRedirect(rules, '/blog/hello'), { rule: rules[0], target: '/posts/hello' });
  assert.deepEqual(matchRedirect(rules, '/blog/hello/'), { rule: rules[0], target: '/posts/hello' });
  assert.equal(matchRedirect(rules, '/blog/a/b'), null);
  assert.equal(matchRedirect(rules, '/docs/special').target, '/manual/special');
  assert.equal(matchRedirect(rules, '/docs/a/b/c').target, '/manual/a/b/c');
  assert.equal(matchRedirect(rules, '/docs').target, '/manual/');
  assert.equal(matchRedirect(rules, '/elsewhere'), null);
  assert.equal(compilePattern('relative'), null);
  assert.equal(compilePattern('/with space'), null);
  assert.ok(compilePattern('/a.b+c').re.test('/a.b+c'));
  assert.ok(!compilePattern('/a.b').re.test('/aXb'), 'dots are literal');
});

test('buildDescriptor: manifest wins over _redirects; neither means plain gateway behaviour', () => {
  assert.equal(buildDescriptor({}).source, 'none');
  const fromRedirects = buildDescriptor({ redirectsText: '/*  /index.html  200\n/old /new 301' });
  assert.equal(fromRedirects.source, 'redirects');
  assert.equal(fromRedirects.spa, true);
  assert.equal(fromRedirects.fallback, 'index.html');
  assert.equal(fromRedirects.rules.length, 1);
  const both = buildDescriptor({ manifestText: '{"spa":false,"notFound":"404.html","entry":"app.html"}', redirectsText: '/* /index.html 200' });
  assert.equal(both.source, 'manifest');
  assert.equal(both.spa, false);
  assert.equal(both.entry, 'app.html');
  assert.equal(both.fallback, 'app.html');
  assert.equal(both.notFound, '404.html');
  assert.deepEqual(both.rules, []);
});

test('headersFor merges matching blocks in order and csp replaces any CSP header', () => {
  const d = buildDescriptor({ manifestText: JSON.stringify({ headers: { '/*': { 'X-A': '1', 'content-security-policy': 'default-src *' }, '/assets/*': { 'X-A': '2', 'Cache-Control': 'no-cache' } }, csp: "default-src 'self'" }) });
  assert.deepEqual(headersFor(d, '/assets/app.js'), { 'X-A': '2', 'Cache-Control': 'no-cache', 'Content-Security-Policy': "default-src 'self'" });
  assert.deepEqual(headersFor(d, '/'), { 'X-A': '1', 'Content-Security-Policy': "default-src 'self'" });
  assert.deepEqual(headersFor(buildDescriptor({}), '/'), {});
});

test('hasExtension and isSafeRelativePath', () => {
  assert.equal(hasExtension('/a/b.js'), true);
  assert.equal(hasExtension('/deep/link'), false);
  assert.equal(hasExtension('/v1.2/'), false);
  assert.equal(hasExtension('/'), false);
  assert.equal(isSafeRelativePath('a/b.html'), true);
  for (const bad of ['', '/a', 'a/../b', 'a//b', 'a\\b', null]) assert.equal(isSafeRelativePath(bad), false);
});
