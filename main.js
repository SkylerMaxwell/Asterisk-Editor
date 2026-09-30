// Asterisk - main process.
// Everything in this folder is plain JS/HTML/CSS that Electron reads at start-up,
// so editing any file here needs NO recompiling: just relaunch (or press Ctrl+R).
const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs');

const APP_NAME = 'Asterisk';
const PROJECT_EXT = 'asterisk';
const PROJECT_FORMAT = 'asterisk-project';
const PROJECT_VERSION = 1;
const ICON = path.join(__dirname, 'assets', 'asterisk.ico');

app.setName(APP_NAME);
if (process.platform === 'win32') app.setAppUserModelId('Asterisk.App');

let win = null;
let allowClose = false;
let initialFile = null;

// A file passed on the command line (double-click on a .asterisk file).
(function readArgs() {
  const args = process.argv.slice(app.isPackaged ? 1 : 2);
  for (const a of args) {
    if (!a || a.startsWith('-')) continue;
    if (/\.(asterisk|json)$/i.test(a) && fs.existsSync(a)) { initialFile = path.resolve(a); break; }
  }
})();

// Never show Electron's native "A JavaScript error occurred" box - route to the in-app dialog.
function reportError(title, err) {
  const message = (err && (err.stack || err.message)) || String(err);
  if (win && !win.isDestroyed()) win.webContents.send('app-error', { title, message: String(message).split('\n')[0] });
  else console.error(title, message);
}
process.on('uncaughtException', (err) => reportError('Something went wrong', err));
process.on('unhandledRejection', (err) => reportError('Something went wrong', err));

function createWindow() {
  win = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 800,
    minHeight: 500,
    title: APP_NAME,
    icon: ICON,
    frame: false,
    backgroundColor: '#f3f2f1',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });
  win.removeMenu();
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.once('ready-to-show', () => win.show());

  win.on('maximize', () => win.webContents.send('win-maximized', true));
  win.on('unmaximize', () => win.webContents.send('win-maximized', false));

  // Lock down navigation / popups.
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (e) => e.preventDefault());

  // Closing: let the renderer decide (it shows an in-app "unsaved changes" dialog).
  let ackTimer = null;
  win.on('close', (e) => {
    if (allowClose || win.webContents.isCrashed() || win.webContents.isLoading()) return;
    e.preventDefault();
    win.webContents.send('request-close');
    clearTimeout(ackTimer);
    ackTimer = setTimeout(() => { allowClose = true; if (win && !win.isDestroyed()) win.close(); }, 2500); // renderer unresponsive
    ipcMain.once('close-ack', () => clearTimeout(ackTimer));
  });
  win.on('closed', () => { win = null; });

  // Dev conveniences (the menu is removed, so register them by hand).
  win.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return;
    const ctrl = input.control || input.meta;
    const k = (input.key || '').toLowerCase();
    if (k === 'f5' || (ctrl && k === 'r')) { event.preventDefault(); win.webContents.send('request-reload'); }
    else if (k === 'f12' || (ctrl && input.shift && k === 'i')) { event.preventDefault(); win.webContents.toggleDevTools(); }
  });
}

app.whenReady().then(createWindow);
app.on('window-all-closed', () => app.quit());

// ---- Window controls ----
ipcMain.on('win-minimize', () => { if (win) win.minimize(); });
ipcMain.on('win-maximize', () => { if (!win) return; win.isMaximized() ? win.unmaximize() : win.maximize(); });
ipcMain.on('win-close', () => { if (win) win.close(); });
ipcMain.handle('win-is-maximized', () => (win ? win.isMaximized() : false));
ipcMain.on('close-now', () => { allowClose = true; if (win) win.close(); });
ipcMain.on('reload-now', () => { if (win) win.webContents.reloadIgnoringCache(); });
ipcMain.on('set-title', (e, t) => { if (win && !win.isDestroyed()) win.setTitle(String(t)); });

// ---- Project files ----
function writeAtomic(file, text) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, text, 'utf8');
  try { fs.renameSync(tmp, file); }
  catch (_) { fs.writeFileSync(file, text, 'utf8'); try { fs.unlinkSync(tmp); } catch (__) {} }
}

function parseProject(file) {
  const raw = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
  let data;
  try { data = JSON.parse(raw); } catch (_) { throw new Error('This file is not a valid Asterisk project.'); }
  const legacy = data && Array.isArray(data.items);            // old Starboard .json
  if (!data || (data.format !== PROJECT_FORMAT && !legacy)) throw new Error('This file is not an Asterisk project.');
  if (data.version && data.version > PROJECT_VERSION) throw new Error('This project was made with a newer version of Asterisk.');
  return data;
}

// Save the project. { data, filePath?, saveAs? } -> { saved, filePath } | { saved:false, canceled } | { saved:false, error }
ipcMain.handle('save-project', async (event, { data, filePath, saveAs, suggestedName }) => {
  try {
    const w = BrowserWindow.fromWebContents(event.sender);
    let target = filePath;
    if (!target || saveAs) {
      const r = await dialog.showSaveDialog(w, {
        title: 'Save project',
        defaultPath: filePath || (suggestedName || 'Untitled') + '.' + PROJECT_EXT,
        filters: [{ name: 'Asterisk project', extensions: [PROJECT_EXT] }]
      });
      if (r.canceled || !r.filePath) return { saved: false, canceled: true };
      target = r.filePath;
      if (!path.extname(target)) target += '.' + PROJECT_EXT;
    }
    const project = {
      format: PROJECT_FORMAT,
      version: PROJECT_VERSION,
      app: APP_NAME,
      savedAt: new Date().toISOString(),
      view: data.view,
      theme: data.theme,
      items: data.items
    };
    writeAtomic(target, JSON.stringify(project));
    return { saved: true, filePath: target };
  } catch (err) {
    return { saved: false, error: err.message };
  }
});

ipcMain.handle('open-project', async (event) => {
  try {
    const w = BrowserWindow.fromWebContents(event.sender);
    const r = await dialog.showOpenDialog(w, {
      title: 'Open project',
      filters: [
        { name: 'Asterisk project', extensions: [PROJECT_EXT] },
        { name: 'Older Starboard files', extensions: ['json'] }
      ],
      properties: ['openFile']
    });
    if (r.canceled || !r.filePaths[0]) return { loaded: false, canceled: true };
    return { loaded: true, filePath: r.filePaths[0], data: parseProject(r.filePaths[0]) };
  } catch (err) {
    return { loaded: false, error: err.message };
  }
});

ipcMain.handle('initial-file', () => {
  if (!initialFile) return null;
  try { return { loaded: true, filePath: initialFile, data: parseProject(initialFile) }; }
  catch (err) { return { loaded: false, error: err.message }; }
});

// ---- PNG export (native file picker, but written by us - no browser download popup) ----
ipcMain.handle('export-png', async (event, { dataUrl, suggestedName }) => {
  try {
    const w = BrowserWindow.fromWebContents(event.sender);
    const r = await dialog.showSaveDialog(w, {
      title: 'Export image',
      defaultPath: (suggestedName || 'Untitled') + '.png',
      filters: [{ name: 'PNG image', extensions: ['png'] }]
    });
    if (r.canceled || !r.filePath) return { saved: false, canceled: true };
    const b64 = String(dataUrl).replace(/^data:image\/png;base64,/, '');
    fs.writeFileSync(r.filePath, Buffer.from(b64, 'base64'));
    return { saved: true, filePath: r.filePath };
  } catch (err) {
    return { saved: false, error: err.message };
  }
});
