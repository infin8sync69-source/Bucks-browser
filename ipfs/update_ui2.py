import re
import os

def process_file(filepath, is_desktop):
    with open(filepath, 'r') as f:
        content = f.read()

    # 1. Update viewFile for PDF
    old_pdf_check = """    if (contentType === 'application/pdf' || /\.pdf$/.test(e.name)) {
      dialog(`<h2>${e.name}</h2><div class="body"><iframe src="${url}" style="width:100%;height:65vh;border:none;"></iframe></div>
        <div class="btns"><button class="primary" onclick="closeDialog()">Close (Esc)</button></div>`);
      return;
    }"""
    new_pdf_check = """    if (contentType === 'application/pdf' || /\.pdf$/.test(e.name)) {
      dialog(`<h2>${e.name}</h2><div class="body" style="padding:0; height:70vh; overflow:hidden">
        <iframe src="/pdfjs/web/viewer.html?file=${encodeURIComponent(url)}" style="width:100%;height:100%;border:none;"></iframe>
      </div><div class="btns"><button class="primary" onclick="closeDialog()">Close (Esc)</button></div>`);
      return;
    }"""
    content = content.replace(old_pdf_check, new_pdf_check)

    # 2. Add IPFS Object Patch Logic
    patch_logic = """
async function ipfsPatch(dirCid, name, itemCid, remove=false) {
  if (remove) {
    const r = await fetch(`${KUBO}/api/v0/object/patch/rm-link?arg=${dirCid}&arg=${encodeURIComponent(name)}`, {method:'POST'});
    const j = await r.json(); return j.Hash;
  } else {
    const rmR = await fetch(`${KUBO}/api/v0/object/patch/rm-link?arg=${dirCid}&arg=${encodeURIComponent(name)}`, {method:'POST'});
    let cleanDir = dirCid;
    if (rmR.ok) { const j = await rmR.json(); if (j.Hash) cleanDir = j.Hash; }
    const r2 = await fetch(`${KUBO}/api/v0/object/patch/add-link?arg=${cleanDir}&arg=${encodeURIComponent(name)}&arg=${itemCid}`, {method:'POST'});
    const j2 = await r2.json(); return j2.Hash;
  }
}

async function updatePathTree(pane, leafCid) {
  let currentCid = leafCid;
  for (let i = pane.path.length - 1; i >= 1; i--) {
    const parent = pane.path[i-1];
    const childName = pane.path[i].name;
    currentCid = await ipfsPatch(parent.cid, childName, currentCid, false);
    pane.path[i].cid = currentCid; 
  }
  const oldRootCid = pane.path[0].cid;
  const rootName = pane.path[0].name;
  await fetch(`${API}/pins/${currentCid}?name=${encodeURIComponent(rootName)}`, {method:'POST'});
  await fetch(`${API}/pins/${oldRootCid}`, {method:'DELETE'});
  pane.path[0].cid = currentCid;
}

async function performCopyMove(sourceItem, targetPane, targetFolderEntry, action) {
  setXfer(`\\u21EA ${action}ing ${sourceItem.name}...`);
  try {
    if (targetFolderEntry) {
      const newDir = await ipfsPatch(targetFolderEntry.cid, sourceItem.name, sourceItem.cid, false);
      if (targetPane.path.length === 0) {
        await fetch(`${API}/pins/${newDir}?name=${encodeURIComponent(targetFolderEntry.name)}`, {method:'POST'});
        await fetch(`${API}/pins/${targetFolderEntry.cid}`, {method:'DELETE'});
      } else {
        const newParent = await ipfsPatch(targetPane.path[targetPane.path.length-1].cid, targetFolderEntry.name, newDir, false);
        await updatePathTree(targetPane, newParent);
      }
    } else {
      if (targetPane.path.length === 0) {
        await fetch(`${API}/pins/${sourceItem.cid}?name=${encodeURIComponent(sourceItem.name)}`, {method:'POST'});
      } else {
        const newDir = await ipfsPatch(targetPane.path[targetPane.path.length-1].cid, sourceItem.name, sourceItem.cid, false);
        await updatePathTree(targetPane, newDir);
      }
    }
    
    if (action === 'move') {
      const sourcePane = panes[sourceItem.paneId];
      if (sourceItem.isRoot) {
        await fetch(`${API}/pins/${sourceItem.cid}`, {method:'DELETE'});
      } else {
        const newDir = await ipfsPatch(sourcePane.path[sourcePane.path.length-1].cid, sourceItem.name, null, true);
        await updatePathTree(sourcePane, newDir);
      }
    }
  } catch(e) { console.error(e); }
  setXfer('');
  refreshBoth();
}
"""
    content = content.replace("// ---- pane model", patch_logic + "\n// ---- pane model")

    # 3. Add Drag and Drop Events to Pane Render
    old_list = "const list = $('.list', this.el);"
    new_list = """const list = $('.list', this.el);
    list.ondragover = (ev) => ev.preventDefault();
    list.ondrop = async (ev) => {
      ev.preventDefault();
      const data = ev.dataTransfer.getData('text/plain');
      if (!data) return;
      try {
        const item = JSON.parse(data);
        if (item.internalDrop) {
          ev.stopPropagation();
          if (item.paneId === panes.indexOf(this) && item.pathJson === JSON.stringify(this.path)) return;
          await performCopyMove(item, this, null, ev.shiftKey ? 'copy' : 'move');
        }
      } catch(e) {}
    };"""
    content = content.replace(old_list, new_list)

    old_row = "const row = document.createElement('div');"
    new_row = """const row = document.createElement('div');
      if (!e.up) {
        row.draggable = true;
        row.ondragstart = (ev) => {
          ev.dataTransfer.setData('text/plain', JSON.stringify({
            internalDrop: true, cid: e.cid, name: e.name, 
            paneId: panes.indexOf(this), isRoot: this.path.length===0,
            pathJson: JSON.stringify(this.path)
          }));
        };
      }
      if (e.dir && !e.up) {
        row.ondragover = (ev) => { ev.preventDefault(); row.style.background = 'rgba(255,255,255,0.2)'; };
        row.ondragleave = (ev) => { row.style.background = ''; };
        row.ondrop = async (ev) => {
          ev.preventDefault(); ev.stopPropagation();
          row.style.background = '';
          const data = ev.dataTransfer.getData('text/plain');
          if (!data) return;
          try {
            const item = JSON.parse(data);
            if (item.internalDrop) {
              await performCopyMove(item, this, e, ev.shiftKey ? 'copy' : 'move');
            }
          } catch(err) {}
        };
      }
"""
    content = content.replace(old_row, new_row)

    # 4. Copy/Paste Shortcuts
    clip_logic = """
let clipBoard = null;
"""
    content = content.replace("// ---- keyboard", clip_logic + "\n// ---- keyboard")
    
    old_kb = """  else if (k === 'F10' || (k === 'r' && (e.metaKey || e.ctrlKey))) { e.preventDefault(); kb(10); }
});"""
    new_kb = """  else if (k === 'F10' || (k === 'r' && (e.metaKey || e.ctrlKey))) { e.preventDefault(); kb(10); }
  else if (k === 'c' && (e.metaKey || e.ctrlKey)) {
    const eCur = p.cur();
    if (eCur && !eCur.up) {
      clipBoard = { internalDrop: true, cid: eCur.cid, name: eCur.name, paneId: active, isRoot: p.path.length===0, pathJson: JSON.stringify(p.path), action: 'copy' };
      setXfer('Copied ' + eCur.name); setTimeout(()=>setXfer(''), 2000);
    }
  }
  else if (k === 'x' && (e.metaKey || e.ctrlKey)) {
    const eCur = p.cur();
    if (eCur && !eCur.up) {
      clipBoard = { internalDrop: true, cid: eCur.cid, name: eCur.name, paneId: active, isRoot: p.path.length===0, pathJson: JSON.stringify(p.path), action: 'move' };
      setXfer('Cut ' + eCur.name); setTimeout(()=>setXfer(''), 2000);
    }
  }
  else if (k === 'v' && (e.metaKey || e.ctrlKey)) {
    if (clipBoard) {
      performCopyMove(clipBoard, p, null, clipBoard.action).then(() => { if(clipBoard && clipBoard.action==='move') clipBoard = null; });
    }
  }
});"""
    content = content.replace(old_kb, new_kb)

    with open(filepath, 'w') as f:
        f.write(content)

process_file('/Users/mikado/new/folder/public/index.html', False)
process_file('/Users/mikado/new/folder/desktop-ui/index.html', True)
print("Files updated successfully")
