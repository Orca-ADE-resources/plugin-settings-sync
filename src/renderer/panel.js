// Settings Sync panel and toasts, injected into Orca's window by src/engine/main.cjs.
// Talks to the main process with `console.debug('__orcaSettingsSync:' + json)` (the page has no IPC
// channel of ours); the main process calls window.__orcaSettingsSync.update/showHistory/... back.
// DOM + element.style only (no <style>, no innerHTML), so Orca's CSP has nothing to block.
(() => {
  const KEY = '__orcaSettingsSync';
  const VERSION = '__VERSION__';
  const CHANNEL = '__orcaSettingsSync:';
  if (window[KEY]) {
    if (window[KEY].version === VERSION) return;
    try { window[KEY].destroy(); } catch { /* replaced below */ }
  }

  const send = (op, extra) => console.debug(CHANNEL + JSON.stringify({ op, ...extra }));
  const isMac = /Mac/i.test(navigator.platform);
  const SHORTCUT = isMac ? '⌘⌥S' : 'Ctrl+Alt+S';

  const h = (tag, style, props, children) => {
    const node = document.createElement(tag);
    if (style) Object.assign(node.style, style);
    if (props) Object.assign(node, props);
    for (const c of children || []) if (c) node.append(c);
    return node;
  };
  const text = (t, style) => h('span', style, { textContent: t });
  const accent = { accentColor: 'var(--primary, #4f8cff)' };
  const muted = { opacity: '0.65' };
  const COLORS = { ok: '#3fb950', warn: '#d29922', error: '#f85149', info: 'var(--primary, #4f8cff)' };

  function button(label, onClick, style) {
    const b = h('button', {
      background: 'transparent', color: 'inherit', border: '1px solid var(--border, #444)', borderRadius: '6px',
      padding: '3px 10px', font: 'inherit', cursor: 'pointer', whiteSpace: 'nowrap', ...style,
    }, { type: 'button', textContent: label });
    b.addEventListener('click', onClick);
    return b;
  }

  function ago(at) {
    if (!at) return 'never';
    const s = Math.max(0, Math.round((Date.now() - at) / 1000));
    if (s < 10) return 'just now';
    if (s < 60) return `${s} s ago`;
    if (s < 3600) return `${Math.round(s / 60)} min ago`;
    if (s < 86400) return `${Math.round(s / 3600)} h ago`;
    return new Date(at).toLocaleString();
  }

  /** settings/terminalFontSize -> "terminalFontSize" etc. */
  function label(id) {
    const [prefix, ...rest] = id.split('/');
    const key = rest.join('/');
    switch (prefix) {
      case 'settings': return key;
      case 'keybindings': { const [scope, ...a] = rest; return `shortcut ${a.join('/')}${scope === 'common' ? '' : ` (${scope})`}`; }
      case 'plugin-source': return `plugin ${key}`;
      case 'plugin-enabled': return `plugin ${key} on/off`;
      case 'plugin-consent': return `plugin ${key} approval`;
      case 'file': return key;
      case 'ui': return `UI ${key}`;
      default: return id;
    }
  }

  // ---- toasts ----

  let toastBox = null;
  function toast({ text: msg, kind = 'info' } = {}) {
    if (!msg) return;
    if (!toastBox || !toastBox.isConnected) {
      toastBox = h('div', {
        position: 'fixed', right: '16px', bottom: '40px', zIndex: '61', display: 'flex', flexDirection: 'column',
        gap: '6px', alignItems: 'flex-end', pointerEvents: 'none', maxWidth: '420px',
      });
      toastBox.id = 'orca-settings-sync-toasts';
      document.body.appendChild(toastBox);
    }
    const node = h('div', {
      background: 'var(--popover, #1c1c1c)', color: 'var(--popover-foreground, #e5e5e5)',
      border: '1px solid var(--border, #333)', borderLeft: `3px solid ${COLORS[kind] || COLORS.info}`,
      borderRadius: '8px', padding: '7px 12px', fontSize: '12px', lineHeight: '1.4',
      boxShadow: '0 8px 28px rgba(0,0,0,.4)', transition: 'opacity 200ms', opacity: '1', pointerEvents: 'auto',
      cursor: 'pointer',
    }, { textContent: msg, title: 'Click to open Settings Sync' });
    node.addEventListener('click', () => { node.remove(); open(); });
    toastBox.append(node);
    if (panel) toastBox.style.bottom = `${panel.getBoundingClientRect().height + 52}px`;
    setTimeout(() => { node.style.opacity = '0'; }, kind === 'error' ? 9000 : 5000);
    setTimeout(() => node.remove(), kind === 'error' ? 9300 : 5300);
  }

  // ---- panel ----

  let panel = null;
  let body = null;
  let view = 'main'; // main | history | preview
  let status = null;
  let historyList = null;
  let preview = null;
  let returnFocus = null;
  let ticker = 0;

  function section(title) {
    return h('div', {
      marginTop: '10px', paddingTop: '8px', borderTop: '1px solid var(--border, #333)', fontWeight: '600',
      fontSize: '11px', textTransform: 'uppercase', letterSpacing: '.04em', opacity: '0.7',
    }, { textContent: title });
  }

  function statusPill() {
    const s = status;
    let kind = 'info';
    let t = 'Not set up';
    if (s?.running) { kind = 'info'; t = 'Syncing…'; }
    else if (!s?.config?.repoUrl) { kind = 'warn'; t = 'Not set up'; }
    else if (s?.awaitingChoice) { kind = 'warn'; t = 'Waiting for your choice'; }
    else if (s?.lastSync && !s.lastSync.ok) { kind = 'error'; t = 'Error'; }
    else if (s?.lastSync?.failed?.length) { kind = 'warn'; t = 'Synced, with issues'; }
    else if (s?.lastSync) { kind = 'ok'; t = 'Synced'; }
    else { t = 'Waiting'; }
    return h('span', {
      display: 'inline-flex', alignItems: 'center', gap: '5px', fontSize: '11px', fontWeight: '500', opacity: '0.9',
    }, null, [h('span', { width: '7px', height: '7px', borderRadius: '50%', background: COLORS[kind] }), text(t)]);
  }

  function renderMain() {
    const s = status || {};
    const cfg = s.config || {};
    const nodes = [];

    // Repo URL
    const url = h('input', {
      flex: '1', minWidth: '0', background: 'var(--background, #111)', color: 'inherit',
      border: '1px solid var(--border, #444)', borderRadius: '6px', padding: '4px 7px', font: 'inherit',
    }, { type: 'text', value: cfg.repoUrl || '', placeholder: 'https://github.com/you/orca-settings.git', spellcheck: false });
    const save = button('Save', () => {
      save.focus(); // leave the text box so the panel can refresh with the result
      send('config', { patch: { repoUrl: url.value.trim() } });
    });
    url.addEventListener('keydown', (e) => { if (e.key === 'Enter') save.click(); });
    nodes.push(h('div', { margin: '6px 0 2px' }, null, [text('Sync repo (private git)', { fontWeight: '500' })]));
    nodes.push(h('div', { display: 'flex', gap: '6px' }, null, [url, save]));
    nodes.push(h('div', { ...muted, fontSize: '11px', marginTop: '3px' }, {
      textContent: 'Any git host. Uses this machine\'s git login (Git Credential Manager / SSH key).',
    }));

    // First sync of this machine with a repo that already has settings: ask, like VS Code.
    if (s.awaitingChoice) {
      const machines = Object.entries(s.remoteMachines || {}).sort((a, b) => b[1] - a[1]).map(([m, at]) => `${m} (${ago(at)})`);
      nodes.push(h('div', {
        marginTop: '10px', padding: '9px 10px', borderRadius: '8px', border: `1px solid ${COLORS.warn}`,
        background: 'rgba(210,153,34,.08)',
      }, null, [
        h('div', { fontWeight: '600', marginBottom: '3px' }, { textContent: 'This repo already has Orca settings' }),
        h('div', { ...muted, marginBottom: '8px' }, { textContent: machines.length ? `from ${machines.join(', ')}` : 'from another machine' }),
        h('div', { display: 'flex', flexDirection: 'column', gap: '6px' }, null, [
          button('Use the repo\'s settings on this machine', () => send('firstSync', { prefer: 'remote' }), { fontWeight: '600', textAlign: 'left', borderColor: COLORS.ok }),
          button('Upload this machine\'s settings', () => send('firstSync', { prefer: 'local' }), { textAlign: 'left' }),
        ]),
        h('div', { ...muted, fontSize: '11px', marginTop: '6px' }, {
          textContent: 'Either way both are merged: items only one side has are kept. Every sync is saved, so History can undo it.',
        }),
      ]));
    }

    // Actions
    const auto = h('input', { ...accent, margin: '0' }, { type: 'checkbox', checked: Boolean(cfg.autoSync) });
    auto.addEventListener('change', () => send('config', { patch: { autoSync: auto.checked } }));
    const syncBtn = button(s.running ? 'Syncing…' : 'Sync now', () => send('sync'), { fontWeight: '600' });
    syncBtn.disabled = Boolean(s.running) || !cfg.repoUrl;
    if (syncBtn.disabled) syncBtn.style.opacity = '0.5';
    nodes.push(h('div', { display: 'flex', alignItems: 'center', gap: '6px', marginTop: '10px', flexWrap: 'wrap' }, null, [
      syncBtn,
      button('History', () => { view = 'history'; historyList = null; render(); send('history'); }),
      button('Folder', () => send('openFolder'), { opacity: '0.85' }),
      h('label', { display: 'flex', alignItems: 'center', gap: '5px', marginLeft: 'auto', cursor: 'pointer' }, null, [auto, text('Auto sync')]),
    ]));

    // Last sync
    const ls = s.awaitingChoice ? null : s.lastSync;
    const lines = [];
    if (s.awaitingChoice) {
      lines.push(text('Nothing synced yet: pick one of the two above.', muted));
    } else if (ls) {
      const head = ls.ok
        ? `Last sync ${ago(ls.at)} · ↓${ls.applied.length} ↑${ls.pushed.length}`
        : `Last try ${ago(ls.at)} failed`;
      lines.push(text(head));
      if (!ls.ok && ls.error) lines.push(h('div', { color: COLORS.error, marginTop: '3px', userSelect: 'text' }, { textContent: ls.error }));
    } else {
      lines.push(text(cfg.repoUrl ? 'Not synced yet' : 'Paste a private repo URL and Save. The first machine uploads its settings; the next ones download them.'));
    }
    if (s.pending && !s.firstSync) lines.push(h('div', muted, { textContent: `${s.pending} local change${s.pending === 1 ? '' : 's'} waiting to upload` }));
    nodes.push(h('div', { marginTop: '9px', lineHeight: '1.5' }, null, lines));

    const conflicts = (ls?.conflicts || []).filter((c) => !c.firstSync);
    if (conflicts.length) {
      nodes.push(section('Conflicts (newer change kept)'));
      for (const c of conflicts.slice(0, 6)) {
        nodes.push(h('div', { margin: '3px 0' }, {
          textContent: `${label(c.id)} → ${c.winner === 'local' ? 'this machine' : (c.remoteMachine || 'other machine')}`,
        }));
      }
    }
    if (ls?.failed?.length) {
      nodes.push(section('Not applied here'));
      for (const f of ls.failed.slice(0, 6)) {
        nodes.push(h('div', { margin: '3px 0', userSelect: 'text' }, null, [
          text(label(f.id), { fontWeight: '500' }), text(` — ${f.message}`, muted),
        ]));
      }
    }

    // What to sync
    nodes.push(section('What to sync'));
    const inc = cfg.include || {};
    const grid = h('div', { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '4px 10px', marginTop: '6px' });
    for (const [k, t] of [['settings', 'Settings'], ['keybindings', 'Shortcuts'], ['plugins', 'Plugins + approvals'], ['ui', 'UI preferences'], ['files', 'Plugin config files']]) {
      const cb = h('input', { ...accent, margin: '0' }, { type: 'checkbox', checked: inc[k] !== false });
      cb.addEventListener('change', () => send('config', { patch: { include: { [k]: cb.checked } } }));
      grid.append(h('label', { display: 'flex', alignItems: 'center', gap: '6px', cursor: 'pointer' }, null, [cb, text(t)]));
    }
    nodes.push(grid);

    // Machine name
    const machine = h('input', {
      width: '150px', background: 'var(--background, #111)', color: 'inherit', border: '1px solid var(--border, #444)',
      borderRadius: '6px', padding: '2px 6px', font: 'inherit',
    }, { type: 'text', value: cfg.machineName || '', spellcheck: false });
    machine.addEventListener('change', () => send('config', { patch: { machineName: machine.value.trim() } }));
    nodes.push(h('div', { display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: '10px' }, null, [
      text('This machine', muted), machine,
    ]));

    nodes.push(h('div', {
      display: 'flex', justifyContent: 'space-between', marginTop: '10px', paddingTop: '8px',
      borderTop: '1px solid var(--border, #333)', fontSize: '11px',
    }, null, [
      text(`${SHORTCUT} opens this · v${VERSION}`, muted),
      button('Log', () => send('openLog'), { border: 'none', padding: '0 4px', fontSize: '11px', opacity: '0.7' }),
    ]));
    return nodes;
  }

  function renderHistory() {
    const nodes = [h('div', { display: 'flex', alignItems: 'center', gap: '8px', margin: '6px 0' }, null, [
      button('← Back', () => { view = 'main'; render(); }),
      text('Pick a sync to restore', muted),
    ])];
    if (!historyList) {
      nodes.push(text('Loading…', muted));
      return nodes;
    }
    if (historyList.length === 0) nodes.push(text('No syncs yet.', muted));
    const list = h('div', { maxHeight: '300px', overflowY: 'auto', marginTop: '4px' });
    for (const c of historyList) {
      const row = h('div', {
        display: 'flex', alignItems: 'center', gap: '8px', padding: '4px 2px', borderBottom: '1px solid var(--border, #2a2a2a)',
      });
      row.append(
        h('div', { flex: '1', minWidth: '0' }, null, [
          h('div', { whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }, { textContent: c.subject, title: c.subject }),
          h('div', { ...muted, fontSize: '11px' }, { textContent: `${new Date(c.at).toLocaleString()} · ${c.commit.slice(0, 7)}` }),
        ]),
        button('Preview', () => { view = 'preview'; preview = { commit: c.commit, loading: true, subject: c.subject }; render(); send('preview', { commit: c.commit }); }),
      );
      list.append(row);
    }
    nodes.push(list);
    return nodes;
  }

  function renderPreview() {
    const p = preview || {};
    const nodes = [h('div', { display: 'flex', alignItems: 'center', gap: '8px', margin: '6px 0' }, null, [
      button('← History', () => { view = 'history'; render(); }),
      text(p.commit ? p.commit.slice(0, 7) : '', muted),
    ])];
    if (p.subject) nodes.push(h('div', { marginBottom: '6px' }, { textContent: p.subject }));
    if (p.loading) {
      nodes.push(text('Comparing with this machine…', muted));
      return nodes;
    }
    const changes = p.changes || [];
    if (changes.length === 0) {
      nodes.push(text('This machine already matches that sync.', muted));
      return nodes;
    }
    nodes.push(h('div', { marginBottom: '4px' }, { textContent: `Restore sets ${changes.length} item${changes.length === 1 ? '' : 's'} on this machine back to that sync, then sends ${changes.length === 1 ? 'it' : 'them'} to your other machines:` }));
    const list = h('div', { maxHeight: '220px', overflowY: 'auto', ...muted, userSelect: 'text' });
    for (const c of changes) list.append(h('div', null, { textContent: `${c.removed ? '− ' : '• '}${label(c.id)}` }));
    nodes.push(list);
    nodes.push(h('div', { display: 'flex', gap: '6px', marginTop: '10px' }, null, [
      button('Restore', () => { send('restore', { commit: p.commit }); view = 'main'; render(); }, { fontWeight: '600', borderColor: COLORS.warn }),
      button('Cancel', () => { view = 'history'; render(); }),
    ]));
    return nodes;
  }

  function render() {
    if (!panel) return;
    head.replaceChildren(h('div', { fontWeight: '600', fontSize: '13px' }, { textContent: 'Settings Sync' }), statusPill(), closeBtn);
    const active = document.activeElement;
    const typing = active && panel.contains(active) && active.tagName === 'INPUT' && active.type === 'text';
    if (typing && view === 'main') return; // do not wipe what the user is typing; the next update catches up
    body.replaceChildren(...(view === 'history' ? renderHistory() : view === 'preview' ? renderPreview() : renderMain()));
  }

  let head = null;
  let closeBtn = null;
  function open(s) {
    if (s) status = s;
    if (panel) { render(); return; }
    panel = h('div', {
      position: 'fixed', right: '16px', bottom: '40px', width: '380px', maxHeight: '75vh', overflowY: 'auto',
      zIndex: '60', boxSizing: 'border-box', padding: '12px 14px 10px', borderRadius: '10px',
      background: 'var(--popover, #1c1c1c)', color: 'var(--popover-foreground, #e5e5e5)',
      border: '1px solid var(--border, #333)', boxShadow: '0 12px 40px rgba(0,0,0,.45)',
      fontSize: '12px', lineHeight: '1.45',
    });
    panel.id = 'orca-settings-sync-panel';
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-label', 'Settings Sync');
    panel.setAttribute('data-terminal-focus-release-surface', 'true');
    closeBtn = button('×', close, { border: 'none', fontSize: '16px', lineHeight: '1', padding: '2px 6px', marginLeft: 'auto' });
    closeBtn.title = 'Close (Esc)';
    head = h('div', { display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '2px' });
    body = h('div');
    panel.append(head, body);
    panel.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { e.preventDefault(); close(); }
      e.stopPropagation(); // typing in the panel must not trigger Orca shortcuts
    });
    returnFocus = document.activeElement;
    document.body.appendChild(panel);
    view = 'main';
    render();
    send('refresh');
    ticker = setInterval(() => { if (view === 'main') render(); }, 15_000); // keep "x min ago" fresh
    const first = panel.querySelector('input[type=text]');
    if (first && !status?.config?.repoUrl) first.focus();
    else closeBtn.focus();
  }

  function close() {
    if (!panel) return;
    clearInterval(ticker);
    const active = document.activeElement;
    const hadFocus = !active || active === document.body || panel.contains(active);
    panel.remove();
    panel = null;
    if (toastBox) toastBox.style.bottom = '40px';
    if (hadFocus && returnFocus instanceof HTMLElement && returnFocus.isConnected) returnFocus.focus({ preventScroll: true });
    returnFocus = null;
  }

  function toggle(s) {
    if (panel) close();
    else open(s);
  }

  // ---- status bar item: "Last sync 2m ago", click opens the panel ----
  // Sits first in the right-hand group of Orca's status bar (before "Off", memory, terminals) and
  // borrows the classes of the Resource Manager button there, so it looks like Orca's own items.
  // React may re-create the bar (status bar toggled, layout change): a timer puts the item back.

  const ITEM_ID = 'orca-settings-sync-statusbar';
  const ITEM_CLASS = 'relative inline-flex items-center gap-1.5 cursor-pointer rounded px-1 py-0.5 hover:bg-accent/70';
  const LABEL_CLASS = 'text-[11px] font-medium tabular-nums text-muted-foreground';
  const SVG = 'http://www.w3.org/2000/svg';
  let item = null;
  let itemIcon = null;
  let itemLabel = null;

  function statusBarGroup() {
    const resources = document.querySelector('button[aria-label^="Resource Manager"]');
    if (resources?.parentElement) return resources.parentElement;
    const usage = document.querySelector('.status-bar-usage-cluster');
    const group = usage?.nextElementSibling?.firstElementChild;
    return group && group.tagName === 'DIV' ? group : null;
  }

  function shortAgo(at) {
    const s = Math.max(0, Math.round((Date.now() - at) / 1000));
    if (s < 45) return 'just now';
    if (s < 3600) return `${Math.max(1, Math.round(s / 60))}m ago`;
    if (s < 86400) return `${Math.round(s / 3600)}h ago`;
    return `${Math.round(s / 86400)}d ago`;
  }

  function syncIcon() {
    // two arrows in a circle (lucide "refresh-cw"), drawn with the text colour
    const svg = document.createElementNS(SVG, 'svg');
    for (const [k, v] of Object.entries({ width: '12', height: '12', viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': '2', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' })) svg.setAttribute(k, v);
    for (const d of ['M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8', 'M21 3v5h-5', 'M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16', 'M8 16H3v5']) {
      const p = document.createElementNS(SVG, 'path');
      p.setAttribute('d', d);
      svg.append(p);
    }
    return svg;
  }

  function makeItem(group) {
    const sample = group.querySelector('button[aria-label^="Resource Manager"]');
    const b = document.createElement('button');
    b.type = 'button';
    b.id = ITEM_ID;
    b.className = sample?.className || ITEM_CLASS;
    b.setAttribute('aria-label', 'Settings Sync');
    Object.assign(b.style, { background: b.className ? '' : 'transparent', border: 'none', color: 'inherit', font: 'inherit' });
    itemIcon = syncIcon();
    itemLabel = document.createElement('span');
    itemLabel.className = sample?.querySelector('span.tabular-nums')?.className || LABEL_CLASS;
    b.append(itemIcon, itemLabel);
    // Keep the keyboard where it was (terminal/editor), so closing the panel gives it back.
    b.addEventListener('mousedown', (e) => e.preventDefault());
    b.addEventListener('click', () => toggle(status));
    return b;
  }

  function refreshItem() {
    if (!item) return;
    const s = status;
    const cfg = s?.config || {};
    let text;
    let color = '';
    if (!s) text = 'Settings Sync';
    else if (!cfg.repoUrl) { text = 'Sync: set up'; color = COLORS.warn; }
    else if (s.awaitingChoice) { text = 'Sync: choose'; color = COLORS.warn; }
    else if (s.running) text = 'Syncing…';
    else if (s.lastSync && !s.lastSync.ok) { text = 'Sync failed'; color = COLORS.error; }
    else if (s.lastSync) { text = `Last sync ${shortAgo(s.lastSync.at)}`; if (s.lastSync.failed?.length) color = COLORS.warn; }
    else text = 'Not synced yet';
    if (itemLabel.textContent !== text) itemLabel.textContent = text;
    itemIcon.style.color = color;
    itemIcon.style.animation = s?.running ? 'spin 1s linear infinite' : '';
    const ls = s?.lastSync;
    item.title = [
      'Settings Sync',
      cfg.repoUrl ? `Repo: ${cfg.repoUrl}` : 'No sync repo yet',
      cfg.machineName ? `This machine: ${cfg.machineName}` : null,
      ls ? `Last sync: ${new Date(ls.at).toLocaleString()}${ls.ok ? ` · ↓${ls.applied.length} ↑${ls.pushed.length}` : ` · ${ls.error}`}` : null,
      `Click to open (${SHORTCUT})`,
    ].filter(Boolean).join('\n');
  }

  function keepItem() {
    const group = statusBarGroup();
    if (!group) return;
    if (!item) item = makeItem(group);
    if (item.parentElement !== group || group.firstElementChild !== item) group.prepend(item);
    refreshItem();
  }

  keepItem();
  const keeper = setInterval(keepItem, 2000);
  send('refresh'); // get the status for the item now, not only when the panel opens

  window[KEY] = {
    version: VERSION,
    update(s) {
      status = s;
      refreshItem();
      if (panel && view === 'main') render();
    },
    open,
    close,
    toggle,
    toast,
    showHistory(list) { historyList = Array.isArray(list) ? list : []; if (view === 'history') render(); },
    showPreview(p) { if (view === 'preview' && preview?.commit === p?.commit) { preview = { ...preview, ...p, loading: false }; render(); } },
    debug: { get state() { return { open: Boolean(panel), view, status, historyList, preview, item: item?.isConnected ? item.textContent : null }; } },
    destroy() {
      clearInterval(keeper);
      item?.remove();
      item = null;
      close();
      toastBox?.remove();
      toastBox = null;
      if (window[KEY]?.version === VERSION) delete window[KEY];
    },
  };
})();
