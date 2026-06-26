import re
import os

def process_file(filepath):
    with open(filepath, 'r') as f:
        content = f.read()

    # 1. Add CID Input to Top Bar
    # Look for `<div id="top">`
    top_search = '<div id="top">'
    idx = content.find(top_search)
    if idx != -1:
        # Add a flex row inside #top above the existing controls
        new_top = """<div id="top">
  <div style="display:flex; width: 100%; margin-bottom: 10px; gap: 8px;">
    <span style="color: var(--dim); line-height: 24px;">ipfs://</span>
    <input id="cidInput" placeholder="Enter CID to navigate (e.g. Qm... or ipfs://Qm...)" style="flex:1; padding: 4px; border-radius: 4px; border: 1px solid var(--border); background: var(--bg); color: var(--text)">
  </div>
  <div style="display:flex; width: 100%; align-items: center;">"""
        # We need to replace the first line and then add a closing div after the toolbar buttons.
        # It's easier to just do string replacement on the known toolbar html.
        pass

    # A simpler way is to replace the whole #top div contents if we know them.
    # In desktop-ui/index.html and public/index.html:
    old_top_start = '<div id="top">'
    new_top_start = """<div id="top">
  <div style="display:flex; width: 100%; margin-bottom: 8px; gap: 5px;">
    <span style="color: var(--dim); align-self: center; font-size: 14px;">ipfs://</span>
    <input id="cidInput" placeholder="Navigate to any CID..." style="flex:1; padding: 4px 8px; border-radius: 4px; border: 1px solid var(--border); background: var(--bg); color: var(--text);">
  </div>
  <div style="display:flex; align-items: center; gap: 5px; flex-wrap: wrap;">
"""
    content = content.replace('<div id="top">', new_top_start)

    # Note: we need to add an extra closing `</div>` before `<main>`.
    content = content.replace('</main>', '</div>\n</main>') # Wait, if we added a <div> open, we need to close it before main.
    # Actually `<div id="top">` ends before `<main>`. 
    content = content.replace('</select>\n  <input', '</select>\n    <input')
    content = content.replace('Refresh</button>', 'Refresh</button>\n  </div>')
    content = content.replace('↻</button>', '↻</button>\n  </div>')

    # 2. Add Event Listener for cidInput
    js_logic = """
const cidInput = $('#cidInput');
cidInput.onkeydown = async (e) => {
  if (e.key === 'Enter') {
    let val = e.target.value.trim();
    if (val.startsWith('ipfs://')) val = val.slice(7);
    if (val.startsWith('/ipfs/')) val = val.slice(6);
    if (!val) return;
    
    // Check if it's a valid CID format roughly
    if (val.length < 40) {
      alert("Invalid CID format.");
      return;
    }
    
    const p = pane();
    p.path = [{name: val, cid: val}];
    try {
      await p.load();
      p.cursor = 0;
      p.render();
      cidInput.blur();
    } catch(err) {
      alert("Failed to load CID: " + err.message);
    }
  }
};
"""
    # Insert js_logic before `const searchBox = $('#searchBox');`
    content = content.replace("const searchBox = $('#searchBox');", js_logic + "\nconst searchBox = $('#searchBox');")

    with open(filepath, 'w') as f:
        f.write(content)

process_file('/Users/mikado/new/folder/public/index.html')
process_file('/Users/mikado/new/folder/desktop-ui/index.html')
