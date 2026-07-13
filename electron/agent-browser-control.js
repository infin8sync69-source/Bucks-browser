/* ╔══════════════════════════════════════════════════════════╗
   ║  BUCKS AGENTIC BROWSER — RENDERER-SIDE ACTUATION LAYER      ║
   ║                                                            ║
   ║  Lets the agent loop operate the *live* <webview> the user ║
   ║  sees: read an indexed accessibility snapshot, screenshot, ║
   ║  click / type / scroll / navigate. This is the piece that  ║
   ║  turns Bucks from "reads a copy of the web" into an agent  ║
   ║  that drives the real tab.                                  ║
   ║                                                            ║
   ║  Bound by renderer.js via window.__bucksBrowserControl.bind║
   ║  (getActiveWebview). The Soul Engine proxies browser_*      ║
   ║  tool calls here over SSE; execute(name,args) runs them.    ║
   ╚══════════════════════════════════════════════════════════╝ */
(function () {
  'use strict';

  let getActiveWebview = () => null;

  // Injected into the page to produce a compact, indexed snapshot of the
  // interactive elements. Each element is tagged with data-bucks-ref so a
  // later click/type can locate it deterministically.
  const SNAPSHOT_SCRIPT = `(() => {
    const SEL = 'a[href], button, input:not([type=hidden]), textarea, select, [role=button], [role=link], [role=textbox], [onclick], [contenteditable=true]';
    const out = [];
    let ref = 0;
    const nodes = document.querySelectorAll(SEL);
    for (const el of nodes) {
      const rect = el.getBoundingClientRect();
      const visible = rect.width > 0 && rect.height > 0 &&
        rect.bottom > 0 && rect.right > 0 &&
        rect.top < (window.innerHeight || 0) + 600;
      if (!visible) continue;
      el.setAttribute('data-bucks-ref', String(ref));
      const tag = el.tagName.toLowerCase();
      const role = el.getAttribute('role') || tag;
      let name = (el.getAttribute('aria-label') || el.placeholder || el.value ||
        el.innerText || el.getAttribute('title') || '').trim().replace(/\\s+/g, ' ');
      if (name.length > 80) name = name.slice(0, 80) + '…';
      out.push({ ref, role, tag, type: el.type || '', name });
      ref++;
      if (ref >= 150) break;
    }
    return {
      url: location.href,
      title: document.title,
      scrollY: Math.round(window.scrollY),
      scrollHeight: document.body ? document.body.scrollHeight : 0,
      elements: out,
    };
  })()`;

  function execInWebview(wv, code) {
    return new Promise((resolve, reject) => {
      if (!wv || typeof wv.executeJavaScript !== 'function') {
        return reject(new Error('No active web tab to act on.'));
      }
      try {
        // userGesture=true so clicks/focus behave like real input.
        wv.executeJavaScript(code, true).then(resolve).catch(reject);
      } catch (e) {
        reject(e);
      }
    });
  }

  async function snapshot(wv) {
    const snap = await execInWebview(wv, SNAPSHOT_SCRIPT);
    return snap;
  }

  // Render the snapshot as a compact text block the model can reason over.
  function formatSnapshot(snap) {
    if (!snap) return 'No page loaded.';
    const lines = snap.elements.map(
      (e) => `[${e.ref}] ${e.role}${e.type ? '(' + e.type + ')' : ''}: ${e.name || '(no label)'}`
    );
    return [
      `URL: ${snap.url}`,
      `Title: ${snap.title}`,
      `Scroll: ${snap.scrollY}/${snap.scrollHeight}`,
      `Interactive elements:`,
      ...lines,
    ].join('\n');
  }

  async function clickRef(wv, ref) {
    const code = `(() => {
      const el = document.querySelector('[data-bucks-ref="' + ${JSON.stringify(String(ref))} + '"]');
      if (!el) return { ok: false, error: 'ref not found' };
      el.scrollIntoView({ block: 'center' });
      el.click();
      return { ok: true };
    })()`;
    return execInWebview(wv, code);
  }

  async function typeRef(wv, ref, text) {
    const code = `(() => {
      const el = document.querySelector('[data-bucks-ref="' + ${JSON.stringify(String(ref))} + '"]');
      if (!el) return { ok: false, error: 'ref not found' };
      el.focus();
      const v = ${JSON.stringify(String(text))};
      if ('value' in el) {
        el.value = v;
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      } else {
        el.textContent = v;
      }
      return { ok: true };
    })()`;
    return execInWebview(wv, code);
  }

  async function scroll(wv, direction) {
    const dy = direction === 'up' ? -600 : 600;
    return execInWebview(wv, `(() => { window.scrollBy(0, ${dy}); return { ok: true, scrollY: window.scrollY }; })()`);
  }

  async function screenshot(wv) {
    // WebContentsView shim path (tab-view.js): capture happens in main.
    if (wv && typeof wv.capturePageBase64 === 'function') {
      return wv.capturePageBase64();
    }
    if (!wv || typeof wv.capturePage !== 'function') {
      throw new Error('Screenshot not available for this tab.');
    }
    const img = await wv.capturePage();
    return img.toPNG().toString('base64');
  }

  function navigate(wv, url) {
    if (!wv) throw new Error('No active web tab.');
    let target = String(url || '').trim();
    if (!/^[a-z]+:\/\//i.test(target) && !target.startsWith('bucks://')) {
      target = 'https://' + target;
    }
    wv.src = target;
    return { ok: true, url: target };
  }

  // Dispatcher. Names mirror the browser_control tool schemas in soul_engine.py.
  async function execute(name, args) {
    args = args || {};
    const wv = getActiveWebview();

    switch (name) {
      case 'browser_read_page': {
        const snap = await snapshot(wv);
        return formatSnapshot(snap);
      }
      case 'browser_navigate': {
        const r = navigate(wv, args.url);
        // Give the page a moment, then return a fresh snapshot.
        await new Promise((res) => setTimeout(res, 1200));
        return `Navigated to ${r.url}\n\n` + formatSnapshot(await snapshot(wv).catch(() => null));
      }
      case 'browser_click': {
        const r = await clickRef(wv, args.ref);
        if (!r.ok) return `Click failed: ${r.error}`;
        await new Promise((res) => setTimeout(res, 800));
        return `Clicked [${args.ref}].\n\n` + formatSnapshot(await snapshot(wv).catch(() => null));
      }
      case 'browser_type': {
        const r = await typeRef(wv, args.ref, args.text);
        if (!r.ok) return `Type failed: ${r.error}`;
        return `Typed into [${args.ref}].`;
      }
      case 'browser_scroll': {
        await scroll(wv, args.direction);
        return formatSnapshot(await snapshot(wv).catch(() => null));
      }
      case 'browser_screenshot': {
        const b64 = await screenshot(wv);
        return { text: 'Screenshot of the current tab.', screenshot_b64: b64, media_type: 'image/png' };
      }
      default:
        return `Unknown browser tool: ${name}`;
    }
  }

  window.__bucksBrowserControl = {
    bind(fn) { getActiveWebview = fn; },
    execute,
    snapshot: () => snapshot(getActiveWebview()),
  };
})();
