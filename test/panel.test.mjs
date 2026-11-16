// Runs src/renderer/panel.js in headless Edge/Chrome (no Orca) and drives every view: checks what
// it shows and the messages it sends to the main process. Skipped when no Chromium browser is found.
// Set BROWSER=<path to msedge.exe/chrome.exe> to pick the browser.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const browserPath = [
  process.env.BROWSER,
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
].filter(Boolean).find((p) => fs.existsSync(p));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let browser;
let ws;
let evaluate;
const sent = []; // messages the panel sent with console.debug

before(async () => {
  if (!browserPath) return;
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'orca-sync-panel-'));
  browser = spawn(browserPath, ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--no-first-run',
    '--window-size=1200,900', 'about:blank'], { stdio: 'ignore' });
  let port = null;
  for (let i = 0; i < 100 && !port; i++) {
    try { port = fs.readFileSync(path.join(profile, 'DevToolsActivePort'), 'utf8').split('\n')[0]; } catch { await sleep(100); }
  }
  let page = null;
  for (let i = 0; i < 50 && !page; i++) {
    page = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find((t) => t.type === 'page');
    if (!page) await sleep(100);
  }
  ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  let id = 0;
  const pending = new Map();
  ws.onmessage = (m) => {
    const d = JSON.parse(m.data);
    if (d.method === 'Runtime.consoleAPICalled' && d.params.type === 'debug') {
      const text = d.params.args[0]?.value;
      if (typeof text === 'string' && text.startsWith('__orcaSettingsSync:')) sent.push(JSON.parse(text.slice(19)));
    }
    if (pending.has(d.id)) { pending.get(d.id)(d); pending.delete(d.id); }
  };
  const send = (method, params = {}) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
  await send('Runtime.enable');
  evaluate = async (expression) => {
    const res = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (res.result?.exceptionDetails) throw new Error(res.result.exceptionDetails.exception?.description ?? 'evaluate failed');
    return res.result.result.value;
  };
  await evaluate(`document.body.style.background = '#0a0a0a'; document.body.style.color = '#e5e5e5'; true`);
  const source = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'panel.js'), 'utf8').replace('__VERSION__', 'test');
  await evaluate(source + '\n;true');
});

after(() => {
  try { ws?.close(); } catch { /* closed */ }
  browser?.kill();
});

const skip = !browserPath && 'no Chromium browser';
const S = (o) => JSON.stringify(o);
const panelText = () => evaluate(`document.getElementById('orca-settings-sync-panel')?.innerText ?? null`);
const click = (label) => evaluate(`(() => { const b = [...document.querySelectorAll('#orca-settings-sync-panel button')].find((x) => x.textContent === ${S(label)}); if (!b) return false; b.click(); return true; })()`);
const lastSent = async (op) => { await sleep(50); return [...sent].reverse().find((m) => m.op === op); };

const base = {
  installed: true, running: false, firstSync: false, awaitingChoice: false, pending: 0,
  config: { repoUrl: '', branch: 'main', autoSync: true, include: { settings: true, keybindings: true, plugins: true, files: true, ui: true }, machineName: 'work' },
  lastSync: null,
};

test('not set up: asks for a repo URL and saves it', { skip }, async () => {
  await evaluate(`window.__orcaSettingsSync.open(${S(base)}); true`);
  assert.match(await panelText(), /Not set up/);
  assert.ok(await lastSent('refresh'), 'asks main for fresh status on open');
  assert.equal(await evaluate(`document.activeElement?.placeholder ?? ''`), 'https://github.com/you/orca-settings.git', 'URL box focused');
  await evaluate(`(() => { const i = document.activeElement; i.value = 'git@github.com:me/orca-settings.git'; true })()`);
  assert.ok(await click('Save'));
  assert.deepEqual((await lastSent('config')).patch, { repoUrl: 'git@github.com:me/orca-settings.git' });
});

test('synced: shows counts, conflicts and items not applied', { skip }, async () => {
  const s = {
    ...base, firstSync: false, pending: 2,
    config: { ...base.config, repoUrl: 'https://github.com/me/orca-settings.git' },
    lastSync: {
      ok: true, at: Date.now() - 120_000, applied: ['settings/a', 'settings/b'], pushed: ['ui/c'],
      conflicts: [{ id: 'settings/terminalFontSize', winner: 'remote', remoteMachine: 'home', firstSync: false }],
      failed: [{ id: 'plugin-consent/acme.x', message: 'this copy asks for different permissions' }],
    },
  };
  await evaluate(`window.__orcaSettingsSync.update(${S(s)}); document.getElementById('orca-settings-sync-panel').querySelector('button').focus(); window.__orcaSettingsSync.update(${S(s)}); true`);
  const t = await panelText();
  assert.match(t, /Synced, with issues/);
  assert.match(t, /Last sync 2 min ago · ↓2 ↑1/);
  assert.match(t, /2 local changes waiting to upload/);
  assert.match(t, /terminalFontSize → home/);
  assert.match(t, /plugin acme\.x approval/);
  assert.ok(await click('Sync now'));
  assert.ok(await lastSent('sync'));
});

test('error: shows the message', { skip }, async () => {
  const s = { ...base, config: { ...base.config, repoUrl: 'x' }, lastSync: { ok: false, at: Date.now(), error: 'Git could not sign in', applied: [], pushed: [], conflicts: [], failed: [] } };
  await evaluate(`window.__orcaSettingsSync.update(${S(s)}); true`);
  const t = await panelText();
  assert.match(t, /Error/);
  assert.match(t, /Git could not sign in/);
});

test('first sync with a repo that has settings: asks, and sends the choice', { skip }, async () => {
  const s = { ...base, firstSync: true, awaitingChoice: true, pending: 188, remoteMachines: { work: Date.now() - 60_000 }, config: { ...base.config, repoUrl: 'x' } };
  await evaluate(`window.__orcaSettingsSync.update(${S(s)}); true`);
  const t = await panelText();
  assert.match(t, /Waiting for your choice/);
  assert.match(t, /from work \(1 min ago\)/);
  assert.doesNotMatch(t, /waiting to upload/, 'no misleading pending count before the first sync');
  assert.ok(await click("Upload this machine's settings"));
  assert.equal((await lastSent('firstSync')).prefer, 'local');
  assert.ok(await click("Use the repo's settings on this machine"));
  assert.equal((await lastSent('firstSync')).prefer, 'remote');
});

test('toggling what to sync sends a config patch', { skip }, async () => {
  await evaluate(`window.__orcaSettingsSync.update(${S({ ...base, config: { ...base.config, repoUrl: 'x' } })}); true`);
  await evaluate(`(() => { const l = [...document.querySelectorAll('#orca-settings-sync-panel label')].find((x) => x.innerText.trim() === 'Shortcuts'); l.querySelector('input').click(); return true; })()`);
  assert.deepEqual((await lastSent('config')).patch, { include: { keybindings: false } });
});

test('history -> preview -> restore', { skip }, async () => {
  assert.ok(await click('History'));
  assert.ok(await lastSent('history'));
  assert.match(await panelText(), /Loading/);
  const list = [
    { commit: 'a'.repeat(40), at: Date.now() - 1000, subject: 'home: 1 change (settings/theme)' },
    { commit: 'b'.repeat(40), at: Date.now() - 9000, subject: 'work: first sync' },
  ];
  await evaluate(`window.__orcaSettingsSync.showHistory(${S(list)}); true`);
  assert.match(await panelText(), /home: 1 change/);
  await evaluate(`[...document.querySelectorAll('#orca-settings-sync-panel button')].filter((b) => b.textContent === 'Preview')[1].click(); true`);
  assert.equal((await lastSent('preview')).commit, 'b'.repeat(40));
  assert.match(await panelText(), /Comparing/);
  await evaluate(`window.__orcaSettingsSync.showPreview(${S({ commit: 'b'.repeat(40), changes: [{ id: 'settings/theme', removed: false }, { id: 'keybindings/win32/tab.close', removed: true }] })}); true`);
  const t = await panelText();
  assert.match(t, /Restore sets 2 items/);
  assert.match(t, /shortcut tab\.close \(win32\)/);
  assert.ok(await click('Restore'));
  assert.equal((await lastSent('restore')).commit, 'b'.repeat(40));
  assert.match(await panelText(), /Sync repo/, 'back to the main view');
});

test('toast shows, Esc closes the panel, destroy cleans up', { skip }, async () => {
  await evaluate(`window.__orcaSettingsSync.toast({ text: 'Settings Sync: got 1 setting', kind: 'ok' }); true`);
  assert.equal(await evaluate(`document.getElementById('orca-settings-sync-toasts').innerText`), 'Settings Sync: got 1 setting');
  await evaluate(`document.getElementById('orca-settings-sync-panel').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); true`);
  assert.equal(await panelText(), null);
  await evaluate(`window.__orcaSettingsSync.destroy(); true`);
  assert.equal(await evaluate(`typeof window.__orcaSettingsSync + ':' + !!document.getElementById('orca-settings-sync-toasts')`), 'undefined:false');
});
