// Runs an expression in Orca's main process. Orca's plugin API v1 gives plugins no way to read or
// change settings, keybindings or other plugins, so this uses the standard Node debug hook:
// `process._debugProcess(pid)` asks Orca's main process to open its inspector on 127.0.0.1:9229
// (what VS Code's "attach to process" does). We connect, check that the inspector really belongs
// to that pid and is Electron's main process, evaluate, and close the inspector again.
// Same plumbing as the Dim Unfocused Panes plugin.
const INSPECTOR = 'http://127.0.0.1:9229';
const CALL_TIMEOUT_MS = 120_000;

/** Evaluates `expression` (may return a promise) in Orca main process `pid`; returns its JSON value. */
export async function evaluateInOrca(pid, expression) {
  try {
    return await withOrcaInspector(pid, (session) => session.evaluate(expression));
  } catch (err) {
    if (err.code !== 'RETRYABLE') throw err;
    await sleep(600); // another client was closing the inspector at the same moment
    return withOrcaInspector(pid, (session) => session.evaluate(expression));
  }
}

async function withOrcaInspector(pid, fn) {
  let session = await connectIfOwnedBy(pid);
  const openedByUs = !session;
  if (!session) {
    try {
      process._debugProcess(pid);
    } catch (err) {
      throw new Error(`cannot signal Orca main process ${pid}: ${err.message}`);
    }
    session = await waitForInspector(pid);
  }
  try {
    return await fn(session);
  } finally {
    if (openedByUs) await session.closeInspector();
    session.close();
  }
}

async function listTargets() {
  try {
    const res = await fetch(`${INSPECTOR}/json/list`, { signal: AbortSignal.timeout(1000) });
    return res.ok ? await res.json() : null;
  } catch {
    return null;
  }
}

// Returns a session only if the inspector on 9229 is Orca's main process `pid`.
async function connectIfOwnedBy(pid) {
  const targets = await listTargets();
  const target = targets?.find((t) => t.type === 'node' && t.webSocketDebuggerUrl);
  if (!target) return null;
  const session = await Session.connect(target.webSocketDebuggerUrl);
  const who = await session.evaluate('({ pid: process.pid, type: process.type })').catch(() => null);
  if (who && who.pid === pid && who.type === 'browser') return session;
  if (who && who.pid === pid) {
    await session.closeInspector();
    session.close();
    throw fatal(`process ${pid} is not Orca's Electron main process (process.type=${who.type})`);
  }
  session.close();
  if (who) throw fatal(`port 9229 is used by another process (pid ${who.pid}); stop that debugger and retry`);
  return null;
}

async function waitForInspector(pid) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const session = await connectIfOwnedBy(pid).catch((err) => {
      if (err.fatal) throw err;
      return null;
    });
    if (session) return session;
    await sleep(100);
  }
  throw retryable(`Orca main process ${pid} did not open its inspector`);
}

class Session {
  static connect(url) {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      const timer = setTimeout(() => { ws.close(); reject(retryable('inspector websocket timed out')); }, 10_000);
      ws.onopen = () => { clearTimeout(timer); resolve(new Session(ws)); };
      ws.onerror = () => { clearTimeout(timer); reject(retryable('inspector websocket failed')); };
    });
  }

  constructor(ws) {
    this.ws = ws;
    this.nextId = 1;
    this.pending = new Map();
    ws.onmessage = (msg) => {
      const data = JSON.parse(msg.data);
      const p = data.id && this.pending.get(data.id);
      if (!p) return;
      this.pending.delete(data.id);
      clearTimeout(p.timer);
      if (data.error) p.reject(new Error(data.error.message));
      else p.resolve(data.result);
    };
    ws.onclose = () => {
      for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(retryable('inspector closed')); }
      this.pending.clear();
    };
  }

  send(method, params) {
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`${method} timed out`)); }, CALL_TIMEOUT_MS);
      this.pending.set(id, { resolve, reject, timer });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  async evaluate(expression) {
    const res = await this.send('Runtime.evaluate', { expression, includeCommandLineAPI: true, awaitPromise: true, returnByValue: true });
    if (res.exceptionDetails) {
      const ex = res.exceptionDetails.exception;
      throw new Error(ex?.description ?? ex?.value ?? res.exceptionDetails.text);
    }
    return res.result.value;
  }

  // Closing the inspector drops this socket, so there is no reply to wait for.
  async closeInspector() {
    if (this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify({
      id: this.nextId++,
      method: 'Runtime.evaluate',
      params: { expression: "process.getBuiltinModule('node:inspector').close()" },
    }));
    await sleep(150);
  }

  close() {
    try { this.ws.close(); } catch { /* already closed */ }
  }
}

function fatal(message) {
  const err = new Error(message);
  err.fatal = true;
  return err;
}

function retryable(message) {
  const err = new Error(message);
  err.code = 'RETRYABLE';
  return err;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** Orca main process ids, for the CLI (the plugin worker just uses process.ppid). */
export async function findOrcaMainPids() {
  const { execFileSync } = await import('node:child_process');
  if (process.platform === 'win32') {
    const ps = "Get-CimInstance Win32_Process -Filter \"Name='Orca.exe'\" | Select-Object ProcessId,ParentProcessId,CommandLine | ConvertTo-Json -Compress";
    const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { encoding: 'utf8' }).trim();
    if (!out) return [];
    const list = [].concat(JSON.parse(out));
    const orcaPids = new Set(list.map((p) => p.ProcessId));
    return list
      .filter((p) => p.CommandLine && !/--type=/.test(p.CommandLine) && !/\.(c|m)?js\b/i.test(p.CommandLine))
      .filter((p) => !orcaPids.has(p.ParentProcessId))
      .map((p) => p.ProcessId);
  }
  const out = execFileSync('ps', ['-axo', 'pid=,ppid=,command='], { encoding: 'utf8' });
  const rows = out.split('\n').map((l) => l.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/)).filter(Boolean)
    .map(([, pid, ppid, cmd]) => ({ pid: Number(pid), ppid: Number(ppid), cmd }));
  const isOrcaExe = (cmd) => /(^|\/)orca(\s|$)/i.test(cmd.split(/\s--/)[0]);
  const orca = rows.filter((r) => isOrcaExe(r.cmd));
  const orcaPids = new Set(orca.map((r) => r.pid));
  return orca.filter((r) => !/--type=/.test(r.cmd) && !/\.(c|m)?js\b/.test(r.cmd) && !orcaPids.has(r.ppid)).map((r) => r.pid);
}
