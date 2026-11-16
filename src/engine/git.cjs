'use strict';
// Thin wrapper over the system `git`, so any host works (GitHub, GitLab, Gitea, a NAS, a bare repo
// on disk) with whatever credentials git already has (Git Credential Manager, SSH keys…).
// The clone is private to the plugin: we reset it to the remote before every sync, write the
// merged files, commit and push. Nobody edits it by hand, so there are never merge conflicts.
const { execFile } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const TIMEOUT_MS = 90_000;

class GitError extends Error {
  constructor(args, code, stderr) {
    super(`git ${args[0]} failed (${code}): ${String(stderr).trim().split('\n').slice(-3).join(' | ')}`);
    this.code = code;
    this.stderr = String(stderr);
  }
}

class Git {
  /** @param {{ dir: string, gitPath?: string, log?: (msg: string) => void }} o */
  constructor({ dir, gitPath = 'git', log = () => {} }) {
    this.dir = dir;
    this.gitPath = gitPath;
    this.log = log;
  }

  run(args, { allowFail = false, timeout = TIMEOUT_MS, env } = {}) {
    return new Promise((resolve, reject) => {
      execFile(this.gitPath, args, {
        cwd: this.dir,
        timeout,
        windowsHide: true, // Orca is a GUI app: never flash a console window
        maxBuffer: 32 * 1024 * 1024,
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', LC_ALL: 'C', ...env },
      }, (err, stdout, stderr) => {
        const code = err ? (typeof err.code === 'number' ? err.code : -1) : 0;
        if (err && !allowFail) return reject(new GitError(args, err.killed ? 'timeout' : code, stderr || err.message));
        resolve({ code, stdout: String(stdout), stderr: String(stderr) });
      });
    });
  }

  /** Creates the clone on first use and points `origin` at `url`. */
  async prepare(url, branch) {
    fs.mkdirSync(this.dir, { recursive: true });
    if (!fs.existsSync(path.join(this.dir, '.git'))) {
      await this.run(['init', '-q']);
      await this.run(['symbolic-ref', 'HEAD', `refs/heads/${branch}`]);
    }
    const current = await this.run(['remote', 'get-url', 'origin'], { allowFail: true });
    if (current.code !== 0) await this.run(['remote', 'add', 'origin', url]);
    else if (current.stdout.trim() !== url) await this.run(['remote', 'set-url', 'origin', url]);
    await this.run(['config', 'core.autocrlf', 'false']);
    await this.run(['config', 'core.quotepath', 'false']);
    await this.run(['config', 'commit.gpgsign', 'false']);
  }

  /**
   * Fetches `branch` and makes the working tree exactly the remote's. Returns the remote commit, or
   * null when the remote has no such branch yet (new, empty repo).
   */
  async fetchAndReset(branch) {
    const fetched = await this.run(
      ['fetch', '--quiet', '--no-tags', 'origin', `+refs/heads/${branch}:refs/remotes/origin/${branch}`],
      { allowFail: true },
    );
    if (fetched.code !== 0) {
      if (!/couldn't find remote ref/i.test(fetched.stderr)) throw new GitError(['fetch'], fetched.code, fetched.stderr);
      // Empty remote: start from nothing (drop any unpushed local commit; we rebuild from Orca anyway).
      await this.run(['symbolic-ref', 'HEAD', `refs/heads/${branch}`]);
      await this.run(['update-ref', '-d', `refs/heads/${branch}`], { allowFail: true });
      await this.run(['update-ref', '-d', `refs/remotes/origin/${branch}`], { allowFail: true });
      await this.run(['read-tree', '--empty']);
      await this.run(['clean', '-fdxq']);
      return null;
    }
    await this.run(['checkout', '-q', '--force', '-B', branch, `refs/remotes/origin/${branch}`]);
    await this.run(['reset', '-q', '--hard', `refs/remotes/origin/${branch}`]);
    await this.run(['clean', '-fdxq']);
    return (await this.run(['rev-parse', 'HEAD'])).stdout.trim();
  }

  /** Commits everything in the working tree. Returns the new commit, or null when nothing changed. */
  async commitAll(message, { name, email }) {
    await this.run(['add', '-A']);
    const diff = await this.run(['diff', '--cached', '--quiet'], { allowFail: true });
    if (diff.code === 0) return null;
    await this.run(['-c', `user.name=${name}`, '-c', `user.email=${email}`, 'commit', '-q', '--no-verify', '-m', message]);
    return (await this.run(['rev-parse', 'HEAD'])).stdout.trim();
  }

  /** Pushes HEAD to `branch`. Returns { ok } or { ok: false, rejected: true } when someone pushed first. */
  async push(branch) {
    const res = await this.run(['push', '--quiet', '--porcelain', 'origin', `HEAD:refs/heads/${branch}`], { allowFail: true });
    if (res.code === 0) return { ok: true };
    const text = `${res.stdout}\n${res.stderr}`;
    // "fetch first" from hosts; "cannot lock ref" when two pushes hit a repo on disk at once.
    if (/\[rejected\]|non-fast-forward|fetch first|stale info|cannot lock ref|failed to update ref|\[remote rejected\]/i.test(text)) {
      return { ok: false, rejected: true };
    }
    throw new GitError(['push'], res.code, res.stderr || res.stdout);
  }

  /** Recent commits of the synced branch: [{ commit, at, subject }] */
  async history(branch, limit = 30) {
    const res = await this.run(
      ['log', `--max-count=${limit}`, '--format=%H%x1f%ct%x1f%s', `refs/remotes/origin/${branch}`],
      { allowFail: true },
    );
    if (res.code !== 0) return [];
    return res.stdout.split('\n').filter(Boolean).map((line) => {
      const [commit, ct, subject] = line.split('\x1f');
      return { commit, at: Number(ct) * 1000, subject };
    });
  }

  /** Writes the files of `commit` into `dest` (for previews and restores), leaving the clone untouched. */
  async exportCommit(commit, dest) {
    if (!/^[0-9a-f]{7,64}$/i.test(commit)) throw new Error(`not a commit id: ${commit}`);
    fs.rmSync(dest, { recursive: true, force: true });
    fs.mkdirSync(dest, { recursive: true });
    const index = path.join(this.dir, '.git', `export-${process.pid}.index`);
    try {
      await this.run(['--work-tree', dest, 'checkout', '-q', commit, '--', '.'], { env: { GIT_INDEX_FILE: index } });
    } finally {
      fs.rmSync(index, { force: true });
    }
  }
}

module.exports = { Git, GitError };
