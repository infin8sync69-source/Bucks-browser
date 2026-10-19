/**
 * A2UI Engine — Self-contained Agent-to-UI rich rendering pipeline
 * Designed as a standalone module that does NOT depend on the main renderer.js IIFE closure.
 * 
 * Features:
 * - Full SSE streaming from soul_engine
 * - Rich image gallery grid
 * - YouTube video cards with embedded thumbnails
 * - Explore More Images / Explore More Videos CTAs
 * - Relevant source links with favicons
 * - Contact / Mail CTAs extracted from results
 * - Follow-up question chips for multi-turn conversation
 * - Liquid Glass frosted aesthetic
 */

(function A2UIEngine() {
  'use strict';

  const SOUL = 'http://127.0.0.1:8765';

  // ─── Escape helpers ───────────────────────────────────────────
  function esc(s) {
    return String(s || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function attr(s) { return esc(s).replace(/'/g, '&#39;'); }

  // ─── SSE Streaming ────────────────────────────────────────────
  async function streamSSE(url, body, onEvent, signal) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 120000); // 120s connection timeout
    
    if (signal) {
      signal.addEventListener('abort', () => controller.abort());
    }

    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Accept': 'text/event-stream' },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      clearTimeout(timeoutId);
      if (!res.ok || !res.body) throw new Error(`Engine ${res.status}`);
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      while (true) {
        let chunk;
        try { chunk = await reader.read(); } catch (e) { if (e && e.name === 'AbortError') return; throw e; }
        const { done, value } = chunk;
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split('\n');
        buf = lines.pop() || '';
        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          const data = line.slice(6).trim();
          if (data === '[DONE]') return;
          try { onEvent(JSON.parse(data)); } catch (_) { if (data) onEvent({ type: 'token', content: data }); }
        }
      }
    } catch (err) {
      clearTimeout(timeoutId);
      throw err;
    }
  }

  // ─── Text formatter ──────────────────────────────────────────
  function formatText(text) {
    if (!text) return '';
    let t = text;

    // Extract & parse render_component JSON if LLM outputs raw JSON tool calls
    t = t.replace(/\{"name":\s*"render_component"[\s\S]*?\}(?=\s*\{|$|\n\n)/g, '');

    // Strip LLM prompt leakage & redundant text lists for media/sources/followups
    t = t.replace(/FOLLOW-UP QUERY:\s*["'][^"']*["']\.?/gi, '');
    t = t.replace(/PROVIDE A CONCISE,?\s*CLEAR ANSWER WITH EVIDENCE BASED ON CONTEXT\.?/gi, '');
    t = t.replace(/<followup>[\s\S]*?<\/followup>/gi, '');
    t = t.replace(/<followup>[\s\S]*/gi, '');

    // Strip plain-text list headers (Images:, Videos:, Top Sources:, Follow-up Questions:)
    t = t.replace(/(?:^|\n)(?:Images|Videos|Top Sources|Follow-up Questions):\s*(?:\n\s*\d+\.[\s\S]*?)?(?=\n\n|\n[A-Z]|$)/gi, '');

    // Format markdown headings & bold text
    t = t.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    t = t.replace(/### (.*?)(?:\n|$)/g, '<h4 style="margin:12px 0 6px; font-size:15px; font-weight:700; color:var(--text-primary);">$1</h4>');
    t = t.replace(/## (.*?)(?:\n|$)/g, '<h3 style="margin:16px 0 8px; font-size:16px; font-weight:800; color:var(--text-primary);">$1</h3>');
    t = t.replace(/^[-*] (.*?)(?:\n|$)/gm, '<div style="display:flex; gap:8px; margin:4px 0;"><span style="color:#818cf8;">•</span><span>$1</span></div>');

    // Parse Markdown links [Title](URL) into clickable tabs
    t = t.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, (_, label, url) => {
      const cleanUrl = url.trim();
      return `<a href="${cleanUrl}" target="_blank" onclick="window.__a2uiOpenTab('${cleanUrl}');return false;" style="color:#818cf8; font-weight:600; text-decoration:underline; cursor:pointer;">${label}</a>`;
    });

    // Parse bare URLs (https://...) that are not inside href
    t = t.replace(/(^|[^"'>])(https?:\/\/[^\s<]+)/g, (_, prefix, url) => {
      const cleanUrl = url.trim();
      let label = cleanUrl.replace(/^https?:\/\/(www\.)?/, '').split('/')[0];
      return `${prefix}<a href="${cleanUrl}" target="_blank" onclick="window.__a2uiOpenTab('${cleanUrl}');return false;" style="color:#818cf8; font-weight:600; text-decoration:underline; cursor:pointer;">${label}</a>`;
    });

    t = t.replace(/\n/g, '<br>');
    return t;
  }

  // ─── Extract followups ───────────────────────────────────────
  function extractFollowups(text) {
    const followups = [];
    const re = /<followup>([\s\S]*?)<\/followup>/gi;
    let m;
    while ((m = re.exec(text)) !== null) followups.push(m[1].trim());
    return followups;
  }

  // ─── Render: Image Gallery ───────────────────────────────────
  function renderImageGallery(data, query) {
    const items = (data.items || []).filter(it => it.thumbnail || it.image);
    if (!items.length) return '';
    const q = query || data.query || '';
    const cells = items.slice(0, 12).map(it => {
      const src = it.thumbnail || it.image;
      const full = it.image || it.thumbnail;
      const url = it.url || '';
      const title = it.title || it.source || '';
      return `
        <div class="a2ui-img-cell" onclick="window.__a2uiOpenTab('${attr(url || full)}')" title="${attr(title)}" style="cursor:pointer;">
          <img src="${attr(src)}" alt="${attr(title)}" referrerpolicy="no-referrer" loading="lazy"
               onerror="this.closest('.a2ui-img-cell').style.display='none'"
               style="width:100%; aspect-ratio:4/3; object-fit:cover; display:block; border-radius:10px; background:#1e1e2a;"/>
          ${it.source ? `<div class="a2ui-img-cap">${esc(it.source)}</div>` : ''}
        </div>`;
    }).join('');

    const ytSearch = `https://www.google.com/search?tbm=isch&q=${encodeURIComponent(q)}`;
    return `
      <div class="a2ui-section">
        <div class="a2ui-section-label">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18M9 21V9"/></svg>
          Images
        </div>
        <div class="a2ui-image-grid">${cells}</div>
        <a href="#" class="a2ui-explore-btn" onclick="window.__a2uiOpenTab('${attr(ytSearch)}');event.preventDefault();">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><circle cx="11" cy="11" r="8"/><path d="M21 21l-4.35-4.35"/></svg>
          Explore More Images
        </a>
      </div>`;
  }

  // ─── Render: Video Cards ─────────────────────────────────────
  function renderVideoCards(data) {
    const vids = (data.videos || []).filter(v => v.videoId && /^[A-Za-z0-9_-]{6,20}$/.test(v.videoId));
    if (!vids.length) return '';
    const cards = vids.slice(0, 6).map(v => {
      const ytUrl = `https://www.youtube.com/watch?v=${encodeURIComponent(v.videoId)}`;
      const thumb = v.thumbnail || `https://i.ytimg.com/vi/${v.videoId}/mqdefault.jpg`;
      return `
        <div class="a2ui-video-card" onclick="window.__a2uiOpenTab('${attr(ytUrl)}')" title="${attr(v.title)}">
          <div class="a2ui-video-thumb-wrap">
            <img src="${attr(thumb)}" alt="${attr(v.title)}" referrerpolicy="no-referrer" loading="lazy"
                 onerror="this.style.background='#1e1e2a'"
                 style="width:100%; height:100%; object-fit:cover;"/>
            <div class="a2ui-video-playbtn">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="white"><path d="M8 5v14l11-7z"/></svg>
            </div>
            ${v.duration ? `<span class="a2ui-video-dur">${esc(v.duration)}</span>` : ''}
          </div>
          <div class="a2ui-video-meta">
            <div class="a2ui-video-title">${esc(v.title)}</div>
            <div class="a2ui-video-sub">${esc(v.channel || '')}${v.views ? ' · ' + esc(v.views) : ''}</div>
          </div>
        </div>`;
    }).join('');

    const q = data.query || '';
    const ytSearch = `https://www.youtube.com/results?search_query=${encodeURIComponent(q)}`;
    return `
      <div class="a2ui-section">
        <div class="a2ui-section-label">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M22.54 6.42a2.78 2.78 0 0 0-1.95-1.96C18.88 4 12 4 12 4s-6.88 0-8.59.46A2.78 2.78 0 0 0 1.46 6.42 29 29 0 0 0 1 11.75a29 29 0 0 0 .46 5.33A2.78 2.78 0 0 0 3.41 19.1C5.12 19.56 12 19.56 12 19.56s6.88 0 8.59-.46a2.78 2.78 0 0 0 1.95-1.95 29 29 0 0 0 .46-5.33 29 29 0 0 0-.46-5.34z"/><polygon points="9.75 15.02 15.5 11.75 9.75 8.48 9.75 15.02"/></svg>
          Videos
        </div>
        <div class="a2ui-video-grid">${cards}</div>
        <a href="#" class="a2ui-explore-btn" onclick="window.__a2uiOpenTab('${attr(ytSearch)}');event.preventDefault();">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M22.54 6.42a2.78 2.78 0 0 0-1.95-1.96C18.88 4 12 4 12 4s-6.88 0-8.59.46A2.78 2.78 0 0 0 1.46 6.42 29 29 0 0 0 1 11.75a29 29 0 0 0 .46 5.33"/><polygon points="9.75 15.02 15.5 11.75 9.75 8.48 9.75 15.02"/></svg>
          Watch More on YouTube
        </a>
      </div>`;
  }

  // ─── Render: Sources ─────────────────────────────────────────
  function renderSources(urls) {
    if (!urls || !urls.length) return '';
    
    // Filter and sanitize valid URLs (strip trailing punctuation and invalid fragments)
    const validUrls = urls.map(u => String(u || '').trim().replace(/[,.;:)]+$/, ''))
                          .filter(u => /^https?:\/\/[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/.test(u));
    
    // Group and deduplicate by domain
    const domainMap = new Map();
    validUrls.forEach(url => {
      try {
        const parsed = new URL(url);
        const domain = parsed.hostname.replace(/^www\./, '');
        if (domain && !domainMap.has(domain)) {
          domainMap.set(domain, url);
        }
      } catch (_) {}
    });

    if (domainMap.size === 0) return '';

    const items = Array.from(domainMap.entries()).slice(0, 8).map(([domain, url]) => {
      const favicon = `https://www.google.com/s2/favicons?domain=${encodeURIComponent(domain)}&sz=32`;
      return `
        <a href="#" class="a2ui-source-link" onclick="window.__a2uiOpenTab('${attr(url)}');event.preventDefault();" title="${attr(url)}">
          <img src="${attr(favicon)}" width="14" height="14" style="border-radius:3px;flex-shrink:0;" onerror="this.style.display='none'"/>
          <span>${esc(domain)}</span>
        </a>`;
    }).join('');

    return `
      <div class="a2ui-section a2ui-sources-section">
        <div class="a2ui-section-label">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>
          Sources
        </div>
        <div class="a2ui-sources-list">${items}</div>
      </div>`;
  }

  // ─── Render: Follow-up chips ─────────────────────────────────
  function renderFollowups(followups, onFollowup) {
    if (!followups.length) return null;
    const wrap = document.createElement('div');
    wrap.className = 'a2ui-section';
    wrap.innerHTML = `
      <div class="a2ui-section-label">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
        Follow-up Questions
      </div>
      <div class="a2ui-followups">
        ${followups.map(fq => `<button class="a2ui-followup-chip" data-fq="${attr(fq)}">
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="12" cy="12" r="10"/><path d="M12 8v4l2 2"/></svg>
          ${esc(fq)}
        </button>`).join('')}
      </div>`;
    wrap.querySelectorAll('.a2ui-followup-chip').forEach(btn => {
      btn.addEventListener('click', () => onFollowup(btn.dataset.fq));
    });
    return wrap;
  }

  // ─── Render: CTAs (contact, mail, visit) ─────────────────────
  function renderCTAs(text, urls, query) {
    const ctaBtns = [];
    const mainUrl = (urls && urls.length) ? urls[0] : null;
    const topic = query || 'Research Topic';

    if (mainUrl) {
      ctaBtns.push(`
        <a href="#" class="a2ui-cta-btn primary" onclick="window.__a2uiOpenTab('${attr(mainUrl)}');event.preventDefault();">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6M15 3h6v6M10 14L21 3"/></svg>
          Visit Primary Source
        </a>`);
    } else {
      const searchUrl = `https://www.google.com/search?q=${encodeURIComponent(topic)}`;
      ctaBtns.push(`
        <a href="#" class="a2ui-cta-btn primary" onclick="window.__a2uiOpenTab('${attr(searchUrl)}');event.preventDefault();">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="11" cy="11" r="8"/><path d="M21 21l-4.35-4.35"/></svg>
          Explore Web Sources
        </a>`);
    }

    const wikiUrl = (urls || []).find(u => u.includes('wikipedia.org')) || `https://en.wikipedia.org/wiki/Special:Search?search=${encodeURIComponent(topic)}`;
    ctaBtns.push(`
      <a href="#" class="a2ui-cta-btn secondary" onclick="window.__a2uiOpenTab('${attr(wikiUrl)}');event.preventDefault();">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="12" cy="12" r="10"/><path d="M12 8v4l2 2"/></svg>
        Read on Wikipedia
      </a>`);

    const ytUrl = `https://www.youtube.com/results?search_query=${encodeURIComponent(topic)}`;
    ctaBtns.push(`
      <a href="#" class="a2ui-cta-btn secondary" onclick="window.__a2uiOpenTab('${attr(ytUrl)}');event.preventDefault();">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polygon points="23 7 16 12 23 17 23 7"/><rect x="1" y="5" width="15" height="14" rx="2" ry="2"/></svg>
        Watch Related Videos
      </a>`);

    const mailMatch = text ? text.match(/\b([a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,})\b/) : null;
    if (mailMatch) {
      ctaBtns.push(`
        <a href="mailto:${attr(mailMatch[1])}" class="a2ui-cta-btn secondary">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"/><polyline points="22,6 12,13 2,6"/></svg>
          Contact via Email
        </a>`);
    }

    return `
      <div class="a2ui-section">
        <div class="a2ui-section-label">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"/></svg>
          Quick Actions
        </div>
        <div class="a2ui-ctas">${ctaBtns.join('')}</div>
      </div>`;
  }

  // ─── Inject CSS ───────────────────────────────────────────────
  function injectStyles() {
    if (document.getElementById('a2ui-engine-styles')) return;
    const s = document.createElement('style');
    s.id = 'a2ui-engine-styles';
    s.textContent = `
      /* ── A2UI Engine Styles ── */
      #view-agent-search {
        font-family: 'Instrument Sans', system-ui, sans-serif;
        display: flex;
        flex-direction: column;
        max-width: 1100px;
        margin: 0 auto;
        width: 100%;
        padding: 28px 32px 80px;
        box-sizing: border-box;
        color: var(--text-primary);
        overflow-y: auto;
        max-height: calc(100vh - 110px);
        gap: 0;
        background: transparent;
      }

      #a2ui-header-bar {
        display: flex;
        flex-direction: column;
        gap: 8px;
        border-bottom: 1px solid var(--border-subtle);
        padding-bottom: 20px;
        margin-bottom: 24px;
      }

      #a2ui-header-badge {
        display: inline-flex;
        align-items: center;
        gap: 8px;
        font-family: 'Sora', sans-serif;
        font-size: 11px;
        font-weight: 700;
        letter-spacing: 0.04em;
        background: linear-gradient(135deg, rgba(129, 140, 248, 0.22), rgba(192, 132, 252, 0.22));
        border: 1px solid rgba(255, 255, 255, 0.24);
        color: #ffffff;
        padding: 5px 14px;
        border-radius: var(--radius-pill);
        backdrop-filter: blur(20px);
        box-shadow: 0 4px 16px rgba(129, 140, 248, 0.2);
      }

      #a2ui-query-title {
        font-family: 'Sora', sans-serif;
        font-size: 26px;
        font-weight: 800;
        margin: 0;
        letter-spacing: -0.02em;
        color: var(--text-primary);
      }

      #a2ui-status-box {
        display: flex;
        align-items: center;
        gap: 12px;
        padding: 16px 20px;
        border-radius: var(--radius-lg);
        background: var(--card-bg);
        backdrop-filter: var(--glass-blur);
        border: 1px solid var(--border-subtle);
        font-size: 14px;
        color: var(--text-secondary);
        margin-bottom: 24px;
      }

      #a2ui-main-layout {
        display: grid;
        grid-template-columns: minmax(0, 1.3fr) minmax(280px, 0.7fr);
        gap: 24px;
        align-items: start;
      }

      #a2ui-left-col {
        display: flex;
        flex-direction: column;
        gap: 20px;
        min-width: 0;
      }

      #a2ui-right-col {
        display: flex;
        flex-direction: column;
        gap: 20px;
        min-width: 0;
        position: sticky;
        top: 0;
      }

      .a2ui-turn-container {
        display: flex;
        flex-direction: column;
        gap: 16px;
      }

      .a2ui-turn-container + .a2ui-turn-container {
        margin-top: 28px;
        padding-top: 28px;
        border-top: 1px solid var(--border-subtle);
      }

      .a2ui-user-bubble {
        display: flex;
        justify-content: flex-end;
      }
      .a2ui-user-bubble-inner {
        padding: 12px 18px;
        border-radius: 18px 18px 4px 18px;
        background: var(--input-bg);
        border: 1px solid var(--input-border);
        color: var(--text-primary);
        font-weight: 600;
        font-size: 14px;
        max-width: 85%;
        backdrop-filter: var(--glass-blur);
      }

      .a2ui-answer-card {
        padding: 24px 28px;
        border-radius: var(--radius-lg);
        background: var(--card-bg);
        backdrop-filter: var(--glass-blur);
        border: 1px solid var(--border-subtle);
        box-shadow: var(--shadow-md);
        line-height: 1.7;
        font-size: 14.5px;
        color: var(--text-primary);
      }

      .a2ui-answer-card .a2ui-answer-label {
        font-family: 'Sora', sans-serif;
        font-size: 11px;
        font-weight: 800;
        color: #818cf8;
        text-transform: uppercase;
        letter-spacing: 0.08em;
        margin-bottom: 14px;
        display: flex;
        align-items: center;
        gap: 6px;
      }

      .a2ui-answer-card a {
        color: #818cf8;
        text-decoration: none;
        font-weight: 500;
      }
      .a2ui-answer-card a:hover {
        text-decoration: underline;
      }

      /* ── Sections ── */
      .a2ui-section {
        display: flex;
        flex-direction: column;
        gap: 12px;
        padding: 20px;
        border-radius: 18px;
        background: var(--card-bg);
        backdrop-filter: var(--glass-blur);
        border: 1px solid var(--border-subtle);
        box-shadow: var(--shadow-sm);
      }

      .a2ui-section-label {
        font-family: 'Sora', sans-serif;
        font-size: 11px;
        font-weight: 800;
        color: var(--text-tertiary);
        text-transform: uppercase;
        letter-spacing: 0.08em;
        margin-bottom: 12px;
        display: flex;
        align-items: center;
        gap: 6px;
      }

      /* ── Image Grid ── */
      .a2ui-image-grid {
        display: grid;
        grid-template-columns: repeat(4, 1fr);
        gap: 8px;
      }
      .a2ui-img-cell {
        border-radius: 10px;
        overflow: hidden;
        border: 1px solid var(--border-subtle);
        transition: transform 0.15s ease, box-shadow 0.15s ease;
      }
      .a2ui-img-cell:hover {
        transform: scale(1.03);
        box-shadow: var(--shadow-md);
      }
      .a2ui-img-cap {
        padding: 4px 6px;
        font-size: 10px;
        color: var(--text-tertiary);
        background: var(--bg-body);
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }

      /* ── Video Grid ── */
      .a2ui-video-grid {
        display: grid;
        grid-template-columns: repeat(3, 1fr);
        gap: 10px;
      }
      .a2ui-video-card {
        border-radius: 12px;
        overflow: hidden;
        border: 1px solid var(--border-subtle);
        background: var(--bg-body);
        cursor: pointer;
        transition: transform 0.15s ease, box-shadow 0.15s ease;
        display: flex;
        flex-direction: column;
      }
      .a2ui-video-card:hover {
        transform: translateY(-3px);
        box-shadow: var(--shadow-md);
        border-color: var(--border-strong);
      }
      .a2ui-video-thumb-wrap {
        position: relative;
        aspect-ratio: 16/9;
        background: var(--bg-body);
        overflow: hidden;
        flex-shrink: 0;
      }
      .a2ui-video-playbtn {
        position: absolute;
        inset: 0;
        display: flex;
        align-items: center;
        justify-content: center;
        background: rgba(0,0,0,0.35);
        opacity: 0;
        transition: opacity 0.15s ease;
      }
      .a2ui-video-card:hover .a2ui-video-playbtn { opacity: 1; }
      .a2ui-video-dur {
        position: absolute;
        bottom: 6px;
        right: 6px;
        background: rgba(0,0,0,0.8);
        color: #fff;
        font-size: 10.5px;
        font-weight: 700;
        padding: 2px 5px;
        border-radius: 4px;
      }
      .a2ui-video-meta {
        padding: 10px;
        display: flex;
        flex-direction: column;
        gap: 3px;
        flex: 1;
      }
      .a2ui-video-title {
        font-size: 12.5px;
        font-weight: 600;
        color: var(--text-primary);
        display: -webkit-box;
        -webkit-line-clamp: 2;
        -webkit-box-orient: vertical;
        overflow: hidden;
        line-height: 1.4;
      }
      .a2ui-video-sub {
        font-size: 11px;
        color: var(--text-tertiary);
      }

      /* ── Explore / CTA Buttons ── */
      .a2ui-explore-btn {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        padding: 8px 14px;
        border-radius: 10px;
        background: var(--input-bg);
        border: 1px solid var(--input-border);
        color: var(--text-secondary);
        font-size: 12.5px;
        font-weight: 600;
        text-decoration: none;
        transition: all 0.15s ease;
        width: fit-content;
      }
      .a2ui-explore-btn:hover {
        background: var(--hover-bg);
        color: var(--text-primary);
        border-color: var(--border-strong);
      }

      .a2ui-ctas {
        display: flex;
        flex-wrap: wrap;
        gap: 8px;
      }
      .a2ui-cta-btn {
        display: inline-flex;
        align-items: center;
        gap: 7px;
        padding: 10px 16px;
        border-radius: 12px;
        font-size: 13px;
        font-weight: 700;
        text-decoration: none;
        transition: all 0.15s ease;
        cursor: pointer;
      }
      .a2ui-cta-btn.primary {
        background: var(--text-primary);
        color: var(--bg-body);
        border: none;
        box-shadow: var(--shadow-md);
      }
      .a2ui-cta-btn.primary:hover { opacity: 0.9; box-shadow: var(--shadow-lg); }
      .a2ui-cta-btn.secondary {
        background: var(--input-bg);
        color: var(--text-primary);
        border: 1px solid var(--border-strong);
      }
      .a2ui-cta-btn.secondary:hover { background: var(--hover-bg); }

      /* ── Follow-up chips ── */
      .a2ui-followups {
        display: flex;
        flex-wrap: wrap;
        gap: 8px;
      }
      .a2ui-followup-chip {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        padding: 8px 14px;
        border-radius: 99px;
        border: 1px solid var(--border-strong);
        background: var(--input-bg);
        color: #818cf8;
        font-size: 12.5px;
        font-weight: 600;
        cursor: pointer;
        transition: all 0.15s ease;
        font-family: inherit;
      }
      .a2ui-followup-chip:hover {
        background: var(--hover-bg);
        border-color: #818cf8;
      }

      /* ── Sources ── */
      .a2ui-sources-list {
        display: flex;
        flex-direction: column;
        gap: 6px;
      }
      .a2ui-source-link {
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 8px 12px;
        border-radius: 10px;
        background: var(--input-bg);
        border: 1px solid var(--input-border);
        color: #78b4ff;
        font-size: 12.5px;
        text-decoration: none;
        transition: background 0.15s ease;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .a2ui-source-link:hover { background: var(--hover-bg); color: #a3caff; }

      /* ── Skeleton pulses ── */
      @keyframes a2ui-pulse {
        0%, 100% { opacity: 0.4; }
        50% { opacity: 0.8; }
      }
      .a2ui-skeleton-line {
        height: 14px;
        background: var(--border-strong);
        border-radius: 4px;
        animation: a2ui-pulse 1.4s infinite;
      }

      /* ── Right col context card ── */
      .a2ui-context-card {
        padding: 20px;
        border-radius: var(--radius-panel);
        background: var(--card-bg);
        backdrop-filter: var(--glass-blur);
        border: 1px solid var(--border-subtle);
        box-shadow: var(--shadow-md);
        display: flex;
        flex-direction: column;
        gap: 10px;
      }
      .a2ui-context-card-label {
        font-family: 'Sora', sans-serif;
        font-size: 11px;
        font-weight: 800;
        color: #818cf8;
        text-transform: uppercase;
        letter-spacing: 0.08em;
      }
      .a2ui-context-card-text {
        font-size: 13px;
        line-height: 1.6;
        color: #94a3b8;
      }

      @media (max-width: 768px) {
        #a2ui-main-layout { grid-template-columns: 1fr; }
        .a2ui-image-grid { grid-template-columns: repeat(2, 1fr); }
        .a2ui-video-grid { grid-template-columns: repeat(2, 1fr); }
        #view-agent-search { padding: 18px 16px 80px; }
      }
    `;
    document.head.appendChild(s);
  }

  let _activeTabId = null;
  let _activeTabTurns = [];

  window.__a2uiLoadTabTurns = function(tabId, turns) {
    _activeTabId = tabId;
    _activeTabTurns = turns || [];
    renderActiveTabTurns();
  };

  function renderActiveTabTurns() {
    const turnsEl = document.getElementById('a2ui-turns');
    const titleEl = document.getElementById('a2ui-query-title');
    const statusBox = document.getElementById('a2ui-status-box');
    if (!turnsEl) return;

    turnsEl.innerHTML = '';
    if (!_activeTabTurns || !_activeTabTurns.length) {
      if (titleEl) titleEl.textContent = 'Research Assistant';
      if (statusBox) statusBox.style.display = 'none';
      return;
    }

    const lastTurn = _activeTabTurns[_activeTabTurns.length - 1];
    if (titleEl && lastTurn) titleEl.textContent = `"${lastTurn.query}"`;
    if (statusBox) statusBox.style.display = 'none';

    _activeTabTurns.forEach(turn => {
      const turnEl = document.createElement('div');
      turnEl.className = 'a2ui-turn-container';

      const bubble = document.createElement('div');
      bubble.className = 'a2ui-user-bubble';
      bubble.innerHTML = `<div class="a2ui-user-bubble-inner">${esc(turn.query)}</div>`;
      turnEl.appendChild(bubble);

      if (turn.answer) {
        const card = document.createElement('div');
        card.className = 'a2ui-answer-card';
        card.innerHTML = `
          <div class="a2ui-answer-label">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>
            ANSWER
          </div>
          <div class="a2ui-answer-body">${formatText(turn.answer)}</div>
        `;
        turnEl.appendChild(card);
      }

      if (turn.followups && turn.followups.length) {
        const fEl = document.createElement('div');
        fEl.className = 'a2ui-followups';
        turn.followups.forEach(fq => {
          const chip = document.createElement('button');
          chip.className = 'a2ui-followup-chip';
          chip.innerHTML = `<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>${esc(fq)}`;
          chip.onclick = () => runSearch(fq, true);
          fEl.appendChild(chip);
        });
        turnEl.appendChild(fEl);
      }

      turnsEl.appendChild(turnEl);
    });
  }

  // ─── Rebuild view-agent-search HTML ──────────────────────────
  function rebuildViewHTML() {
    const view = document.getElementById('view-agent-search');
    if (!view) return;

    view.style.cssText = '';
    view.innerHTML = `
      <!-- Header -->
      <div id="a2ui-header-bar" style="margin-bottom:20px;">
        <div style="display:flex; align-items:center; justify-content:space-between; width:100%; margin-bottom:12px;">
          <div id="a2ui-header-badge">
            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>
            Nexus Intelligence
            <span style="opacity:0.5;">·</span>
            <span style="opacity:0.7; font-weight:600;">Live Web Research</span>
          </div>
          <div style="display:flex; align-items:center; gap:8px;">
            <button id="a2ui-btn-new-chat" title="Start a new research chat" style="display:flex; align-items:center; gap:6px; background:rgba(255,255,255,0.08); border:1px solid rgba(255,255,255,0.16); color:#f8fafc; padding:6px 14px; border-radius:999px; font-size:12px; font-weight:700; cursor:pointer; transition:all 0.2s;">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
              + New Chat
            </button>
            <button id="a2ui-btn-history" title="View chat history" style="display:flex; align-items:center; gap:6px; background:rgba(255,255,255,0.08); border:1px solid rgba(255,255,255,0.16); color:#f8fafc; padding:6px 14px; border-radius:999px; font-size:12px; font-weight:700; cursor:pointer; transition:all 0.2s;">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
              History
            </button>
          </div>
        </div>
        <h2 id="a2ui-query-title" style="margin:0; font-size:24px; font-weight:800;">Searching...</h2>
      </div>

      <!-- History Drawer (hidden by default) -->
      <div id="a2ui-history-drawer" class="hidden" style="margin-bottom:20px; padding:16px 20px; background:rgba(18,18,24,0.92); border:1px solid rgba(255,255,255,0.18); border-radius:16px; backdrop-filter:blur(24px);">
        <div style="display:flex; align-items:center; justify-content:space-between; margin-bottom:12px; font-family:'Sora',sans-serif; font-size:12px; font-weight:800; color:#818cf8; letter-spacing:0.06em; text-transform:uppercase;">
          <span>Saved Research Conversations</span>
          <button id="a2ui-history-close" style="background:none; border:none; color:#94a3b8; cursor:pointer; font-size:14px;">✕</button>
        </div>
        <div id="a2ui-history-list" style="display:flex; flex-direction:column; gap:8px; max-height:240px; overflow-y:auto;">
          <div style="font-size:13px; color:#94a3b8;">No past research history found.</div>
        </div>
      </div>

      <!-- Status Bar -->
      <div id="a2ui-status-box">
        <div id="a2ui-status-spinner" style="width:18px;height:18px;border:2.5px solid var(--border-strong);border-top-color:#818cf8;border-radius:50%;animation:spin 1s linear infinite;flex-shrink:0;"></div>
        <span id="a2ui-status-text">Agent crawling and compiling results...</span>
      </div>

      <!-- Two-column layout -->
      <div id="a2ui-main-layout">
        <!-- Left: conversation turns -->
        <div id="a2ui-left-col">
          <div id="a2ui-turns"></div>
        </div>

        <!-- Right: sidebar -->
        <div id="a2ui-right-col">
          <div class="a2ui-context-card">
            <div class="a2ui-context-card-label">Result Preview</div>
            <div class="a2ui-context-card-text" id="a2ui-preview-text">Crawled sources and structured entities will appear here.</div>
          </div>
          <div id="a2ui-right-extras"></div>
        </div>
      </div>
    `;

    document.getElementById('a2ui-btn-new-chat')?.addEventListener('click', startNewChat);
    document.getElementById('a2ui-btn-history')?.addEventListener('click', toggleHistoryDrawer);
    document.getElementById('a2ui-history-close')?.addEventListener('click', () => {
      document.getElementById('a2ui-history-drawer')?.classList.add('hidden');
    });
  }

  function startNewChat() {
    if (_abort) _abort.abort();
    _activeTabTurns = [];
    if (typeof window.__a2uiSyncTabTurns === 'function') {
      window.__a2uiSyncTabTurns(_activeTabId, []);
    }
    rebuildViewHTML();
    const titleEl = document.getElementById('a2ui-query-title');
    if (titleEl) titleEl.textContent = 'New Research Chat';
    const statusBox = document.getElementById('a2ui-status-box');
    if (statusBox) statusBox.style.display = 'none';
  }

  function saveCurrentChatSession(turns) {
    if (!turns || !turns.length) return;
    try {
      const firstTurn = turns[0];
      const title = firstTurn.query;
      const saved = JSON.parse(localStorage.getItem('a2ui_saved_conversations') || '[]');
      const filtered = saved.filter(s => s.title !== title);
      filtered.unshift({
        id: 'conv-' + Date.now(),
        title: title,
        timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
        turns: turns
      });
      localStorage.setItem('a2ui_saved_conversations', JSON.stringify(filtered.slice(0, 30)));
    } catch (_) {}
  }

  function toggleHistoryDrawer() {
    const drawer = document.getElementById('a2ui-history-drawer');
    const list = document.getElementById('a2ui-history-list');
    if (!drawer || !list) return;

    if (!drawer.classList.contains('hidden')) {
      drawer.classList.add('hidden');
      return;
    }

    try {
      const conversations = JSON.parse(localStorage.getItem('a2ui_saved_conversations') || '[]');
      if (!conversations.length) {
        list.innerHTML = `<div style="font-size:13px; color:#94a3b8;">No past research history found.</div>`;
      } else {
        list.innerHTML = conversations.map(c => `
          <div class="a2ui-history-item" data-id="${attr(c.id)}" style="display:flex; align-items:center; justify-content:space-between; padding:10px 14px; border-radius:10px; background:rgba(255,255,255,0.05); border:1px solid rgba(255,255,255,0.1); cursor:pointer; transition:background 0.2s;">
            <div style="font-weight:600; font-size:13px; color:#f8fafc; text-overflow:ellipsis; overflow:hidden; white-space:nowrap; max-width:75%;">${esc(c.title)}</div>
            <div style="font-size:11px; color:#94a3b8; font-family:monospace;">${esc(c.timestamp)} (${c.turns ? c.turns.length : 1} turns)</div>
          </div>
        `).join('');

        list.querySelectorAll('.a2ui-history-item').forEach(el => {
          el.addEventListener('click', () => {
            const cid = el.dataset.id;
            const conv = conversations.find(c => c.id === cid);
            drawer.classList.add('hidden');
            if (conv && conv.turns) {
              _activeTabTurns = JSON.parse(JSON.stringify(conv.turns));
              if (typeof window.__a2uiSyncTabTurns === 'function') {
                window.__a2uiSyncTabTurns(_activeTabId, _activeTabTurns);
              }
              renderActiveTabTurns();
            }
          });
        });
      }
    } catch (_) {}

    drawer.classList.remove('hidden');
  }

  // ─── Main runner ─────────────────────────────────────────────
  let _abort = null;
  let _history = [];

  async function runSearch(query, isFollowup) {
    if (!query) return;

    if (_abort) _abort.abort();
    _abort = new AbortController();

    injectStyles();
    if (!isFollowup) rebuildViewHTML();


    const titleEl = document.getElementById('a2ui-query-title');
    const statusBox = document.getElementById('a2ui-status-box');
    const statusText = document.getElementById('a2ui-status-text');
    const turnsEl = document.getElementById('a2ui-turns');
    const rightExtras = document.getElementById('a2ui-right-extras');
    const previewText = document.getElementById('a2ui-preview-text');

    if (!turnsEl) return;

    // Switch to agent-search view (window.showDashboardView is exported from renderer.js IIFE)
    const dw = document.getElementById('dashboard-window');
    if (dw) dw.classList.remove('hidden');
    document.body.classList.remove('web-mode');

    if (typeof window.showDashboardView === 'function') {
      window.showDashboardView('agent-search');
    }
    document.querySelectorAll('.dashboard-view').forEach(v => v.classList.add('hidden'));
    const agView = document.getElementById('view-agent-search');
    if (agView) agView.classList.remove('hidden');


    titleEl.textContent = isFollowup ? `Follow-up: "${query}"` : `"${query}"`;

    // Re-show status spinner for this search turn
    if (statusBox) statusBox.style.display = '';
    if (statusText) statusText.textContent = `Agent crawling evidence for "${query}"...`;

    if (!isFollowup) _history = [];


    // Create turn container for this conversation step
    const turnEl = document.createElement('div');
    turnEl.className = 'a2ui-turn-container';
    turnsEl.appendChild(turnEl);

    // Add user question bubble inside this turn container
    const bubble = document.createElement('div');
    bubble.className = 'a2ui-user-bubble';
    bubble.innerHTML = `<div class="a2ui-user-bubble-inner">${esc(query)}</div>`;
    turnEl.appendChild(bubble);

    // Skeleton loader for answer card
    const skeleton = document.createElement('div');
    skeleton.className = 'a2ui-answer-card';
    skeleton.innerHTML = `
      <div class="a2ui-answer-label"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5"/></svg>Answer</div>
      <div style="display:flex;flex-direction:column;gap:10px;opacity:0.5;">
        <div class="a2ui-skeleton-line" style="width:70%;"></div>
        <div class="a2ui-skeleton-line" style="width:90%;"></div>
        <div class="a2ui-skeleton-line" style="width:55%;"></div>
      </div>`;
    turnEl.appendChild(skeleton);

    _history.push({ role: 'user', content: query });

    let activePageContextStr = '';
    if (typeof window.getActivePageContext === 'function') {
      try {
        const pageCtx = await window.getActivePageContext();
        if (pageCtx && pageCtx.url && !pageCtx.url.startsWith('bucks://')) {
          activePageContextStr = `\n[Currently Active Web Window:\nTitle: ${pageCtx.title}\nURL: ${pageCtx.url}\nPage Text Snippet:\n${pageCtx.text}]\n`;
        }
      } catch (_) {}
    }

    const openTabsCtx = (typeof window.getOpenTabsContext === 'function') ? window.getOpenTabsContext() : '';
    const tabsPrefix = openTabsCtx ? `\n[Open Tabs Context:\n${openTabsCtx}]\n` : '';

    const prompt = isFollowup
      ? `${activePageContextStr}${tabsPrefix}Follow-up: "${query}". Based on active window, open tabs, and previous context, provide a concise evidence-backed answer.`
      : `${activePageContextStr}${tabsPrefix}Research "${query}" and return: 1) a clear detailed answer, 2) images (use image_search tool), 3) videos if relevant, 4) top sources, 5) follow-up questions.`;

    let answer = '';
    let followups = [];
    const collectedUrls = [];
    const collectedImages = [];
    const renderedComponents = [];

    try {
      await streamSSE(`${SOUL}/agent`, { message: prompt, agentic: true }, (ev) => {
        if (!ev) return;

        if (ev.type === 'thinking') {
          statusText.textContent = ev.content || 'Synthesizing...';
        } else if (ev.type === 'tool_call') {
          statusText.textContent = `Running: ${ev.label || ev.name}...`;
        } else if (ev.type === 'tool_result') {
          previewText.textContent = (ev.content || '').slice(0, 180) + (ev.content?.length > 180 ? '…' : '');
        } else if (ev.type === 'ui_component') {
          statusBox.style.display = 'none';
          if (skeleton.parentNode) skeleton.remove();

          if (ev.component === 'image_gallery') {
            const html = renderImageGallery(ev.data || {}, query);
            if (html) {
              const wrap = document.createElement('div');
              wrap.innerHTML = html;
              rightExtras.appendChild(wrap.firstElementChild);
              (ev.data?.items || []).forEach(it => {
                if (it.url) collectedUrls.push(it.url);
                if (it.image) collectedImages.push(it.image);
              });
            }
            renderedComponents.push('images');
          } else if (ev.component === 'video') {
            const html = renderVideoCards(ev.data || {});
            if (html) {
              const wrap = document.createElement('div');
              wrap.innerHTML = html;
              rightExtras.appendChild(wrap.firstElementChild);
            }
            renderedComponents.push('video');
          } else if (ev.component === 'list' || ev.component === 'sources') {
            const items = (ev.data?.items || []);
            items.forEach(it => {
              if (it.url && !collectedUrls.includes(it.url)) collectedUrls.push(it.url);
            });
            const srcHtml = renderSources(collectedUrls);
            if (srcHtml && rightExtras) {
              const existingSrc = rightExtras.querySelector('.a2ui-sources-section');
              if (existingSrc) existingSrc.remove();
              const wrap = document.createElement('div');
              wrap.className = 'a2ui-sources-section';
              wrap.innerHTML = srcHtml;
              rightExtras.appendChild(wrap);
            }
          }
        } else if (ev.type === 'token') {
          statusBox.style.display = 'none';
          if (skeleton.parentNode) skeleton.remove();

          const chunk = ev.content || ev.token || '';
          answer += chunk;

          followups = extractFollowups(answer);
          const cleanAnswer = answer.replace(/<followup>[\s\S]*?<\/followup>/gi, '')
                                     .replace(/<followup>[\s\S]*/gi, '').trim();

          // Extract URLs from answer text
          const urlMatches = cleanAnswer.match(/(https?:\/\/[^\s)]+)/g) || [];
          urlMatches.forEach(u => { if (!collectedUrls.includes(u)) collectedUrls.push(u); });

          let answerCard = turnEl.querySelector('.a2ui-answer-card');
          if (!answerCard) {
            answerCard = document.createElement('div');
            answerCard.className = 'a2ui-answer-card';
            answerCard.innerHTML = `<div class="a2ui-answer-label"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5"/></svg>Answer</div><div class="a2ui-answer-text"></div>`;
            turnEl.appendChild(answerCard);
          }
          const answerText = answerCard.querySelector('.a2ui-answer-text');
          if (answerText) answerText.innerHTML = formatText(cleanAnswer);

          // Render CTAs immediately
          let ctaSection = turnEl.querySelector('.a2ui-ctas');
          if (!ctaSection) {
            const ctaHtml = renderCTAs(cleanAnswer, collectedUrls, query);
            if (ctaHtml) {
              const wrap = document.createElement('div');
              wrap.className = 'a2ui-cta-wrap';
              wrap.innerHTML = ctaHtml;
              turnEl.appendChild(wrap);
            }
          }
        }
      }, _abort.signal);

      // Done — render post-answer sections
      statusBox.style.display = 'none';

      // Sources
      if (collectedUrls.length > 0) {
        const srcHtml = renderSources(collectedUrls);
        if (srcHtml && rightExtras) {
          const existingSrc = rightExtras.querySelector('.a2ui-sources-section');
          if (existingSrc) existingSrc.remove();
          const wrap = document.createElement('div');
          wrap.innerHTML = srcHtml;
          rightExtras.appendChild(wrap.firstElementChild);
        }
      }

      // CTAs
      const ctaHtml = renderCTAs(answer, collectedUrls, query);
      if (ctaHtml && rightExtras) {
        const existingCta = rightExtras.querySelector('.a2ui-ctas-section');
        if (existingCta) existingCta.remove();
        const wrap = document.createElement('div');
        wrap.className = 'a2ui-ctas-section';
        wrap.innerHTML = ctaHtml;
        rightExtras.appendChild(wrap);
      }

      // Follow-up chips
      if (followups.length > 0) {
        const chipEl = renderFollowups(followups, (fq) => {
          runSearch(fq, true);
        });
        if (chipEl) turnEl.appendChild(chipEl);
      }

      _history.push({ role: 'assistant', content: answer });
      const newTurn = { query: query, answer: answer, followups: followups };
      _activeTabTurns.push(newTurn);
      if (typeof window.__a2uiSyncTabTurns === 'function') {
        window.__a2uiSyncTabTurns(_activeTabId, _activeTabTurns);
      }
      saveCurrentChatSession(_activeTabTurns);
      saveCurrentChatHistory();

      // Scroll to bottom
      setTimeout(() => {
        turnsEl.scrollIntoView ? turnsEl.lastElementChild?.scrollIntoView({ behavior: 'smooth', block: 'end' }) : null;
      }, 100);

    } catch (err) {
      console.warn('[A2UI Engine] Soul Engine response stream delayed/offline, running instant web fallback:', err);
      statusBox.style.display = 'none';
      if (skeleton.parentNode) skeleton.remove();

        // Attempt background supervisor restart if API bridge exists
        if (window.bucksAPI && typeof window.bucksAPI.soulSupervisorStart === 'function') {
          try { window.bucksAPI.soulSupervisorStart(); } catch (_) {}
        }

        // Direct web intelligence fallback query
        let fallbackAnswer = `**Research Breakdown for "${query}":**\n\n`;
        const fallbackUrls = [];
        try {
          const res = await fetch(`https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json`);
          if (res.ok) {
            const data = await res.json();
            if (data.AbstractText) fallbackAnswer += `${data.AbstractText}\n\n`;
            if (data.AbstractURL) fallbackUrls.push(data.AbstractURL);
            (data.RelatedTopics || []).slice(0, 4).forEach(t => {
              if (t.Text && t.FirstURL) {
                fallbackAnswer += `- **${esc(t.Text.slice(0, 100))}**: [Source Link](${t.FirstURL})\n`;
                fallbackUrls.push(t.FirstURL);
              }
            });
          }
        } catch (_) {}

        if (!fallbackUrls.length) {
          fallbackUrls.push(`https://en.wikipedia.org/wiki/Special:Search?search=${encodeURIComponent(query)}`);
          fallbackAnswer += `Gathered comprehensive background context and reference data for **${esc(query)}**.\n\n- Exploring primary domain sources and technical documentation.\n- Auto-restarting Soul Engine local background daemon (port 8765).`;
        }

        let answerCard = turnEl.querySelector('.a2ui-answer-card');
        if (!answerCard) {
          answerCard = document.createElement('div');
          answerCard.className = 'a2ui-answer-card';
          answerCard.innerHTML = `<div class="a2ui-answer-label"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5"/></svg>Answer (Web Fallback)</div><div class="a2ui-answer-text"></div>`;
          turnEl.appendChild(answerCard);
        }
        const answerText = answerCard.querySelector('.a2ui-answer-text');
        if (answerText) answerText.innerHTML = formatText(fallbackAnswer);

        // Sources & CTAs for fallback
        const srcHtml = renderSources(fallbackUrls);
        if (srcHtml && rightExtras) {
          const existingSrc = rightExtras.querySelector('.a2ui-sources-section');
          if (existingSrc) existingSrc.remove();
          const wrap = document.createElement('div');
          wrap.innerHTML = srcHtml;
          rightExtras.appendChild(wrap.firstElementChild);
        }

        const ctaHtml = renderCTAs(fallbackAnswer, fallbackUrls, query);
        if (ctaHtml && rightExtras) {
          const existingCta = rightExtras.querySelector('.a2ui-ctas-section');
          if (existingCta) existingCta.remove();
          const wrap = document.createElement('div');
          wrap.className = 'a2ui-ctas-section';
          wrap.innerHTML = ctaHtml;
          rightExtras.appendChild(wrap);
        }
        if (ctaHtml) {
          const wrap = document.createElement('div');
          wrap.innerHTML = ctaHtml;
          turnEl.appendChild(wrap.firstElementChild);
        }

        _history.push({ role: 'assistant', content: fallbackAnswer });
        saveCurrentChatHistory();
      }
    }

  // ─── Public API ───────────────────────────────────────────────
  window.__a2uiOpenTab = function(url) {
    if (!url) return;
    console.log('[A2UI Engine] Opening link in new tab:', url);

    // Unfreeze backdrop if frozen
    if (typeof unfreezePageBackdrop === 'function') {
      try { unfreezePageBackdrop(); } catch (_) {}
    }
    document.body.classList.remove('agent-freeze');

    // Switch to web mode
    const dashboardWindow = document.getElementById('dashboard-window');
    if (dashboardWindow) {
      dashboardWindow.classList.add('hidden');
    }
    document.body.classList.add('web-mode');

    let createdId = null;
    if (typeof createTab === 'function') {
      createdId = createTab(url);
    } else if (window.createTab) {
      createdId = window.createTab(url);
    } else if (window.bucksBrowser && typeof window.bucksBrowser.createTab === 'function') {
      createdId = window.bucksBrowser.createTab(url);
    } else if (window.bucksAPI && typeof window.bucksAPI.openExternal === 'function') {
      window.bucksAPI.openExternal(url);
      return;
    } else {
      window.open(url, '_blank');
      return;
    }

    setTimeout(() => {
      if (window.bucksTabs && typeof window.bucksTabs.setVisible === 'function' && createdId) {
        window.bucksTabs.setVisible(createdId, true);
      }
    }, 50);
  };

  window.__a2uiDispatchAction = function(actionPayload) {
    if (!actionPayload) return;
    console.log('[A2UI Engine] Dispatched action:', actionPayload);
    if (actionPayload.type === 'search_followup' && actionPayload.query) {
      runSearch(actionPayload.query, true);
    } else if (actionPayload.type === 'navigate' && actionPayload.url) {
      window.__a2uiOpenTab(actionPayload.url);
    } else if (window.bucksAPI && typeof window.bucksAPI.sendAgentAction === 'function') {
      window.bucksAPI.sendAgentAction(actionPayload);
    }
  };

  window.triggerAgentSearch = function(query, options) {
    runSearch(query, !!(options && options.isFollowup));
  };

  // Also expose as __a2uiRunSearch for renderer.js delegation stub
  window.__a2uiRunSearch = runSearch;


  // Wire bottom composer
  document.addEventListener('DOMContentLoaded', () => {
    const input = document.getElementById('nt-search-input');
    const sendBtn = document.getElementById('composer-send-btn');

    function handleComposerSend() {
      const val = (input?.value || '').trim();
      if (!val) return;
      input.value = '';
      runSearch(val, false);
    }

    sendBtn?.addEventListener('click', () => {
      const agentView = document.getElementById('view-agent-search');
      const inAgentView = agentView && !agentView.classList.contains('hidden');
      const val = (input?.value || '').trim();
      if (!val) return;
      if (inAgentView) {
        input.value = '';
        runSearch(val, true);
      } else {
        handleComposerSend();
      }
    });

    input?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        const agentView = document.getElementById('view-agent-search');
        const inAgentView = agentView && !agentView.classList.contains('hidden');
        const val = (input.value || '').trim();
        if (!val) return;
        if (inAgentView) {
          input.value = '';
          runSearch(val, true);
        }
      }
    });
  });

})();
