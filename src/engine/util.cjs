'use strict';
// Small helpers shared by the sync engine. Plain CommonJS with no dependencies, so the same files
// load inside Orca's main process (via require) and in the Node tests.
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

/** JSON with object keys sorted at every level, so equal values always give equal text. */
function stableStringify(value, indent) {
  return JSON.stringify(sortKeys(value), null, indent);
}

function sortKeys(value) {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object') {
    const out = {};
    for (const k of Object.keys(value).sort()) if (value[k] !== undefined) out[k] = sortKeys(value[k]);
    return out;
  }
  return value;
}

function sha1(text) {
  return crypto.createHash('sha1').update(text).digest('hex');
}

/** Hash of a JSON value; `undefined` (item absent) stays undefined. */
function hashValue(value) {
  return value === undefined ? undefined : sha1(stableStringify(value));
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

/** Writes through a temp file so a crash never leaves half a JSON file behind. */
function writeFileAtomic(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
}

function writeJson(file, value) {
  writeFileAtomic(file, stableStringify(value, 2) + '\n');
}

// ---- plugin folders ----

// Never copied: VCS data, dependencies, secrets, logs, OS junk.
const EXCLUDED_NAMES = new Set(['.git', 'node_modules', '.DS_Store', 'Thumbs.db', '.vs', '.idea']);
const EXCLUDED_PATTERNS = [/^\.env(\..*)?$/i, /\.log$/i, /\.(pem|key|p12|pfx)$/i];
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_TREE_BYTES = 20 * 1024 * 1024;

function isExcluded(name) {
  return EXCLUDED_NAMES.has(name) || EXCLUDED_PATTERNS.some((re) => re.test(name));
}

/** Lists files of a plugin folder as sorted posix relative paths, skipping excluded and huge files. */
function listTree(root) {
  const files = [];
  let total = 0;
  const walk = (dir, rel) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
      if (isExcluded(e.name)) continue;
      const abs = path.join(dir, e.name);
      const relPath = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(abs, relPath);
      else if (e.isFile()) {
        const size = fs.statSync(abs).size;
        if (size > MAX_FILE_BYTES || total + size > MAX_TREE_BYTES) continue;
        total += size;
        files.push(relPath);
      }
    }
  };
  walk(root, '');
  return files;
}

/** Content hash of a plugin folder (paths + bytes), or undefined when it has no files. */
function hashTree(root) {
  const files = listTree(root);
  if (files.length === 0) return undefined;
  const h = crypto.createHash('sha1');
  for (const rel of files) {
    h.update(rel);
    h.update('\0');
    h.update(crypto.createHash('sha1').update(fs.readFileSync(path.join(root, rel))).digest('hex'));
    h.update('\n');
  }
  return h.digest('hex');
}

/** Makes `dest` an exact copy of the plugin files in `src` (same exclusions as hashTree). */
function mirrorTree(src, dest) {
  const files = listTree(src);
  rmrf(dest);
  for (const rel of files) {
    const to = path.join(dest, ...rel.split('/'));
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(path.join(src, ...rel.split('/')), to);
  }
}

function rmrf(target) {
  fs.rmSync(target, { recursive: true, force: true, maxRetries: 3 });
}

/** True when `child` is `parent` or inside it (case-insensitive on Windows). */
function isInside(child, parent) {
  const norm = (p) => {
    const r = path.resolve(p);
    return process.platform === 'win32' ? r.toLowerCase() : r;
  };
  const rel = path.relative(norm(parent), norm(child));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

module.exports = {
  stableStringify, sortKeys, sha1, hashValue, readJson, writeJson, writeFileAtomic,
  listTree, hashTree, mirrorTree, rmrf, isInside, isExcluded,
};
