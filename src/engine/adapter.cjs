'use strict';
// Orca state <-> sync items. All Orca access goes through `ops` (see orca-ops.cjs for the real
// one, test/fake-orca.cjs for the test one), so the rules here are exercised by the tests too.
//
// ops:
//   getSettings() / setSettings(patch)
//   readKeybindings() -> { path, file }      writeKeybindings(file)   (writes + reloads)
//   readLock() -> { [pluginKey]: lockEntry }
//   readManifest(dir) -> manifest | null      readInstalledManifest(pluginKey) -> manifest | null  (git/marketplace/bundled)
//   listPlugins() -> [{ pluginKey, consentFingerprint }]
//   consent(pluginKey, fingerprint)  setEnabled(pluginKey, enabled)  refreshPlugins()
//   installGit({ url, ref }) -> { ok, error }   installMarketplace(source) -> { ok, error }   removePlugin(pluginKey)
//   readUserFile(name) -> string | undefined   writeUserFile(name, text | undefined)
//   getUi() / setUi(patch)
const path = require('node:path');
const {
  settingsToItems, settingsPatch, keybindingsToItems, applyKeybindingChanges, pluginItems, pluginKeyOf, approvalValue,
  uiToItems, toMap, item,
} = require('./items.cjs');
const { hashTree, mirrorTree, rmrf, isInside, stableStringify } = require('./util.cjs');

/**
 * @param {object} ops
 * @param {{ managedDevRoot: string, log?: (msg: string) => void, afterFileWrite?: (name: string, text: string | undefined) => void }} o
 */
function createAdapter(ops, { managedDevRoot, log = () => {}, afterFileWrite = () => {} }) {
  async function devPlugins(settings) {
    const out = [];
    const seen = new Set();
    for (const dir of Array.isArray(settings.devPluginPaths) ? settings.devPluginPaths : []) {
      const manifest = ops.readManifest(dir);
      const pluginKey = pluginKeyOf(manifest);
      if (!pluginKey || seen.has(pluginKey)) continue;
      seen.add(pluginKey);
      out.push({ pluginKey, dir, manifest, hash: hashTree(dir), own: !isInside(dir, managedDevRoot) });
    }
    return out;
  }

  /** The manifest of the copy installed here and, for git/marketplace/bundled plugins, its release. */
  function installedCopy(pluginKey, lock, dev) {
    const d = dev.find((x) => x.pluginKey === pluginKey);
    if (d) return { manifest: d.manifest, release: null };
    const manifest = ops.readInstalledManifest(pluginKey);
    if (!manifest) return null;
    return { manifest, release: lock[pluginKey]?.resolvedCommit || lock[pluginKey]?.contentHash || null };
  }

  /**
   * Plugins approved for the copy installed now. An approval Orca asks for again only because the
   * plugin's files changed (Orca 1.4.269 binds the approval of a dev plugin that adds shortcuts to
   * its files) still counts when the copy asks for exactly what was approved at the last sync; a
   * copy this engine keeps up to date (managed dev folder) is then approved again right away.
   * @param {Record<string, string>} lastLocal  item hashes at the end of the last sync
   */
  async function approvals(settings, lock, dev, lastLocal) {
    const consents = settings.pluginConsents || {};
    let listed;
    try {
      listed = await ops.listPlugins();
    } catch {
      return [];
    }
    const out = [];
    for (const p of listed) {
      const key = p.pluginKey;
      if (!consents[key]) continue;
      const copy = installedCopy(key, lock, dev);
      if (!copy) continue;
      const value = approvalValue(copy.manifest, copy.release);
      if (consents[key] !== p.consentFingerprint) {
        const id = `plugin-consent/${key}`;
        if (item(id, value).h !== lastLocal[id]) continue; // asks for something not approved yet
        const d = dev.find((x) => x.pluginKey === key);
        if (d && !d.own) {
          try {
            await ops.consent(key, p.consentFingerprint);
            log(`approved the updated copy of ${key} (same permissions as before)`);
          } catch (err) {
            log(`could not approve the updated copy of ${key}: ${err.message}`);
          }
        }
      }
      out.push({ pluginKey: key, value });
    }
    return out;
  }

  /** @param {{ lastLocal?: Record<string, string> }} [o] */
  async function readLocal(cfg, { lastLocal = {} } = {}) {
    const items = [];
    const settings = await ops.getSettings();
    if (cfg.include.settings) items.push(...settingsToItems(settings, cfg.excludeSettings));
    if (cfg.include.keybindings) items.push(...keybindingsToItems((await ops.readKeybindings()).file));
    if (cfg.include.plugins) {
      const lock = ops.readLock();
      const dev = await devPlugins(settings);
      items.push(...pluginItems({ disabled: settings.disabledPlugins, lock, dev, approvals: await approvals(settings, lock, dev, lastLocal) }));
    }
    if (cfg.include.files) {
      for (const name of cfg.extraFiles) {
        const text = ops.readUserFile(name);
        if (typeof text === 'string') items.push(item(`file/${name}`, text));
      }
    }
    if (cfg.include.ui) items.push(...uiToItems(await ops.getUi()));
    return toMap(items);
  }

  /**
   * @param {Array<{ id: string, item: { value: any, dir?: string } | undefined }>} changes  undefined item = delete
   */
  async function apply(changes) {
    const failed = new Map();
    const skipped = new Set();
    const fail = (id, err, retry = false) => {
      const message = err instanceof Error ? err.message : String(err);
      failed.set(id, { message, retry });
      log(`apply ${id} failed: ${message}`);
    };
    // Not something the user has to act on (e.g. the plugin is not installed here): retry quietly.
    const wait = (id, message, retry = true) => {
      failed.set(id, { message, retry, quiet: true });
      log(`apply ${id} waits: ${message}`);
    };
    let listCache = null;
    const listed = async () => (listCache ??= await ops.listPlugins());
    const group = (prefix) => changes.filter((c) => c.id.startsWith(`${prefix}/`));
    const keyOf = (c) => c.id.slice(c.id.indexOf('/') + 1);

    // Settings: one settings:set, so Orca updates every window once.
    const settingChanges = group('settings');
    if (settingChanges.length) {
      try {
        const current = await ops.getSettings();
        const patch = settingsPatch(settingChanges.map((c) => ({ key: keyOf(c), value: c.item?.value })), current);
        for (const c of settingChanges) if (c.item === undefined) skipped.add(c.id);
        if (Object.keys(patch).length) await ops.setSettings(patch);
      } catch (err) {
        for (const c of settingChanges) fail(c.id, err);
      }
    }

    // Keybindings: rewrite ~/.orca/keybindings.json and let Orca reload it.
    const kbChanges = group('keybindings');
    if (kbChanges.length) {
      try {
        const { file } = await ops.readKeybindings();
        await ops.writeKeybindings(applyKeybindingChanges(file, kbChanges.map((c) => ({ id: c.id, value: c.item?.value }))));
      } catch (err) {
        for (const c of kbChanges) fail(c.id, err);
      }
    }

    // Extra files in userData.
    for (const c of group('file')) {
      try {
        const name = keyOf(c);
        ops.writeUserFile(name, c.item?.value);
        afterFileWrite(name, c.item?.value);
      } catch (err) {
        fail(c.id, err);
      }
    }

    // Plugin sources: dev folders are copied under managedDevRoot and added as dev plugin paths;
    // git and marketplace plugins are installed the way Orca's Plugins page would.
    const sourceChanges = group('plugin-source');
    if (sourceChanges.length) {
      const settings = await ops.getSettings();
      const dev = new Map((await devPlugins(settings)).map((d) => [d.pluginKey, d]));
      const lock = ops.readLock();
      let devPaths = Array.isArray(settings.devPluginPaths) ? [...settings.devPluginPaths] : [];
      let devPathsChanged = false;
      for (const c of sourceChanges) {
        const key = keyOf(c);
        const want = c.item?.value;
        const localDev = dev.get(key);
        try {
          if (localDev?.own) {
            skipped.add(c.id); // this machine runs the plugin from its own source folder: never overwrite it
          } else if (want?.kind === 'dev') {
            if (!c.item.dir) throw new Error('plugin files missing from the sync repo');
            const target = path.join(managedDevRoot, key);
            mirrorTree(c.item.dir, target);
            if (!devPaths.some((p) => path.resolve(p) === path.resolve(target))) {
              devPaths.push(target);
              devPathsChanged = true;
            }
          } else if (want === undefined && localDev) {
            devPaths = devPaths.filter((p) => path.resolve(p) !== path.resolve(localDev.dir));
            devPathsChanged = true;
            rmrf(localDev.dir);
          } else if (want?.kind === 'git') {
            const res = await ops.installGit({ url: want.url, ref: want.ref });
            if (!res?.ok) throw new Error(res?.error || 'git install failed');
          } else if (want?.kind === 'marketplace') {
            const res = await ops.installMarketplace(want, key);
            if (!res?.ok) throw new Error(res?.error || 'marketplace install failed');
          } else if (want === undefined && lock[key] && lock[key].source?.kind !== 'bundled') {
            await ops.removePlugin(key);
          } else {
            skipped.add(c.id);
          }
        } catch (err) {
          fail(c.id, err, true);
        }
      }
      if (devPathsChanged) await ops.setSettings({ devPluginPaths: devPaths });
      await ops.refreshPlugins();
    }

    // Approvals: approve this machine's copy (with its own fingerprint) when it asks for exactly
    // what was approved on the other machine. See approvalValue() in items.cjs.
    const consentChanges = group('plugin-consent');
    if (consentChanges.length) {
      const list = await listed();
      const settings = await ops.getSettings();
      const lock = ops.readLock();
      const dev = await devPlugins(settings);
      for (const c of consentChanges) {
        const key = keyOf(c);
        try {
          if (c.item === undefined) { skipped.add(c.id); continue; } // Orca has no "revoke"; keep this machine's choice
          const p = list.find((x) => x.pluginKey === key);
          if (!p) { wait(c.id, 'plugin not installed here yet'); continue; }
          if (settings.pluginConsents?.[key] === p.consentFingerprint) { skipped.add(c.id); continue; } // approved here already
          const want = c.item.value;
          if (typeof want === 'string') {
            // Written by Settings Sync 0.2: an Orca fingerprint, only valid for the same Orca version and folder.
            if (want === p.consentFingerprint) await ops.consent(key, p.consentFingerprint);
            else wait(c.id, 'approved by an older Settings Sync; waits for that machine to sync again', false);
            continue;
          }
          const copy = installedCopy(key, lock, dev);
          if (!copy) { wait(c.id, 'cannot read the manifest of the copy installed here'); continue; }
          const mine = approvalValue(copy.manifest, copy.release);
          if (stableStringify(mine.permissions) !== stableStringify(want?.permissions)) {
            throw new Error('this copy asks for different permissions than the one approved on your other machine; review it in Settings → Plugins');
          }
          if (want.release && mine.release !== want.release) {
            throw new Error('this copy is a different release than the one approved on your other machine; review it in Settings → Plugins');
          }
          await ops.consent(key, p.consentFingerprint);
        } catch (err) {
          fail(c.id, err, true);
        }
      }
    }

    const enabledChanges = group('plugin-enabled');
    if (enabledChanges.length) {
      const list = await listed();
      for (const c of enabledChanges) {
        try {
          if (c.item === undefined) { skipped.add(c.id); continue; }
          if (!list.some((x) => x.pluginKey === keyOf(c))) { wait(c.id, 'plugin not installed here yet'); continue; }
          await ops.setEnabled(keyOf(c), Boolean(c.item.value));
        } catch (err) {
          fail(c.id, err, true);
        }
      }
    }

    const uiChanges = group('ui');
    if (uiChanges.length) {
      try {
        const patch = {};
        for (const c of uiChanges) if (c.item !== undefined) patch[keyOf(c)] = c.item.value; else skipped.add(c.id);
        if (Object.keys(patch).length) await ops.setUi(patch);
      } catch (err) {
        for (const c of uiChanges) fail(c.id, err);
      }
    }

    return { failed, skipped };
  }

  return { readLocal, apply };
}

module.exports = { createAdapter };
