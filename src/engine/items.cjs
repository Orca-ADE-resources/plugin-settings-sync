'use strict';
// What gets synced, and how Orca's state maps to items. Pure functions (no Orca, no fs), so the
// rules are easy to test and to read.
//
// Item ids:
//   settings/<key>                 one Orca setting
//   keybindings/<scope>/<action>   one entry of ~/.orca/keybindings.json; scope = common | win32 | darwin | linux
//   plugin-source/<pluginKey>      where the plugin comes from: git, marketplace, or a dev folder (files in the repo)
//   plugin-enabled/<pluginKey>     on/off
//   plugin-consent/<pluginKey>     the permission fingerprint the user approved
//   file/<name>                    a small file in Orca's userData folder (e.g. dim-unfocused-panes.json)
//   ui/<key>                       a display preference from Orca's UI state (status bar, zoom, sidebar filters…)
const { hashValue } = require('./util.cjs');

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
 * @param {object} o
 * @param {Record<string, string>} o.consents      settings.pluginConsents
 * @param {string[]} o.disabled                    settings.disabledPlugins
 * @param {Record<string, {source: object}>} o.lock plugins.lock.json `plugins`
 * @param {Array<{pluginKey: string, dir: string, hash: string | undefined}>} o.dev  dev plugin folders
 */
function pluginItems({ consents, disabled, lock, dev }) {
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
  for (const [key, fingerprint] of Object.entries(consents || {})) {
    if (typeof fingerprint === 'string') items.push(item(`plugin-consent/${key}`, fingerprint));
  }
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
  installSourceOf, pluginItems, uiToItems, UI_KEYS, item, toMap,
  SETTINGS_SKIP, SETTINGS_LOCAL_PARTS,
};
