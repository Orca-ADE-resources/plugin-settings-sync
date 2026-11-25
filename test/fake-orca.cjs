'use strict';
// An in-memory Orca with the same `ops` surface as src/engine/orca-ops.cjs, so the tests can run
// the real adapter + sync engine for two "machines" against one bare git repo.
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { hashTree } = require('../src/engine/util.cjs');

const WORD_COUNT = { publisher: 'acme', id: 'word-count', main: 'worker.mjs', capabilities: [{ kind: 'workspace:read' }] };
// Pretend plugin registry for git installs: url -> { pluginKey, refs: { ref -> { commit, contentHash, manifest } } }
const GIT_REGISTRY = {
  'https://example.com/acme/word-count.git': {
    pluginKey: 'acme.word-count',
    refs: {
      'v1.0.0': { commit: 'c0ffee1', contentHash: 'wc-v1', manifest: WORD_COUNT },
      main: { commit: 'c0ffee1', contentHash: 'wc-v1', manifest: WORD_COUNT },
    },
  },
};

// Like Orca 1.4.269: the approval fingerprint covers what the plugin asks for, normalised the way
// this Orca version does it, plus where it comes from (the folder for a dev plugin, the content
// hash for an installed one). So the same plugin has another fingerprint on another machine.
function fakeFingerprint(orcaVersion, manifest, where) {
  const what = JSON.stringify({ caps: manifest?.capabilities || [], main: manifest?.main || null, orcaVersion, where });
  return `sha256-${crypto.createHash('sha256').update(what).digest('base64url').slice(0, 12)}`;
}

/**
 * @param {object} o
 * @param {string} o.home  folder for this machine's files (userData, dev plugin folders)
 * @param {object} o.settings
 * @param {object} [o.keybindings]
 * @param {object} [o.lock]      plugins.lock.json `plugins`
 * @param {object} [o.files]     userData files
 * @param {object} [o.ui]
 */
function createFakeOrca({ home, settings, keybindings, lock, files, ui, orcaVersion = '1.4.222' }) {
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
    readManifest: (dir) => manifestOf(dir),
    // The fake keeps an installed plugin's manifest in its lock entry (real Orca: plugins/<key>/<hash>/).
    readInstalledManifest: (pluginKey) => structuredClone(state.lock[pluginKey]?.manifest ?? null),
    async listPlugins() {
      const out = [];
      for (const [key, entry] of Object.entries(state.lock)) {
        out.push({ pluginKey: key, consentFingerprint: fakeFingerprint(orcaVersion, entry.manifest, entry.contentHash) });
      }
      for (const dir of state.settings.devPluginPaths || []) {
        const m = manifestOf(dir);
        const key = m ? `${m.publisher || 'local'}.${m.id}` : null;
        if (key && !out.some((x) => x.pluginKey === key)) {
          // Orca 1.4.269: a dev plugin that adds shortcuts is approved for its files as they are now
          const files = m.contributes?.keybindings?.length ? hashTree(dir) : '';
          out.push({ pluginKey: key, consentFingerprint: fakeFingerprint(orcaVersion, m, `dev-folder:${path.resolve(dir)}\0${files}`) });
        }
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
      const rel = GIT_REGISTRY[url]?.refs[ref];
      if (!rel) return { ok: false, error: `could not clone ${url}` };
      state.lock[GIT_REGISTRY[url].pluginKey] = {
        pluginKey: GIT_REGISTRY[url].pluginKey, source: { kind: 'git', url, ref },
        resolvedCommit: rel.commit, contentHash: rel.contentHash, manifest: structuredClone(rel.manifest),
      };
      return { ok: true };
    },
    async installMarketplace() { return { ok: false, error: 'not in fake' }; },
    async removePlugin(pluginKey) { delete state.lock[pluginKey]; },
    readUserFile(name) { return state.files.get(name); },
    writeUserFile(name, text) { if (text === undefined) state.files.delete(name); else state.files.set(name, text); },
    async getUi() { return structuredClone(state.ui); },
    async setUi(patch) { Object.assign(state.ui, structuredClone(patch)); },
  };
  /** This machine's fingerprint for a plugin, as Orca would show it (undefined: not installed). */
  async function fingerprintOf(pluginKey) {
    return (await ops.listPlugins()).find((p) => p.pluginKey === pluginKey)?.consentFingerprint;
  }
  /** Approves a plugin the way the Plugins page does. */
  async function approve(pluginKey) {
    await ops.consent(pluginKey, await fingerprintOf(pluginKey));
  }
  return { ops, state, fingerprintOf, approve };
}

/** Writes a small dev plugin folder. `publisher: null` leaves it out (manifest v2: Orca names it local.<id>). */
function writeDevPlugin(dir, { publisher = 'khoa', id, capabilities = [{ kind: 'events:subscribe' }], contributes, body = 'export default function activate() {}\n' }) {
  fs.mkdirSync(dir, { recursive: true });
  const manifest = { ...(publisher ? { publisher } : {}), id, main: 'worker.mjs', capabilities, ...(contributes ? { contributes } : {}) };
  fs.writeFileSync(path.join(dir, 'orca-plugin.json'), JSON.stringify(manifest, null, 2));
  fs.writeFileSync(path.join(dir, 'worker.mjs'), body);
  fs.mkdirSync(path.join(dir, 'node_modules', 'x'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'node_modules', 'x', 'big.js'), '// must not be synced\n');
  fs.writeFileSync(path.join(dir, '.env'), 'TOKEN=secret\n');
}

module.exports = { createFakeOrca, writeDevPlugin, GIT_REGISTRY };
