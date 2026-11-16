// Loads (or upgrades) the sync engine into Orca's main process and runs a command there.
// The engine files stay in the plugin folder; the main process `require`s them by absolute path.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { evaluateInOrca } from './inspector.mjs';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function readVersion() {
  return JSON.parse(fs.readFileSync(path.join(ROOT, 'orca-plugin.json'), 'utf8')).version;
}

// ---- marker: "this Orca process already runs this version", so workers skip the inspector ----

export function markerPathFor(pid) {
  return path.join(os.tmpdir(), 'orca-settings-sync', `${pid}.json`);
}

export function isMarked(pid, version) {
  try {
    const m = JSON.parse(fs.readFileSync(markerPathFor(pid), 'utf8'));
    return m.pid === pid && m.version === version && m.root === ROOT;
  } catch {
    return false;
  }
}

export function writeMarker(pid, version) {
  const file = markerPathFor(pid);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ pid, version, root: ROOT, at: new Date().toISOString() }));
}

/**
 * @param {{ pid: number, command?: string, args?: object, force?: boolean, dataDir?: string, wait?: boolean }} o
 * @returns {Promise<object>} status or the command's result
 */
export async function runInOrca({ pid, command, args, force = false, dataDir, wait = false }) {
  const version = readVersion();
  const opts = { version, root: ROOT, command, args, force, dataDir, wait, markerPath: markerPathFor(pid) };
  const result = await evaluateInOrca(pid, `(${bootstrap.toString()})(${JSON.stringify(opts)})`);
  if (command !== 'uninstall' && !dataDir) writeMarker(pid, version); // a test data folder is not "installed"
  return result;
}

// Evaluated inside Orca's main process: self-contained, no outside references.
function bootstrap(opts) {
  const KEY = '__orcaSettingsSync';
  const Module = process.getBuiltinModule('node:module');
  const path = process.getBuiltinModule('node:path');
  let api = globalThis[KEY];
  const dataDir = opts.dataDir || null;
  const stale = api && (api.version !== opts.version || api.root !== opts.root || (api.dataDirOption || null) !== dataDir);
  if (api && (stale || opts.force) && opts.command !== 'status' && opts.command !== 'uninstall') {
    try { api.dispose(); } catch { /* replaced below */ }
    api = undefined;
  }
  if (!api) {
    if (opts.command === 'status' || opts.command === 'uninstall') return { installed: false, pid: process.pid };
    // Drop cached engine modules so an upgrade loads the new files.
    const src = path.join(opts.root, 'src') + path.sep;
    for (const id of Object.keys(Module._cache)) if (id.startsWith(src)) delete Module._cache[id];
    const load = Module.createRequire(path.join(opts.root, 'src', 'engine', 'main.cjs'));
    api = load('./main.cjs').install({ version: opts.version, root: opts.root, dataDir: opts.dataDir });
    api.dataDirOption = dataDir;
  }
  if (opts.markerPath) api.setMarker(opts.markerPath);
  if (!opts.command) return api.status();
  const result = api.command(opts.command, opts.args);
  // Keep the inspector open only as long as needed: long commands (sync, restore) report through
  // toasts in Orca unless the caller (the CLI) asked to wait for the result.
  if (!opts.wait && result && typeof result.then === 'function') {
    result.catch(() => {});
    return { started: opts.command, pid: process.pid };
  }
  return result;
}
