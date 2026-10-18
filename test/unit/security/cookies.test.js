import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registrableDomain, siteOf, isThirdParty, stripSetCookie } from '../../../src/main/security/cookies.js';

test('registrableDomain: last two labels', () => {
  assert.equal(registrableDomain('example.com'), 'example.com');
  assert.equal(registrableDomain('www.example.com'), 'example.com');
  assert.equal(registrableDomain('a.b.c.example.org'), 'example.org');
  assert.equal(registrableDomain('WWW.Example.COM.'), 'example.com');
});

test('registrableDomain: two-level suffixes use three labels', () => {
  assert.equal(registrableDomain('www.bbc.co.uk'), 'bbc.co.uk');
  assert.equal(registrableDomain('bbc.co.uk'), 'bbc.co.uk');
  assert.equal(registrableDomain('shop.example.com.au'), 'example.com.au');
  assert.equal(registrableDomain('alice.github.io'), 'alice.github.io');
  assert.equal(registrableDomain('docs.alice.github.io'), 'alice.github.io');
});

test('registrableDomain: IPs and single labels are unchanged', () => {
  assert.equal(registrableDomain('localhost'), 'localhost');
  assert.equal(registrableDomain('192.168.1.10'), '192.168.1.10');
  assert.equal(registrableDomain('[::1]'), '[::1]');
  assert.equal(registrableDomain(''), '');
});

test('siteOf handles web, ipfs and garbage', () => {
  assert.equal(siteOf('https://cdn.example.com/a.js'), 'example.com');
  assert.equal(siteOf('ipfs://bafyabc/index.html'), 'ipfs://bafyabc');
  assert.equal(siteOf('not a url'), '');
});

test('isThirdParty', () => {
  assert.equal(isThirdParty('https://cdn.example.com/x', 'https://www.example.com/'), false);
  assert.equal(isThirdParty('https://tracker.net/p', 'https://www.example.com/'), true);
  assert.equal(isThirdParty('https://a.co.uk/x', 'https://b.co.uk/'), true);
  assert.equal(isThirdParty('https://tracker.net/p', 'ipfs://bafyabc/'), true);
  assert.equal(isThirdParty('https://tracker.net/p', ''), false, 'unknown first party is not third party');
});

test('stripSetCookie removes only cookie headers, case-insensitively, without mutating input', () => {
  const input = { 'Set-Cookie': ['a=1', 'b=2'], 'content-type': ['text/html'], 'SET-COOKIE': 'c=3' };
  const { headers, removed } = stripSetCookie(input);
  assert.equal(removed, 3);
  assert.deepEqual(headers, { 'content-type': ['text/html'] });
  assert.ok('Set-Cookie' in input);
  assert.deepEqual(stripSetCookie(undefined), { headers: {}, removed: 0 });
});
