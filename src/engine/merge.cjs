'use strict';
// Per-item three-way decision, like VS Code Settings Sync. Every synced thing (one setting, one
// keybinding, one plugin's enabled flag…) is an "item" with an id and a hash of its value; an
// absent item has hash `undefined`, so additions and deletions follow the same rules.
//
// For each item we remember what this machine had (lastLocal) and what the repo had (lastRemote)
// at the end of the previous sync. They are normally equal; they differ when Orca stored a value
// differently from what we asked (normalisation), when an apply failed, or for a plugin this
// machine develops from its own folder. Comparing each side with its own last value means such a
// known difference never bounces back and forth.

/**
 * @typedef {{ h: string | undefined }} Item
 * @typedef {{ id: string, action: 'same' | 'apply' | 'push' | 'keep', conflict?: Conflict }} Decision
 * @typedef {{ winner: 'local' | 'remote', localAt: number, remoteAt: number, remoteMachine: string | null, firstSync: boolean }} Conflict
 */

/**
 * @param {object} o
 * @param {Map<string, Item>} o.local         items on this machine now
 * @param {Map<string, Item>} o.remote        items in the sync repo now
 * @param {Record<string, string>} o.lastLocal   local hash per id at the end of the last sync
 * @param {Record<string, string>} o.lastRemote  repo hash per id at the end of the last sync
 * @param {Record<string, {h?: string, t: number}>} o.localStamps  when each pending local change was first seen
 * @param {Record<string, {t: number, m?: string}>} o.remoteStamps  when each item last changed in the repo, and where
 * @param {boolean} o.firstSync   this machine never synced with this repo
 * @param {'remote' | 'local'} [o.firstSyncPrefer]  who wins conflicts on that first sync (default: the repo)
 * @param {Set<string>} [o.retry] ids whose last apply failed and should be tried again
 * @param {number} o.now
 * @returns {Decision[]}
 */
function decide(o) {
  const ids = new Set([...o.local.keys(), ...o.remote.keys(), ...Object.keys(o.lastLocal), ...Object.keys(o.lastRemote)]);
  const out = [];
  for (const id of [...ids].sort()) {
    const L = o.local.get(id)?.h;
    const R = o.remote.get(id)?.h;
    if (L === R) {
      if (L !== undefined || o.lastLocal[id] !== undefined || o.lastRemote[id] !== undefined) out.push({ id, action: 'same' });
      continue;
    }
    const localChanged = L !== o.lastLocal[id];
    const remoteChanged = R !== o.lastRemote[id];
    if (!localChanged && !remoteChanged) {
      out.push({ id, action: o.retry?.has(id) ? 'apply' : 'keep' });
    } else if (!localChanged) {
      out.push({ id, action: 'apply' });
    } else if (!remoteChanged) {
      out.push({ id, action: 'push' });
    } else {
      const localAt = o.localStamps[id]?.t ?? o.now;
      const remoteAt = o.remoteStamps[id]?.t ?? 0;
      // First sync on a machine: the user picked "use the repo's settings" (default) or "upload this
      // machine's". Otherwise the newer change wins; a tie goes to the repo so all machines agree.
      const remoteWins = o.firstSync
        ? (o.firstSyncPrefer === 'local' ? L === undefined : R !== undefined)
        : remoteAt >= localAt;
      out.push({
        id,
        action: remoteWins ? 'apply' : 'push',
        conflict: {
          winner: remoteWins ? 'remote' : 'local',
          localAt,
          remoteAt,
          remoteMachine: o.remoteStamps[id]?.m ?? null,
          firstSync: Boolean(o.firstSync),
        },
      });
    }
  }
  return out;
}

/**
 * Updates `localStamps` for local changes that are not in the repo yet: a stamp records when this
 * machine first had the current pending value, which is what conflicts compare.
 */
function stampLocalChanges(local, lastLocal, localStamps, now) {
  const ids = new Set([...local.keys(), ...Object.keys(lastLocal), ...Object.keys(localStamps)]);
  for (const id of ids) {
    const L = local.get(id)?.h;
    if (L === lastLocal[id]) {
      delete localStamps[id];
    } else if (!localStamps[id] || localStamps[id].h !== (L ?? null)) {
      localStamps[id] = { h: L ?? null, t: now };
    }
  }
}

module.exports = { decide, stampLocalChanges };
