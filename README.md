# Settings Sync for Orca

Keeps [Orca](https://onorca.dev) the same on every machine, like VS Code Settings Sync: settings,
shortcuts, plugins (with their approvals and on/off state), UI preferences and plugin config files.
The data lives in **your own private git repo** (GitHub, GitLab, Gitea, a NAS, any git host), using
the git login the machine already has.

- Syncs by itself: when Orca starts, when its window gets focus (at most once a minute), every
  5 minutes, and a few seconds after you change something.
- Each setting, shortcut and plugin flag is merged on its own, so changing different things on two
  machines never conflicts. Same thing changed on both: the newer change wins and the panel says so.
- A machine joining a repo that already has settings asks first: take the repo's settings, or upload
  its own.
- Every sync is a git commit: **History** shows them and restores any of them.

Shortcut: `Ctrl+Alt+S` (`⌘⌥S` on macOS) opens the panel; commands **Settings Sync: Open / Sync Now**.

## What is synced

| Group | Synced | Never synced |
|---|---|---|
| Settings | Every Orca setting (theme, fonts, terminal, editor, agents, notifications…) | Accounts and tokens, agent environment variables, proxy, machine paths (workspace folder, shells, SDKs, sound files, voice models), WSL distros, device pairing, per-machine history, one-time migration flags |
| Shortcuts | Every entry of `~/.orca/keybindings.json`, per platform | |
| Plugins | Installed plugins (git and marketplace sources are installed on the other machine; dev-folder plugins are copied), on/off state, approvals | Approval of a copy that asks for different permissions (approve it yourself) |
| UI preferences | Status bar items, zoom levels, sidebar filters and grouping, worktree card layout | Window size, sidebar widths, last opened workspace, notices already seen |
| Plugin config files | `dim-unfocused-panes.json` by default (`extraFiles` in `config.json`) | |

Dev-folder plugins: on a machine that runs the plugin from its own source folder, that folder is never
overwritten. On other machines the files go to `<userData>/settings-sync/dev-plugins/<plugin>` and
are kept up to date. `.git`, `node_modules`, `.env*`, keys and logs are never copied.

The repo must be **private**: it holds your settings and the code of your dev plugins.

## Set up

1. Create an empty **private** repo on any git host, e.g. `orca-settings`.
2. Check that this machine can reach it: `git ls-remote <repo url>` in a terminal (logs you in once
   through Git Credential Manager, or uses your SSH key).
3. In Orca: **Settings → Plugins** → turn on the plugin system → add this folder under
   **Development plugin folder path** → approve the plugin.
4. `Ctrl+Alt+S` → paste the repo URL → **Save**. The first machine uploads its settings.

On every other machine, do steps 2–4. To get the plugin there, take it from the sync repo itself, which
carries a copy after the first sync (PowerShell):

```powershell
git clone <repo url> "$env:TEMP\orca-settings"
$dest = "$env:APPDATA\orca\settings-sync\dev-plugins\khoa.settings-sync"
New-Item -ItemType Directory -Force $dest | Out-Null
Copy-Item "$env:TEMP\orca-settings\dev-plugins\khoa.settings-sync\*" $dest -Recurse -Force
$dest   # add this path in Orca → Settings → Plugins → Development plugin folder path
```

A copy in that folder is updated by sync when the plugin changes on another machine. On macOS/Linux
the folder is `~/Library/Application Support/orca/…` / `~/.config/orca/…`.

When Save finds settings in the repo, the panel asks:
- **Use the repo's settings on this machine** (new machine): where both differ, the repo wins.
- **Upload this machine's settings**: where both differ, this machine wins.

Either way items only one side has are kept, and History can undo it.

## How it works

Orca's plugin API (v1) cannot read or change settings, shortcuts or other plugins, and plugin workers
are stopped after 5 idle minutes. So the worker (`worker.mjs`) only loads the sync engine into Orca's
main process, through the standard Node debug hook: `process._debugProcess(<Orca pid>)` opens Orca's
inspector on `127.0.0.1:9229`, the worker checks it really is Orca's Electron main process, loads
`src/engine/main.cjs` from this folder, and closes the inspector (open for about a second). The worker
starts on Orca events (agent status, worktree created/removed) or a command.

In the main process the engine uses Orca's own IPC handlers (the code behind the Settings page), so
Orca validates, saves and refreshes every window as usual. It wraps the handlers that change synced
things to notice your changes, and watches `keybindings.json` and the plugin config files.

One sync: read this machine → `git fetch` → decide per item → apply what the repo won → write what
this machine won → commit → push (if someone pushed meanwhile, start again). Per item it remembers
what each side had after the last sync, so a value Orca stores differently (clamped, normalised) or a
plugin that failed to install never bounces between machines; failed installs are retried.

Repo layout (sorted, pretty JSON so `git log -p` reads well):

```
settings.json      keybindings.json   plugins.json   ui.json
files/<name>       dev-plugins/<plugin>/…
meta.json          when and where each item last changed; machines and their last sync
```

The engine's own files are in `<Orca userData>/settings-sync/`: `config.json`, `state.json`,
`sync.log`, the git clone (`repo/`) and copied dev plugins.

## Limits

- Needs `git` on PATH and Orca 1.4 (tested on 1.4.222, Windows).
- After an Orca restart the engine starts with the first Orca event (any agent status change) or when
  you open the panel; plugin API v1 has no "on startup" event.
- Port 9229 held by another debugger: the engine cannot load; the worker retries a minute later.
- Uses Orca internals (`ipcMain` handler names, the plugins lock file). A future Orca can change them;
  the engine then reports an error instead of syncing wrong data.
- Disabling the plugin in Orca does not stop an engine that is already loaded: use **Reload Engine**
  after changes, or restart Orca.

## Development

```bash
node --test test/*.test.mjs                 # merge rules + two simulated machines against a bare repo
scripts/run-local.bat                       # load the current source into the running Orca
node scripts/sync.mjs status                # also: sync, settings, history, preview <commit>, restore <commit>,
                                            #       config repoUrl=<url> autoSync=false, choose remote|local, uninstall
node scripts/sync.mjs install --data-dir <folder>   # try it against a test data folder instead of the real one
```

Files in reading order (each file only uses the ones above it):

| # | File | Runs in | Does |
|---|---|---|---|
| 1 | `src/engine/util.cjs` | anywhere | Stable JSON + hashes, plugin folder hash/copy with exclusions |
| 2 | `src/engine/items.cjs` | anywhere | What is synced and how Orca state maps to items |
| 3 | `src/engine/adapter.cjs` | Orca main / tests | Reads and applies items through `ops` |
| 4 | `src/engine/orca-ops.cjs` | Orca main | The real `ops`: Orca IPC handlers and files |
| 5 | `src/engine/git.cjs` | Orca main / tests | git commands on the private clone |
| 6 | `src/engine/merge.cjs` | anywhere | Per-item decision rules |
| 7 | `src/engine/repo.cjs` | Orca main / tests | Repo files ↔ items |
| 8 | `src/engine/sync.cjs` | Orca main / tests | One sync: fetch, decide, apply, commit, push; first-sync choice; history and restore |
| 9 | `src/engine/main.cjs` | Orca main | Triggers, change detection, panel bridge, toasts |
| 10 | `src/inspector.mjs` | Worker / CLI | Connects to Orca's inspector, checks the pid is Orca's main process |
| 11 | `src/install.mjs` | Worker / CLI | Bootstrap that `require`s the engine into Orca (reloads it on a new version) |
| 12 | `scripts/sync.mjs` | Terminal | CLI |
| 13 | `worker.mjs` | Plugin worker | Loads the engine into Orca, forwards commands |
| 14 | `src/renderer/panel.js` | Orca window | Settings Sync panel and toasts |
| 15–18 | `test/fake-orca.cjs`, `sync.test.mjs`, `merge.test.mjs`, `panel.test.mjs` | Node / headless Edge | Fake Orca; two machines against a bare repo; merge table; panel views |
| | `orca-plugin.json` | Orca | Manifest: commands, `Mod+Alt+S`, events that start the worker |
