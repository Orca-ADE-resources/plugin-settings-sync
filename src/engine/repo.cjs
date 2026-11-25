'use strict';
// The sync repo's files <-> items. Layout (all JSON sorted and pretty, so `git log -p` reads well):
//
//   settings.json            { "<setting>": value }
//   keybindings.json         same format as ~/.orca/keybindings.json
//   plugins.json             { "<pluginKey>": { "source": {...}, "enabled": true, "consent": "sha256-…" } }
//   dev-plugins/<pluginKey>/ files of plugins that run from a dev folder
//   files/<name>             extra userData files (e.g. dim-unfocused-panes.json)
//   ui.json                  { "<ui key>": value }
//   meta.json                { format, stamps: { "<item id>": { t, m } }, machines: { "<name>": lastSyncAt } }
const fs = require('node:fs');
const path = require('node:path');
const { readJson, writeJson, writeFileAtomic, mirrorTree, rmrf } = require('./util.cjs');
const { item, keybindingsToItems, itemsToKeybindingsFile, categoryOf } = require('./items.cjs');

const FORMAT = 1;
const SAFE_NAME = /^[A-Za-z0-9._-]+$/;

/** Reads the working tree of the sync repo. */
function readRepo(dir) {
  const items = new Map();
  const add = (i) => items.set(i.id, i);

  for (const [k, v] of Object.entries(readJson(path.join(dir, 'settings.json'), {}))) add(item(`settings/${k}`, v));
  for (const i of keybindingsToItems(readJson(path.join(dir, 'keybindings.json'), {}))) add(i);

  for (const [key, p] of Object.entries(readJson(path.join(dir, 'plugins.json'), {}))) {
    if (!SAFE_NAME.test(key) || !p || typeof p !== 'object') continue;
    if (p.source) {
      const i = item(`plugin-source/${key}`, p.source);
      if (p.source.kind === 'dev') i.dir = path.join(dir, 'dev-plugins', key);
      add(i);
    }
    if (typeof p.enabled === 'boolean') add(item(`plugin-enabled/${key}`, p.enabled));
    // { permissions, release } since 0.3; a bare Orca fingerprint (string) before
    if (typeof p.consent === 'string' || (p.consent && typeof p.consent === 'object')) add(item(`plugin-consent/${key}`, p.consent));
  }

  const filesDir = path.join(dir, 'files');
  for (const name of safeReaddir(filesDir)) {
    if (!SAFE_NAME.test(name)) continue;
    add(item(`file/${name}`, fs.readFileSync(path.join(filesDir, name), 'utf8')));
  }

  for (const [k, v] of Object.entries(readJson(path.join(dir, 'ui.json'), {}))) add(item(`ui/${k}`, v));

  const meta = readJson(path.join(dir, 'meta.json'), {});
  return {
    items,
    stamps: meta && typeof meta.stamps === 'object' && meta.stamps ? meta.stamps : {},
    machines: meta && typeof meta.machines === 'object' && meta.machines ? meta.machines : {},
    format: meta?.format ?? FORMAT,
  };
}

/**
 * Rewrites the repo working tree from `merged`. Dev plugin folders are copied only when the item
 * points somewhere other than the repo's own copy (i.e. this machine's version won).
 */
function writeRepo(dir, merged, { stamps, machines }) {
  const byCat = { settings: {}, keybindings: [], plugins: {}, files: new Map(), ui: {} };
  const devDirs = new Map();
  for (const i of merged.values()) {
    const [prefix, ...rest] = i.id.split('/');
    const key = rest.join('/');
    switch (categoryOf(i.id)) {
      case 'settings': byCat.settings[key] = i.value; break;
      case 'keybindings': byCat.keybindings.push(i); break;
      case 'plugins': {
        const p = (byCat.plugins[key] ??= {});
        if (prefix === 'plugin-source') {
          p.source = i.value;
          if (i.value?.kind === 'dev') devDirs.set(key, i.dir);
        } else if (prefix === 'plugin-enabled') p.enabled = i.value;
        else if (prefix === 'plugin-consent') p.consent = i.value;
        break;
      }
      case 'files': byCat.files.set(key, i.value); break;
      case 'ui': byCat.ui[key] = i.value; break;
      default: break;
    }
  }

  writeJson(path.join(dir, 'settings.json'), byCat.settings);
  writeJson(path.join(dir, 'keybindings.json'), itemsToKeybindingsFile(byCat.keybindings));
  writeJson(path.join(dir, 'plugins.json'), byCat.plugins);
  writeJson(path.join(dir, 'ui.json'), byCat.ui);
  writeJson(path.join(dir, 'meta.json'), { format: FORMAT, stamps, machines });
  writeFileAtomic(path.join(dir, '.gitattributes'), '* -text\n');
  if (!fs.existsSync(path.join(dir, 'README.md'))) {
    writeFileAtomic(path.join(dir, 'README.md'),
      '# Orca settings\n\nWritten by the Orca **Settings Sync** plugin. Do not edit by hand: each machine rewrites these files.\n');
  }

  const devRoot = path.join(dir, 'dev-plugins');
  for (const name of safeReaddir(devRoot)) if (!devDirs.has(name)) rmrf(path.join(devRoot, name));
  for (const [key, src] of devDirs) {
    const dest = path.join(devRoot, key);
    if (src && path.resolve(src) !== path.resolve(dest)) mirrorTree(src, dest);
  }

  const filesDir = path.join(dir, 'files');
  for (const name of safeReaddir(filesDir)) if (!byCat.files.has(name)) rmrf(path.join(filesDir, name));
  for (const [name, text] of byCat.files) {
    if (SAFE_NAME.test(name)) writeFileAtomic(path.join(filesDir, name), text);
  }
}

function safeReaddir(dir) {
  try {
    return fs.readdirSync(dir).sort();
  } catch {
    return [];
  }
}

module.exports = { readRepo, writeRepo, FORMAT, SAFE_NAME };
