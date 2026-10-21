// A main process that opens no window: scripts/ui-screenshots.mjs runs nativeImage code in it.
const { app } = require('electron');
app.on('window-all-closed', () => {});
