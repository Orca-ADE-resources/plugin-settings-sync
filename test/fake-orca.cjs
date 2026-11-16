'use strict';
// An in-memory Orca with the same `ops` surface as src/engine/orca-ops.cjs, so the tests can run
// the real adapter + sync engine for two "machines" against one bare git repo.
const fs = require('node:fs');
const path = require('node:path');

// Pretend plugin registry for git installs: url -> { pluginKey, fingerprint }
const GIT_REGISTRY = {
  'https://example.com/acme/word-count.git': { pluginKey: 'acme.word-count', fingerprint: 'sha256-wordcount-v1' },
};

/**
 * @param {object} o
 * @param {string} o.home  folder for this machine's files (userData, dev plugin folders)
 * @param {object} o.settings
 * @param {object} [o.keybindings]
 * @param {object} [o.lock]      plugins.lock.json `plugins`
 * @param {object} [o.files]     userData files
 * @param {object} [o.ui]
 */
function createFakeOrca({ home, settings, keybindings, lock, files, ui }) {
  const state = {
    settings: structuredClone(settings),
    keybindings: keybindings ? structuredClone(keybindings) : undefined,
    lock: structuredClone(lock || {}),
    files: new Map(Object.entries(files || {})),
    ui: structuredClone(ui || {}),
    calls: [],
  };
  fs.mkdirSync(home, { recursive: true });

  const manifestOf = (dir) => {
    try {
      return JSON.parse(fs.readFileSync(path.join(dir, 'orca-plugin.json'), 'utf8'));
    } catch {
      return null;
    }
  };

  const ops = {
    async getSettings() { return structuredClone(state.settings); },
    async setSettings(patch) {
      state.calls.push(['setSettings', Object.keys(patch)]);
      const p = { ...patch };
      delete p.pluginConsents; // like Orca's settings:set
      delete p.disabledPlugins;
      if (typeof p.terminalFontSize === 'number') p.terminalFontSize = Math.min(32, Math.max(8, p.terminalFontSize)); // Orca-style clamp
      Object.assign(state.settings, structuredClone(p));
    },
    async readKeybindings() { return { path: path.join(home, 'keybindings.json'), file: structuredClone(state.keybindings) }; },
    async writeKeybindings(file) { state.calls.push(['writeKeybindings']); state.keybindings = structuredClone(file); },
    readLock() { return structuredClone(state.lock); },
    readManifest: (dir) => {
      const m = manifestOf(dir);
      return m ? { publisher: m.publisher, id: m.id } : null;
    },
    async listPlugins() {
      const out = [];
      for (const [key, entry] of Object.entries(state.lock)) out.push({ pluginKey: key, consentFingerprint: entry.fingerprint });
      for (const dir of state.settings.devPluginPaths || []) {
        const m = manifestOf(dir);
        if (m) out.push({ pluginKey: `${m.publisher}.${m.id}`, consentFingerprint: m.fakeFingerprint });
      }
      return out;
    },
    async consent(pluginKey, fingerprint) {
      const p = (await ops.listPlugins()).find((x) => x.pluginKey === pluginKey);
      if (!p) throw new Error(`cannot record consent for unknown plugin ${pluginKey}`);
      if (p.consentFingerprint !== fingerprint) throw new Error(`plugin ${pluginKey} changed since its permissions were reviewed`);
      state.settings.pluginConsents = { ...(state.settings.pluginConsents || {}), [pluginKey]: fingerprint };
      state.settings.disabledPlugins = (state.settings.disabledPlugins || []).filter((k) => k !== pluginKey);
    },
    async setEnabled(pluginKey, enabled) {
      if (!(await ops.listPlugins()).some((x) => x.pluginKey === pluginKey)) throw new Error(`cannot change enablement for unknown plugin ${pluginKey}`);
      const off = new Set(state.settings.disabledPlugins || []);
      if (enabled) off.delete(pluginKey); else off.add(pluginKey);
      state.settings.disabledPlugins = [...off];
    },
    async refreshPlugins() {},
    async installGit({ url, ref }) {
      const reg = GIT_REGISTRY[url];
      if (!reg) return { ok: false, error: `could not clone ${url}` };
      state.lock[reg.pluginKey] = { pluginKey: reg.pluginKey, source: { kind: 'git', url, ref }, fingerprint: reg.fingerprint };
      return { ok: true };
    },
    async installMarketplace() { return { ok: false, error: 'not in fake' }; },
    async removePlugin(pluginKey) { delete state.lock[pluginKey]; },
    readUserFile(name) { return state.files.get(name); },
    writeUserFile(name, text) { if (text === undefined) state.files.delete(name); else state.files.set(name, text); },
    async getUi() { return structuredClone(state.ui); },
    async setUi(patch) { Object.assign(state.ui, structuredClone(patch)); },
  };
  return { ops, state };
}

/** Writes a small dev plugin folder. */
function writeDevPlugin(dir, { publisher = 'khoa', id, fingerprint, body = 'export default function activate() {}\n' }) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'orca-plugin.json'), JSON.stringify({ publisher, id, fakeFingerprint: fingerprint }, null, 2));
  fs.writeFileSync(path.join(dir, 'worker.mjs'), body);
  fs.mkdirSync(path.join(dir, 'node_modules', 'x'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'node_modules', 'x', 'big.js'), '// must not be synced\n');
  fs.writeFileSync(path.join(dir, '.env'), 'TOKEN=secret\n');
}

module.exports = { createFakeOrca, writeDevPlugin, GIT_REGISTRY };
