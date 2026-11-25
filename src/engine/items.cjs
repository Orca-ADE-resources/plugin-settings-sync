'use strict';
// What gets synced, and how Orca's state maps to items. Pure functions (no Orca, no fs), so the
// rules are easy to test and to read.
//
// Item ids:
//   settings/<key>                 one Orca setting
//   keybindings/<scope>/<action>   one entry of ~/.orca/keybindings.json; scope = common | win32 | darwin | linux
//   plugin-source/<pluginKey>      where the plugin comes from: git, marketplace, or a dev folder (files in the repo)
//   plugin-enabled/<pluginKey>     on/off
//   plugin-consent/<pluginKey>     what the user approved: the permissions the manifest asks for (+ release)
//   file/<name>                    a small file in Orca's userData folder (e.g. dim-unfocused-panes.json)
//   ui/<key>                       a display preference from Orca's UI state (status bar, zoom, sidebar filters…)
const { hashValue, stableStringify } = require('./util.cjs');

const CATEGORY_OF_PREFIX = {
  settings: 'settings',
  keybindings: 'keybindings',
  'plugin-source': 'plugins',
  'plugin-enabled': 'plugins',
  'plugin-consent': 'plugins',
  file: 'files',
  ui: 'ui',
};

function categoryOf(id) {
  return CATEGORY_OF_PREFIX[id.slice(0, id.indexOf('/'))] ?? 'unknown';
}

// ---- settings ----

// Never synced: accounts and secrets, things that only make sense on one machine (paths, devices,
// WSL distros, pairing), per-machine history, and keys handled as plugin items.
const SETTINGS_SKIP = new Set([
  // accounts, tokens, identity
  'claudeManagedAccounts', 'codexManagedAccounts',
  'activeClaudeManagedAccountId', 'activeClaudeManagedAccountIdsByRuntime',
  'activeCodexManagedAccountId', 'activeCodexManagedAccountIdsByRuntime',
  'opencodeSessionCookie', 'opencodeWorkspaceId', 'minimaxGroupId', 'telemetry',
  // environment variables can carry API keys
  'agentDefaultEnv', 'nativeChatShellEnvironmentVariables',
  // network of this machine
  'httpProxyUrl', 'httpProxyBypassRules',
  // paths, devices and runtimes of this machine
  'workspaceDir', 'workspaceDirHistory', 'floatingTerminalCwd', 'floatingTerminalTrustedCwds',
  'androidSdkPath', 'terminalDefaultShell', 'machineName', 'activeRuntimeEnvironmentId',
  'localAccountWslDistro', 'terminalWindowsWslDistro', 'localWindowsRuntimeDefault',
  'mobileEmulatorDefaultDeviceUdid', 'mobileAutoRestoreFitMs',
  'mobilePairingConnectionMode', 'mobilePairingCustomAddress', 'mobilePairingCustomAddresses',
  // per-machine history / selections
  'githubProjects', 'defaultRepoSelection', 'defaultLinearTeamSelection',
  // synced as plugin items instead
  'pluginConsents', 'disabledPlugins', 'devPluginPaths',
]);

// One-time migration and "already shown" flags: each Orca install manages its own.
const SETTINGS_SKIP_PATTERNS = [/Migrated/, /Defaulted/, /(Seed|Prompted|Dismissed)$/];

// Parts of a synced setting that stay per machine (paths, devices, discovered model caches).
const SETTINGS_LOCAL_PARTS = {
  notifications: ['customSoundPath'],
  voice: ['modelsDir', 'userModels', 'microphoneDeviceId', 'microphoneDeviceLabel', 'openAiApiKeyConfigured'],
  commitMessageAi: ['discoveredModelsByAgent', 'discoveredModelsByAgentByHost', 'selectedModelByAgentByHost'],
  sourceControlAi: ['discoveredModelsByAgent', 'discoveredModelsByAgentByHost', 'selectedModelByAgentByHost'],
};

function isSyncedSetting(key, extraSkip = []) {
  if (SETTINGS_SKIP.has(key) || extraSkip.includes(key)) return false;
  return !SETTINGS_SKIP_PATTERNS.some((re) => re.test(key));
}

function withoutLocalParts(key, value) {
  const parts = SETTINGS_LOCAL_PARTS[key];
  if (!parts || !value || typeof value !== 'object' || Array.isArray(value)) return value;
  const copy = { ...value };
  for (const p of parts) delete copy[p];
  return copy;
}

/** Orca settings object -> items. `pluginSystemEnabled` is a normal setting. */
function settingsToItems(settings, extraSkip) {
  const items = [];
  for (const key of Object.keys(settings).sort()) {
    const value = settings[key];
    if (value === undefined || !isSyncedSetting(key, extraSkip)) continue;
    items.push(item(`settings/${key}`, withoutLocalParts(key, value)));
  }
  return items;
}

/** Changes -> a patch for `settings:set`, keeping this machine's local parts of each setting. */
function settingsPatch(changes, current) {
  const patch = {};
  for (const { key, value } of changes) {
    if (value === undefined) continue; // settings cannot be deleted; Orca keeps its default
    const parts = SETTINGS_LOCAL_PARTS[key];
    if (parts && value && typeof value === 'object' && !Array.isArray(value) && current[key] && typeof current[key] === 'object') {
      const merged = { ...value };
      for (const p of parts) if (p in current[key]) merged[p] = current[key][p];
      patch[key] = merged;
    } else {
      patch[key] = value;
    }
  }
  return patch;
}

// ---- keybindings (~/.orca/keybindings.json) ----

/** { version, keybindings: {action: keys}, platforms: {win32: {action: keys}} } -> items */
function keybindingsToItems(file) {
  const items = [];
  const common = file && typeof file.keybindings === 'object' && file.keybindings ? file.keybindings : {};
  for (const action of Object.keys(common).sort()) items.push(item(`keybindings/common/${action}`, common[action]));
  const platforms = file && typeof file.platforms === 'object' && file.platforms ? file.platforms : {};
  for (const platform of Object.keys(platforms).sort()) {
    const map = platforms[platform] && typeof platforms[platform] === 'object' ? platforms[platform] : {};
    for (const action of Object.keys(map).sort()) items.push(item(`keybindings/${platform}/${action}`, map[action]));
  }
  return items;
}

/** Applies keybinding item changes to a keybindings file object (returns a new object). */
function applyKeybindingChanges(file, changes) {
  const out = {
    ...(file || {}),
    version: file?.version ?? 1,
    keybindings: { ...(file?.keybindings || {}) },
    platforms: Object.fromEntries(Object.entries(file?.platforms || {}).map(([p, m]) => [p, { ...(m || {}) }])),
  };
  for (const { id, value } of changes) {
    const [, scope, ...rest] = id.split('/');
    const action = rest.join('/');
    const target = scope === 'common' ? out.keybindings : (out.platforms[scope] ??= {});
    if (value === undefined) delete target[action];
    else target[action] = value;
  }
  return out;
}

/** Items -> keybindings file object (used for the repo copy). */
function itemsToKeybindingsFile(items) {
  return applyKeybindingChanges({ version: 1, keybindings: {}, platforms: {} }, items.map((i) => ({ id: i.id, value: i.value })));
}

// ---- plugins ----

/** Lock-file source -> what another machine needs to install the same plugin. */
function installSourceOf(lockSource) {
  if (!lockSource || typeof lockSource !== 'object') return null;
  if (lockSource.kind === 'git' && lockSource.url) return { kind: 'git', url: lockSource.url, ref: lockSource.ref || '' };
  if (lockSource.kind === 'marketplace' && lockSource.marketplace?.url && lockSource.plugin?.url) {
    return {
      kind: 'marketplace',
      marketplace: { url: lockSource.marketplace.url, ref: lockSource.marketplace.ref || '' },
      plugin: { url: lockSource.plugin.url, ref: lockSource.plugin.ref || '' },
    };
  }
  return null; // bundled plugins ship with Orca; local-path installs cannot be reproduced
}

/**
 * Orca names a plugin `<publisher>.<id>`. A plugin folder whose manifest leaves the publisher out
 * (manifest v2, Orca >= 1.4.246) is `local.<id>`.
 */
function pluginKeyOf(manifest) {
  if (!manifest || typeof manifest.id !== 'string') return null;
  return `${typeof manifest.publisher === 'string' && manifest.publisher ? manifest.publisher : 'local'}.${manifest.id}`;
}

// ---- approvals ----
// Orca records an approval as a fingerprint, and the fingerprint is not portable: Orca 1.4.269
// mixes in the plugin folder's path for dev plugins, and each Orca version normalises capabilities
// its own way. So what we sync is what Orca's fingerprint covers, read from the manifest itself:
// the capabilities, the execution profile, whether it has a worker, whether its code or its
// shortcuts are bound to its content, which commands it replaces, and for an installed plugin whose
// content is bound, which release (commit) it was. Another machine approves its own copy when that
// copy asks for exactly the same, using its own fingerprint.

const EXECUTION_LEVELS = ['data', 'declarative', 'sandboxed-ui', 'trusted-worker'];
const listed = (contributes, kind) => Array.isArray(contributes[kind]) && contributes[kind].length > 0;

/** Orca: the approval covers the plugin's code (worker, panels, editors, or a UI-or-higher execution profile). */
function bindsCode(manifest, contributes) {
  if (typeof manifest?.execution !== 'string') {
    return typeof manifest?.main === 'string' || listed(contributes, 'panels') || listed(contributes, 'customEditors');
  }
  return EXECUTION_LEVELS.indexOf(manifest.execution) >= EXECUTION_LEVELS.indexOf('sandboxed-ui');
}

/** Orca: the approval covers what its shortcuts and VM recipes say (they run commands for you). */
function bindsInstructions(contributes) {
  return listed(contributes, 'keybindings') || listed(contributes, 'vmRecipes');
}

function permissionsOf(manifest) {
  const contributes = manifest?.contributes && typeof manifest.contributes === 'object' ? manifest.contributes : {};
  return {
    capabilities: (Array.isArray(manifest?.capabilities) ? manifest.capabilities : []).map((c) => stableStringify(c)).sort(),
    execution: typeof manifest?.execution === 'string' ? manifest.execution : null,
    worker: typeof manifest?.main === 'string',
    code: bindsCode(manifest, contributes),
    instructions: bindsInstructions(contributes),
    replaces: (Array.isArray(contributes.commands) ? contributes.commands : [])
      .map((c) => c?.replaces).filter((r) => typeof r === 'string').sort(),
  };
}

/**
 * The synced value of an approval. `release` (git commit, or Orca's content hash) is kept only for
 * an installed plugin whose approval Orca binds to its content; then another release needs its own
 * approval, as in Orca. Dev folders are matched by permissions alone.
 */
function approvalValue(manifest, release) {
  const p = permissionsOf(manifest);
  return { permissions: p, release: release && (p.code || p.instructions) ? release : null };
}

/**
 * @param {object} o
 * @param {string[]} o.disabled                    settings.disabledPlugins
 * @param {Record<string, {source: object}>} o.lock plugins.lock.json `plugins`
 * @param {Array<{pluginKey: string, dir: string, hash: string | undefined, own: boolean}>} o.dev  dev plugin folders
 * @param {Array<{pluginKey: string, value: object}>} o.approvals  plugins approved for the copy installed now
 */
function pluginItems({ disabled, lock, dev, approvals }) {
  const items = [];
  const installed = new Set();
  for (const [key, entry] of Object.entries(lock || {})) {
    installed.add(key);
    const source = installSourceOf(entry?.source);
    if (source) items.push(item(`plugin-source/${key}`, source));
  }
  for (const d of dev) {
    installed.add(d.pluginKey);
    if (d.hash) items.push({ ...item(`plugin-source/${d.pluginKey}`, { kind: 'dev', hash: d.hash }), dir: d.dir, own: d.own });
  }
  const off = new Set(disabled || []);
  for (const key of [...installed].sort()) items.push(item(`plugin-enabled/${key}`, !off.has(key)));
  for (const a of approvals || []) if (installed.has(a.pluginKey)) items.push(item(`plugin-consent/${a.pluginKey}`, a.value));
  return items;
}

// ---- UI state (Orca's `ui:get`) ----

// Only display preferences. Window size, sidebar widths, last opened workspace, notices seen and
// per-repo state stay on each machine.
const UI_KEYS = [
  'statusBarItems', 'statusBarVisible', 'statusBarUsageMode', 'usagePercentageDisplay',
  'uiZoomLevel', 'editorFontZoomLevel', 'browserDefaultZoomLevel',
  'agentActivityDisplayMode', 'agentsCompactMode', 'agentsGroupBy', 'agentsReadFilter',
  'agentsShowChildAgents', 'agentsShowSearch',
  'groupBy', 'sortBy', 'projectOrderBy', 'showActiveOnly', 'showSleepingWorkspaces',
  'hideSleepingWorkspaces', 'hideDefaultBranchWorkspace', 'alwaysShowDefaultBranchWorkspace',
  'hideDetachedHeadWorkspaces', 'hideCliCreatedWorkspaces', 'hideAutomationGeneratedWorkspaces',
  'hideWorkspacesFromOtherDevices', 'worktreeCardProperties', 'workspaceStatuses',
  'workspaceBoardOpacity', 'syncTaskStatusFromWorkspaceBoard',
];

function uiToItems(ui) {
  const items = [];
  for (const key of UI_KEYS) if (ui && ui[key] !== undefined) items.push(item(`ui/${key}`, ui[key]));
  return items;
}

// ---- helpers ----

function item(id, value) {
  return { id, value, h: hashValue(value) };
}

function toMap(items) {
  return new Map(items.map((i) => [i.id, i]));
}

module.exports = {
  categoryOf, isSyncedSetting, settingsToItems, settingsPatch, withoutLocalParts,
  keybindingsToItems, applyKeybindingChanges, itemsToKeybindingsFile,
  installSourceOf, pluginItems, pluginKeyOf, permissionsOf, approvalValue, uiToItems, UI_KEYS, item, toMap,
  SETTINGS_SKIP, SETTINGS_LOCAL_PARTS,
};
