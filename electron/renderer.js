/* ╔═══════════════════════════════════════════════╗
   ║     BUCKS WEB3 BROWSER — RENDERER LOGIC       ║
   ╚═══════════════════════════════════════════════╝ */

(function () {
  'use strict';

  /* ─── State ─── */
  let tabs = [];
  let activeTabId = null;
  let settings = {};

  // Incognito / private window: signalled via the #private URL hash from main.js.
  // Private windows use an in-memory webview partition and skip history persistence.
  const IS_PRIVATE = (location.hash || '').includes('private');

  // Downloads + zoom state
  let downloads = [];
  let zoomFactor = 1;

  // Spaces / Tab Grouping State
  let spaces = [
    { id: 'default', name: 'General', color: '#52b6ff' },
    { id: 'work', name: 'Work Space', color: '#f7931a' },
    { id: 'personal', name: 'Personal Space', color: '#2ed573' },
    { id: 'finance', name: 'Finance Space', color: '#ff7a96' }
  ];
  let activeSpaceId = 'default';

  // Workspace & Widgets State
  let widgets = [];
  let chatHistory = [];
  let topZ = 20;
  let moved = false;
  let justDragged = false;

  // Wallet State
  let walletState = {
    connected: false,
    address: '',
    balance: 0,
    goldRate: 0,
    currentView: 'home', // 'welcome', 'create', 'recovery', 'restore', 'home'
    mnemonic: '',
    password: ''
  };

  /* ─── DOM refs ─── */
  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => document.querySelectorAll(sel);

  const tabsContainer = $('#tabs-container');
  const browserContent = $('#browser-content');
  const addressBar = $('#address-bar');
  const blockedBadge = $('#blocked-count');
  const walletSidebar = $('#wallet-sidebar');
  const settingsPanel = $('#settings-panel');
  const historyPanel = $('#history-panel');
  const bookmarksPanel = $('#bookmarks-panel');
  const downloadsPanel = $('#downloads-panel');
  const btnBookmark = $('#btn-bookmark');
  const omniboxDropdown = $('#omnibox-dropdown');
  const findBar = $('#find-bar');
  const findInput = $('#find-input');
  const findResults = $('#find-results');

  /* ─── Utility ─── */
  let tabIdCounter = 0;
  function genTabId() { return `tab-${++tabIdCounter}`; }

  function cidV0toV1(cidV0) {
    const B58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
    const B32_ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567';
    try {
      if (!cidV0.startsWith('Qm') || cidV0.length !== 46) return cidV0;
      const bytes = [0];
      for (let i = 0; i < cidV0.length; i++) {
        let value = B58_ALPHABET.indexOf(cidV0[i]);
        if (value === -1) return cidV0;
        for (let j = 0; j < bytes.length; j++) {
          value += bytes[j] * 58;
          bytes[j] = value & 0xff;
          value = value >> 8;
        }
        while (value > 0) {
          bytes.push(value & 0xff);
          value = value >> 8;
        }
      }
      let numZeros = 0;
      for (let i = 0; i < cidV0.length && cidV0[i] === '1'; i++) {
        numZeros++;
      }
      const bytesV0 = new Uint8Array(numZeros + bytes.length);
      for (let i = 0; i < numZeros; i++) bytesV0[i] = 0;
      for (let i = 0; i < bytes.length; i++) {
        bytesV0[numZeros + i] = bytes[bytes.length - 1 - i];
      }
      const bytesV1 = new Uint8Array(2 + bytesV0.length);
      bytesV1[0] = 1;
      bytesV1[1] = 0x70;
      bytesV1.set(bytesV0, 2);
      let bits = 0;
      let val = 0;
      let output = '';
      for (let i = 0; i < bytesV1.length; i++) {
        val = (val << 8) | bytesV1[i];
        bits += 8;
        while (bits >= 5) {
          output += B32_ALPHABET[(val >>> (bits - 5)) & 31];
          bits -= 5;
        }
      }
      if (bits > 0) {
        output += B32_ALPHABET[(val << (5 - bits)) & 31];
      }
      return 'b' + output;
    } catch (e) {
      return cidV0;
    }
  }

  function isURL(str) {
    if (/^(https?:\/\/|file:\/\/|ipfs:\/\/|ipns:\/\/)/i.test(str)) return true;
    if (/^[\w-]+(\.[\w-]+)+/.test(str) && !str.includes(' ')) return true;
    const trimmed = str.trim();
    if (trimmed.startsWith('Qm') && trimmed.length === 46 && !trimmed.includes(' ')) return true;
    if (trimmed.startsWith('bafy') && trimmed.length === 59 && !trimmed.includes(' ')) return true;
    return false;
  }

  function normalizeURL(str) {
    let target = str.trim();
    if (/^ipfs:\/\//i.test(target)) {
      const match = target.match(/^ipfs:\/\/([^\/]+)(.*)$/i);
      if (match) {
        const cid = match[1];
        const rest = match[2] || '';
        if (cid.startsWith('Qm') && cid.length === 46) {
          target = `ipfs://${cidV0toV1(cid)}${rest}`;
        }
      }
    } else if (/^ipns:\/\//i.test(target)) {
      const match = target.match(/^ipns:\/\/([^\/]+)(.*)$/i);
      if (match) {
        const cid = match[1];
        const rest = match[2] || '';
        if (cid.startsWith('Qm') && cid.length === 46) {
          target = `ipns://${cidV0toV1(cid)}${rest}`;
        }
      }
    } else if (target.startsWith('Qm') && target.length === 46) {
      target = `ipfs://${cidV0toV1(target)}`;
    } else if (target.startsWith('bafy') && target.length === 59) {
      target = `ipfs://${target}`;
    }

    if (/^(https?|file|ipfs|ipns|bucks):\/\//i.test(target)) return target;
    if (/^[\w-]+(\.[\w-]+)+/.test(target)) return `https://${target}`;
    return `${settings.searchEngine || 'https://duckduckgo.com/?q='}${encodeURIComponent(target)}`;
  }

  /* ═══════════ SECURITY & ORIGIN APPROVAL ═══════════ */
  window.bucksAPI.onWalletAccessRequest(({ requestId, origin }) => {
    const modal = $('#origin-approval');
    const originText = $('#requesting-origin');
    originText.textContent = origin;
    modal.classList.remove('sidebar-hidden');

    if ($('#btn-origin-deny')) $('#btn-origin-deny').onclick = () => {
      window.bucksAPI.respondToWalletAccess(requestId, false);
      modal.classList.add('sidebar-hidden');
    };
  });

  /* ═══════════ WIDGETS ENGINE & DYNAMIC WORKSPACE ═══════════ */

  function loadWidgets() {
    try {
      const stored = localStorage.getItem('bucks-widgets');
      if (stored) {
        widgets = JSON.parse(stored);
      } else {
        widgets = [
          { uid: 1, type: 'clock', x: 24, y: 14, w: 410, h: 150, z: 1 },
          { uid: 2, type: 'weather', x: 452, y: 14, w: 250, h: 196, z: 2 },
          { uid: 3, type: 'calendar', x: 24, y: 188, w: 290, h: 220, z: 3 },
          { uid: 4, type: 'music', x: 332, y: 232, w: 400, h: 150, z: 4 }
        ];
      }
    } catch (e) {
      console.error('Failed to load widgets:', e);
    }
  }

  function saveWidgets() {
    try {
      localStorage.setItem('bucks-widgets', JSON.stringify(widgets));
    } catch (e) {
      console.error('Failed to save widgets:', e);
    }
  }

  function getClockTime() {
    const d = new Date();
    let h = d.getHours();
    const ap = h >= 12 ? 'PM' : 'AM';
    let h12 = h % 12;
    if (h12 === 0) h12 = 12;
    const min = String(d.getMinutes()).padStart(2, '0');
    return {
      time: `${h12}:${min}`,
      ampm: ap
    };
  }

  function getGreeting() {
    const hrs = new Date().getHours();
    if (hrs < 12) return 'Good Morning';
    if (hrs < 18) return 'Good Afternoon';
    return 'Good Evening';
  }

  function getFormattedDate(short = false) {
    const d = new Date();
    const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    const daysShort = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    
    if (short) {
      return `${daysShort[d.getDay()]}, ${months[d.getMonth()]} ${d.getDate()}`;
    }
    return `${days[d.getDay()]}, ${months[d.getMonth()]} ${d.getDate()}`;
  }

  function updateClocks() {
    const timeInfo = getClockTime();
    const greeting = getGreeting();
    const dateStr = getFormattedDate(false);
    
    $$('.widget-clock-time').forEach(el => {
      el.innerHTML = `${timeInfo.time}<span style="font-size:19px; font-weight:600; color:rgba(255,255,255,0.5); margin-left:6px;">${timeInfo.ampm}</span>`;
    });
    $$('.widget-clock-greeting').forEach(el => {
      el.textContent = greeting;
    });
    $$('.widget-clock-date').forEach(el => {
      el.textContent = dateStr;
    });
  }

  function renderWidgets() {
    const board = $('#widgets-board');
    if (!board) return;
    board.innerHTML = '';

    widgets.forEach((w, index) => {
      const tile = document.createElement('div');
      tile.className = 'widget-tile';
      tile.dataset.uid = w.uid;
      tile.dataset.index = index;
      
      // Position and size
      tile.style.left = `${w.x}px`;
      tile.style.top = `${w.y}px`;
      tile.style.width = `${w.w}px`;
      tile.style.height = `${w.h}px`;
      tile.style.zIndex = w.z || 1;

      // Close Button
      const removeBtn = document.createElement('button');
      removeBtn.className = 'widget-remove-btn';
      removeBtn.title = 'Remove';
      removeBtn.style.cssText = `position:absolute; top:9px; right:9px; z-index:3; width:22px; height:22px; border-radius:50%; border:none; cursor:pointer; background:rgba(0,0,0,0.32); display:flex; align-items:center; justify-content:center;`;
      removeBtn.innerHTML = `<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2.6" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"></path></svg>`;
      removeBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        removeWidget(w.uid);
      });
      tile.appendChild(removeBtn);

      // Inner Container
      const content = document.createElement('div');
      content.style.height = '100%';
      content.style.width = '100%';

      if (w.type === 'clock') {
        const timeInfo = getClockTime();
        content.innerHTML = `
          <div style="display:flex; align-items:center; justify-content:space-between; height:100%; gap:14px;">
            <div class="widget-clock-time" style="font-family:'Sora',sans-serif; font-weight:800; font-size:52px; line-height:1; letter-spacing:-0.03em;">${timeInfo.time}<span style="font-size:19px; font-weight:600; color:rgba(255,255,255,0.5); margin-left:6px;">${timeInfo.ampm}</span></div>
            <div style="text-align:right;"><div class="widget-clock-greeting" style="font-size:16px; font-weight:600;">${getGreeting()}</div><div class="widget-clock-date" style="font-size:13px; color:rgba(255,255,255,0.55); margin-top:3px;">${getFormattedDate(false)}</div></div>
          </div>
        `;
      } else if (w.type === 'weather') {
        content.innerHTML = `
          <div style="font-size:11px; font-weight:700; letter-spacing:0.07em; color:rgba(255,255,255,0.45); margin-bottom:8px;">WEATHER · LISBON</div>
          <div style="display:flex; align-items:baseline; gap:9px;"><span style="font-family:'Sora',sans-serif; font-weight:700; font-size:40px; line-height:1;">23°</span><span style="font-size:14px; color:rgba(255,255,255,0.6);">Clear</span></div>
          <div style="display:flex; gap:14px; margin-top:14px;">
            <div style="display:flex; flex-direction:column; align-items:center; gap:5px;"><span style="font-size:11.5px; color:rgba(255,255,255,0.45);">Mon</span><span style="font-size:13.5px; font-weight:600;">23°</span></div>
            <div style="display:flex; flex-direction:column; align-items:center; gap:5px;"><span style="font-size:11.5px; color:rgba(255,255,255,0.45);">Tue</span><span style="font-size:13.5px; font-weight:600;">21°</span></div>
            <div style="display:flex; flex-direction:column; align-items:center; gap:5px;"><span style="font-size:11.5px; color:rgba(255,255,255,0.45);">Wed</span><span style="font-size:13.5px; font-weight:600;">20°</span></div>
            <div style="display:flex; flex-direction:column; align-items:center; gap:5px;"><span style="font-size:11.5px; color:rgba(255,255,255,0.45);">Thu</span><span style="font-size:13.5px; font-weight:600;">22°</span></div>
          </div>
        `;
      } else if (w.type === 'calendar') {
        content.innerHTML = `
          <div style="font-size:11px; font-weight:700; letter-spacing:0.07em; color:rgba(255,255,255,0.45); margin-bottom:8px;">TODAY</div>
          <div style="font-family:'Sora',sans-serif; font-weight:700; font-size:24px; margin-bottom:12px;">${getFormattedDate(true)}</div>
          <div style="display:flex; flex-direction:column; gap:9px;">
            <div style="display:flex; align-items:center; gap:11px;"><span style="font-size:12.5px; color:rgba(255,255,255,0.5); width:46px; flex:none;">10:00</span><span style="width:6px; height:6px; border-radius:50%; background:rgba(255,255,255,0.7); flex:none;"></span><span style="font-size:13.5px; font-weight:500;">Standup</span></div>
            <div style="display:flex; align-items:center; gap:11px;"><span style="font-size:12.5px; color:rgba(255,255,255,0.5); width:46px; flex:none;">14:30</span><span style="width:6px; height:6px; border-radius:50%; background:rgba(255,255,255,0.7); flex:none;"></span><span style="font-size:13.5px; font-weight:500;">Design review</span></div>
            <div style="display:flex; align-items:center; gap:11px;"><span style="font-size:12.5px; color:rgba(255,255,255,0.5); width:46px; flex:none;">17:00</span><span style="width:6px; height:6px; border-radius:50%; background:rgba(255,255,255,0.7); flex:none;"></span><span style="font-size:13.5px; font-weight:500;">1:1 with Sam</span></div>
          </div>
        `;
      } else if (w.type === 'music') {
        content.innerHTML = `
          <div style="display:flex; align-items:center; gap:16px; height:100%;">
            <div style="flex:none; width:60px; height:60px; border-radius:13px; background:linear-gradient(145deg,#8a8a8e,#48484c); box-shadow:inset 0 1px 0 rgba(255,255,255,0.3); display:flex; align-items:center; justify-content:center; font-size:24px;">🎵</div>
            <div style="flex:1; min-width:0;">
              <div style="font-size:11px; font-weight:700; letter-spacing:0.07em; color:rgba(255,255,255,0.45); margin-bottom:4px;">NOW PLAYING</div>
              <div style="font-size:15px; font-weight:700; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">Deeper Well</div>
              <div style="font-size:13px; color:rgba(255,255,255,0.55);">Kacey Musgraves</div>
              <div style="margin-top:9px; height:4px; border-radius:99px; background:rgba(255,255,255,0.16);"><div style="width:38%; height:100%; border-radius:99px; background:#fff;"></div></div>
            </div>
            <div style="display:flex; align-items:center; gap:10px;">
              <svg class="music-ctrl-btn" width="18" height="18" viewBox="0 0 24 24" fill="#fff" style="cursor:pointer;"><path d="M7 6v12M9 12l9-6v12z"></path></svg>
              <svg class="music-ctrl-btn" width="22" height="22" viewBox="0 0 24 24" fill="#fff" style="cursor:pointer;"><path d="M8 5h3v14H8zM13 5h3v14h-3z"></path></svg>
              <svg class="music-ctrl-btn" width="18" height="18" viewBox="0 0 24 24" fill="#fff" style="cursor:pointer;"><path d="M17 6v12M15 12L6 6v12z"></path></svg>
            </div>
          </div>
        `;
      } else if (w.type === 'agent') {
        content.innerHTML = `
          <div style="display:flex; align-items:center; gap:9px; margin-bottom:12px;">
            <span style="width:30px; height:30px; border-radius:9px; display:flex; align-items:center; justify-content:center; background:linear-gradient(135deg,#5e5e63,#2c2c30); box-shadow:inset 0 1px 0 rgba(255,255,255,0.25);">
              <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="1.6" stroke-linejoin="round"><path d="M12 3l1.7 4.6 4.6 1.7-4.6 1.7L12 15.6l-1.7-4.6L5.7 9.3l4.6-1.7z"></path></svg>
            </span>
            <span style="font-size:15px; font-weight:700;">Delegate a task</span>
          </div>
          <div style="display:flex; flex-direction:column; gap:8px;">
            <button class="btn-agent-task" data-query="summarize my open tabs" style="text-align:left; padding:9px 12px; border-radius:11px; border:1px solid rgba(255,255,255,0.12); background:rgba(255,255,255,0.05); color:#fff; font-family:inherit; font-size:13.5px; cursor:pointer;">Summarize my open tabs</button>
            <button class="btn-agent-task" data-query="plan a 5-day Lisbon trip" style="text-align:left; padding:9px 12px; border-radius:11px; border:1px solid rgba(255,255,255,0.12); background:rgba(255,255,255,0.05); color:#fff; font-family:inherit; font-size:13.5px; cursor:pointer;">Plan a 5-day Lisbon trip</button>
          </div>
        `;
        content.querySelectorAll('.btn-agent-task').forEach(btn => {
          btn.addEventListener('click', (e) => {
            e.stopPropagation();
            sendChat(btn.getAttribute('data-query'));
          });
        });
      } else if (w.type === 'markets' || w.type === 'stocks') {
        content.innerHTML = `
          <div style="font-size:11px; font-weight:700; letter-spacing:0.07em; color:rgba(255,255,255,0.45); margin-bottom:10px;">MARKETS</div>
          <div style="display:flex; flex-direction:column; gap:10px;">
            <div style="display:flex; align-items:center;"><span style="font-size:14px; font-weight:700; width:56px;">AAPL</span><span style="font-size:13px; color:rgba(255,255,255,0.6);">228.5</span><span style="margin-left:auto; font-size:13px; font-weight:600; color:#fff;">▲ 1.2%</span></div>
            <div style="display:flex; align-items:center;"><span style="font-size:14px; font-weight:700; width:56px;">NVDA</span><span style="font-size:13px; color:rgba(255,255,255,0.6);">132.1</span><span style="margin-left:auto; font-size:13px; font-weight:600; color:#fff;">▲ 3.4%</span></div>
            <div style="display:flex; align-items:center;"><span style="font-size:14px; font-weight:700; width:56px;">TSLA</span><span style="font-size:13px; color:rgba(255,255,255,0.6);">214.8</span><span style="margin-left:auto; font-size:13px; font-weight:600; color:rgba(255,255,255,0.45);">▼ 0.8%</span></div>
          </div>
        `;
      } else if (w.type === 'notes') {
        content.innerHTML = `
          <div style="font-size:11px; font-weight:700; letter-spacing:0.07em; color:rgba(255,255,255,0.45); margin-bottom:10px;">NOTES</div>
          <div style="display:flex; flex-direction:column; gap:9px;">
            <div style="display:flex; align-items:flex-start; gap:9px; font-size:13.5px; color:rgba(255,255,255,0.85);"><span style="width:5px; height:5px; border-radius:50%; background:rgba(255,255,255,0.6); margin-top:7px; flex:none;"></span>Ship the monochrome design system</div>
            <div style="display:flex; align-items:flex-start; gap:9px; font-size:13.5px; color:rgba(255,255,255,0.85);"><span style="width:5px; height:5px; border-radius:50%; background:rgba(255,255,255,0.6); margin-top:7px; flex:none;"></span>Follow up: Lisbon flight options</div>
            <div style="display:flex; align-items:flex-start; gap:9px; font-size:13.5px; color:rgba(255,255,255,0.85);"><span style="width:5px; height:5px; border-radius:50%; background:rgba(255,255,255,0.6); margin-top:7px; flex:none;"></span>Renew bucks.ai domain</div>
          </div>
        `;
      } else if (w.type === 'space') {
        content.innerHTML = `
          <div style="font-size:11px; font-weight:700; letter-spacing:0.07em; color:rgba(255,255,255,0.45); margin-bottom:8px;">SPACE</div>
          <div style="font-family:'Sora',sans-serif; font-weight:700; font-size:22px;">Work</div>
          <div style="font-size:13px; color:rgba(255,255,255,0.55); margin-bottom:12px;">4 tabs · resume</div>
          <div style="display:flex; gap:7px;">
            <span style="width:30px; height:30px; border-radius:8px; background:rgba(255,255,255,0.1); border:1px solid rgba(255,255,255,0.14);"></span>
            <span style="width:30px; height:30px; border-radius:8px; background:rgba(255,255,255,0.1); border:1px solid rgba(255,255,255,0.14);"></span>
            <span style="width:30px; height:30px; border-radius:8px; background:rgba(255,255,255,0.1); border:1px solid rgba(255,255,255,0.14);"></span>
            <span style="width:30px; height:30px; border-radius:8px; background:rgba(255,255,255,0.1); border:1px solid rgba(255,255,255,0.14);"></span>
          </div>
        `;
      }
      
      tile.appendChild(content);

      // Resize Handle
      const resizeHandle = document.createElement('div');
      resizeHandle.className = 'widget-resize-handle';
      resizeHandle.dataset.rz = 'true';
      resizeHandle.style.cssText = `position:absolute; right:2px; bottom:2px; z-index:3; width:22px; height:22px; cursor:nwse-resize; display:flex; align-items:flex-end; justify-content:flex-end; padding:5px;`;
      resizeHandle.innerHTML = `<svg width="11" height="11" viewBox="0 0 12 12" fill="none" stroke="#fff" stroke-width="1.6" stroke-linecap="round"><path d="M11 5L5 11M11 9l-2 2"></path></svg>`;
      tile.appendChild(resizeHandle);

      board.appendChild(tile);

      // Pointer events for Move / Resize
      tile.addEventListener('pointerdown', (e) => {
        // Ignore dragging on interactive inner elements
        if (e.target.closest('button, a, input, select, textarea')) return;
        
        const isResize = !!e.target.closest('[data-rz="true"]');
        startInteract(index, isResize ? 'resize' : 'move', e);
      });
    });
  }

  function addWidget(type) {
    const defaultSizes = {
      clock: [410, 150],
      weather: [250, 196],
      calendar: [290, 220],
      music: [400, 150],
      agent: [300, 210],
      notes: [290, 210],
      markets: [270, 210],
      space: [240, 180]
    };
    const sz = defaultSizes[type] || [280, 180];
    const n = widgets.length;
    const uid = Date.now() + Math.random().toString(36).substr(2, 9);
    let maxZ = widgets.reduce((max, w) => Math.max(max, w.z || 0), 0) + 1;
    
    widgets.push({
      uid,
      type,
      x: 40 + (n % 5) * 34,
      y: 36 + (n % 5) * 34,
      w: sz[0],
      h: sz[1],
      z: maxZ
    });
    
    saveWidgets();
    renderWidgets();
    
    const libOverlay = $('#widget-library-overlay');
    if (libOverlay) libOverlay.classList.add('hidden');
  }

  function removeWidget(uid) {
    widgets = widgets.filter(w => w.uid !== uid);
    saveWidgets();
    renderWidgets();
  }

  function startInteract(idx, mode, e) {
    e.preventDefault();
    const tile = e.currentTarget;
    const startX = e.clientX;
    const startY = e.clientY;
    const w0 = widgets[idx];
    if (!w0) return;
    
    const ox = w0.x;
    const oy = w0.y;
    const ow = w0.w;
    const oh = w0.h;
    
    const board = $('#widgets-board');
    const rect = board ? board.getBoundingClientRect() : { width: 4000, height: 4000 };
    
    moved = false;
    tile.classList.add('dragging');
    w0.z = ++topZ;
    tile.style.zIndex = w0.z;

    function move(ev) {
      const dx = ev.clientX - startX;
      const dy = ev.clientY - startY;
      
      if (Math.abs(dx) > 3 || Math.abs(dy) > 3) {
        moved = true;
      }
      
      if (mode === 'move') {
        w0.x = Math.max(0, Math.min(ox + dx, rect.width - w0.w));
        w0.y = Math.max(0, Math.min(oy + dy, rect.height - w0.h));
        tile.style.left = `${w0.x}px`;
        tile.style.top = `${w0.y}px`;
      } else {
        w0.w = Math.max(190, Math.min(ow + dx, rect.width - w0.x));
        w0.h = Math.max(110, Math.min(oh + dy, rect.height - w0.y));
        tile.style.width = `${w0.w}px`;
        tile.style.height = `${w0.h}px`;
      }
    }

    function up() {
      document.removeEventListener('pointermove', move);
      document.removeEventListener('pointerup', up);
      tile.classList.remove('dragging');
      
      if (moved) {
        justDragged = true;
        saveWidgets();
      }
    }

    document.addEventListener('pointermove', move);
    document.addEventListener('pointerup', up);
  }

  function wireWidgetsCanvas() {
    const board = $('#widgets-board');
    if (!board) return;
    board.addEventListener('click', (e) => {
      if (justDragged) {
        justDragged = false;
        return;
      }
      if (e.target.closest('.widget-tile, button, a, input, select, textarea, [data-rz]')) return;
      
      const libOverlay = $('#widget-library-overlay');
      if (libOverlay) libOverlay.classList.remove('hidden');
    });

    const addWidgetBtn = $('#btn-add-widget');
    if (addWidgetBtn) {
      addWidgetBtn.addEventListener('click', () => {
        const libOverlay = $('#widget-library-overlay');
        if (libOverlay) libOverlay.classList.remove('hidden');
      });
    }

    const closeWidgetLibBtn = $('#btn-close-widget-library');
    if (closeWidgetLibBtn) {
      closeWidgetLibBtn.addEventListener('click', () => {
        const libOverlay = $('#widget-library-overlay');
        if (libOverlay) libOverlay.classList.add('hidden');
      });
    }

    $$('.btn-add-lib-widget').forEach(btn => {
      btn.addEventListener('click', () => {
        const type = btn.getAttribute('data-widget');
        addWidget(type);
      });
    });
  }

  /* ═══════════ CHAT HISTORY & APP STORE HELPERS ═══════════ */

  function classifyQueryKind(q) {
    const t = q.toLowerCase();
    if (/(flight|trip|travel|lisbon|tokyo|weekend|vacation|hotel|fly|getaway)/.test(t)) return 'flights';
    if (/(compare|vs|best|laptop|buy|deal|cheap|price|macbook)/.test(t)) return 'compare';
    return 'summary';
  }

  function loadChatHistory() {
    try {
      const stored = localStorage.getItem('bucks-chat-history');
      if (stored) {
        chatHistory = JSON.parse(stored);
      } else {
        chatHistory = [
          { q: 'Plan a 5-day Lisbon trip', time: '2:14 PM', kind: 'flights' },
          { q: 'Compare MacBook Air vs Pro', time: '1:02 PM', kind: 'compare' },
          { q: 'Summarize my open tabs', time: '11:30 AM', kind: 'summary' }
        ];
      }
    } catch (e) {
      console.error('Failed to load chat history:', e);
    }
  }

  function saveChatHistory() {
    try {
      localStorage.setItem('bucks-chat-history', JSON.stringify(chatHistory));
    } catch (e) {
      console.error('Failed to save chat history:', e);
    }
  }

  function renderChatHistory() {
    const container = $('#chat-history-list');
    if (!container) return;
    container.innerHTML = '';
    
    chatHistory.forEach(h => {
      const btn = document.createElement('button');
      btn.className = 'chat-history-item-btn';
      btn.style.cssText = `display:flex; align-items:center; gap:12px; padding:11px 12px; border-radius:13px; border:none; cursor:pointer; background:transparent; text-align:left; color:#fff; font-family:inherit; width: 100%;`;
      btn.innerHTML = `
        <span style="flex:none; width:30px; height:30px; border-radius:9px; display:flex; align-items:center; justify-content:center; background:linear-gradient(135deg,#5e5e63,#2c2c30); box-shadow:inset 0 1px 0 rgba(255,255,255,0.22);"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="1.6" stroke-linejoin="round"><path d="M12 3l1.7 4.6 4.6 1.7-4.6 1.7L12 15.6l-1.7-4.6L5.7 9.3l4.6-1.7z"></path></svg></span>
        <div style="flex:1; min-width:0;"><div style="font-size:14px; font-weight:600; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">${escapeHTML(h.q)}</div><div style="font-size:12px; color:rgba(255,255,255,0.5);">${h.kind}</div></div>
        <span style="flex:none; font-size:12px; color:rgba(255,255,255,0.45);">${h.time}</span>
      `;
      btn.addEventListener('click', () => {
        const popover = $('#chat-history-popover');
        if (popover) popover.classList.add('hidden');
        sendChat(h.q);
      });
      container.appendChild(btn);
    });
  }

  function wireChatHistoryPopover() {
    const toggle = $('#btn-chat-history-toggle');
    const popover = $('#chat-history-popover');
    const closeBtn = $('#btn-close-chat-history');
    
    if (toggle && popover) {
      toggle.addEventListener('click', (e) => {
        e.stopPropagation();
        popover.classList.toggle('hidden');
      });
    }
    
    if (closeBtn && popover) {
      closeBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        popover.classList.add('hidden');
      });
    }

    document.addEventListener('click', (e) => {
      if (popover && !popover.classList.contains('hidden') && !e.target.closest('#chat-history-popover') && !e.target.closest('#btn-chat-history-toggle')) {
        popover.classList.add('hidden');
      }
    });
  }

  function wireAppStore() {
    const storeOverlay = $('#store-overlay');
    if (!storeOverlay) return;

    const closeBtn = $('#btn-close-store');
    if (closeBtn) {
      closeBtn.addEventListener('click', () => {
        storeOverlay.classList.add('hidden');
      });
    }

    const allAppsBtn = $('#btn-all-apps');
    if (allAppsBtn) {
      allAppsBtn.addEventListener('click', () => {
        storeOverlay.classList.remove('hidden');
      });
    }

    $$('.pinned-app-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        storeOverlay.classList.remove('hidden');
      });
    });
  }

  /* ═══════════ TAB MANAGEMENT ═══════════ */

  function createTab(url, spaceId = activeSpaceId) {
    const id = genTabId();
    const isNewTab = !url || url === 'bucks://newtab';

    const tab = {
      id,
      title: isNewTab ? 'New Tab' : 'Loading…',
      url: isNewTab ? 'bucks://newtab' : normalizeURL(url),
      webview: null,
      newtabEl: null,
      spaceId: spaceId || activeSpaceId,
    };

    if (isNewTab) {
      // Liquid-glass shell: the home is the always-present `view-home` (dock
      // shell), not a per-tab injected template. Only inject the legacy
      // new-tab template if it still exists.
      const tmpl = $('#newtab-template');
      if (tmpl && tmpl.content) {
        const clone = tmpl.content.cloneNode(true);
        const container = document.createElement('div');
        container.className = 'newtab-container';
        container.dataset.tabId = id;
        container.style.background = 'transparent';
        container.style.position = 'absolute';
        container.style.top = '0';
        container.style.left = '0';
        container.style.width = '100%';
        container.style.height = '100%';
        container.style.display = 'none';
        container.appendChild(clone);
        browserContent.insertBefore(container, walletSidebar);
        tab.newtabEl = container;

        const searchBox = container.querySelector('.newtab-search');
        if (searchBox) searchBox.addEventListener('keydown', (e) => {
          if (e.key === 'Enter' && searchBox.value.trim()) navigateTab(id, searchBox.value.trim());
        });
        container.querySelectorAll('.shortcut-link').forEach((card) => {
          card.addEventListener('click', (e) => {
            e.preventDefault();
            navigateTab(id, card.getAttribute('href'));
          });
        });
      }
      // else: the shell `view-home` is shown — nothing to inject.
    } else {
      createWebview(tab);
    }

    tabs.push(tab);
    renderTabBar();
    setActiveTab(id);
    return id;
  }

  function createWebview(tab) {
    // WebContentsView-backed tab (tab-view.js shim): real Chromium view in the
    // main process, placeholder div in this DOM. Same API surface as <webview>.
    // Private windows isolate browsing in a non-persistent (in-memory) partition.
    const wv = new window.BucksTabView({ partition: IS_PRIVATE ? 'bucks-private' : undefined });
    wv.setAttribute('src', tab.url);
    wv.dataset.tabId = tab.id;

    // Listen for events
    wv.addEventListener('did-start-loading', () => {
      updateTabTitle(tab.id, 'Loading…');
    });

    wv.addEventListener('page-title-updated', (e) => {
      updateTabTitle(tab.id, e.title);
    });

    // Track security status
    wv.addEventListener('did-start-navigation', (e) => {
      if (tab.id === activeTabId) updateSecurityIcon('pending');
    });

    wv.addEventListener('did-navigate', (e) => {
      tab.url = e.url;
      if (tab.id === activeTabId) {
        addressBar.value = e.url;
        updateSecurityIcon(e.url.startsWith('https://') ? 'secure' : 'insecure');
        updateBookmarkIcon(e.url);
      }
      addToHistory(tab.title, e.url);
    });

    wv.addEventListener('did-fail-load', () => {
      if (tab.id === activeTabId) updateSecurityIcon('insecure');
    });

    wv.addEventListener('did-navigate-in-page', (e) => {
      tab.url = e.url;
      if (tab.id === activeTabId) {
        addressBar.value = e.url;
        updateBookmarkIcon(e.url);
      }
      addToHistory(tab.title, e.url);
    });

    wv.addEventListener('new-window', (e) => {
      createTab(e.url);
    });

    wv.addEventListener('found-in-page', (e) => {
      if (tab.id === activeTabId && findBar && !findBar.classList.contains('hidden')) {
        findResults.textContent = `${e.result.activeMatchOrdinal}/${e.result.matches}`;
      }
    });

    browserContent.insertBefore(wv.el, walletSidebar);
    tab.webview = wv;
  }

  function navigateTab(tabId, input) {
    const tab = tabs.find((t) => t.id === tabId);
    if (!tab) return;
    const url = normalizeURL(input);
    tab.url = url;

    // If it was a new-tab page, replace with webview
    if (tab.newtabEl) {
      tab.newtabEl.remove();
      tab.newtabEl = null;
      createWebview(tab);
      tab.webview.setAttribute('src', url);
    } else if (tab.webview) {
      tab.webview.setAttribute('src', url);
    }

    if (tabId === activeTabId) {
      setActiveTab(tabId);
    }
  }

  function closeTab(tabId) {
    const idx = tabs.findIndex((t) => t.id === tabId);
    if (idx === -1) return;
    const tab = tabs[idx];

    // Remove webview or new-tab element
    if (tab.webview) tab.webview.remove();
    if (tab.newtabEl) tab.newtabEl.remove();

    tabs.splice(idx, 1);

    if (tabs.length === 0) {
      createTab(); // Always keep at least one tab
      return;
    }

    if (activeTabId === tabId) {
      const newIdx = Math.min(idx, tabs.length - 1);
      setActiveTab(tabs[newIdx].id);
    }

    renderTabBar();
  }

  function setActiveTab(tabId) {
    activeTabId = tabId;

    // Hide all webviews and newtab pages
    browserContent.querySelectorAll('webview, .webview-host').forEach((wv) => wv.classList.remove('active'));
    browserContent.querySelectorAll('.newtab-container').forEach((el) => el.classList.remove('active'));

    const tab = tabs.find((t) => t.id === tabId);
    if (!tab) return;

    // Auto align activeSpaceId if tab belongs to a different space (e.g. mock tabs or programmatic switch)
    const tabSpaceId = tab.spaceId || 'default';
    if (tabSpaceId !== activeSpaceId) {
      activeSpaceId = tabSpaceId;
      renderSpaceSelector();
    }

    const dashboardWindow = $('#dashboard-window');

    if (tab.webview) {
      tab.webview.classList.add('active');
      addressBar.value = tab.url;
      updateSecurityIcon(tab.url.startsWith('https://') ? 'secure' : 'insecure');
      updateBookmarkIcon(tab.url);
      try { tab.webview.setZoomFactor(zoomFactor); } catch (_) {}
      if (dashboardWindow) {
        dashboardWindow.classList.add('hidden');
      }
      document.body.classList.add('web-mode');
      document.body.classList.remove('files-mode');
    } else if (tab.newtabEl) {
      tab.newtabEl.classList.add('active');
      addressBar.value = '';
      updateSecurityIcon('pending'); // New tab page doesn't have a security status yet
      updateBookmarkIcon('');
      if (dashboardWindow) {
        dashboardWindow.classList.remove('hidden');
        showDashboardView('newtab'); // Auto-switch dashboard view to new tab search hub
      }
      document.body.classList.remove('web-mode');
    }

    if (window.canvasManager) {
      window.canvasManager.onTabChanged(tabId, !!tab.webview);
    }

    renderTabBar();
  }

  function updateTabTitle(tabId, title) {
    const tab = tabs.find((t) => t.id === tabId);
    if (tab) tab.title = title;
    renderTabBar();
  }

  /* ─── Tab bar rendering ─── */
  function renderTabBar() {
    tabsContainer.innerHTML = '';
    
    // Only display tabs belonging to the active Space
    const visibleTabs = tabs.filter(t => (t.spaceId || 'default') === activeSpaceId);
    
    // Auto-create a tab if the active space becomes empty
    if (visibleTabs.length === 0) {
      createTab('bucks://newtab', activeSpaceId);
      return;
    }

    visibleTabs.forEach((tab) => {
      const el = document.createElement('div');
      el.className = `tab${tab.id === activeTabId ? ' active' : ''}`;
      el.innerHTML = `
        <span class="tab-title">${escapeHTML(tab.title)}</span>
        <button class="tab-close" data-tab-id="${tab.id}" title="Close tab">
          <svg width="8" height="8" viewBox="0 0 8 8"><path d="M1 1l6 6M7 1L1 7" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/></svg>
        </button>
      `;
      el.addEventListener('click', (e) => {
        if (!e.target.closest('.tab-close')) setActiveTab(tab.id);
      });
      el.querySelector('.tab-close').addEventListener('click', (e) => {
        e.stopPropagation();
        closeTab(tab.id);
      });
      el.addEventListener('contextmenu', (e) => {
        showTabContextMenu(e, tab.id);
      });
      tabsContainer.appendChild(el);
    });

    // Append new tab '+' button at the end of opened tabs
    const plusBtn = document.createElement('button');
    plusBtn.id = 'tabs-plus-btn';
    plusBtn.title = 'New tab';
    plusBtn.className = 'urlbar-btn';
    plusBtn.style.cssText = 'flex-shrink:0; width:26px; height:26px; border-radius:8px; margin-left:6px; background:rgba(255,255,255,0.06); border:1px solid rgba(255,255,255,0.1); color:#fff; display:flex; align-items:center; justify-content:center; cursor:pointer; transition:background 0.2s;';
    plusBtn.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="M12 5v14M5 12h14"></path></svg>`;
    plusBtn.addEventListener('click', () => createTab());
    plusBtn.addEventListener('mouseover', () => plusBtn.style.background = 'rgba(255,255,255,0.12)');
    plusBtn.addEventListener('mouseout', () => plusBtn.style.background = 'rgba(255,255,255,0.06)');
    tabsContainer.appendChild(plusBtn);

    // Auto-scroll the active tab into view
    const activeEl = tabsContainer.querySelector('.tab.active');
    if (activeEl) {
      activeEl.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'nearest' });
    }
  }

  // Enable horizontal wheel scrolling on the tab bar
  tabsContainer.addEventListener('wheel', (e) => {
    if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) {
      e.preventDefault();
      tabsContainer.scrollLeft += e.deltaY;
    }
  }, { passive: false });

  // ─── Vertical Tabs Slab List ───
  function renderTabsSlabList() {
    const list = document.getElementById('tabs-slab-list');
    if (!list) return;
    list.innerHTML = '';
    
    tabs.forEach((tab) => {
      const item = document.createElement('div');
      const isActive = tab.id === activeTabId;
      item.style.cssText = `
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 8px 10px;
        border-radius: 8px;
        cursor: pointer;
        transition: background 0.15s;
        background: ${isActive ? 'rgba(123, 63, 228, 0.2)' : 'transparent'};
        border: 1px solid ${isActive ? 'rgba(123, 63, 228, 0.35)' : 'transparent'};
      `;
      
      const space = spaces.find(s => s.id === (tab.spaceId || 'default')) || { name: 'General', color: '#52b6ff' };
      
      item.innerHTML = `
        <span style="width: 6px; height: 6px; border-radius: 50%; background: ${space.color}; flex-shrink: 0;" title="Space: ${space.name}"></span>
        <div style="flex: 1; min-width: 0; text-align: left;">
          <div style="font-size: 13px; font-weight: 600; color: #fff; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${escapeHTML(tab.title)}</div>
          <div style="font-size: 10px; color: rgba(255,255,255,0.45); overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${escapeHTML(tab.url || 'bucks://newtab')}</div>
        </div>
        <button class="slab-close-btn" style="background:transparent; border:none; color:rgba(255,255,255,0.4); cursor:pointer; font-size:10px; display:flex; align-items:center; justify-content:center; padding:4px;" title="Close tab">✕</button>
      `;
      
      item.addEventListener('click', (e) => {
        if (!e.target.closest('.slab-close-btn')) {
          setActiveTab(tab.id);
          document.getElementById('tabs-slab-dropdown')?.classList.add('hidden');
        }
      });
      
      item.querySelector('.slab-close-btn').addEventListener('click', (e) => {
        e.stopPropagation();
        closeTab(tab.id);
        renderTabsSlabList(); // refresh
      });
      
      list.appendChild(item);
    });
  }

  // Toggle Tabs Slab Dropdown
  document.getElementById('btn-tabs-slab')?.addEventListener('click', (e) => {
    e.stopPropagation();
    const dropdown = document.getElementById('tabs-slab-dropdown');
    if (!dropdown) return;
    const isHidden = dropdown.classList.contains('hidden');
    
    // Hide other dropdowns
    document.getElementById('space-selector-dropdown')?.classList.add('hidden');
    document.getElementById('more-dropdown-menu')?.classList.add('hidden');
    
    if (isHidden) {
      dropdown.classList.remove('hidden');
      renderTabsSlabList();
    } else {
      dropdown.classList.add('hidden');
    }
  });

  let selectedTabIdForContextMenu = null;

  function showTabContextMenu(e, tabId) {
    e.preventDefault();
    selectedTabIdForContextMenu = tabId;
    
    const menu = $('#tab-context-menu');
    if (!menu) return;
    
    menu.innerHTML = '';
    
    // Sort Options
    const sortTitleItem = document.createElement('div');
    sortTitleItem.className = 'dropdown-item';
    sortTitleItem.style.cssText = `display:flex; align-items:center; gap:8px; padding:8px 10px; border-radius:8px; cursor:pointer; font-size:13px; color:#fff; user-select:none;`;
    sortTitleItem.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg> Sort Tabs by Title`;
    sortTitleItem.addEventListener('click', () => {
      sortTabs('title');
      menu.classList.add('hidden');
    });
    menu.appendChild(sortTitleItem);
    
    const sortUrlItem = document.createElement('div');
    sortUrlItem.className = 'dropdown-item';
    sortUrlItem.style.cssText = `display:flex; align-items:center; gap:8px; padding:8px 10px; border-radius:8px; cursor:pointer; font-size:13px; color:#fff; user-select:none;`;
    sortUrlItem.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg> Sort Tabs by URL`;
    sortUrlItem.addEventListener('click', () => {
      sortTabs('url');
      menu.classList.add('hidden');
    });
    menu.appendChild(sortUrlItem);
    
    // Divider
    const divider = document.createElement('div');
    divider.style.cssText = `height:1px; background:rgba(255,255,255,0.1); margin:4px 0;`;
    menu.appendChild(divider);
    
    // Group / Move to Space Submenu Header
    const moveHeader = document.createElement('div');
    moveHeader.style.cssText = `padding:4px 10px; font-size:10px; font-weight:700; color:rgba(255,255,255,0.4); text-transform:uppercase; letter-spacing:0.04em; user-select:none;`;
    moveHeader.textContent = 'Move to Space';
    menu.appendChild(moveHeader);
    
    // List Spaces
    spaces.forEach(s => {
      const spaceItem = document.createElement('div');
      spaceItem.className = 'dropdown-item';
      spaceItem.style.cssText = `display:flex; align-items:center; gap:8px; padding:8px 10px; border-radius:8px; cursor:pointer; font-size:13px; color:#fff; user-select:none;`;
      
      const tab = tabs.find(t => t.id === tabId);
      if (tab && (tab.spaceId || 'default') === s.id) {
        spaceItem.style.background = 'rgba(255,255,255,0.06)';
        spaceItem.style.fontWeight = '700';
      }
      
      spaceItem.innerHTML = `
        <span style="width:6px; height:6px; border-radius:50%; background:${s.color};"></span>
        <span style="flex:1;">${s.name}</span>
      `;
      spaceItem.addEventListener('click', () => {
        moveTabToSpace(tabId, s.id);
        menu.classList.add('hidden');
      });
      menu.appendChild(spaceItem);
    });
    
    // Divider
    const divider2 = document.createElement('div');
    divider2.style.cssText = `height:1px; background:rgba(255,255,255,0.1); margin:4px 0;`;
    menu.appendChild(divider2);
    
    // Close Option
    const closeItem = document.createElement('div');
    closeItem.className = 'dropdown-item';
    closeItem.style.cssText = `display:flex; align-items:center; gap:8px; padding:8px 10px; border-radius:8px; cursor:pointer; font-size:13px; color:#ff4757; user-select:none;`;
    closeItem.innerHTML = `✕ Close Tab`;
    closeItem.addEventListener('click', () => {
      closeTab(tabId);
      menu.classList.add('hidden');
    });
    menu.appendChild(closeItem);
    
    // Position menu with boundary safety
    const menuWidth = 180;
    const menuHeight = 220; // approximate height including spaces
    let x = e.clientX;
    let y = e.clientY;
    
    if (x + menuWidth > window.innerWidth) {
      x = window.innerWidth - menuWidth - 10;
    }
    if (y + menuHeight > window.innerHeight) {
      y = window.innerHeight - menuHeight - 10;
    }
    
    menu.style.left = `${x}px`;
    menu.style.top = `${y}px`;
    menu.classList.remove('hidden');
  }

  function moveTabToSpace(tabId, spaceId) {
    const tab = tabs.find(t => t.id === tabId);
    if (!tab) return;
    
    tab.spaceId = spaceId;
    
    // Hide its webview if we are moving it away from current active space
    if (spaceId !== activeSpaceId && tab.webview) {
      tab.webview.classList.remove('active');
    }
    
    // If the moved tab was the active tab, we need to switch active tab to another tab in this space
    if (tabId === activeTabId) {
      const visibleTabs = tabs.filter(t => (t.spaceId || 'default') === activeSpaceId);
      if (visibleTabs.length > 0) {
        setActiveTab(visibleTabs[0].id);
      } else {
        createTab('bucks://newtab', activeSpaceId);
      }
    } else {
      renderTabBar();
    }
    
    if (document.getElementById('view-spaces') && !document.getElementById('view-spaces').classList.contains('hidden')) {
      renderSpacesView();
    }
    showToast(`Moved tab to ${spaces.find(s => s.id === spaceId).name}`, 'info');
  }

  function sortTabs(by) {
    const spaceTabs = tabs.filter(t => (t.spaceId || 'default') === activeSpaceId);
    if (by === 'title') {
      spaceTabs.sort((a, b) => a.title.localeCompare(b.title));
    } else if (by === 'url') {
      spaceTabs.sort((a, b) => {
        const urlA = a.url || '';
        const urlB = b.url || '';
        return urlA.localeCompare(urlB);
      });
    }

    // Put them back in the tabs array in the sorted order
    let spaceTabIdx = 0;
    tabs = tabs.map(t => {
      if ((t.spaceId || 'default') === activeSpaceId) {
        return spaceTabs[spaceTabIdx++];
      }
      return t;
    });

    renderTabBar();
    if (document.getElementById('view-spaces') && !document.getElementById('view-spaces').classList.contains('hidden')) {
      renderSpacesView();
    }
    showToast(`Sorted tabs by ${by}`, 'info');
  }

  function renderSpaceSelector() {
    const nameEl = $('#space-selector-name');
    const dotEl = $('#space-selector-dot');
    const dropdownEl = $('#space-selector-dropdown');
    
    const activeSpace = spaces.find(s => s.id === activeSpaceId) || spaces[0];
    if (nameEl) nameEl.textContent = activeSpace.name;
    if (dotEl) {
      dotEl.style.background = activeSpace.color;
      dotEl.style.boxShadow = `0 0 8px ${activeSpace.color}`;
    }
    
    if (dropdownEl) {
      dropdownEl.innerHTML = '';
      spaces.forEach(s => {
        const item = document.createElement('div');
        item.className = 'dropdown-item';
        item.style.cssText = `display:flex; align-items:center; gap:8px; padding:8px 10px; border-radius:8px; cursor:pointer; font-size:13px; color:#fff; user-select:none;`;
        if (s.id === activeSpaceId) {
          item.style.background = 'rgba(255,255,255,0.08)';
          item.style.fontWeight = '700';
        }
        item.innerHTML = `
          <span style="width:8px; height:8px; border-radius:50%; background:${s.color}; box-shadow:0 0 6px ${s.color};"></span>
          <span style="flex:1;">${s.name}</span>
        `;
        item.addEventListener('click', (e) => {
          e.stopPropagation();
          switchSpace(s.id);
          dropdownEl.classList.add('hidden');
        });
        dropdownEl.appendChild(item);
      });
    }
  }

  function switchSpace(spaceId) {
    activeSpaceId = spaceId;
    
    // Hide all webviews first
    browserContent.querySelectorAll('webview, .webview-host').forEach(wv => wv.classList.remove('active'));
    
    // Get visible tabs in the target space
    const visibleTabs = tabs.filter(t => (t.spaceId || 'default') === activeSpaceId);
    if (visibleTabs.length === 0) {
      createTab('bucks://newtab', activeSpaceId);
    } else {
      const activeTab = visibleTabs.find(t => t.id === activeTabId) || visibleTabs[0];
      setActiveTab(activeTab.id);
    }
    
    renderSpaceSelector();
    renderTabBar();
    
    if (document.getElementById('view-spaces') && !document.getElementById('view-spaces').classList.contains('hidden')) {
      renderSpacesView();
    }
  }

  function renderSpacesView() {
    const listContainer = $('#spaces-list-container');
    if (!listContainer) return;
    
    listContainer.innerHTML = '';
    
    spaces.forEach(s => {
      const spaceTabs = tabs.filter(t => (t.spaceId || 'default') === s.id);
      const card = document.createElement('div');
      card.style.cssText = `padding:18px; border-radius:18px; background:rgba(255,255,255,0.06); border:1px solid rgba(255,255,255,0.1); cursor:pointer; transition: transform 0.2s, background 0.2s;`;
      
      card.addEventListener('mouseenter', () => {
        card.style.transform = 'translateY(-2px)';
        card.style.background = 'rgba(255,255,255,0.09)';
        card.style.borderColor = 'rgba(255,255,255,0.18)';
      });
      card.addEventListener('mouseleave', () => {
        card.style.transform = 'translateY(0)';
        card.style.background = 'rgba(255,255,255,0.06)';
        card.style.borderColor = 'rgba(255,255,255,0.1)';
      });
      
      const header = document.createElement('div');
      header.style.cssText = `display:flex; align-items:center; gap:9px; margin-bottom:14px;`;
      header.innerHTML = `
        <span style="width:10px; height:10px; border-radius:50%; background:${s.color}; box-shadow:0 0 8px ${s.color};"></span>
        <span style="font-size:16px; font-weight:700; user-select:none;">${s.name}</span>
        <span style="margin-left:auto; font-size:12.5px; color:rgba(255,255,255,0.5); user-select:none;">${spaceTabs.length} tab${spaceTabs.length === 1 ? '' : 's'}</span>
      `;
      card.appendChild(header);
      
      const tabsList = document.createElement('div');
      tabsList.style.cssText = `display:flex; flex-direction:column; gap:8px;`;
      
      if (spaceTabs.length === 0) {
        tabsList.innerHTML = `<div style="font-size:13px; color:rgba(255,255,255,0.3); font-style:italic; user-select:none;">No active tabs</div>`;
      } else {
        spaceTabs.forEach(t => {
          const tabRow = document.createElement('div');
          tabRow.style.cssText = `display:flex; align-items:center; gap:11px; cursor:pointer; padding:4px 6px; border-radius:6px; transition: background 0.15s;`;
          tabRow.addEventListener('mouseenter', () => { tabRow.style.background = 'rgba(255,255,255,0.05)'; });
          tabRow.addEventListener('mouseleave', () => { tabRow.style.background = 'transparent'; });
          
          const firstLetter = (t.title || 'N').charAt(0).toUpperCase();
          tabRow.innerHTML = `
            <span style="font-size:12px; font-weight:700; width:18px; height:18px; border-radius:50%; background:rgba(255,255,255,0.1); display:flex; align-items:center; justify-content:center; opacity:0.7;">${firstLetter}</span>
            <span style="flex:1; min-width:0; font-size:13.5px; color:rgba(255,255,255,0.85); white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">${escapeHTML(t.title)}</span>
          `;
          
          tabRow.addEventListener('click', (e) => {
            e.stopPropagation();
            switchSpace(s.id);
            setActiveTab(t.id);
            if (t.webview) {
              $('#dashboard-window')?.classList.add('hidden');
            }
          });
          
          tabsList.appendChild(tabRow);
        });
      }
      
      card.appendChild(tabsList);
      
      card.addEventListener('click', () => {
        switchSpace(s.id);
      });
      
      listContainer.appendChild(card);
    });
  }

  function wireNewTabEvents() {
    $('#newtab-btn-home')?.addEventListener('click', () => showDashboardView('home'));
    $('#newtab-btn-spaces')?.addEventListener('click', () => showDashboardView('spaces'));
    $('#newtab-btn-wallet')?.addEventListener('click', () => showDashboardView('wallet'));
    
    $('#newtab-btn-ipfs')?.addEventListener('click', () => {
      const activeTab = tabs.find(t => t.id === activeTabId);
      if (activeTab && activeTab.webview) {
        const ipfsSidebar = document.getElementById('ipfs-sidebar');
        if (ipfsSidebar) {
          ipfsSidebar.classList.remove('sidebar-hidden');
          refreshIPFSStatus();
          refreshIPFSFeed();
        }
      } else {
        showDashboardView('ipfs');
      }
    });

    $('#newtab-btn-history')?.addEventListener('click', () => showDashboardView('history'));
    $('#newtab-btn-settings')?.addEventListener('click', () => showDashboardView('settings'));
  }

  function escapeHTML(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  function updateSecurityIcon(status) {
    const icon = $('#security-icon');
    if (status === 'secure') {
      icon.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--success)" stroke-width="2.5"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>`;
      icon.title = 'Connection is secure';
    } else if (status === 'pending') {
      icon.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--text-muted)" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/></svg>`;
      icon.title = 'Loading...';
    } else {
      icon.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--danger)" stroke-width="2.5"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>`;
      icon.title = 'Connection is not secure';
    }
  }

  if ($('#btn-adblock')) $('#btn-adblock').onclick = async () => {
    const count = await window.bucksAPI.getBlockedCount();
    alert(`Bucks Privacy Report\n\nBlocked Trackers & Ads: ${count}\n\nYour browsing is being shielded.`);
  };

  function showToast(text, type = 'info') {
    const container = $('#toast-container') || (() => {
      const c = document.createElement('div');
      c.id = 'toast-container';
      document.body.appendChild(c);
      return c;
    })();

    const toast = document.createElement('div');
    toast.className = `toast glass-panel toast-${type} fade-in`;
    toast.innerHTML = `
      <div class="toast-content">
        <span class="toast-icon">${type === 'success' ? '✅' : type === 'error' ? '❌' : 'ℹ️'}</span>
        <span class="toast-text">${text}</span>
      </div>
    `;

    container.appendChild(toast);

    setTimeout(() => {
      toast.classList.add('fade-out');
      setTimeout(() => toast.remove(), 400);
    }, 3000);
  }

  /* ═══════════ BROWSING HISTORY ═══════════ */
  let browsingHistory = [];
  function addToHistory(title, url) {
    if (IS_PRIVATE) return; // incognito: no history persistence
    if (!url || url.startsWith('bucks://')) return;
    const item = { title: title || url, url, timestamp: Date.now() };
    browsingHistory.unshift(item);
    if (browsingHistory.length > 500) browsingHistory.length = 500;
    renderHistory();
  }

  function renderHistory() {
    const containers = document.querySelectorAll('#history-list-container, #history-list-sidebar-container');
    containers.forEach(container => {
      if (!container) return;
      if (browsingHistory.length === 0) {
        container.innerHTML = '<p class="muted" style="text-align:center; margin-top: 20px;">No history yet.</p>';
        return;
      }

      container.innerHTML = browsingHistory.map(item => {
        const time = new Date(item.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        return `
          <div class="history-item" data-url="${escapeHTML(item.url)}">
            <div class="history-item-time">${time}</div>
            <div class="history-item-details">
              <div class="history-item-title">${escapeHTML(item.title)}</div>
              <div class="history-item-url">${escapeHTML(item.url)}</div>
            </div>
          </div>
        `;
      }).join('');
    });
  }

  // Handle clicking history items to open them for both containers
  document.addEventListener('click', (e) => {
    const container = e.target.closest('#history-list-container, #history-list-sidebar-container');
    if (container) {
      const item = e.target.closest('.history-item');
      if (item && item.dataset.url) {
        createTab(item.dataset.url);
      }
    }
  });

  /* ═══════════ BOOKMARKS MANAGER ═══════════ */
  let bookmarks = [];
  try {
    const stored = localStorage.getItem('bucks_bookmarks');
    if (stored) bookmarks = JSON.parse(stored);
  } catch (e) { console.error('Error loading bookmarks', e); }

  function saveBookmarks() {
    localStorage.setItem('bucks_bookmarks', JSON.stringify(bookmarks));
    renderBookmarks();
  }

  function toggleBookmark() {
    const tab = tabs.find(t => t.id === activeTabId);
    if (!tab || tab.url.startsWith('bucks://') || !tab.url) return;

    const existingIdx = bookmarks.findIndex(b => b.url === tab.url);
    if (existingIdx !== -1) {
      bookmarks.splice(existingIdx, 1);
      btnBookmark?.classList.remove('bookmark-active');
      showToast('Removed from bookmarks');
    } else {
      bookmarks.push({ title: tab.title || tab.url, url: tab.url, timestamp: Date.now() });
      btnBookmark?.classList.add('bookmark-active');
      showToast('Added to bookmarks');
    }
    saveBookmarks();
  }

  function updateBookmarkIcon(url) {
    if (!btnBookmark) return;
    if (url && bookmarks.some(b => b.url === url)) {
      btnBookmark.classList.add('bookmark-active');
    } else {
      btnBookmark.classList.remove('bookmark-active');
    }
  }

  function renderBookmarks() {
    const containers = document.querySelectorAll('#bookmarks-list-container, #bookmarks-list-sidebar-container');
    containers.forEach(container => {
      if (!container) return;
      if (bookmarks.length === 0) {
        container.innerHTML = '<p class="muted" style="text-align:center; margin-top: 20px;">No bookmarks yet.</p>';
        return;
      }

      container.innerHTML = [...bookmarks].reverse().map(item => {
        return `
          <div class="history-item" data-url="${escapeHTML(item.url)}">
            <div class="history-item-details">
              <div class="history-item-title">${escapeHTML(item.title)}</div>
              <div class="history-item-url">${escapeHTML(item.url)}</div>
            </div>
            <button class="icon-btn remove-bookmark" title="Remove" data-url="${escapeHTML(item.url)}">
               <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 6L6 18M6 6l12 12"/></svg>
            </button>
          </div>
        `;
      }).join('');
    });
  }

  document.addEventListener('click', (e) => {
    const container = e.target.closest('#bookmarks-list-container, #bookmarks-list-sidebar-container');
    if (container) {
      const removeBtn = e.target.closest('.remove-bookmark');
      if (removeBtn) {
        const urlToRemove = removeBtn.dataset.url;
        bookmarks = bookmarks.filter(b => b.url !== urlToRemove);
        saveBookmarks();
        updateBookmarkIcon(addressBar.value);
        return;
      }
      const item = e.target.closest('.history-item');
      if (item && item.dataset.url) {
        createTab(item.dataset.url);
      }
    }
  });

  btnBookmark?.addEventListener('click', toggleBookmark);

  /* ═══════════ DOWNLOAD MANAGER ═══════════ */
  function fmtBytes(n) {
    if (!n || n < 0) return '';
    const u = ['B', 'KB', 'MB', 'GB'];
    let i = 0;
    while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
    return `${n.toFixed(i ? 1 : 0)} ${u[i]}`;
  }

  function renderDownloads() {
    const container = $('#downloads-list-container');
    if (!container) return;
    if (downloads.length === 0) {
      container.innerHTML = '<p class="muted" style="text-align:center; margin-top: 20px;">No downloads yet.</p>';
      return;
    }
    container.innerHTML = downloads.map((d, i) => {
      const pct = d.totalBytes > 0 ? Math.min(100, Math.round((d.receivedBytes / d.totalBytes) * 100)) : 0;
      const done = d.state === 'completed';
      const failed = d.state === 'cancelled' || d.state === 'interrupted';
      const statusLine = done
        ? `<span style="color:#8affc1;">Completed</span> · ${fmtBytes(d.totalBytes)}`
        : failed
          ? `<span style="color:#ff8a8a;">${escapeHTML(d.state)}</span>`
          : `${fmtBytes(d.receivedBytes)}${d.totalBytes > 0 ? ' / ' + fmtBytes(d.totalBytes) : ''}`;
      const bar = (!done && !failed)
        ? `<div style="height:4px; background:rgba(255,255,255,0.16); border-radius:2px; overflow:hidden; margin-top:6px;"><div style="width:${pct}%; height:100%; background:#fff;"></div></div>`
        : '';
      const action = done && d.savePath
        ? `<button class="dl-show" data-i="${i}" style="background:rgba(255,255,255,0.08); border:none; color:#fff; cursor:pointer; font-size:11px; padding:5px 9px; border-radius:7px;">Show in folder</button>`
        : '';
      return `
        <div style="padding:12px; border-radius:12px; background:rgba(255,255,255,0.04); border:1px solid rgba(255,255,255,0.08); margin-bottom:10px;">
          <div style="display:flex; justify-content:space-between; align-items:center; gap:8px;">
            <div style="min-width:0;">
              <div style="font-size:13px; font-weight:600; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">${escapeHTML(d.fileName)}</div>
              <div style="font-size:11px; color:rgba(255,255,255,0.55); margin-top:2px;">${statusLine}</div>
            </div>
            ${action}
          </div>
          ${bar}
        </div>`;
    }).join('');
    container.querySelectorAll('.dl-show').forEach(btn => {
      btn.addEventListener('click', () => {
        const d = downloads[+btn.dataset.i];
        if (d?.savePath) window.bucksAPI.showDownloadInFolder(d.savePath);
      });
    });
  }

  window.bucksAPI.onDownloadEvent((data) => {
    if (data.type === 'start') {
      downloads.unshift({ fileName: data.fileName, url: data.url, receivedBytes: 0, totalBytes: data.totalBytes || 0, state: 'progressing', savePath: null });
      if (downloads.length > 100) downloads.length = 100;
      showToast(`Started downloading: ${data.fileName}`);
    } else if (data.type === 'progress') {
      const d = downloads.find(x => x.fileName === data.fileName && x.state === 'progressing');
      if (d) { d.receivedBytes = data.receivedBytes; if (data.totalBytes) d.totalBytes = data.totalBytes; }
    } else if (data.type === 'done') {
      const d = downloads.find(x => x.fileName === data.fileName && x.state === 'progressing');
      if (d) { d.state = data.state; d.savePath = data.savePath || null; if (data.totalBytes) { d.totalBytes = data.totalBytes; d.receivedBytes = data.totalBytes; } }
      if (data.state === 'completed') {
        showToast(`✅ Download complete: ${data.fileName}`, 'success');
      } else {
        showToast(`❌ Download ${data.state}: ${data.fileName}`, 'error');
      }
    }
    renderDownloads();
  });

  /* ═══════════ ZOOM & PRINT ═══════════ */
  function applyZoom(factor) {
    zoomFactor = Math.max(0.25, Math.min(3, Math.round(factor * 100) / 100));
    const tab = tabs.find(t => t.id === activeTabId);
    if (tab?.webview) {
      try { tab.webview.setZoomFactor(zoomFactor); } catch (_) {}
    }
    const label = $('#zoom-level');
    if (label) label.textContent = `${Math.round(zoomFactor * 100)}%`;
    showToast(`Zoom: ${Math.round(zoomFactor * 100)}%`);
  }

  function printActiveTab() {
    const tab = tabs.find(t => t.id === activeTabId);
    if (tab?.webview) {
      try { tab.webview.print(); } catch (e) { showToast('Unable to print this page', 'error'); }
    } else {
      showToast('Open a page to print', 'error');
    }
  }

  /* ═══════════ NAVIGATION CONTROLS ═══════════ */

  // Dashboard view navigation history
  const dashboardHistory = ['newtab'];
  let dashboardHistoryIndex = 0;
  let isNavigatingDashboardHistory = false;

  function goBackDashboard() {
    if (dashboardHistoryIndex > 0) {
      dashboardHistoryIndex--;
      isNavigatingDashboardHistory = true;
      showDashboardView(dashboardHistory[dashboardHistoryIndex]);
      isNavigatingDashboardHistory = false;
    }
  }

  function goForwardDashboard() {
    if (dashboardHistoryIndex < dashboardHistory.length - 1) {
      dashboardHistoryIndex++;
      isNavigatingDashboardHistory = true;
      showDashboardView(dashboardHistory[dashboardHistoryIndex]);
      isNavigatingDashboardHistory = false;
    }
  }

  $('#btn-back')?.addEventListener('click', () => {
    const tab = tabs.find((t) => t.id === activeTabId);
    const inWebMode = document.body.classList.contains('web-mode');
    if (inWebMode && tab?.webview && typeof tab.webview.canGoBack === 'function' && tab.webview.canGoBack()) {
      tab.webview.goBack();
    } else {
      goBackDashboard();
    }
  });

  $('#btn-forward')?.addEventListener('click', () => {
    const tab = tabs.find((t) => t.id === activeTabId);
    const inWebMode = document.body.classList.contains('web-mode');
    if (inWebMode && tab?.webview && typeof tab.webview.canGoForward === 'function' && tab.webview.canGoForward()) {
      tab.webview.goForward();
    } else {
      goForwardDashboard();
    }
  });

  $('#btn-refresh')?.addEventListener('click', () => {
    const tab = tabs.find((t) => t.id === activeTabId);
    if (tab?.webview) tab.webview.reload();
  });

  // Address bar (Omnibox)
  let suggestionIndex = -1;
  let currentSuggestions = [];

  addressBar.addEventListener('input', handleOmniboxInput);
  addressBar.addEventListener('focus', () => {
    addressBar.select();
    handleOmniboxInput();
  });
  addressBar.addEventListener('blur', () => {
    setTimeout(() => omniboxDropdown.classList.add('hidden'), 150);
  });
  addressBar.addEventListener('keydown', handleOmniboxKeydown);

  async function handleOmniboxInput() {
    const query = addressBar.value.trim().toLowerCase();
    suggestionIndex = -1;

    let results = [];
    if (!query) {
      results = [...bookmarks.slice(0, 5), ...browsingHistory.slice(0, 5)];
    } else {
      let dwebRes = [];
      try {
        const rawDweb = await window.bucksAPI.ipfsSearchDweb(query);
        dwebRes = rawDweb.map(item => ({
          title: item.title || item.name,
          url: `ipfs://${item.cid}`,
          type: 'dweb'
        }));
      } catch (e) {
        console.error('[Omnibox] dWeb search failed:', e);
      }

      const bRes = bookmarks.filter(b => b.title.toLowerCase().includes(query) || b.url.toLowerCase().includes(query)).map(b => ({ ...b, type: 'bookmark' }));
      const urls = new Set(bRes.map(b => b.url));
      
      const hRes = browsingHistory.filter(h => {
        if (urls.has(h.url) || (!h.title.toLowerCase().includes(query) && !h.url.toLowerCase().includes(query))) return false;
        urls.add(h.url);
        return true;
      }).map(h => ({ ...h, type: 'history' }));
      
      results = [...dwebRes, ...bRes, ...hRes].slice(0, 8);
    }

    if (!query) {
      const unique = [];
      const set = new Set();
      results.forEach(r => {
        if (!set.has(r.url)) {
          set.add(r.url);
          unique.push(r);
        }
      });
      results = unique.slice(0, 8);
    }

    currentSuggestions = results;
    renderOmniboxSuggestions();
  }

  function renderOmniboxSuggestions() {
    if (currentSuggestions.length === 0) {
      omniboxDropdown.classList.add('hidden');
      return;
    }

    omniboxDropdown.innerHTML = currentSuggestions.map((item, idx) => {
      const isBookmark = bookmarks.some(b => b.url === item.url);
      const isDweb = item.type === 'dweb';
      const icon = isDweb ?
        `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="16 18 22 12 16 6"></polyline><polyline points="8 6 2 12 8 18"></polyline></svg>` :
        isBookmark ?
        `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" class="bookmark-active" stroke="currentColor" stroke-width="2"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" /></svg>` :
        `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>`;

      return `
        <div class="omnibox-suggestion ${idx === suggestionIndex ? 'selected' : ''}" data-url="${escapeHTML(item.url)}">
          <div class="omnibox-suggestion-icon" ${isDweb || isBookmark ? 'style="color: var(--accent);"' : ''}>${icon}</div>
          <div class="omnibox-suggestion-content">
            <div class="omnibox-suggestion-title">${escapeHTML(item.title)}</div>
            <div class="omnibox-suggestion-url">${escapeHTML(item.url)}</div>
          </div>
        </div>
      `;
    }).join('');

    omniboxDropdown.classList.remove('hidden');
  }

  function handleOmniboxKeydown(e) {
    if (currentSuggestions.length === 0 || omniboxDropdown.classList.contains('hidden')) {
      if (e.key === 'Enter' && addressBar.value.trim()) {
        const val = addressBar.value.trim();
        if (!isURL(val)) {
          sendChat(val);
        } else {
          navigateTab(activeTabId, val);
        }
        omniboxDropdown.classList.add('hidden');
        addressBar.blur();
      }
      return;
    }

    if (e.key === 'ArrowDown') {
      e.preventDefault();
      suggestionIndex = (suggestionIndex + 1) % currentSuggestions.length;
      renderOmniboxSuggestions();
      addressBar.value = currentSuggestions[suggestionIndex].url;
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      suggestionIndex = (suggestionIndex - 1 + currentSuggestions.length) % currentSuggestions.length;
      renderOmniboxSuggestions();
      addressBar.value = currentSuggestions[suggestionIndex].url;
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const targetUrl = suggestionIndex >= 0 ? currentSuggestions[suggestionIndex].url : addressBar.value.trim();
      if (targetUrl) {
        if (!isURL(targetUrl)) {
          sendChat(targetUrl);
        } else {
          navigateTab(activeTabId, targetUrl);
        }
        addressBar.blur();
        omniboxDropdown.classList.add('hidden');
      }
    }
  }

  omniboxDropdown.addEventListener('mousedown', (e) => {
    const item = e.target.closest('.omnibox-suggestion');
    if (item && item.dataset.url) {
      e.preventDefault();
      navigateTab(activeTabId, item.dataset.url);
      omniboxDropdown.classList.add('hidden');
    }
  });

  /* ═══════════ FIND IN PAGE ═══════════ */
  window.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') {
      const tab = tabs.find(t => t.id === activeTabId);
      if (tab && tab.webview) {
        findBar.classList.remove('hidden');
        findInput.focus();
        findInput.select();
      }
    }
    if (e.key === 'Escape' && !findBar.classList.contains('hidden')) {
      closeFindBar();
    }
  });

  function closeFindBar() {
    findBar.classList.add('hidden');
    const tab = tabs.find(t => t.id === activeTabId);
    if (tab && tab.webview) {
      tab.webview.stopFindInPage('clearSelection');
    }
  }

  $('#btn-find-close')?.addEventListener('click', closeFindBar);

  findInput?.addEventListener('input', (e) => {
    const query = e.target.value;
    const tab = tabs.find(t => t.id === activeTabId);
    if (!tab || !tab.webview) return;

    if (query) {
      tab.webview.findInPage(query);
    } else {
      tab.webview.stopFindInPage('clearSelection');
      findResults.textContent = '0/0';
    }
  });

  findInput?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      const tab = tabs.find(t => t.id === activeTabId);
      if (tab && tab.webview && findInput.value) {
        tab.webview.findInPage(findInput.value, { forward: !e.shiftKey, findNext: true });
      }
    }
  });

  $('#btn-find-next')?.addEventListener('click', () => {
    const tab = tabs.find(t => t.id === activeTabId);
    if (tab && tab.webview && findInput.value) {
      tab.webview.findInPage(findInput.value, { forward: true, findNext: true });
    }
  });

  $('#btn-find-prev')?.addEventListener('click', () => {
    const tab = tabs.find(t => t.id === activeTabId);
    if (tab && tab.webview && findInput.value) {
      tab.webview.findInPage(findInput.value, { forward: false, findNext: true });
    }
  });

  // New tab button
  $('#btn-new-tab')?.addEventListener('click', () => createTab());

  /* ═══════════ VERTICAL SIDEBAR CONTROLS ═══════════ */
  function updateSidebarNav(activeId) {
    $$('.vertical-sidebar .nav-item').forEach(btn => btn.classList.remove('active'));
    if (activeId) $(`#${activeId}`)?.classList.add('active');
  }

  function showDashboardView(viewName) {
    if (viewName === 'home') {
      viewName = 'newtab';
    }

    if (viewName === 'newtab') {
      const pendingTransfer = localStorage.getItem('pending-chat-transfer');
      if (pendingTransfer) {
        localStorage.removeItem('pending-chat-transfer');
        try {
          const messages = JSON.parse(pendingTransfer);
          if (Array.isArray(messages) && messages.length) {
            const id = createChatThread('Chat');
            const thread = chatTabThreads[id];
            if (thread) {
              thread.messages = messages.map(m => {
                if (m.role === 'component') return { role: 'component', ui: m.ui };
                return { role: m.role === 'user' ? 'user' : 'assistant', text: m.text || '' };
              });
              const firstUser = thread.messages.find(m => m.role === 'user');
              if (firstUser) {
                thread.title = firstUser.text.slice(0, 42) + (firstUser.text.length > 42 ? '…' : '');
                persistRename(id, thread.title);
              }
              thread.messages.forEach(m => {
                if (m.role === 'component') persistMessage(id, 'component', JSON.stringify(m.ui));
                else persistMessage(id, m.role, m.text);
              });
            }
            viewName = 'chat-tab';
            chatTabActiveThread = id;
            setTimeout(() => {
              renderChatTabHistory();
              renderChatTabMessages();
            }, 50);
          }
        } catch (e) {
          console.error('[Chat Transfer] Failed to load carried-over chat:', e);
        }
      }
    }

    // Manage dashboard history
    if (!isNavigatingDashboardHistory) {
      dashboardHistory.splice(dashboardHistoryIndex + 1);
      if (dashboardHistory[dashboardHistory.length - 1] !== viewName) {
        dashboardHistory.push(viewName);
        dashboardHistoryIndex = dashboardHistory.length - 1;
      }
    }

    // The Ephemeral UI response zone is scoped to the Home/New Tab dashboard —
    // return the shared chat panel to its default (undocked) home before
    // showing any other view, so it doesn't get stranded inside a hidden view.
    if (viewName !== 'newtab' && viewName !== 'home') {
      undockChatPanel();
      if (window.BucksEarthMap && window.BucksEarthMap.isOpen()) {
        window.BucksEarthMap.close();
      }
    }

    // Home and New Tab are the same Agentic-UI dashboard (search + dock +
    // status zones) — #view-home has no content of its own.
    const resolvedViewName = viewName === 'home' ? 'newtab' : viewName;

    if (resolvedViewName === 'newtab') {
      document.body.classList.add('dock-collapsed');
    } else {
      document.body.classList.remove('dock-collapsed', 'dock-expanded');
    }

    // Hide all views, show target view
    const views = document.querySelectorAll('.dashboard-view');
    views.forEach(v => v.classList.add('hidden'));
    const target = document.getElementById(`view-${resolvedViewName}`);
    if (target) {
      target.classList.remove('hidden');
      if (viewName === 'chat-tab') {
        addressBar.value = 'bucks://chat';
        updateSecurityIcon('secure');
        populateNavChatModels();
      } else if (viewName === 'newtab') {
        addressBar.value = '';
        updateSecurityIcon('pending');
      } else if (['files', 'studio', 'spaces', 'history', 'bookmarks', 'settings', 'wallet', 'ipfs'].includes(viewName)) {
        addressBar.value = 'bucks://' + viewName;
        updateSecurityIcon('secure');
      }
      if (viewName === 'files') {
        const wv = document.getElementById('bucks-files-webview');
        if (wv) {
          try {
            wv.reload();
          } catch (e) {
            console.error('[Webview] Reload failed:', e);
          }
        }
      } else if (viewName === 'studio') {
        const wv = document.getElementById('bucks-studio-webview');
        if (wv) {
          try {
            if (typeof wv.reload === 'function') {
              wv.reload();
            } else {
              wv.src = wv.src;
            }
          } catch (e) {
            console.error('[Webview] Studio Reload failed:', e);
          }
        }
      }
    }

    // Files mode overrides removed - layout remains static across all views.
    document.body.classList.remove('files-mode');

    // Dynamic width expansion for wide layouts (Files / Chat Tab / Studio)
    const dashboardWindow = document.getElementById('dashboard-window');
    if (dashboardWindow) {
      if (viewName === 'files' || viewName === 'chat-tab' || viewName === 'studio' || viewName === 'messages') {
        dashboardWindow.style.maxWidth = 'calc(100% - 80px)';
        dashboardWindow.style.width = '100%';
        // Fill the viewport so the full-screen chat/files/studio views get a
        // real height (composer pinned to the bottom, messages scroll) instead
        // of collapsing to content height and clipping.
        dashboardWindow.style.height = '100%';
      } else {
        dashboardWindow.style.maxWidth = '880px';
        dashboardWindow.style.height = '';
      }
    }

    const ntSearchInput = document.getElementById('nt-search-input');
    if (ntSearchInput) {
      if (viewName === 'chat-tab') {
        ntSearchInput.placeholder = "Message the agent…  (or /agent <task> to act on this tab)";
      } else {
        ntSearchInput.placeholder = "Ask Bucks, search the web, or find a place — try “Mysore” or “Bangalore to Mysore”";
      }
    }

    // Update left dock buttons active class
    document.querySelectorAll('.left-dock .dock-btn').forEach(btn => btn.classList.remove('active'));
    let btnId = `nav-${viewName}`;
    if (viewName === 'home') btnId = 'nav-dashboard';
    else if (viewName === 'wallet') btnId = 'nav-wallet-side';
    else if (viewName === 'ipfs') btnId = 'nav-explore';
    else if (viewName === 'files') btnId = 'nav-files';
    else if (viewName === 'studio') btnId = 'nav-studio';
    else if (viewName === 'chat-tab') btnId = null; // no dock btn for chat tab
    const btn = btnId ? document.getElementById(btnId) : null;
    if (btn) btn.classList.add('active');

    // Handle context: ensure active tab is newtab
    const activeTab = tabs.find(t => t.id === activeTabId);
    if (activeTab && activeTab.webview) {
      // Switch to the first newtab, or create one inside the active space
      const newtab = tabs.find(t => t.newtabEl && (t.spaceId || 'default') === activeSpaceId);
      if (newtab) {
        setActiveTab(newtab.id);
      } else {
        createTab('bucks://newtab', activeSpaceId);
      }
      // Re-trigger the target view since setActiveTab overrides it to 'newtab'
      showDashboardView(viewName);
      return;
    }

    // Trigger loads/refreshes
    if (viewName === 'history') {
      renderHistory();
    } else if (viewName === 'bookmarks') {
      renderBookmarks();
    } else if (viewName === 'wallet') {
      refreshWallet();
    } else if (viewName === 'ipfs') {
      refreshIPFSStatus();
      refreshIPFSFeed();
    } else if (viewName === 'spaces') {
      renderSpacesView();
    } else if (viewName === 'settings') {
      try { loadSettings(); } catch (_) {}
    }
  }

  // Bind Left Dock events
  $('#nav-dashboard')?.addEventListener('click', () => showDashboardView('home'));
  $('#nav-wallet-side')?.addEventListener('click', () => {
    const activeTab = tabs.find(t => t.id === activeTabId);
    if (activeTab && activeTab.webview) {
      toggleSidebar('wallet');
    } else {
      showDashboardView('wallet');
    }
  });
  $('#nav-explore')?.addEventListener('click', () => {
    const activeTab = tabs.find(t => t.id === activeTabId);
    if (activeTab && activeTab.webview) {
      const ipfsSidebar = document.getElementById('ipfs-sidebar');
      if (ipfsSidebar) {
        const isHidden = ipfsSidebar.classList.contains('sidebar-hidden');
        if (isHidden) {
          ipfsSidebar.classList.remove('sidebar-hidden');
          document.getElementById('wallet-sidebar')?.classList.add('sidebar-hidden');
          document.getElementById('settings-panel')?.classList.add('sidebar-hidden');
          refreshIPFSStatus();
          refreshIPFSFeed();
        } else {
          ipfsSidebar.classList.add('sidebar-hidden');
        }
      }
    } else {
      showDashboardView('ipfs');
    }
  });
  $('#nav-spaces')?.addEventListener('click', () => showDashboardView('spaces'));
  $('#nav-files')?.addEventListener('click', () => showDashboardView('files'));
  $('#nav-messages')?.addEventListener('click', () => showDashboardView('messages'));
  $('#nav-studio')?.addEventListener('click', () => showDashboardView('studio'));
  
  $('#nav-apps')?.addEventListener('click', () => {
    document.getElementById('store-overlay')?.classList.remove('hidden');
  });

  $('#nav-history')?.addEventListener('click', () => {
    const activeTab = tabs.find(t => t.id === activeTabId);
    if (activeTab && activeTab.webview) {
      toggleSidebar('history');
    } else {
      showDashboardView('history');
    }
  });

  $('#nav-bookmarks')?.addEventListener('click', () => {
    const activeTab = tabs.find(t => t.id === activeTabId);
    if (activeTab && activeTab.webview) {
      toggleSidebar('bookmarks');
    } else {
      showDashboardView('bookmarks');
    }
  });

  $('#nav-settings-side')?.addEventListener('click', () => {
    showDashboardView('settings');
  });

  /* ═══════════ WINDOW CONTROLS ═══════════ */
  $('#btn-minimize')?.addEventListener('click', () => window.bucksAPI.minimize());
  $('#btn-maximize')?.addEventListener('click', () => window.bucksAPI.maximize());
  $('#btn-close')?.addEventListener('click', () => window.bucksAPI.close());

  /* ═══════════ SIDEBAR TOGGLE & PANELS ═══════════ */

  function toggleSidebar(panelName) {
    const panels = {
      'wallet': walletSidebar,
      'settings': settingsPanel,
      'history': historyPanel,
      'bookmarks': bookmarksPanel,
      'downloads': downloadsPanel
    };

    const target = panels[panelName];

    Object.values(panels).forEach(p => {
      if (p && p !== target) {
        p.classList.remove('sidebar-visible');
        p.classList.add('sidebar-hidden');
      }
    });

    if (target) {
      if (target.classList.contains('sidebar-visible')) {
        target.classList.remove('sidebar-visible');
        target.classList.add('sidebar-hidden');
      } else {
        target.classList.remove('sidebar-hidden');
        target.classList.add('sidebar-visible');
        if (panelName === 'wallet') refreshWallet();
        if (panelName === 'history') renderHistory();
        if (panelName === 'bookmarks') renderBookmarks();
        if (panelName === 'downloads') renderDownloads();
      }
    }
  }

  $('#btn-wallet')?.addEventListener('click', () => toggleSidebar('wallet'));
  $('#btn-close-wallet')?.addEventListener('click', () => toggleSidebar('wallet'));
  $('#nav-history')?.addEventListener('click', () => { updateSidebarNav('nav-history'); toggleSidebar('history'); });
  $('#btn-close-history')?.addEventListener('click', () => toggleSidebar('history'));
  $('#nav-bookmarks')?.addEventListener('click', () => { updateSidebarNav('nav-bookmarks'); toggleSidebar('bookmarks'); });
  $('#btn-close-bookmarks')?.addEventListener('click', () => toggleSidebar('bookmarks'));

  /* ─── Wallet UI Rendering ─── */

  async function refreshWallet() {
    try {
      // 1. Check Node Connection & Economy Status
      const ecoData = await window.bucksAPI.walletRPC({ method: 'GET', endpoint: '/api/economy/status' });
      if (ecoData && !ecoData.error) {
        walletState.goldRate = ecoData.price_per_buck || 0;
        walletState.connected = true;
      } else {
        walletState.connected = false;
      }

      // 2. Load Wallets
      const walletsData = await window.bucksAPI.walletRPC({ method: 'GET', endpoint: '/api/wallets' });
      if (walletsData && !walletsData.error && walletsData.wallets && walletsData.wallets.length > 0) {
        const w = walletsData.wallets[0];
        walletState.address = w.address;
        walletState.balance = w.balance / 100000000.0;
        walletState.currentView = 'home';
      } else {
        walletState.currentView = 'welcome';
      }

      renderWalletView();
    } catch (err) {
      walletState.connected = false;
      renderWalletView();
    }
  }

  function renderWalletView() {
    const content = $('#wallet-content');
    const dotEl = $('.wallet-dot');
    const dashDotEl = $('#wallet-dashboard-dot');
    const dashTextEl = $('#wallet-dashboard-text');

    if (walletState.connected) {
      dotEl.classList.add('connected');
      if (dashDotEl) {
        dashDotEl.className = 'status-indicator online';
        dashDotEl.style.background = '#2ed573';
      }
      if (dashTextEl) dashTextEl.textContent = 'Node Online';
    } else {
      dotEl.classList.remove('connected');
      if (dashDotEl) {
        dashDotEl.className = 'status-indicator offline';
        dashDotEl.style.background = '#ff4757';
      }
      if (dashTextEl) dashTextEl.textContent = 'Node Offline';
    }

    if (!walletState.connected && walletState.currentView === 'home') {
      content.innerHTML = `
        <div class="wallet-status">
          <div class="status-indicator offline"></div>
          <span>Node Offline</span>
        </div>
        <div class="wallet-card glass-panel">
          <p class="label">Balance</p>
          <h3 id="wallet-balance">—</h3>
          <p class="address">Please start your Bucks Node</p>
        </div>
      `;
      return;
    }

    switch (walletState.currentView) {
      case 'welcome':
        content.innerHTML = `
          <div class="wallet-welcome">
            <div class="wallet-card glass-panel">
              <p>Welcome to Bucks. Create a new wallet or restore an existing one to begin.</p>
            </div>
            <div class="wallet-actions">
              <button class="btn-primary" id="btn-go-create">Create Wallet</button>
              <button class="btn-secondary" id="btn-go-restore">Restore</button>
            </div>
          </div>
        `;
        if ($('#btn-go-create')) $('#btn-go-create').onclick = () => { walletState.currentView = 'create'; renderWalletView(); };
        if ($('#btn-go-restore')) $('#btn-go-restore').onclick = () => { walletState.currentView = 'restore'; renderWalletView(); };
        break;

      case 'create':
        content.innerHTML = `
          <div class="wallet-form fade-in">
            <p class="label">Set Password</p>
            <input type="password" id="wallet-pass" placeholder="New Password" />
            <input type="password" id="wallet-pass-confirm" placeholder="Confirm Password" />
            <button class="btn-primary" id="btn-do-create">Generate Recovery Phrase</button>
            <button class="btn-secondary" id="btn-back-welcome">Back</button>
          </div>
        `;
        if ($('#btn-back-welcome')) $('#btn-back-welcome').onclick = () => { walletState.currentView = 'welcome'; renderWalletView(); };
        if ($('#btn-do-create')) $('#btn-do-create').onclick = handleCreateWallet;
        break;

      case 'recovery':
        content.innerHTML = `
          <div class="wallet-recovery fade-in">
            <p class="label">Recovery Phrase</p>
            <div class="card recovery-box-wrapper">
              <div class="recovery-box" id="mnemonic-text">${walletState.mnemonic}</div>
              <button class="btn-icon-small" id="btn-copy-mnemonic" title="Copy Phrase">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M8 4v8H4V4h4m2-2H2v12h10V2M16 8v8h-4V8h4m2-2h-8v12h10V6"/></svg>
              </button>
            </div>
            <p class="muted">Write this down. It is the only way to recover your funds.</p>
            <button class="btn-primary" id="btn-recovery-next">Next</button>
          </div>
        `;
        if ($('#btn-copy-mnemonic')) $('#btn-copy-mnemonic').onclick = () => {
          navigator.clipboard.writeText(walletState.mnemonic);
          showToast('Mnemonic copied to clipboard!');
        };
        if ($('#btn-recovery-next')) $('#btn-recovery-next').onclick = () => { walletState.currentView = 'confirm'; renderWalletView(); };
        break;

      case 'confirm':
        content.innerHTML = `
          <div class="wallet-confirm fade-in">
            <p class="label">Confirm Recovery Phrase</p>
            <p class="muted" style="margin-bottom:12px;">Please type your phrase to confirm you've saved it.</p>
            <textarea id="wallet-confirm-input" placeholder="Paste or type phrase here..."></textarea>
            <div class="wallet-actions">
              <button class="btn-primary" id="btn-confirm-mnemonic">Verify & Finish</button>
              <button class="btn-secondary" id="btn-confirm-back">Back</button>
            </div>
          </div>
        `;
        if ($('#btn-confirm-back')) $('#btn-confirm-back').onclick = () => { walletState.currentView = 'recovery'; renderWalletView(); };
        if ($('#btn-confirm-mnemonic')) $('#btn-confirm-mnemonic').onclick = (e) => {
          const container = e.target.closest('.wallet-confirm');
          const input = container.querySelector('#wallet-confirm-input').value.trim();
          if (input === walletState.mnemonic.trim()) {
            showToast('Wallet verified successfully!');
            walletState.currentView = 'home';
            refreshWallet();
          } else {
            showToast('Phrase mismatch. Please check again.');
          }
        };
        break;

      case 'restore':
        content.innerHTML = `
          <div class="wallet-form fade-in">
            <p class="label">Restore Wallet</p>
            <textarea id="wallet-mnemonic-input" placeholder="Enter recovery phrase..."></textarea>
            <button class="btn-primary" id="btn-do-restore">Restore</button>
            <button class="btn-secondary" id="btn-back-welcome-2">Back</button>
          </div>
        `;
        if ($('#btn-back-welcome-2')) $('#btn-back-welcome-2').onclick = () => { walletState.currentView = 'welcome'; renderWalletView(); };
        if ($('#btn-do-restore')) $('#btn-do-restore').onclick = handleRestoreWallet;
        break;

      case 'home':
        const totalGold = walletState.balance * walletState.goldRate;
        const goldText = totalGold >= 1
          ? `${totalGold.toFixed(3)}g Gold`
          : `${(totalGold * 1000).toFixed(2)}mg Gold`;

        content.innerHTML = `
          <div class="wallet-home animate-in">
            <div class="wallet-card glass-panel">
              <p class="label">Primary Wallet</p>
              <h3 id="wallet-balance">${walletState.balance.toFixed(2)} $BUCKS</h3>
              <p class="gold-val">≈ ${goldText}</p>
              <div class="address-chip" id="btn-copy-address">${walletState.address.substring(0, 8)}...${walletState.address.slice(-6)}</div>
            </div>

            <div class="sidebar-tabs">
              <button class="side-tab active" id="tab-send">Send</button>
              <button class="side-tab" id="tab-receive">Receive</button>
            </div>

            <div id="side-view-send" class="side-view">
              <input type="text" id="send-to" placeholder="Recipient Address" />
              <input type="number" id="send-amount" placeholder="Amount" />
              <button class="btn-primary" id="btn-send-bucks">Send Bucks</button>
            </div>

            <div id="side-view-receive" class="side-view" style="display:none">
              <div class="qr-placeholder">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M3 3h7v7H3zM14 3h7v7h-7zM3 14h7v7H3zM14 14h3v3h-3zM18 18h3v3h-3zM17 17h1v1h-1zM14 18h1v1h-1zM17 14h1v1h-1zM18 17h1v1h-1z"/></svg>
              </div>
              <p class="address-full">${walletState.address}</p>
            </div>
          </div>
        `;

        // Wire up tabs
        if ($('#tab-send')) $('#tab-send').onclick = () => {
          $('#side-view-send').style.display = 'block';
          $('#side-view-receive').style.display = 'none';
          $('#tab-send').classList.add('active');
          $('#tab-receive').classList.remove('active');
        };
        if ($('#tab-receive')) $('#tab-receive').onclick = () => {
          $('#side-view-send').style.display = 'none';
          $('#side-view-receive').style.display = 'block';
          $('#tab-send').classList.remove('active');
          $('#tab-receive').classList.add('active');
        };

        if ($('#btn-copy-address')) $('#btn-copy-address').onclick = () => {
          navigator.clipboard.writeText(walletState.address);
          showToast('Address copied to clipboard!');
        };

        if ($('#btn-send-bucks')) $('#btn-send-bucks').onclick = handleSendBucks;
        break;
    }

    // Sync to embedded Dashboard view
    const dashContent = document.getElementById('wallet-dashboard-content');
    if (dashContent && content) {
      dashContent.innerHTML = content.innerHTML;
      
      // Wire up dashboard-specific buttons
      const copyAddr = dashContent.querySelector('#btn-copy-address');
      if (copyAddr) copyAddr.onclick = () => {
        navigator.clipboard.writeText(walletState.address);
        showToast('Address copied to clipboard!');
      };
      const sendBtn = dashContent.querySelector('#btn-send-bucks');
      if (sendBtn) sendBtn.onclick = handleSendBucks;
      const goCreate = dashContent.querySelector('#btn-go-create');
      if (goCreate) goCreate.onclick = () => { walletState.currentView = 'create'; renderWalletView(); };
      const goRestore = dashContent.querySelector('#btn-go-restore');
      if (goRestore) goRestore.onclick = () => { walletState.currentView = 'restore'; renderWalletView(); };
      const doCreate = dashContent.querySelector('#btn-do-create');
      if (doCreate) doCreate.onclick = handleCreateWallet;
      const doRestore = dashContent.querySelector('#btn-do-restore');
      if (doRestore) doRestore.onclick = handleRestoreWallet;
      const backWelcome = dashContent.querySelector('#btn-back-welcome');
      if (backWelcome) backWelcome.onclick = () => { walletState.currentView = 'welcome'; renderWalletView(); };
      const backWelcome2 = dashContent.querySelector('#btn-back-welcome-2');
      if (backWelcome2) backWelcome2.onclick = () => { walletState.currentView = 'welcome'; renderWalletView(); };
      const copyMnemonic = dashContent.querySelector('#btn-copy-mnemonic');
      if (copyMnemonic) copyMnemonic.onclick = () => {
        navigator.clipboard.writeText(walletState.mnemonic);
        showToast('Mnemonic copied to clipboard!');
      };
      const recoveryNext = dashContent.querySelector('#btn-recovery-next');
      if (recoveryNext) recoveryNext.onclick = () => { walletState.currentView = 'confirm'; renderWalletView(); };
      const confirmBack = dashContent.querySelector('#btn-confirm-back');
      if (confirmBack) confirmBack.onclick = () => { walletState.currentView = 'recovery'; renderWalletView(); };
      const confirmMnemonic = dashContent.querySelector('#btn-confirm-mnemonic');
      if (confirmMnemonic) confirmMnemonic.onclick = (e) => {
        const container = e.target.closest('.wallet-confirm');
        const input = container.querySelector('#wallet-confirm-input').value.trim();
        if (input === walletState.mnemonic.trim()) {
          showToast('Wallet verified successfully!');
          walletState.currentView = 'home';
          refreshWallet();
        } else {
          showToast('Phrase mismatch. Please check again.');
        }
      };

      // Handle sending/receiving tabs inside the dashboard
      const tabSend = dashContent.querySelector('#tab-send');
      const tabReceive = dashContent.querySelector('#tab-receive');
      const viewSend = dashContent.querySelector('#side-view-send');
      const viewReceive = dashContent.querySelector('#side-view-receive');
      if (tabSend) tabSend.onclick = () => {
        if (viewSend) viewSend.style.display = 'block';
        if (viewReceive) viewReceive.style.display = 'none';
        tabSend.classList.add('active');
        if (tabReceive) tabReceive.classList.remove('active');
      };
      if (tabReceive) tabReceive.onclick = () => {
        if (viewSend) viewSend.style.display = 'none';
        if (viewReceive) viewReceive.style.display = 'block';
        if (tabSend) tabSend.classList.remove('active');
        tabReceive.classList.add('active');
      };
    }
  }

  /* ─── Wallet Handlers ─── */

  async function handleCreateWallet(e) {
    const container = e?.target ? e.target.closest('.wallet-form') : document;
    const pass = container.querySelector('#wallet-pass').value;
    const confirm = container.querySelector('#wallet-pass-confirm').value;
    if (!pass || pass !== confirm) return alert('Passwords do not match');

    const res = await window.bucksAPI.walletRPC({ method: 'POST', endpoint: '/api/wallets/create', body: { password: pass } });
    if (res && res.mnemonic) {
      walletState.mnemonic = res.mnemonic;
      walletState.currentView = 'recovery';
      renderWalletView();
    } else {
      alert('Error: ' + (res.error || 'Failed to create wallet'));
    }
  }

  async function handleRestoreWallet(e) {
    const container = e?.target ? e.target.closest('.wallet-form') : document;
    const mnemonic = container.querySelector('#wallet-mnemonic-input').value.trim();
    if (!mnemonic) return alert('Enter mnemonic');

    const res = await window.bucksAPI.walletRPC({ method: 'POST', endpoint: '/api/wallets/restore', body: { mnemonic } });
    if (res && !res.error) {
      walletState.currentView = 'home';
      refreshWallet();
    } else {
      alert('Error: ' + (res.error || 'Invalid mnemonic'));
    }
  }

  async function handleSendBucks(e) {
    const container = e?.target ? e.target.closest('.wallet-home') : document;
    const to = container.querySelector('#send-to').value.trim();
    const amount = parseFloat(container.querySelector('#send-amount').value);
    if (!to || isNaN(amount)) return alert('Invalid inputs');

    const res = await window.bucksAPI.walletRPC({
      method: 'POST',
      endpoint: '/api/transactions/send',
      body: {
        from: walletState.address,
        to: to,
        amount: Math.floor(amount * 100000000) // Satoshis
      }
    });

    if (res && res.success) {
      alert('Bucks sent successfully!');
      container.querySelector('#send-to').value = '';
      container.querySelector('#send-amount').value = '';
      refreshWallet();
    } else {
      alert('Error: ' + (res.error || 'Transaction failed'));
    }
  }

  $('#btn-settings')?.addEventListener('click', () => toggleSidebar('settings'));
  $('#btn-close-settings')?.addEventListener('click', () => toggleSidebar('settings'));

  /* ═══════════ SETTINGS ═══════════ */

  async function loadSettings() {
    settings = await window.bucksAPI.getSettings();
    // Populate UI
    $('#setting-search-engine').value = settings.searchEngine || 'https://duckduckgo.com/?q=';
    $('#setting-homepage').value = settings.homepage || 'bucks://newtab';
    $('#setting-adblock').checked = settings.adBlockEnabled !== false;
    $('#setting-https-only').checked = settings.httpsOnly === true;

    // Swarm Settings
    $('#setting-cluster-secret').value = settings.clusterSecret || 'BUCKS_DEFAULT_CLUSTER';
    $('#setting-cluster-cidn').value = settings.clusterCidn || 'mainnet';
  }

  async function saveSettings() {
    const updated = {
      ...settings,
      searchEngine: $('#setting-search-engine').value,
      homepage: $('#setting-homepage').value,
      adBlockEnabled: $('#setting-adblock').checked,
      httpsOnly: $('#setting-https-only').checked,
      clusterSecret: $('#setting-cluster-secret').value,
      clusterCidn: $('#setting-cluster-cidn').value
    };
    await window.bucksAPI.saveSettings(updated);
    settings = updated;
    window.bucksAPI.toggleAdBlock(updated.adBlockEnabled);
    showToast('Settings saved successfully', 'success');
  }

  if ($('#btn-test-speed')) $('#btn-test-speed').onclick = async () => {
    const start = Date.now();
    const latencyEl = $('#stat-latency');
    latencyEl.textContent = 'Testing...';
    try {
      // Use a fast-responding public endpoint for latency check
      await fetch('https://www.google.com/favicon.ico', { mode: 'no-cors', cache: 'no-cache' });
      const latency = Date.now() - start;
      latencyEl.textContent = `${latency} ms`;
      showToast(`Connection Test: ${latency}ms latency`);
    } catch (err) {
      latencyEl.textContent = 'Error';
      showToast('Connection test failed.');
    }
  };

  $('#btn-save-settings')?.addEventListener('click', async () => {
    await saveSettings();
    // If in web-mode, close the panel; if on dashboard, stay on settings
    const activeTab = tabs.find(t => t.id === activeTabId);
    if (activeTab && activeTab.webview) {
      toggleSidebar('settings');
    } else {
      showToast('Settings saved!', 'success');
    }
  });

  $('#btn-clear-browsing-data')?.addEventListener('click', async () => {
    if (!confirm('Clear cache, cookies and browsing history? Bookmarks are kept.')) return;
    try {
      await window.bucksAPI.clearBrowsingData();
      browsingHistory = [];
      renderHistory();
      showToast('Browsing data cleared', 'success');
    } catch (e) {
      showToast('Failed to clear browsing data', 'error');
    }
  });

  /* ═══════════ PRIVATE WINDOW INDICATOR ═══════════ */
  if (IS_PRIVATE) {
    try {
      document.title = 'Bucks — Private';
      const profile = $('#profile-section');
      if (profile) {
        profile.innerHTML = `
          <div style="width:24px; height:24px; border-radius:50%; background:linear-gradient(135deg, #6a4bd6, #3a2270); display:flex; align-items:center; justify-content:center;">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3-7 10-7 10 7 10 7"></path><circle cx="12" cy="12" r="3"></circle><line x1="3" y1="3" x2="21" y2="21"></line></svg>
          </div>
          <span style="font-size:12.5px; font-weight:600; color:rgba(255,255,255,0.85);">Private</span>`;
      }
      const topBar = document.querySelector('.top-bar-inner');
      if (topBar) topBar.style.border = '1px solid rgba(150,110,255,0.55)';
    } catch (_) {}
  }

  /* ═══════════ PROFILE PANEL ═══════════ */
  {
    const profileSection = document.getElementById('profile-section');
    const profilePanel = document.getElementById('profile-panel');
    const profilePeerId = document.getElementById('profile-peer-id');
    const profileUuid = document.getElementById('profile-uuid');
    const profileDisplayName = document.getElementById('profile-display-name');
    const profileDisplayEmail = document.getElementById('profile-display-email');
    const profileAvatar = document.getElementById('profile-avatar');
    const profileStatusDot = document.getElementById('profile-status-dot');
    const profilePeerCount = document.getElementById('profile-peer-count');
    const profileFollowingCount = document.getElementById('profile-following-count');
    const profileFeedCount = document.getElementById('profile-feed-count');
    const profileSyncedCount = document.getElementById('profile-synced-count');
    const profileCopyPeerId = document.getElementById('profile-copy-peer-id');
    const profileCopyUuid = document.getElementById('profile-copy-uuid');
    const profileSyncInput = document.getElementById('profile-sync-input');
    const profileSyncBtn = document.getElementById('profile-sync-btn');
    const profileSyncStatus = document.getElementById('profile-sync-status');
    const profileNameSpan = document.querySelector('#profile-section span');
    const profileUsernameInput = document.getElementById('profile-username-input');
    const profileUsernameSave = document.getElementById('profile-username-save');
    const profileUsernameStatus = document.getElementById('profile-username-status');

    let _profilePeerId = '';
    let _profileUuid = '';

    // Generate a stable UUID from Peer ID (deterministic, no external deps)
    function peerIdToUuid(peerId) {
      let hash = 0;
      for (let i = 0; i < peerId.length; i++) {
        hash = ((hash << 5) - hash + peerId.charCodeAt(i)) | 0;
      }
      const hex = Math.abs(hash).toString(16).padStart(8, '0');
      const p2 = peerId.slice(-12);
      const uuid = `${hex}-${p2.slice(0,4)}-4${p2.slice(4,7)}-${p2.slice(7,11)}-${peerId.slice(6,18)}`;
      return uuid.toLowerCase();
    }

    // Apply username everywhere it's shown
    function applyUsername(name) {
      if (profileDisplayName) profileDisplayName.textContent = name;
      if (profileNameSpan) profileNameSpan.textContent = name;
      if (profileAvatar) profileAvatar.textContent = name.charAt(0).toUpperCase();
      if (profileUsernameInput) profileUsernameInput.value = name;
      if (profileDisplayEmail) {
        const tag = name.toLowerCase().replace(/[^a-z0-9]/g, '') || 'user';
        profileDisplayEmail.textContent = `${tag}@bucks.p2p`;
      }
    }

    // Load saved display name
    const savedName = localStorage.getItem('bucks-profile-name') || 'Bucks User';
    applyUsername(savedName);

    // Save username via button
    if (profileUsernameSave && profileUsernameInput) {
      function saveUsername() {
        const name = profileUsernameInput.value.trim();
        if (!name) {
          if (profileUsernameStatus) { profileUsernameStatus.textContent = '⚠ Name cannot be empty'; profileUsernameStatus.style.color = '#ffa502'; }
          return;
        }
        if (name.length > 30) {
          if (profileUsernameStatus) { profileUsernameStatus.textContent = '⚠ Max 30 characters'; profileUsernameStatus.style.color = '#ffa502'; }
          return;
        }
        localStorage.setItem('bucks-profile-name', name);
        applyUsername(name);
        if (profileUsernameStatus) {
          profileUsernameStatus.textContent = '✅ Username saved!';
          profileUsernameStatus.style.color = '#2ed573';
          setTimeout(() => { profileUsernameStatus.textContent = ''; }, 2500);
        }
        // Flash save button green
        profileUsernameSave.style.transform = 'scale(0.95)';
        setTimeout(() => { profileUsernameSave.style.transform = 'scale(1)'; }, 150);
      }
      profileUsernameSave.addEventListener('click', saveUsername);
      profileUsernameInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); saveUsername(); }
      });
    }

    // Toggle profile panel
    if (profileSection && profilePanel) {
      profileSection.addEventListener('click', (e) => {
        e.stopPropagation();
        const isHidden = profilePanel.classList.contains('hidden');
        // Close the 3-dots menu if open
        const moreMenu = document.getElementById('more-dropdown-menu');
        if (moreMenu) moreMenu.classList.add('hidden');
        profilePanel.classList.toggle('hidden');
        if (isHidden) refreshProfileInfo();
      });
      document.addEventListener('click', (e) => {
        if (!profilePanel.contains(e.target) && !profileSection.contains(e.target)) {
          profilePanel.classList.add('hidden');
        }
      });
    }

    // Synced peers counter (persisted)
    let syncedPeers = [];
    try { syncedPeers = JSON.parse(localStorage.getItem('bucks-synced-peers') || '[]'); } catch (_) { syncedPeers = []; }
    function saveSyncedPeers() {
      try { localStorage.setItem('bucks-synced-peers', JSON.stringify(syncedPeers)); } catch (_) {}
    }

    async function refreshProfileInfo() {
      try {
        const info = await window.bucksAPI.ipfsInfo();
        if (info && info.peerId) {
          _profilePeerId = info.peerId;
          _profileUuid = peerIdToUuid(info.peerId);
          if (profilePeerId) profilePeerId.textContent = info.peerId;
          if (profileUuid) profileUuid.textContent = _profileUuid;
          if (profileStatusDot) {
            profileStatusDot.style.background = '#2ed573';
            profileStatusDot.title = 'Node Online';
          }
          if (profilePeerCount) profilePeerCount.textContent = info.peers || 0;
          if (profileFollowingCount) profileFollowingCount.textContent = (info.following || []).length;
          if (profileFeedCount) profileFeedCount.textContent = info.feedCount || 0;
          if (profileSyncedCount) profileSyncedCount.textContent = syncedPeers.length;
        } else {
          if (profilePeerId) profilePeerId.textContent = 'Node starting…';
          if (profileUuid) profileUuid.textContent = 'Waiting…';
          if (profileStatusDot) {
            profileStatusDot.style.background = '#ffa502';
            profileStatusDot.title = 'Connecting…';
          }
        }
      } catch (err) {
        if (profilePeerId) profilePeerId.textContent = 'Offline';
        if (profileUuid) profileUuid.textContent = 'Offline';
        if (profileStatusDot) {
          profileStatusDot.style.background = '#ff4757';
          profileStatusDot.title = 'Offline';
        }
      }
    }

    // Copy buttons
    if (profileCopyPeerId) {
      profileCopyPeerId.addEventListener('click', (e) => {
        e.stopPropagation();
        if (_profilePeerId) {
          navigator.clipboard.writeText(_profilePeerId);
          if (window._showToast) window._showToast('Peer ID copied to clipboard');
          profileCopyPeerId.style.background = 'rgba(46,213,115,0.25)';
          setTimeout(() => { profileCopyPeerId.style.background = 'rgba(255,255,255,0.06)'; }, 1200);
        }
      });
    }
    if (profileCopyUuid) {
      profileCopyUuid.addEventListener('click', (e) => {
        e.stopPropagation();
        if (_profileUuid) {
          navigator.clipboard.writeText(_profileUuid);
          if (window._showToast) window._showToast('UUID copied to clipboard');
          profileCopyUuid.style.background = 'rgba(46,213,115,0.25)';
          setTimeout(() => { profileCopyUuid.style.background = 'rgba(255,255,255,0.06)'; }, 1200);
        }
      });
    }

    // Sync button
    if (profileSyncBtn && profileSyncInput) {
      async function doSync() {
        const val = profileSyncInput.value.trim();
        if (!val) {
          if (profileSyncStatus) profileSyncStatus.textContent = '⚠ Paste a Peer ID or UUID first';
          return;
        }
        if (val === _profilePeerId || val === _profileUuid) {
          if (profileSyncStatus) profileSyncStatus.textContent = "⚠ That's your own ID";
          return;
        }
        if (val.length < 10) {
          if (profileSyncStatus) profileSyncStatus.textContent = '⚠ ID looks too short';
          return;
        }

        profileSyncBtn.disabled = true;
        if (profileSyncStatus) profileSyncStatus.innerHTML = '⏳ Syncing…';

        try {
          // Follow the peer on IPFS network
          await window.bucksAPI.ipfsFollow(val);

          // Add to synced list
          if (!syncedPeers.includes(val)) {
            syncedPeers.push(val);
            saveSyncedPeers();
          }

          // Also add as a chat contact (opens a Messages thread)
          let contacts = [];
          try { contacts = JSON.parse(localStorage.getItem('bucks-msg-contacts') || '[]'); } catch (_) {}
          if (!contacts.includes(val)) {
            contacts.push(val);
            localStorage.setItem('bucks-msg-contacts', JSON.stringify(contacts));
          }

          if (profileSyncStatus) profileSyncStatus.innerHTML = '✅ Synced! Peer added to Messages & Following.';
          if (profileSyncedCount) profileSyncedCount.textContent = syncedPeers.length;
          profileSyncInput.value = '';

          if (window._showToast) window._showToast(`Synced with peer ${val.slice(0,10)}…`);
        } catch (err) {
          if (profileSyncStatus) profileSyncStatus.innerHTML = `❌ Sync failed: ${err.message}`;
        }
        profileSyncBtn.disabled = false;
      }

      profileSyncBtn.addEventListener('click', doSync);
      profileSyncInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') doSync();
      });
    }

    // Auto-refresh profile info periodically & on startup
    refreshProfileInfo();
    setInterval(() => {
      if (profilePanel && !profilePanel.classList.contains('hidden')) {
        refreshProfileInfo();
      }
    }, 5000);

    // Also update the top-bar profile section avatar on load
    if (!IS_PRIVATE) {
      refreshProfileInfo().then(() => {
        const savedN = localStorage.getItem('bucks-profile-name');
        if (savedN) applyUsername(savedN);
      });
    }
  }

  /* ═══════════ AD-BLOCKER BADGE ═══════════ */
  setInterval(async () => {
    try {
      const count = await window.bucksAPI.getBlockedCount();
      blockedBadge.textContent = count > 999 ? '999+' : count;
    } catch (_) { }
  }, 3000);

  /* ═══════════ KEYBOARD SHORTCUTS ═══════════ */
  document.addEventListener('keydown', (e) => {
    // Ctrl+T = new tab
    if (e.ctrlKey && e.key === 't') { e.preventDefault(); createTab(); }
    // Ctrl+W = close tab
    if (e.ctrlKey && e.key === 'w') { e.preventDefault(); closeTab(activeTabId); }
    // Ctrl+L = focus address bar
    if (e.ctrlKey && e.key === 'l') { e.preventDefault(); addressBar.focus(); }
    // Ctrl+R = refresh
    if (e.ctrlKey && e.key === 'r') {
      e.preventDefault();
      const tab = tabs.find((t) => t.id === activeTabId);
      if (tab?.webview) tab.webview.reload();
    }
    // F5 = refresh
    if (e.key === 'F5') {
      e.preventDefault();
      const tab = tabs.find((t) => t.id === activeTabId);
      if (tab?.webview) tab.webview.reload();
    }
    // Alt+Left = back
    if (e.altKey && e.key === 'ArrowLeft') {
      const tab = tabs.find((t) => t.id === activeTabId);
      if (tab?.webview) tab.webview.goBack();
    }
    // Alt+Right = forward
    if (e.altKey && e.key === 'ArrowRight') {
      const tab = tabs.find((t) => t.id === activeTabId);
      if (tab?.webview) tab.webview.goForward();
    }

    const mod = e.ctrlKey || e.metaKey;
    // Ctrl/Cmd+Shift+N = new private window
    if (mod && e.shiftKey && e.key.toLowerCase() === 'n') {
      e.preventDefault();
      window.bucksAPI.openPrivateWindow();
    }
    // Ctrl/Cmd+J = downloads
    if (mod && !e.shiftKey && e.key.toLowerCase() === 'j') {
      e.preventDefault();
      toggleSidebar('downloads');
    }
    // Ctrl/Cmd+P = print
    if (mod && !e.shiftKey && e.key.toLowerCase() === 'p') {
      e.preventDefault();
      printActiveTab();
    }
    // Ctrl/Cmd + / - / 0 = zoom in / out / reset
    if (mod && (e.key === '=' || e.key === '+')) { e.preventDefault(); applyZoom(zoomFactor + 0.1); }
    if (mod && e.key === '-') { e.preventDefault(); applyZoom(zoomFactor - 0.1); }
    if (mod && e.key === '0') { e.preventDefault(); applyZoom(1); }
  });

  /* ═══════════ BENCHMARKING ═══════════ */
  window.runBenchmark = async function () {
    const urls = [
      'https://www.wikipedia.org',
      'https://news.ycombinator.com',
      'https://github.com',
      'https://www.reddit.com/r/javascript',
      'https://developer.mozilla.org',
      'https://example.com'
    ];
    console.log('🚀 Starting Browser Benchmark...');
    const results = [];

    for (const url of urls) {
      console.log(`Loading: ${url}`);
      const start = performance.now();
      const tabId = createTab(url);

      await new Promise(resolve => {
        const tab = tabs.find(t => t.id === tabId);
        const checkWV = setInterval(() => {
          if (tab.webview) {
            clearInterval(checkWV);
            tab.webview.addEventListener('did-stop-loading', () => {
              resolve();
            }, { once: true });

            // Timeout just in case
            setTimeout(() => resolve('timeout'), 15000);
          }
        }, 100);
      });

      const time = performance.now() - start;
      console.log(`✅ ${url} loaded in ${Math.round(time)}ms`);
      results.push({ url, time: Math.round(time) });

      // Close tab to free memory before next test, except the last one
      closeTab(tabId);
    }

    console.table(results);
    const avg = results.reduce((a, b) => a + b.time, 0) / results.length;
    console.log(`📊 Average Load Time: ${Math.round(avg)}ms`);
    showToast(`Benchmark Complete! Avg: ${Math.round(avg)}ms`);
  };

  // Auto-run benchmark for testing
  // setTimeout(() => window.runBenchmark(), 3000);

  window.runPhase19Test = async function () {
    console.log('🧪 Starting Phase 1.9 Automated Mechanics Test...');

    // Mock active tab and search autocomplete entries so tests pass on clean launch
    const origTabs = [...tabs];
    const origActiveTabId = activeTabId;
    const origBookmarks = [...bookmarks];
    const origHistory = [...browsingHistory];

    const mockTabId = 'mock-tab-test';
    const mockTab = {
      id: mockTabId,
      title: 'Google',
      url: 'https://google.com',
      webview: document.createElement('div'), // Mock webview for Ctrl+F test
      newtabEl: null
    };
    tabs.push(mockTab);
    activeTabId = mockTabId;

    bookmarks = [{ title: 'http test bookmark', url: 'https://httpbin.org' }];
    browsingHistory = [{ title: 'http test history', url: 'https://httpbin.org/get' }];

    // Test 1: Bookmarks
    const prevCount = bookmarks.length;
    btnBookmark.click();
    await new Promise(r => setTimeout(r, 500));
    const pass1 = bookmarks.length === prevCount + 1;
    console.log(`[Test 1] Bookmarking Active Tab: ${pass1 ? '✅ PASS' : '❌ FAIL'}`);

    // Test 2: Omnibox Autocomplete
    addressBar.value = 'http';
    addressBar.dispatchEvent(new Event('input'));
    await new Promise(r => setTimeout(r, 500));
    const isVisible = !omniboxDropdown.classList.contains('hidden');
    const hasChildren = omniboxDropdown.children.length > 0;
    const pass2 = isVisible && hasChildren;
    console.log(`[Test 2] Omnibox Suggestions Rendered: ${pass2 ? '✅ PASS' : '❌ FAIL'}`);

    // Test 3: Find in Page
    const event = new KeyboardEvent('keydown', { key: 'f', ctrlKey: true });
    window.dispatchEvent(event);
    await new Promise(r => setTimeout(r, 500));
    const pass3 = !findBar.classList.contains('hidden');
    console.log(`[Test 3] Ctrl+F Opens Find Bar: ${pass3 ? '✅ PASS' : '❌ FAIL'}`);

    // Cleanup and restore original states
    tabs = origTabs;
    activeTabId = origActiveTabId;
    bookmarks = origBookmarks;
    browsingHistory = origHistory;
    saveBookmarks();
    closeFindBar();
    omniboxDropdown.classList.add('hidden');

    if (pass1 && pass2 && pass3) {
      console.log('🎉 ALL PHASE 1.9 TESTS PASSED!');
      showToast('Phase 1.9 Verification Passed!', 'success');
    }
  };

  setTimeout(() => window.runPhase19Test(), 6000);

  /* ═══════════ IPFS SOCIAL PANEL ═══════════ */
  const ipfsSidebar = document.getElementById('ipfs-sidebar');
  const btnIpfs = document.getElementById('btn-ipfs');
  const btnCloseIpfs = document.getElementById('btn-close-ipfs');
  const ipfsDot = document.querySelector('.ipfs-dot');

  if (btnIpfs) btnIpfs.addEventListener('click', () => toggleSidebar('ipfs'));
  if (btnCloseIpfs) btnCloseIpfs.addEventListener('click', () => toggleSidebar('ipfs'));

  // Extend toggleSidebar to handle IPFS panel
  const originalToggleSidebar = toggleSidebar;
  // We'll patch toggleSidebar inline — check if ipfs panel was already handled
  // The existing toggleSidebar handles 'wallet' and 'settings'. We need to add 'ipfs'.

  function toggleIPFS() {
    const isHidden = ipfsSidebar.classList.contains('sidebar-hidden');
    // Close other panels first
    const walletSidebar = document.getElementById('wallet-sidebar');
    const settingsPanel = document.getElementById('settings-panel');
    if (walletSidebar && !walletSidebar.classList.contains('sidebar-hidden')) {
      walletSidebar.classList.add('sidebar-hidden');
    }
    if (settingsPanel && !settingsPanel.classList.contains('sidebar-hidden')) {
      settingsPanel.classList.add('sidebar-hidden');
    }
    if (isHidden) {
      ipfsSidebar.classList.remove('sidebar-hidden');
      refreshIPFSStatus();
      refreshIPFSFeed();
    } else {
      ipfsSidebar.classList.add('sidebar-hidden');
    }
  }

  // Re-bind to use our IPFS-aware toggle
  if (btnIpfs) {
    btnIpfs.removeEventListener('click', () => toggleSidebar('ipfs'));
    btnIpfs.addEventListener('click', toggleIPFS);
  }
  if (btnCloseIpfs) {
    btnCloseIpfs.removeEventListener('click', () => toggleSidebar('ipfs'));
    btnCloseIpfs.addEventListener('click', () => ipfsSidebar && ipfsSidebar.classList.add('sidebar-hidden'));
  }

  /* ── IPFS Status Refresh ── */
  async function refreshIPFSStatus() {
    const info = await window.bucksAPI.ipfsInfo();
    const dot = $('#ipfs-status-dot');
    dot.className = info.status === 'online' ? 'status-indicator status-online' : 'status-indicator status-offline';
    $('#ipfs-peer-count').textContent = `${info.peers} Peers`;
    $('#ipfs-peer-id').textContent = info.peerId ? `${info.peerId.slice(0, 8)}...${info.peerId.slice(-4)}` : 'Offline';

    // Auto-refresh swarm data if cluster is present
    if (info.cluster) {
      refreshSwarmStatus(info.cluster);
    }

    try {
      // Social layer is fully P2P (gossipsub) — status is the Helia node itself
      const isHeliaOnline = info && info.status === 'online';

      if (ipfsDot) {
        ipfsDot.className = 'ipfs-dot ' + (isHeliaOnline ? 'online' : 'offline');
        ipfsDot.title = `Helia: ${isHeliaOnline ? 'ON' : 'OFF'} | Swarm peers: ${info?.peers ?? 0}`;
      }

      // Render following list
      renderFollowingList(info.following || []);

      // ── Storage Dashboard ──
      var stats = await window.bucksAPI.ipfsStorageStats();
      const pinnedCountEl = document.getElementById('storage-pinned-count');
      const totalSizeEl = document.getElementById('storage-total-size');
      const progressFill = document.getElementById('storage-progress-fill');

      if (stats && !stats.error) {
        pinnedCountEl.textContent = stats.pinnedCount;
        totalSizeEl.textContent = formatSize(stats.totalSizeBytes);
        const percent = Math.min((stats.totalSizeBytes / (500 * 1024 * 1024)) * 100, 100);
        progressFill.style.width = `${percent}%`;
        renderPinnedList(stats.pinnedItems || []);
      }
    } catch (e) {
      console.error('[IPFS UI] Status error:', e);
    }

    // Sync to embedded Dashboard view
    const dashStatusDot = document.getElementById('ipfs-dash-dot');
    const dashStatusText = document.getElementById('ipfs-dash-status-text');
    const dashPeerId = document.getElementById('ipfs-dash-peer-id');
    const dashPeerCount = document.getElementById('ipfs-dash-peer-count');
    const dashFeedCount = document.getElementById('ipfs-dash-feed-count');
    const dashPinnedCount = document.getElementById('storage-dash-pinned-count');
    const dashTotalSize = document.getElementById('storage-dash-total-size');
    const dashProgressFill = document.getElementById('storage-dash-progress-fill');

    if (dashStatusDot && info) {
      dashStatusDot.className = 'status-indicator ' + (info.status === 'online' ? 'online' : 'offline');
    }
    if (dashStatusText && info) {
      dashStatusText.textContent = info.status === 'online' ? 'Node Online' : 'Node Offline';
    }
    if (dashPeerId && info) {
      dashPeerId.textContent = info.peerId ? `${info.peerId.slice(0, 8)}...${info.peerId.slice(-4)}` : 'Offline';
    }
    if (dashPeerCount && info) {
      dashPeerCount.textContent = `${info.peers} Peers`;
    }
    if (dashFeedCount && info) {
      dashFeedCount.textContent = `${info.posts || 0} posts`;
    }
    if (stats && !stats.error) {
      if (dashPinnedCount) dashPinnedCount.textContent = stats.pinnedCount;
      if (dashTotalSize) dashTotalSize.textContent = formatSize(stats.totalSizeBytes);
      if (dashProgressFill) {
        const percent = Math.min((stats.totalSizeBytes / (500 * 1024 * 1024)) * 100, 100);
        dashProgressFill.style.width = `${percent}%`;
      }
    }
  }

  /* ── Pinned List ── */
  function renderPinnedList(items) {
    const list = document.getElementById('ipfs-pinned-list');
    if (!items.length) {
      list.innerHTML = '<p class="tx-empty" style="font-size:11px;">No recommended files yet.</p>';
      return;
    }

    list.innerHTML = items.map(item => `
      <div class="ipfs-pinned-item" title="${item.cid}">
        <div class="pinned-info">
          <span class="pinned-name">${escapeHtml(item.name)}</span>
          <span class="pinned-meta">${formatSize(item.size)} • ${new Date(item.timestamp).toLocaleDateString()}</span>
        </div>
        <button class="btn-unpin" onclick="window._ipfsUnpin('${item.cid}')" title="Unpin content">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M18 6L6 18M6 6l12 12"/></svg>
        </button>
      </div>
    `).join('');
  }

  window._ipfsUnpin = async (cid) => {
    const confirm = window.confirm("Are you sure you want to unpin this content? Removing this deletes your local copy. Copies other people pinned stay on their machines.");
    if (!confirm) return;

    await window.bucksAPI.ipfsUnpin(cid);
    showToast('Unpinned: ' + cid.slice(0, 12) + '…');
    refreshIPFSStatus();
    refreshIPFSFeed();
  };

  /* ── Following List ── */
  function renderFollowingList(following) {
    const list = document.getElementById('ipfs-following-list');
    if (!list) return;
    if (!following.length) {
      list.innerHTML = '<p class="tx-empty" style="font-size:11px;">Not following anyone yet.</p>';
      const dashList = document.getElementById('ipfs-dash-following-list');
      if (dashList) dashList.innerHTML = list.innerHTML;
      return;
    }
    list.innerHTML = following.map(id => `
      <div class="ipfs-following-item">
        <span>${id.slice(0, 12)}…${id.slice(-6)}</span>
        <button onclick="window._ipfsUnfollow('${id}')">✕</button>
      </div>
    `).join('');
    const dashList = document.getElementById('ipfs-dash-following-list');
    if (dashList) {
      dashList.innerHTML = list.innerHTML;
    }
  }

  window._ipfsUnfollow = async (peerId) => {
    try {
      await window.bucksAPI.ipfsUnfollow(peerId);
    } catch (e) {
      console.error('[IPFS UI] Unfollow error:', e);
    }
    refreshIPFSStatus();
  };

  /* ── Follow ── */
  async function handleIPFSFollow(e) {
    const isDash = e.target.id === 'btn-ipfs-dash-follow';
    const inputId = isDash ? 'ipfs-dash-follow-id' : 'ipfs-follow-id';
    const input = document.getElementById(inputId);
    const peerId = input?.value.trim();
    if (!peerId) return;

    try {
      // Follow in local Helia node (feed gossip picks up their posts)
      const localRes = await window.bucksAPI.ipfsFollow(peerId);

      if (input) input.value = '';
      showToast(`${localRes.status === 'followed' || localRes.status === 'already_following' ? '✓ Following' : 'Error'} ${peerId.slice(0, 12)}…`);
      refreshIPFSStatus();
    } catch (e) {
      showToast('Follow failed', 'error');
    }
  }

  document.getElementById('btn-ipfs-follow')?.addEventListener('click', handleIPFSFollow);
  document.getElementById('btn-ipfs-dash-follow')?.addEventListener('click', handleIPFSFollow);

  /* ── Dashboard Publish (Text Only) ── */
  document.getElementById('btn-ipfs-dash-publish')?.addEventListener('click', async () => {
    const descInput = document.getElementById('ipfs-dash-publish-desc');
    const text = descInput?.value.trim();
    if (!text) {
      showToast('Enter a message to broadcast');
      return;
    }

    const metadata = {
      name: text.slice(0, 30) + (text.length > 30 ? '...' : ''),
      type: 'text',
      description: text,
    };

    try {
      showToast('Broadcasting to IPFS...', 'info');

      // Publish to local Helia node — the post gossips to all swarm peers
      const encoder = new TextEncoder();
      const content = Array.from(encoder.encode(text));
      const localPost = await window.bucksAPI.ipfsPublish(content, metadata);

      showToast(`Broadcasted successfully! CID: ${localPost.cid.slice(0, 8)}…`, 'success');
      if (descInput) descInput.value = '';
      refreshIPFSFeed();
    } catch (e) {
      console.error('[Broadcast] Error:', e);
      showToast('Broadcast failed: ' + e.message, 'error');
    }
  });

  /* ── Publish ── */
  document.getElementById('btn-ipfs-publish').addEventListener('click', async () => {
    const fileInput = document.getElementById('ipfs-publish-file');
    const descInput = document.getElementById('ipfs-publish-desc');

    if (!fileInput.files.length) {
      showToast('Select a file to publish');
      return;
    }

    const file = fileInput.files[0];
    const metadata = {
      name: file.name,
      type: file.type || 'file',
      description: descInput.value || '',
    };

    try {
      showToast('Publishing to IPFS...', 'info');

      // Publish to local Helia node — the post gossips to all swarm peers
      const arrayBuffer = await file.arrayBuffer();
      const content = Array.from(new Uint8Array(arrayBuffer));
      const localPost = await window.bucksAPI.ipfsPublish(content, metadata);

      showToast(`Published successfully! CID: ${localPost.cid.slice(0, 8)}…`, 'success');
      descInput.value = '';
      fileInput.value = '';
      const label = document.querySelector('.ipfs-file-label');
      if (label) label.textContent = 'Choose File';

      refreshIPFSFeed();
    } catch (e) {
      console.error('[Publish] Error:', e);
      showToast('Publish failed: ' + e.message, 'error');
    }
  });

  // Update file label when file is selected
  document.getElementById('ipfs-publish-file').addEventListener('change', (e) => {
    const label = document.querySelector('.ipfs-file-label');
    label.textContent = e.target.files.length ? e.target.files[0].name : 'Choose File';
  });

  /* ── Feed Rendering ── */
  async function refreshIPFSFeed() {
    try {
      const container = document.getElementById('ipfs-feed');
      container.innerHTML = '<div class="skeleton-loader"><div class="skeleton-card"></div><div class="skeleton-card"></div></div>';

      // Fetch from the local Helia node — aggregates own posts + gossiped peer posts
      const feed = (await window.bucksAPI.ipfsFeed()) || [];

      if (!feed.length) {
        container.innerHTML = '<p class="tx-empty">No content yet. Publish something or connect to peers to see their posts.</p>';
        const dashFeed = document.getElementById('ipfs-dash-feed');
        if (dashFeed) dashFeed.innerHTML = container.innerHTML;
        return;
      }

      // Get current pinned status from local Helia node
      const stats = await window.bucksAPI.ipfsStorageStats();
      const pinnedCids = new Set((stats.pinnedItems || []).map(i => i.cid));

      container.innerHTML = feed.map(post => {
        const time = post.timestamp ? new Date(post.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : 'recently';
        const peerId = post.peerId || post.peer_id;
        const peerShort = peerId ? `${peerId.slice(0, 8)}…${peerId.slice(-4)}` : 'Unknown';
        const size = post.size ? formatSize(post.size) : (post.metadata?.size ? formatSize(post.metadata.size) : '');
        const isPinnedLocally = pinnedCids.has(post.cid);

        return `
          <div class="ipfs-feed-card fade-in">
            <div class="feed-header">
              <span class="feed-peer">${peerShort}</span>
              <span class="feed-time">${time}</span>
            </div>
            <div class="feed-body">
              <p class="feed-name">${escapeHtml(post.name || post.metadata?.name || 'Untitled')}</p>
              ${(post.description || post.metadata?.description) ? `<p class="feed-desc">${escapeHtml(post.description || post.metadata.description)}</p>` : ''}
            </div>
            <div class="feed-cid" title="Click to copy CID" onclick="navigator.clipboard.writeText('${post.cid}');window._showToast('CID copied!')">${post.cid}</div>
            <div class="feed-footer">
              <button class="btn-upvote ${isPinnedLocally ? 'upvoted' : ''}" onclick="window._ipfsUpvote('${post.cid}')">
                ${isPinnedLocally ? '🛡️ Hosting' : '👍 Upvote'}
              </button>
              <span class="feed-size">${size}</span>
            </div>
          </div>
        `;
      }).join('');

      const dashFeed = document.getElementById('ipfs-dash-feed');
      if (dashFeed) {
        dashFeed.innerHTML = container.innerHTML;
      }
    } catch (e) {
      console.error('[IPFS UI] Feed error:', e);
      const errMsg = `<p class="tx-empty" style="color:var(--danger)">IPFS node is still starting…</p>`;
      document.getElementById('ipfs-feed').innerHTML = errMsg;
      const dashFeed = document.getElementById('ipfs-dash-feed');
      if (dashFeed) dashFeed.innerHTML = errMsg;
    }
  }

  window._ipfsUpvote = async (cid) => {
    try {
      showToast('Sending appreciation...', 'info');

      // Co-Hosting: pin content locally — this node becomes a host for it
      const localRes = await window.bucksAPI.ipfsUpvote(cid);

      if (localRes.status === 'pinned') {
        showToast('Pinned & Hosting globally!', 'success');
      } else if (localRes.error) {
        showToast('Pin failed: ' + localRes.error, 'error');
      }
    } catch (e) {
      showToast('Integration Error', 'error');
    }

    refreshIPFSStatus();
    refreshIPFSFeed();
  };

  window._showToast = (msg) => showToast(msg);

  function formatSize(bytes) {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
  }

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  // Poll IPFS status every 5 seconds when panel is visible
  setInterval(() => {
    if (!ipfsSidebar.classList.contains('sidebar-hidden')) {
      refreshIPFSStatus();
    }
  }, 5000);

  /* ── Swarm Intelligence Dashboard ── */
  function refreshSwarmStatus(cluster) {
    const clusterBadge = $('#swarm-status-badge');
    if (clusterBadge) {
      clusterBadge.textContent = `Cluster: ${cluster.cidn}`;
      clusterBadge.classList.add('swarm-badge-active');
    }

    const peerList = $('#swarm-peer-list');
    if (peerList) {
      peerList.innerHTML = cluster.peers.map(p => `
      <div class="swarm-peer-card fade-in">
        <div class="peer-header">
          <span class="peer-id">${p.id.slice(0, 10)}…</span>
          <span class="peer-version">v${p.version}</span>
        </div>
        <div class="peer-stats">
          <div class="pheromone-bar">
            <div class="pheromone-level" style="width: ${(p.reputation / 200) * 100}%"></div>
          </div>
          <span class="reputation-text">${p.reputation} Ph</span>
        </div>
      </div>
    `).join('') || '<div class="empty-state">No other swarm nodes found.</div>';
    }

    if ($('#local-reputation')) $('#local-reputation').textContent = `${cluster.reputation} Ph\u00e9romones`;
  }

  /* ═══════════ AGENT BRAIN — Web-Intelligent Multi-Turn Chat ═══════════ */
  const SOUL_ENGINE = 'http://127.0.0.1:8765';
  let chatBusy = false;

  // Multi-turn conversation memory (shared across home chat bar + left panel)
  let agentConversation = []; // [{role:'user'|'assistant', text, sources}]

  function chatEl(id) {
    const navPanel = document.getElementById('nav-chat-panel');
    const isNavOpen = navPanel && !navPanel.classList.contains('hidden');
    if (isNavOpen) {
      let navId = id;
      if (id.startsWith('chat-')) {
        navId = 'nav-' + id;
      } else if (id === 'ephemeral-content') {
        navId = 'nav-ephemeral-content';
      }
      const el = document.getElementById(navId) || navPanel.querySelector('.' + id);
      if (el) return el;
    }
    return document.getElementById(id);
  }

  /* ── Intent Classification ── */
  // Shopping intent → deterministic product_lookup on the backend (real products,
  // images, buy links). Kept in sync with soul_engine.py::_is_shopping.
  function isShoppingQuery(q) {
    const m = ' ' + q.toLowerCase().trim() + ' ';
    const kw = ['buy ', 'shop ', 'shop for', 'purchase', 'cheapest', 'cheaper',
      'best price', 'for sale', 'add to cart', 'order online', 'where to buy',
      'shopping for', 'deals on', ' deals'];
    if (kw.some(k => m.includes(k))) return true;
    if (/\b(find|show|get)\s+me\s+(a|an|some|the best)\b/.test(m) &&
        /\b(buy|under|below|cheap|budget|₹|\$|rs\.?)\b/.test(m)) return true;
    return false;
  }

  // Media / research intents → deterministic ephemeral-UI pipelines on the
  // backend. Kept in sync with soul_engine.py::_is_video/_is_images/_is_research.
  function isMediaOrResearchQuery(q) {
    const s = q.trim();
    if (/^(play|watch)\b/i.test(s)) return true;
    if (/\b(youtube|music video|videos? (of|about)|trailer|listen to)\b/i.test(s)) return true;
    if (/\b(images?|photos?|pictures?|pics|wallpapers?)\s+(of|for|about)\b/i.test(s)) return true;
    if (/\b(show|find|get)\s+(me\s+)?(some\s+)?(images?|photos?|pictures?|pics|wallpapers?)\b/i.test(s)) return true;
    if (/^research\b|\b(deep|in-?depth)\s+(research|dive|analysis|report|insight)/i.test(s)) return true;
    if (/\b(detailed|comprehensive|full)\s+(report|analysis|overview|research)\b/i.test(s)) return true;
    if (/\btell me everything about\b/i.test(s)) return true;
    if (/^compare\b|\b(vs\.?|versus)\b/i.test(s)) return true;
    // Weather → deterministic weather_lookup + weather card (soul_engine.py::_is_weather)
    if (/\b(weather|forecast|temperature)\b/i.test(s)) return true;
    if (/\b(is it|will it)\s+(rain|snow|sunny|hot|cold|humid)/i.test(s)) return true;
    return false;
  }

  function classifyIntent(q) {
    const lower = q.toLowerCase().trim();

    // Explicit agent command prefix
    if (lower.startsWith('/agent')) return 'agent';

    // Shopping → route to the agent (deterministic product_lookup)
    if (isShoppingQuery(lower)) return 'shopping';

    // Location / directions intent (on map page only). The dashboard hides by
    // toggling #dashboard-window, so checking #view-newtab alone stays truthy
    // on web pages — require dashboard mode (not web-mode) as well, or every
    // short query typed over a website becomes a place search.
    const isMapPage = (() => {
      if (document.body.classList.contains('web-mode')) return false;
      const dw = document.getElementById('dashboard-window');
      if (dw && dw.classList.contains('hidden')) return false;
      const v = document.getElementById('view-newtab');
      return v && !v.classList.contains('hidden');
    })();
    if (isMapPage) {
      // "X to Y" routing pattern
      if (/^.+\s+to\s+.+$/i.test(lower)) return 'location';
      // Explicit directions
      if (/^(directions?|navigate|route|drive|walk|cycle)\s+(to|from)\s+/i.test(lower)) return 'location';
      // Bare place name — short queries (1-4 words) without question words
      if (lower.split(/\s+/).length <= 4
          && !/\b(what|who|when|why|how|is|are|was|were|does|do|can|will|should)\b/.test(lower)
          && !/\b(price|cost|buy|stock|weather|score|news|latest)\b/.test(lower)
          && !/^(go to|open|navigate to|visit|browse to|search for|find|look up|google|search)\s/.test(lower)
          && !/^https?:\/\//.test(lower)
          && !/^[a-z0-9-]+\.(com|org|net|io|ai|co|uk|gov|edu)\b/.test(lower)
          && !lower.startsWith('/')) {
        return 'location';
      }
    }

    // Browser actions
    if (/^(go to|open|navigate to|visit|browse to)\s+\S+/.test(lower)) return 'navigate';
    if (/^(search for|find|look up|google|search)\s+.+/.test(lower)) return 'search';
    if (/^new tab/.test(lower)) return 'new_tab';
    if (/^(close tab|close this tab)/.test(lower)) return 'close_tab';
    if (/^(back|go back)/.test(lower)) return 'back';
    if (/^(forward|go forward)/.test(lower)) return 'forward';
    if (/^(reload|refresh)/.test(lower)) return 'reload';
    if (/^(bookmark|save this page)/.test(lower)) return 'bookmark';

    // Web research intent
    if (/\b(what is|who is|what are|where is|when was|how does|why does|explain|define|tell me about)\b/.test(lower)) return 'research';
    if (/\b(latest|news|today|current|2024|2025|2026)\b/.test(lower)) return 'search';
    if (/\b(compare|vs|versus|difference between)\b/.test(lower)) return 'research';
    if (/\b(price|cost|buy|stock|weather|score)\b/.test(lower)) return 'search';
    if (/\bhow to\b/.test(lower)) return 'research';

    // Looks like a URL
    if (/^https?:\/\//.test(lower) || /^[a-z0-9-]+\.(com|org|net|io|ai|co|uk|gov|edu)\b/.test(lower)) return 'navigate';

    return 'chat';
  }

  /* ── NEXUS Inline Step Cards — Minimal Premium Design ──
   * Timeline-style step cards with left accent border.
   * No emojis, no heavy glows — clean, information-dense.
   */

  // Minimal SVG icons (14×14, inline, currentColor)
  const _NX_SVG = {
    thinking:       `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><circle cx="12" cy="12" r="10"/><path d="M12 8v4l2 2"/></svg>`,
    tool_call:      `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3-3a1 1 0 0 0-1.4-1.4l-3 3M5 21l8.4-8.4M15 5L19 9M3 9l4-4 4 4-4 4z"/></svg>`,
    tool_result:    `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6M9 13h6M9 17h4"/></svg>`,
    browser_action: `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><circle cx="12" cy="12" r="10"/><path d="M2 12h20M12 2a15 15 0 0 1 4 10 15 15 0 0 1-4 10 15 15 0 0 1-4-10 15 15 0 0 1 4-10z"/></svg>`,
    token:          `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>`,
    done:           `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M20 6L9 17l-5-5"/></svg>`,
    error:          `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><circle cx="12" cy="12" r="10"/><path d="M12 8v4M12 16h.01"/></svg>`,
    cancelled:      `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><circle cx="12" cy="12" r="10"/><path d="M15 9l-6 6M9 9l6 6"/></svg>`,
  };

  const _NX_STYLE = {
    thinking:       { accent: 'rgba(255,200,80,0.5)',  label: 'Thinking',        fg: 'rgba(255,200,80,0.85)' },
    tool_call:      { accent: 'rgba(120,180,255,0.5)', label: 'Tool',            fg: 'rgba(120,180,255,0.85)' },
    tool_result:    { accent: 'rgba(120,220,160,0.4)', label: 'Result',          fg: 'rgba(120,220,160,0.85)' },
    browser_action: { accent: 'rgba(255,160,80,0.5)',  label: 'Browser',         fg: 'rgba(255,160,80,0.85)' },
    token:          { accent: 'rgba(200,200,220,0.25)',label: 'Answer',          fg: 'rgba(200,200,220,0.6)' },
    done:           { accent: 'rgba(80,220,140,0.5)',  label: 'Done',            fg: 'rgba(80,220,140,0.85)' },
    error:          { accent: 'rgba(255,90,100,0.5)',  label: 'Error',           fg: 'rgba(255,100,110,0.85)' },
    cancelled:      { accent: 'rgba(150,150,170,0.4)', label: 'Stopped',         fg: 'rgba(150,150,170,0.7)' },
  };

  let _nxTokenCardEl = null;
  function _nxClearTokenCard() { _nxTokenCardEl = null; }

  window.openAgentLink = (url) => {
    if (!url) return;
    createTab(normalizeURL(url));
  };

  // Open the earth map and route between two places (called from ephemeral location cards)
  window._bucksLocationRoute = (from, to) => {
    if (window.BucksEarthMap) {
      window.BucksEarthMap.openAt(20, 0, 5);
      // Give the map a moment to open, then fill in routing fields and trigger
      setTimeout(() => {
        const fromInput = document.querySelector('.em-from');
        const toInput = document.querySelector('.em-to');
        if (fromInput) fromInput.value = from;
        if (toInput) toInput.value = to;
        // Trigger the directions panel and fetch route
        const dirBtn = document.querySelector('.em-dirbtn');
        if (dirBtn) dirBtn.click();
        // Use the earth-maps routeByNames if exposed
        if (window.BucksEarthMap.routeByNames) {
          window.BucksEarthMap.routeByNames(from, to);
        }
      }, 400);
    }
  };

  window.submitAgentFollowup = (encodedQuery) => {
    if (!encodedQuery) return;
    const query = decodeURIComponent(encodedQuery);
    const chatTab = document.getElementById('view-chat-tab');
    if (chatTab && !chatTab.classList.contains('hidden')) {
      sendChatTab(query);
    } else {
      const input = document.getElementById('chat-input') || document.getElementById('nt-search-input');
      if (input) {
        const q = query.startsWith('/') ? query : `/agent ${query}`;
        input.value = q;
        sendChat(q);
      }
    }
  };

  /* ═══════════════════════════════════════════════════════════════════════
     GENERATIVE UI — render predefined components from a spec.
     Spec shape: { component, title?, data }. See agent/genui.py for the
     builders. renderComponent(spec) returns an HTMLElement to append.
     ═══════════════════════════════════════════════════════════════════════ */

  // CTA action dispatcher — CTAs reference these by kind.
  window.__bucksGenUIAction = function (kind, value) {
    try {
      if (kind === 'navigate') {
        // Open the real destination in a browser tab (same path agent links use).
        if (value && window.openAgentLink) window.openAgentLink(value);
        else if (value) createTab(value);
      } else if (kind === 'search') {
        sendChat(value);
      } else if (kind === 'agent') {
        sendChat(value.startsWith('/agent') ? value : `/agent ${value}`);
      } else if (kind === 'copy') {
        navigator.clipboard?.writeText(value).catch(() => {});
      }
    } catch (e) { console.error('[GenUI] action failed', e); }
  };

  function _gu_esc(s) { return escapeHtml(String(s == null ? '' : s)); }

  // Attribute-safe escaping (escapeHtml leaves quotes intact, which breaks
  // inline attribute interpolation) — used by the media components below.
  function _gu_attr(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/"/g, '&quot;')
      .replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/'/g, '&#39;');
  }

  /* ── Ephemeral UI: media helpers (lightbox + YouTube player swap) ────────── */

  window.__bucksCloseLightbox = function () {
    const lb = document.getElementById('gu-lightbox');
    if (lb) lb.remove();
    document.removeEventListener('keydown', window.__bucksLightboxKey);
  };
  window.__bucksLightboxKey = function (e) {
    if (e.key === 'Escape') window.__bucksCloseLightbox();
  };

  // Open a full-size image overlay. Reads data-img / data-url / data-title
  // from the clicked element so no untrusted string rides inside onclick.
  window.__bucksLightboxFromEl = function (el) {
    if (!el) return;
    const img = el.getAttribute('data-img') || '';
    const url = el.getAttribute('data-url') || '';
    const title = el.getAttribute('data-title') || '';
    if (!/^https?:\/\//i.test(img)) return;
    window.__bucksCloseLightbox();
    const lb = document.createElement('div');
    lb.id = 'gu-lightbox';
    lb.innerHTML = `
      <div class="gu-lb-backdrop"></div>
      <div class="gu-lb-body">
        <img class="gu-lb-img" src="${_gu_attr(img)}" referrerpolicy="no-referrer"/>
        <div class="gu-lb-bar">
          <div class="gu-lb-title">${_gu_esc(title)}</div>
          <div class="gu-lb-actions">
            ${url ? `<button class="gu-cta gu-lb-open">Open source ↗</button>` : ''}
            <button class="gu-cta gu-lb-close">✕ Close</button>
          </div>
        </div>
      </div>`;
    lb.querySelector('.gu-lb-backdrop').addEventListener('click', window.__bucksCloseLightbox);
    lb.querySelector('.gu-lb-close').addEventListener('click', window.__bucksCloseLightbox);
    const openBtn = lb.querySelector('.gu-lb-open');
    if (openBtn) openBtn.addEventListener('click', () => {
      window.__bucksCloseLightbox();
      window.__bucksGenUIAction('navigate', url);
    });
    document.body.appendChild(lb);
    document.addEventListener('keydown', window.__bucksLightboxKey);
  };

  /* ── Global mini-player ────────────────────────────────────────────────────
     YouTube's iframe embed rejects the app's file:// page origin ("Error 153"),
     so in-message players can't work — and the chat re-renders its thread on
     every streamed chunk, which would reload any in-message player anyway.
     Instead, ONE floating dock on document.body hosts a <webview> (the embed
     loads as its own top-level document, origin youtube-nocookie.com, so it
     plays). Because it lives outside the chat DOM it keeps playing when the
     chat minimizes, closes, or re-renders — i.e. background play. Collapse (—)
     shrinks it to an audio pill without unloading the webview. */
  window.__bucksMiniPlayer = {
    _ensure() {
      let dock = document.getElementById('bucks-mini-player');
      if (dock) return dock;
      dock = document.createElement('div');
      dock.id = 'bucks-mini-player';
      dock.innerHTML = `
        <div class="mp-bar">
          <span class="mp-eq">♪</span>
          <span class="mp-title"></span>
          <button class="mp-btn mp-open" title="Open in YouTube tab">
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6M15 3h6v6M10 14L21 3"/></svg>
          </button>
          <button class="mp-btn mp-collapse" title="Collapse to audio pill (keeps playing)">
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"><path d="M5 12h14"/></svg>
          </button>
          <button class="mp-btn mp-close" title="Stop and close">✕</button>
        </div>
        <div class="mp-body"></div>`;
      dock.querySelector('.mp-open').addEventListener('click', () => {
        const vid = dock.dataset.vid || '';
        if (vid) window.__bucksGenUIAction('navigate', `https://www.youtube.com/watch?v=${vid}`);
        window.__bucksMiniPlayer.close();
      });
      dock.querySelector('.mp-collapse').addEventListener('click', () => {
        dock.classList.toggle('mp-min');
      });
      dock.querySelector('.mp-bar').addEventListener('click', (e) => {
        if (e.target.closest('button')) return;
        dock.classList.remove('mp-min');   // tap the pill to restore video
      });
      dock.querySelector('.mp-close').addEventListener('click', () => {
        window.__bucksMiniPlayer.close();
      });
      document.body.appendChild(dock);
      return dock;
    },
    // Rail context for auto-advance: when a video comes from a component,
    // the sibling rail items queue up so an unplayable embed skips ahead.
    _queue: [],
    _queuePos: -1,
    play(vid, title) {
      if (!/^[A-Za-z0-9_-]{6,20}$/.test(vid || '')) return;
      const dock = this._ensure();
      dock.dataset.vid = vid;
      dock.classList.remove('mp-min');
      dock.querySelector('.mp-title').textContent = title || 'Now playing';
      const body = dock.querySelector('.mp-body');
      const overlay = body.querySelector('.mp-error');
      if (overlay) overlay.remove();
      const src = `https://www.youtube-nocookie.com/embed/${vid}?autoplay=1&rel=0&playsinline=1`;
      let wv = body.querySelector('webview');
      if (wv) {
        wv.style.display = '';
        wv.src = src;
      } else {
        wv = document.createElement('webview');
        if (typeof IS_PRIVATE !== 'undefined' && IS_PRIVATE) wv.setAttribute('partition', 'bucks-private');
        wv.setAttribute('allowpopups', 'false');
        wv.src = src;
        body.appendChild(wv);
        wv.addEventListener('did-finish-load', () => {
          // Embed-restricted videos (error 150/152/153: "Playback on other
          // websites has been disabled") render YouTube's error UI instead of
          // firing any event we can catch — so probe the player DOM for it.
          setTimeout(() => window.__bucksMiniPlayer._checkEmbedError(), 1600);
        });
      }
      dock.classList.add('mp-visible');
    },
    async _checkEmbedError() {
      const dock = document.getElementById('bucks-mini-player');
      const wv = dock && dock.querySelector('.mp-body webview');
      if (!wv) return;
      let failed = false;
      try {
        failed = await wv.executeJavaScript(
          `!!document.querySelector('.ytp-error, .ytp-error-content-wrap')`, false);
      } catch (_) { return; }
      if (!failed) return;
      const vid = dock.dataset.vid || '';
      // Try the next video from the rail queue first — seamless recovery.
      if (this._queue.length && this._queuePos >= 0 && this._queuePos < this._queue.length - 1) {
        const next = this._queue[++this._queuePos];
        if (typeof showToast === 'function') showToast('Video can’t be embedded — playing next result', 'info');
        this._highlightRailItem(next.vid);
        this.play(next.vid, next.channel ? `${next.title} · ${next.channel}` : next.title);
        return;
      }
      // No queue left: friendly overlay with an open-in-tab escape hatch.
      const body = dock.querySelector('.mp-body');
      const wvEl = body.querySelector('webview');
      if (wvEl) wvEl.style.display = 'none';
      if (!body.querySelector('.mp-error')) {
        const ov = document.createElement('div');
        ov.className = 'mp-error';
        ov.innerHTML = `
          <div class="mp-error-msg">This video doesn’t allow embedded playback.</div>
          <button class="mp-error-open">Watch on YouTube ↗</button>`;
        ov.querySelector('.mp-error-open').addEventListener('click', () => {
          if (vid) window.__bucksGenUIAction('navigate', `https://www.youtube.com/watch?v=${vid}`);
          window.__bucksMiniPlayer.close();
        });
        body.appendChild(ov);
      }
    },
    _highlightRailItem(vid) {
      document.querySelectorAll('.gu-video').forEach((comp) => {
        comp.querySelectorAll('.gu-video-item').forEach((it) => {
          it.classList.toggle('active', it.getAttribute('data-vid') === vid);
        });
      });
    },
    close() {
      const dock = document.getElementById('bucks-mini-player');
      if (!dock) return;
      dock.querySelector('.mp-body').innerHTML = '';   // unload webview = stop audio
      dock.classList.remove('mp-visible', 'mp-min');
      dock.dataset.vid = '';
    },
  };

  // Play the clicked rail item's video in the global mini-player and move the
  // active highlight within this component.
  // Videos open on the real YouTube watch page in a NEW TAB (tabs are native
  // Chromium WebContentsViews now — full player, no embed restrictions, no
  // error 150/152/153). The embedded mini player kept mis-playing restricted
  // uploads, so tab playback is the primary path; __bucksMiniPlayer remains
  // for anything that still wants docked playback.
  window.__bucksPlayVideoFromEl = function (playerId, el) {
    if (!el) return;
    const vid = el.getAttribute('data-vid') || '';
    if (!/^[A-Za-z0-9_-]{6,20}$/.test(vid)) return;
    const title = el.getAttribute('data-title') || '';
    const channel = el.getAttribute('data-channel') || '';
    window.__bucksGenUIAction('navigate', `https://www.youtube.com/watch?v=${vid}`);
    const comp = el.closest('.gu-video');
    if (comp) {
      comp.querySelectorAll('.gu-video-item').forEach(it => it.classList.toggle('active', it === el));
      const now = comp.querySelector('.gu-video-now');
      if (now) now.textContent = `▶ ${title}${channel ? ' · ' + channel : ''} — playing in tab`;
    }
  };

  function _gu_faviconImg(favicon, domain) {
    const letter = (domain || '?').charAt(0).toUpperCase();
    if (!favicon) return `<div class="gu-favi gu-favi-fallback">${_gu_esc(letter)}</div>`;
    return `<img class="gu-favi" src="${_gu_esc(favicon)}" onerror="this.outerHTML='<div class=\\'gu-favi gu-favi-fallback\\'>${_gu_esc(letter)}</div>'"/>`;
  }

  // Build an inline-SVG chart (line | bar | pie). No external dependency.
  function _gu_chart(data) {
    const kind = data.kind || 'bar';
    const series = data.series || [];
    const W = 320, H = 160, pad = 26;
    if (!series.length) return '<div class="gu-empty">No chart data</div>';
    if (kind === 'pie') {
      const total = series.reduce((s, p) => s + (Number(p.value) || 0), 0) || 1;
      let a0 = -Math.PI / 2, cx = 80, cy = 80, r = 64, segs = '';
      const colors = ['#7b3fe4', '#52b6ff', '#2ed573', '#f7931a', '#ff4757', '#a978ff'];
      series.forEach((p, i) => {
        const frac = (Number(p.value) || 0) / total, a1 = a0 + frac * 2 * Math.PI;
        const x0 = cx + r * Math.cos(a0), y0 = cy + r * Math.sin(a0);
        const x1 = cx + r * Math.cos(a1), y1 = cy + r * Math.sin(a1);
        const large = frac > 0.5 ? 1 : 0;
        segs += `<path d="M${cx},${cy} L${x0.toFixed(1)},${y0.toFixed(1)} A${r},${r} 0 ${large} 1 ${x1.toFixed(1)},${y1.toFixed(1)} Z" fill="${colors[i % colors.length]}" opacity="0.85"/>`;
        a0 = a1;
      });
      const legend = series.map((p, i) => `<div class="gu-legend-item"><span class="gu-legend-dot" style="background:${colors[i % colors.length]}"></span>${_gu_esc(p.label)} (${_gu_esc(p.value)})</div>`).join('');
      return `<div class="gu-chart-wrap"><svg viewBox="0 0 160 160" width="160" height="160">${segs}</svg><div class="gu-legend">${legend}</div></div>`;
    }
    // line/bar share axis math
    const pts = series[0].points || series.map(s => ({ x: s.label, y: s.value }));
    const ys = pts.map(p => Number(p.y) || 0);
    const maxY = Math.max(...ys, 1), minY = Math.min(...ys, 0);
    const span = (maxY - minY) || 1;
    const n = pts.length;
    const xStep = (W - pad * 2) / Math.max(n - 1, 1);
    const sx = i => pad + i * xStep;
    const sy = v => H - pad - ((v - minY) / span) * (H - pad * 2);
    let body = '';
    if (kind === 'line') {
      const d = pts.map((p, i) => `${i ? 'L' : 'M'}${sx(i).toFixed(1)},${sy(Number(p.y) || 0).toFixed(1)}`).join(' ');
      body = `<path d="${d}" fill="none" stroke="#7b3fe4" stroke-width="2.5"/>` +
        pts.map((p, i) => `<circle cx="${sx(i).toFixed(1)}" cy="${sy(Number(p.y) || 0).toFixed(1)}" r="3" fill="#a978ff"/>`).join('');
    } else {
      const bw = Math.min(xStep * 0.6, 34);
      body = pts.map((p, i) => {
        const yv = sy(Number(p.y) || 0);
        return `<rect x="${(sx(i) - bw / 2).toFixed(1)}" y="${yv.toFixed(1)}" width="${bw.toFixed(1)}" height="${Math.max(H - pad - yv, 1).toFixed(1)}" rx="3" fill="#7b3fe4" opacity="0.85"/>`;
      }).join('');
    }
    const labels = pts.map((p, i) => `<text x="${sx(i).toFixed(1)}" y="${H - 8}" text-anchor="middle" font-size="9" fill="rgba(255,255,255,0.4)">${_gu_esc(String(p.x).slice(0, 6))}</text>`).join('');
    return `<div class="gu-chart-wrap"><svg viewBox="0 0 ${W} ${H}" width="100%" height="${H}">${body}${labels}</svg></div>`;
  }

  // ─── Dynamic Product Grid Engine ───
  window.__productGrids = new Map();

  function parseNumericPrice(priceStr) {
    if (!priceStr) return 0;
    const clean = String(priceStr).replace(/,/g, '');
    const match = clean.match(/[\d.]+/);
    return match ? parseFloat(match[0]) : 0;
  }

  window.__renderProductGridHTML = function(gridId) {
    const gridData = window.__productGrids.get(gridId);
    if (!gridData) return '<div class="gu-empty">No products.</div>';

    const { items, limit, sortBy, filterBy } = gridData;

    // Apply filter
    let filtered = [...items];
    if (filterBy === 'low') {
      filtered = filtered.filter(p => {
        const val = parseNumericPrice(p.price);
        return val > 0 && val < 1000;
      });
    } else if (filterBy === 'high') {
      filtered = filtered.filter(p => {
        const val = parseNumericPrice(p.price);
        return val >= 1000 || (p.price && p.price.includes('$') && val >= 50);
      });
    } else if (filterBy === 'rating') {
      filtered = filtered.filter(p => p.rating && parseFloat(p.rating) >= 4.0);
    }

    // Apply sort
    if (sortBy === 'price-asc') {
      filtered.sort((a, b) => parseNumericPrice(a.price) - parseNumericPrice(b.price));
    } else if (sortBy === 'price-desc') {
      filtered.sort((a, b) => parseNumericPrice(b.price) - parseNumericPrice(a.price));
    } else if (sortBy === 'rating-desc') {
      filtered.sort((a, b) => (parseFloat(b.rating) || 0) - (parseFloat(a.rating) || 0));
    }

    const totalCount = items.length;
    const showingCount = Math.min(limit, filtered.length);
    const visibleItems = filtered.slice(0, showingCount);

    const cardsHtml = visibleItems.map(p => {
      const kind = p.url ? 'navigate' : 'search';
      const target = p.url || p.title;
      const imgHtml = p.image
        ? `<img src="${_gu_esc(p.image)}" loading="lazy" referrerpolicy="no-referrer"
                onerror="this.parentElement.innerHTML='<div class=\\'gu-product-noimg\\'>🛍️</div>'"/>`
        : '<div class="gu-product-noimg">🛍️</div>';

      return `
      <div class="gu-product gu-product--click" onclick="window.__bucksGenUIAction('${kind}','${_gu_esc(target).replace(/'/g, "\\'")}')" title="${p.url ? 'Open ' + _gu_esc(p.url) : 'Search ' + _gu_esc(p.title)}">
        <div class="gu-product-img">${imgHtml}</div>
        <div class="gu-product-title">${_gu_esc(p.title)}</div>
        <div class="gu-product-meta">
          <span class="gu-product-price">${_gu_esc(p.price)}</span>
          ${p.rating != null ? `<span class="gu-product-rating">★ ${_gu_esc(p.rating)}</span>` : ''}
        </div>
        ${p.badge ? `<span class="gu-product-badge">${_gu_esc(p.badge)}</span>` : ''}
        <div class="gu-product-actions" onclick="event.stopPropagation();">
          <button class="gu-cta gu-product-cta" onclick="window.__bucksGenUIAction('${kind}','${_gu_esc(target).replace(/'/g, "\\'")}')">${p.url ? 'View & Buy' : 'View'}</button>
          <button class="gu-cta gu-product-ask" onclick="window.__askAboutProduct('${_gu_esc(p.title).replace(/'/g, "\\'")}')" title="Ask AI about this product">💬</button>
        </div>
      </div>`;
    }).join('');

    const hasMore = showingCount < filtered.length;
    const viewMoreBtn = hasMore
      ? `<button class="gu-cta gu-view-more" onclick="window.__viewMoreProducts('${gridId}')">View More (${filtered.length - showingCount} left)</button>`
      : '';

    const toolbarHtml = `
      <div class="gu-product-toolbar">
        <span class="gu-product-count">${totalCount} products found</span>
        <div class="gu-product-controls">
          <select class="gu-select" onchange="window.__filterProductGrid('${gridId}', this.value)">
            <option value="all" ${filterBy === 'all' ? 'selected' : ''}>All Prices</option>
            <option value="low" ${filterBy === 'low' ? 'selected' : ''}>Under $50 / ₹1000</option>
            <option value="high" ${filterBy === 'high' ? 'selected' : ''}>Over $50 / ₹1000</option>
            <option value="rating" ${filterBy === 'rating' ? 'selected' : ''}>4★ & above</option>
          </select>
          <select class="gu-select" onchange="window.__sortProductGrid('${gridId}', this.value)">
            <option value="default" ${sortBy === 'default' ? 'selected' : ''}>Featured</option>
            <option value="price-asc" ${sortBy === 'price-asc' ? 'selected' : ''}>Price: Low-High</option>
            <option value="price-desc" ${sortBy === 'price-desc' ? 'selected' : ''}>Price: High-Low</option>
            <option value="rating-desc" ${sortBy === 'rating-desc' ? 'selected' : ''}>Rating</option>
          </select>
        </div>
      </div>
    `;

    return `
      <div class="gu-product-grid-wrapper" id="${gridId}_wrap">
        ${toolbarHtml}
        <div class="gu-product-grid">${cardsHtml}</div>
        ${viewMoreBtn}
      </div>
    `;
  };

  window.__filterProductGrid = function(gridId, filterValue) {
    const gridData = window.__productGrids.get(gridId);
    if (gridData) {
      gridData.filterBy = filterValue;
      gridData.limit = 3;
      const wrap = document.getElementById(`${gridId}_wrap`);
      if (wrap) {
        wrap.outerHTML = window.__renderProductGridHTML(gridId);
      }
    }
  };

  window.__sortProductGrid = function(gridId, sortValue) {
    const gridData = window.__productGrids.get(gridId);
    if (gridData) {
      gridData.sortBy = sortValue;
      const wrap = document.getElementById(`${gridId}_wrap`);
      if (wrap) {
        wrap.outerHTML = window.__renderProductGridHTML(gridId);
      }
    }
  };

  window.__viewMoreProducts = function(gridId) {
    const gridData = window.__productGrids.get(gridId);
    if (gridData) {
      gridData.limit += 6;
      const wrap = document.getElementById(`${gridId}_wrap`);
      if (wrap) {
        wrap.outerHTML = window.__renderProductGridHTML(gridId);
      }
    }
  };

  window.__askAboutProduct = function(title) {
    const query = `Tell me more about the product: ${title}`;
    const viewChatTab = document.getElementById('view-chat-tab');
    if (viewChatTab && !viewChatTab.classList.contains('hidden')) {
      sendChatTab(query);
    } else {
      const ntInput = document.getElementById('nt-search-input');
      if (ntInput) {
        ntInput.value = query;
        dockChatPanel();
        sendChat(query);
        ntInput.value = '';
      }
    }
  };

  // ─── Translate Slash Commands for LLM Agent ───
  function translateSlashCommand(val) {
    const trimmed = (val || '').trim();
    if (!trimmed.startsWith('/')) return trimmed;

    const lower = trimmed.toLowerCase();
    if (lower.startsWith('/product lookup ')) {
      return `Look up products for: ${trimmed.substring(16).trim()}`;
    }
    if (lower === '/product lookup') {
      return 'Look up products';
    }
    if (lower.startsWith('/content scrap ')) {
      return `Scrape the text content of: ${trimmed.substring(15).trim()}`;
    }
    if (lower === '/content scrap') {
      return 'Scrape web page content';
    }
    if (lower.startsWith('/content scrape ')) {
      return `Scrape the text content of: ${trimmed.substring(16).trim()}`;
    }
    if (lower === '/content scrape') {
      return 'Scrape web page content';
    }

    const spaceIdx = trimmed.indexOf(' ');
    const cmd = spaceIdx !== -1 ? trimmed.substring(0, spaceIdx) : trimmed;
    const arg = spaceIdx !== -1 ? trimmed.substring(spaceIdx + 1).trim() : '';

    switch (cmd.toLowerCase()) {
      case '/search':
        return arg ? `Search the web for: ${arg}` : 'Search the web';
      case '/product-lookup':
      case '/product':
        return arg ? `Look up products for: ${arg}` : 'Look up products';
      case '/scrape':
        return arg ? `Scrape the text content of: ${arg}` : 'Scrape web page content';
      case '/summarize':
      case '/summerize':
        return arg ? `Read and summarize the web page at: ${arg}` : 'Read and summarize page';
      case '/images':
      case '/image':
        return arg ? `Show me images of ${arg}` : 'Search for images';
      case '/video':
      case '/play':
        return arg ? `Play ${arg}` : 'Play a video';
      case '/research':
        return arg ? `Research ${arg}` : 'Run deep research';
      case '/weather':
        return arg ? `What's the weather in ${arg}?` : 'Show the weather';
      case '/links':
        return arg ? `Extract all links from the page at: ${arg}` : 'Extract page links';
      case '/code':
        return arg ? `Execute this code in the sandbox: ${arg}` : 'Execute code in sandbox';
      case '/calendar-list':
        return 'List my calendar events';
      case '/calendar-add':
        return arg ? `Add a calendar event with details: ${arg}` : 'Add calendar event';
      case '/track':
        return arg ? `Track order status for: ${arg}` : 'Track shipment status';
      case '/ipfs-upload':
        return arg ? `Upload this text to IPFS: ${arg}` : 'Upload text to IPFS';
      case '/ipfs-cat':
        return arg ? `Read text content from IPFS CID: ${arg}` : 'Read content from IPFS';
      case '/ipfs-load':
        return arg ? `Load custom agent tool from IPFS CID: ${arg}` : 'Load dynamic tool from IPFS';
      default:
        return trimmed;
    }
  }

  // ─── Slash Command Autocomplete Auto-Suggestions ───
  function setupCommandSuggestions(inputEl, parentEl, offsetLeftRight = false) {
    let activeIndex = 0;
    let dropdown = null;

    const commands = [
      // Local Views
      { cmd: '/wallet', desc: 'Open Wallet view. Check balances and transactions.', keywords: ['wallet', 'money', 'send', 'crypto'] },
      { cmd: '/ipfs', desc: 'Explore decentralized IPFS content and follow peers.', keywords: ['ipfs', 'dweb', 'social', 'publish'] },
      { cmd: '/files', desc: 'Launch File Manager to browse downloads and local files.', keywords: ['files', 'manager', 'explorer', 'downloads'] },
      { cmd: '/studio', desc: 'DWeb Studio creator interface. Build decentralized applications.', keywords: ['studio', 'dweb', 'creator', 'build'] },
      { cmd: '/history', desc: 'Open History dashboard. Search your navigation timeline.', keywords: ['history', 'tabs', 'visits'] },
      { cmd: '/bookmarks', desc: 'Open Bookmarks manager. View and load saved sites.', keywords: ['bookmarks', 'saved', 'favorites'] },
      { cmd: '/settings', desc: 'Browser configurations. Toggle adblocker and settings.', keywords: ['settings', 'config', 'adblock'] },
      { cmd: '/agent', desc: 'Agentic browser control. Run autonomous agent steps.', keywords: ['agent', 'browser', 'control', 'click', 'type'] },

      // Skillsets
      { cmd: '/search', desc: 'DDG Web Search. Search the web and synthesize results.', keywords: ['search', 'web', 'google', 'find'] },
      { cmd: '/product-lookup', desc: 'Product Search. Fetch real products from trusted retailers.', keywords: ['product', 'shopping', 'lookup', 'buy', 'price'] },
      { cmd: '/scrape', desc: 'Scrape Content. Fetch clean readable text from a URL.', keywords: ['scrape', 'fetch', 'url', 'read', 'text'] },
      { cmd: '/images', desc: 'Image Gallery. Search the web for images, tap to view full-size.', keywords: ['images', 'photos', 'pictures', 'gallery', 'wallpaper'] },
      { cmd: '/video', desc: 'Play Videos. Search YouTube and play right here in chat.', keywords: ['video', 'play', 'watch', 'youtube', 'music'] },
      { cmd: '/research', desc: 'Deep Research. Multi-source dossier with insights, images & sources.', keywords: ['research', 'deep', 'report', 'insight', 'analysis'] },
      { cmd: '/weather', desc: 'Weather Card. Current conditions and multi-day forecast for any place.', keywords: ['weather', 'forecast', 'temperature', 'rain'] },
      { cmd: '/summarize', desc: 'Summarize Page. Read and synthesize webpage contents.', keywords: ['summarize', 'summary', 'page', 'read', 'article'] },
      { cmd: '/links', desc: 'Extract Links. Extract all hyperlinks from a webpage.', keywords: ['links', 'extract', 'href', 'url'] },
      { cmd: '/code', desc: 'Run Code. Execute Python, JS, or Bash in a sandbox.', keywords: ['code', 'run', 'python', 'javascript', 'bash'] },
      { cmd: '/calendar-list', desc: 'List Calendar. List all events scheduled in calendar.', keywords: ['calendar', 'events', 'list', 'schedule'] },
      { cmd: '/calendar-add', desc: 'Add Calendar. Add a new event to your calendar.', keywords: ['calendar', 'add', 'event', 'new'] },
      { cmd: '/track', desc: 'Track Shipment. Retrieve shipping and delivery updates.', keywords: ['track', 'order', 'shipment', 'dhl', 'fedex'] },
      { cmd: '/ipfs-upload', desc: 'IPFS Upload. Upload text content to IPFS.', keywords: ['ipfs', 'upload', 'text', 'cid'] },
      { cmd: '/ipfs-cat', desc: 'IPFS Retrieve. Read and fetch text content from a CID.', keywords: ['ipfs', 'cat', 'cid', 'retrieve'] },
      { cmd: '/ipfs-load', desc: 'IPFS Load Tool. Dynamically load an agent tool from IPFS.', keywords: ['ipfs', 'load', 'tool', 'plugin'] }
    ];

    function renderDropdown(filtered) {
      if (dropdown) dropdown.remove();
      if (filtered.length === 0) return;

      dropdown = document.createElement('div');
      dropdown.className = 'command-suggestions-dropdown';
      if (offsetLeftRight) {
        dropdown.style.left = '14px';
        dropdown.style.right = '14px';
      } else {
        dropdown.style.left = '0';
        dropdown.style.right = '0';
      }

      filtered.forEach((cmd, idx) => {
        const item = document.createElement('div');
        item.className = `command-suggestion-item ${idx === activeIndex ? 'active' : ''}`;
        item.innerHTML = `
          <div class="command-suggestion-header">
            <span class="command-suggestion-cmd">${escapeHtml(cmd.cmd)}</span>
          </div>
          <div class="command-suggestion-desc">${escapeHtml(cmd.desc)}</div>
        `;
        item.addEventListener('click', () => {
          inputEl.value = cmd.cmd + ' ';
          inputEl.focus();
          cleanup();
        });
        dropdown.appendChild(item);
      });

      parentEl.appendChild(dropdown);
    }

    function cleanup() {
      if (dropdown) {
        dropdown.remove();
        dropdown = null;
      }
      activeIndex = 0;
    }

    inputEl.addEventListener('input', () => {
      const val = inputEl.value;
      if (val.startsWith('/')) {
        const query = val.toLowerCase();
        // If there is a space, they are typing their query/arguments. Dismiss suggestions.
        if (query.includes(' ')) {
          cleanup();
          return;
        }
        const filtered = commands.filter(c => 
          c.cmd.startsWith(query) || 
          c.keywords.some(k => k.startsWith(query.substring(1)))
        );
        activeIndex = Math.min(activeIndex, Math.max(0, filtered.length - 1));
        renderDropdown(filtered);
      } else {
        cleanup();
      }
    });

    inputEl.addEventListener('keydown', (e) => {
      if (!dropdown) return;

      const items = dropdown.querySelectorAll('.command-suggestion-item');
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        activeIndex = (activeIndex + 1) % items.length;
        items.forEach((item, idx) => {
          item.classList.toggle('active', idx === activeIndex);
        });
        items[activeIndex].scrollIntoView({ block: 'nearest' });
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        activeIndex = (activeIndex - 1 + items.length) % items.length;
        items.forEach((item, idx) => {
          item.classList.toggle('active', idx === activeIndex);
        });
        items[activeIndex].scrollIntoView({ block: 'nearest' });
      } else if (e.key === 'Enter') {
        const activeItem = items[activeIndex];
        if (activeItem) {
          e.preventDefault();
          e.stopPropagation();
          const cmdText = activeItem.querySelector('.command-suggestion-cmd').textContent;
          inputEl.value = cmdText + ' ';
          inputEl.focus();
          cleanup();
        }
      } else if (e.key === 'Escape') {
        e.preventDefault();
        cleanup();
      }
    });

    document.addEventListener('click', (e) => {
      if (dropdown && !parentEl.contains(e.target)) {
        cleanup();
      }
    });
  }

  const _GENUI_RENDERERS = {
    answer(d) {
      const parsed = formatNexusAnswer(d.markdown || d.text || '');
      return `<div class="gu-answer">${parsed.html}</div>`;
    },
    list(d) {
      const items = (d.items || []).map(it => `
        <a class="gu-list-item" href="#" onclick="window.__bucksGenUIAction('navigate','${_gu_esc(it.url)}');event.preventDefault();">
          ${_gu_faviconImg(it.favicon, it.domain)}
          <div class="gu-list-body">
            <div class="gu-list-title">${_gu_esc(it.title)}</div>
            <div class="gu-list-sub">${_gu_esc(it.subtitle)}</div>
            <div class="gu-list-domain">${_gu_esc(it.domain)}</div>
          </div>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="gu-list-arrow"><path d="M7 17L17 7M17 7H8M17 7v9"/></svg>
        </a>`).join('');
      return `<div class="gu-list">${items}</div>`;
    },
    cta_row(d) {
      const btns = (d.actions || []).map(a => `
        <button class="gu-cta" onclick="window.__bucksGenUIAction('${_gu_esc(a.kind || 'search')}','${_gu_esc(a.value || a.label)}')">${_gu_esc(a.label)}</button>`).join('');
      return `<div class="gu-cta-row">${btns}</div>`;
    },
    product_grid(d) {
      const PAGE = 8;
      const cards = (d.items || []).map((p, i) => {
        // Clicking anywhere on the card (or View) opens the real listing when we
        // have its URL; otherwise it searches the product name.
        const kind = p.url ? 'navigate' : 'search';
        const target = _gu_esc(p.url || p.title);
        const imgHtml = p.image
          ? `<img src="${_gu_esc(p.image)}" loading="lazy" referrerpolicy="no-referrer"
                  onerror="this.parentElement.innerHTML='<div class=\\'gu-product-noimg\\'>🛍️</div>'"/>`
          : '<div class="gu-product-noimg">🛍️</div>';
        return `
        <div class="gu-product gu-product--click${i >= PAGE ? ' gu-hidden' : ''}" onclick="window.__bucksGenUIAction('${kind}','${target}')" title="${p.url ? 'Open ' + _gu_esc(p.url) : 'Search ' + _gu_esc(p.title)}">
          <div class="gu-product-img">${imgHtml}</div>
          <div class="gu-product-title">${_gu_esc(p.title)}</div>
          <div class="gu-product-meta">
            <span class="gu-product-price">${_gu_esc(p.price)}</span>
            ${p.rating != null ? `<span class="gu-product-rating">★ ${_gu_esc(p.rating)}</span>` : ''}
          </div>
          ${p.badge ? `<span class="gu-product-badge">${_gu_esc(p.badge)}</span>` : ''}
          <button class="gu-cta gu-product-cta" onclick="event.stopPropagation();window.__bucksGenUIAction('${kind}','${target}')">${p.url ? 'View & Buy' : 'View'}</button>
        </div>`;
      }).join('');
      // Optional shopping follow-up actions (cheaper / top-rated / refine).
      const actions = (d.actions || []).map(a =>
        `<button class="gu-cta gu-shop-action" onclick="window.__bucksGenUIAction('${_gu_esc(a.kind || 'agent')}','${_gu_esc(a.value || a.label)}')">${_gu_esc(a.label)}</button>`
      ).join('');
      const actionRow = actions ? `<div class="gu-cta-row gu-shop-actions">${actions}</div>` : '';
      const items = d.items || [];
      return `<div class="gu-more-scope"><div class="gu-product-grid">${cards}</div>${actionRow}${_gu_moreBtn('product', d.query || '', items.length > PAGE)}</div>`;
    },
    stat_cards(d) {
      const cards = (d.stats || []).map(s => `
        <div class="gu-stat">
          <div class="gu-stat-label">${_gu_esc(s.label)}</div>
          <div class="gu-stat-value">${_gu_esc(s.value)}</div>
          ${s.delta != null ? `<div class="gu-stat-delta ${String(s.delta).startsWith('-') ? 'down' : 'up'}">${_gu_esc(s.delta)}</div>` : ''}
        </div>`).join('');
      return `<div class="gu-stat-cards">${cards}</div>`;
    },
    table(d) {
      const cols = d.columns || [];
      const head = `<tr>${cols.map(c => `<th>${_gu_esc(c)}</th>`).join('')}</tr>`;
      const rows = (d.rows || []).map(r => `<tr>${r.map(cell => `<td>${_gu_esc(cell)}</td>`).join('')}</tr>`).join('');
      return `<div class="gu-table-wrap"><table class="gu-table"><thead>${head}</thead><tbody>${rows}</tbody></table></div>`;
    },
    chart(d) { return _gu_chart(d); },
    image_gallery(d) {
      const items = (d.items || []).filter(it => it.image || it.thumbnail);
      if (!items.length) return '<div class="gu-empty">No images found.</div>';
      const PAGE = 12;
      const cells = items.map((it, i) => `
        <div class="gu-img-cell${i >= PAGE ? ' gu-hidden' : ''}"
             data-img="${_gu_attr(it.image || it.thumbnail)}"
             data-url="${_gu_attr(it.url || '')}"
             data-title="${_gu_attr(it.title || '')}"
             onclick="window.__bucksLightboxFromEl(this)"
             title="${_gu_attr(it.title || 'View full size')}">
          <img src="${_gu_attr(it.thumbnail || it.image)}" loading="lazy" referrerpolicy="no-referrer"
               onerror="this.closest('.gu-img-cell').style.display='none'"/>
          ${it.source ? `<div class="gu-img-cap">${_gu_esc(it.source)}</div>` : ''}
        </div>`).join('');

      const query = d.query || d.title?.replace("Images — “", "")?.replace("”", "") || "";
      return `<div class="gu-image-gallery-container gu-more-scope" style="display:flex; flex-direction:column; width:100%;">
                <div class="gu-image-gallery">${cells}</div>
                ${_gu_moreBtn('images', query, items.length > PAGE)}
              </div>`;
    },
    video(d) {
      const vids = (d.videos || []).filter(v => /^[A-Za-z0-9_-]{6,20}$/.test(v.videoId || ''));
      if (!vids.length) return '<div class="gu-empty">No playable videos found.</div>';
      const PAGE = 8;
      const pid = 'gu-yt-' + Math.random().toString(36).slice(2, 10);
      const first = vids[0];
      const rail = vids.map((v, i) => `
        <div class="gu-video-item${i === 0 ? ' active' : ''}${i >= PAGE ? ' gu-hidden' : ''}"
             data-vid="${_gu_attr(v.videoId)}"
             data-title="${_gu_attr(v.title)}"
             data-channel="${_gu_attr(v.channel || '')}"
             onclick="window.__bucksPlayVideoFromEl('${pid}', this)">
          <div class="gu-video-thumb">
            <img src="${_gu_attr(v.thumbnail)}" loading="lazy" referrerpolicy="no-referrer"/>
            ${v.duration ? `<span class="gu-video-dur">${_gu_esc(v.duration)}</span>` : ''}
          </div>
          <div class="gu-video-meta">
            <div class="gu-video-title">${_gu_esc(v.title)}</div>
            <div class="gu-video-sub">${_gu_esc(v.channel || '')}${v.views ? ' · ' + _gu_esc(v.views) : ''}</div>
          </div>
        </div>`).join('');
      // Playback opens the real YouTube watch page in a NEW TAB (native
      // WebContentsView — no embed restrictions). The hero is the top result;
      // rail thumbnails open their own tabs.
      const query = d.query || '';
      return `<div class="gu-video gu-more-scope">
        <div class="gu-video-player gu-video-hero"
             data-vid="${_gu_attr(first.videoId)}"
             data-title="${_gu_attr(first.title)}"
             data-channel="${_gu_attr(first.channel || '')}"
             onclick="window.__bucksPlayVideoFromEl('${pid}', this)"
             title="Play in a new tab">
          <img src="${_gu_attr(first.thumbnail)}" referrerpolicy="no-referrer"/>
          <div class="gu-video-playbtn">
            <svg width="24" height="24" viewBox="0 0 24 24" fill="white"><path d="M8 5v14l11-7z"/></svg>
          </div>
          <button class="gu-video-openyt" title="Open on YouTube"
            onclick="event.stopPropagation();window.__bucksGenUIAction('navigate','https://www.youtube.com/watch?v=${_gu_attr(first.videoId)}')">YouTube ↗</button>
        </div>
        <div class="gu-video-now">${_gu_esc(first.title)}${first.channel ? ' · ' + _gu_esc(first.channel) : ''}</div>
        ${vids.length > 1 ? `<div class="gu-video-rail">${rail}</div>` : ''}
        ${_gu_moreBtn('video', query, vids.length > PAGE)}
      </div>`;
    },
    weather(d) {
      const cur = d.current || {};
      const days = (d.days || []).slice(0, 7);
      const num = v => (v == null || v === '' ? '—' : Math.round(Number(v)));
      const strip = days.length ? `<div class="gu-wx-strip">${days.map(day => `
        <div class="gu-wx-day">
          <div class="gu-wx-day-name">${_gu_esc(day.day)}</div>
          <div class="gu-wx-day-icon">${_gu_esc(day.icon || '🌡️')}</div>
          <div class="gu-wx-day-temps"><b>${num(day.high_c)}°</b> <span>${num(day.low_c)}°</span></div>
        </div>`).join('')}</div>` : '';
      return `<div class="gu-weather">
        <div class="gu-wx-now">
          <div class="gu-wx-icon">${_gu_esc(cur.icon || '🌡️')}</div>
          <div class="gu-wx-main">
            <div class="gu-wx-temp">${num(cur.temp_c)}°C</div>
            <div class="gu-wx-cond">${_gu_esc(cur.condition || '')}</div>
          </div>
          <div class="gu-wx-meta">
            ${cur.feels_c != null ? `<div>Feels like ${num(cur.feels_c)}°C</div>` : ''}
            ${cur.wind_kmh != null ? `<div>Wind ${num(cur.wind_kmh)} km/h</div>` : ''}
            ${cur.humidity != null ? `<div>Humidity ${num(cur.humidity)}%</div>` : ''}
          </div>
        </div>
        ${strip}
      </div>`;
    },
    timeline(d) {
      const events = d.events || [];
      if (!events.length) return '<div class="gu-empty">No events.</div>';
      return `<div class="gu-timeline">${events.map(ev => `
        <div class="gu-tl-item">
          <div class="gu-tl-marker"><span class="gu-tl-dot"></span><span class="gu-tl-line"></span></div>
          <div class="gu-tl-body">
            <div class="gu-tl-date">${_gu_esc(ev.date || '')}</div>
            <div class="gu-tl-title">${_gu_esc(ev.title || '')}</div>
            ${ev.text ? `<div class="gu-tl-text">${_gu_esc(ev.text)}</div>` : ''}
          </div>
        </div>`).join('')}</div>`;
    },
    checklist(d) {
      const items = d.items || [];
      if (!items.length) return '<div class="gu-empty">Empty list.</div>';
      return `<div class="gu-checklist">${items.map(it => {
        const text = typeof it === 'string' ? it : (it.text || '');
        const done = typeof it === 'object' && !!it.done;
        return `
        <div class="gu-check-item${done ? ' done' : ''}" onclick="this.classList.toggle('done')">
          <span class="gu-check-box"></span>
          <span class="gu-check-text">${_gu_esc(text)}</span>
        </div>`;
      }).join('')}</div>`;
    },
    accordion(d) {
      const items = (d.items || []).filter(it => it && (it.heading || it.q));
      if (!items.length) return '<div class="gu-empty">Nothing to show.</div>';
      return `<div class="gu-accordion">${items.map((it, i) => `
        <details class="gu-acc-item"${i === 0 ? ' open' : ''}>
          <summary class="gu-acc-head">${_gu_esc(it.heading || it.q)}</summary>
          <div class="gu-acc-body">${_gu_esc(it.text || it.a || '')}</div>
        </details>`).join('')}</div>`;
    },
    code(d) {
      const code = String(d.code || '');
      if (!code.trim()) return '<div class="gu-empty">No code.</div>';
      const lang = _gu_esc(d.language || '');
      return `<div class="gu-code">
        <div class="gu-code-bar">
          <span class="gu-code-lang">${lang || 'code'}</span>
          <button class="gu-cta gu-code-copy"
            onclick="navigator.clipboard.writeText(this.closest('.gu-code').querySelector('code').textContent).then(()=>{this.textContent='Copied ✓';setTimeout(()=>this.textContent='Copy',1200);})">Copy</button>
        </div>
        <pre class="gu-code-pre"><code>${_gu_esc(code)}</code></pre>
      </div>`;
    },
    research(d) {
      const hero = d.hero && /^https?:\/\//i.test(d.hero) ? `
        <div class="gu-res-hero">
          <img src="${_gu_attr(d.hero)}" referrerpolicy="no-referrer"
               onerror="this.closest('.gu-res-hero').style.display='none'"/>
          <div class="gu-res-hero-title">${_gu_esc(d.topic || '')}</div>
        </div>` : '';
      const summary = d.summary ? `<div class="gu-res-summary">${_gu_esc(d.summary)}</div>` : '';
      const stats = (d.stats || []).length ? `<div class="gu-stat-cards">${d.stats.map(s => `
        <div class="gu-stat">
          <div class="gu-stat-label">${_gu_esc(s.label)}</div>
          <div class="gu-stat-value">${_gu_esc(s.value)}</div>
        </div>`).join('')}</div>` : '';
      const sections = (d.sections || []).map(s => `
        <div class="gu-res-section">
          <div class="gu-res-heading">
            <span>${_gu_esc(s.heading)}</span>
            ${s.url ? `<span class="gu-res-domain" data-url="${_gu_attr(s.url)}"
              onclick="window.__bucksGenUIAction('navigate', this.getAttribute('data-url'))">${_gu_esc(s.domain || 'source')} ↗</span>` : ''}
          </div>
          <div class="gu-res-text">${_gu_esc(s.text)}</div>
        </div>`).join('');
      const strip = (d.images || []).length ? `<div class="gu-res-strip">${d.images.map(im => `
        <div class="gu-img-cell gu-res-strip-cell"
             data-img="${_gu_attr(im.image || im.thumbnail)}"
             data-url="${_gu_attr(im.url || '')}"
             data-title="${_gu_attr(im.title || '')}"
             onclick="window.__bucksLightboxFromEl(this)">
          <img src="${_gu_attr(im.thumbnail || im.image)}" loading="lazy" referrerpolicy="no-referrer"
               onerror="this.closest('.gu-img-cell').style.display='none'"/>
        </div>`).join('')}</div>` : '';
      const sources = (d.sources || []).length ? `<div class="gu-res-sources">
        <div class="gu-res-sources-label">Sources</div>${(d.sources || []).map(s => `
        <a class="gu-res-src" href="#" data-url="${_gu_attr(s.url)}"
           onclick="window.__bucksGenUIAction('navigate', this.getAttribute('data-url'));event.preventDefault();">
          ${_gu_faviconImg(s.favicon, s.domain)}<span>${_gu_esc(s.domain || s.title)}</span>
        </a>`).join('')}</div>` : '';
      const actions = (d.actions || []).length ? `<div class="gu-cta-row">${d.actions.map(a => `
        <button class="gu-cta" data-kind="${_gu_attr(a.kind || 'agent')}" data-value="${_gu_attr(a.value || a.label)}"
          onclick="window.__bucksGenUIAction(this.getAttribute('data-kind'), this.getAttribute('data-value'))">${_gu_esc(a.label)}</button>`).join('')}</div>` : '';
      return `<div class="gu-research">${hero}${summary}${stats}${sections}${strip}${sources}${actions}</div>`;
    },
  };

  // Render a component spec into a card element (returns the element).
  function renderComponent(spec) {
    const wrap = document.createElement('div');
    wrap.className = 'gu-component';

    if (spec && spec.component === 'product_grid') {
      let gridId = spec.gridId;
      if (!gridId) {
        gridId = 'grid-' + Math.random().toString(36).substr(2, 9);
        spec.gridId = gridId;
      }
      if (!window.__productGrids) window.__productGrids = new Map();
      if (!window.__productGrids.has(gridId)) {
        window.__productGrids.set(gridId, {
          query: spec.title || '',
          items: (spec.data && spec.data.items) || [],
          limit: 3,
          sortBy: 'default',
          filterBy: 'all'
        });
      }
      wrap.innerHTML = window.__renderProductGridHTML(gridId);
      return wrap;
    }

    const renderer = _GENUI_RENDERERS[spec && spec.component];
    if (!renderer) {
      wrap.innerHTML = `<div class="gu-answer">${formatNexusAnswer((spec && spec.data && spec.data.markdown) || '').html}</div>`;
      return wrap;
    }
    let inner = '';
    try { inner = renderer(spec.data || {}); }
    catch (e) { console.error('[GenUI] render failed', spec.component, e); inner = '<div class="gu-empty">Could not render component.</div>'; }
    wrap.innerHTML = `${spec.title ? `<div class="gu-title">${_gu_esc(spec.title)}</div>` : ''}${inner}`;
    return wrap;
  }

  function formatNexusAnswer(text) {
    if (!text) return { html: '', links: [], followups: [] };

    let rawText = text;
    let links = [];
    let followups = [];

    // 1. Extract follow-up questions wrapped in <followup>...</followup>
    const followupRegex = /<followup>([\s\S]*?)<\/followup>/gi;
    let followupMatch;
    while ((followupMatch = followupRegex.exec(rawText)) !== null) {
      followups.push(followupMatch[1].trim());
    }
    rawText = rawText.replace(followupRegex, '');

    // 2. Extract markdown links: [Label](URL)
    const linkRegex = /\[([^\]]+)\]\((https?:\/\/[^\s\)]+|[^\s\)]+)\)/g;
    let linkMatch;
    while ((linkMatch = linkRegex.exec(rawText)) !== null) {
      links.push({ text: linkMatch[1].trim(), url: linkMatch[2].trim() });
    }

    // 3. Escape HTML
    let formatted = escapeHtml(rawText);

    // Strip out unclosed <followup> tags so they don't show up as ugly tags during streaming
    formatted = formatted.replace(/&lt;followup&gt;[\s\S]*/gi, '');

    // 4. Format markdown links in text
    formatted = formatted.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (match, linkText, url) => {
      const decodedUrl = url.replace(/&amp;/g, '&');
      return `<a href="#" onclick="window.openAgentLink('${decodedUrl}'); event.preventDefault();" style="color: #78b4ff; text-decoration: underline; font-weight: 500; cursor: pointer; transition: color 0.15s ease;" onmouseover="this.style.color='#a3caff'" onmouseout="this.style.color='#78b4ff'">${linkText}</a>`;
    });

    // 5. Format bold tags
    formatted = formatted.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');

    return { html: formatted, links, followups };
  }

  function renderNexusStepCard(ev) {
    if (!ev || !ev.type || ev.type === 'session') return;

    // Remove any active thinking card when the real answer, error, cancellation, or done event arrives
    if (ev.type === 'token' || ev.type === 'done' || ev.type === 'error' || ev.type === 'cancelled') {
      const existingThinking = document.getElementById('nx-thinking-card');
      if (existingThinking) {
        existingThinking.remove();
      }
    }

    /* Show all tool calls, results, and browser actions in UI for transparency */
    /*
    if (ev.type === 'tool_call' || ev.type === 'tool_result') {
      return;
    }
    if (ev.type === 'browser_action' && !ev.needs_approval) {
      return;
    }
    */

    const msgContainer = document.getElementById('nav-chat-messages-container');
    if (!msgContainer) return;

    // ── Generative UI component ──
    if (ev.type === 'ui_component') {
      if (Array.isArray(agentConversation)) {
        agentConversation.push({ role: 'component', ui: ev });
      }
      const el = renderComponent(ev);
      el.style.cssText += 'animation:nxFadeUp .18s ease;';
      msgContainer.appendChild(el);
      msgContainer.scrollTop = msgContainer.scrollHeight;
      return;
    }

    const style  = _NX_STYLE[ev.type]  || { accent: 'rgba(255,255,255,0.15)', label: ev.type, fg: 'rgba(255,255,255,0.5)' };
    const svg    = _NX_SVG[ev.type]    || '';
    const content = ev.content || ev.label || '';
    const name    = ev.name   || '';

    // ── Token events: accumulate into one streaming bubble with Markdown HTML parsing ──
    if (ev.type === 'token') {
      if (!_nxTokenCardEl) {
        _nxTokenCardEl = document.createElement('div');
        _nxTokenCardEl.style.cssText = 'display:flex;justify-content:flex-start;margin-bottom:6px;animation:nxFadeUp .18s ease; width:100%;';
        _nxTokenCardEl.innerHTML = `
          <div style="max-width:88%;padding:11px 14px 11px 12px;
            border-left:2px solid ${style.accent};
            background:rgba(255,255,255,0.03);
            border-radius:0 10px 10px 0; width:100%;">
            <div style="display:flex;align-items:center;gap:5px;margin-bottom:5px;color:${style.fg};">
              ${svg}
              <span style="font-size:10px;font-weight:600;letter-spacing:.04em;">${style.label}</span>
            </div>
            <div class="nx-token-body" style="font-size:13.5px;line-height:1.65;color:rgba(255,255,255,0.88);white-space:pre-wrap;word-break:break-word;"></div>
            <div class="nx-cta-section" style="display:none; flex-wrap:wrap; gap:8px; margin-top:10px; padding-top:8px; border-top:1px dashed rgba(255,255,255,0.1);"></div>
          </div>`;
        _nxTokenCardEl._accumulatedText = '';
        msgContainer.appendChild(_nxTokenCardEl);
      }
      _nxTokenCardEl._accumulatedText += content;
      
      const body = _nxTokenCardEl.querySelector('.nx-token-body');
      const ctaSec = _nxTokenCardEl.querySelector('.nx-cta-section');
      
      if (body) {
        const parsed = formatNexusAnswer(_nxTokenCardEl._accumulatedText);
        body.innerHTML = parsed.html;
        
        if (ctaSec) {
          if (parsed.links.length > 0 || parsed.followups.length > 0) {
            ctaSec.style.display = 'flex';
            let ctaHtml = '';
            
            // Render links as CTAs
            parsed.links.forEach(link => {
              ctaHtml += `
                <a href="#" onclick="window.openAgentLink('${escapeHtml(link.url)}'); event.preventDefault();" style="display: inline-flex; align-items: center; gap: 4px; padding: 6px 12px; border-radius: 8px; border: 1px solid rgba(120, 180, 255, 0.3); background: rgba(120, 180, 255, 0.08); color: rgba(120, 180, 255, 0.95); font-size: 11px; font-weight: 600; text-decoration: none; cursor: pointer; transition: all 0.15s ease;" onmouseover="this.style.background='rgba(120, 180, 255, 0.15)'; this.style.borderColor='rgba(120, 180, 255, 0.5)';" onmouseout="this.style.background='rgba(120, 180, 255, 0.08)'; this.style.borderColor='rgba(120, 180, 255, 0.3)';">
                  <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6M15 3h6v6M10 14L21 3"/></svg>
                  ${escapeHtml(link.text)}
                </a>`;
            });
            
            // Render follow-ups as CTAs
            parsed.followups.forEach(q => {
              ctaHtml += `
                <button onclick="window.submitAgentFollowup('${encodeURIComponent(q)}')" style="display: inline-flex; align-items: center; gap: 4px; padding: 6px 12px; border-radius: 8px; border: 1px solid rgba(255, 255, 255, 0.1); background: rgba(255, 255, 255, 0.03); color: rgba(255, 255, 255, 0.8); font-size: 11px; font-weight: 500; font-family: inherit; cursor: pointer; transition: all 0.15s ease;" onmouseover="this.style.background='rgba(255, 255, 255, 0.08)'; this.style.borderColor='rgba(255, 255, 255, 0.2)'; this.style.color='#fff';" onmouseout="this.style.background='rgba(255, 255, 255, 0.03)'; this.style.borderColor='rgba(255, 255, 255, 0.1)'; this.style.color='rgba(255, 255, 255, 0.8)';">
                  <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14M12 5l7 7-7 7"/></svg>
                  ${escapeHtml(q)}
                </button>`;
            });
            
            ctaSec.innerHTML = ctaHtml;
          } else {
            ctaSec.style.display = 'none';
          }
        }
      }
      msgContainer.scrollTop = msgContainer.scrollHeight;
      return;
    }

    _nxTokenCardEl = null;

    // ── Reusable single Thinking card ──
    if (ev.type === 'thinking') {
      let existingThinking = document.getElementById('nx-thinking-card');
      if (existingThinking) {
        const bodyEl = existingThinking.querySelector('.nx-thinking-body');
        if (bodyEl) bodyEl.textContent = content;
        return;
      }
    }

    // ── Approval buttons for browser_action ──
    let approvalHtml = '';
    if (ev.type === 'browser_action' && ev.needs_approval) {
      const aid = ev.action_id || Date.now();
      const sid = ev.session_id || '';
      approvalHtml = `
        <div id="nx-approval-${aid}" style="display:flex;gap:6px;margin-top:9px;align-items:center;">
          <button onclick="window._nxApprove('${sid}','${aid}')" style="padding:4px 12px;border-radius:6px;border:1px solid rgba(80,220,140,0.3);background:rgba(80,220,140,0.08);color:rgba(80,220,140,0.9);font-size:11px;font-weight:600;cursor:pointer;font-family:inherit;letter-spacing:.02em;">Approve</button>
          <button onclick="window._nxDeny('${sid}','${aid}')" style="padding:4px 12px;border-radius:6px;border:1px solid rgba(255,90,100,0.3);background:rgba(255,90,100,0.08);color:rgba(255,100,110,0.9);font-size:11px;font-weight:600;cursor:pointer;font-family:inherit;letter-spacing:.02em;">Deny</button>
          <span id="nx-cd-${aid}" style="font-size:10px;color:rgba(255,255,255,0.25);">30s</span>
        </div>`;
      let secs = 30;
      const t = setInterval(() => {
        const cd = document.getElementById(`nx-cd-${aid}`);
        if (!cd) { clearInterval(t); return; }
        if (--secs <= 0) {
          clearInterval(t);
          window._nxDeny(sid, aid);
          const row = document.getElementById(`nx-approval-${aid}`);
          if (row) row.innerHTML = '<span style="font-size:10px;color:rgba(255,90,100,0.6);">Timed out — denied</span>';
        } else { cd.textContent = `${secs}s`; }
      }, 1000);
    }

    // ── Step card ──
    const card = document.createElement('div');
    if (ev.type === 'thinking') {
      card.id = 'nx-thinking-card';
    }
    card.style.cssText = 'display:flex;justify-content:flex-start;margin-bottom:6px;animation:nxFadeUp .18s ease; width:100%;';

    const labelExtra = name ? ` <span style="opacity:.55;font-weight:400">→ ${escapeHtml(name)}</span>` : '';
    const bodyHtml   = content
      ? `<div class="${ev.type === 'thinking' ? 'nx-thinking-body' : ''}" style="font-size:13px;line-height:1.55;color:rgba(255,255,255,0.78);white-space:pre-wrap;word-break:break-word;margin-top:${name ? 4 : 0}px;">${escapeHtml(content)}</div>`
      : '';

    card.innerHTML = `
      <div style="max-width:88%;padding:9px 14px 9px 12px;
        border-left:2px solid ${style.accent};
        background:rgba(255,255,255,0.025);
        border-radius:0 10px 10px 0; width:100%;">
        <div style="display:flex;align-items:center;gap:5px;color:${style.fg};">
          ${svg}
          <span style="font-size:10px;font-weight:600;letter-spacing:.04em;">${style.label}${labelExtra}</span>
        </div>
        ${bodyHtml}
        ${approvalHtml}
      </div>`;

    msgContainer.appendChild(card);
    msgContainer.scrollTop = msgContainer.scrollHeight;
  }

  // Map of action_id → browser_action event, for executing after user approval
  const _pendingBrowserActions = new Map();

  /* Approval callbacks */
  window._nxApprove = async (sessionId, actionId) => {
    const row = document.getElementById(`nx-approval-${actionId}`);
    if (row) row.innerHTML = '<span style="font-size:10px;color:rgba(80,220,140,0.8);">&#10003; Approved — running…</span>';
    try {
      // 1. Resolve the approval gate in the soul engine
      if (window.nexusAPI) await window.nexusAPI.approveAction(sessionId, actionId);
      else await fetch(`${SOUL_ENGINE}/agent/approve/${encodeURIComponent(sessionId)}`,
        { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({action_id:actionId}) });

      // 2. Execute the browser tool and post the result back (soul engine awaits this)
      const pendingEv = _pendingBrowserActions.get(actionId);
      if (pendingEv) {
        _pendingBrowserActions.delete(actionId);
        await _executeBrowserAction(pendingEv);
        if (row) row.innerHTML = '<span style="font-size:10px;color:rgba(80,220,140,0.8);">&#10003; Done</span>';
      }
    } catch (_) {}
  };
  window._nxDeny = async (sessionId, actionId) => {
    const row = document.getElementById(`nx-approval-${actionId}`);
    if (row) row.innerHTML = '<span style="font-size:10px;color:rgba(255,90,100,0.7);">&#10007; Denied</span>';
    _pendingBrowserActions.delete(actionId);
    try {
      if (window.nexusAPI) await window.nexusAPI.denyAction(sessionId, actionId);
      else await fetch(`${SOUL_ENGINE}/agent/deny/${encodeURIComponent(sessionId)}`,
        { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({action_id:actionId}) });
    } catch (_) {}
  };

  /* ── URL Extraction ── */
  function extractUrl(q) {
    const urlMatch = q.match(/https?:\/\/[^\s]+/) || q.match(/[a-z0-9-]+\.(com|org|net|io|ai|co|uk|gov|edu)[^\s]*/i);
    if (!urlMatch) return null;
    let url = urlMatch[0];
    if (!url.startsWith('http')) url = 'https://' + url;
    return url;
  }

  /* ── Spinner step renderer (agent thinking steps) ── */
  function renderAgentSteps(steps) {
    const box = chatEl('chat-agent-steps');
    if (!box) return;
    box.innerHTML = steps.map((s) => {
      let icon;
      if (s.state === 'done') {
        icon = `<span style="flex:none;width:22px;height:22px;border-radius:6px;display:flex;align-items:center;justify-content:center;background:rgba(74,222,128,0.18);"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#4ade80" stroke-width="2.8" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12l5 5L19 7"/></svg></span>`;
      } else if (s.state === 'active') {
        icon = `<span style="flex:none;width:22px;height:22px;border-radius:6px;display:flex;align-items:center;justify-content:center;background:rgba(169,120,255,0.18);"><span style="width:11px;height:11px;border:2px solid rgba(169,120,255,0.4);border-top-color:#a978ff;border-radius:50%;display:inline-block;animation:spin .7s linear infinite;"></span></span>`;
      } else {
        icon = `<span style="flex:none;width:22px;height:22px;border-radius:6px;border:1px solid rgba(255,255,255,0.14);"></span>`;
      }
      return `<div style="display:flex;align-items:center;gap:10px;opacity:${s.state === 'pending' ? 0.4 : 1};transition:opacity .3s;">${icon}<div style="flex:1;min-width:0;"><div style="font-size:13px;font-weight:600;color:rgba(255,255,255,0.9);">${escapeHtml(s.label)}</div>${s.sub ? `<div style="font-size:11.5px;color:rgba(255,255,255,0.45);margin-top:1px;">${escapeHtml(s.sub)}</div>` : ''}</div></div>`;
    }).join('');
  }

  /* ── Rich Ephemeral UI renderer with sources + follow-up chips ── */
  function renderWebAnswer({ answer, sources, followUps, elapsed, intent }) {
    const msgContainer = document.getElementById('nav-chat-messages-container');
    if (!msgContainer) return;

    // Format markdown-ish answer
    const formattedAnswer = answer
      .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
      .replace(/\*(.+?)\*/g, '<em>$1</em>')
      .replace(/`(.+?)`/g, '<code style="background:rgba(255,255,255,0.1);padding:1px 5px;border-radius:4px;font-size:0.9em;">$1</code>')
      .split('\\n').map(line => line.trim() ? `<p style="margin:0 0 6px;">${line}</p>` : '').join('');

    // Source reference pills
    const srcHtml = (sources && sources.length)
      ? `<div style="display:flex;flex-wrap:wrap;gap:7px;margin-top:10px;padding-top:10px;border-top:1px solid rgba(255,255,255,0.08);">
          ${sources.map((s, i) => `
            <button onclick="window._agentOpenUrl('${escapeHtml(s.url)}')" style="display:inline-flex;align-items:center;gap:5px;padding:4px 10px;border-radius:16px;font-size:11.5px;color:rgba(255,255,255,0.85);background:rgba(255,255,255,0.07);border:1px solid rgba(255,255,255,0.14);cursor:pointer;transition:all 0.15s;font-family:inherit;" onmouseover="this.style.background='rgba(255,255,255,0.14)'" onmouseout="this.style.background='rgba(255,255,255,0.07)'">
              <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6M15 3h6v6M10 14L21 3"/></svg>
              <span>${escapeHtml(s.source || new URL(s.url).hostname.replace('www.',''))}</span>
            </button>
          `).join('')}
        </div>`
      : '';

    // Follow-up suggestion chips
    const chipsHtml = (followUps && followUps.length)
      ? `<div style="display:flex;flex-wrap:wrap;gap:7px;margin-top:8px;">
          <span style="font-size:11px;color:rgba(255,255,255,0.35);align-self:center;margin-right:2px;">Follow up:</span>
          ${followUps.map(fu => `
            <button onclick="window._agentFollowUp('${escapeHtml(fu)}')" class="chat-chip" style="font-size:11.5px;padding:4px 10px;border-radius:16px;border:1px solid rgba(255,255,255,0.14);background:transparent;color:rgba(255,255,255,0.7);cursor:pointer;font-family:inherit;transition:all 0.15s;" onmouseover="this.style.background='rgba(255,255,255,0.08)'" onmouseout="this.style.background='transparent'">${escapeHtml(fu)}</button>
          `).join('')}
        </div>`
      : '';

    msgContainer.innerHTML += `
      <div style="display:flex; justify-content:flex-start; margin-bottom:12px;">
        <div style="max-width:90%; padding:14px; border-radius:4px 14px 14px 14px; background:rgba(255,255,255,0.06); border:1px solid rgba(255,255,255,0.12); box-shadow:0 0 20px rgba(0,0,0,0.1);">
          <div style="font-size:13.5px;line-height:1.6;color:rgba(255,255,255,0.92);">${formattedAnswer}</div>
          ${srcHtml}
          ${chipsHtml}
        </div>
      </div>
    `;
    msgContainer.scrollTop = msgContainer.scrollHeight;
  }

  /* ── Simple text answer (for chat/conversational responses) ── */
  function renderChatAnswer(text, sources) {
    renderWebAnswer({
      answer: text,
      sources: sources ? sources.map(s => ({ url: s, source: s })) : [],
      followUps: []
    });
  }

  /* ── Browser action handlers ── */
  window._agentOpenUrl = (url) => {
    try { createTab(url.startsWith('http') ? url : 'https://' + url); } catch (_) {}
  };
  window._agentFollowUp = (q) => {
    const input = chatEl('chat-input') || chatEl('left-chat-input');
    if (input) { input.value = q; input.focus(); }
    sendChat(q);
  };

  // ── Unified "View more" for media components ──
  // First clicks reveal already-fetched items client-side (instant paging);
  // once exhausted the button turns into a real follow-up search (--more).
  const _GU_MORE = {
    images:  { page: 12, cmd: (q) => `/images ${q} --more`,  fetchLabel: 'Crawling Web…' },
    video:   { page: 8,  cmd: (q) => `/video ${q} --more`,   fetchLabel: 'Finding more videos…' },
    product: { page: 8,  cmd: (q) => `/product ${q} --more`, fetchLabel: 'Finding more products…' },
  };
  window.__bucksGuViewMore = (btn, kind, query) => {
    if (!btn) return;
    const cfg = _GU_MORE[kind] || _GU_MORE.images;
    const scope = btn.closest('.gu-more-scope');
    const hidden = scope ? scope.querySelectorAll('.gu-hidden') : [];
    if (hidden.length) {
      // Reveal the next page from what we already fetched.
      for (let i = 0; i < Math.min(cfg.page, hidden.length); i++) hidden[i].classList.remove('gu-hidden');
      if (!scope.querySelectorAll('.gu-hidden').length) {
        const label = btn.querySelector('.gu-more-label');
        if (label) label.textContent = query ? 'Search more' : 'That’s everything';
        if (!query) btn.disabled = true;
      }
      return;
    }
    if (!query) { btn.disabled = true; return; }
    // Nothing left locally — run a wider search as a follow-up turn.
    btn.disabled = true;
    btn.innerHTML = `<svg style="animation: spin 1.2s linear infinite;" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4"><circle cx="12" cy="12" r="10" stroke="rgba(255,255,255,0.15)"></circle><path d="M4 12a8 8 0 018-8" fill="none" stroke-linecap="round"></path></svg> ${cfg.fetchLabel}`;
    const moreQuery = cfg.cmd(query);
    const chatTab = document.getElementById('view-chat-tab');
    if (chatTab && !chatTab.classList.contains('hidden')) {
      sendChatTab(moreQuery);
    } else {
      sendChat(moreQuery);
    }
  };
  // Back-compat alias (older rendered components may still reference it).
  window.__bucksImageGalleryViewMore = (btn, query) => window.__bucksGuViewMore(btn, 'images', query);

  // Shared button markup for the media components.
  function _gu_moreBtn(kind, query, hasHidden) {
    if (!hasHidden && !query) return '';
    const label = hasHidden ? 'View more' : 'Search more';
    return `
      <div style="width:100%; display:flex; justify-content:center; margin-top:14px; flex-shrink:0; padding-bottom:6px;">
        <button class="gu-more-btn" onclick="window.__bucksGuViewMore(this,'${kind}','${_gu_attr(query || '')}')"
          style="padding:9px 22px; border-radius:99px; background:rgba(169,120,255,0.14); border:1px solid rgba(169,120,255,0.35); color:#a978ff; font-family:inherit; font-size:13px; font-weight:600; cursor:pointer; transition:all 0.2s; display:flex; align-items:center; gap:8px;"
          onmouseover="this.style.background='rgba(169,120,255,0.24)';" onmouseout="this.style.background='rgba(169,120,255,0.14)';">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>
          <span class="gu-more-label">${label}</span>
        </button>
      </div>`;
  }

  /* ── Generate follow-up suggestions based on query + intent ── */
  function generateFollowUps(query, intent, results) {
    const q = query.toLowerCase().trim();
    const suggestions = [];

    // Strip a leading question stem to get the core "topic" of the query,
    // so follow-ups are about what the user actually asked, not generic.
    const topic = query
      .replace(/^(what is|what are|who is|who are|how does|how do|how to|explain|tell me about|why is|why are|when is|where is|can you|could you|give me)\s*/i, '')
      .replace(/[?.!]+$/, '')
      .trim();
    const shortTopic = topic.split(/\s+/).slice(0, 6).join(' ');

    if (intent === 'research' || intent === 'search') {
      if (results && results.length > 0) {
        suggestions.push(`More details about ${results[0].title?.split(' ').slice(0, 4).join(' ')}`);
      }
      if (q.startsWith('what is') || q.startsWith('what are')) suggestions.push(`How does ${shortTopic} work?`);
      if (q.startsWith('who is')) suggestions.push(`What is ${shortTopic} known for?`);
      suggestions.push(`Latest news about ${shortTopic}`);
    } else if (intent === 'navigate') {
      suggestions.push(`Search for alternatives to this site`);
      suggestions.push(`Summarize this page`);
    } else {
      // Conversational chat — build contextual follow-ups from the query topic
      // instead of the old generic "Search the web for more" / "Tell me more".
      if (shortTopic) {
        if (q.startsWith('what is') || q.startsWith('what are')) {
          suggestions.push(`How does ${shortTopic} work?`);
          suggestions.push(`What are the pros and cons of ${shortTopic}?`);
        } else if (q.startsWith('how')) {
          suggestions.push(`Show me a step-by-step example`);
          suggestions.push(`What are common mistakes with ${shortTopic}?`);
        } else if (q.startsWith('convert') || /\b(usd|eur|gbp|inr|btc|price|cost)\b/i.test(q)) {
          suggestions.push(`Show the latest exchange rate`);
          suggestions.push(`Convert a different amount`);
        } else {
          suggestions.push(`Tell me more about ${shortTopic}`);
          suggestions.push(`Give me a practical example`);
        }
      } else {
        suggestions.push(`Explain that in more detail`);
      }
    }
    // De-duplicate and cap at 3
    return [...new Set(suggestions.filter(Boolean))].slice(0, 3);
  }

  /* ── Synthesize answer from web search results ── */
  function synthesizeAnswer(query, instant, results, activeTab) {
    const parts = [];

    if (instant && instant.snippet) {
      parts.push(`**${instant.title}**\n${instant.snippet}`);
    }

    if (results && results.length > 0) {
      if (!instant) {
        // Use top result snippet as primary answer
        const top = results[0];
        if (top.snippet) parts.push(`**${top.title}**\n${top.snippet}`);
      }
      // Add 1-2 additional snippets for context
      const extras = results.slice(instant ? 0 : 1, 3).filter(r => r.snippet && r.snippet.length > 20);
      if (extras.length) {
        parts.push(extras.map(r => `• ${r.snippet.slice(0, 200)}`).join('\n'));
      }
    }

    if (!parts.length) {
      parts.push(`I searched for "${query}" but couldn't find specific results right now. Try visiting a search engine directly.`);
    }

    return parts.join('\n\n');
  }

  async function streamSSE(url, body, onEvent, signal) {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'text/event-stream' },
      body: JSON.stringify(body),
      signal,
    });
    if (!res.ok || !res.body) throw new Error(`Engine ${res.status}`);
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    while (true) {
      let chunk;
      try {
        chunk = await reader.read();
      } catch (e) {
        if (e && e.name === 'AbortError') return; // stopped by user
        throw e;
      }
      const { done, value } = chunk;
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop() || '';
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const data = line.slice(6).trim();
        if (data === '[DONE]') return;
        try { onEvent(JSON.parse(data)); } catch (_) { if (data) onEvent({ token: data }); }
      }
    }
  }

  /* ═══════════ NETWORK STATUS ═══════════ */
  // Surface connectivity changes; failed tab loads get an in-view error page
  // from tab-manager.js — this covers the shell-level signal.
  window.addEventListener('offline', () => showToast('You’re offline — pages may not load', 'error'));
  window.addEventListener('online', () => showToast('Back online', 'success'));

  /* ═══════════ AGENTIC BROWSER (Phase 1 slice) ═══════════ */
  // Bind the renderer actuation layer to whatever tab is active.
  if (window.__bucksBrowserControl) {
    window.__bucksBrowserControl.bind(() => {
      const t = tabs.find((t) => t.id === activeTabId);
      return t ? t.webview : null;
    });
  }

  // Agentic run control: AbortController + a stopped flag so any tool request
  // that arrives after Stop never actuates the live tab.
  let agentAbort = null;
  let agentStopped = false;

  function setAgentRunningUI(running) {
    const sendBtn = document.getElementById('chat-tab-send');
    const stopBtn = document.getElementById('chat-tab-stop');
    if (sendBtn) sendBtn.style.display = running ? 'none' : 'flex';
    if (stopBtn) stopBtn.style.display = running ? 'flex' : 'none';
  }

  function stopAgenticTask() {
    agentStopped = true;
    if (agentAbort) { try { agentAbort.abort(); } catch (_) {} }
  }
  window.stopAgenticTask = stopAgenticTask;

  async function postToolResult(id, result) {
    try {
      await fetch(`${SOUL_ENGINE}/agent/tool_result`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, result }),
      });
    } catch (_) { /* loop will time out server-side */ }
  }

  async function handleAgentToolRequest(ev) {
    if (agentStopped) { await postToolResult(ev.id, 'Stopped by user.'); return; }
    const needsApproval = ev.confirm || ev.needs_approval;
    let result;
    try {
      if (!window.__bucksBrowserControl) throw new Error('Browser control unavailable');

      if (needsApproval && !window.nexusAPI) {
        const ok = window.confirm(
          `Bucks agent wants to run ${ev.name}(${JSON.stringify(ev.args)}).\n\nAllow?`
        );
        if (!ok) { await postToolResult(ev.id, 'User denied this action.'); return; }
      }
      result = await window.__bucksBrowserControl.execute(ev.name, ev.args || {});
    } catch (e) {
      result = 'Tool error: ' + ((e && e.message) || e);
    }
    await postToolResult(ev.id, result);
  }

  // Drive an agentic task over the live tab — fully local (Ollama Soul Engine).
  async function runAgenticTask(prompt, onTrace, context) {
    const body = { message: prompt, agentic: true };
    if (context) body.context = context;
    agentStopped = false;
    agentAbort = new AbortController();
    setAgentRunningUI(true);
    try {
      await streamSSE(`${SOUL_ENGINE}/agent`, body, (ev) => {
        // Legacy tool_request path (kept for compatibility)
        if (ev && ev.type === 'tool_request') { handleAgentToolRequest(ev); return; }

        // NEXUS browser_action: soul engine emits this type for all browser tools.
        // Non-approval actions execute immediately. Approval-gated actions are stored
        // so _nxApprove can execute them after the user confirms.
        if (ev && ev.type === 'browser_action') {
          if (!ev.needs_approval) {
            _executeBrowserAction(ev);
          } else if (ev.action_id) {
            _pendingBrowserActions.set(ev.action_id, ev);
          }
          // Pass through to renderNexusStepCard for approval UI cards
          if (onTrace) onTrace(ev);
          return;
        }

        if (onTrace) onTrace(ev);
      }, agentAbort.signal);
    } finally {
      setAgentRunningUI(false);
      agentAbort = null;
    }
  }

  // Execute a browser_action event from the soul engine and post the result back.
  async function _executeBrowserAction(ev) {
    if (agentStopped) { await postToolResult(ev.id, 'Stopped by user.'); return; }
    let result;
    try {
      if (!window.__bucksBrowserControl) throw new Error('Browser control unavailable');
      result = await window.__bucksBrowserControl.execute(ev.name, ev.args || {});
    } catch (e) {
      result = 'Tool error: ' + ((e && e.message) || String(e));
    }
    await postToolResult(ev.id, result);
  }
  // Exposed so the chat panel (or a dev console) can launch an agentic run.
  window.runAgenticTask = runAgenticTask;

  function resetChat() {
    chatBusy = false;
    const msgContainer = document.getElementById('nav-chat-messages-container');
    if (msgContainer) msgContainer.innerHTML = '';
    agentConversation = [];
    const chips = document.getElementById('nav-chat-chips-container');
    if (chips) chips.style.display = 'flex';
  }

  async function captureActivePageContext() {
    const consentPage = document.getElementById('nav-consent-page')?.checked;
    const consentSelection = document.getElementById('nav-consent-selection')?.checked;
    const consentTabs = document.getElementById('nav-consent-tabs')?.checked;
    const consentFiles = document.getElementById('nav-consent-files')?.checked;
    
    let contextParts = [];
    
    if (consentFiles) {
      contextParts.push('[FILES_RAG_ENABLED]');
    }

    try {
      const activeTab = tabs.find(t => t.id === activeTabId);
      if (activeTab && activeTab.webview && !activeTab.url.startsWith('bucks://')) {
        if (consentPage) {
          try {
            const bodyText = await activeTab.webview.executeJavaScript("document.body.innerText");
            if (bodyText) {
              const capText = bodyText.slice(0, 6000) + (bodyText.length > 6000 ? '\n...[truncated]' : '');
              contextParts.push(`--- ACTIVE PAGE TEXT (${activeTab.title || ''} - ${activeTab.url}) ---\n${capText}`);
            }
          } catch (err) {
            console.warn('[Context Capture] Failed to read webview page text:', err);
            contextParts.push(`Active page: ${activeTab.title || ''} (${activeTab.url})`);
          }
        }
        if (consentSelection) {
          try {
            const selectedText = await activeTab.webview.executeJavaScript("window.getSelection().toString()");
            if (selectedText && selectedText.trim() !== '') {
              contextParts.push(`--- SELECTED TEXT ---\n${selectedText}`);
            }
          } catch (err) {
            console.warn('[Context Capture] Failed to read webview selection:', err);
          }
        }
      } else if (activeTab && consentPage) {
        contextParts.push(`Active page: ${activeTab.title || ''} (${activeTab.url})`);
      }
    } catch (_) {}
    
    if (consentTabs) {
      const openTabsList = tabs.map((t, idx) => `${idx + 1}. "${t.title || 'Untitled'}" (${t.url})`).join('\n');
      contextParts.push(`--- OPEN TABS LIST ---\n${openTabsList}`);
    }
    
    return contextParts.join('\n\n');
  }

  async function sendChat(query) {
    const q = (query || '').trim();
    if (!q || chatBusy) return;
    chatBusy = true;
    const startTime = Date.now();

    // Ensure the agent dock's response zone is open — the panel lives inside
    // #nt-ephemeral-zone now, so un-hiding the panel alone leaves it clipped
    // by the zone's zero height.
    dockChatPanel();

    /* ── NEXUS AGENTIC PATH ──
     * Triggered by: /agent <goal>  OR  keywords like "search and open", "book", etc.
     * Routes to the soul engine /agent endpoint with agentic:true.
     * Renders typed step cards inline in #bottom-chat-messages.
     */
    const intent0 = classifyIntent(q);
    const isAgentCmd = intent0 === 'agent' || intent0 === 'shopping' || q.startsWith('/agent') ||
                       isMediaOrResearchQuery(q) ||
                       /^\/(product|scrape|summarize|summerize|links|code|calendar|track|ipfs|images|video|play|research|weather|search)/i.test(q);
    if (isAgentCmd) {
      const goal = translateSlashCommand(q).replace(/^\/agent\s*/i, '').trim();

      // Show user bubble
      const chips = document.getElementById('nav-chat-chips-container');
      if (chips) chips.style.display = 'none';
      const input = document.getElementById('chat-input');
      if (input) input.value = '';
      const msgContainer = document.getElementById('nav-chat-messages-container');
      if (msgContainer) {
        msgContainer.innerHTML += `<div style="display:flex;justify-content:flex-end;margin-bottom:10px;">
          <div style="max-width:82%;padding:9px 14px;border-radius:14px 14px 3px 14px;
            background:rgba(255,255,255,0.07);border:1px solid rgba(255,255,255,0.1);
            font-size:13.5px;line-height:1.5;color:rgba(255,255,255,0.9);">
            <span style="font-size:9px;font-weight:600;letter-spacing:.07em;color:rgba(255,255,255,0.3);display:block;margin-bottom:3px;">AGENT</span>
            ${escapeHtml(goal)}
          </div>
        </div>`;
        msgContainer.scrollTop = msgContainer.scrollHeight;
      }

      // Get page context
      const context = await captureActivePageContext();

      _nxClearTokenCard();
      chatBusy = true;
      try {
        await runAgenticTask(goal, (ev) => { renderNexusStepCard(ev); }, context);
      } catch (e) {
        // Friendly offline message
        const isOffline = e && (e.message || '').toLowerCase().includes('failed');
        renderNexusStepCard({
          type: 'error',
          content: isOffline
            ? 'The inbuilt AI engine is still starting up — give it a few seconds and try again.'
            : `Agent error: ${e.message || e}`,
        });
      } finally {
        chatBusy = false;
      }
      return;
    }

    // Save to history
    try {
      const timeInfo = getClockTime();
      const entry = { q, time: `${timeInfo.time} ${timeInfo.ampm}`, kind: classifyQueryKind(q) };
      chatHistory = [entry, ...chatHistory.filter(h => h.q !== q)].slice(0, 14);
      saveChatHistory();
      renderChatHistory();
    } catch (_) {}

    // Show "sent" state
    const input = document.getElementById('chat-input');
    if (input) input.value = '';
    const chips = document.getElementById('nav-chat-chips-container');
    if (chips) chips.style.display = 'none';

    // Append user message bubble
    const msgContainer = document.getElementById('nav-chat-messages-container');
    if (msgContainer) {
      msgContainer.innerHTML += `<div style="display:flex; justify-content:flex-end;">
        <div style="max-width:85%; padding:10px 14px; border-radius:14px 14px 4px 14px; background:rgba(255,255,255,0.15); border:1px solid rgba(255,255,255,0.25); font-size:13.5px; line-height:1.4; word-break:break-word; color:#fff;">${escapeHtml(q)}</div>
      </div>`;
      msgContainer.scrollTop = msgContainer.scrollHeight;
    }

    // Add to conversation history for multi-turn
    agentConversation.push({ role: 'user', text: q });
    if (agentConversation.length > 20) agentConversation = agentConversation.slice(-20);

    const intent = classifyIntent(q);

    // Get active tab context
    const activePageContext = await captureActivePageContext();
    let activeTab = null;
    try {
      activeTab = tabs.find(t => t.id === activeTabId);
    } catch (_) {}

    try {
      /* ══ BROWSER ACTION INTENTS ══ */
      if (intent === 'navigate') {
        const url = extractUrl(q) || `https://www.google.com/search?q=${encodeURIComponent(q)}`;
        renderAgentSteps([{ label: 'Opening page', sub: url.slice(0, 60), state: 'active' }]);
        createTab(url);
        setTimeout(() => {
          renderWebAnswer({
            answer: `**Navigating to** \`${url}\`\n\nOpened in a new tab.`,
            sources: [{ url, source: new URL(url).hostname.replace('www.', '') }],
            followUps: ['Summarize this page', `Search for more about ${new URL(url).hostname}`],
            elapsed: Date.now() - startTime
          });
        }, 400);
        agentConversation.push({ role: 'assistant', text: `Opened ${url}` });
        return;
      }

      if (intent === 'new_tab') {
        createTab();
        renderWebAnswer({ answer: 'Opened a new tab.', sources: [], followUps: [] });
        return;
      }
      if (intent === 'close_tab') {
        closeTab(activeTabId);
        renderWebAnswer({ answer: 'Closed the current tab.', sources: [], followUps: [] });
        return;
      }
      if (intent === 'back') {
        if (activeTab?.webview) activeTab.webview.goBack();
        renderWebAnswer({ answer: 'Going back.', sources: [], followUps: [] });
        return;
      }
      if (intent === 'forward') {
        if (activeTab?.webview) activeTab.webview.goForward();
        renderWebAnswer({ answer: 'Going forward.', sources: [], followUps: [] });
        return;
      }
      if (intent === 'reload') {
        if (activeTab?.webview) activeTab.webview.reload();
        renderWebAnswer({ answer: 'Reloading the page.', sources: [], followUps: [] });
        return;
      }
      if (intent === 'bookmark') {
        if (activeTab?.url) {
          addBookmark(activeTab.url, activeTab.title);
          renderWebAnswer({ answer: `Bookmarked: **${activeTab.title || activeTab.url}**`, sources: [], followUps: [] });
        }
        return;
      }

      /* ══ LOCATION / DIRECTIONS (Ephemeral Map Card) ══ */
      if (intent === 'location') {
        renderAgentSteps([
          { label: 'Finding location', sub: q.slice(0, 50), state: 'active' }
        ]);

        // Check "X to Y" routing pattern
        const routeMatch = q.match(/^(.+?)\s+to\s+(.+)$/i);

        if (routeMatch) {
          // ── ROUTING ──
          const from = routeMatch[1].trim();
          const to = routeMatch[2].trim();
          renderAgentSteps([
            { label: 'Finding location', sub: `${from} → ${to}`, state: 'done' },
            { label: 'Opening directions', sub: 'Loading map…', state: 'active' }
          ]);
          // Render ephemeral route card
          const msgContainer = document.getElementById('nav-chat-messages-container');
          if (msgContainer) {
            const cardId = 'loc-card-' + Date.now();
            msgContainer.innerHTML += `
              <div style="display:flex;justify-content:flex-start;margin-bottom:12px;">
                <div style="max-width:90%;padding:16px 18px;border-radius:6px 16px 16px 16px;background:linear-gradient(145deg,rgba(123,63,228,0.12),rgba(60,60,70,0.35));border:1px solid rgba(123,63,228,0.25);box-shadow:0 4px 24px rgba(0,0,0,0.15);">
                  <div style="display:flex;align-items:center;gap:8px;margin-bottom:10px;">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="rgba(169,120,255,0.9)" stroke-width="2" stroke-linecap="round"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/></svg>
                    <span style="font-size:14px;font-weight:600;color:#fff;">Directions</span>
                  </div>
                  <div style="font-size:13px;color:rgba(255,255,255,0.75);margin-bottom:12px;line-height:1.5;">
                    <span style="color:rgba(80,220,140,0.9);font-weight:600;">From:</span> ${escapeHtml(from)}<br>
                    <span style="color:rgba(255,120,90,0.9);font-weight:600;">To:</span> ${escapeHtml(to)}
                  </div>
                  <div style="display:flex;gap:8px;flex-wrap:wrap;">
                    <button onclick="window.BucksEarthMap && window.BucksEarthMap.openAt(20,0,5); setTimeout(()=>{ const inp = document.querySelector('.em-from'); if(inp){inp.value='${escapeHtml(from)}';} const inp2 = document.querySelector('.em-to'); if(inp2){inp2.value='${escapeHtml(to)}';} },300)" style="padding:7px 14px;border-radius:10px;border:1px solid rgba(123,63,228,0.4);background:rgba(123,63,228,0.18);color:#a978ff;font-size:12px;font-weight:600;cursor:pointer;transition:all 0.15s;font-family:inherit;" onmouseover="this.style.background='rgba(123,63,228,0.3)'" onmouseout="this.style.background='rgba(123,63,228,0.18)'">
                      🗺️ Open in Map
                    </button>
                    <button onclick="window._bucksLocationRoute('${escapeHtml(from)}','${escapeHtml(to)}')" style="padding:7px 14px;border-radius:10px;border:1px solid rgba(80,220,140,0.3);background:rgba(80,220,140,0.12);color:rgba(80,220,140,0.9);font-size:12px;font-weight:600;cursor:pointer;transition:all 0.15s;font-family:inherit;" onmouseover="this.style.background='rgba(80,220,140,0.22)'" onmouseout="this.style.background='rgba(80,220,140,0.12)'">
                      🧭 Get Directions
                    </button>
                  </div>
                </div>
              </div>`;
            msgContainer.scrollTop = msgContainer.scrollHeight;
          }
          agentConversation.push({ role: 'assistant', text: `Directions: ${from} → ${to}` });
        } else {
          // ── SINGLE PLACE SEARCH ──
          // Try universe map first
          if (window.BucksUniverseMap && window.BucksUniverseMap.flyTo(q)) {
            renderAgentSteps([
              { label: 'Finding location', sub: q, state: 'done' },
              { label: 'Flying to celestial object', sub: q, state: 'active' }
            ]);
            agentConversation.push({ role: 'assistant', text: `Flying to ${q} in the Universe Map` });
            chatBusy = false;
            return;
          }

          // Geocode the place
          const geocodeUrl = `https://nominatim.openstreetmap.org/search?format=json&limit=3&q=${encodeURIComponent(q)}`;
          let places = [];
          try {
            const res = await fetch(geocodeUrl, { headers: { 'Accept-Language': 'en' } });
            places = await res.json();
          } catch (_) {}

          if (places && places.length > 0) {
            const p = places[0];
            const name = p.display_name.split(',')[0];
            const fullAddr = p.display_name;
            const lat = (+p.lat).toFixed(4);
            const lon = (+p.lon).toFixed(4);

            renderAgentSteps([
              { label: 'Finding location', sub: `Found: ${name}`, state: 'done' }
            ]);

            const msgContainer = document.getElementById('nav-chat-messages-container');
            if (msgContainer) {
              msgContainer.innerHTML += `
                <div style="display:flex;justify-content:flex-start;margin-bottom:12px;">
                  <div style="max-width:90%;padding:16px 18px;border-radius:6px 16px 16px 16px;background:linear-gradient(145deg,rgba(123,63,228,0.12),rgba(60,60,70,0.35));border:1px solid rgba(123,63,228,0.25);box-shadow:0 4px 24px rgba(0,0,0,0.15);">
                    <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px;">
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="rgba(169,120,255,0.9)" stroke-width="2" stroke-linecap="round"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/></svg>
                      <span style="font-size:14.5px;font-weight:700;color:#fff;">${escapeHtml(name)}</span>
                    </div>
                    <div style="font-size:12px;color:rgba(255,255,255,0.5);margin-bottom:4px;line-height:1.4;">${escapeHtml(fullAddr)}</div>
                    <div style="font-size:11px;color:rgba(255,255,255,0.35);margin-bottom:12px;">${lat}° N, ${lon}° E</div>
                    <div style="display:flex;gap:8px;flex-wrap:wrap;">
                      <button onclick="window.BucksEarthMap && window.BucksEarthMap.openAt(${p.lat},${p.lon},14)" style="padding:7px 14px;border-radius:10px;border:1px solid rgba(123,63,228,0.4);background:rgba(123,63,228,0.18);color:#a978ff;font-size:12px;font-weight:600;cursor:pointer;transition:all 0.15s;font-family:inherit;" onmouseover="this.style.background='rgba(123,63,228,0.3)'" onmouseout="this.style.background='rgba(123,63,228,0.18)'">
                        🗺️ Navigate
                      </button>
                      <button onclick="window._bucksLocationRoute('my location','${escapeHtml(name)}')" style="padding:7px 14px;border-radius:10px;border:1px solid rgba(80,220,140,0.3);background:rgba(80,220,140,0.12);color:rgba(80,220,140,0.9);font-size:12px;font-weight:600;cursor:pointer;transition:all 0.15s;font-family:inherit;" onmouseover="this.style.background='rgba(80,220,140,0.22)'" onmouseout="this.style.background='rgba(80,220,140,0.12)'">
                        🧭 Directions
                      </button>
                    </div>
                  </div>
                </div>`;
              msgContainer.scrollTop = msgContainer.scrollHeight;
            }
            agentConversation.push({ role: 'assistant', text: `Found: ${name} — ${fullAddr}` });
          } else {
            renderWebAnswer({ answer: `No location found for **"${q}"**. Try a different place name.`, sources: [], followUps: [] });
          }
        }
        chatBusy = false;
        return;
      }

      /* ══ WEB SEARCH / RESEARCH ══ */
      if (intent === 'search' || intent === 'research') {
        renderAgentSteps([
          { label: 'Searching the web', sub: q.slice(0, 50), state: 'active' }
        ]);

        // Use the main-process web-search IPC
        const searchResult = await window.bucksAPI.webSearch(q, 5);

        renderAgentSteps([
          { label: 'Searching the web', sub: `Found ${searchResult.results?.length || 0} results`, state: 'done' },
          { label: 'Synthesizing answer', sub: 'Reading sources…', state: 'active' }
        ]);

        const { instant, results } = searchResult;
        const answer = synthesizeAnswer(q, instant, results, activeTab);
        const allSources = [
          ...(instant ? [{ title: instant.title, url: instant.url, source: instant.source }] : []),
          ...(results || [])
        ].filter((s, i, arr) => s.url && arr.findIndex(x => x.url === s.url) === i).slice(0, 5);

        const followUps = generateFollowUps(q, intent, results);

        agentConversation.push({ role: 'assistant', text: answer, sources: allSources.map(s => s.url) });

        // Simulate Streaming Inference for Web Search
        const msgContainer = document.getElementById('nav-chat-messages-container');
        if (msgContainer) {
          msgContainer.innerHTML += `<div style="display:flex; justify-content:flex-start; margin-bottom:12px;" id="streaming-agent-bubble">
            <div style="max-width:90%; padding:14px; border-radius:4px 14px 14px 14px; background:rgba(255,255,255,0.06); border:1px solid rgba(255,255,255,0.12); box-shadow:0 0 20px rgba(0,0,0,0.1);">
              <div id="streaming-agent-text" style="font-size:13.5px;line-height:1.6;color:rgba(255,255,255,0.92);"></div>
            </div>
          </div>`;
          msgContainer.scrollTop = msgContainer.scrollHeight;
          const textContainer = document.getElementById('streaming-agent-text');
          
          let currentText = '';
          const tokens = answer.split(' ');
          for (let i = 0; i < tokens.length; i++) {
            currentText += (i > 0 ? ' ' : '') + tokens[i];
            textContainer.innerHTML = escapeHtml(currentText) + '●';
            msgContainer.scrollTop = msgContainer.scrollHeight;
            await new Promise(r => setTimeout(r, 15 + Math.random() * 25));
          }
          // Remove temporary streaming bubble and render full final answer
          document.getElementById('streaming-agent-bubble').remove();
        }

        renderWebAnswer({
          answer,
          sources: allSources,
          followUps,
          elapsed: Date.now() - startTime,
          intent
        });
        return;
      }

      /* ══ CONVERSATIONAL CHAT (with multi-turn context) ══ */
      {
        const stepsBox = chatEl('chat-agent-steps');
        if (stepsBox) stepsBox.innerHTML = '';

        // Build conversation context
        const conversationCtx = agentConversation.slice(-6).map(m =>
          `${m.role === 'user' ? 'User' : 'Bucks AI'}: ${m.text}`
        ).join('\n');
        const system = [activePageContext, conversationCtx ? `\nConversation:\n${conversationCtx}` : ''].filter(Boolean).join('\n');

        // Try Soul Engine first; if offline, do a web search as fallback
        let answered = false;
        try {
          let answer = '';
          const msgContainer = document.getElementById('nav-chat-messages-container');
          
          if (msgContainer) {
            msgContainer.innerHTML += `<div style="display:flex; justify-content:flex-start; margin-bottom:12px;" id="soul-engine-streaming-bubble">
              <div style="max-width:90%; padding:14px; border-radius:4px 14px 14px 14px; background:rgba(255,255,255,0.06); border:1px solid rgba(255,255,255,0.12); box-shadow:0 0 20px rgba(0,0,0,0.1);">
                <div id="soul-engine-streaming-text" style="font-size:13.5px;line-height:1.6;color:rgba(255,255,255,0.92);"></div>
              </div>
            </div>`;
            msgContainer.scrollTop = msgContainer.scrollHeight;
          }

          await streamSSE(`${SOUL_ENGINE}/chat`, { message: q, system, stream: true }, (ev) => {
            const chunk = ev.token || ev.content || '';
            if (chunk) {
              answer += chunk;
              const textContainer = document.getElementById('soul-engine-streaming-text');
              if (textContainer) {
                textContainer.innerHTML = escapeHtml(answer) + '●';
                if (msgContainer) msgContainer.scrollTop = msgContainer.scrollHeight;
              }
            }
          });
          
          if (answer) {
            answered = true;
            agentConversation.push({ role: 'assistant', text: answer });
            
            // Render final formatted answer using renderWebAnswer to get formatting and chips
            const streamingBubble = document.getElementById('soul-engine-streaming-bubble');
            if (streamingBubble) streamingBubble.remove();
            
            renderWebAnswer({
              answer,
              sources: [],
              followUps: generateFollowUps(q, 'chat', []),
              elapsed: Date.now() - startTime
            });
          } else {
             const streamingBubble = document.getElementById('soul-engine-streaming-bubble');
             if (streamingBubble) streamingBubble.remove();
          }
        } catch (_) {
             const streamingBubble = document.getElementById('soul-engine-streaming-bubble');
             if (streamingBubble) streamingBubble.remove();
        }

        // Fallback: web search if Soul Engine offline
        if (!answered) {
          renderAgentSteps([{ label: 'Searching the web', sub: q.slice(0, 50), state: 'active' }]);
          const searchResult = await window.bucksAPI.webSearch(q, 4);
          const { instant, results } = searchResult;
          const answer = synthesizeAnswer(q, instant, results, activeTab);
          const allSources = [
            ...(instant ? [{ url: instant.url, source: instant.source }] : []),
            ...(results || [])
          ].filter(s => s.url).slice(0, 4);
          agentConversation.push({ role: 'assistant', text: answer, sources: allSources.map(s => s.url) });
          
          // Simulate Streaming Inference for Web Fallback
          const msgContainer = document.getElementById('nav-chat-messages-container');
          if (msgContainer) {
            msgContainer.innerHTML += `<div style="display:flex; justify-content:flex-start; margin-bottom:12px;" id="streaming-agent-bubble">
              <div style="max-width:90%; padding:14px; border-radius:4px 14px 14px 14px; background:rgba(255,255,255,0.06); border:1px solid rgba(255,255,255,0.12); box-shadow:0 0 20px rgba(0,0,0,0.1);">
                <div id="streaming-agent-text" style="font-size:13.5px;line-height:1.6;color:rgba(255,255,255,0.92);"></div>
              </div>
            </div>`;
            msgContainer.scrollTop = msgContainer.scrollHeight;
            const textContainer = document.getElementById('streaming-agent-text');
            
            let currentText = '';
            const tokens = answer.split(' ');
            for (let i = 0; i < tokens.length; i++) {
              currentText += (i > 0 ? ' ' : '') + tokens[i];
              textContainer.innerHTML = escapeHtml(currentText) + '●';
              msgContainer.scrollTop = msgContainer.scrollHeight;
              await new Promise(r => setTimeout(r, 15 + Math.random() * 25));
            }
            document.getElementById('streaming-agent-bubble').remove();
          }

          renderWebAnswer({
            answer,
            sources: allSources,
            followUps: generateFollowUps(q, 'chat', results),
            elapsed: Date.now() - startTime
          });
        }
      }
    } catch (err) {
      // Final fallback: web search
      try {
        renderAgentSteps([{ label: 'Searching the web…', sub: '', state: 'active' }]);
        const searchResult = await window.bucksAPI.webSearch(q, 4);
        const { instant, results } = searchResult;
        if ((results && results.length) || instant) {
          renderWebAnswer({
            answer: synthesizeAnswer(q, instant, results, activeTab),
            sources: (results || []).slice(0, 4),
            followUps: generateFollowUps(q, 'search', results),
            elapsed: Date.now() - startTime
          });
        } else {
          renderWebAnswer({ answer: `I couldn't find information about "${q}". Try rephrasing or being more specific.`, sources: [], followUps: [`Search for ${q}`, 'Try a different query'] });
        }
      } catch (err2) {
        renderWebAnswer({ answer: `Something went wrong: ${err2.message}`, sources: [], followUps: [] });
      }
    } finally {
      chatBusy = false;
    }
  }

  // ── Ephemeral UI: dock/undock the (single, shared) agent chat panel ──────
  // #nav-chat-panel is the one real chat/agent engine — used both as a
  // floating dropdown off the address bar, and as the in-flow "Ephemeral UI"
  // response zone on the Home/New Tab dashboard. Reparenting it (rather than
  // building a second copy) means every existing flow — plain chat, agentic
  // tool trace, browser_action approval — keeps working unchanged; only its
  // container and CSS positioning change.
  function dockChatPanel() {
    const navPanel = document.getElementById('nav-chat-panel');
    const zone = document.getElementById('nt-ephemeral-zone');
    const view = document.getElementById('view-newtab');
    if (!navPanel || !zone) return;
    
    // It is permanently docked now. Just show it.
    zone.classList.remove('hidden');
    navPanel.classList.remove('hidden');
    navPanel.classList.remove('nav-chat-min'); // Ensure it's not minimized
    // Force reflow
    zone.offsetHeight;
    zone.classList.add('active');
    if (view) view.classList.add('nt-ephemeral-active');
    populateNavChatModels();
  }

  function undockChatPanel() {
    const navPanel = document.getElementById('nav-chat-panel');
    const zone = document.getElementById('nt-ephemeral-zone');
    const view = document.getElementById('view-newtab');
    
    if (zone) {
      zone.classList.remove('active');
      setTimeout(() => {
        navPanel?.classList.add('hidden');
        zone.classList.add('hidden');
      }, 300);
    } else {
      navPanel?.classList.add('hidden');
    }
    if (view) view.classList.remove('nt-ephemeral-active');
  }

  // Hand the current ephemeral conversation off to the full-screen chat-tab
  // view (Claude/ChatGPT-style: history sidebar + composer, fills the window).
  function expandChatToFullScreen() {
    const id = createChatThread('Chat');
    const thread = chatTabThreads[id];
    if (thread && Array.isArray(agentConversation) && agentConversation.length) {
      thread.messages = agentConversation.map(m => {
        if (m.role === 'component') {
          return { role: 'component', ui: m.ui };
        }
        return {
          role: m.role === 'user' ? 'user' : 'assistant',
          text: m.text || '',
        };
      });
      // Title from the first user message; persist the carried-over messages.
      const firstUser = thread.messages.find(m => m.role === 'user');
      if (firstUser) {
        thread.title = firstUser.text.slice(0, 42) + (firstUser.text.length > 42 ? '…' : '');
        persistRename(id, thread.title);
      }
      thread.messages.forEach(m => {
        if (m.role === 'component') {
          persistMessage(id, 'component', JSON.stringify(m.ui));
        } else {
          persistMessage(id, m.role, m.text);
        }
      });
    }
    undockChatPanel();
    showDashboardView('chat-tab');
    renderChatTabHistory();
    renderChatTabMessages();
    setTimeout(() => document.getElementById('nt-search-input')?.focus(), 120);
  }

  function expandChatToNewTab() {
    if (Array.isArray(agentConversation) && agentConversation.length) {
      localStorage.setItem('pending-chat-transfer', JSON.stringify(agentConversation));
    }
    try {
      createTab('bucks://newtab');
    } catch (_) {}
  }

  async function populateNavChatModels() {
    const selects = [
      document.getElementById('nav-chat-model-select'),
      document.getElementById('tab-chat-model-select')
    ].filter(Boolean);
    if (!selects.length) return;
    try {
      const r = await fetch(`${SOUL_ENGINE}/models`, { signal: AbortSignal.timeout(3000) });
      const data = await r.json();
      const models = data?.models || [];
      const current = data?.current || '';
      if (models && models.length) {
        const optionsHtml = models.map(m => {
          const active = m.id === current || m.current ? 'selected' : '';
          const disabled = !m.fits_ram && !m.current ? 'disabled' : '';
          return `<option value="${m.id}" ${active} ${disabled}>${m.id} (${m.size_gb}GB)</option>`;
        }).join('');
        selects.forEach(sel => { sel.innerHTML = optionsHtml; });
      } else {
        selects.forEach(sel => { sel.innerHTML = '<option value="">Ollama Model</option>'; });
      }
    } catch (_) {
      selects.forEach(sel => { sel.innerHTML = '<option value="">Offline</option>'; });
    }
  }

  function wireAgentChat() {
    // --- NAV PANEL WIRING ---
    const expandNav = document.getElementById('btn-nav-chat-expand');
    if (expandNav) {
      expandNav.addEventListener('click', () => {
        expandChatToNewTab();
      });
    }

    const historyNav = document.getElementById('btn-nav-chat-history');
    if (historyNav) {
      historyNav.addEventListener('click', () => {
        undockChatPanel();
        showDashboardView('chat-tab');
        renderChatTabHistory();
      });
    }

    const modelSelect = document.getElementById('nav-chat-model-select');
    const tabModelSelect = document.getElementById('tab-chat-model-select');

    const handleModelChange = async (model) => {
      if (!model) return;
      try {
        await fetch(`${SOUL_ENGINE}/models/select`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ model }),
        });
        showToast(`Switched active model to ${model}`, 'success');
        updateNewtabStatus(); // Also update model name on status cards
      } catch (err) {
        showToast('Failed to switch active model', 'error');
      }
    };

    if (modelSelect) {
      modelSelect.addEventListener('change', async (e) => {
        const val = e.target.value;
        if (tabModelSelect) tabModelSelect.value = val;
        await handleModelChange(val);
      });
    }
    if (tabModelSelect) {
      tabModelSelect.addEventListener('change', async (e) => {
        const val = e.target.value;
        if (modelSelect) modelSelect.value = val;
        await handleModelChange(val);
      });
    }

    // Synchronize checkboxes between Ephemeral UI and Chat Tab
    const syncCheckbox = (id1, id2) => {
      const el1 = document.getElementById(id1);
      const el2 = document.getElementById(id2);
      if (el1 && el2) {
        el1.addEventListener('change', () => { el2.checked = el1.checked; });
        el2.addEventListener('change', () => { el1.checked = el2.checked; });
      }
    };
    syncCheckbox('nav-consent-page', 'tab-consent-page');
    syncCheckbox('nav-consent-selection', 'tab-consent-selection');
    syncCheckbox('nav-consent-tabs', 'tab-consent-tabs');
    syncCheckbox('nav-consent-files', 'tab-consent-files');

    const dismissNav = document.getElementById('btn-nav-chat-dismiss');
    if (dismissNav) {
      dismissNav.addEventListener('click', () => {
        undockChatPanel();
        resetChat();
      });
    }

    const refreshNav = document.getElementById('btn-nav-chat-refresh');
    if (refreshNav) {
      refreshNav.addEventListener('click', () => {
        resetChat();
      });
    }

    // New chat: wipe the conversation AND restore the panel if minimized, so
    // "＋ New" always lands the user in a fresh, ready-to-type state.
    const newNav = document.getElementById('btn-nav-chat-new');
    if (newNav) {
      newNav.addEventListener('click', () => {
        resetChat();
        document.getElementById('nav-chat-panel')?.classList.remove('nav-chat-min');
        const bar = document.getElementById('nt-search-input') || document.getElementById('address-bar');
        bar?.focus();
      });
    }

    // Minimize: completely hide the chat panel, leaving only the persistent
    // search bar at the bottom, matching the Claude UI concept.
    const minNav = document.getElementById('btn-nav-chat-minimize');
    if (minNav) {
      minNav.addEventListener('click', () => {
        undockChatPanel();
      });
    }
    
    // (dismiss button is wired above: undock + resetChat)

    document.querySelectorAll('.nav-chat-chip').forEach((chip) => {
      chip.addEventListener('click', () => {
        const query = chip.getAttribute('data-query') || chip.textContent;
        const addressBar = document.getElementById('address-bar');
        if (addressBar) addressBar.value = query;
        sendChat(query);
      });
    });

    document.addEventListener('click', (e) => {
      const navPanel = document.getElementById('nav-chat-panel');
      if (!navPanel || navPanel.classList.contains('hidden')) return;
      if (navPanel.dataset.docked === 'true') {
        // Docked on the dashboard: only the explicit ✕ dismisses it — a
        // click-outside-to-close here would fight with clicking around
        // inside the dashboard while reading a response.
        return;
      }
      const topBar = document.querySelector('.top-bar-inner');
      if (!navPanel.contains(e.target) && topBar && !topBar.contains(e.target)) {
        navPanel.classList.add('hidden');
      }
    });

    // Wire standard chips (if any remaining)
    document.querySelectorAll('.chat-chip:not(.newtab-chip)').forEach((chip) => {
      chip.addEventListener('click', () => sendChat(chip.getAttribute('data-query') || chip.textContent));
    });
  }

  function wireTopRightAndOverlays() {
    const btnMoreMenu = $('#btn-more-menu');
    const moreDropdownMenu = $('#more-dropdown-menu');

    if (btnMoreMenu && moreDropdownMenu) {
      btnMoreMenu.addEventListener('click', (e) => {
        e.stopPropagation();
        moreDropdownMenu.classList.toggle('hidden');
      });

      document.addEventListener('click', (e) => {
        if (!e.target.closest('#btn-more-menu') && !e.target.closest('#more-dropdown-menu')) {
          moreDropdownMenu.classList.add('hidden');
        }
      });
    }

    $('#dropdown-ipfs')?.addEventListener('click', () => {
      moreDropdownMenu?.classList.add('hidden');
      const activeTab = tabs.find(t => t.id === activeTabId);
      if (activeTab && activeTab.webview) {
        toggleIPFS();
      } else {
        showDashboardView('ipfs');
      }
    });

    $('#dropdown-settings')?.addEventListener('click', () => {
      moreDropdownMenu?.classList.add('hidden');
      const activeTab = tabs.find(t => t.id === activeTabId);
      if (activeTab && activeTab.webview) {
        toggleSidebar('settings');
      } else {
        showDashboardView('settings');
      }
    });

    $('#dropdown-history')?.addEventListener('click', () => {
      moreDropdownMenu?.classList.add('hidden');
      const activeTab = tabs.find(t => t.id === activeTabId);
      if (activeTab && activeTab.webview) {
        toggleSidebar('history');
      } else {
        showDashboardView('history');
      }
    });

    $('#dropdown-bookmarks')?.addEventListener('click', () => {
      moreDropdownMenu?.classList.add('hidden');
      const activeTab = tabs.find(t => t.id === activeTabId);
      if (activeTab && activeTab.webview) {
        toggleSidebar('bookmarks');
      } else {
        showDashboardView('bookmarks');
      }
    });

    $('#dropdown-private')?.addEventListener('click', () => {
      moreDropdownMenu?.classList.add('hidden');
      window.bucksAPI.openPrivateWindow();
    });

    $('#dropdown-downloads')?.addEventListener('click', () => {
      moreDropdownMenu?.classList.add('hidden');
      toggleSidebar('downloads');
    });
    $('#btn-close-downloads')?.addEventListener('click', () => toggleSidebar('downloads'));
    $('#btn-open-downloads-folder')?.addEventListener('click', () => window.bucksAPI.openDownloadsFolder());

    $('#dropdown-print')?.addEventListener('click', () => {
      moreDropdownMenu?.classList.add('hidden');
      printActiveTab();
    });

    $('#btn-zoom-in')?.addEventListener('click', (e) => { e.stopPropagation(); applyZoom(zoomFactor + 0.1); });
    $('#btn-zoom-out')?.addEventListener('click', (e) => { e.stopPropagation(); applyZoom(zoomFactor - 0.1); });

    const storeOverlay = $('#store-overlay');
    if (storeOverlay) {
      storeOverlay.addEventListener('click', (e) => {
        if (e.target === storeOverlay) {
          storeOverlay.classList.add('hidden');
        }
      });
    }

    const libOverlay = $('#widget-library-overlay');
    if (libOverlay) {
      libOverlay.addEventListener('click', (e) => {
        if (e.target === libOverlay) {
          libOverlay.classList.add('hidden');
        }
      });
    }

    // 4. Nav Add Widget icon trigger
    $('#nav-add-widget')?.addEventListener('click', () => {
      const libOverlay = $('#widget-library-overlay');
      if (libOverlay) libOverlay.classList.remove('hidden');
    });

    // 5. Left Dock auto-hide handle in web-mode and map full-view mode
    const leftDockTrigger = document.getElementById('left-dock-trigger');
    const leftDock = document.querySelector('.left-dock');
    if (leftDockTrigger && leftDock) {
      const showDock = () => {
        leftDock.classList.add('expanded');
        leftDockTrigger.querySelector('svg').style.transform = 'rotate(180deg)';
      };
      const hideDock = () => {
        leftDock.classList.remove('expanded');
        leftDockTrigger.querySelector('svg').style.transform = 'rotate(0deg)';
      };
      leftDockTrigger.addEventListener('mouseenter', () => {
        if (!document.body.classList.contains('dock-collapsed')) {
          showDock();
        }
      });
      leftDockTrigger.addEventListener('click', () => {
        if (document.body.classList.contains('dock-collapsed')) {
          document.body.classList.toggle('dock-expanded');
        } else {
          showDock();
        }
      });
      leftDock.addEventListener('mouseleave', () => {
        if (document.body.classList.contains('dock-collapsed')) {
          document.body.classList.remove('dock-expanded');
        } else {
          hideDock();
        }
      });
    }

    // 6. FAB & Left Chat Panel sliding drawer toggles
    const fab = document.getElementById('fab-agent-chat');
    const leftChatPanel = document.getElementById('left-chat-panel');
    const btnCloseLeftChat = document.getElementById('btn-close-left-chat');

    if (fab && leftChatPanel) {
      fab.addEventListener('click', () => {
        leftChatPanel.classList.remove('hidden');
        setTimeout(() => {
          leftChatPanel.classList.toggle('open');
        }, 10);
      });
    }

    if (btnCloseLeftChat && leftChatPanel) {
      btnCloseLeftChat.addEventListener('click', () => {
        leftChatPanel.classList.remove('open');
        setTimeout(() => {
          leftChatPanel.classList.add('hidden');
        }, 300);
      });
    }

    // 7. Wire Chat inside Left Panel
    try {
      wireLeftAgentChat();
    } catch (e) {
      console.error('[Init] wireLeftAgentChat failed:', e);
    }

    // 8. Wire dedicated Chat Tab + newtab nav cards
    try {
      wireChatTab();
      // Load persisted chat history so past conversations survive reload.
      loadChatThreadsFromBackend();
    } catch (e) {
      console.error('[Init] wireChatTab failed:', e);
    }
  }

  function wireLeftAgentChat() {
    const input = document.getElementById('left-chat-input');
    const send = document.getElementById('left-btn-chat-send');
    const reset = document.getElementById('left-btn-chat-reset');
    const dismiss = document.getElementById('left-btn-chat-dismiss');

    if (input) {
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          sendChat(input.value);
        }
      });
    }
    if (send) {
      send.addEventListener('click', () => {
        sendChat(input ? input.value : '');
      });
    }
    if (reset) {
      reset.addEventListener('click', resetChat);
    }
    if (dismiss) {
      dismiss.addEventListener('click', () => {
        const eph = document.getElementById('left-chat-ephemeral-ui');
        if (eph) eph.classList.add('hidden');
      });
    }

    document.querySelectorAll('#left-chat-panel .chat-chip').forEach((chip) => {
      chip.addEventListener('click', () => {
        sendChat(chip.getAttribute('data-query') || chip.textContent);
      });
    });
  }

  /* ═══════════ CHAT TAB — Dedicated Multi-Turn Chat Experience ═══════════ */

  const chatTabThreads = {}; // { threadId: { id, title, messages: [{role, text}], loaded } }
  let chatTabActiveThread = null;
  let chatTabBusy = false;

  // ── Chat history persistence (SQLite via Soul Engine) ──
  // All persistence is fire-and-forget: the UI never blocks on it, and if the
  // engine is offline the chat still works in-memory (just won't survive reload).
  function persistThreadCreate(id, title) {
    fetch(`${SOUL_ENGINE}/chat/threads`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ thread_id: id, title }),
    }).catch(() => {});
  }
  function persistMessage(id, role, text) {
    fetch(`${SOUL_ENGINE}/chat/threads/${encodeURIComponent(id)}/messages`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ role, text }),
    }).catch(() => {});
  }
  function persistRename(id, title) {
    fetch(`${SOUL_ENGINE}/chat/threads/${encodeURIComponent(id)}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title }),
    }).catch(() => {});
  }
  function persistDelete(id) {
    fetch(`${SOUL_ENGINE}/chat/threads/${encodeURIComponent(id)}`, { method: 'DELETE' }).catch(() => {});
  }

  // Load thread list (metadata only) from the backend at startup. Messages are
  // fetched lazily when a thread is opened, to keep startup fast.
  async function loadChatThreadsFromBackend() {
    try {
      const r = await fetch(`${SOUL_ENGINE}/chat/threads`, { signal: AbortSignal.timeout(3000) });
      if (!r.ok) return;
      const { threads } = await r.json();
      (threads || []).forEach(t => {
        if (!chatTabThreads[t.thread_id]) {
          chatTabThreads[t.thread_id] = { id: t.thread_id, title: t.title, messages: [], loaded: (t.message_count === 0) };
        }
      });
      renderChatTabHistory();
    } catch (_) {}
  }

  async function openChatThread(id) {
    chatTabActiveThread = id;
    const thread = chatTabThreads[id];
    if (thread && !thread.loaded) {
      try {
        const r = await fetch(`${SOUL_ENGINE}/chat/threads/${encodeURIComponent(id)}`, { signal: AbortSignal.timeout(4000) });
        if (r.ok) {
          const data = await r.json();
          thread.messages = (data.messages || []).map(m => {
            if (m.role === 'component') {
              try { return { role: 'component', ui: JSON.parse(m.text) }; }
              catch (_) { return { role: 'assistant', text: m.text }; }
            }
            return { role: m.role, text: m.text };
          });
        }
      } catch (_) {}
      thread.loaded = true;
    }
    renderChatTabHistory();
    renderChatTabMessages();
  }

  function createChatThread(title) {
    const id = 'thread-' + Date.now();
    chatTabThreads[id] = { id, title: title || 'New Chat', messages: [], loaded: true };
    chatTabActiveThread = id;
    persistThreadCreate(id, chatTabThreads[id].title);
    renderChatTabHistory();
    renderChatTabMessages();
    return id;
  }

  function renderChatTabHistory() {
    const list = document.getElementById('chat-tab-history-list');
    if (!list) return;
    const ids = Object.keys(chatTabThreads).reverse();
    if (!ids.length) {
      list.innerHTML = '<div style="font-size:12px; color:rgba(255,255,255,0.3); padding:6px 6px;">No chats yet</div>';
      return;
    }
    list.innerHTML = ids.map(id => {
      const t = chatTabThreads[id];
      const isActive = id === chatTabActiveThread;
      return `<div class="chat-thread-row" data-thread="${id}" style="width:100%; padding:8px 10px; border-radius:9px; cursor:pointer; font-size:12.5px; color:${isActive ? '#fff' : 'rgba(255,255,255,0.6)'}; background:${isActive ? 'rgba(123,63,228,0.32)' : 'transparent'}; transition:background 0.15s; display:flex; align-items:center; gap:8px; overflow:hidden;">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" opacity="0.6" style="flex-shrink:0;"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
        <span style="white-space:nowrap; overflow:hidden; text-overflow:ellipsis; flex:1;">${escapeHtml(t.title)}</span>
        <button class="chat-thread-del" data-del="${id}" title="Delete chat" style="flex-shrink:0; background:transparent; border:none; cursor:pointer; color:rgba(255,255,255,0.35); padding:2px; display:flex; opacity:0.7;">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2m2 0v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/></svg>
        </button>
      </div>`;
    }).join('');
    list.querySelectorAll('.chat-thread-row').forEach(row => {
      row.addEventListener('click', (e) => {
        if (e.target.closest('.chat-thread-del')) return;  // delete handled separately
        openChatThread(row.getAttribute('data-thread'));
      });
    });
    list.querySelectorAll('.chat-thread-del').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const id = btn.getAttribute('data-del');
        delete chatTabThreads[id];
        persistDelete(id);
        if (chatTabActiveThread === id) {
          const remaining = Object.keys(chatTabThreads);
          chatTabActiveThread = remaining.length ? remaining[remaining.length - 1] : null;
        }
        renderChatTabHistory();
        renderChatTabMessages();
      });
    });
  }

  function renderChatTabMessages() {
    const container = document.getElementById('chat-tab-messages');
    if (!container) return;
    const thread = chatTabActiveThread ? chatTabThreads[chatTabActiveThread] : null;
    if (!thread || !thread.messages.length) {
      container.innerHTML = `<div style="display:flex; justify-content:center; padding:30px 0;">
        <div style="text-align:center; max-width:400px;">
          <div style="font-size:36px; margin-bottom:12px;">✨</div>
          <div style="font-weight:700; font-size:18px; margin-bottom:8px;">Start a conversation</div>
          <div style="font-size:13px; color:rgba(255,255,255,0.5); line-height:1.6;">Ask anything — research, browse the web, analyze data, interact with IPFS, or just chat.</div>
        </div>
      </div>`;
      return;
    }
    container.innerHTML = thread.messages.filter(msg =>
      msg.role === 'component' || (msg.text && msg.text.trim())
    ).map(msg => {
      const isUser = msg.role === 'user';
      if (msg.role === 'component' && msg.ui) {
        return renderComponent(msg.ui).outerHTML;
      }
      if (isUser) {
        return `<div style="display:flex; flex-direction:column; align-items:flex-end; gap:4px; margin-bottom:12px;">
          <div style="max-width:85%; padding:10px 14px; border-radius:14px 14px 4px 14px; background:linear-gradient(135deg,#7b3fe4,#a978ff); font-size:14px; line-height:1.55; white-space:pre-wrap; color:#fff; box-shadow:0 2px 8px rgba(0,0,0,0.2);">${escapeHtml(msg.text)}</div>
          <div style="font-size:10.5px; color:rgba(255,255,255,0.3); padding:0 4px;">You</div>
        </div>`;
      } else {
        const parsed = formatNexusAnswer(msg.text);
        
        let ctaHtml = '';
        if (parsed.links.length > 0 || parsed.followups.length > 0) {
          ctaHtml = `<div style="display:flex; flex-wrap:wrap; gap:6px; margin-top:8px; padding-top:6px; border-top:1px dashed rgba(255,255,255,0.1);">`;
          parsed.links.forEach(link => {
            ctaHtml += `
              <a href="#" onclick="window.openAgentLink('${escapeHtml(link.url)}'); event.preventDefault();" style="display: inline-flex; align-items: center; gap: 4px; padding: 4px 8px; border-radius: 6px; border: 1px solid rgba(120, 180, 255, 0.3); background: rgba(120, 180, 255, 0.08); color: rgba(120, 180, 255, 0.95); font-size: 10.5px; font-weight: 600; text-decoration: none; cursor: pointer; transition: all 0.15s ease;" onmouseover="this.style.background='rgba(120, 180, 255, 0.15)'; this.style.borderColor='rgba(120, 180, 255, 0.5)';" onmouseout="this.style.background='rgba(120, 180, 255, 0.08)'; this.style.borderColor='rgba(120, 180, 255, 0.3)';">
                <svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6M15 3h6v6M10 14L21 3"/></svg>
                ${escapeHtml(link.text)}
              </a>`;
          });
          parsed.followups.forEach(q => {
            ctaHtml += `
              <button onclick="window.submitAgentFollowup('${encodeURIComponent(q)}')" style="display: inline-flex; align-items: center; gap: 4px; padding: 4px 8px; border-radius: 6px; border: 1px solid rgba(255, 255, 255, 0.1); background: rgba(255, 255, 255, 0.03); color: rgba(255, 255, 255, 0.8); font-size: 10.5px; font-weight: 500; font-family: inherit; cursor: pointer; transition: all 0.15s ease;" onmouseover="this.style.background='rgba(255, 255, 255, 0.08)'; this.style.borderColor='rgba(255, 255, 255, 0.2)'; this.style.color='#fff';" onmouseout="this.style.background='rgba(255, 255, 255, 0.03)'; this.style.borderColor='rgba(255, 255, 255, 0.1)'; this.style.color='rgba(255, 255, 255, 0.8)';">
                <svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14M12 5l7 7-7 7"/></svg>
                ${escapeHtml(q)}
              </button>`;
          });
          ctaHtml += `</div>`;
        }

        return `<div style="display:flex; flex-direction:column; align-items:flex-start; gap:4px; margin-bottom:12px; width:100%;">
          <div style="max-width:88%; padding:10px 14px; border-radius:14px 14px 14px 4px; background:rgba(255,255,255,0.08); border:1px solid rgba(255,255,255,0.1); font-size:14px; line-height:1.55; white-space:pre-wrap; color:#fff; box-shadow:0 2px 8px rgba(0,0,0,0.2); width:100%;">
            <div class="nx-token-body">${parsed.html}</div>
            ${ctaHtml}
          </div>
          <div style="font-size:10.5px; color:rgba(255,255,255,0.3); padding:0 4px;">✦ Bucks AI</div>
        </div>`;
      }
    }).join('');
    container.scrollTop = container.scrollHeight;
  }

  function appendChatTabMessage(role, text) {
    if (!chatTabActiveThread) createChatThread('New Chat');
    const thread = chatTabThreads[chatTabActiveThread];
    thread.messages.push({ role, text });
    if (thread.messages.length === 1 && role === 'user') {
      thread.title = text.slice(0, 42) + (text.length > 42 ? '…' : '');
      persistRename(thread.id, thread.title);
      renderChatTabHistory();
    }
    persistMessage(thread.id, role, text);
    renderChatTabMessages();
  }

  // A generative-UI component in the full-screen chat. Stored as a special
  // 'component' message so it renders in place and survives reload (persisted
  // with role 'component' and the spec JSON as text).
  function appendChatTabComponent(ev) {
    if (!chatTabActiveThread) createChatThread('New Chat');
    const thread = chatTabThreads[chatTabActiveThread];
    const spec = { component: ev.component, title: ev.title || '', data: ev.data || {} };
    thread.messages.push({ role: 'component', ui: spec });
    persistMessage(thread.id, 'component', JSON.stringify(spec));
    renderChatTabMessages();
  }

  // Persist the assistant reply once, after streaming completes (the streaming
  // path builds it up chunk-by-chunk in-memory via appendChatTabAssistantChunk;
  // we don't want to POST every token).
  function persistChatTabAssistantFinal() {
    const thread = chatTabActiveThread ? chatTabThreads[chatTabActiveThread] : null;
    if (!thread || !thread.messages.length) return;
    const last = thread.messages[thread.messages.length - 1];
    if (last && last.role === 'assistant' && last.text) {
      persistMessage(thread.id, 'assistant', last.text);
    }
  }

  // Transient one-line status shown while the agent works (thinking / tool
  // activity). Lives outside the message thread so it is never persisted.
  function setChatTabAgentStatus(text) {
    const container = document.getElementById('chat-tab-messages');
    if (!container) return;
    let el = document.getElementById('chat-tab-agent-status');
    if (!text) { if (el) el.remove(); return; }
    if (!el) {
      el = document.createElement('div');
      el.id = 'chat-tab-agent-status';
      el.style.cssText = 'margin:6px 0 10px 4px;font-size:12.5px;color:rgba(255,255,255,0.55);font-style:italic;';
      container.appendChild(el);
    } else {
      container.appendChild(el); // keep it pinned below the latest message
    }
    el.textContent = `⋯ ${text}`;
    container.scrollTop = container.scrollHeight;
  }

  function appendChatTabAssistantChunk(chunk) {
    if (!chatTabActiveThread) return;
    const thread = chatTabThreads[chatTabActiveThread];
    const last = thread.messages[thread.messages.length - 1];
    if (last && last.role === 'assistant') {
      last.text += chunk;
    } else {
      thread.messages.push({ role: 'assistant', text: chunk });
    }
    renderChatTabMessages();
  }

  async function classifyQuery(q) {
    try {
      const res = await fetch(`${SOUL_ENGINE}/router/classify?q=${encodeURIComponent(q)}`);
      if (res.ok) {
        const data = await res.json();
        return { useAgent: !!data.use_agent, domain: data.domain };
      }
    } catch (_) {}
    const intent = classifyIntent(q);
    const useAgent = intent === 'search' || intent === 'research' || intent === 'agent';
    return { useAgent, domain: intent };
  }

  async function sendChatTab(query) {
    const q = (query || '').trim();
    if (!q || chatTabBusy) return;

    // Intercept local view navigation slash commands
    const lower = q.toLowerCase();
    const isLocalNav = ['/wallet', '/ipfs', '/files', '/studio', '/history', '/bookmarks', '/settings'].some(cmd => lower.startsWith(cmd));
    if (isLocalNav) {
      const input = document.getElementById('chat-tab-input') || document.getElementById('nt-search-input');
      if (input) { input.value = ''; if (input.tagName === 'TEXTAREA') input.style.height = 'auto'; }

      if (lower.startsWith('/wallet')) {
        if (window.bucksAPI.showWallet) {
          showDashboardView('wallet');
        } else {
          showToast('Wallet is disabled', 'error');
        }
      }
      else if (lower.startsWith('/ipfs')) showDashboardView('ipfs');
      else if (lower.startsWith('/files')) showDashboardView('files');
      else if (lower.startsWith('/studio')) showDashboardView('studio');
      else if (lower.startsWith('/history')) showDashboardView('history');
      else if (lower.startsWith('/bookmarks')) showDashboardView('bookmarks');
      else if (lower.startsWith('/settings')) showDashboardView('settings');
      return;
    }

    chatTabBusy = true;

    if (!chatTabActiveThread) createChatThread('New Chat');
    appendChatTabMessage('user', q);

    const input = document.getElementById('chat-tab-input') || document.getElementById('nt-search-input');
    if (input) { input.value = ''; if (input.tagName === 'TEXTAREA') input.style.height = 'auto'; }

    // Build context from thread history for multi-turn
    const thread = chatTabThreads[chatTabActiveThread];
    const history = thread.messages.slice(-10).map(m => `${m.role === 'user' ? 'User' : 'AI'}: ${m.text}`).join('\n');
    let context = `Chat history:\n${history}`;
    try {
      const activeCtx = await captureActivePageContext();
      if (activeCtx) context += `\n\n${activeCtx}`;
    } catch (_) {}

    // Agentic path: explicit "/agent <task>", a shopping query, or an agentic skillset slash command
    const isAgent = /^\/agent(ic)?\b/i.test(q) || isShoppingQuery(q) ||
                    isMediaOrResearchQuery(q) ||
                    /^\/(product|scrape|summarize|summerize|links|code|calendar|track|ipfs|images|video|play|research|weather|search)/i.test(q);
    if (isAgent) {
      const taskPrompt = translateSlashCommand(q).replace(/^\/agent(ic)?\s*/i, '').trim();
      if (!taskPrompt) {
        appendChatTabAssistantChunk('Usage: /agent <task> — e.g. "/agent find the pricing page and read me the cheapest plan"');
        chatTabBusy = false;
        return;
      }
      try {
        await runAgenticTask(taskPrompt, (ev) => {
          if (!ev) return;
          // Only the model's final answer (token) and rendered components reach
          // the message bubble. Tool traffic, thinking, and browser-tool errors
          // are transient status — never dump their raw content into the answer.
          switch (ev.type) {
            case 'ui_component': appendChatTabComponent(ev); break;
            case 'token': appendChatTabAssistantChunk(ev.content || ev.token || ''); break;
            case 'thinking':
            case 'tool_call':
            case 'tool':
              // Internal tool chatter: transient status line, never in the answer.
              setChatTabAgentStatus(ev.type === 'thinking'
                ? (ev.content || 'Reasoning…')
                : (ev.label || ev.name || 'Working…'));
              break;
            case 'browser_action':
              if (ev.needs_approval) appendChatTabAssistantChunk(`\n🌐 ${ev.label || ev.name}\n`);
              else setChatTabAgentStatus(ev.label || ev.name || 'Browser action…');
              break;
            case 'error':
              appendChatTabAssistantChunk(`\n⚠️ ${ev.content || 'error'}\n`);
              break;
            case 'done': setChatTabAgentStatus(''); break;
            // tool_result / result / session → ignore (status only)
            default: break;
          }
        }, context);
        setChatTabAgentStatus('');
        if (agentStopped) appendChatTabAssistantChunk('\n\n■ Stopped by user.');
      } catch (err) {
        appendChatTabAssistantChunk('\nThe inbuilt AI engine is still starting up — give it a few seconds and try again.');
      } finally {
        chatTabBusy = false;
        setChatTabAgentStatus('');
        persistChatTabAssistantFinal();
      }
      return;
    }

    const { useAgent } = await classifyQuery(q);

    try {
      let answer = '';
      if (useAgent) {
        appendChatTabAssistantChunk('');
        await streamSSE(`${SOUL_ENGINE}/agent`, { message: q, context }, (ev) => {
          if (!ev) return;
          // Only the model's final answer and rendered components become part of
          // the message. Thinking/tool traffic is transient status shown in the
          // steps box — never persisted into the answer bubble (see the /agent
          // slash path above for the same rule).
          switch (ev.type) {
            case 'token':
              answer += ev.content || ev.token || '';
              appendChatTabAssistantChunk(ev.content || ev.token || '');
              break;
            case 'ui_component': appendChatTabComponent(ev); break;
            case 'thinking':
            case 'tool_call':
            case 'tool_result':
              setChatTabAgentStatus(ev.type === 'thinking'
                ? (ev.content || 'Reasoning…')
                : (ev.label || ev.name || 'Working…'));
              break;
            case 'browser_action':
              if (ev.needs_approval) appendChatTabAssistantChunk(`\n🌐 ${ev.label || ev.name}\n`);
              else setChatTabAgentStatus(ev.label || ev.name || 'Browser action…');
              break;
            case 'error':
              appendChatTabAssistantChunk(`\n⚠️ ${ev.content || 'error'}\n`);
              break;
            case 'done': setChatTabAgentStatus(''); break;
            default: break; // session / cancelled → status only
          }
        });
        setChatTabAgentStatus('');
      } else {
        appendChatTabAssistantChunk('');
        await streamSSE(`${SOUL_ENGINE}/chat`, { message: q, system: context, stream: true }, (ev) => {
          const chunk = ev.token || ev.content || '';
          if (chunk) { answer += chunk; appendChatTabAssistantChunk(chunk); }
        });
      }
      if (!answer) appendChatTabAssistantChunk('(No response — Soul Engine may be offline)');
    } catch (err) {
      appendChatTabAssistantChunk('The inbuilt AI engine is still starting up — give it a few seconds and try again.');
    } finally {
      chatTabBusy = false;
      setChatTabAgentStatus('');
      persistChatTabAssistantFinal();
    }
  }

  function wireChatTab() {
    // Wire the input textarea to send on Enter (Shift+Enter = newline)
    const input = document.getElementById('chat-tab-input');
    const sendBtn = document.getElementById('chat-tab-send');
    const newChatBtn = document.getElementById('btn-new-chat-thread');

    if (input) {
      const inputRow = input.closest('div');
      if (inputRow) {
        inputRow.style.position = 'relative';
        setupCommandSuggestions(input, inputRow, true);
      }

      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
          // If suggestion dropdown is open, autocomplete Enter is handled in setupCommandSuggestions keydown listener.
          // However, we check if suggestions dropdown exists in DOM to avoid submitting the query when selecting a command.
          const hasSuggestions = inputRow.querySelector('.command-suggestions-dropdown');
          if (hasSuggestions) return; // let suggestion listener handle Enter

          e.preventDefault();
          sendChatTab(input.value);
        }
      });
      // Auto-resize textarea
      input.addEventListener('input', () => {
        input.style.height = 'auto';
        input.style.height = Math.min(input.scrollHeight, 120) + 'px';
      });
    }
    if (sendBtn) {
      sendBtn.addEventListener('click', () => sendChatTab(input ? input.value : ''));
    }
    const stopBtn = document.getElementById('chat-tab-stop');
    if (stopBtn) {
      stopBtn.addEventListener('click', () => stopAgenticTask());
    }
    if (newChatBtn) {
      newChatBtn.addEventListener('click', () => {
        createChatThread('New Chat');
      });
    }

    // Also wire the FAB to open the Chat Tab view (on dashboard) or toggle left panel (on web)
    const fab = document.getElementById('fab-agent-chat');
    if (fab) {
      // Remove any previously attached listener by cloning
      const newFab = fab.cloneNode(true);
      fab.parentNode.replaceChild(newFab, fab);
      newFab.addEventListener('click', () => {
        const activeTab = tabs.find(t => t.id === activeTabId);
        if (!activeTab || !activeTab.webview) {
          // On home/dashboard — show chat tab view
          if (!chatTabActiveThread) createChatThread('New Chat');
          showDashboardView('chat-tab');
          setTimeout(() => document.getElementById('nt-search-input')?.focus(), 100);
        } else {
          // On web page — open sliding left chat panel
          const leftChatPanel = document.getElementById('left-chat-panel');
          if (leftChatPanel) {
            leftChatPanel.classList.remove('hidden');
            setTimeout(() => leftChatPanel.classList.toggle('open'), 10);
          }
        }
      });
    }

    // Wire newtab quick-nav card: Settings
    document.getElementById('newtab-btn-settings')?.addEventListener('click', () => showDashboardView('settings'));
    // Wire newtab nav cards for history/bookmarks
    document.getElementById('newtab-btn-history')?.addEventListener('click', () => showDashboardView('history'));
    document.getElementById('newtab-btn-bookmarks')?.addEventListener('click', () => showDashboardView('bookmarks'));
    document.getElementById('newtab-btn-spaces')?.addEventListener('click', () => showDashboardView('spaces'));
    document.getElementById('newtab-btn-wallet')?.addEventListener('click', () => showDashboardView('wallet'));
    document.getElementById('newtab-btn-ipfs')?.addEventListener('click', () => showDashboardView('ipfs'));

    // Mini app launch buttons on home page
    document.querySelectorAll('.nt-app-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const url = btn.dataset.url;
        if (url) createTab(url, activeSpaceId);
      });
    });

    // App Store card open buttons
    document.getElementById('store-apps-grid')?.addEventListener('click', e => {
      const card = e.target.closest('.store-app-card');
      if (!card) return;
      const url = card.dataset.appUrl;
      if (url) {
        createTab(url, activeSpaceId);
        document.getElementById('store-overlay')?.classList.add('hidden');
      }
    });

    // Home page live clock + greeting
    function updateNewtabClock() {
      const now = new Date();
      const h = now.getHours(), m = now.getMinutes();
      const timeEl = document.getElementById('nt-time');
      const greetEl = document.getElementById('nt-greeting');
      const dateEl = document.getElementById('nt-date');
      if (timeEl) timeEl.textContent = String(h).padStart(2,'0') + ':' + String(m).padStart(2,'0');
      if (greetEl) greetEl.textContent = h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
      if (dateEl) dateEl.textContent = now.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
    }
    updateNewtabClock();
    setInterval(updateNewtabClock, 10000);

    // Agentic search bar — same navigate/search/agent routing as the address bar omnibox
    const ntSearchInput = document.getElementById('nt-search-input');
    if (ntSearchInput) {
      const searchWrap = ntSearchInput.closest('.nt-search-wrap');
      if (searchWrap) {
        setupCommandSuggestions(ntSearchInput, searchWrap, false);
      }

      ntSearchInput.addEventListener('keydown', (e) => {
        if (e.key !== 'Enter') return;

        // Prevent premature submit if suggestions dropdown is open
        const hasSuggestions = searchWrap?.querySelector('.command-suggestions-dropdown');
        if (hasSuggestions) return;

        const val = ntSearchInput.value.trim();
        if (!val) return;

        // Intercept local view navigation slash commands
        const lower = val.toLowerCase();
        if (lower.startsWith('/wallet')) {
          if (window.bucksAPI.showWallet) {
            showDashboardView('wallet');
          } else {
            showToast('Wallet is disabled', 'error');
          }
          ntSearchInput.value = '';
          return;
        }
        if (lower.startsWith('/ipfs')) { showDashboardView('ipfs'); ntSearchInput.value = ''; return; }
        if (lower.startsWith('/files')) { showDashboardView('files'); ntSearchInput.value = ''; return; }
        if (lower.startsWith('/studio')) { showDashboardView('studio'); ntSearchInput.value = ''; return; }
        if (lower.startsWith('/history')) { showDashboardView('history'); ntSearchInput.value = ''; return; }
        if (lower.startsWith('/bookmarks')) { showDashboardView('bookmarks'); ntSearchInput.value = ''; return; }
        if (lower.startsWith('/settings')) { showDashboardView('settings'); ntSearchInput.value = ''; return; }

        if (isURL(val)) {
          navigateTab(activeTabId, val);
        } else {
          const chatTab = document.getElementById('view-chat-tab');
          if (chatTab && !chatTab.classList.contains('hidden')) {
            sendChatTab(val);
          } else {
            dockChatPanel();
            sendChat(val);
          }
        }
        ntSearchInput.value = '';
      });
    }

    // Status card clicks
    document.getElementById('nt-card-wallet')?.addEventListener('click', () => showDashboardView('wallet'));
    document.getElementById('nt-card-ipfs')?.addEventListener('click', () => showDashboardView('ipfs'));
    document.getElementById('nt-card-agent')?.addEventListener('click', () => showDashboardView('chat-tab'));

    // ── Model switcher (SOUL AGENT card) ──
    async function renderModelPicker() {
      const list = document.getElementById('nt-model-picker-list');
      if (!list) return;
      list.innerHTML = '<div style="padding:10px; font-size:12px; color:rgba(255,255,255,0.4);">Loading…</div>';
      try {
        const r = await fetch(`${SOUL_ENGINE}/models`, { signal: AbortSignal.timeout(3000) });
        const { models, current } = await r.json();
        if (!models || !models.length) {
          list.innerHTML = '<div style="padding:10px; font-size:12px; color:rgba(255,255,255,0.4);">Model switching needs edge mode.</div>';
          return;
        }
        list.innerHTML = models.map(m => {
          const disabled = !m.fits_ram && !m.current;
          const check = m.current
            ? '<svg class="nt-model-row-check" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><polyline points="20 6 9 17 4 12"/></svg>'
            : '<span style="width:14px;flex-shrink:0;"></span>';
          const dl = m.downloaded ? '' : '<span class="nt-model-row-dl">↓ download</span>';
          return `<div class="nt-model-row ${disabled ? 'disabled' : ''}" data-model="${m.id}" data-disabled="${disabled}">
            ${check}
            <span class="nt-model-row-name">${escapeHtml(m.id)}${dl}</span>
            <span class="nt-model-row-meta">${m.size_gb} GB</span>
          </div>`;
        }).join('');
      } catch (_) {
        list.innerHTML = '<div style="padding:10px; font-size:12px; color:rgba(255,255,255,0.4);">Soul Engine offline.</div>';
      }
    }

    const modelBtn = document.getElementById('nt-agent-model-btn');
    const modelPicker = document.getElementById('nt-model-picker');
    modelBtn?.addEventListener('click', (e) => {
      e.stopPropagation();  // don't trigger the card's "open chat" handler
      const willShow = modelPicker.classList.contains('hidden');
      modelPicker.classList.toggle('hidden');
      if (willShow) renderModelPicker();
    });
    modelPicker?.addEventListener('click', (e) => e.stopPropagation());
    document.getElementById('nt-model-picker-list')?.addEventListener('click', async (e) => {
      const row = e.target.closest('.nt-model-row');
      if (!row || row.dataset.disabled === 'true') return;
      const model = row.dataset.model;
      row.querySelector('.nt-model-row-name').insertAdjacentHTML('beforeend', ' <span style="color:rgba(255,255,255,0.4);font-size:10px;">switching…</span>');
      try {
        await fetch(`${SOUL_ENGINE}/models/select`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ model }),
        });
      } catch (_) {}
      await renderModelPicker();
      updateNewtabStatus();  // refresh the card's model label
    });
    // Close picker on outside click
    document.addEventListener('click', () => {
      modelPicker?.classList.add('hidden');
    });

    // Live status card data
    function updateNewtabStatus() {
      // Wallet card
      const walletDot = document.getElementById('nt-wallet-dot');
      const walletBal = document.getElementById('nt-wallet-balance');
      const walletLbl = document.getElementById('nt-wallet-label');
      if (walletState?.connected) {
        if (walletDot) { walletDot.className = 'nt-status-dot online'; }
        if (walletBal) walletBal.textContent = walletState.balance ? walletState.balance + ' BTC' : 'Connected';
        if (walletLbl) walletLbl.textContent = walletState.address ? walletState.address.slice(0,8)+'…' : 'Wallet active';
      } else {
        if (walletDot) { walletDot.className = 'nt-status-dot'; walletDot.style.background = 'rgba(255,255,255,0.2)'; }
        if (walletBal) walletBal.textContent = 'Not connected';
        if (walletLbl) walletLbl.textContent = 'Click to connect';
      }

      // IPFS card
      const ipfsDot = document.getElementById('nt-ipfs-dot');
      const ipfsPeers = document.getElementById('nt-ipfs-peers');
      const ipfsLbl = document.getElementById('nt-ipfs-label');
      if (window.bucksAPI?.ipfsInfo) {
        window.bucksAPI.ipfsInfo().then(info => {
          const peers = info?.peers ?? 0;
          if (ipfsDot) ipfsDot.className = peers > 0 ? 'nt-status-dot online' : 'nt-status-dot warning';
          if (ipfsPeers) ipfsPeers.textContent = peers + ' peers';
          if (ipfsLbl) ipfsLbl.textContent = peers > 0 ? 'Node online' : 'Connecting…';
        }).catch(() => {
          if (ipfsDot) { ipfsDot.className = 'nt-status-dot'; ipfsDot.style.background = 'rgba(255,255,255,0.2)'; }
          if (ipfsPeers) ipfsPeers.textContent = 'Offline';
          if (ipfsLbl) ipfsLbl.textContent = 'Node not running';
        });
      }

      // Agent card
      const agentDot = document.getElementById('nt-agent-dot');
      const agentModel = document.getElementById('nt-agent-model');
      const agentLbl = document.getElementById('nt-agent-label');
      fetch('http://127.0.0.1:8765/health', { signal: AbortSignal.timeout(2000) })
        .then(r => r.ok ? r.json() : Promise.reject())
        .then(data => {
          if (agentDot) agentDot.className = 'nt-status-dot online';
          if (agentModel) agentModel.textContent = data?.model || 'hermes3';
          if (agentLbl) agentLbl.textContent = 'Soul Engine ready';
        })
        .catch(() => {
          if (agentDot) { agentDot.className = 'nt-status-dot'; agentDot.style.background = 'rgba(255,255,255,0.2)'; }
          if (agentModel) agentModel.textContent = 'Offline';
          if (agentLbl) agentLbl.textContent = 'Start soul_engine.py';
        });
    }
    updateNewtabStatus();
    setInterval(updateNewtabStatus, 15000);

    // ── Ephemeral UI use case: peer knowledge/adapter consent queue (Phase 4) ──
    // Polls the real /agent/pending endpoint; each card is a live user-gated
    // approve/deny decision, not a mock — nothing gets pinned or loaded into
    // RAG until the user clicks Approve here.
    async function updatePendingUpdates() {
      const zone = document.getElementById('nt-pending-zone');
      if (!zone) return;
      try {
        const r = await fetch(`${SOUL_ENGINE}/agent/pending?status=pending`, { signal: AbortSignal.timeout(3000) });
        if (!r.ok) throw new Error('pending fetch failed');
        const { updates } = await r.json();
        if (!updates || !updates.length) {
          zone.classList.add('hidden');
          zone.innerHTML = '';
          return;
        }
        zone.classList.remove('hidden');
        zone.innerHTML = updates.map((u) => {
          const peerLabel = u.peer ? `${u.peer.locality || 'peer'} · ${(u.peer.capabilities || []).join(', ')}` : u.peer_soul_id.slice(0, 12) + '…';
          const kindLabel = u.kind === 'adapter' ? 'Skill/adapter update' : 'Knowledge fragment';
          return `<div class="nt-pending-card" data-update-id="${u.update_id}">
            <div class="nt-pending-card-body">
              <div class="nt-pending-card-title">${escapeHtml(kindLabel)} proposed by ${escapeHtml(peerLabel)}</div>
              <div class="nt-pending-card-sub">${escapeHtml(u.summary || u.cid)}</div>
            </div>
            <div class="nt-pending-card-actions">
              <button class="nt-pending-btn nt-pending-btn--approve" data-action="approve" data-update-id="${u.update_id}">Approve</button>
              <button class="nt-pending-btn nt-pending-btn--deny" data-action="deny" data-update-id="${u.update_id}">Deny</button>
            </div>
          </div>`;
        }).join('');
      } catch (_) {
        zone.classList.add('hidden');
      }
    }

    document.getElementById('nt-pending-zone')?.addEventListener('click', async (e) => {
      const btn = e.target.closest('.nt-pending-btn');
      if (!btn) return;
      const updateId = btn.getAttribute('data-update-id');
      const action = btn.getAttribute('data-action');
      btn.disabled = true;
      try {
        await fetch(`${SOUL_ENGINE}/agent/pending/${encodeURIComponent(updateId)}/${action}`, { method: 'POST' });
      } catch (_) {}
      updatePendingUpdates();
    });

    updatePendingUpdates();
    setInterval(updatePendingUpdates, 15000);

    // (dock trigger logic moved to the unified handler at ~L5106)

    // Initialize first thread if none
    renderChatTabHistory();
  }

  async function init() {
    // Flag-gate the Wallet UI (hide by default unless BUCKS_SHOW_WALLET=1)
    const showWallet = window.bucksAPI.showWallet;
    if (!showWallet) {
      const walletDockBtn = document.getElementById('nav-wallet-side');
      if (walletDockBtn) walletDockBtn.style.setProperty('display', 'none', 'important');

      const walletAppBtn = document.getElementById('newtab-btn-wallet');
      if (walletAppBtn) walletAppBtn.style.setProperty('display', 'none', 'important');

      const walletCard = document.getElementById('nt-card-wallet');
      if (walletCard) walletCard.style.setProperty('display', 'none', 'important');
    }

    const platform = await window.bucksAPI.getPlatform();
    document.body.classList.add(`platform-${platform}`);

    // On Mac with hiddenInset, we hide our custom window controls 
    // because MacOS provides the native traffic lights automatically.
    if (platform === 'darwin') {
      const winControls = $('.window-controls');
      if (winControls) winControls.style.display = 'none';
      const titlebarTitle = $('.titlebar-title');
      if (titlebarTitle) titlebarTitle.style.marginLeft = '70px'; // Make room for traffic lights
    }

    /* ── Swarm Edge Compute ── */
    const SwarmCompute = {
      async delegateTask(taskId, wasmCid, payload) {
        showToast('Swarm: Requesting Edge Compute...', 'info');
        // Logic would broadcast compute:request topic
      }
    };

    // Wire the agent chat bar first so it survives any downstream init error.
    try { wireAgentChat(); } catch (e) { console.error('[Chat] wire failed:', e); }

    try { await loadSettings(); } catch (e) { console.error('[Init] loadSettings:', e); }

    // Initialize Workspace, Widgets, Chat History, App Store
    try {
      loadWidgets();
      renderWidgets();
      wireWidgetsCanvas();
      setInterval(updateClocks, 1000);
    } catch (e) {
      console.error('[Init] Widgets Engine failed:', e);
    }

    try {
      loadChatHistory();
      renderChatHistory();
      wireChatHistoryPopover();
    } catch (e) {
      console.error('[Init] Chat History failed:', e);
    }

    try {
      wireAppStore();
    } catch (e) {
      console.error('[Init] App Store failed:', e);
    }

    try {
      wireTopRightAndOverlays();
    } catch (e) {
      console.error('[Init] Top Right and Overlays failed:', e);
    }

    try { createTab(); } catch (e) { console.error('[Init] createTab:', e); }
    try { refreshIPFSStatus(); } catch (e) { console.error('[Init] refreshIPFSStatus:', e); }

    try {
      renderSpaceSelector();
      wireNewTabEvents();
      
      // Toggle Space Selector Dropdown
      $('#space-selector')?.addEventListener('click', (e) => {
        e.stopPropagation();
        $('#space-selector-dropdown')?.classList.toggle('hidden');
        $('#tab-context-menu')?.classList.add('hidden');
      });

      // Global click to dismiss context menus/dropdowns
      document.addEventListener('click', () => {
        $('#tab-context-menu')?.classList.add('hidden');
        $('#space-selector-dropdown')?.classList.add('hidden');
        $('#tabs-slab-dropdown')?.classList.add('hidden');
        $('#more-dropdown-menu')?.classList.add('hidden');
      });

      // New Space Creation Custom Modal Dialog
      const presetColors = ['#52b6ff', '#f7931a', '#2ed573', '#ff7a96', '#a978ff', '#eccc68', '#ff4757'];
      let selectedSpaceColor = '#52b6ff';

      function confirmCreateSpace() {
        const nameInput = $('#create-space-name-input');
        const name = nameInput ? nameInput.value.trim() : '';
        if (!name) {
          showToast('Please enter a space name', 'error');
          return;
        }
        const newId = `space-${Date.now()}`;
        spaces.push({ id: newId, name, color: selectedSpaceColor });
        renderSpaceSelector();
        renderSpacesView();
        $('#create-space-modal')?.classList.add('hidden');
        showToast(`Created space: ${name}`, 'success');
      }

      $('#btn-create-space')?.addEventListener('click', (e) => {
        e.stopPropagation();
        const nameInput = $('#create-space-name-input');
        if (nameInput) nameInput.value = '';
        selectedSpaceColor = '#52b6ff';

        const container = $('#create-space-colors-container');
        if (container) {
          container.innerHTML = '';
          presetColors.forEach(c => {
            const dot = document.createElement('span');
            dot.style.cssText = `width:16px; height:16px; border-radius:50%; background:${c}; cursor:pointer; transition:transform 0.15s, border 0.15s; box-shadow:0 0 6px ${c}; border:2px solid transparent;`;
            if (c === selectedSpaceColor) {
              dot.style.transform = 'scale(1.3)';
              dot.style.borderColor = '#fff';
            }
            dot.addEventListener('click', (ev) => {
              ev.stopPropagation();
              selectedSpaceColor = c;
              container.querySelectorAll('span').forEach(s => {
                s.style.transform = 'none';
                s.style.borderColor = 'transparent';
              });
              dot.style.transform = 'scale(1.3)';
              dot.style.borderColor = '#fff';
            });
            container.appendChild(dot);
          });
        }

        $('#create-space-modal')?.classList.remove('hidden');
        setTimeout(() => nameInput?.focus(), 50);
      });

      $('#btn-create-space-confirm')?.addEventListener('click', (e) => {
        e.stopPropagation();
        confirmCreateSpace();
      });

      $('#btn-create-space-cancel')?.addEventListener('click', (e) => {
        e.stopPropagation();
        $('#create-space-modal')?.classList.add('hidden');
      });

      $('#create-space-modal-overlay')?.addEventListener('click', (e) => {
        e.stopPropagation();
        $('#create-space-modal')?.classList.add('hidden');
      });

      $('#create-space-name-input')?.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          confirmCreateSpace();
        } else if (e.key === 'Escape') {
          $('#create-space-modal')?.classList.add('hidden');
        }
      });
    } catch (e) {
      console.error('[Init] Spaces setup failed:', e);
    }

    // Listen for events from iframe tools (like Creator Studio)
    window.addEventListener('message', async (event) => {
      if (event.data && event.data.action === 'openUrl') {
        createTab(event.data.url);
      } else if (event.data && event.data.action === 'publishDweb') {
        const { name, cid, title, desc } = event.data.data;
        try {
          await window.bucksAPI.ipfsPublishDweb(name, cid, title, desc);
        } catch (e) {
          console.error('[Renderer] Failed to publish dWeb through IPC:', e);
        }
      }
    });

    // Hide splash screen after initialization
    setTimeout(() => {
      const splash = document.getElementById('splash-screen');
      if (splash) {
        splash.style.opacity = '0';
        setTimeout(() => splash.remove(), 500);
      }
    }, 3200); // 3.2s animation duration
  }

  init();
})();
