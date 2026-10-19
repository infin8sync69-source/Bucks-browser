import { test } from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { register } from 'node:module';

register('./helpers/electron-loader.mjs', import.meta.url);
const { markdownToHtml, inlineMarkdown, htmlDocument, safeFileName, createDocs } = await import('../../../src/main/docs.js');

test('inline Markdown: emphasis, code, safe links, everything else escaped', () => {
  assert.equal(inlineMarkdown('**bold** and *it* and `a<b>`'), '<strong>bold</strong> and <em>it</em> and <code>a&lt;b&gt;</code>');
  assert.equal(inlineMarkdown('[Kubo](https://github.com/ipfs/kubo?a=1&b=2)'), '<a href="https://github.com/ipfs/kubo?a=1&amp;b=2">Kubo</a>');
  assert.equal(inlineMarkdown('[x](javascript:alert(1))'), '[x](javascript:alert(1))', 'only http(s), ipfs, ipns and mailto links');
  assert.equal(inlineMarkdown('<img src=x onerror=alert(1)>'), '&lt;img src=x onerror=alert(1)&gt;');
  assert.equal(inlineMarkdown('snake_case_name stays'), 'snake_case_name stays');
  assert.equal(inlineMarkdown('`**not bold**`'), '<code>**not bold**</code>');
});

test('block Markdown: headings, lists, quotes, fences, tables, rules', () => {
  const html = markdownToHtml([
    '# Title', '', 'First line', 'continues.', '', '- one', '- two', '1. first', '2. second', '',
    '> quoted', '', '```js', 'const a = "<x>";', '```', '', '| A | B |', '|---|:-:|', '| 1 | **2** |', '', '---',
  ].join('\n'));
  assert.equal(html, [
    '<h1>Title</h1>',
    '<p>First line continues.</p>',
    '<ul><li>one</li><li>two</li></ul>',
    '<ol><li>first</li><li>second</li></ol>',
    '<blockquote>quoted</blockquote>',
    '<pre><code>const a = &quot;&lt;x&gt;&quot;;</code></pre>',
    '<table><thead><tr><th>A</th><th>B</th></tr></thead><tbody><tr><td>1</td><td><strong>2</strong></td></tr></tbody></table>',
    '<hr>',
  ].join('\n'));
});

test('htmlDocument has no scripts and adds a title heading when the text has none', () => {
  const doc = htmlDocument('Report <1>', 'Body');
  assert.match(doc, /<title>Report &lt;1&gt;<\/title>/);
  assert.match(doc, /<h1>Report &lt;1&gt;<\/h1>/);
  assert.match(doc, /default-src 'none'/);
  assert.doesNotMatch(doc, /<script/i);
  assert.doesNotMatch(htmlDocument('T', '# Own heading'), /<h1>T<\/h1>/);
});

test('safeFileName', () => {
  assert.equal(safeFileName('Q3 report: draft/final?', 'pdf'), 'Q3 report draft final.pdf');
  assert.equal(safeFileName('../../etc/passwd', 'md'), 'etc passwd.md');
  assert.equal(safeFileName('', 'txt'), 'Document.txt');
  assert.equal(safeFileName('x'.repeat(200), 'md').length, 83);
});

test('createDocs writes unique files in the folder, PDFs through the renderer', async (t) => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'bucks-docs-'));
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  const rendered = [];
  const docs = createDocs({ getDir: () => path.join(dir, 'Bucks'), renderPdf: async (html) => { rendered.push(html); return Buffer.from('%PDF-1.7 fake'); } });

  const a = await docs.create({ title: 'Notes', content: '# Notes\nHello' });
  const b = await docs.create({ title: 'Notes', content: 'Again', format: 'md' });
  assert.equal(path.basename(a.path), 'Notes.md');
  assert.equal(path.basename(b.path), 'Notes (2).md');
  assert.equal(await fsp.readFile(a.path, 'utf8'), '# Notes\nHello\n');

  const pdf = await docs.create({ title: 'Report', content: '- a\n- b', format: 'pdf' });
  assert.equal(path.basename(pdf.path), 'Report.pdf');
  assert.match(rendered[0], /<ul><li>a<\/li><li>b<\/li><\/ul>/);
  assert.equal((await fsp.readFile(pdf.path, 'utf8')).slice(0, 5), '%PDF-');

  const html = await docs.create({ title: 'Page', content: 'Hi', format: 'html' });
  assert.match(await fsp.readFile(html.path, 'utf8'), /<p>Hi<\/p>/);
  assert.equal(docs.wrote(html.path), true);
  assert.equal(docs.wrote('/etc/passwd'), false);

  await assert.rejects(docs.create({ title: 'x', content: '   ' }), /empty/);
  await assert.rejects(docs.create({ title: 'x', content: 'y', format: 'exe' }), /Unknown document format/);
  const saved = await docs.savePdf('Page / one', Buffer.from('%PDF-'));
  assert.equal(path.basename(saved.path), 'Page one.pdf');
});
