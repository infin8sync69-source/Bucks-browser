// End-to-end checks of the agent chat ported from Bucks Core: threads (kept across a restart of
// the panel), conversation history sent with each question, file attachments, slash commands,
// Stop, and saving an answer as a document and as a PDF. The agent is a stand-in "remote agent"
// server that records what it receives, so no model is needed. IPFS is off.
//
//   npm run build:ui && xvfb-run -a node --test test/e2e/agent-chat.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const ARTIFACTS = process.env.BUCKS_E2E_ARTIFACTS || path.join(os.tmpdir(), 'bucks-e2e');

async function waitFor(fn, { timeout = 15_000, interval = 150, label }) {
  const start = Date.now();
  let last;
  while (Date.now() - start < timeout) {
    last = await fn();
    if (last) return last;
    await new Promise((r) => setTimeout(r, interval));
  }
  throw new Error(`Timed out waiting for ${label}: last=${JSON.stringify(last)}`);
}

/** A Bucks "remote agent" that answers every task and remembers what it was sent. */
function agentServer() {
  const tasks = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const task = body ? JSON.parse(body) : {};
      if (task.prompt !== '__ping__') tasks.push(task);
      const reply = (evaluation) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ status: 'ok', evaluation, task_id: `t${tasks.length}` })); };
      if (/take your time/.test(task.prompt || '')) { setTimeout(() => reply('Too late.'), 20_000); return; }
      reply(`Answer ${tasks.length}: **${String(task.prompt).split('\n')[0].slice(0, 60)}**`);
    });
  });
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r({ server, tasks, url: `http://127.0.0.1:${server.address().port}` })));
}

test('agent chat: threads, history, attachments, slash commands, stop, save as document and PDF', { timeout: 180_000 }, async () => {
  assert.ok(fs.existsSync(path.join(root, 'ui', 'build', 'index.html')), 'ui/build missing — run npm run build:ui first');
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'bucks-e2e-chat-'));
  const documents = path.join(userData, 'Documents');
  fs.mkdirSync(ARTIFACTS, { recursive: true });
  const agent = await agentServer();
  fs.writeFileSync(path.join(userData, 'settings.json'), JSON.stringify({ ipfs: { autoStart: false }, agent: { provider: 'remote', remoteUrl: agent.url } }));
  const notes = path.join(userData, 'notes.txt');
  fs.writeFileSync(notes, 'The launch is on Friday at 10:00.\n');

  const app = await electron.launch({ cwd: root, args: ['.', '--no-sandbox', `--user-data-dir=${userData}`], env: { ...process.env, BUCKS_USER_DATA: userData } });
  await app.evaluate(({ app: a }, dir) => a.setPath('documents', dir), documents);
  let page;
  const threads = () => page.evaluate(() => JSON.parse(localStorage.getItem('bucks_chat_threads_v1') || '[]'));
  try {
    page = await app.firstWindow();
    await page.waitForFunction(() => typeof window.bucks?.agent?.cancel === 'function', null, { timeout: 30_000 });

    // ── a first question from the command bar opens the chat ──
    const bar = page.getByLabel('Ask the agent');
    await bar.fill('What is IPFS?');
    await bar.press('Enter');
    const panel = page.getByRole('complementary', { name: 'Agent chat' });
    await panel.getByText('Answer 1: What is IPFS?').waitFor();

    // ── a follow-up carries the conversation and an attached file ──
    const box = panel.getByRole('textbox', { name: 'Message' });
    await panel.locator('input[type=file]').setInputFiles(notes);
    await panel.getByText('notes.txt').waitFor();
    await box.fill('When is the launch?');
    await box.press('Enter');
    await panel.getByText('Answer 2: When is the launch?').waitFor();
    const second = agent.tasks[1];
    assert.deepEqual(second.history, [{ role: 'user', content: 'What is IPFS?' }, { role: 'assistant', content: 'Answer 1: **What is IPFS?**' }]);
    assert.match(second.prompt, /^When is the launch\?\n\nThe user attached the following\./);
    assert.match(second.prompt, /BEGIN ATTACHMENT: notes\.txt -----\nThe launch is on Friday at 10:00\./);

    // ── slash commands: suggestions, a usage hint, a page, and a translated request ──
    await box.fill('/sea');
    await panel.getByRole('option', { name: /\/search/ }).waitFor();
    await box.press('Tab');
    assert.equal(await box.inputValue(), '/search ');
    await box.fill('/research');
    await box.press('Enter'); // picks nothing new: the command is complete, so it is sent
    await panel.getByText(/^Usage: \/research <topic>/).waitFor();
    await box.fill('/search pinning services');
    await box.press('Enter');
    await panel.getByText('Answer 3: Search the web for: pinning services').waitFor();
    await box.fill('/agent book a table');
    await box.press('Enter');
    await panel.getByText(/Acting in a tab needs the Soul Engine/).waitFor();
    assert.equal(agent.tasks.length, 3, '/agent was not sent to a provider that cannot act');
    await box.fill('/bookmarks');
    await box.press('Enter');
    await waitFor(async () => (await page.evaluate(() => JSON.parse(localStorage.getItem('bucks_browser_v2') || '{}').tabs || [])).some((t) => t.url === 'bucks://bookmarks'), { label: '/bookmarks opened its page' });

    // ── stop a slow answer ──
    await box.fill('take your time');
    await box.press('Enter');
    await panel.getByRole('button', { name: 'Stop' }).click();
    await panel.getByText('Stopped.', { exact: true }).waitFor({ timeout: 5000 });

    // ── save an answer as a document and as a PDF ──
    const answer = panel.getByText('Answer 2: When is the launch?');
    await answer.hover();
    await panel.getByRole('button', { name: 'Save answer as document' }).nth(1).click();
    await panel.getByText('Saved When is the launch.md').waitFor();
    await answer.hover();
    await panel.getByRole('button', { name: 'Save answer as PDF' }).nth(1).click();
    await panel.getByText('Saved When is the launch.pdf').waitFor({ timeout: 20_000 });
    assert.equal(fs.readFileSync(path.join(documents, 'Bucks', 'When is the launch.md'), 'utf8'), 'Answer 2: **When is the launch?**\n');
    assert.equal(fs.readFileSync(path.join(documents, 'Bucks', 'When is the launch.pdf')).subarray(0, 5).toString(), '%PDF-');
    await page.screenshot({ path: path.join(ARTIFACTS, 'agent-chat.png') });

    // ── threads: a new chat starts empty; the old one is kept and can be reopened ──
    await panel.getByRole('button', { name: 'New chat' }).click();
    await panel.getByText('How can I help?').waitFor();
    await box.fill('Second conversation');
    await box.press('Enter');
    await panel.getByText('Answer 5: Second conversation').waitFor();
    assert.deepEqual(agent.tasks.at(-1).history, [], 'a new thread starts without history');
    const saved = await threads();
    assert.deepEqual(saved.map((t) => t.title), ['Second conversation', 'What is IPFS?']);
    assert.equal(saved[1].messages.find((m) => m.attachments)?.attachments[0], 'notes.txt');

    await panel.getByRole('button', { name: 'Chats' }).click();
    await panel.getByRole('button', { name: /^What is IPFS\?/ }).click();
    await panel.getByText('Answer 2: When is the launch?').waitFor();
    await page.screenshot({ path: path.join(ARTIFACTS, 'agent-threads.png') });
    await panel.getByRole('button', { name: 'Chats' }).click();
    await panel.getByRole('button', { name: 'Delete Second conversation' }).click();
    await waitFor(async () => (await threads()).length === 1, { label: 'thread deleted' });
  } finally {
    await app.close();
    agent.server.close();
  }
});
