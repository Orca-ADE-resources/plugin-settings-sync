'use strict';
// The real `ops` for adapter.cjs, inside Orca's main process. Settings, keybindings, plugins and UI
// state go through Orca's own IPC handlers (the same code the Settings page calls), so Orca
// validates, saves and refreshes every window as usual. We call the handlers directly from the
// main process with a sender id no window has (-1), so Orca broadcasts the change to all windows.
const fs = require('node:fs');
const path = require('node:path');
const { readJson, writeFileAtomic } = require('./util.cjs');

const FAKE_EVENT = Object.freeze({ sender: Object.freeze({ id: -1 }) });

/**
 * @param {object} o
 * @param {import('electron').IpcMain} o.ipcMain
 * @param {string} o.userData       Orca's userData folder
 * @param {Map<string, Function>} o.originals  handlers we wrapped (call these, not the wrappers)
 * @param {typeof import('electron').BrowserWindow} [o.BrowserWindow]
 */
function createOrcaOps({ ipcMain, userData, originals, BrowserWindow }) {
  const invoke = async (channel, ...args) => {
    const handler = originals.get(channel) || ipcMain._invokeHandlers?.get(channel);
    if (typeof handler !== 'function') throw new Error(`this Orca version has no "${channel}" handler`);
    return handler(FAKE_EVENT, ...args);
  };

  let keybindingsPath = null;
  const kbPath = async () => {
    if (!keybindingsPath) keybindingsPath = (await invoke('keybindings:get'))?.path;
    if (!keybindingsPath) throw new Error('Orca did not report where keybindings.json is');
    return keybindingsPath;
  };

  const userFile = (name) => {
    if (!/^[A-Za-z0-9._-]+$/.test(name)) throw new Error(`unsafe file name ${name}`);
    return path.join(userData, name);
  };

  return {
    invoke,
    keybindingsPath: kbPath,

    getSettings: () => invoke('settings:get'),
    setSettings: (patch) => invoke('settings:set', patch),

    async readKeybindings() {
      const file = await kbPath();
      let text;
      try {
        text = fs.readFileSync(file, 'utf8');
      } catch {
        return { path: file, file: { version: 1, keybindings: {}, platforms: {} } };
      }
      try {
        return { path: file, file: JSON.parse(text) };
      } catch (err) {
        // Never treat a half-edited file as "all keybindings removed".
        throw new Error(`${file} is not valid JSON (${err.message}); fix it or turn off keybindings sync`);
      }
    },
    async writeKeybindings(fileObj) {
      writeFileAtomic(await kbPath(), JSON.stringify(fileObj, null, 2) + '\n');
      await invoke('keybindings:reload');
    },

    readLock: () => readJson(path.join(userData, 'plugins', 'plugins.lock.json'), {})?.plugins || {},
    readManifest(dir) {
      const m = readJson(path.join(dir, 'orca-plugin.json'), null);
      return m && typeof m.publisher === 'string' && typeof m.id === 'string' ? { publisher: m.publisher, id: m.id } : null;
    },
    listPlugins: () => invoke('plugins:list'),
    consent: (pluginKey, fingerprint) => invoke('plugins:consent', { pluginKey, reviewedFingerprint: fingerprint, decision: 'approve' }),
    setEnabled: (pluginKey, enabled) => invoke('plugins:setEnabled', { pluginKey, enabled }),
    refreshPlugins: () => invoke('plugins:refresh'),
    removePlugin: (pluginKey) => invoke('plugins:remove', { pluginKey }),

    async installGit({ url, ref }) {
      const res = await invoke('plugins:install', { kind: 'git', url, ref: ref || '' });
      return res?.ok ? { ok: true } : { ok: false, error: res?.error || res?.message || 'install failed' };
    },

    // Marketplace plugins: find (or add) the marketplace by its git URL, then install like the
    // Plugins page does (preview gives the commits to pin).
    async installMarketplace(want, pluginKey) {
      let sources = await invoke('plugins:listMarketplaces');
      let source = sources.find((s) => sameGitUrl(s.source?.url, want.marketplace.url));
      if (!source) {
        await invoke('plugins:addMarketplace', { kind: 'git', url: want.marketplace.url, ref: want.marketplace.ref || 'main' });
        sources = await invoke('plugins:listMarketplaces');
        source = sources.find((s) => sameGitUrl(s.source?.url, want.marketplace.url));
        if (!source) return { ok: false, error: `could not add marketplace ${want.marketplace.url}` };
      }
      // [{ marketplaceSourceId, pluginKey, marketplaceCommit, source: { url, ref } }]
      const listed = await invoke('plugins:listMarketplacePlugins');
      const entry = (Array.isArray(listed) ? listed : []).find((p) => p.marketplaceSourceId === source.id && p.pluginKey === pluginKey);
      if (!entry) return { ok: false, error: `${pluginKey} is not in marketplace ${want.marketplace.url}` };
      // Preview resolves the plugin's commit (and checks it), as the Plugins page does before installing.
      const preview = await invoke('plugins:previewMarketplacePlugin', { marketplaceSourceId: source.id, pluginKey });
      if (!preview?.marketplaceCommit || !preview?.resolvedCommit) return { ok: false, error: preview?.error || 'marketplace preview failed' };
      const res = await invoke('plugins:installMarketplacePlugin', {
        marketplaceSourceId: source.id, pluginKey, marketplaceCommit: preview.marketplaceCommit, resolvedCommit: preview.resolvedCommit,
      });
      return res?.ok ? { ok: true } : { ok: false, error: res?.error || 'install failed' };
    },

    readUserFile(name) {
      try {
        return fs.readFileSync(userFile(name), 'utf8');
      } catch {
        return undefined;
      }
    },
    writeUserFile(name, text) {
      if (text === undefined) fs.rmSync(userFile(name), { force: true });
      else writeFileAtomic(userFile(name), text);
    },

    getUi: () => invoke('ui:get'),
    // Windows keep their own copy of the UI state and take updates from `ui:stateChanged` (what
    // Orca sends between its own windows), so send that after saving.
    async setUi(patch) {
      await invoke('ui:set', patch);
      const ui = await invoke('ui:get');
      for (const win of BrowserWindow?.getAllWindows?.() ?? []) {
        if (!win.isDestroyed()) win.webContents.send('ui:stateChanged', ui);
      }
    },
  };
}

function sameGitUrl(a, b) {
  const norm = (u) => String(u || '').trim().toLowerCase().replace(/\.git$/, '').replace(/\/+$/, '');
  return Boolean(a) && norm(a) === norm(b);
}

module.exports = { createOrcaOps, FAKE_EVENT };
