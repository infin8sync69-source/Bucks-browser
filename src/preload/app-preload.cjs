// Preload for apps running in a Bucks container (docs/APP-ENVIRONMENT.md §5): the whole bridge an
// app gets is window.bucks.app. The main process checks every call against the app's grants;
// nothing here is trusted. Apps should feature-detect it (window.bucks?.app): the same package
// also opens as a plain ipfs:// or ipns:// site in a tab, where it does not exist.

const { contextBridge, ipcRenderer } = require('electron');

const handlers = new Map();
let announce = null;

/** Tell Bucks which agent tools this page handles (debounced to one message per task). */
function scheduleAnnounce() {
  if (announce) return;
  announce = Promise.resolve().then(() => {
    announce = null;
    ipcRenderer.send('bucks-app:tools', [...handlers.keys()]);
  });
}

ipcRenderer.on('bucks-app:tool-call', async (_event, msg) => {
  const { callId, name, input } = msg || {};
  const fn = handlers.get(name);
  if (!fn) {
    ipcRenderer.send('bucks-app:tool-result', { callId, ok: false, error: `This app has no handler for "${name}".` });
    return;
  }
  try {
    const result = await fn(input);
    ipcRenderer.send('bucks-app:tool-result', { callId, ok: true, result: result === undefined ? null : JSON.parse(JSON.stringify(result)) });
  } catch (e) {
    ipcRenderer.send('bucks-app:tool-result', { callId, ok: false, error: String((e && e.message) || e) });
  }
});

contextBridge.exposeInMainWorld('bucks', {
  app: {
    /** { id, name, version, permissions (granted), tools (declared) } */
    info: () => ipcRenderer.invoke('bucks-app:info'),
    agent: {
      /**
       * Handle one of the tools this app declares in bucks-site.json (app.agent.tools). The
       * handler gets the agent's input and returns JSON (or a promise of it). Returns an
       * unregister function.
       */
      handle(name, fn) {
        if (typeof name !== 'string' || typeof fn !== 'function') throw new TypeError('handle(name, fn) needs a tool name and a function');
        handlers.set(name, fn);
        scheduleAnnounce();
        return () => { handlers.delete(name); scheduleAnnounce(); };
      },
    },
    ipfs: {
      /** Add text or bytes to the user's node (pinned). Needs the "ipfs" permission. → { cid, size } */
      add: (data, opts) => ipcRenderer.invoke('bucks-app:ipfs-add', data, opts),
      /** Read a CID (optionally with a path) as bytes. Needs the "ipfs" permission. */
      cat: (cidPath) => ipcRenderer.invoke('bucks-app:ipfs-cat', cidPath),
    },
    /** Open a web or IPFS link in a Bucks tab. */
    openExternal: (url) => ipcRenderer.invoke('bucks-app:open-external', url),
  },
});
