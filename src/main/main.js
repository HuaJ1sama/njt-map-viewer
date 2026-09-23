'use strict';

const { app, BrowserWindow, Menu, ipcMain, protocol, net, shell } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { pathToFileURL } = require('node:url');

const APP_ROOT = app.isPackaged ? process.resourcesPath : path.join(__dirname, '..', '..');
// 改名前的数据目录，升级后第一次启动会把里面的标注/校准/偏好搬过来
const LEGACY_APP_NAME = '尼沙皇吊图地图浏览';
const MIGRATED_FILES = ['annotations.json', 'hotspots.json', 'settings.json'];

const paths = {
  appRoot: () => APP_ROOT,
  mapsDir: () => path.join(APP_ROOT, '尼沙皇吊图'),
  assetsDir: () => path.join(APP_ROOT, 'assets'),
  configFile: () => path.join(APP_ROOT, 'config', 'regions.json'),
  scavLootFile: () => path.join(APP_ROOT, 'config', 'scav-loot.json'),
  announcementsFile: () => path.join(APP_ROOT, 'config', 'announcements.json'),
  userDir: () => app.getPath('userData'),
  annotationsFile: () => path.join(app.getPath('userData'), 'annotations.json'),
  hotspotsFile: () => path.join(app.getPath('userData'), 'hotspots.json'),
  settingsFile: () => path.join(app.getPath('userData'), 'settings.json'),
  penLogFile: () => path.join(app.getPath('userData'), 'pen-log.json'),
};

const MIME_BY_EXT = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
};

protocol.registerSchemesAsPrivileged([
  {
    scheme: 'njt',
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
      stream: true,
      bypassCSP: true,
    },
  },
]);

function isInside(base, target) {
  const rel = path.relative(base, target);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/** 只允许读取图片目录与 assets 目录内的文件，拒绝越权路径。 */
function resolveServedFile(urlString) {
  const url = new URL(urlString);
  const rel = decodeURIComponent(url.pathname).replace(/^\/+/, '');
  const base = url.hostname === 'map' ? paths.mapsDir() : url.hostname === 'asset' ? paths.assetsDir() : null;
  if (!base || !rel) return null;
  const target = path.resolve(base, rel);
  if (!isInside(base, target)) return null;
  return target;
}

function registerProtocol() {
  protocol.handle('njt', async (request) => {
    try {
      const target = resolveServedFile(request.url);
      if (!target) return new Response('forbidden', { status: 403 });
      const stat = await fs.promises.stat(target).catch(() => null);
      if (!stat || !stat.isFile()) return new Response('not found', { status: 404 });
      const response = await net.fetch(pathToFileURL(target).toString());
      const type = MIME_BY_EXT[path.extname(target).toLowerCase()] || response.headers.get('content-type') || 'application/octet-stream';
      const headers = new Headers(response.headers);
      headers.set('content-type', type);
      headers.set('cache-control', 'no-cache');
      headers.set('access-control-allow-origin', '*');
      return new Response(response.body, { status: response.status, headers });
    } catch (error) {
      return new Response(`error: ${error && error.message}`, { status: 500 });
    }
  });
}

function readJsonSync(file, fallback) {
  try {
    const text = fs.readFileSync(file, 'utf8');
    const data = JSON.parse(text);
    return data && typeof data === 'object' ? data : fallback;
  } catch {
    return fallback;
  }
}

/**
 * 应用版本：正常从应用自己的 package.json 读。
 * 注意 `electron tools/xxx.js` 这种跑法下 app.getVersion() 会退回 Electron 的版本号，所以不直接用它。
 */
function readAppVersion() {
  try {
    const data = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'package.json'), 'utf8'));
    if (data && data.version) return String(data.version);
  } catch {
    /* 读不到就用 Electron 给的 */
  }
  return app.getVersion();
}

/** 应用改名后 userData 目录也跟着变，把旧目录里的数据搬过来，免得标注看着像丢了。 */
function migrateLegacyUserData() {
  const current = app.getPath('userData');
  if (path.basename(current) === LEGACY_APP_NAME) return;
  const legacy = path.join(path.dirname(current), LEGACY_APP_NAME);
  if (!fs.existsSync(legacy)) return;
  try {
    fs.mkdirSync(current, { recursive: true });
    for (const name of MIGRATED_FILES) {
      const from = path.join(legacy, name);
      const to = path.join(current, name);
      if (fs.existsSync(from) && !fs.existsSync(to)) fs.copyFileSync(from, to);
    }
  } catch (error) {
    console.warn(`旧数据迁移失败：${error.message}`);
  }
}

function writeJsonSync(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

let mainWindow = null;

function createWindow() {
  const win = new BrowserWindow({
    width: 1600,
    height: 1000,
    minWidth: 1024,
    minHeight: 640,
    show: false,
    backgroundColor: '#0b0d10',
    autoHideMenuBar: true,
    title: '尼沙皇版图浏览小工具',
    icon: path.join(paths.assetsDir(), 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,
      backgroundThrottling: false,
    },
  });

  win.setMenuBarVisibility(false);
  // 页面里的外部链接一律交给系统浏览器，别在应用里弹新窗口
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  win.once('ready-to-show', () => {
    win.maximize();
    win.show();
  });
  if (process.argv.includes('--dev')) {
    win.webContents.openDevTools({ mode: 'detach' });
  }
  win.on('closed', () => {
    if (mainWindow === win) mainWindow = null;
  });
  mainWindow = win;
  return win;
}

function registerIpc() {
  ipcMain.handle('config:get', () => {
    const config = readJsonSync(paths.configFile(), null);
    if (!config) throw new Error(`无法读取配置：${paths.configFile()}`);
    const saved = readJsonSync(paths.hotspotsFile(), { version: 1, hotspots: {} });
    // 坐标空间变了（例如大地图重新裁剪）就丢弃旧的校准结果，避免热区错位。
    const sameSpace = !saved.space || saved.space === (config.overview && config.overview.space);
    return {
      config,
      version: readAppVersion(),
      hotspots: sameSpace ? saved.hotspots || {} : {},
      scav: readJsonSync(paths.scavLootFile(), { version: 1, cost: 95000, items: [] }),
      announcements: readJsonSync(paths.announcementsFile(), null),
      mapsDir: paths.mapsDir(),
      userDataDir: paths.userDir(),
      // 只有带 --penlog 启动时才记录笔的指针事件，平时不产生任何额外文件
      penLog: process.argv.includes('--penlog'),
    };
  });

  ipcMain.handle('annotations:load', () => readJsonSync(paths.annotationsFile(), { version: 1, maps: {} }));
  ipcMain.handle('annotations:save', (_event, data) => {
    if (!data || typeof data !== 'object') throw new Error('标注数据格式不正确');
    writeJsonSync(paths.annotationsFile(), data);
    return { ok: true, file: paths.annotationsFile() };
  });

  ipcMain.handle('hotspots:load', () => readJsonSync(paths.hotspotsFile(), { version: 1, hotspots: {} }));
  ipcMain.handle('hotspots:save', (_event, data) => {
    if (!data || typeof data !== 'object') throw new Error('热点数据格式不正确');
    writeJsonSync(paths.hotspotsFile(), data);
    return { ok: true, file: paths.hotspotsFile() };
  });

  ipcMain.handle('settings:load', () => readJsonSync(paths.settingsFile(), { version: 1 }));
  ipcMain.handle('settings:save', (_event, data) => {
    if (!data || typeof data !== 'object') throw new Error('设置数据格式不正确');
    writeJsonSync(paths.settingsFile(), data);
    return { ok: true, file: paths.settingsFile() };
  });

  // 数绘屏反馈取证用：把渲染进程记下的 pointer 事件落盘，方便远程排查笔输入问题
  ipcMain.handle('penlog:save', (_event, data) => {
    if (!data || typeof data !== 'object') throw new Error('笔迹日志格式不正确');
    writeJsonSync(paths.penLogFile(), data);
    return { ok: true, file: paths.penLogFile() };
  });

  // 主进程只负责截图，写剪贴板交给渲染进程的异步剪贴板 API（部分 Electron 构建的主进程没有图片剪贴板 API）
  ipcMain.handle('view:capture', async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win) return { ok: false, reason: 'no-window' };
    const image = await win.webContents.capturePage();
    return { ok: true, size: image.getSize(), dataUrl: image.toDataURL() };
  });

  ipcMain.handle('win:toggle-fullscreen', (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win) return false;
    win.setFullScreen(!win.isFullScreen());
    return win.isFullScreen();
  });

  ipcMain.handle('win:is-fullscreen', (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    return win ? win.isFullScreen() : false;
  });

  ipcMain.handle('app:quit', () => {
    app.quit();
    return true;
  });

  // 「作者」那个链接交给系统浏览器打开，不在应用里开新窗口
  ipcMain.handle('shell:openExternal', (_event, url) => {
    if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) throw new Error('只允许打开 http(s) 链接');
    return shell.openExternal(url);
  });
}

const readyPromise = app.whenReady().then(() => {
  Menu.setApplicationMenu(null);
  migrateLegacyUserData();
  registerProtocol();
  registerIpc();
  const win = createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
  return win;
});

app.on('window-all-closed', () => {
  app.quit();
});

module.exports = {
  readyPromise,
  getWindow: () => mainWindow,
  paths,
  readJsonSync,
  writeJsonSync,
};
