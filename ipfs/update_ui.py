import re
import os

def process_file(filepath, is_desktop):
    with open(filepath, 'r') as f:
        content = f.read()

    # 1. Add CSS
    css_to_add = """
  /* View Modes */
  .pane .list.grid {
    display: grid; grid-template-columns: repeat(auto-fill, minmax(120px, 1fr));
    gap: 10px; padding: 10px; align-content: start;
  }
  .pane .list.tiles {
    display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
    gap: 8px; padding: 10px; align-content: start;
  }
  .row.grid, .row.tiles {
    display: flex; cursor: default;
    border-radius: 6px; padding: 8px; border: 1px solid transparent;
  }
  .row.grid { flex-direction: column; align-items: center; text-align: center; }
  .row.tiles { flex-direction: row; align-items: center; text-align: left; }
  
  .row.grid:hover, .row.tiles:hover { background: #2a2e38; }
  .row.grid.selected, .row.tiles.selected { background: var(--sel-bg); border-color: var(--focus-frame); }
  .pane.focused .row.grid.cursor, .pane.focused .row.tiles.cursor { background: var(--cursor-bg); }
  .pane:not(.focused) .row.grid.cursor, .pane:not(.focused) .row.tiles.cursor { background: #333a49; }
  
  .row.grid .icon { font-size: 48px; width: 64px; height: 64px; display:flex; align-items:center; justify-content:center; margin-bottom: 8px; }
  .row.tiles .icon { font-size: 32px; width: 48px; height: 48px; display:flex; align-items:center; justify-content:center; margin-right: 10px; }
  
  .row.grid .nm { width: 100%; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; font-size: 12px; }
  .row.tiles .details { display: flex; flex-direction: column; overflow: hidden; flex: 1; }
  .row.tiles .nm { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; font-size: 13px; font-weight: 500; }
  .row.tiles .sz, .row.tiles .dt { font-size: 11px; color: var(--dim); text-align: left; padding: 0; }
  
  .row .icon svg { width: 100%; height: 100%; fill: currentColor; }
  .row.dir .icon { color: #82aaff; }
  .row.f .icon { color: #c3ccdf; }
  
  .row:not(.grid):not(.tiles) .icon { display: inline-block; width: 14px; height: 14px; margin-right: 6px; vertical-align: middle; }
  
  /* Filter & Sort Headers */
  .pane .cols span { cursor: pointer; user-select: none; }
  .pane .cols span:hover { background: rgba(255,255,255,0.1); }
  .pane .cols span.sort-asc::after { content: " ↑"; }
  .pane .cols span.sort-desc::after { content: " ↓"; }
"""
    content = content.replace("</style>", css_to_add + "\n</style>")

    # 2. Update Toolbar
    toolbar_old = """  <input id="searchBox" placeholder="Search (⌘F)">
  <button onclick="uploadDialog()">⇪ Add Files</button>
  <button onclick="uploadFolderDialog()">⊞ Add Folder</button>
  <button onclick="refreshBoth()">↻ Refresh</button>"""
    
    toolbar_new = """  <select id="typeFilterBox" style="background:var(--bg);color:var(--text);border:1px solid var(--border);border-radius:5px;padding:3px;font-size:12px">
    <option value="">All Types</option>
    <option value="image">Images</option>
    <option value="video">Videos</option>
    <option value="pdf">PDFs</option>
    <option value="folder">Folders</option>
  </select>
  <input id="searchBox" placeholder="Search (⌘F)">
  <div style="display:flex; border:1px solid var(--border); border-radius:5px; overflow:hidden">
    <button onclick="setViewMode('list')" style="border:none; border-radius:0; padding:3px 8px">☰</button>
    <button onclick="setViewMode('grid')" style="border:none; border-radius:0; padding:3px 8px; border-left:1px solid var(--border)">⊞</button>
    <button onclick="setViewMode('tiles')" style="border:none; border-radius:0; padding:3px 8px; border-left:1px solid var(--border)">≣</button>
  </div>
  <button onclick="uploadDialog()">⇪ Add</button>
  <button onclick="uploadFolderDialog()">⊞ Folder</button>
  <button onclick="refreshBoth()">↻</button>"""
    content = content.replace(toolbar_old, toolbar_new)

    # 3. Add JS Icons & Logic
    js_icons = """
const ICONS = {
  folder: '<svg viewBox="0 0 24 24"><path d="M10 4H4c-1.1 0-1.99.9-1.99 2L2 18c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2h-8l-2-2z"/></svg>',
  image: '<svg viewBox="0 0 24 24"><path d="M21 19V5c0-1.1-.9-2-2-2H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2zM8.5 13.5l2.5 3.01L14.5 12l4.5 6H5l3.5-4.5z"/></svg>',
  video: '<svg viewBox="0 0 24 24"><path d="M17 10.5V7c0-.55-.45-1-1-1H4c-.55 0-1 .45-1 1v10c0 .55.45 1 1 1h12c.55 0 1-.45 1-1v-3.5l4 4v-11l-4 4z"/></svg>',
  text: '<svg viewBox="0 0 24 24"><path d="M14 2H6c-1.1 0-1.99.9-1.99 2L4 20c0 1.1.89 2 1.99 2H18c1.1 0 2-.9 2-2V8l-6-6zm2 16H8v-2h8v2zm0-4H8v-2h8v2zm-3-5V3.5L18.5 9H13z"/></svg>',
  file: '<svg viewBox="0 0 24 24"><path d="M6 2c-1.1 0-1.99.9-1.99 2L4 20c0 1.1.89 2 1.99 2H18c1.1 0 2-.9 2-2V8l-6-6H6zm6 7V3.5L18.5 9H12z"/></svg>',
  pdf: '<svg viewBox="0 0 24 24"><path d="M20 2H8c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zm-8.5 7.5c0 .83-.67 1.5-1.5 1.5H9v2H7.5V7H10c.83 0 1.5.67 1.5 1.5v1zm5 2c0 .83-.67 1.5-1.5 1.5h-2.5V7H15c.83 0 1.5.67 1.5 1.5v3zm4-3H19v1h1.5V11H19v2h-1.5V7h3v1.5zM9 9.5h1v-1H9v1zM16.5 9h-1v1.5h1V9z"/><path d="M4 6H2v14c0 1.1.9 2 2 2h14v-2H4V6z"/></svg>'
};

function getIcon(e) {
  if (e.dir) return ICONS.folder;
  const n = e.name.toLowerCase();
  if (/\.(png|jpe?g|gif|webp|svg)$/.test(n)) return ICONS.image;
  if (/\.(mp4|webm|ogg|mov)$/.test(n)) return ICONS.video;
  if (/\.pdf$/.test(n)) return ICONS.pdf;
  if (/\.(txt|md|js|html|css|json|csv)$/.test(n)) return ICONS.text;
  return ICONS.file;
}

function setViewMode(mode) {
  panes.forEach(p => { p.viewMode = mode; p.render(); });
}
"""
    content = content.replace("const fmtSize = (n) => {", js_icons + "\nconst fmtSize = (n) => {")

    # 4. Modify Pane Class
    pane_constructor_old = """    this.all = [];
    this.filter = '';
  }"""
    pane_constructor_new = """    this.all = [];
    this.filter = '';
    this.viewMode = 'list';
    this.sortField = 'name';
    this.sortAsc = true;
  }"""
    content = content.replace(pane_constructor_old, pane_constructor_new)

    # 5. Type Filter & Sort Logic in applyFilter
    apply_filter_old = """  applyFilter() {
    const q = this.filter.toLowerCase();
    this.entries = !q ? this.all
      : this.all.filter((e) => e.up || e.name.toLowerCase().includes(q) || (e.cid || '').toLowerCase().includes(q));
  }"""
    apply_filter_new = """  applyFilter() {
    const q = this.filter.toLowerCase();
    const typeFilt = typeFilterBox.value;
    let list = this.all;
    if (q) list = list.filter((e) => e.up || e.name.toLowerCase().includes(q) || (e.cid || '').toLowerCase().includes(q));
    if (typeFilt) {
      list = list.filter((e) => {
        if (e.up) return true;
        if (typeFilt === 'folder') return e.dir;
        const n = e.name.toLowerCase();
        if (typeFilt === 'image') return /\.(png|jpe?g|gif|webp|svg)$/.test(n);
        if (typeFilt === 'video') return /\.(mp4|webm|ogg|mov)$/.test(n);
        if (typeFilt === 'pdf') return /\.pdf$/.test(n);
        return true;
      });
    }
    
    // Sort
    const s = this.sortField;
    const a = this.sortAsc ? 1 : -1;
    list.sort((x, y) => {
      if (x.up) return -1; if (y.up) return 1;
      if (x.dir !== y.dir) return x.dir ? -1 : 1; // folders always first
      if (s === 'name') return x.name.localeCompare(y.name) * a;
      if (s === 'size') return (x.size - y.size) * a;
      if (s === 'date') return (x.date - y.date) * a;
      return 0;
    });
    this.entries = list;
  }"""
    content = content.replace(apply_filter_old, apply_filter_new)

    # 6. Render Logic
    render_old = """  render() {
    const pb = $('.pathbar', this.el);
    pb.innerHTML = `<button class="nav" title="Back">←</button><button class="nav" title="Up">↑</button><button class="nav" title="Home">⌂</button><span></span>`;
    pb.lastChild.textContent = ' ipfs-cluster:' + this.pathString();
    const [bBack, bUp, bHome] = pb.querySelectorAll('button');
    bBack.onclick = () => { focusPane(this); this.back(); };
    bUp.onclick = () => { focusPane(this); this.up(); };
    bHome.onclick = () => { focusPane(this); this.home(); };
    const list = $('.list', this.el);
    list.innerHTML = '';
    this.entries.forEach((e, i) => {
      const row = document.createElement('div');
      row.className = 'row' + (e.dir ? ' dir' : ' f') + (e.up ? ' up' : '') +
        (i === this.cursor ? ' cursor' : '') + (this.selected.has(i) ? ' selected' : '');
      row.innerHTML = `<span class="nm"></span><span class="sz"></span><span class="dt"></span>`;
      row.children[0].textContent = e.up ? '..' : e.name;
      row.children[1].textContent = e.dir ? (e.up ? 'Up' : 'Folder') : fmtSize(e.size);
      row.children[2].textContent = fmtDate(e.date);
      row.onclick = () => { focusPane(this); this.cursor = i; this.render(); };
      row.ondblclick = () => { focusPane(this); this.cursor = i; this.enter(); };
      row.oncontextmenu = (ev) => { ev.preventDefault(); focusPane(this); this.cursor = i; this.render(); ctxMenu(ev, e); };
      list.appendChild(row);
    });
    const files = this.entries.filter((e) => !e.dir).length;
    const dirs = this.entries.filter((e) => e.dir && !e.up).length;
    const bytes = this.entries.reduce((a, e) => a + Math.max(0, e.size), 0);
    $('.status', this.el).textContent =
      `${files} files, ${dirs} folders · ${fmtSize(bytes)}B` + (this.selected.size ? ` · ${this.selected.size} selected` : '') +
      (this.filter ? ` · filter: "${this.filter}" (${this.all.length - this.entries.length} hidden)` : '');
    const c = $('.row.cursor', this.el);
    if (c) c.scrollIntoView({ block: 'nearest' });
  }"""
    render_new = """  render() {
    const pb = $('.pathbar', this.el);
    pb.innerHTML = `<button class="nav" title="Back">←</button><button class="nav" title="Up">↑</button><button class="nav" title="Home">⌂</button><span></span>`;
    pb.lastChild.textContent = ' ipfs-cluster:' + this.pathString();
    const [bBack, bUp, bHome] = pb.querySelectorAll('button');
    bBack.onclick = () => { focusPane(this); this.back(); };
    bUp.onclick = () => { focusPane(this); this.up(); };
    bHome.onclick = () => { focusPane(this); this.home(); };
    
    // Sort headers
    const cols = $('.cols', this.el);
    cols.innerHTML = `<span data-sort="name">Name</span><span data-sort="size" style="text-align:right">Size</span><span data-sort="date" style="text-align:right">Date Created</span>`;
    [...cols.children].forEach(c => {
      const f = c.getAttribute('data-sort');
      if (this.sortField === f) c.className = this.sortAsc ? 'sort-asc' : 'sort-desc';
      c.onclick = () => {
        if (this.sortField === f) this.sortAsc = !this.sortAsc;
        else { this.sortField = f; this.sortAsc = f==='name'; }
        this.applyFilter();
        this.render();
      };
    });

    const list = $('.list', this.el);
    list.className = 'list ' + this.viewMode;
    list.innerHTML = '';
    
    this.entries.forEach((e, i) => {
      const row = document.createElement('div');
      row.className = 'row ' + this.viewMode + (e.dir ? ' dir' : ' f') + (e.up ? ' up' : '') +
        (i === this.cursor ? ' cursor' : '') + (this.selected.has(i) ? ' selected' : '');
      
      const iconHTML = `<span class="icon">${e.up ? ICONS.folder : getIcon(e)}</span>`;
      
      if (this.viewMode === 'list') {
        row.innerHTML = `${iconHTML}<span class="nm"></span><span class="sz"></span><span class="dt"></span>`;
        row.children[1].textContent = e.up ? '..' : e.name;
        row.children[2].textContent = e.dir ? (e.up ? 'Up' : 'Folder') : fmtSize(e.size);
        row.children[3].textContent = fmtDate(e.date);
      } else if (this.viewMode === 'grid') {
        // optionally load actual thumbnail here if image, but sticking to icons to save memory/data
        row.innerHTML = `${iconHTML}<span class="nm" title="${e.name.replace(/"/g,'&quot;')}">${e.up ? '..' : e.name}</span>`;
      } else { // tiles
        row.innerHTML = `${iconHTML}<div class="details"><span class="nm" title="${e.name.replace(/"/g,'&quot;')}">${e.up ? '..' : e.name}</span>
          <span class="sz">${e.dir ? (e.up?'':'Folder') : fmtSize(e.size)}</span>
          <span class="dt">${fmtDate(e.date)}</span></div>`;
      }
      
      row.onclick = () => { focusPane(this); this.cursor = i; this.render(); };
      row.ondblclick = () => { focusPane(this); this.cursor = i; this.enter(); };
      row.oncontextmenu = (ev) => { ev.preventDefault(); focusPane(this); this.cursor = i; this.render(); ctxMenu(ev, e); };
      list.appendChild(row);
    });
    
    const files = this.entries.filter((e) => !e.dir).length;
    const dirs = this.entries.filter((e) => e.dir && !e.up).length;
    const bytes = this.entries.reduce((a, e) => a + Math.max(0, e.size), 0);
    $('.status', this.el).textContent =
      `${files} files, ${dirs} folders · ${fmtSize(bytes)}B` + (this.selected.size ? ` · ${this.selected.size} selected` : '') +
      (this.filter || typeFilterBox.value ? ` · filtered (${this.all.length - this.entries.length} hidden)` : '');
    const c = $('.row.cursor', this.el);
    if (c) c.scrollIntoView({ block: 'nearest' });
  }"""
    content = content.replace(render_old, render_new)

    # 7. Bind Type Filter
    boot_old = """const searchBox = $('#searchBox');"""
    boot_new = """const searchBox = $('#searchBox');
const typeFilterBox = $('#typeFilterBox');
typeFilterBox.onchange = () => {
  pane().applyFilter();
  pane().cursor = 0;
  pane().render();
};"""
    content = content.replace(boot_old, boot_new)

    with open(filepath, 'w') as f:
        f.write(content)

process_file('/Users/mikado/new/folder/public/index.html', False)
process_file('/Users/mikado/new/folder/desktop-ui/index.html', True)
print("Files updated successfully")
