/**
 * Electron main process.
 *
 * Security baseline (§viii):
 *   - nodeIntegration: false
 *   - contextIsolation: true
 *   - sandbox: true
 *   - strict CSP (no unsafe-inline, no unsafe-eval)
 *   - external links open in the OS browser, never inside the renderer
 *   - new BrowserWindow / window.open denied
 */

import { app, BrowserWindow, ipcMain, session, shell } from 'electron';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { installAgentBridge, disposeAgentBridge } from './agent-bridge.js';
import { installPrefsBridge } from './prefs-bridge.js';
import { installProjectsBridge } from './projects-bridge.js';
import { closeDb } from './db.js';
import { IPC } from '../shared/ipc.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const isDev = !!process.env['ELECTRON_RENDERER_URL'];

/**
 * Strict CSP. The renderer is allowed to load:
 *   - its own bundled assets (self)
 *   - inline web fonts via fonts.googleapis.com / fonts.gstatic.com
 *   - data: URIs (favicon SVG)
 * In dev mode we additionally allow ws: to localhost for Vite HMR.
 */
function buildCsp(): string {
  const base: Record<string, string[]> = {
    'default-src': ["'self'"],
    'script-src': ["'self'"],
    'style-src': ["'self'", 'https://fonts.googleapis.com'],
    'font-src': ["'self'", 'https://fonts.gstatic.com', 'data:'],
    'img-src': ["'self'", 'data:'],
    'connect-src': ["'self'"],
    'object-src': ["'none'"],
    'frame-ancestors': ["'none'"],
    'base-uri': ["'self'"],
    'form-action': ["'none'"],
  };
  if (isDev) {
    // Vite injects an inline HMR client preamble and uses Function/eval for
    // hot-replacement. Relax script-src and style-src in dev only — the
    // production CSP (used for the file:// build) stays strict per §viii.
    // Port is variable because electron-vite may shift up if 5173 is in use.
    base['connect-src']?.push(
      'ws://localhost:*',
      'http://localhost:*',
      'ws://127.0.0.1:*',
      'http://127.0.0.1:*',
    );
    base['style-src']?.push("'unsafe-inline'");
    base['script-src']?.push("'unsafe-inline'", "'unsafe-eval'");
  }
  return Object.entries(base)
    .map(([k, v]) => `${k} ${v.join(' ')}`)
    .join('; ');
}

function applyCsp(): void {
  const csp = buildCsp();
  session.defaultSession.webRequest.onHeadersReceived((details, cb) => {
    const headers = { ...details.responseHeaders };
    headers['Content-Security-Policy'] = [csp];
    cb({ responseHeaders: headers });
  });
}

function createWindow(): BrowserWindow {
  const isMac = process.platform === 'darwin';
  const win = new BrowserWindow({
    width: 1480,
    height: 940,
    minWidth: 960,
    minHeight: 600,
    show: false,
    backgroundColor: '#f4f1ea',
    // macOS keeps native traffic lights via hiddenInset; other platforms are
    // fully frameless and rely on the renderer's title bar (which has
    // -webkit-app-region: drag set and our own minimize/maximize/close).
    ...(isMac
      ? ({ titleBarStyle: 'hiddenInset' as const } as const)
      : ({ frame: false } as const)),
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: true,
      nodeIntegration: false,
      contextIsolation: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      spellcheck: false,
    },
  });

  const broadcastMaximized = () => {
    if (!win.isDestroyed()) {
      win.webContents.send(IPC.WinIsMaximizedChanged, win.isMaximized());
    }
  };
  win.on('maximize', broadcastMaximized);
  win.on('unmaximize', broadcastMaximized);

  // Deny new windows; route to OS browser instead.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });

  // Block in-page navigation to anything off-origin.
  win.webContents.on('will-navigate', (event, url) => {
    const devUrl = process.env['ELECTRON_RENDERER_URL'];
    const allowed = isDev && devUrl ? devUrl : 'file://';
    if (!url.startsWith(allowed)) {
      event.preventDefault();
      if (/^https?:\/\//.test(url)) void shell.openExternal(url);
    }
  });

  win.once('ready-to-show', () => win.show());

  if (isDev) {
    void win.loadURL(process.env['ELECTRON_RENDERER_URL']!);
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'));
  }

  return win;
}

function installWindowControlBridge(): void {
  const focused = () => BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
  ipcMain.handle(IPC.WinMinimize, async () => {
    focused()?.minimize();
  });
  ipcMain.handle(IPC.WinMaximizeToggle, async (): Promise<boolean> => {
    const w = focused();
    if (!w) return false;
    if (w.isMaximized()) w.unmaximize();
    else w.maximize();
    return w.isMaximized();
  });
  ipcMain.handle(IPC.WinClose, async () => {
    focused()?.close();
  });
}

void app.whenReady().then(async () => {
  applyCsp();
  installPrefsBridge();
  installProjectsBridge();
  installWindowControlBridge();
  installAgentBridge();

  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  void disposeAgentBridge().finally(() => closeDb());
});

// Defence-in-depth: refuse any unexpected webContents permission request.
app.on('web-contents-created', (_event, contents) => {
  contents.on('will-attach-webview', (e) => e.preventDefault());
  contents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
});
