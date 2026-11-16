#!/usr/bin/env node
// CLI for the running Orca, without the plugin system:
//   node scripts/sync.mjs install|reload        load the engine from this folder into Orca
//   node scripts/sync.mjs status|sync|settings|history|uninstall
//   node scripts/sync.mjs config repoUrl=<url> [branch=main] [autoSync=false] [machineName=…]
//   node scripts/sync.mjs preview <commit> | restore <commit>
//   node scripts/sync.mjs choose remote|local   first sync with a repo that has settings: take them / upload mine
// Options: --pid <orca main pid>, --data-dir <folder> (test data folder instead of userData/settings-sync)
// Must run on a Node that can talk to Orca's inspector; scripts/run-local.* fall back to Orca's own.
import { findOrcaMainPids } from '../src/inspector.mjs';
import { runInOrca } from '../src/install.mjs';

const argv = process.argv.slice(2);
const opt = (name) => {
  const i = argv.indexOf(name);
  if (i === -1) return undefined;
  const v = argv[i + 1];
  argv.splice(i, 2);
  return v;
};
const pidArg = opt('--pid');
const dataDir = opt('--data-dir');
const [command = 'status', ...rest] = argv;

const parseValue = (v) => {
  if (v === 'true') return true;
  if (v === 'false') return false;
  if (/^-?\d+(\.\d+)?$/.test(v)) return Number(v);
  return v;
};

let pids = pidArg ? [Number(pidArg)] : await findOrcaMainPids();
if (pids.length === 0) {
  console.error('Orca is not running.');
  process.exit(1);
}
if (pids.length > 1) {
  console.error(`Several Orca main processes: ${pids.join(', ')}. Pick one with --pid.`);
  process.exit(1);
}

const pid = pids[0];
let call;
switch (command) {
  case 'install': call = { command: undefined }; break;
  case 'reload': call = { command: undefined, force: true }; break;
  case 'config': {
    const patch = {};
    for (const kv of rest) {
      const [k, ...v] = kv.split('=');
      if (k.startsWith('include.')) (patch.include ??= {})[k.slice(8)] = parseValue(v.join('='));
      else patch[k] = parseValue(v.join('='));
    }
    call = { command: 'config', args: patch };
    break;
  }
  case 'preview':
  case 'restore': call = { command, args: { commit: rest[0] } }; break;
  case 'history': call = { command, args: { limit: Number(rest[0]) || 20 } }; break;
  case 'choose': call = { command, args: { prefer: rest[0] } }; break; // first sync: remote | local
  default: call = { command }; break;
}

try {
  const result = await runInOrca({ pid, dataDir, wait: true, ...call });
  console.log(JSON.stringify(result, null, 2));
} catch (err) {
  console.error(err.message);
  process.exit(1);
}
