'use strict';
// Runs inside Orca's Electron main process (loaded by the bootstrap in src/install.mjs). Keeps the
// sync engine alive until Orca quits, whatever happens to the plugin worker:
//   - syncs on start, when an Orca window gets focus (at most once a minute), every N minutes, and
//     a few seconds after you change a setting, a keybinding, a plugin or a synced file
//   - injects src/renderer/panel.js into Orca's windows (Settings Sync panel + toasts)
//   - exposes globalThis.__orcaSettingsSync = { version, root, command(), status(), dispose() }
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { app, BrowserWindow, ipcMain, shell } = require('electron');
const { SyncEngine } = require('./sync.cjs');
const { createAdapter } = require('./adapter.cjs');
const { createOrcaOps } = require('./orca-ops.cjs');
const { isSyncedSetting, UI_KEYS } = require('./items.cjs');

const KEY = '__orcaSettingsSync';
const CHANNEL = '__orcaSettingsSync:';
const CHANGE_DEBOUNCE_MS = 4000;
const FOCUS_MIN_GAP_MS = 60_000;
const QUIET_AFTER_APPLY_MS = 6000;

// Orca IPC calls that mean "the user changed something we sync".
const WATCHED_CHANNELS = {
  'settings:set': (patch) => Object.keys(patch || {}).some((k) => isSyncedSetting(k) || k === 'devPluginPaths'),
  'keybindings:setAction': () => true,
  'keybindings:reload': () => true,
  'plugins:consent': () => true,
  'plugins:setEnabled': () => true,
  'plugins:install': () => true,
  'plugins:remove': () => true,
  'plugins:installMarketplacePlugin': () => true,
  'ui:set': (patch) => Object.keys(patch || {}).some((k) => UI_KEYS.includes(k)),
};

/** @param {{ version: string, root: string, dataDir?: string }} opts */
function install(opts) {
  const userData = app.getPath('userData');
  const dataDir = opts.dataDir || path.join(userData, 'settings-sync');
  fs.mkdirSync(dataDir, { recursive: true });
  const logFile = path.join(dataDir, 'sync.log');
  const log = (msg) => {
    try {
      if (fs.existsSync(logFile) && fs.statSync(logFile).size > 512 * 1024) fs.renameSync(logFile, `${logFile}.1`);
      fs.appendFileSync(logFile, `${new Date().toISOString()} ${msg}\n`);
    } catch { /* logging must never break syncing */ }
  };

  // ---- Orca access + engine ----

  const originals = new Map();
  const ops = createOrcaOps({ ipcMain, userData, originals, BrowserWindow });
  let quietUntil = 0;
  const adapter = createAdapter(ops, {
    managedDevRoot: path.join(dataDir, 'dev-plugins'),
    log,
    afterFileWrite(name, text) {
      // The dim plugin keeps its config in memory; hand it the synced one.
      if (name === 'dim-unfocused-panes.json' && text && globalThis.__orcaDimUnfocused?.command) {
        try { globalThis.__orcaDimUnfocused.command('set', JSON.parse(text)); } catch (err) { log(`dim reload: ${err.message}`); }
      }
    },
  });
  const quietApply = async (...args) => {
    quietUntil = Infinity;
    try {
      return await adapter.apply(...args);
    } finally {
      quietUntil = Date.now() + QUIET_AFTER_APPLY_MS;
    }
  };
  const engine = new SyncEngine({ adapter: { readLocal: adapter.readLocal, apply: quietApply }, dataDir, log, askOnFirstSync: true });

  // ---- change detection ----

  let changeTimer = null;
  const localChanged = (why) => {
    if (Date.now() < quietUntil) return;
    const cfg = engine.config();
    if (!cfg.autoSync || !cfg.repoUrl || engine.state().awaitingChoice) return;
    clearTimeout(changeTimer);
    changeTimer = setTimeout(() => runSync(`change: ${why}`), CHANGE_DEBOUNCE_MS);
  };

  const handlers = ipcMain._invokeHandlers;
  const wrapped = new Map();
  if (handlers instanceof Map) {
    for (const [channel, matters] of Object.entries(WATCHED_CHANNELS)) {
      const original = handlers.get(channel);
      if (typeof original !== 'function') continue;
      const wrapper = async function wrappedBySettingsSync(event, ...args) {
        const result = await original.call(this, event, ...args);
        try { if (matters(...args)) localChanged(channel); } catch { /* never break Orca's handler */ }
        return result;
      };
      originals.set(channel, original);
      wrapped.set(channel, wrapper);
      handlers.set(channel, wrapper);
    }
  } else {
    log('ipcMain._invokeHandlers not found: only timed and manual syncs');
  }

  // Files edited outside Orca's UI (keybindings.json opened in an editor, plugin config files).
  const watched = new Map();
  const watchFiles = async () => {
    const want = new Set();
    try { want.add(await ops.keybindingsPath()); } catch { /* Orca too old */ }
    for (const name of engine.config().extraFiles) want.add(path.join(userData, name));
    for (const [file, fn] of watched) if (!want.has(file)) { fs.unwatchFile(file, fn); watched.delete(file); }
    for (const file of want) {
      if (watched.has(file)) continue;
      const fn = (cur, prev) => { if (cur.mtimeMs !== prev.mtimeMs) localChanged(path.basename(file)); };
      fs.watchFile(file, { interval: 2000, persistent: false }, fn);
      watched.set(file, fn);
    }
  };

  // ---- syncing + telling the user ----

  let lastError = null;
  const runSync = async (reason, { announceAlways = false } = {}) => {
    clearTimeout(changeTimer);
    broadcast('update', status({ running: true }));
    let result;
    try {
      result = await engine.sync(reason);
    } catch (err) {
      result = { ok: false, error: err.message, applied: [], pushed: [], conflicts: [], failed: [] };
      log(`sync crashed: ${err.stack || err.message}`);
    }
    log(`sync (${reason}): ${result.ok ? 'ok' : `error: ${result.error}`} applied=${result.applied.length} pushed=${result.pushed.length} conflicts=${result.conflicts.length} failed=${result.failed.length}${result.awaitingChoice ? ' (waiting for first-sync choice)' : ''}`);
    if (result.awaitingChoice) {
      // The repo already has settings from other machines: ask before changing anything.
      const wc = targetWindow();
      if (wc) await call(wc, 'open', status());
      toast('Settings Sync: this repo already has settings. Choose what this machine should do.', 'warn');
    } else {
      announce(result, announceAlways);
    }
    broadcast('update', status());
    return result;
  };

  const announce = (r, always) => {
    if (!r.ok) {
      if (always || r.error !== lastError) toast(`Settings Sync: ${r.error}`, 'error');
      lastError = r.error;
      return;
    }
    lastError = null;
    const parts = [];
    if (r.applied.length) parts.push(`got ${describe(r.applied)}`);
    if (r.pushed.length) parts.push(`sent ${describe(r.pushed)}`);
    const conflicts = r.conflicts.filter((c) => !c.firstSync);
    if (conflicts.length) parts.push(`${conflicts.length} conflict${conflicts.length > 1 ? 's' : ''}, kept the newer value`);
    if (r.failed.length) parts.push(`${r.failed.length} not applied (see panel)`);
    if (parts.length && (always || r.applied.length || conflicts.length || r.failed.length)) {
      toast(`Settings Sync: ${parts.join(' · ')}`, r.failed.length ? 'warn' : 'ok');
    } else if (always) {
      toast('Settings Sync: up to date', 'ok');
    }
  };

  // ---- windows ----

  const rendererSource = () =>
    fs.readFileSync(path.join(opts.root, 'src', 'renderer', 'panel.js'), 'utf8').replace('__VERSION__', opts.version);
  const isOrcaUi = (wc) => !wc.isDestroyed() && /\/renderer\/index\.html(?:[?#]|$)/.test(wc.getURL());
  const run = (wc, js) => wc.executeJavaScript(js, false).catch(() => undefined);
  const call = (wc, method, arg) => run(wc, `window.${KEY} && window.${KEY}.${method}(${JSON.stringify(arg ?? null)})`);
  const inject = (wc) => (isOrcaUi(wc) ? run(wc, rendererSource()) : Promise.resolve());
  const broadcast = (method, arg) => {
    for (const wc of attached.keys()) if (isOrcaUi(wc)) call(wc, method, arg);
  };
  const toast = (text, kind) => {
    const focused = BrowserWindow.getFocusedWindow();
    const targets = focused && attached.has(focused.webContents) ? [focused.webContents] : [...attached.keys()].filter(isOrcaUi).slice(0, 1);
    for (const wc of targets) call(wc, 'toast', { text, kind });
  };
  const targetWindow = () => {
    const focused = BrowserWindow.getFocusedWindow();
    return focused && attached.has(focused.webContents) ? focused.webContents : [...attached.keys()].find(isOrcaUi);
  };

  const onPanelMessage = async (wc, text) => {
    if (typeof text !== 'string' || !text.startsWith(CHANNEL)) return;
    let msg;
    try { msg = JSON.parse(text.slice(CHANNEL.length)); } catch { return; }
    try {
      switch (msg?.op) {
        case 'refresh': call(wc, 'update', status()); break;
        case 'config': applyConfig(msg.patch || {}); break;
        case 'sync': runSync('panel', { announceAlways: true }); break;
        case 'firstSync':
          engine.chooseFirstSync(msg.prefer);
          runSync(msg.prefer === 'local' ? 'first sync: upload this machine' : 'first sync: use repo settings', { announceAlways: true });
          break;
        case 'history': call(wc, 'showHistory', await engine.history(40)); break;
        case 'preview': call(wc, 'showPreview', await engine.previewRestore(String(msg.commit))); break;
        case 'restore': {
          const r = await engine.restore(String(msg.commit));
          log(`restore ${String(msg.commit).slice(0, 7)}: ${r.ok ? 'ok' : `error: ${r.error}`} restored=${r.restored.length} pushed=${r.pushed.length}`);
          toast(r.ok ? `Settings Sync: restored ${r.restored.length} item${r.restored.length === 1 ? '' : 's'} from ${String(msg.commit).slice(0, 7)}` : `Settings Sync: ${r.error}`, r.ok ? 'ok' : 'error');
          broadcast('update', status());
          break;
        }
        case 'openFolder': shell.openPath(dataDir); break;
        case 'openLog': shell.openPath(logFile); break;
        default: break;
      }
    } catch (err) {
      log(`panel ${msg?.op}: ${err.stack || err.message}`);
      toast(`Settings Sync: ${err.message}`, 'error');
    }
  };

  const attached = new Map();
  const attach = (win) => {
    const wc = win.webContents;
    if (attached.has(wc)) return;
    const onLoad = () => inject(wc);
    const onDestroyed = () => attached.delete(wc);
    const onConsole = (event, _level, message) => onPanelMessage(wc, typeof message === 'string' ? message : event?.message);
    wc.on('did-finish-load', onLoad);
    wc.once('destroyed', onDestroyed);
    wc.on('console-message', onConsole);
    attached.set(wc, { onLoad, onDestroyed, onConsole });
    if (!wc.isLoading()) onLoad();
  };
  const onWindowCreated = (_e, win) => attach(win);
  app.on('browser-window-created', onWindowCreated);
  for (const win of BrowserWindow.getAllWindows()) attach(win);

  // ---- timers and triggers ----

  let lastAutoSyncAt = 0;
  const autoSync = (reason) => {
    const cfg = engine.config();
    if (!cfg.autoSync || !cfg.repoUrl || engine.state().awaitingChoice) return;
    lastAutoSyncAt = Date.now();
    runSync(reason);
  };
  const onFocus = () => {
    if (Date.now() - Math.max(lastAutoSyncAt, engine.state().lastSync?.at ?? 0) > FOCUS_MIN_GAP_MS) autoSync('window focus');
  };
  app.on('browser-window-focus', onFocus);
  let interval = null;
  const schedule = () => {
    clearInterval(interval);
    interval = setInterval(() => autoSync('timer'), engine.config().intervalMinutes * 60_000);
    interval.unref?.();
  };
  schedule();
  watchFiles();
  const startTimer = setTimeout(() => autoSync('Orca started'), 3000);

  const applyConfig = (patch) => {
    const before = engine.config();
    const cfg = engine.setConfig(patch);
    if (cfg.intervalMinutes !== before.intervalMinutes) schedule();
    watchFiles();
    broadcast('update', status());
    const repoChanged = cfg.repoUrl !== before.repoUrl || cfg.branch !== before.branch;
    const includeAdded = Object.keys(cfg.include).some((k) => cfg.include[k] && !before.include[k]);
    if (cfg.repoUrl && (repoChanged || includeAdded || (cfg.autoSync && !before.autoSync))) runSync('settings changed', { announceAlways: repoChanged });
    return cfg;
  };

  let markerPath = null;
  const removeMarker = () => {
    if (markerPath) try { fs.unlinkSync(markerPath); } catch { /* already gone */ }
  };
  app.on('will-quit', removeMarker);

  function status(extra = {}) {
    const cfg = engine.config();
    const st = engine.state();
    return {
      installed: true, version: opts.version, pid: process.pid, dataDir, logFile,
      running: Boolean(engine.running), config: cfg, firstSync: st.firstSync,
      awaitingChoice: Boolean(st.awaitingChoice), remoteMachines: st.remoteMachines || {},
      lastSync: st.lastSync, lastSuccessAt: st.lastSuccessAt ?? null,
      pending: Object.keys(st.localStamps).length, retry: st.retry, windows: attached.size, host: os.hostname(),
      ...extra,
    };
  }

  const self = {
    version: opts.version,
    root: opts.root,
    engine,
    status,
    setMarker(p) { markerPath = p; },
    async command(name, args) {
      switch (name) {
        case 'status': return status();
        case 'sync': return runSync('command', { announceAlways: true });
        case 'settings': {
          const wc = targetWindow();
          if (wc) await call(wc, 'toggle', status());
          return status();
        }
        case 'config': return applyConfig(args || {});
        case 'choose': engine.chooseFirstSync(args?.prefer); return runSync(`first sync (${args?.prefer})`, { announceAlways: true });
        case 'history': return engine.history(args?.limit ?? 40);
        case 'preview': return engine.previewRestore(String(args?.commit));
        case 'restore': return engine.restore(String(args?.commit));
        case 'uninstall': self.dispose(); return { uninstalled: true };
        default: throw new Error(`unknown command: ${name}`);
      }
    },
    dispose() {
      clearTimeout(startTimer);
      clearTimeout(changeTimer);
      clearInterval(interval);
      app.removeListener('browser-window-focus', onFocus);
      app.removeListener('browser-window-created', onWindowCreated);
      app.removeListener('will-quit', removeMarker);
      for (const [file, fn] of watched) fs.unwatchFile(file, fn);
      watched.clear();
      if (handlers instanceof Map) {
        for (const [channel, wrapper] of wrapped) if (handlers.get(channel) === wrapper) handlers.set(channel, originals.get(channel));
      }
      for (const [wc, h] of attached) {
        if (wc.isDestroyed()) continue;
        wc.removeListener('did-finish-load', h.onLoad);
        wc.removeListener('destroyed', h.onDestroyed);
        wc.removeListener('console-message', h.onConsole);
        run(wc, `window.${KEY} && window.${KEY}.destroy()`);
      }
      attached.clear();
      removeMarker();
      if (globalThis[KEY] === self) delete globalThis[KEY];
    },
  };
  globalThis[KEY] = self;
  log(`installed ${opts.version} from ${opts.root} (pid ${process.pid})`);
  return self;
}

/** "3 settings, 1 keybinding, plugin khoa.dim-unfocused-panes" */
function describe(ids) {
  const counts = new Map();
  const plugins = new Set();
  for (const id of ids) {
    const [prefix, ...rest] = id.split('/');
    if (prefix.startsWith('plugin-')) { plugins.add(rest.join('/')); continue; }
    const label = { settings: 'setting', keybindings: 'keybinding', file: 'file', ui: 'UI preference' }[prefix] || prefix;
    counts.set(label, (counts.get(label) || 0) + 1);
  }
  const parts = [...counts].map(([label, n]) => `${n} ${label}${n === 1 ? '' : 's'}`);
  if (plugins.size) parts.push(plugins.size === 1 ? `plugin ${[...plugins][0]}` : `${plugins.size} plugins`);
  return parts.join(', ');
}

module.exports = { install, describe };
