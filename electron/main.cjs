'use strict';

const { app, BrowserWindow, Menu, MessageChannelMain, dialog, ipcMain, net, protocol, session, utilityProcess } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

if (!app || typeof app.whenReady !== 'function') {
  console.error('Electron started as plain Node because ELECTRON_RUN_AS_NODE is set.');
  process.exit(78);
}

const APP_SCHEME = 'app';
const APP_HOST = 'allinone';
const DEV_SERVER = process.env.MCSEEDMAP_DEV_SERVER || '';
const SMOKE = process.env.AIO_SMOKE === '1';
const appRoot = path.resolve(__dirname, '..');
let logFile = '';
let sessionDir = '';

/** Any Chinese system locale (zh-CN, zh-HK, zh-TW, zh-Hans-CN, zh-SG, ...) defaults to Chinese. */
function preferredLocale(systemLocale) {
  const tag = String(systemLocale || '').replaceAll('_', '-').toLowerCase();
  return tag.startsWith('zh') ? 'zh' : 'en';
}

function log(message) {
  const line = `[${new Date().toISOString()}] ${message}`;
  console.log(line);
  if (!logFile) return;
  try { fs.appendFileSync(logFile, `${line}\n`); } catch { /* keep going */ }
}

function exeDirectory() {
  // Portable builds extract to a temp folder; the real exe dir is this env var.
  if (process.env.PORTABLE_EXECUTABLE_DIR) return process.env.PORTABLE_EXECUTABLE_DIR;
  if (process.env.PORTABLE_EXECUTABLE_FILE) return path.dirname(process.env.PORTABLE_EXECUTABLE_FILE);
  if (app.isPackaged) return path.dirname(process.execPath);
  return appRoot;
}

function configureUserData() {
  const exeDir = exeDirectory();
  const portableDir = path.join(exeDir, 'userdata');
  sessionDir = path.join(exeDir, 'session');
  try {
    fs.mkdirSync(portableDir, { recursive: true });
    fs.mkdirSync(sessionDir, { recursive: true });
    fs.writeFileSync(path.join(portableDir, '.write-probe'), 'ok');
    app.setPath('userData', portableDir);
    logFile = path.join(portableDir, 'aio-desktop.log');
  } catch (error) {
    sessionDir = path.join(app.getPath('userData'), 'session');
    try { fs.mkdirSync(sessionDir, { recursive: true }); } catch { /* keep going */ }
    logFile = path.join(app.getPath('userData'), 'aio-desktop.log');
    log(`portable userdata unavailable: ${error}`);
  }
}

function sessionPath(name) {
  const safe = String(name || 'map').replace(/[^a-z0-9._-]/gi, '_');
  return path.join(sessionDir || path.join(appRoot, 'session'), `${safe}.json`);
}

function nativePath() {
  if (app.isPackaged) return path.join(process.resourcesPath, 'native', 'allinone.node');
  return path.join(appRoot, 'native', 'build', 'allinone.node');
}

configureUserData();

protocol.registerSchemesAsPrivileged([
  {
    scheme: APP_SCHEME,
    privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true },
  },
]);

if (!app.requestSingleInstanceLock()) app.quit();

function distDir() {
  const candidates = [
    path.join(appRoot, 'dist'),
    path.join(process.resourcesPath || '', 'app', 'dist'),
    path.join(appRoot, 'resources', 'app', 'dist'),
  ];
  return candidates.find((dir) => fs.existsSync(path.join(dir, 'index.html'))) || candidates[0];
}

function blockNetwork() {
  session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
    const url = details.url;
    const remote = url.startsWith('http:') || url.startsWith('https:');
    const allowed = DEV_SERVER && (url.startsWith(DEV_SERVER) || url.startsWith('http://localhost:5173'));
    callback(remote && !allowed ? { cancel: true } : {});
  });
}

function registerAppProtocol(root) {
  const base = path.resolve(root);
  protocol.handle(APP_SCHEME, (request) => {
    const url = new URL(request.url);
    let pathname = decodeURIComponent(url.pathname);
    if (pathname === '/' || pathname === '') pathname = '/index.html';
    const file = path.resolve(base, `.${pathname}`);
    if (!file.startsWith(base)) return new Response('forbidden', { status: 403 });
    if (!fs.existsSync(file)) return new Response('missing', { status: 404 });
    return net.fetch(pathToFileURL(file).href);
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runSmoke() {
  const addon = require(nativePath());
  const versions = addon.versions();
  const newest = versions[versions.length - 1];
  const modern = versions.find((item) => item.name === '1.21.11') || newest;
  const tile = addon.renderTile({
    mc: modern.id,
    seed: '123',
    dim: 0,
    largeBiomes: false,
    scale: 16,
    x: -256,
    z: -256,
    sx: 32,
    sz: 32,
    y: 64,
  });
  const fineTile = addon.renderTile({
    mc: modern.id,
    seed: '123',
    dim: 0,
    largeBiomes: false,
    scale: 1,
    x: -64,
    z: -64,
    sx: 64,
    sz: 64,
    y: 64,
  });
  const biome = addon.biomeAt({
    mc: modern.id, seed: '123', dim: 0, largeBiomes: false, x: 0, y: 64, z: 0,
  });
  const weird = addon.weirdness('12345');
  const features = addon.features();
  const structures = addon.structures({
    mc: modern.id,
    seed: '123',
    dim: 0,
    largeBiomes: false,
    x0: -1024,
    z0: -1024,
    x1: 1024,
    z1: 1024,
    types: features.filter((item) => item.dim === 0).map((item) => item.id),
  });
  const endStructures = addon.structures({
    mc: modern.id,
    seed: '123',
    dim: 1,
    largeBiomes: false,
    x0: -512,
    z0: -512,
    x1: 512,
    z1: 512,
    types: features.filter((item) => item.dim === 1).map((item) => item.id),
  });
  let search = null;
  let searchError = '';
  try {
    addon.searchStart({
      page: 'lowy-single',
      mc: modern.id,
      threads: 2,
      minX: -512,
      maxX: 512,
      minZ: -512,
      maxZ: 512,
      fastMode: true,
      ratio: 90,
      riverWeight: 0.75,
      seed: '12345',
    });
    const started = Date.now();
    while (Date.now() - started < 20000) {
      search = addon.searchPoll();
      if (search.done || search.current > 0 || search.phase !== 0) break;
      await sleep(250);
    }
    addon.searchStop();
    await sleep(300);
    search = addon.searchPoll();
  } catch (error) {
    searchError = error && error.message ? error.message : String(error);
  }
  let slime = null;
  let slimeError = '';
  try {
    addon.slimeFarmStart({
      mc: newest.id,
      versionRule: 2,
      threads: 2,
      minSlimeArea: 9000,
      minX: -2048,
      maxX: 2048,
      minZ: -2048,
      maxZ: 2048,
      convert: true,
      seeds: ['0'],
    });
    const started = Date.now();
    while (Date.now() - started < 20000) {
      slime = addon.slimeFarmPoll();
      if (slime.done) break;
      await sleep(100);
    }
    if (slime && !slime.done) addon.slimeFarmStop();
  } catch (error) {
    slimeError = error && error.message ? error.message : String(error);
  }
  let witch = null;
  let witchError = '';
  try {
    addon.witchSearchStart({
      versionGroup: 2,
      largeBiomes: false,
      singleBiome: false,
      threads: 2,
      maxY: -40,
      minX: 14848,
      maxX: 15359,
      minZ: -3072,
      maxZ: -2561,
      seeds: ['-143551518615525778'],
    });
    const started = Date.now();
    while (Date.now() - started < 60000) {
      witch = addon.witchSearchPoll();
      if (witch.done) break;
      await sleep(100);
    }
    if (witch && !witch.done) addon.witchSearchStop();
  } catch (error) {
    witchError = error && error.message ? error.message : String(error);
  }
  let river = null;
  let riverError = '';
  try {
    const riverMc = versions.find((item) => item.name === '26.3') || newest;
    addon.riverSearchStart({
      mc: riverMc.id,
      threads: 2,
      minScore: 24831,
      y: -64,
      calcCave: false,
      minX: -1024,
      maxX: 1023,
      minZ: -1024,
      maxZ: 1023,
      seeds: ['0'],
    });
    const started = Date.now();
    while (Date.now() - started < 60000) {
      river = addon.riverSearchPoll();
      if (river.done) break;
      await sleep(100);
    }
    if (river && !river.done) addon.riverSearchStop();
  } catch (error) {
    riverError = error && error.message ? error.message : String(error);
  }
  const colored = Buffer.isBuffer(tile) && tile.some((byte) => byte !== 0 && byte !== 255);
  const fineColored = Buffer.isBuffer(fineTile) && fineTile.length === 64 * 64 * 4
    && fineTile.some((byte) => byte !== 0 && byte !== 255);
  const report = {
    versions: versions.length,
    newest: newest && newest.name,
    tileBytes: tile.length,
    colored,
    fineTileBytes: fineTile.length,
    fineColored,
    biome,
    weird,
    featureCount: features.length,
    structures: structures.length,
    endStructures: endStructures.length,
    search,
    searchError,
    slime: slime ? {
      done: slime.done,
      error: slime.error,
      stage: slime.stage,
      hits: slime.hits.length,
      first: slime.hits[0] ? {
        x: slime.hits[0].x,
        z: slime.hits[0].z,
        area: slime.hits[0].area,
        areaEquiv: slime.hits[0].areaEquiv,
        chunks: slime.hits[0].chunks,
      } : null,
    } : null,
    slimeError,
    witch: witch ? {
      done: witch.done,
      error: witch.error,
      regions: witch.total,
      hits: witch.hits.length,
      first: witch.hits[0] ? {
        x: witch.hits[0].x,
        z: witch.hits[0].z,
        y: witch.hits[0].y,
        sizeX: witch.hits[0].sizeX,
        sizeZ: witch.hits[0].sizeZ,
        wet: witch.hits[0].wet,
      } : null,
    } : null,
    witchError,
    river: river ? {
      done: river.done,
      error: river.error,
      stage: river.stage,
      hits: river.hits.length,
      first: river.hits[0] ? {
        x: river.hits[0].x,
        z: river.hits[0].z,
        score: river.hits[0].score,
        river: river.hits[0].river,
        cave: river.hits[0].cave,
        sampleY: river.hits[0].sampleY,
      } : null,
    } : null,
    riverError,
  };
  const checks = {
    versions: versions.length > 10,
    colored,
    fineColored,
    biome: !!(biome && biome.name),
    weird: Number.isFinite(weird),
    searchError: !searchError,
    search: !!search,
    slimeDone: !!(slime && slime.done),
    slimeError: !!slime && !slime.error && !slimeError,
    slimeHits: !!(slime && slime.hits.length > 0),
    witchDone: !!(witch && witch.done),
    witchError: !!witch && !witch.error && !witchError,
    witchHits: !!(witch && witch.hits.length > 0),
    riverDone: !!(river && river.done),
    riverError: !!river && !river.error && !riverError,
  };
  const ok = Object.values(checks).every(Boolean);
  report.checks = checks;
  report.ok = ok;
  const out = path.join(appRoot, 'smoke-result.json');
  fs.writeFileSync(out, JSON.stringify(report, null, 2));
  log(`smoke wrote ${out}`);
  app.exit(ok ? 0 : 1);
}

let win = null;
let utility = null;

function sessionToText(data, asTxt) {
  if (!asTxt) return JSON.stringify(data, null, 2);
  const features = Array.isArray(data.features) ? data.features.join(',') : '';
  const lines = [
    'kind=aio-session',
    'version=1',
    `seed=${data.seed ?? ''}`,
    `mcVersion=${data.mcVersion ?? ''}`,
    `dim=${data.dim ?? 0}`,
    `y=${data.y ?? 256}`,
    `largeBiomes=${data.largeBiomes ? 'true' : 'false'}`,
    `grid=${data.grid ? 'true' : 'false'}`,
    `features=${features}`,
  ];
  return `${lines.join('\n')}\n`;
}

function installAppMenu() {
  const template = [
    {
      label: 'File',
      submenu: [
        {
          label: 'Export Session...',
          click: () => { if (win) win.webContents.send('session-export'); },
        },
        {
          label: 'Import Session...',
          click: () => { void importSessionFile(); },
        },
        { type: 'separator' },
        { role: 'quit', label: 'Exit' },
      ],
    },
    { role: 'editMenu' },
    { role: 'viewMenu' },
    { role: 'windowMenu' },
    {
      label: 'Help',
      submenu: [
        {
          label: 'About',
          click: () => { if (win) win.webContents.send('show-about'); },
        },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

async function importSessionFile() {
  if (!win) return;
  const result = await dialog.showOpenDialog(win, {
    properties: ['openFile'],
    filters: [
      { name: 'Session', extensions: ['json', 'txt'] },
      { name: 'JSON', extensions: ['json'] },
      { name: 'Text', extensions: ['txt'] },
    ],
  });
  if (result.canceled || !result.filePaths[0]) return;
  const text = fs.readFileSync(result.filePaths[0], 'utf8');
  win.webContents.send('session-import', text);
}

function appIconPath() {
  const candidates = [
    path.join(__dirname, 'icon.ico'),
    path.join(__dirname, 'icon.png'),
    path.join(appRoot, 'build', 'icon.ico'),
    path.join(appRoot, 'build', 'icon.png'),
  ];
  return candidates.find((file) => fs.existsSync(file));
}

function createWindow() {
  const icon = appIconPath();
  win = new BrowserWindow({
    width: 1360,
    height: 860,
    show: false,
    backgroundColor: '#121418',
    ...(icon ? { icon } : {}),
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });
  win.once('ready-to-show', () => win.show());
  if (process.env.AIO_DEV === '1') win.webContents.openDevTools({ mode: 'detach' });
  return win;
}

function utilityScript() {
  if (app.isPackaged) {
    const unpacked = path.join(process.resourcesPath, 'app.asar.unpacked', 'electron', 'utility.cjs');
    if (fs.existsSync(unpacked)) return unpacked;
  }
  return path.join(__dirname, 'utility.cjs');
}

function startUtility() {
  utility = utilityProcess.fork(utilityScript(), [], {
    serviceName: 'aio-native',
    stdio: 'inherit',
    env: { ...process.env, AIO_NATIVE: nativePath() },
  });
  utility.on('exit', (code) => log(`native utility exited ${code}`));
  return new Promise((resolve) => {
    utility.on('message', (data) => {
      if (data && data.ready) resolve(utility);
    });
  });
}

app.on('second-instance', () => {
  if (win) {
    if (win.isMinimized()) win.restore();
    win.focus();
  }
});

app.whenReady().then(async () => {
  if (SMOKE) {
    await runSmoke();
    return;
  }
  blockNetwork();
  installAppMenu();
  if (!DEV_SERVER) registerAppProtocol(distDir());
  ipcMain.on('set-title', (_event, title) => {
    if (win && typeof title === 'string') win.setTitle(title.slice(0, 200));
  });
  ipcMain.handle('open-file', async () => {
    const result = await dialog.showOpenDialog(win, {
      properties: ['openFile'],
      filters: [{ name: 'Text', extensions: ['txt', 'csv'] }],
    });
    if (result.canceled || !result.filePaths[0]) return null;
    return fs.readFileSync(result.filePaths[0], 'utf8');
  });
  ipcMain.handle('save-file', async (_event, name, text) => {
    const result = await dialog.showSaveDialog(win, { defaultPath: typeof name === 'string' ? name : 'results.txt' });
    if (result.canceled || !result.filePath) return false;
    fs.writeFileSync(result.filePath, String(text), 'utf8');
    return true;
  });
  ipcMain.handle('read-session', async (_event, name) => {
    try {
      const file = sessionPath(name);
      if (!fs.existsSync(file)) return null;
      return fs.readFileSync(file, 'utf8');
    } catch (error) {
      log(`read-session failed: ${error}`);
      return null;
    }
  });
  ipcMain.handle('write-session', async (_event, name, text) => {
    try {
      const file = sessionPath(name);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, String(text ?? ''), 'utf8');
      return true;
    } catch (error) {
      log(`write-session failed: ${error}`);
      return false;
    }
  });
  ipcMain.handle('export-session', async (_event, data) => {
    if (!win || !data || typeof data !== 'object') return false;
    const result = await dialog.showSaveDialog(win, {
      defaultPath: 'session.json',
      filters: [
        { name: 'JSON', extensions: ['json'] },
        { name: 'Text', extensions: ['txt'] },
      ],
    });
    if (result.canceled || !result.filePath) return false;
    let file = result.filePath;
    if (!/\.(json|txt)$/i.test(file)) file += '.json';
    fs.writeFileSync(file, sessionToText(data, /\.txt$/i.test(file)), 'utf8');
    return true;
  });
  ipcMain.on('locale-bootstrap', (event) => {
    // Synchronous so the renderer can pick its first paint language before any async work.
    event.returnValue = {
      locale: preferredLocale(app.getLocale()),
      hasSession: fs.existsSync(sessionPath('map')),
    };
  });
  const child = await startUtility();
  const window = createWindow();
  const { port1, port2 } = new MessageChannelMain();
  child.postMessage({ type: 'port' }, [port1]);
  window.webContents.once('did-finish-load', () => {
    window.webContents.postMessage('native-port', null, [port2]);
  });
  if (DEV_SERVER) await window.loadURL(DEV_SERVER);
  else await window.loadURL(`${APP_SCHEME}://${APP_HOST}/`);
}).catch((error) => {
  log(String(error && error.stack ? error.stack : error));
  app.exit(1);
});

app.on('window-all-closed', () => app.quit());
