import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { app } from 'electron';

const here = path.dirname(fileURLToPath(import.meta.url));

/** Repository / app root (the directory containing package.json). */
export const appRoot = path.resolve(here, '..', '..');

/** Built SvelteKit chrome (ui/build). */
export const uiDist = path.join(appRoot, 'ui', 'build');

export const preloadPath = path.join(appRoot, 'src', 'preload', 'preload.cjs');

/** Directory where electron-builder's extraResources land (packaged) or ./resources (dev). */
export function resourcesDir() {
  return app.isPackaged ? process.resourcesPath : path.join(appRoot, 'resources');
}

export function userDataDir() {
  return app.getPath('userData');
}
