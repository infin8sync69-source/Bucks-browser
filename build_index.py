import re

html_content = """<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Bucks Browser</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Sora:wght@400;500;600;700;800&family=Instrument+Sans:wght@400;500;600;700&display=swap" rel="stylesheet">
  <link rel="stylesheet" href="styles.css" />
  <style>
    /* Native App Window Drag */
    .titlebar-drag-region {
      position: fixed;
      top: 0; left: 0; right: 0; height: 22px;
      -webkit-app-region: drag;
      z-index: 9999;
    }
  </style>
</head>
<body style="margin:0; padding:0; background:#1a1a1c; overflow:hidden;">
  <div class="titlebar-drag-region"></div>
  <div style="position:relative; min-height:100vh; width:100%; overflow-x:hidden; font-family:'Instrument Sans',system-ui,sans-serif; color:#fff;">

    <!-- ENVIRONMENT -->
    <div style="position:fixed; inset:0; z-index:0; background:radial-gradient(120% 110% at 50% 50%, rgba(0,0,0,0) 50%, rgba(0,0,0,0.34) 100%); pointer-events:none;"></div>

    <!-- LEFT DOCK -->
    <div style="position:fixed; left:20px; top:50%; transform:translateY(-50%); z-index:40; display:flex; flex-direction:column; align-items:center; gap:6px; padding:12px 9px; border-radius:26px; background:linear-gradient(150deg,rgba(74,74,78,0.52),rgba(30,30,34,0.42)); backdrop-filter:blur(42px) brightness(1.08); -webkit-backdrop-filter:blur(42px) brightness(1.08); border:1px solid rgba(255,255,255,0.2); box-shadow:0 30px 70px rgba(0,0,0,0.42), inset 0 1px 0 rgba(255,255,255,0.34);">
      
      <button id="nav-dashboard" title="Dashboard" class="dock-btn">
        <svg width="21" height="21" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7"></rect><rect x="14" y="3" width="7" height="7"></rect><rect x="14" y="14" width="7" height="7"></rect><rect x="3" y="14" width="7" height="7"></rect></svg>
      </button>
      <button id="nav-wallet-side" title="Wallet" class="dock-btn">
        <svg width="21" height="21" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="1" y="4" width="22" height="16" rx="2" ry="2"></rect><line x1="1" y1="10" x2="23" y2="10"></line></svg>
      </button>
      <button id="nav-explore" title="Explore IPFS" class="dock-btn">
        <svg width="21" height="21" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"></circle><polygon points="16.24 7.76 14.12 14.12 7.76 16.24 9.88 9.88 16.24 7.76"></polygon></svg>
      </button>
      <button id="nav-bookmarks" title="Bookmarks" class="dock-btn">
        <svg width="21" height="21" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" /></svg>
      </button>
      <button id="nav-settings-side" title="Settings" class="dock-btn">
        <svg width="21" height="21" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"></circle><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"></path></svg>
      </button>

      <div style="width:26px; height:1px; background:rgba(255,255,255,0.18); margin:6px 0;"></div>
      <div id="btn-minimize" style="width:40px; height:40px; border-radius:50%; display:flex; align-items:center; justify-content:center; font-weight:700; font-size:15px; color:#1c1c1f; background:linear-gradient(135deg,#f4f4f6,#c2c2c6); box-shadow:inset 0 1px 0 rgba(255,255,255,0.6); cursor:pointer;" title="Minimize">_</div>
      <div id="btn-close" style="width:40px; height:40px; border-radius:50%; display:flex; align-items:center; justify-content:center; font-weight:700; font-size:15px; color:#fff; background:linear-gradient(135deg,#ff4757,#ff6b81); box-shadow:inset 0 1px 0 rgba(255,255,255,0.6); cursor:pointer; margin-top: 6px;" title="Close">X</div>
    </div>

    <!-- MAIN -->
    <div style="position:relative; z-index:5; height:100vh; padding:22px 24px 22px 116px; display:flex; flex-direction:column;">

      <!-- URL BAR -->
      <div style="display:flex; justify-content:center; margin-bottom:8px; flex-shrink: 0;">
        <div style="width:100%; max-width:720px; display:flex; align-items:center; gap:8px; padding:8px 10px; border-radius:18px; background:linear-gradient(150deg,rgba(72,72,76,0.50),rgba(32,32,36,0.40)); backdrop-filter:blur(40px) brightness(1.08); -webkit-backdrop-filter:blur(40px) brightness(1.08); border:1px solid rgba(255,255,255,0.2); box-shadow:0 16px 44px rgba(0,0,0,0.3), inset 0 1px 0 rgba(255,255,255,0.32);">
          <button id="btn-back" title="Back" class="urlbar-btn"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="rgba(255,255,255,0.85)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 6l-6 6 6 6"></path></svg></button>
          <button id="btn-forward" title="Forward" class="urlbar-btn"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="rgba(255,255,255,0.85)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 6l6 6-6 6"></path></svg></button>
          
          <div style="flex:1; display:flex; align-items:center; gap:9px; padding:7px 14px; border-radius:11px; background:rgba(0,0,0,0.22); border:1px solid rgba(255,255,255,0.08); position:relative;">
            <span id="security-icon" style="display:flex;"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="rgba(255,255,255,0.6)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="11" width="14" height="9" rx="2"></rect><path d="M8 11V8a4 4 0 018 0v3"></path></svg></span>
            <input type="text" id="address-bar" placeholder="Search or enter website" style="flex:1; min-width:0; background:transparent; border:none; outline:none; color:#fff; font-family:inherit; font-size:14px; text-align:center;">
            <button id="btn-bookmark" style="background:transparent; border:none; cursor:pointer; padding:0; display:flex;"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="rgba(255,255,255,0.5)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" /></svg></button>
            <div id="omnibox-dropdown" class="hidden" style="position:absolute; top:100%; left:0; width:100%; background:rgba(30,30,34,0.95); backdrop-filter:blur(20px); border-radius:12px; margin-top:8px; padding:8px 0; border:1px solid rgba(255,255,255,0.1); z-index:50;"></div>
          </div>

          <button id="btn-refresh" title="Refresh" class="urlbar-btn"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="rgba(255,255,255,0.85)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10" /><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" /></svg></button>
          <button id="btn-new-tab" title="New tab" class="urlbar-btn"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="rgba(255,255,255,0.85)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v14M5 12h14"></path></svg></button>
        </div>
      </div>

      <!-- CENTER WINDOW (Dynamic View Area) -->
      <div style="flex:1; display:flex; align-items:center; justify-content:center; position:relative;" id="browser-content">
        <!-- New Tab Template matches the new design aesthetic -->
        <template id="newtab-template">
          <div class="newtab-dashboard">
            <h1 style="font-family:'Sora',sans-serif; font-size:48px; margin-bottom:12px; background:linear-gradient(135deg, #f7931a, #ffb347); -webkit-background-clip:text; -webkit-text-fill-color:transparent;">Bucks</h1>
            <p style="color:rgba(255,255,255,0.5); font-size:16px; margin-bottom:32px;">Welcome to the Decentralized Web</p>
            <div style="display:flex; gap:16px;">
              <a href="https://ipfs.tech" class="shortcut-link glass-card">IPFS</a>
              <a href="https://ens.domains" class="shortcut-link glass-card">ENS</a>
              <a href="bucks://settings" class="shortcut-link glass-card">Settings</a>
            </div>
          </div>
        </template>

        <!-- Dynamic Sidebars / Panels -->
        <!-- Wallet Sidebar -->
        <aside id="wallet-sidebar" class="sidebar-hidden glass-panel-side">
          <div class="sidebar-header">
            <h2>Wallet</h2>
            <button id="btn-close-wallet" class="icon-btn">X</button>
          </div>
          <div id="wallet-content" style="padding: 16px;"></div>
        </aside>

        <!-- Settings Panel -->
        <aside id="settings-panel" class="sidebar-hidden glass-panel-side">
          <div class="sidebar-header">
            <h2>Settings</h2>
            <button id="btn-close-settings" class="icon-btn">X</button>
          </div>
          <div class="settings-content" style="padding: 16px;">
             <!-- Simplified settings for now to match logic -->
             <button id="btn-save-settings">Save</button>
          </div>
        </aside>

        <!-- History & Bookmarks -->
        <aside id="history-panel" class="sidebar-hidden glass-panel-side">
          <div class="sidebar-header">
            <h2>History</h2>
            <button id="btn-close-history" class="icon-btn">X</button>
          </div>
          <div id="history-list-container" style="padding: 16px;"></div>
        </aside>
        <aside id="bookmarks-panel" class="sidebar-hidden glass-panel-side">
          <div class="sidebar-header">
            <h2>Bookmarks</h2>
            <button id="btn-close-bookmarks" class="icon-btn">X</button>
          </div>
          <div id="bookmarks-list-container" style="padding: 16px;"></div>
        </aside>
        
        <!-- Tab Bar (Hidden visually, but logic needs it or we rework it. Let's make it a floating pill) -->
        <nav id="tab-bar" style="position:absolute; top: -10px; left: 50%; transform: translateX(-50%); display:flex; gap:4px; z-index: 50;">
          <div id="tabs-container" style="display:flex; gap:4px;"></div>
        </nav>
      </div>

    </div>
  </div>

  <script src="renderer.js"></script>
</body>
</html>
"""

with open('/Users/mikado/Desktop/Bucks Core/Bucks-browser/electron/index.html', 'w') as f:
    f.write(html_content)

css_content = """
/* ─── NEW BUCKS UI STYLES ─── */
html, body {
  margin: 0; padding: 0; background: #1a1a1c; overflow: hidden;
  font-family: 'Instrument Sans', system-ui, sans-serif;
  color: #fff;
}
* { box-sizing: border-box; }
::selection { background: rgba(255,255,255,0.28); }

.dock-btn {
  width: 44px; height: 44px; border-radius: 14px;
  border: none; background: transparent; color: rgba(255,255,255,0.6);
  cursor: pointer; display: flex; align-items: center; justify-content: center;
  transition: all 0.2s ease;
}
.dock-btn:hover {
  background: rgba(255,255,255,0.1); color: #fff;
}
.dock-btn.active {
  background: rgba(255,255,255,0.15); color: #fff;
}

.urlbar-btn {
  width: 32px; height: 32px; border-radius: 10px;
  border: none; background: transparent; cursor: pointer;
  display: flex; align-items: center; justify-content: center;
  transition: background 0.2s;
}
.urlbar-btn:hover { background: rgba(255,255,255,0.12); }

#browser-content {
  position: relative;
  width: 100%; height: 100%;
  border-radius: 24px;
  overflow: hidden;
  background: linear-gradient(155deg,rgba(70,70,74,0.44),rgba(30,30,34,0.36));
  backdrop-filter: blur(46px) brightness(1.06);
  -webkit-backdrop-filter: blur(46px) brightness(1.06);
  border: 1px solid rgba(255,255,255,0.16);
  box-shadow: 0 40px 100px rgba(0,0,0,0.42), inset 0 1px 0 rgba(255,255,255,0.3);
}

webview {
  position: absolute; top: 0; left: 0; width: 100%; height: 100%;
  border: none; display: none; border-radius: 24px;
}
webview.active { display: flex; }

.newtab-container {
  position: absolute; top: 0; left: 0; width: 100%; height: 100%;
  display: none; align-items: center; justify-content: center;
}
.newtab-container.active { display: flex; }

.newtab-dashboard { text-align: center; }

.glass-card {
  padding: 16px 24px; border-radius: 16px;
  background: rgba(255,255,255,0.05); border: 1px solid rgba(255,255,255,0.1);
  color: #fff; text-decoration: none; font-weight: 600;
  transition: all 0.2s;
}
.glass-card:hover {
  background: rgba(255,255,255,0.1); transform: translateY(-2px);
}

.glass-panel-side {
  position: absolute; top: 0; right: 0; width: 340px; height: 100%;
  background: rgba(30,30,34,0.85); backdrop-filter: blur(24px);
  -webkit-backdrop-filter: blur(24px);
  border-left: 1px solid rgba(255,255,255,0.1);
  transition: transform 0.3s ease; z-index: 100;
}
.sidebar-hidden { transform: translateX(100%); }
.sidebar-visible { transform: translateX(0); }

.sidebar-header {
  display: flex; justify-content: space-between; align-items: center;
  padding: 16px; border-bottom: 1px solid rgba(255,255,255,0.1);
}
.sidebar-header h2 { margin: 0; font-size: 18px; font-family: 'Sora', sans-serif; }
.icon-btn {
  background: transparent; border: none; color: #fff; cursor: pointer;
  font-weight: bold; padding: 4px 8px;
}

/* Tab Bar Override */
#tab-bar { padding: 4px 8px; background: rgba(0,0,0,0.4); border-radius: 16px; border: 1px solid rgba(255,255,255,0.1); backdrop-filter: blur(10px); }
.tab {
  display: flex; align-items: center; gap: 6px; padding: 4px 12px;
  background: rgba(255,255,255,0.05); border-radius: 12px;
  font-size: 12px; cursor: pointer; transition: background 0.2s;
  max-width: 150px;
}
.tab.active { background: rgba(255,255,255,0.15); }
.tab-title { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.tab-close { background: transparent; border: none; color: rgba(255,255,255,0.5); cursor: pointer; padding: 0 4px; }
.tab-close:hover { color: #fff; }

.hidden { display: none !important; }

/* Utilities */
.bookmark-active { stroke: #f7931a; fill: #f7931a; }
.omnibox-suggestion {
  display: flex; align-items: center; gap: 12px; padding: 10px 16px;
  cursor: pointer;
}
.omnibox-suggestion:hover, .omnibox-suggestion.selected { background: rgba(255,255,255,0.1); }
.omnibox-suggestion-title { font-weight: 600; font-size: 13px; }
.omnibox-suggestion-url { font-size: 11px; color: rgba(255,255,255,0.5); }
"""

with open('/Users/mikado/Desktop/Bucks Core/Bucks-browser/electron/styles.css', 'w') as f:
    f.write(css_content)

print("Files updated")
