'use strict';
// One sync = read this machine's items, fetch the repo, decide per item (merge.cjs), apply what the
// repo won to Orca, write what this machine won to the repo, commit, push. If someone pushed in
// between, start again from the fetch (up to 3 times).
//
// The engine does not know Orca: everything Orca-specific goes through the adapter
//   adapter.readLocal(config)          -> Promise<Map<id, item>>
//   adapter.apply(changes, config)     -> Promise<{ failed: Map<id, {message, retry}>, skipped: Set<id> }>
// so the tests can run two fake machines against a bare repo.
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const { decide, stampLocalChanges } = require('./merge.cjs');
const { readRepo, writeRepo } = require('./repo.cjs');
const { categoryOf } = require('./items.cjs');
const { Git } = require('./git.cjs');
const { readJson, writeJson } = require('./util.cjs');

const DEFAULT_CONFIG = {
  repoUrl: '',
  branch: 'main',
  autoSync: true,
  intervalMinutes: 5,
  include: { settings: true, keybindings: true, plugins: true, files: true, ui: true },
  extraFiles: ['dim-unfocused-panes.json'],
  excludeSettings: [],
  machineName: '',
};

const TOMBSTONE_DAYS = 90;
const MAX_ATTEMPTS = 3;

function sanitizeConfig(c) {
  const d = DEFAULT_CONFIG;
  const str = (v, fallback) => (typeof v === 'string' ? v.trim() : fallback);
  const include = { ...d.include };
  for (const k of Object.keys(include)) if (typeof c?.include?.[k] === 'boolean') include[k] = c.include[k];
  const names = (v, fallback) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string' && /^[A-Za-z0-9._-]+$/.test(x)) : fallback);
  const branch = str(c?.branch, '');
  return {
    repoUrl: str(c?.repoUrl, d.repoUrl),
    branch: /^[A-Za-z0-9._/-]+$/.test(branch) ? branch : d.branch,
    autoSync: typeof c?.autoSync === 'boolean' ? c.autoSync : d.autoSync,
    intervalMinutes: Number.isFinite(c?.intervalMinutes) ? Math.min(240, Math.max(1, c.intervalMinutes)) : d.intervalMinutes,
    include,
    extraFiles: names(c?.extraFiles, d.extraFiles),
    excludeSettings: Array.isArray(c?.excludeSettings) ? c.excludeSettings.filter((x) => typeof x === 'string') : [],
    machineName: str(c?.machineName, '') || os.hostname(),
  };
}

function emptyState(repoKey) {
  return {
    repoKey, firstSync: true, firstSyncPrefer: null, awaitingChoice: false, remoteMachines: {},
    lastLocal: {}, lastRemote: {}, localStamps: {}, retry: [], lastSync: null,
  };
}

class SyncEngine {
  /**
   * @param {object} o
   * @param {object} o.adapter      see top of file
   * @param {string} o.dataDir      config.json, state.json and the repo clone live here
   * @param {(msg: string) => void} [o.log]
   * @param {() => number} [o.now]
   */
  constructor({ adapter, dataDir, log = () => {}, now = Date.now, gitPath, askOnFirstSync = false }) {
    this.adapter = adapter;
    this.dataDir = dataDir;
    this.log = log;
    this.now = now;
    this.askOnFirstSync = askOnFirstSync;
    this.repoDir = path.join(dataDir, 'repo');
    this.git = new Git({ dir: this.repoDir, gitPath, log });
    this.running = null;
    this.again = false;
  }

  get configPath() { return path.join(this.dataDir, 'config.json'); }
  get statePath() { return path.join(this.dataDir, 'state.json'); }

  config() {
    return sanitizeConfig(readJson(this.configPath, {}));
  }

  setConfig(patch) {
    const current = readJson(this.configPath, {});
    const next = sanitizeConfig({ ...current, ...patch, include: { ...(current.include || {}), ...(patch.include || {}) } });
    writeJson(this.configPath, { ...next, machineName: patch.machineName ?? current.machineName ?? '' });
    return this.config();
  }

  state() {
    const cfg = this.config();
    const key = `${cfg.repoUrl}#${cfg.branch}`;
    const s = readJson(this.statePath, null);
    return s && s.repoKey === key ? { ...emptyState(key), ...s } : emptyState(key);
  }

  saveState(s) {
    writeJson(this.statePath, s);
  }

  /** Answer to the first-sync question: 'remote' = use the repo's settings here, 'local' = upload this machine's. */
  chooseFirstSync(prefer) {
    if (prefer !== 'remote' && prefer !== 'local') throw new Error(`unknown choice ${prefer}`);
    const s = this.state();
    s.firstSyncPrefer = prefer;
    s.awaitingChoice = false;
    this.saveState(s);
  }

  /** Runs one sync; a call while one is running queues exactly one more run after it. */
  sync(reason = 'manual') {
    if (this.running) {
      this.again = true;
      return this.running;
    }
    this.running = (async () => {
      let result = null;
      try {
        do {
          this.again = false;
          const next = await this.syncOnce(reason);
          result = result ? combineResults(result, next) : next;
        } while (this.again);
      } finally {
        this.running = null;
      }
      return result;
    })();
    return this.running;
  }

  async syncOnce(reason) {
    const cfg = this.config();
    const startedAt = this.now();
    const state = this.state();
    if (!cfg.repoUrl) return this.finish(state, { ok: false, error: 'No sync repo set. Open Settings Sync and paste a private git repo URL.', reason, startedAt });

    // 1. This machine, and when each not-yet-synced change was first seen.
    let local = filterIncluded(await this.adapter.readLocal(cfg), cfg);
    stampLocalChanges(local, pick(state.lastLocal, cfg), state.localStamps, startedAt);
    this.saveState(state);

    const result = { ok: true, reason, startedAt, applied: [], pushed: [], conflicts: [], failed: [], skipped: [], commit: null, remoteCommit: null };
    try {
      await this.git.prepare(cfg.repoUrl, cfg.branch);
      for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        // 2. The repo as it is now.
        result.remoteCommit = await this.git.fetchAndReset(cfg.branch);
        const repo = readRepo(this.repoDir);
        const remoteAll = repo.items;
        // A machine joining a repo that already has settings: like VS Code, ask whether to take
        // the repo's settings or upload this machine's, instead of guessing.
        if (state.firstSync && !state.firstSyncPrefer && this.askOnFirstSync && remoteAll.size > 0) {
          state.awaitingChoice = true;
          state.remoteMachines = repo.machines;
          result.awaitingChoice = true;
          result.remoteMachines = repo.machines;
          return this.finish(state, result);
        }
        const remote = filterIncluded(remoteAll, cfg);
        const stamps = { ...repo.stamps };

        // 3. Decide.
        const retry = new Set(state.retry);
        const decisions = decide({
          local, remote, lastLocal: pick(state.lastLocal, cfg), lastRemote: pick(state.lastRemote, cfg),
          localStamps: state.localStamps, remoteStamps: stamps, firstSync: state.firstSync,
          firstSyncPrefer: state.firstSyncPrefer || 'remote', retry, now: this.now(),
        });
        for (const d of decisions) if (d.conflict && !result.conflicts.some((c) => c.id === d.id)) result.conflicts.push({ id: d.id, ...d.conflict });

        // 4. Apply what the repo won.
        const toApply = decisions.filter((d) => d.action === 'apply');
        if (toApply.length) {
          const changes = toApply.map((d) => ({ id: d.id, item: remote.get(d.id) }));
          const { failed, skipped } = await this.adapter.apply(changes, cfg);
          local = filterIncluded(await this.adapter.readLocal(cfg), cfg);
          for (const d of toApply) {
            state.lastLocal[d.id] = local.get(d.id)?.h;
            state.lastRemote[d.id] = remote.get(d.id)?.h;
            if (state.lastLocal[d.id] === undefined) delete state.lastLocal[d.id];
            if (state.lastRemote[d.id] === undefined) delete state.lastRemote[d.id];
            delete state.localStamps[d.id];
            const f = failed.get(d.id);
            if (f) {
              if (!result.failed.some((x) => x.id === d.id)) result.failed.push({ id: d.id, message: f.message });
              if (f.retry) retry.add(d.id); else retry.delete(d.id);
            } else {
              retry.delete(d.id);
              if (skipped.has(d.id)) { if (!result.skipped.includes(d.id)) result.skipped.push(d.id); }
              else if (!result.applied.includes(d.id)) result.applied.push(d.id);
            }
          }
          state.retry = [...retry];
          this.saveState(state);
        }
        for (const d of decisions) {
          if (d.action !== 'same') continue;
          const h = local.get(d.id)?.h;
          if (h === undefined) { delete state.lastLocal[d.id]; delete state.lastRemote[d.id]; }
          else { state.lastLocal[d.id] = h; state.lastRemote[d.id] = h; }
          delete state.localStamps[d.id];
        }
        for (const d of decisions) if (d.action !== 'apply') retry.delete(d.id);
        state.retry = [...retry];

        // 5. Write what this machine won, commit, push.
        const toPush = decisions.filter((d) => d.action === 'push');
        const merged = new Map(remoteAll);
        const at = this.now();
        for (const d of toPush) {
          const mine = local.get(d.id);
          if (mine) merged.set(d.id, mine); else merged.delete(d.id);
          stamps[d.id] = { t: state.localStamps[d.id]?.t ?? at, m: cfg.machineName, ...(mine ? {} : { deleted: true }) };
        }
        pruneTombstones(stamps, merged, at);
        const machines = { ...repo.machines, [cfg.machineName]: at };
        const needsWrite = toPush.length > 0 || result.remoteCommit === null || !repo.machines[cfg.machineName];
        if (!needsWrite) {
          result.pushed = [];
          break;
        }
        writeRepo(this.repoDir, merged, { stamps, machines });
        const commit = await this.git.commitAll(commitMessage(cfg.machineName, toPush), {
          name: `Orca Settings Sync (${cfg.machineName})`,
          email: 'settings-sync@orca.local',
        });
        if (!commit) break;
        const pushed = await this.git.push(cfg.branch);
        if (!pushed.ok) {
          this.log(`push rejected (attempt ${attempt}); someone synced at the same time, retrying`);
          if (attempt === MAX_ATTEMPTS) throw new Error('Could not push: the repo kept changing. Try again.');
          continue;
        }
        result.commit = commit;
        result.pushed = toPush.map((d) => d.id);
        for (const d of toPush) {
          const h = local.get(d.id)?.h;
          if (h === undefined) { delete state.lastLocal[d.id]; delete state.lastRemote[d.id]; }
          else { state.lastLocal[d.id] = h; state.lastRemote[d.id] = h; }
          delete state.localStamps[d.id];
        }
        break;
      }
      state.firstSync = false;
      state.awaitingChoice = false;
    } catch (err) {
      result.ok = false;
      result.error = friendlyError(err);
      this.log(`sync failed: ${err.stack || err.message}`);
    }
    return this.finish(state, result);
  }

  finish(state, result) {
    result.finishedAt = this.now();
    state.lastSync = summarize(result);
    if (result.ok) state.lastSuccessAt = result.finishedAt;
    this.saveState(state);
    return result;
  }

  async history(limit) {
    const cfg = this.config();
    if (!cfg.repoUrl || !fs.existsSync(path.join(this.repoDir, '.git'))) return [];
    return this.git.history(cfg.branch, limit);
  }

  // ---- restore an older sync ----
  // Restore = make this machine look like the repo did at `commit`, then sync, which pushes those
  // values as this machine's (newer) changes, so every machine follows. Plugins installed since
  // then are not removed.

  async restoreChanges(commit) {
    const cfg = this.config();
    const snapDir = path.join(this.dataDir, 'snapshot');
    await this.git.exportCommit(commit, snapDir);
    const snap = filterIncluded(readRepo(snapDir).items, cfg);
    const local = filterIncluded(await this.adapter.readLocal(cfg), cfg);
    const changes = [];
    for (const id of new Set([...snap.keys(), ...local.keys()])) {
      const want = snap.get(id);
      if (want?.h === local.get(id)?.h) continue;
      if (!want && (categoryOf(id) === 'plugins' || id.startsWith('settings/'))) continue;
      changes.push({ id, item: want });
    }
    changes.sort((a, b) => (a.id < b.id ? -1 : 1));
    return changes;
  }

  async previewRestore(commit) {
    await this.running?.catch(() => {});
    const changes = await this.restoreChanges(commit);
    return { commit, changes: changes.map((c) => ({ id: c.id, removed: c.item === undefined })) };
  }

  async restore(commit) {
    await this.running?.catch(() => {});
    const changes = await this.restoreChanges(commit);
    const { failed } = await this.adapter.apply(changes, this.config());
    const result = await this.sync(`restore ${commit.slice(0, 7)}`);
    return { ...result, restored: changes.map((c) => c.id), restoreFailed: [...failed].map(([id, f]) => ({ id, message: f.message })) };
  }
}

/** A queued re-run reports everything both runs did, so the first caller sees its own changes. */
function combineResults(a, b) {
  const ids = (x, y) => [...new Set([...(x || []), ...(y || [])])];
  const byId = (x, y) => [...new Map([...(x || []), ...(y || [])].map((e) => [e.id, e])).values()];
  return {
    ...b,
    startedAt: a.startedAt,
    applied: ids(a.applied, b.applied),
    pushed: ids(a.pushed, b.pushed),
    skipped: ids(a.skipped, b.skipped),
    conflicts: byId(a.conflicts, b.conflicts),
    failed: b.ok ? byId([], b.failed) : byId(a.failed, b.failed),
    commit: b.commit ?? a.commit,
  };
}

function filterIncluded(items, cfg) {
  const out = new Map();
  for (const [id, i] of items) if (cfg.include[categoryOf(id)]) out.set(id, i);
  return out;
}

function pick(record, cfg) {
  const out = {};
  for (const [id, h] of Object.entries(record)) if (cfg.include[categoryOf(id)]) out[id] = h;
  return out;
}

function pruneTombstones(stamps, merged, now) {
  const limit = now - TOMBSTONE_DAYS * 24 * 3600 * 1000;
  for (const [id, s] of Object.entries(stamps)) {
    if (!merged.has(id) && (!s.deleted || s.t < limit)) delete stamps[id];
  }
}

function commitMessage(machine, pushed) {
  if (pushed.length === 0) return `${machine}: first sync`;
  const names = pushed.map((d) => d.id).slice(0, 6).join(', ');
  return `${machine}: ${pushed.length} change${pushed.length === 1 ? '' : 's'} (${names}${pushed.length > 6 ? ', …' : ''})`;
}

function summarize(r) {
  return {
    ok: r.ok, error: r.error ?? null, reason: r.reason, at: r.finishedAt, tookMs: r.finishedAt - r.startedAt,
    awaitingChoice: Boolean(r.awaitingChoice),
    applied: r.applied ?? [], pushed: r.pushed ?? [], conflicts: r.conflicts ?? [], failed: r.failed ?? [],
    skipped: r.skipped ?? [], commit: r.commit ?? null, remoteCommit: r.remoteCommit ?? null,
  };
}

function friendlyError(err) {
  const text = String(err?.stderr || err?.message || err);
  if (/ENOENT.*git|spawn git/i.test(text)) return 'git is not installed or not on PATH.';
  if (/Authentication failed|could not read Username|Permission denied \(publickey\)|terminal prompts disabled/i.test(text)) {
    return 'Git could not sign in to the sync repo. Run `git ls-remote <repo url>` once in a terminal to log in, then Sync now.';
  }
  if (/Repository not found|does not appear to be a git repository|repository '.*' not found/i.test(text)) {
    return 'Sync repo not found. Check the URL, and that this machine\'s git account can read it.';
  }
  if (/Could not resolve host|unable to access|Connection timed out|Failed to connect/i.test(text)) {
    return 'Offline or the git host is unreachable. Changes are kept and sync again later.';
  }
  return err?.message || text;
}

module.exports = { SyncEngine, sanitizeConfig, DEFAULT_CONFIG, filterIncluded };
