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
    const wv = document.createElement('webview');
    // Private windows isolate browsing in a non-persistent (in-memory) partition.
    if (IS_PRIVATE) wv.setAttribute('partition', 'bucks-private');
    wv.setAttribute('src', tab.url);
    wv.dataset.tabId = tab.id;
    wv.setAttribute('allowpopups', '');

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

    browserContent.insertBefore(wv, walletSidebar);
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
    browserContent.querySelectorAll('webview').forEach((wv) => wv.classList.remove('active'));
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
    browserContent.querySelectorAll('webview').forEach(wv => wv.classList.remove('active'));
    
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

  $('#btn-back')?.addEventListener('click', () => {
    const tab = tabs.find((t) => t.id === activeTabId);
    if (tab?.webview) tab.webview.goBack();
  });

  $('#btn-forward')?.addEventListener('click', () => {
    const tab = tabs.find((t) => t.id === activeTabId);
    if (tab?.webview) tab.webview.goForward();
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
    // Hide all views, show target view
    const views = document.querySelectorAll('.dashboard-view');
    views.forEach(v => v.classList.add('hidden'));
    const target = document.getElementById(`view-${viewName}`);
    if (target) {
      target.classList.remove('hidden');
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

    // Toggle files-mode class on body to allow fullscreen layout overrides
    if (viewName === 'files' || viewName === 'studio') {
      document.body.classList.add('files-mode');
    } else {
      document.body.classList.remove('files-mode');
    }

    // Dynamic width expansion for wide layouts (Files / Chat Tab / Studio)
    const dashboardWindow = document.getElementById('dashboard-window');
    if (dashboardWindow) {
      if (viewName === 'files' || viewName === 'chat-tab' || viewName === 'studio') {
        dashboardWindow.style.maxWidth = 'calc(100% - 80px)';
        dashboardWindow.style.width = '100%';
      } else {
        dashboardWindow.style.maxWidth = '880px';
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
      const socialRes = await window.bucksAPI.socialRPC({ endpoint: '/' });

      const isHeliaOnline = info && info.status === 'online';
      const isSocialOnline = socialRes && !socialRes.error;

      if (ipfsDot) {
        ipfsDot.className = 'ipfs-dot ' + (isHeliaOnline && isSocialOnline ? 'online' : (isHeliaOnline || isSocialOnline ? 'warning' : 'offline'));
        ipfsDot.title = `Helia: ${isHeliaOnline ? 'ON' : 'OFF'} | Social: ${isSocialOnline ? 'ON' : 'OFF'}`;
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
      await window.bucksAPI.socialRPC({
        method: 'POST',
        endpoint: `/unfollow/${peerId}`
      });
    } catch (e) {
      console.error('[IPFS UI] Unfollow social error:', e);
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
      // 1. Follow in local Helia node (for co-hosting/discovery)
      const localRes = await window.bucksAPI.ipfsFollow(peerId);

      // 2. Follow in Social Backend (for global feed/notifications)
      const socialRes = await window.bucksAPI.socialRPC({
        method: 'POST',
        endpoint: `/follow/${peerId}`
      });

      if (input) input.value = '';
      showToast(`${localRes.status === 'followed' || (socialRes && !socialRes.error) ? '✓ Following' : 'Error'} ${peerId.slice(0, 12)}…`);
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

      // 1. Convert text to byte array and publish to local Helia node
      const encoder = new TextEncoder();
      const content = Array.from(encoder.encode(text));
      const localPost = await window.bucksAPI.ipfsPublish(content, metadata);

      // 2. Broadcast to Global Social Layer
      const socialRes = await window.bucksAPI.socialRPC({
        method: 'POST',
        endpoint: '/upload',
        body: {
          cid: localPost.cid,
          title: metadata.name,
          description: metadata.description,
          type: 'post'
        }
      });

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

      // 1. Publish to local Helia node
      const arrayBuffer = await file.arrayBuffer();
      const content = Array.from(new Uint8Array(arrayBuffer));
      const localPost = await window.bucksAPI.ipfsPublish(content, metadata);

      // 2. Broadcast to Global Social Layer (Port 8000)
      // We send as FormData to match the backend expectation
      const formData = new FormData();
      formData.append('file', file);
      formData.append('title', metadata.name);
      formData.append('description', metadata.description);

      // We use socialRPC but with special handling for FormData if our proxy supports it
      // For now, we'll use a standard json-based upload or a simplified bridge
      const socialRes = await window.bucksAPI.socialRPC({
        method: 'POST',
        endpoint: '/upload',
        body: {
          cid: localPost.cid,
          title: metadata.name,
          description: metadata.description,
          type: 'post'
        }
      });

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

      // Fetch from Global Social Layer (Port 8000)
      const res = await window.bucksAPI.socialRPC({ endpoint: '/feed/aggregated' });
      const feed = res.library || [];

      if (!feed.length) {
        container.innerHTML = '<p class="tx-empty">No content yet. Follow peers to see their posts.</p>';
        const dashFeed = document.getElementById('ipfs-dash-feed');
        if (dashFeed) dashFeed.innerHTML = container.innerHTML;
        return;
      }

      // Get current pinned status from local Helia node
      const stats = await window.bucksAPI.ipfsStorageStats();
      const pinnedCids = new Set((stats.pinnedItems || []).map(i => i.cid));

      container.innerHTML = feed.map(post => {
        const time = post.timestamp ? new Date(post.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : 'recently';
        const peerShort = post.peer_id ? `${post.peer_id.slice(0, 8)}…${post.peer_id.slice(-4)}` : 'Unknown';
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
      const errMsg = `<p class="tx-empty" style="color:var(--danger)">Offline: Social Gateway (8000)</p>`;
      document.getElementById('ipfs-feed').innerHTML = errMsg;
      const dashFeed = document.getElementById('ipfs-dash-feed');
      if (dashFeed) dashFeed.innerHTML = errMsg;
    }
  }

  window._ipfsUpvote = async (cid) => {
    try {
      showToast('Sending appreciation...', 'info');

      // 1. Send Global Like/Recommendation (Port 8000)
      const socialRes = await window.bucksAPI.socialRPC({
        method: 'POST',
        endpoint: `/interactions/${cid}/like`
      });

      if (socialRes.error) {
        console.warn('[Social] Like failed:', socialRes.error);
      }

      // 2. Co-Hosting: Pin content locally (Helia node)
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
  const SOUL_ENGINE = 'http://localhost:8765';
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
  function classifyIntent(q) {
    const lower = q.toLowerCase().trim();

    // Explicit agent command prefix
    if (lower.startsWith('/agent')) return 'agent';

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

  window.submitAgentFollowup = (encodedQuery) => {
    if (!encodedQuery) return;
    const query = decodeURIComponent(encodedQuery);
    const sideInput = document.getElementById('chat-tab-input');
    if (sideInput && sideInput.offsetParent !== null) {
      sideInput.value = query;
      sendChatTab(query);
    } else {
      const input = document.getElementById('chat-input');
      if (input) {
        const q = query.startsWith('/') ? query : `/agent ${query}`;
        input.value = q;
        sendChat(q);
      }
    }
  };

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

    const msgContainer = document.getElementById('bottom-chat-messages');
    if (!msgContainer) return;
    const chatCard = document.getElementById('chat-history-card');
    if (chatCard) chatCard.classList.remove('hidden');

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
    const msgContainer = document.getElementById('bottom-chat-messages');
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
    const chatCard = document.getElementById('chat-history-card');
    if (chatCard) chatCard.scrollTop = chatCard.scrollHeight;
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

  /* ── Generate follow-up suggestions based on query + intent ── */
  function generateFollowUps(query, intent, results) {
    const q = query.toLowerCase();
    const suggestions = [];

    if (intent === 'research' || intent === 'search') {
      if (results && results.length > 0) {
        suggestions.push(`More details about ${results[0].title?.split(' ').slice(0, 4).join(' ')}`);
      }
      if (q.includes('what is')) suggestions.push(`How does ${query.replace(/what is\s*/i, '')} work?`);
      if (q.includes('who is')) suggestions.push(`What is ${query.replace(/who is\s*/i, '')} known for?`);
      suggestions.push(`Latest news about ${query.replace(/^(what is|who is|how does|explain)\s*/i, '').slice(0, 40)}`);
    } else if (intent === 'navigate') {
      suggestions.push(`Search for alternatives to this site`);
      suggestions.push(`Summarize this page`);
    } else {
      suggestions.push(`Search the web for more`);
      suggestions.push(`Tell me more`);
    }
    return suggestions.slice(0, 3);
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
    const msgContainer = document.getElementById('bottom-chat-messages');
    if (msgContainer) msgContainer.innerHTML = '';
    agentConversation = [];
    const chips = document.getElementById('chat-chips-container');
    if (chips) chips.style.display = 'flex';
    const card = document.getElementById('chat-history-card');
    if (card) card.classList.add('hidden');
  }

  async function sendChat(query) {
    const q = (query || '').trim();
    if (!q || chatBusy) return;
    chatBusy = true;
    const startTime = Date.now();

    /* ── NEXUS AGENTIC PATH ──
     * Triggered by: /agent <goal>  OR  keywords like "search and open", "book", etc.
     * Routes to the soul engine /agent endpoint with agentic:true.
     * Renders typed step cards inline in #bottom-chat-messages.
     */
    const intent0 = classifyIntent(q);
    const isAgentCmd = intent0 === 'agent' || q.startsWith('/agent');
    if (isAgentCmd) {
      const goal = q.replace(/^\/agent\s*/i, '').trim() || q;

      // Show user bubble
      const chatCard = document.getElementById('chat-history-card');
      if (chatCard) chatCard.classList.remove('hidden');
      const chips = document.getElementById('chat-chips-container');
      if (chips) chips.style.display = 'none';
      const input = document.getElementById('chat-input');
      if (input) input.value = '';
      const msgContainer = document.getElementById('bottom-chat-messages');
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
      let context = '';
      try {
        const activeTab = tabs.find(t => t.id === activeTabId);
        if (activeTab && activeTab.url && !activeTab.url.startsWith('bucks://')) {
          context = `Active page: ${activeTab.title || ''} (${activeTab.url})`;
        }
      } catch (_) {}

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
            ? 'Agent offline — start the soul engine:\ncd agent && python -m uvicorn soul_engine:app --port 8765'
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
    const chips = document.getElementById('chat-chips-container');
    if (chips) chips.style.display = 'none';

    // Show the chat card and append user message bubble
    const chatCard = document.getElementById('chat-history-card');
    if (chatCard) chatCard.classList.remove('hidden');
    const msgContainer = document.getElementById('bottom-chat-messages');
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
    let activePageContext = '';
    let activeTab = null;
    try {
      activeTab = tabs.find(t => t.id === activeTabId);
      if (activeTab && activeTab.url && !activeTab.url.startsWith('bucks://')) {
        activePageContext = `Active page: ${activeTab.title || ''} (${activeTab.url})`;
      }
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
        const msgContainer = document.getElementById('bottom-chat-messages');
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
          const msgContainer = document.getElementById('bottom-chat-messages');
          
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
          const msgContainer = document.getElementById('bottom-chat-messages');
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

  function wireAgentChat() {
    // --- BOTTOM CHAT BAR WIRING ---
    const bottomInput = document.getElementById('chat-input');
    const bottomSend = document.getElementById('btn-chat-send');
    const bottomReset = document.getElementById('btn-chat-reset');
    const bottomClear = document.getElementById('btn-bottom-chat-clear');
    const bottomClose = document.getElementById('btn-bottom-chat-close');

    if (bottomInput) {
      bottomInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          sendChat(bottomInput.value);
        }
      });
    }
    if (bottomSend) {
      bottomSend.addEventListener('click', () => {
        sendChat(bottomInput ? bottomInput.value : '');
      });
    }
    if (bottomReset) {
      bottomReset.addEventListener('click', resetChat);
    }
    if (bottomClear) {
      bottomClear.addEventListener('click', resetChat);
    }
    if (bottomClose) {
      bottomClose.addEventListener('click', () => {
        const card = document.getElementById('chat-history-card');
        if (card) card.classList.add('hidden');
      });
    }

    // Wire suggestion chips at bottom
    document.querySelectorAll('.bottom-chat-container .chat-chip').forEach((chip) => {
      chip.addEventListener('click', () => {
        sendChat(chip.getAttribute('data-query') || chip.textContent);
      });
    });

    // --- NAV PANEL WIRING (legacy, kept for address bar queries) ---
    const dismissNav = document.getElementById('btn-nav-chat-dismiss');
    if (dismissNav) {
      dismissNav.addEventListener('click', () => {
        const eph = document.getElementById('nav-chat-ephemeral-ui');
        if (eph) eph.classList.add('hidden');
      });
    }

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
      const topBar = document.querySelector('.top-bar-inner');
      if (navPanel && !navPanel.classList.contains('hidden')) {
        if (!navPanel.contains(e.target) && topBar && !topBar.contains(e.target)) {
          navPanel.classList.add('hidden');
        }
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

    // 5. Left Dock auto-hide handle in web-mode
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
      leftDockTrigger.addEventListener('mouseenter', showDock);
      leftDockTrigger.addEventListener('click', showDock);
      leftDock.addEventListener('mouseleave', hideDock);
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

  const chatTabThreads = {}; // { threadId: { title, messages: [{role, text}] } }
  let chatTabActiveThread = null;
  let chatTabBusy = false;

  function createChatThread(title) {
    const id = 'thread-' + Date.now();
    chatTabThreads[id] = { id, title: title || 'Chat ' + Object.keys(chatTabThreads).length, messages: [] };
    chatTabActiveThread = id;
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
      return `<button data-thread="${id}" style="width:100%; text-align:left; padding:8px 10px; border-radius:9px; border:none; cursor:pointer; font-family:inherit; font-size:12.5px; color:${isActive ? '#fff' : 'rgba(255,255,255,0.6)'}; background:${isActive ? 'rgba(123,63,228,0.32)' : 'transparent'}; transition:background 0.15s; display:flex; align-items:center; gap:8px; overflow:hidden;">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" opacity="0.6"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
        <span style="white-space:nowrap; overflow:hidden; text-overflow:ellipsis; flex:1;">${escapeHtml(t.title)}</span>
      </button>`;
    }).join('');
    list.querySelectorAll('[data-thread]').forEach(btn => {
      btn.addEventListener('click', () => {
        chatTabActiveThread = btn.getAttribute('data-thread');
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
    container.innerHTML = thread.messages.map(msg => {
      const isUser = msg.role === 'user';
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
      renderChatTabHistory();
    }
    renderChatTabMessages();
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
    chatTabBusy = true;

    if (!chatTabActiveThread) createChatThread('New Chat');
    appendChatTabMessage('user', q);

    const input = document.getElementById('chat-tab-input');
    if (input) { input.value = ''; input.style.height = 'auto'; }

    // Build context from thread history for multi-turn
    const thread = chatTabThreads[chatTabActiveThread];
    const history = thread.messages.slice(-10).map(m => `${m.role === 'user' ? 'User' : 'AI'}: ${m.text}`).join('\n');
    let context = `Chat history:\n${history}`;
    try {
      const tab = tabs.find(t => t.id === activeTabId);
      if (tab && tab.url && !tab.url.startsWith('bucks://')) context += `\nActive page: ${tab.title || ''} (${tab.url})`;
    } catch (_) {}

    // Agentic browser mode: "/agent <task>" drives the live tab via local tools.
    if (/^\/agent(ic)?\b/i.test(q)) {
      const taskPrompt = q.replace(/^\/agent(ic)?\s*/i, '').trim();
      if (!taskPrompt) {
        appendChatTabAssistantChunk('Usage: /agent <task> — e.g. "/agent find the pricing page and read me the cheapest plan"');
        chatTabBusy = false;
        return;
      }
      appendChatTabAssistantChunk('');
      try {
        await runAgenticTask(taskPrompt, (ev) => {
          if (!ev) return;
          if (ev.type === 'tool') {
            appendChatTabAssistantChunk(`\n› ${ev.content}\n`);
          } else if (ev.type === 'result') {
            const p = String(ev.content || '').replace(/\s+/g, ' ').slice(0, 90);
            appendChatTabAssistantChunk(`  ↳ ${p}\n`);
          } else if (ev.type === 'error') {
            appendChatTabAssistantChunk(`\n⚠️ ${ev.content}\n`);
          } else if (typeof ev.content === 'string') {
            appendChatTabAssistantChunk(ev.content);
          } else if (typeof ev.token === 'string') {
            appendChatTabAssistantChunk(ev.token);
          }
        }, context);
        if (agentStopped) appendChatTabAssistantChunk('\n\n■ Stopped by user.');
      } catch (err) {
        appendChatTabAssistantChunk('\nSoul Engine is offline. Start it: cd agent && python -m uvicorn soul_engine:app --port 8765');
      } finally {
        chatTabBusy = false;
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
          if (ev.type === 'thinking') {
            appendChatTabAssistantChunk(`\n🤔 Thinking: ${ev.content || 'Reasoning…'}\n`);
          } else if (ev.type === 'tool_call') {
            appendChatTabAssistantChunk(`\n🔧 Tool Call: ${ev.label || ev.name}\n`);
          } else if (ev.type === 'tool_result') {
            const contentSnippet = String(ev.content || '').replace(/\s+/g, ' ').slice(0, 100);
            appendChatTabAssistantChunk(`  ↳ Result: ${contentSnippet}…\n`);
          } else if (ev.type === 'browser_action') {
            appendChatTabAssistantChunk(`\n🌐 Browser Action: ${ev.label || ev.name}\n`);
          } else if (ev.type === 'error') {
            appendChatTabAssistantChunk(`\n❌ Error: ${ev.content || 'Unknown error'}\n`);
          } else if (typeof ev.content === 'string') {
            answer += ev.content;
            appendChatTabAssistantChunk(ev.content);
          } else if (typeof ev.token === 'string') {
            answer += ev.token;
            appendChatTabAssistantChunk(ev.token);
          }
        });
      } else {
        appendChatTabAssistantChunk('');
        await streamSSE(`${SOUL_ENGINE}/chat`, { message: q, system: context, stream: true }, (ev) => {
          const chunk = ev.token || ev.content || '';
          if (chunk) { answer += chunk; appendChatTabAssistantChunk(chunk); }
        });
      }
      if (!answer) appendChatTabAssistantChunk('(No response — Soul Engine may be offline)');
    } catch (err) {
      appendChatTabAssistantChunk('Soul Engine is offline.\nStart it: cd ~/Desktop/Bucks\\ Core/Bucks-browser/agent && ./start_soul_engine.sh');
    } finally {
      chatTabBusy = false;
    }
  }

  function wireChatTab() {
    // Wire the input textarea to send on Enter (Shift+Enter = newline)
    const input = document.getElementById('chat-tab-input');
    const sendBtn = document.getElementById('chat-tab-send');
    const newChatBtn = document.getElementById('btn-new-chat-thread');

    if (input) {
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
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
          setTimeout(() => document.getElementById('chat-tab-input')?.focus(), 100);
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

    // Status card clicks
    document.getElementById('nt-card-wallet')?.addEventListener('click', () => showDashboardView('wallet'));
    document.getElementById('nt-card-ipfs')?.addEventListener('click', () => showDashboardView('ipfs'));
    document.getElementById('nt-card-agent')?.addEventListener('click', () => showDashboardView('agent'));

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
      fetch('http://localhost:8765/health', { signal: AbortSignal.timeout(2000) })
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

    // Drawer arrow show/hide left dock in web mode
    const leftDockTrigger = document.getElementById('left-dock-trigger');
    const leftDock = document.querySelector('.left-dock');
    if (leftDockTrigger && leftDock) {
      const showDock = () => {
        leftDock.classList.add('expanded');
        const arrow = leftDockTrigger.querySelector('svg');
        if (arrow) arrow.style.transform = 'rotate(180deg)';
      };
      const hideDock = () => {
        leftDock.classList.remove('expanded');
        const arrow = leftDockTrigger.querySelector('svg');
        if (arrow) arrow.style.transform = 'rotate(0deg)';
      };
      leftDockTrigger.addEventListener('click', showDock);
      leftDockTrigger.addEventListener('mouseenter', showDock);
      leftDock.addEventListener('mouseleave', hideDock);
    }

    // Initialize first thread if none
    renderChatTabHistory();
  }

  async function init() {

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
