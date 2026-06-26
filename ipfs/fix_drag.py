import re
import os

def fix_file(filepath):
    with open(filepath, 'r') as f:
        content = f.read()

    # Find the chunk starting from "let dragDepth = 0;" to "let clipBoard = null;"
    start_idx = content.find("let dragDepth = 0;")
    end_idx = content.find("let clipBoard = null;")
    
    if start_idx != -1 and end_idx != -1:
        new_drag_logic = """let dragDepth = 0;
window.addEventListener('dragenter', (e) => {
  if (e.dataTransfer.types && e.dataTransfer.types.includes('Files') && !e.dataTransfer.types.includes('text/plain')) {
    if (dragDepth++ === 0) document.body.classList.add('dragover');
  }
});
window.addEventListener('dragleave', (e) => { 
  if (e.dataTransfer.types && e.dataTransfer.types.includes('Files') && !e.dataTransfer.types.includes('text/plain')) {
    if (--dragDepth <= 0) { dragDepth = 0; document.body.classList.remove('dragover'); } 
  }
});
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', async (e) => {
  e.preventDefault(); dragDepth = 0; document.body.classList.remove('dragover');
  if (e.dataTransfer.types && e.dataTransfer.types.includes('text/plain')) return; // handled by internal drops
  const entries = [...(e.dataTransfer.items || [])].map((i) => i.webkitGetAsEntry?.()).filter(Boolean);
  if (entries.length) {
    const items = [];
    for (const en of entries) items.push(...await entryToItems(en, ''));
    uploadEntries(items);
  }
  else if (e.dataTransfer.files.length) {
    uploadEntries([...e.dataTransfer.files].map((f) => ({ file: f, rel: f.name })));
  }
});

"""
        content = content[:start_idx] + new_drag_logic + content[end_idx:]
        
        with open(filepath, 'w') as f:
            f.write(content)
        print(f"Fixed {filepath}")
    else:
        print(f"Could not find drag logic in {filepath}")

fix_file('/Users/mikado/new/folder/public/index.html')
fix_file('/Users/mikado/new/folder/desktop-ui/index.html')
