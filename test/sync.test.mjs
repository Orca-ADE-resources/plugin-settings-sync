// Two simulated machines ("work" and "home") with the real adapter, sync engine and git, against
// a bare repo on disk. Run: node --test test/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createFakeOrca, writeDevPlugin } = require('./fake-orca.cjs');
const { createAdapter } = require('../src/engine/adapter.cjs');
const { SyncEngine } = require('../src/engine/sync.cjs');
const { hashTree } = require('../src/engine/util.cjs');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orca-sync-test-'));
const bare = path.join(root, 'remote.git');
execFileSync('git', ['init', '-q', '--bare', bare]);
const clock = { t: 1_800_000_000_000 };
const tick = (ms = 1000) => { clock.t += ms; };

function machine(name, init) {
  const home = path.join(root, name);
  const fake = createFakeOrca({ home, ...init });
  const dataDir = path.join(home, 'settings-sync');
  const adapter = createAdapter(fake.ops, { managedDevRoot: path.join(dataDir, 'dev-plugins') });
  const engine = new SyncEngine({ adapter, dataDir, now: () => clock.t });
  engine.setConfig({ repoUrl: bare, machineName: name });
  return {
    name, home, fake, engine, dataDir,
    s: () => fake.state.settings,
    async sync() {
      tick();
      const r = await engine.sync('test');
      if (!r.ok) throw new Error(`${name} sync failed: ${r.error}`);
      return r;
    },
  };
}

const workDim = path.join(root, 'work-src', 'dim');
writeDevPlugin(workDim, { id: 'dim-unfocused-panes', fingerprint: 'sha256-dim-v1' });

const work = machine('work', {
  settings: {
    terminalFontSize: 14, theme: 'dark', workspaceDir: 'G:\\ws', claudeManagedAccounts: [{ id: 'secret-account' }],
    agentDefaultEnv: { goose: { API_KEY: 'secret' } }, pluginSystemEnabled: true, devPluginPaths: [workDim],
    pluginConsents: { 'khoa.dim-unfocused-panes': 'sha256-dim-v1' }, disabledPlugins: [],
    notifications: { enabled: true, customSoundPath: 'C:\\work.wav' }, agentYoloDefaultsMigrated: true,
  },
  keybindings: { version: 1, keybindings: {}, platforms: { win32: { 'worktree.palette': ['Mod+Shift+P'] } } },
  files: { 'dim-unfocused-panes.json': '{\n  "amount": 0.6\n}\n' },
  ui: { statusBarVisible: false, sidebarWidth: 300, uiZoomLevel: 1 },
});

const home = machine('home', {
  settings: {
    terminalFontSize: 12, theme: 'light', workspaceDir: 'D:\\code', claudeManagedAccounts: [], pluginSystemEnabled: false,
    devPluginPaths: [], pluginConsents: {}, disabledPlugins: [], notifications: { enabled: false, customSoundPath: 'D:\\home.wav' },
    agentYoloDefaultsMigrated: false, homeOnlySetting: 'kept',
  },
  ui: { statusBarVisible: true, sidebarWidth: 500, uiZoomLevel: 0 },
});

const repoFile = (rel) => execFileSync('git', ['--git-dir', bare, 'show', `main:${rel}`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
const repoHas = (rel) => {
  try { repoFile(rel); return true; } catch { return false; }
};

test('work machine: first sync pushes everything except secrets and machine-only keys', async () => {
  const r = await work.sync();
  assert.ok(r.pushed.length > 5, `pushed ${r.pushed.length}`);
  const settings = JSON.parse(repoFile('settings.json'));
  assert.equal(settings.terminalFontSize, 14);
  assert.equal(settings.workspaceDir, undefined, 'machine path not synced');
  assert.equal(settings.claudeManagedAccounts, undefined, 'accounts not synced');
  assert.equal(settings.agentDefaultEnv, undefined, 'env vars not synced');
  assert.equal(settings.agentYoloDefaultsMigrated, undefined, 'migration flags not synced');
  assert.equal(settings.notifications.customSoundPath, undefined, 'local part of a setting not synced');
  assert.equal(settings.devPluginPaths, undefined);
  const plugins = JSON.parse(repoFile('plugins.json'));
  assert.equal(plugins['khoa.dim-unfocused-panes'].source.kind, 'dev');
  assert.equal(plugins['khoa.dim-unfocused-panes'].consent, 'sha256-dim-v1');
  assert.equal(plugins['khoa.dim-unfocused-panes'].enabled, true);
  assert.ok(repoHas('dev-plugins/khoa.dim-unfocused-panes/worker.mjs'));
  assert.ok(!repoHas('dev-plugins/khoa.dim-unfocused-panes/.env'), '.env never copied');
  assert.ok(!repoHas('dev-plugins/khoa.dim-unfocused-panes/node_modules/x/big.js'), 'node_modules never copied');
  assert.equal(repoFile('files/dim-unfocused-panes.json'), '{\n  "amount": 0.6\n}\n');
  assert.deepEqual(JSON.parse(repoFile('keybindings.json')).platforms.win32['worktree.palette'], ['Mod+Shift+P']);
  const ui = JSON.parse(repoFile('ui.json'));
  assert.equal(ui.statusBarVisible, false);
  assert.equal(ui.sidebarWidth, undefined, 'layout sizes stay per machine');
});

test('home machine: first sync makes it look like work, keeps its own paths and secrets', async () => {
  const r = await home.sync();
  const s = home.s();
  assert.equal(s.terminalFontSize, 14);
  assert.equal(s.theme, 'dark');
  assert.equal(s.pluginSystemEnabled, true);
  assert.equal(s.workspaceDir, 'D:\\code');
  assert.deepEqual(s.claudeManagedAccounts, []);
  assert.equal(s.agentYoloDefaultsMigrated, false);
  assert.deepEqual(s.notifications, { enabled: true, customSoundPath: 'D:\\home.wav' });
  assert.deepEqual(home.fake.state.keybindings.platforms.win32['worktree.palette'], ['Mod+Shift+P']);
  assert.equal(home.fake.state.files.get('dim-unfocused-panes.json'), '{\n  "amount": 0.6\n}\n');
  assert.equal(home.fake.state.ui.statusBarVisible, false);
  assert.equal(home.fake.state.ui.uiZoomLevel, 1);
  assert.equal(home.fake.state.ui.sidebarWidth, 500);
  // dev plugin copied, registered, approved, enabled
  const managed = path.join(home.dataDir, 'dev-plugins', 'khoa.dim-unfocused-panes');
  assert.deepEqual(s.devPluginPaths, [managed]);
  assert.equal(hashTree(managed), hashTree(workDim));
  assert.equal(s.pluginConsents['khoa.dim-unfocused-panes'], 'sha256-dim-v1');
  assert.ok(!s.disabledPlugins.includes('khoa.dim-unfocused-panes'));
  // a home-only setting goes up to the repo
  assert.ok(r.pushed.includes('settings/homeOnlySetting'));
  assert.equal(r.conflicts.every((c) => c.winner === 'remote' && c.firstSync), true);
  assert.equal(r.failed.length, 0, JSON.stringify(r.failed));
});

test('after both machines synced once, further syncs are no-ops (no ping-pong)', async () => {
  const first = await work.sync();
  assert.deepEqual(first.applied, ['settings/homeOnlySetting'], 'work receives the home-only setting');
  assert.deepEqual(first.pushed, []);
  const a = await work.sync();
  const b = await home.sync();
  for (const r of [a, b]) {
    assert.deepEqual(r.pushed, [], `${JSON.stringify(r.pushed)}`);
    assert.deepEqual(r.applied, []);
    assert.equal(r.commit, null);
  }
  assert.equal(work.s().homeOnlySetting, 'kept', 'work received the home-only setting');
});

test('different keys changed on both machines are both kept', async () => {
  work.s().terminalFontSize = 15;
  tick();
  home.s().theme = 'light';
  await work.sync();
  await home.sync();
  await work.sync();
  assert.equal(work.s().terminalFontSize, 15);
  assert.equal(work.s().theme, 'light');
  assert.equal(home.s().terminalFontSize, 15);
  assert.equal(home.s().theme, 'light');
});

test('same key changed on both: the newer change wins, whoever syncs first', async () => {
  // work changes first, home later; work syncs first -> home's newer value wins
  work.s().terminalFontSize = 16;
  tick(10_000);
  home.s().terminalFontSize = 18;
  await work.sync(); // pushes 16, stamped now
  const r = await home.sync(); // home first sees its 18 now, later than work's stamp
  assert.equal(r.conflicts.length, 1);
  assert.equal(r.conflicts[0].id, 'settings/terminalFontSize');
  assert.equal(r.conflicts[0].winner, 'local');
  await work.sync();
  assert.equal(home.s().terminalFontSize, 18);
  assert.equal(work.s().terminalFontSize, 18);
});

test('a later local change beats an earlier one already in the repo', async () => {
  home.s().terminalFontSize = 20;
  await home.sync(); // pushed at T
  tick(5000);
  work.s().terminalFontSize = 21; // changed after home's push...
  // ...but work only notices now; its stamp is newer than the repo's, so it wins
  const r = await work.sync();
  assert.equal(r.conflicts.length, 1);
  assert.equal(r.conflicts[0].winner, 'local');
  await home.sync();
  assert.equal(home.s().terminalFontSize, 21);
});

test('removing a keybinding on one machine removes it on the other', async () => {
  home.fake.state.keybindings.keybindings['tab.close'] = ['Mod+W'];
  await home.sync();
  await work.sync();
  assert.deepEqual(work.fake.state.keybindings.keybindings['tab.close'], ['Mod+W']);
  delete work.fake.state.keybindings.keybindings['tab.close'];
  await work.sync();
  await home.sync();
  assert.equal(home.fake.state.keybindings.keybindings['tab.close'], undefined);
});

test('editing a dev plugin on work updates the copy on home', async () => {
  fs.writeFileSync(path.join(workDim, 'worker.mjs'), 'export default function activate() { /* v2 */ }\n');
  await work.sync();
  const r = await home.sync();
  assert.ok(r.applied.includes('plugin-source/khoa.dim-unfocused-panes'));
  const managed = path.join(home.dataDir, 'dev-plugins', 'khoa.dim-unfocused-panes');
  assert.match(fs.readFileSync(path.join(managed, 'worker.mjs'), 'utf8'), /v2/);
});

test('a value Orca normalises does not bounce between machines', async () => {
  work.s().terminalFontSize = 40; // work's Orca allowed it (fake clamps only on setSettings)
  await work.sync();
  const r1 = await home.sync();
  assert.equal(home.s().terminalFontSize, 32, 'home Orca clamped it');
  assert.ok(r1.applied.includes('settings/terminalFontSize'));
  const a = await work.sync();
  const b = await home.sync();
  assert.deepEqual(a.applied, []);
  assert.deepEqual(a.pushed, []);
  assert.deepEqual(b.applied, []);
  assert.deepEqual(b.pushed, []);
  assert.equal(work.s().terminalFontSize, 40);
  work.s().terminalFontSize = 14;
  await work.sync();
  await home.sync();
  assert.equal(home.s().terminalFontSize, 14);
});

test('disabling a plugin on one machine disables it on the other', async () => {
  await work.fake.ops.setEnabled('khoa.dim-unfocused-panes', false);
  await work.sync();
  await home.sync();
  assert.ok(home.s().disabledPlugins.includes('khoa.dim-unfocused-panes'));
  await work.fake.ops.setEnabled('khoa.dim-unfocused-panes', true);
  await work.sync();
  await home.sync();
  assert.ok(!home.s().disabledPlugins.includes('khoa.dim-unfocused-panes'));
});

test('git plugins are installed, approved and enabled on the other machine', async () => {
  const url = 'https://example.com/acme/word-count.git';
  await work.fake.ops.installGit({ url, ref: 'v1.0.0' });
  await work.fake.ops.consent('acme.word-count', 'sha256-wordcount-v1');
  await work.sync();
  const r = await home.sync();
  assert.equal(r.failed.length, 0, JSON.stringify(r.failed));
  assert.equal(home.fake.state.lock['acme.word-count'].source.ref, 'v1.0.0');
  assert.equal(home.s().pluginConsents['acme.word-count'], 'sha256-wordcount-v1');
});

test('a plugin that fails to install is retried and never removed from the repo', async () => {
  const bad = 'https://example.com/acme/missing.git';
  work.fake.state.lock['acme.missing'] = { pluginKey: 'acme.missing', source: { kind: 'git', url: bad, ref: 'main' }, fingerprint: 'x' };
  await work.sync();
  const r1 = await home.sync();
  assert.ok(r1.failed.some((f) => f.id === 'plugin-source/acme.missing'));
  const r2 = await home.sync();
  assert.ok(r2.failed.some((f) => f.id === 'plugin-source/acme.missing'), 'tried again');
  assert.deepEqual(r2.pushed, [], 'did not push the missing plugin as removed');
  assert.ok(JSON.parse(repoFile('plugins.json'))['acme.missing']);
  delete work.fake.state.lock['acme.missing'];
  await work.sync();
  const r3 = await home.sync();
  assert.equal(r3.failed.length, 0);
});

test('two machines pushing at the same time both get in', async () => {
  work.s().editorWordWrap = true;
  home.s().diffWordWrap = true;
  tick();
  const [a, b] = await Promise.all([work.engine.sync('race'), home.engine.sync('race')]);
  assert.ok(a.ok && b.ok, `${a.error} ${b.error}`);
  await work.sync();
  await home.sync();
  assert.equal(work.s().diffWordWrap, true);
  assert.equal(home.s().editorWordWrap, true);
});

test('a category turned off on one machine is left alone there and in the repo', async () => {
  home.engine.setConfig({ include: { keybindings: false } });
  work.fake.state.keybindings.keybindings['pane.split'] = ['Mod+D'];
  await work.sync();
  await home.sync();
  assert.equal(home.fake.state.keybindings.keybindings['pane.split'], undefined);
  assert.deepEqual(JSON.parse(repoFile('keybindings.json')).keybindings['pane.split'], ['Mod+D']);
  home.engine.setConfig({ include: { keybindings: true } });
  await home.sync();
  assert.deepEqual(home.fake.state.keybindings.keybindings['pane.split'], ['Mod+D']);
});

test('a machine developing the same plugin from its own folder keeps its files', async () => {
  const third = machine('laptop', {
    settings: { pluginSystemEnabled: true, devPluginPaths: [], pluginConsents: {}, disabledPlugins: [] },
  });
  const ownDim = path.join(root, 'laptop-src', 'dim');
  writeDevPlugin(ownDim, { id: 'dim-unfocused-panes', fingerprint: 'sha256-dim-v1', body: '// laptop version\n' });
  third.s().devPluginPaths = [ownDim];
  const r1 = await third.sync();
  assert.ok(r1.skipped.includes('plugin-source/khoa.dim-unfocused-panes'));
  assert.match(fs.readFileSync(path.join(ownDim, 'worker.mjs'), 'utf8'), /laptop version/);
  const r2 = await third.sync();
  assert.deepEqual(r2.pushed, [], 'no ping-pong for its own plugin');
  assert.deepEqual(r2.applied, []);
});

test('offline: sync reports it and keeps the pending change, stamped when it was made', async () => {
  fs.renameSync(bare, `${bare}.off`); // the remote is unreachable
  try {
    home.s().terminalCursorBlink = false;
    tick();
    const madeAt = clock.t;
    const r = await home.engine.sync('offline');
    assert.equal(r.ok, false);
    assert.ok(r.error);
    tick(60_000);
    await home.engine.sync('offline again');
    assert.equal(home.engine.state().localStamps['settings/terminalCursorBlink'].t, madeAt, 'stamp kept from the first sighting');
  } finally {
    fs.renameSync(`${bare}.off`, bare);
  }
  const r = await home.sync();
  assert.ok(r.pushed.includes('settings/terminalCursorBlink'));
  assert.equal(home.engine.state().localStamps['settings/terminalCursorBlink'], undefined);
});

test('a sync asked for while one runs is queued, and the caller sees both runs', async () => {
  work.s().editorMinimapEnabled = true;
  tick();
  const first = work.engine.sync('first');
  work.s().diffShowWhitespace = true; // changed while the first run is busy
  const second = work.engine.sync('second');
  const [a, b] = await Promise.all([first, second]);
  assert.equal(a, b, 'one combined result');
  assert.ok(a.pushed.includes('settings/editorMinimapEnabled'), JSON.stringify(a.pushed));
  assert.ok(a.pushed.includes('settings/diffShowWhitespace'), JSON.stringify(a.pushed));
});

test('joining a repo that has settings asks first; "upload this machine" keeps its values', async () => {
  const tablet = machine('tablet', {
    settings: { terminalFontSize: 30, theme: 'system', pluginSystemEnabled: true, devPluginPaths: [], pluginConsents: {}, disabledPlugins: [] },
  });
  tablet.engine.askOnFirstSync = true;
  const asked = await tablet.sync();
  assert.equal(asked.awaitingChoice, true);
  assert.ok(asked.remoteMachines.work, 'names the machines already in the repo');
  assert.equal(tablet.s().terminalFontSize, 30, 'nothing changed while waiting');
  assert.deepEqual(asked.pushed, []);
  tablet.engine.chooseFirstSync('local');
  const r = await tablet.sync();
  assert.ok(r.pushed.includes('settings/terminalFontSize'));
  assert.equal(tablet.s().terminalFontSize, 30);
  assert.equal(tablet.s().editorWordWrap, true, 'items only the repo had still came down');
  await work.sync();
  assert.equal(work.s().terminalFontSize, 30, 'other machines follow the uploaded value');
});

test('joining with "use the repo\'s settings" takes the repo values', async () => {
  const kiosk = machine('kiosk', {
    settings: { terminalFontSize: 9, pluginSystemEnabled: true, devPluginPaths: [], pluginConsents: {}, disabledPlugins: [] },
  });
  kiosk.engine.askOnFirstSync = true;
  assert.equal((await kiosk.sync()).awaitingChoice, true);
  kiosk.engine.chooseFirstSync('remote');
  await kiosk.sync();
  assert.equal(kiosk.s().terminalFontSize, 30);
});

test('history lists the sync commits', async () => {
  const h = await work.engine.history(50);
  assert.ok(h.length >= 10, `history ${h.length}`);
  assert.match(h.at(-1).subject, /work/);
});
