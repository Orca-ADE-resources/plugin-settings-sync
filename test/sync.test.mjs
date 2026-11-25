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
const { createFakeOrca, writeDevPlugin, GIT_REGISTRY } = require('./fake-orca.cjs');
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
// adds a shortcut, so Orca 1.4.269 asks to approve it again whenever its files change
const DIM_ADDS = { keybindings: [{ command: 'toggle', key: 'Mod+Alt+D' }] };
writeDevPlugin(workDim, { id: 'dim-unfocused-panes', contributes: DIM_ADDS });
const DIM = 'khoa.dim-unfocused-panes';

const work = machine('work', {
  settings: {
    terminalFontSize: 14, theme: 'dark', workspaceDir: 'G:\\ws', claudeManagedAccounts: [{ id: 'secret-account' }],
    agentDefaultEnv: { goose: { API_KEY: 'secret' } }, pluginSystemEnabled: true, devPluginPaths: [workDim],
    // an approval left behind by a plugin removed since: not synced
    pluginConsents: { 'local.dev-services': 'sha256-removed-plugin' }, disabledPlugins: [],
    notifications: { enabled: true, customSoundPath: 'C:\\work.wav' }, agentYoloDefaultsMigrated: true,
  },
  keybindings: { version: 1, keybindings: {}, platforms: { win32: { 'worktree.palette': ['Mod+Shift+P'] } } },
  files: { 'dim-unfocused-panes.json': '{\n  "amount": 0.6\n}\n' },
  ui: { statusBarVisible: false, sidebarWidth: 300, uiZoomLevel: 1 },
  orcaVersion: '1.4.222',
});
await work.fake.approve(DIM);

// A newer Orca at home: it fingerprints plugins differently, and the dim plugin lives in another folder.
const home = machine('home', {
  settings: {
    terminalFontSize: 12, theme: 'light', workspaceDir: 'D:\\code', claudeManagedAccounts: [], pluginSystemEnabled: false,
    devPluginPaths: [], pluginConsents: {}, disabledPlugins: [], notifications: { enabled: false, customSoundPath: 'D:\\home.wav' },
    agentYoloDefaultsMigrated: false, homeOnlySetting: 'kept',
  },
  ui: { statusBarVisible: true, sidebarWidth: 500, uiZoomLevel: 0 },
  orcaVersion: '1.4.269',
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
  assert.deepEqual(plugins[DIM].consent, {
    permissions: { capabilities: ['{"kind":"events:subscribe"}'], execution: null, worker: true, code: true, instructions: true, replaces: [] },
    release: null,
  }, 'what was approved, not the Orca fingerprint');
  assert.equal(plugins['local.dev-services'], undefined, 'approval of a removed plugin not synced');
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
  const homeFp = await home.fake.fingerprintOf(DIM);
  assert.notEqual(homeFp, await work.fake.fingerprintOf(DIM), 'each Orca fingerprints it differently');
  assert.equal(s.pluginConsents[DIM], homeFp, 'approved with home\'s own fingerprint');
  assert.ok(!s.disabledPlugins.includes(DIM));
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
  // new files: Orca asks again on both machines. Home's copy is kept by sync: approved again by itself.
  assert.equal(home.s().pluginConsents[DIM], await home.fake.fingerprintOf(DIM), 'home approved the new files');
  assert.notEqual(work.s().pluginConsents[DIM], await work.fake.fingerprintOf(DIM), 'work (own folder) leaves it to Orca');
  assert.ok(!r.pushed.includes(`plugin-consent/${DIM}`), 'no approval change pushed from home');
  const w = await work.sync();
  assert.deepEqual([w.pushed, w.applied], [[], []], 'work does not push the approval away while Orca asks again');
  await work.fake.approve(DIM); // the developer approves it in Orca
  const w2 = await work.sync();
  assert.deepEqual([w2.pushed, w2.applied], [[], []]);
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
  await work.fake.approve('acme.word-count');
  await work.sync();
  const r = await home.sync();
  assert.equal(r.failed.length, 0, JSON.stringify(r.failed));
  assert.equal(home.fake.state.lock['acme.word-count'].source.ref, 'v1.0.0');
  assert.equal(home.s().pluginConsents['acme.word-count'], await home.fake.fingerprintOf('acme.word-count'));
  assert.equal(JSON.parse(repoFile('plugins.json'))['acme.word-count'].consent.release, 'c0ffee1');
});

test('a git plugin that installs as another release is not approved by itself', async () => {
  const url = 'https://example.com/acme/todo.git';
  const manifest = { publisher: 'acme', id: 'todo', main: 'worker.mjs', capabilities: [] };
  GIT_REGISTRY[url] = { pluginKey: 'acme.todo', refs: { main: { commit: 'aaa1', contentHash: 'todo-1', manifest } } };
  await work.fake.ops.installGit({ url, ref: 'main' });
  await work.fake.approve('acme.todo');
  await work.sync();
  GIT_REGISTRY[url].refs.main = { commit: 'bbb2', contentHash: 'todo-2', manifest }; // the branch moved on meanwhile
  const r = await home.sync();
  assert.equal(home.fake.state.lock['acme.todo'].resolvedCommit, 'bbb2');
  const f = r.failed.find((x) => x.id === 'plugin-consent/acme.todo');
  assert.match(f?.message ?? '', /different release/);
  assert.equal(home.s().pluginConsents['acme.todo'], undefined);
  await home.fake.approve('acme.todo'); // the user reviews it in Settings → Plugins
  const r2 = await home.sync();
  assert.deepEqual(r2.failed, [], 'the warning goes away');
  const r3 = await work.sync();
  assert.deepEqual(r3.failed, []);
  assert.equal(work.fake.state.lock['acme.todo'].resolvedCommit, 'aaa1', 'work keeps its approved copy');
});

test('a plugin not installed here waits quietly and is approved once it is there', async () => {
  // a theme plugin bundled with work's Orca, which home's Orca does not ship yet
  const entry = (contentHash) => ({
    pluginKey: 'stablyai.night-theme', source: { kind: 'bundled', bundleId: 'stablyai.night-theme' }, resolvedCommit: null,
    contentHash, manifest: { publisher: 'stablyai', id: 'night-theme', contributes: { themes: [{ id: 'night' }], terminalThemes: [{ id: 'night' }] } },
  });
  work.fake.state.lock['stablyai.night-theme'] = entry('night-1');
  await work.fake.approve('stablyai.night-theme');
  await work.sync();
  const r1 = await home.sync();
  assert.deepEqual(r1.failed, [], 'nothing for the user to do');
  assert.deepEqual(r1.waiting.map((w) => w.id).sort(), ['plugin-consent/stablyai.night-theme', 'plugin-enabled/stablyai.night-theme']);
  home.fake.state.lock['stablyai.night-theme'] = entry('night-2'); // home's Orca updated: ships it too
  const r2 = await home.sync();
  assert.deepEqual(r2.failed, []);
  assert.ok(r2.applied.includes('plugin-consent/stablyai.night-theme'), JSON.stringify(r2));
  assert.equal(home.s().pluginConsents['stablyai.night-theme'], await home.fake.fingerprintOf('stablyai.night-theme'));
  const r3 = await home.sync();
  assert.deepEqual([r3.applied, r3.pushed, r3.waiting], [[], [], []], 'settled');
});

test('a dev plugin whose manifest has no publisher (local.<id>) is copied and approved', async () => {
  const pm2 = path.join(root, 'work-src', 'pm2');
  writeDevPlugin(pm2, { publisher: null, id: 'pm2-local-services', capabilities: [] });
  work.s().devPluginPaths = [...work.s().devPluginPaths, pm2];
  await work.fake.approve('local.pm2-local-services');
  await work.sync();
  const r = await home.sync();
  assert.deepEqual(r.failed, []);
  const managed = path.join(home.dataDir, 'dev-plugins', 'local.pm2-local-services');
  assert.ok(home.s().devPluginPaths.includes(managed));
  assert.equal(home.s().pluginConsents['local.pm2-local-services'], await home.fake.fingerprintOf('local.pm2-local-services'));
});

test('an approval written by Settings Sync 0.2 (a bare fingerprint) is used only where it matches', async () => {
  const { createAdapter } = require('../src/engine/adapter.cjs');
  const box = createFakeOrca({ home: path.join(root, 'old-format'), settings: { devPluginPaths: [], pluginConsents: {}, disabledPlugins: [] } });
  const dir = path.join(root, 'old-format', 'p');
  writeDevPlugin(dir, { id: 'p' });
  box.state.settings.devPluginPaths = [dir];
  const adapter = createAdapter(box.ops, { managedDevRoot: path.join(root, 'old-format', 'managed') });
  const other = await adapter.apply([{ id: 'plugin-consent/khoa.p', item: { value: 'sha256-from-another-machine' } }]);
  assert.equal(other.failed.get('plugin-consent/khoa.p')?.quiet, true, 'waits for the other machine to sync with 0.3');
  assert.equal(box.state.settings.pluginConsents['khoa.p'], undefined);
  const same = await adapter.apply([{ id: 'plugin-consent/khoa.p', item: { value: await box.fingerprintOf('khoa.p') } }]);
  assert.equal(same.failed.size, 0);
  assert.equal(box.state.settings.pluginConsents['khoa.p'], await box.fingerprintOf('khoa.p'));
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
  writeDevPlugin(ownDim, { id: 'dim-unfocused-panes', contributes: DIM_ADDS, body: '// laptop version\n' });
  third.s().devPluginPaths = [ownDim];
  const r1 = await third.sync();
  assert.ok(r1.skipped.includes('plugin-source/khoa.dim-unfocused-panes'));
  assert.match(fs.readFileSync(path.join(ownDim, 'worker.mjs'), 'utf8'), /laptop version/);
  const r2 = await third.sync();
  assert.deepEqual(r2.pushed, [], 'no ping-pong for its own plugin');
  assert.deepEqual(r2.applied, []);
  assert.equal(third.s().pluginConsents[DIM], await third.fake.fingerprintOf(DIM), 'its own copy asks for the same: approved');
});

test('a copy that asks for other permissions than the one approved is left for the user', async () => {
  const fourth = machine('desktop', {
    settings: { pluginSystemEnabled: true, devPluginPaths: [], pluginConsents: {}, disabledPlugins: [] },
  });
  const ownDim = path.join(root, 'desktop-src', 'dim');
  writeDevPlugin(ownDim, { id: 'dim-unfocused-panes', contributes: DIM_ADDS, capabilities: [{ kind: 'events:subscribe' }, { kind: 'secrets:own' }] });
  fourth.s().devPluginPaths = [ownDim];
  const r = await fourth.sync();
  const f = r.failed.find((x) => x.id === `plugin-consent/${DIM}`);
  assert.match(f?.message ?? '', /different permissions/);
  assert.equal(fourth.s().pluginConsents[DIM], undefined);
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

test('an approval dropped by Settings Sync 0.2 rewriting plugins.json is put back', async () => {
  await work.sync();
  await home.sync();
  // what 0.2 does when it pushes: rewrites plugins.json from the items it can read, no deletion record
  const clone = path.join(root, 'old-engine');
  execFileSync('git', ['clone', '-q', '-b', 'main', bare, clone]);
  const plugins = JSON.parse(fs.readFileSync(path.join(clone, 'plugins.json'), 'utf8'));
  delete plugins[DIM].consent;
  fs.writeFileSync(path.join(clone, 'plugins.json'), JSON.stringify(plugins, null, 2));
  const meta = JSON.parse(fs.readFileSync(path.join(clone, 'meta.json'), 'utf8'));
  delete meta.stamps[`plugin-consent/${DIM}`];
  fs.writeFileSync(path.join(clone, 'meta.json'), JSON.stringify(meta, null, 2));
  const git = (...a) => execFileSync('git', ['-C', clone, '-c', 'user.name=old', '-c', 'user.email=old@x', ...a]);
  git('commit', '-qam', 'home (0.2): 1 change');
  git('push', '-q', 'origin', 'HEAD:main');
  const r = await work.sync();
  assert.ok(r.pushed.includes(`plugin-consent/${DIM}`), JSON.stringify(r.pushed));
  assert.ok(JSON.parse(repoFile('plugins.json'))[DIM].consent.permissions);
  const again = await home.sync();
  assert.deepEqual([again.failed, again.waiting], [[], []]);
});

test('history lists the sync commits', async () => {
  const h = await work.engine.history(50);
  assert.ok(h.length >= 10, `history ${h.length}`);
  assert.match(h.at(-1).subject, /work/);
});
