// Headless-ish renderer verification: load renderer/index.html in a hidden
// BrowserWindow with the real preload, stub the IPC the renderer calls on boot,
// then assert the scripts loaded and the Pair button got a click handler.
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');

ipcMain.handle('host:status', () => ({ paired: false, label: null, server: 'https://agentalpaca.app', agents: [], running: [] }));
ipcMain.handle('host:pair', () => ({ ok: true }));
ipcMain.handle('host:launch', () => ({ ok: true }));
ipcMain.on('open:external', () => {});

app.disableHardwareAcceleration();

app.whenReady().then(async () => {
  const w = new BrowserWindow({
    show: false,
    webPreferences: { preload: path.join(__dirname, '..', 'preload.js'), contextIsolation: true, nodeIntegration: false },
  });
  const logs = [];
  w.webContents.on('console-message', (_e, _lvl, msg) => logs.push(msg));
  await w.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  await new Promise((r) => setTimeout(r, 1000));

  const checks = await w.webContents.executeJavaScript(`(function(){
    var pb = document.getElementById('pairBtn');
    var pv = document.getElementById('pairView');
    var mv = document.getElementById('mainView');
    return {
      hasTerminal: typeof Terminal !== 'undefined',
      hasFitAddon: typeof FitAddon !== 'undefined',
      hasAlpacaBridge: !!window.alpaca,
      pairBtnExists: !!pb,
      pairBtnWired: !!(pb && pb.onclick),
      pairViewShown: pv ? getComputedStyle(pv).display !== 'none' : null,
      mainViewHidden: mv ? getComputedStyle(mv).display === 'none' : null,
      serverPrefilled: (document.getElementById('server') || {}).value
    };
  })()`);

  console.log('CHECKS ' + JSON.stringify(checks, null, 2));
  if (logs.length) console.log('CONSOLE ' + JSON.stringify(logs.slice(0, 15)));
  const ok =
    checks.hasTerminal && checks.hasFitAddon && checks.hasAlpacaBridge &&
    checks.pairBtnWired && checks.pairViewShown && checks.mainViewHidden;
  console.log(ok ? 'RENDERER_OK ✅' : 'RENDERER_ISSUES ❌');
  app.exit(ok ? 0 : 1);
});

setTimeout(() => { console.log('VERIFY_TIMEOUT'); app.exit(2); }, 12000);
