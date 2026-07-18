/**
 * Agent Alpaca host — Electron main process.
 *
 * Lives in the menu bar. Pairs the machine to an account, launches agents in
 * PTYs (via lib/host.js), streams them to the cloud, and shows a live local view
 * in its window. The tray has a quick launcher and a kill switch that stops every
 * running agent at once — the "pull the plug" control for a remote-shell tool.
 */
'use strict';

const { app, BrowserWindow, Tray, Menu, ipcMain, nativeImage, shell } = require('electron');
const path = require('path');
const agents = require('./lib/agents');
const { loadConfig, saveConfig, pair, AgentSession, DEFAULT_SERVER } = require('./lib/host');

let tray = null;
let win = null;
/** @type {Map<string, AgentSession>} sid -> session */
const sessions = new Map();

// --- window ----------------------------------------------------------------

function createWindow() {
  if (win && !win.isDestroyed()) {
    win.show();
    win.focus();
    return;
  }
  win = new BrowserWindow({
    width: 900,
    height: 640,
    show: false,
    title: 'Agent Alpaca',
    backgroundColor: '#0e0e12',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  if (process.env.ALPACA_DEBUG) win.webContents.openDevTools({ mode: 'detach' });
  win.webContents.on('render-process-gone', (_e, d) => console.error('renderer gone:', d.reason));
  win.webContents.on('preload-error', (_e, p, err) => console.error('preload error:', p, err));
  win.once('ready-to-show', () => win.show());
  win.on('close', (e) => {
    // Keep running in the tray instead of quitting.
    if (!app.isQuitting) {
      e.preventDefault();
      win.hide();
    }
  });
}

// --- tray ------------------------------------------------------------------

function trayIcon() {
  // A tiny template image so it looks right in the menu bar (falls back to empty).
  const img = nativeImage.createFromPath(path.join(__dirname, 'assets', 'trayTemplate.png'));
  if (!img.isEmpty() && process.platform === 'darwin') img.setTemplateImage(true);
  return img;
}

function rebuildTrayMenu() {
  if (!tray) return;
  const cfg = loadConfig();
  const running = [...sessions.values()];
  const quickLaunch = agents
    .list()
    .filter((a) => a.installed)
    .map((a) => ({ label: `Start ${a.name}`, click: () => launch({ agentId: a.id }) }));

  const template = [
    { label: cfg.token ? `Signed in · ${cfg.label || 'this machine'}` : 'Not paired', enabled: false },
    { type: 'separator' },
    { label: 'Open Agent Alpaca', click: () => createWindow() },
    ...(cfg.token
      ? [{ label: 'Quick launch', submenu: quickLaunch.length ? quickLaunch : [{ label: 'No agents detected', enabled: false }] }]
      : [{ label: 'Pair this machine…', click: () => createWindow() }]),
    { type: 'separator' },
    {
      label: running.length ? `Running: ${running.length}` : 'No agents running',
      enabled: false,
    },
    {
      label: 'Stop all agents',
      enabled: running.length > 0,
      click: () => stopAll(),
    },
    { label: 'Open web app', click: () => shell.openExternal((cfg.server || DEFAULT_SERVER).replace(/\/$/, '') + '/app.html') },
    { type: 'separator' },
    { label: 'Quit Agent Alpaca', click: () => quit() },
  ];
  tray.setContextMenu(Menu.buildFromTemplate(template));
  tray.setToolTip(`Agent Alpaca — ${running.length} running`);
}

// --- session lifecycle -----------------------------------------------------

async function launch({ agentId, customCommand, cwd }) {
  const cfg = loadConfig();
  if (!cfg.token) throw new Error('not paired');
  const spec = agents.resolve(agentId, customCommand);
  const label = `${cfg.label || 'host'}: ${spec.name}`;
  const session = new AgentSession(cfg, { file: spec.file, args: spec.args, label, cwd });

  session.on('sid', (sid) => {
    sessions.set(sid, session);
    session._agentName = spec.name;
    rebuildTrayMenu();
    sendToRenderer('session:started', { sid, name: spec.name, cmd: [spec.file, ...spec.args].join(' ') });
  });
  session.on('data', (d) => session.sid && sendToRenderer('session:data', { sid: session.sid, data: d }));
  session.on('status', (s) => session.sid && sendToRenderer('session:status', { sid: session.sid, online: s.online }));
  session.on('exit', () => {
    if (session.sid) {
      sessions.delete(session.sid);
      sendToRenderer('session:exit', { sid: session.sid });
      rebuildTrayMenu();
    }
  });
  session.on('error', (e) => sendToRenderer('session:error', { sid: session.sid, message: String(e.message || e) }));

  await session.start();
  return session.sid;
}

function stopSession(sid) {
  const s = sessions.get(sid);
  if (s) s.stop();
}

function stopAll() {
  for (const s of sessions.values()) s.stop();
}

function quit() {
  app.isQuitting = true;
  stopAll();
  app.quit();
}

// --- IPC (renderer <-> main) ----------------------------------------------

function sendToRenderer(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

ipcMain.handle('host:status', () => {
  const cfg = loadConfig();
  return {
    paired: !!cfg.token,
    label: cfg.label || null,
    server: cfg.server || DEFAULT_SERVER,
    agents: agents.list(),
    running: [...sessions.values()].filter((s) => s.sid).map((s) => ({ sid: s.sid, name: s._agentName, online: s.online })),
  };
});

ipcMain.handle('host:pair', async (_e, { code, server, label }) => {
  const srv = server || loadConfig().server || DEFAULT_SERVER;
  const cfg = await pair(srv, code, label || require('os').hostname());
  rebuildTrayMenu();
  return { ok: true, label: cfg.label, server: cfg.server };
});

ipcMain.handle('host:launch', async (_e, opts) => {
  const sid = await launch(opts);
  return { ok: true, sid };
});

ipcMain.handle('host:stop', (_e, { sid }) => {
  stopSession(sid);
  return { ok: true };
});

ipcMain.handle('host:stopAll', () => {
  stopAll();
  return { ok: true };
});

ipcMain.handle('host:unpair', () => {
  stopAll();
  saveConfig({}); // wipe token
  rebuildTrayMenu();
  return { ok: true };
});

ipcMain.on('session:input', (_e, { sid, data }) => {
  const s = sessions.get(sid);
  if (s) s.write(data);
});

ipcMain.on('session:resize', (_e, { sid, cols, rows }) => {
  const s = sessions.get(sid);
  if (s) s.resize(cols, rows);
});

ipcMain.on('open:external', (_e, url) => shell.openExternal(url));

// --- app lifecycle ---------------------------------------------------------

if (process.platform === 'darwin' && app.dock) app.dock.hide(); // menu-bar app, no dock icon

app.whenReady().then(() => {
  tray = new Tray(trayIcon());
  rebuildTrayMenu();
  tray.on('click', () => createWindow());
  createWindow();
});

app.on('window-all-closed', (e) => {
  // Stay alive in the tray.
});

app.on('before-quit', () => {
  app.isQuitting = true;
  stopAll();
});
