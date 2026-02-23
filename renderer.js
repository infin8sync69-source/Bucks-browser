/* ╔═══════════════════════════════════════════════╗
   ║     BUCKS WEB3 BROWSER — RENDERER LOGIC       ║
   ╚═══════════════════════════════════════════════╝ */

(function () {
  'use strict';

  /* ─── State ─── */
  let tabs = [];
  let activeTabId = null;
  let settings = {};

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

  /* ─── Utility ─── */
  let tabIdCounter = 0;
  function genTabId() { return `tab-${++tabIdCounter}`; }

  function isURL(str) {
    if (/^(https?:\/\/|file:\/\/|ipfs:\/\/)/i.test(str)) return true;
    if (/^[\w-]+(\.[\w-]+)+/.test(str) && !str.includes(' ')) return true;
    return false;
  }

  function normalizeURL(str) {
    if (/^https?:\/\//i.test(str)) return str;
    if (/^[\w-]+(\.[\w-]+)+/.test(str)) return `https://${str}`;
    return `${settings.searchEngine || 'https://duckduckgo.com/?q='}${encodeURIComponent(str)}`;
  }

  /* ═══════════ SECURITY & ORIGIN APPROVAL ═══════════ */
  window.bucksAPI.onWalletAccessRequest(({ requestId, origin }) => {
    const modal = $('#origin-approval');
    const originText = $('#requesting-origin');
    originText.textContent = origin;
    modal.classList.remove('sidebar-hidden');

    $('#btn-origin-allow').onclick = () => {
      window.bucksAPI.respondToWalletAccess(requestId, true);
      modal.classList.add('sidebar-hidden');
    };

    $('#btn-origin-deny').onclick = () => {
      window.bucksAPI.respondToWalletAccess(requestId, false);
      modal.classList.add('sidebar-hidden');
    };
  });

  /* ═══════════ TAB MANAGEMENT ═══════════ */

  function createTab(url) {
    const id = genTabId();
    const isNewTab = !url || url === 'bucks://newtab';

    const tab = {
      id,
      title: isNewTab ? 'New Tab' : 'Loading…',
      url: isNewTab ? 'bucks://newtab' : normalizeURL(url),
      webview: null,
      newtabEl: null,
    };

    if (isNewTab) {
      // Create new-tab page element
      const tmpl = $('#newtab-template');
      const clone = tmpl.content.cloneNode(true);
      const container = document.createElement('div');
      container.className = 'newtab-container';
      container.dataset.tabId = id;
      container.appendChild(clone);
      browserContent.insertBefore(container, walletSidebar);
      tab.newtabEl = container;

      // Wire up new-tab search
      const searchBox = container.querySelector('.newtab-search');
      searchBox.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && searchBox.value.trim()) {
          navigateTab(id, searchBox.value.trim());
        }
      });

      // Wire up shortcut clicks
      container.querySelectorAll('.shortcut-card').forEach((card) => {
        card.addEventListener('click', (e) => {
          e.preventDefault();
          navigateTab(id, card.getAttribute('href'));
        });
      });
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
    wv.setAttribute('src', tab.url);
    wv.setAttribute('preload', '');
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
      }
    });

    wv.addEventListener('did-fail-load', () => {
      if (tab.id === activeTabId) updateSecurityIcon('insecure');
    });

    wv.addEventListener('did-navigate-in-page', (e) => {
      tab.url = e.url;
      if (tab.id === activeTabId) addressBar.value = e.url;
    });

    wv.addEventListener('new-window', (e) => {
      createTab(e.url);
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

    if (tabId === activeTabId) addressBar.value = url;
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

    if (tab.webview) {
      tab.webview.classList.add('active');
      addressBar.value = tab.url;
      updateSecurityIcon(tab.url.startsWith('https://') ? 'secure' : 'insecure');
    } else if (tab.newtabEl) {
      tab.newtabEl.classList.add('active');
      addressBar.value = '';
      updateSecurityIcon('pending'); // New tab page doesn't have a security status yet
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
    tabs.forEach((tab) => {
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
      tabsContainer.appendChild(el);
    });
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

  $('#btn-adblock').onclick = async () => {
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

  /* ═══════════ NAVIGATION CONTROLS ═══════════ */

  $('#btn-back').addEventListener('click', () => {
    const tab = tabs.find((t) => t.id === activeTabId);
    if (tab?.webview) tab.webview.goBack();
  });

  $('#btn-forward').addEventListener('click', () => {
    const tab = tabs.find((t) => t.id === activeTabId);
    if (tab?.webview) tab.webview.goForward();
  });

  $('#btn-refresh').addEventListener('click', () => {
    const tab = tabs.find((t) => t.id === activeTabId);
    if (tab?.webview) tab.webview.reload();
  });

  // Address bar
  addressBar.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && addressBar.value.trim()) {
      navigateTab(activeTabId, addressBar.value.trim());
    }
  });

  addressBar.addEventListener('focus', () => addressBar.select());

  // New tab button
  $('#btn-new-tab').addEventListener('click', () => createTab());

  /* ═══════════ WINDOW CONTROLS ═══════════ */
  $('#btn-minimize').addEventListener('click', () => window.bucksAPI.minimize());
  $('#btn-maximize').addEventListener('click', () => window.bucksAPI.maximize());
  $('#btn-close').addEventListener('click', () => window.bucksAPI.close());

  /* ═══════════ WALLET SIDEBAR (Bucks Wallet Integration) ═══════════ */

  function toggleSidebar(panel) {
    const isWallet = panel === 'wallet';
    const target = isWallet ? walletSidebar : settingsPanel;
    const other = isWallet ? settingsPanel : walletSidebar;

    other.classList.remove('sidebar-visible');
    other.classList.add('sidebar-hidden');

    if (target.classList.contains('sidebar-visible')) {
      target.classList.remove('sidebar-visible');
      target.classList.add('sidebar-hidden');
    } else {
      target.classList.remove('sidebar-hidden');
      target.classList.add('sidebar-visible');
      if (isWallet) refreshWallet();
    }
  }

  $('#btn-wallet').addEventListener('click', () => toggleSidebar('wallet'));
  $('#btn-close-wallet').addEventListener('click', () => toggleSidebar('wallet'));

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

    if (walletState.connected) {
      dotEl.classList.add('connected');
    } else {
      dotEl.classList.remove('connected');
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
        $('#btn-go-create').onclick = () => { walletState.currentView = 'create'; renderWalletView(); };
        $('#btn-go-restore').onclick = () => { walletState.currentView = 'restore'; renderWalletView(); };
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
        $('#btn-back-welcome').onclick = () => { walletState.currentView = 'welcome'; renderWalletView(); };
        $('#btn-do-create').onclick = handleCreateWallet;
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
        $('#btn-copy-mnemonic').onclick = () => {
          navigator.clipboard.writeText(walletState.mnemonic);
          showToast('Mnemonic copied to clipboard!');
        };
        $('#btn-recovery-next').onclick = () => { walletState.currentView = 'confirm'; renderWalletView(); };
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
        $('#btn-confirm-back').onclick = () => { walletState.currentView = 'recovery'; renderWalletView(); };
        $('#btn-confirm-mnemonic').onclick = () => {
          const input = $('#wallet-confirm-input').value.trim();
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
        $('#btn-back-welcome-2').onclick = () => { walletState.currentView = 'welcome'; renderWalletView(); };
        $('#btn-do-restore').onclick = handleRestoreWallet;
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
        $('#tab-send').onclick = () => {
          $('#side-view-send').style.display = 'block';
          $('#side-view-receive').style.display = 'none';
          $('#tab-send').classList.add('active');
          $('#tab-receive').classList.remove('active');
        };
        $('#tab-receive').onclick = () => {
          $('#side-view-send').style.display = 'none';
          $('#side-view-receive').style.display = 'block';
          $('#tab-send').classList.remove('active');
          $('#tab-receive').classList.add('active');
        };

        $('#btn-copy-address').onclick = () => {
          navigator.clipboard.writeText(walletState.address);
          showToast('Address copied to clipboard!');
        };

        $('#btn-send-bucks').onclick = handleSendBucks;
        break;
    }
  }

  /* ─── Wallet Handlers ─── */

  async function handleCreateWallet() {
    const pass = $('#wallet-pass').value;
    const confirm = $('#wallet-pass-confirm').value;
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

  async function handleRestoreWallet() {
    const mnemonic = $('#wallet-mnemonic-input').value.trim();
    if (!mnemonic) return alert('Enter mnemonic');

    const res = await window.bucksAPI.walletRPC({ method: 'POST', endpoint: '/api/wallets/restore', body: { mnemonic } });
    if (res && !res.error) {
      walletState.currentView = 'home';
      refreshWallet();
    } else {
      alert('Error: ' + (res.error || 'Invalid mnemonic'));
    }
  }

  async function handleSendBucks() {
    const to = $('#send-to').value.trim();
    const amount = parseFloat($('#send-amount').value);
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
      $('#send-to').value = '';
      $('#send-amount').value = '';
      refreshWallet();
    } else {
      alert('Error: ' + (res.error || 'Transaction failed'));
    }
  }

  $('#btn-settings').addEventListener('click', () => toggleSidebar('settings'));
  $('#btn-close-settings').addEventListener('click', () => toggleSidebar('settings'));

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
    showToast('Settings saved successfully', 'success');
  }

  $('#btn-test-speed').onclick = async () => {
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

  $('#btn-save-settings').addEventListener('click', async () => {
    const newSettings = {
      searchEngine: $('#setting-search-engine').value,
      homepage: $('#setting-homepage').value,
      adBlockEnabled: $('#setting-adblock').checked,
      httpsOnly: $('#setting-https-only').checked,
    };
    await window.bucksAPI.saveSettings(newSettings);
    window.bucksAPI.toggleAdBlock(newSettings.adBlockEnabled);
    toggleSidebar('settings'); // Close panel
  });

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
  });

  /* ═══════════ IPFS SOCIAL PANEL ═══════════ */
  const ipfsSidebar = document.getElementById('ipfs-sidebar');
  const btnIpfs = document.getElementById('btn-ipfs');
  const btnCloseIpfs = document.getElementById('btn-close-ipfs');
  const ipfsDot = document.querySelector('.ipfs-dot');

  btnIpfs.addEventListener('click', () => toggleSidebar('ipfs'));
  btnCloseIpfs.addEventListener('click', () => toggleSidebar('ipfs'));

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
  btnIpfs.removeEventListener('click', () => toggleSidebar('ipfs'));
  btnIpfs.addEventListener('click', toggleIPFS);
  btnCloseIpfs.removeEventListener('click', () => toggleSidebar('ipfs'));
  btnCloseIpfs.addEventListener('click', () => ipfsSidebar.classList.add('sidebar-hidden'));

  /* ── IPFS Status Refresh ── */
  async function refreshIPFSStatus() {
    const info = await window.bucksAPI.ipfsInfo();
    const dot = $('#ipfs-status-dot');
    dot.className = info.status === 'online' ? 'status-indicator status-online' : 'status-indicator status-offline';
    $('#ipfs-peer-count').textContent = `${info.peers} Peers`;
    $('#ipfs-node-id').textContent = info.peerId ? `${info.peerId.slice(0, 8)}...${info.peerId.slice(-4)}` : 'Offline';

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
      const stats = await window.bucksAPI.ipfsStorageStats();
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
    if (!following.length) {
      list.innerHTML = '<p class="tx-empty" style="font-size:11px;">Not following anyone yet.</p>';
      return;
    }
    list.innerHTML = following.map(id => `
      <div class="ipfs-following-item">
        <span>${id.slice(0, 12)}…${id.slice(-6)}</span>
        <button onclick="window._ipfsUnfollow('${id}')">✕</button>
      </div>
    `).join('');
  }

  window._ipfsUnfollow = async (peerId) => {
    await window.bucksAPI.ipfsUnfollow(peerId);
    refreshIPFSStatus();
  };

  /* ── Follow ── */
  document.getElementById('btn-ipfs-follow').addEventListener('click', async () => {
    const input = document.getElementById('ipfs-follow-id');
    const peerId = input.value.trim();
    if (!peerId) return;

    try {
      // 1. Follow in local Helia node (for co-hosting/discovery)
      const localRes = await window.bucksAPI.ipfsFollow(peerId);

      // 2. Follow in Social Backend (for global feed/notifications)
      const socialRes = await window.bucksAPI.socialRPC({
        method: 'POST',
        endpoint: '/connections/follow',
        body: { peer_id: peerId }
      });

      input.value = '';
      showToast(`${localRes.status === 'followed' || (socialRes && !socialRes.error) ? '✓ Following' : 'Error'} ${peerId.slice(0, 12)}…`);
      refreshIPFSStatus();
    } catch (e) {
      showToast('Follow failed', 'error');
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
    } catch (e) {
      console.error('[IPFS UI] Feed error:', e);
      document.getElementById('ipfs-feed').innerHTML = `<p class="tx-empty" style="color:var(--danger)">Offline: Social Gateway (8000)</p>`;
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

  /* ═══════════ INIT ═══════════ */
  async function init() {
    const platform = await window.bucksAPI.getPlatform();
    document.body.classList.add(`platform-${platform}`);

    // On Mac with hiddenInset, we hide our custom window controls 
    // because MacOS provides the native traffic lights automatically.
    if (platform === 'darwin') {
      $('.window-controls').style.display = 'none';
      $('.titlebar-title').style.marginLeft = '70px'; // Make room for traffic lights
    }

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

    /* ── Swarm Edge Compute ── */
    const SwarmCompute = {
      async delegateTask(taskId, wasmCid, payload) {
        showToast('Swarm: Requesting Edge Compute...', 'info');
        // Logic would broadcast compute:request topic
      }
    };

    await loadSettings();
    createTab(); // Open a new-tab page by default
    refreshIPFSStatus();
  }

  init();
})();
