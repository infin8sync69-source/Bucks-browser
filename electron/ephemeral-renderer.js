/* ephemeral-renderer.js — Soul Engine A2UI overlay
 * Flow: input → stream from local Soul Engine → response + action chips
 * The window grows upward as the response appears (IPC: ephemeral:resize).
 * "Open in chat" routes to the main browser window's full chat panel. */

(function () {
  const SOUL_ENGINE = 'http://127.0.0.1:8765';
  const INPUT_HEIGHT = 72;   // collapsed height (px) — matches ephemeral-window.js
  const RESPONSE_MAX = 460;  // max expanded height

  // ── DOM refs ──
  const input       = document.getElementById('ephemeral-input');
  const statusDot   = document.getElementById('status-dot');
  const responseArea = document.getElementById('response-area');
  const responseText = document.getElementById('response-text');
  const errorMsg    = document.getElementById('error-msg');
  const chipsRow    = document.getElementById('chips-row');

  // Action chip buttons
  const chipOpenChat = document.getElementById('chip-open-chat');
  const chipCopy     = document.getElementById('chip-copy');
  const chipAgain    = document.getElementById('chip-again');
  const chipDismiss  = document.getElementById('chip-dismiss');

  let lastQuery    = '';
  let lastResponse = '';
  let streaming    = false;
  let abortCtrl    = null;

  // ── Resize helper ──
  function setHeight(px) {
    if (window.ephemeralAPI && window.ephemeralAPI.resize) {
      window.ephemeralAPI.resize(Math.round(px));
    }
  }

  // ── Reset to collapsed state ──
  function collapse() {
    responseArea.classList.remove('visible');
    chipsRow.classList.remove('visible');
    responseText.textContent = '';
    responseText.classList.remove('streaming');
    errorMsg.classList.remove('visible');
    errorMsg.textContent = '';
    statusDot.className = '';
    lastResponse = '';
    setHeight(INPUT_HEIGHT);
  }

  // ── Show error ──
  function showError(msg) {
    streaming = false;
    statusDot.className = 'err';
    responseText.classList.remove('streaming');
    errorMsg.textContent = '⚠ ' + msg;
    errorMsg.classList.add('visible');
    chipsRow.classList.add('visible');
    // Reveal response area with just the error + chips
    responseArea.classList.add('visible');
    setHeight(INPUT_HEIGHT + 80);
  }

  // ── Stream response from Soul Engine ──
  async function runQuery(query) {
    if (streaming) {
      abortCtrl && abortCtrl.abort();
    }
    streaming = true;
    lastQuery = query;
    lastResponse = '';

    // Reveal response zone immediately, hide chips until done
    errorMsg.classList.remove('visible');
    responseText.textContent = '';
    responseText.classList.add('streaming');
    chipsRow.classList.remove('visible');
    responseArea.classList.add('visible');
    statusDot.className = 'thinking';
    setHeight(INPUT_HEIGHT + 120);

    abortCtrl = new AbortController();

    try {
      const res = await fetch(`${SOUL_ENGINE}/agent`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
        body: JSON.stringify({
          query,
          history: [],
          stream: true,
          mode: 'ephemeral'
        }),
        signal: abortCtrl.signal
      });

      if (!res.ok) throw new Error(`Soul Engine returned ${res.status}`);

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buf += decoder.decode(value, { stream: true });
        const lines = buf.split('\n');
        buf = lines.pop(); // keep incomplete line

        for (const line of lines) {
          if (!line.startsWith('data:')) continue;
          const raw = line.slice(5).trim();
          if (raw === '[DONE]') continue;

          let ev;
          try { ev = JSON.parse(raw); } catch (_) { continue; }

          // Handle token events
          const token =
            ev.token ??
            ev.delta?.content ??
            ev.choices?.[0]?.delta?.content ??
            null;

          if (token) {
            lastResponse += token;
            responseText.textContent = lastResponse;
            // Auto-scroll
            responseText.scrollTop = responseText.scrollHeight;

            // Grow the window as content accumulates (capped)
            const needed = Math.min(
              INPUT_HEIGHT + 20 + responseText.scrollHeight + 80,
              RESPONSE_MAX
            );
            setHeight(needed);
          }
        }
      }

      // Done streaming
      streaming = false;
      abortCtrl = null;
      responseText.classList.remove('streaming');
      statusDot.className = 'done';
      if (!lastResponse) {
        showError('No response received from Soul Engine.');
        return;
      }
      chipsRow.classList.add('visible');

    } catch (err) {
      if (err.name === 'AbortError') return; // user started a new query
      streaming = false;
      abortCtrl = null;

      // Fallback: if Soul Engine is offline, route to main window instead
      if (err.message.includes('fetch') || err.message.includes('Failed')) {
        showError('Soul Engine offline — routing to main chat…');
        setTimeout(async () => {
          await window.ephemeralAPI.submitQuery(query);
        }, 900);
      } else {
        showError(err.message || 'Unknown error');
      }
    }
  }

  // ── Input events ──
  input.addEventListener('keydown', async (e) => {
    if (e.key === 'Enter') {
      const query = input.value.trim();
      if (!query) return;
      await runQuery(query);
    } else if (e.key === 'Escape') {
      if (responseArea.classList.contains('visible')) {
        collapse();
        input.focus();
      } else {
        window.ephemeralAPI.hide();
      }
    }
  });

  // ── Action chips ──
  chipOpenChat.addEventListener('click', async () => {
    if (lastQuery) {
      await window.ephemeralAPI.submitQuery(lastQuery);
    }
  });

  chipCopy.addEventListener('click', async () => {
    if (lastResponse) {
      try {
        await navigator.clipboard.writeText(lastResponse);
        chipCopy.textContent = '✓ Copied';
        setTimeout(() => { chipCopy.innerHTML = '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg> Copy'; }, 1800);
      } catch (_) {}
    }
  });

  chipAgain.addEventListener('click', async () => {
    if (lastQuery) {
      input.value = lastQuery;
      await runQuery(lastQuery);
    }
  });

  chipDismiss.addEventListener('click', () => {
    collapse();
    window.ephemeralAPI.hide();
  });

  // ── Focus input when window is shown ──
  window.ephemeralAPI.onFocusInput(() => {
    collapse();
    input.focus();
    input.select();
  });

  // Initial focus
  document.addEventListener('DOMContentLoaded', () => {
    input.focus();
  });
})();
