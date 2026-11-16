// Orca plugin worker. Orca starts it on demand (a command, or one of the events in orca-plugin.json)
// and stops it after ~5 minutes idle, so the sync engine lives in Orca's main process (see
// src/engine/main.cjs) and keeps syncing after this worker is gone. This worker only loads it
// there and forwards commands. Orca forks the worker from its main process: process.ppid is Orca.
import { isMarked, readVersion, runInOrca } from './src/install.mjs';

export default async function activate(ctx) {
  const pid = process.ppid;
  const version = readVersion();
  const RETRY_AFTER_MS = 60_000;
  let installing = null;
  let lastFailure = 0;

  const exec = async (command, extra = {}) => {
    try {
      return await runInOrca({ pid, command, ...extra });
    } catch (err) {
      ctx.log(`settings-sync: ${err.message}`);
      throw err;
    }
  };

  // Called on every event; cheap once this Orca process runs the current version. After a failure
  // (e.g. another debugger holds port 9229) wait a minute instead of retrying on every event.
  const ensureInstalled = () => {
    if (isMarked(pid, version) || Date.now() - lastFailure < RETRY_AFTER_MS) return Promise.resolve();
    installing ??= exec(undefined)
      .then((status) => ctx.log(`settings-sync ${version} running in Orca pid ${pid} (${status.windows} window)`))
      .catch(() => { lastFailure = Date.now(); })
      .finally(() => { installing = null; });
    return installing;
  };

  ctx.commands.register('settings', () => exec('settings'));
  ctx.commands.register('sync-now', () => exec('sync'));
  ctx.commands.register('reload', () => exec(undefined, { force: true }));
  ctx.events.on('agent.status.changed', ensureInstalled);
  ctx.events.on('worktree.created', ensureInstalled);
  ctx.events.on('worktree.removed', ensureInstalled);

  // Do not hold up activation (Orca waits for "ready"); load the engine right after.
  setTimeout(ensureInstalled, 0);
}

// Nothing to undo: the engine must outlive this worker. It is gone when Orca quits.
export function deactivate() {}
