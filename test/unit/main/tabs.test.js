import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';

register('./helpers/electron-loader.mjs', import.meta.url);
const {
  navigationDecision, canonicalUrl, isBareIpfsUrl, schemeOf, clampBounds,
  isHttpsFallbackError, isUpgradedHttpsFailure, downgradeToHttp, buildTabState, ALLOWED_SCHEMES, zoomPercent, pdfFileName,
} = await import('../../../src/main/tabs.js');

test('schemeOf / isBareIpfsUrl', () => {
  assert.equal(schemeOf('HTTPS://x'), 'https:');
  assert.equal(schemeOf('  ipfs://bafy'), 'ipfs:');
  assert.equal(schemeOf('example.com'), null);
  assert.equal(schemeOf(''), null);
  assert.equal(isBareIpfsUrl('ipfs://'), true);
  assert.equal(isBareIpfsUrl('ipns:///'), true);
  assert.equal(isBareIpfsUrl('ipfs://bafy'), false);
});

test('canonicalUrl normalises ipfs/ipns and leaves others alone', () => {
  const v0 = 'ipfs://QmPZ9gcCEpqKTo6aq61g2nXGUhM4iCL3ewB6LDXZCtioEB/readme';
  const canon = canonicalUrl(v0);
  assert.match(canon, /^ipfs:\/\/bafy[a-z2-7]+\/readme$/);
  assert.equal(canonicalUrl(canon), canon, 'idempotent');
  assert.equal(canonicalUrl('https://Example.com/A'), 'https://Example.com/A');
  assert.equal(canonicalUrl('ipns://docs.ipfs.tech/x'), 'ipns://docs.ipfs.tech/x');
  assert.equal(canonicalUrl(undefined), '');
});

test('navigationDecision enforces the scheme policy', () => {
  assert.equal(navigationDecision('https://a'), 'allow');
  assert.equal(navigationDecision('http://a'), 'allow');
  assert.equal(navigationDecision('ipfs://bafy'), 'allow');
  assert.equal(navigationDecision('ipns://x'), 'allow');
  assert.equal(navigationDecision('about:blank'), 'allow');
  assert.equal(navigationDecision('data:text/html,hi'), 'allow');
  assert.equal(navigationDecision('blob:https://a/uuid'), 'allow');
  assert.equal(navigationDecision('bucks://app/'), 'forward');
  assert.equal(navigationDecision('BUCKS://wallet'), 'forward');
  assert.equal(navigationDecision('javascript:alert(1)'), 'block');
  assert.equal(navigationDecision('file:///etc/passwd'), 'block');
  assert.equal(navigationDecision('file:///tmp/x.html', { allowFile: true }), 'allow');
  assert.equal(navigationDecision('ftp://x'), 'block');
  assert.equal(navigationDecision('chrome://gpu'), 'block');
  assert.equal(navigationDecision('devtools://x'), 'block');
  assert.equal(navigationDecision('mailto:a@b'), 'block');
  assert.equal(navigationDecision('no-scheme'), 'block');
  assert.equal(ALLOWED_SCHEMES.length, 8);
});

test('clampBounds yields non-negative integers', () => {
  assert.deepEqual(clampBounds({ x: 10.6, y: -5, width: 800.2, height: 'x' }), { x: 11, y: 0, width: 800, height: 0 });
  assert.deepEqual(clampBounds(null), { x: 0, y: 0, width: 0, height: 0 });
});

test('https-only fallback detection', () => {
  assert.equal(isHttpsFallbackError(-102, 'ERR_CONNECTION_REFUSED'), true);
  assert.equal(isHttpsFallbackError(-200, 'ERR_CERT_COMMON_NAME_INVALID'), true);
  assert.equal(isHttpsFallbackError(-107, 'ERR_SSL_PROTOCOL_ERROR'), true);
  assert.equal(isHttpsFallbackError(-105, 'ERR_NAME_NOT_RESOLVED'), false);
  assert.equal(isHttpsFallbackError(-3, 'ERR_ABORTED'), false);

  assert.equal(isUpgradedHttpsFailure('http://router.local/', 'https://router.local/'), true);
  assert.equal(isUpgradedHttpsFailure('https://router.local/', 'https://router.local/'), false, 'user asked for https explicitly');
  assert.equal(isUpgradedHttpsFailure('http://a.com/', 'https://b.com/'), false);
  assert.equal(isUpgradedHttpsFailure('garbage', 'https://b.com/'), false);
  assert.equal(downgradeToHttp('https://router.local:8443/x?y#z'), 'http://router.local:8443/x?y#z');
});

test('buildTabState reads the web contents and canonicalises ipfs urls', () => {
  const wc = {
    getURL: () => 'ipfs://QmPZ9gcCEpqKTo6aq61g2nXGUhM4iCL3ewB6LDXZCtioEB/',
    getTitle: () => 'Hello',
    isLoading: () => true,
    isCurrentlyAudible: () => false,
    navigationHistory: { canGoBack: () => true, canGoForward: () => false },
  };
  const s = buildTabState({ id: 't1', wc, favicon: 'https://x/f.ico', error: null });
  assert.equal(s.id, 't1');
  assert.match(s.url, /^ipfs:\/\/bafy/);
  assert.equal(s.title, 'Hello');
  assert.equal(s.favicon, 'https://x/f.ico');
  assert.equal(s.isLoading, true);
  assert.equal(s.canGoBack, true);
  assert.equal(s.canGoForward, false);
  assert.equal(s.error, null);
  assert.equal(s.audible, false);

  const blank = { getURL: () => '', getTitle: () => '', isLoading: () => false, isCurrentlyAudible: () => true };
  const s2 = buildTabState({ id: 't2', wc: blank, favicon: null, error: { code: -1, description: 'Page crashed', url: 'x' }, requestedUrl: 'https://pending/' });
  assert.equal(s2.url, 'https://pending/', 'falls back to the requested url before the first commit');
  assert.equal(s2.canGoBack, false);
  assert.equal(s2.audible, true);
  assert.deepEqual(s2.error, { code: -1, description: 'Page crashed', url: 'x' });
});

test('zoomPercent and pdfFileName', () => {
  assert.equal(zoomPercent(1), 100);
  assert.equal(zoomPercent(1.1), 110);
  assert.equal(zoomPercent(0.333), 33);
  assert.equal(zoomPercent(NaN), 100);
  assert.equal(zoomPercent(0), 100);
  assert.equal(pdfFileName('Report: Q3/Q4 <draft>'), 'Report Q3 Q4 draft.pdf');
  assert.equal(pdfFileName('  '), 'page.pdf');
  assert.equal(pdfFileName(undefined), 'page.pdf');
  assert.equal(pdfFileName('ends with dots...'), 'ends with dots.pdf');
  assert.equal(pdfFileName('x'.repeat(300)).length, 124);
});

test('buildTabState reports mute, zoom and private', () => {
  const wc = {
    getURL: () => 'https://a.b/', getTitle: () => 'A', isLoading: () => false,
    navigationHistory: { canGoBack: () => true, canGoForward: () => false },
    isCurrentlyAudible: () => true, isAudioMuted: () => true, getZoomFactor: () => 1.25,
  };
  const st = buildTabState({ id: 't', wc, favicon: null, error: null, isPrivate: true });
  assert.equal(st.muted, true);
  assert.equal(st.audible, true);
  assert.equal(st.zoom, 125);
  assert.equal(st.private, true);
  assert.equal(buildTabState({ id: 't', wc: { ...wc, isAudioMuted: undefined, getZoomFactor: undefined }, favicon: null, error: null }).zoom, 100);
});

test('buildTabState carries the ipfs:// badge when the handler has one', () => {
  const wc = { getURL: () => 'ipfs://bafyx/', getTitle: () => '', isLoading: () => false };
  const seen = [];
  const badgeFor = (url) => { seen.push(url); return url.startsWith('ipfs://') ? { kind: 'content-addressed', label: 'Content-addressed' } : null; };
  assert.deepEqual(buildTabState({ id: 't', wc, favicon: null, error: null, badgeFor }).badge, { kind: 'content-addressed', label: 'Content-addressed' });
  assert.deepEqual(seen, ['ipfs://bafyx/']);
  const web = { ...wc, getURL: () => 'https://example.com/' };
  assert.equal('badge' in buildTabState({ id: 't', wc: web, favicon: null, error: null, badgeFor }), false);
  assert.equal('badge' in buildTabState({ id: 't', wc, favicon: null, error: null }), false);
});
