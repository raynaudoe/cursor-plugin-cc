import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { parseLine } from './parse.mjs';
import { killTree, run } from './run.mjs';

// Convenience aliases that map shortcuts to real Cursor model ids. Cursor
// rotates these over time — `/cursor:setup --print-models` shows the live
// list for the current account. Unknown ids are passed through verbatim.
export const MODEL_ALIASES = {
  // Short shortcuts point at Cursor's current Composer line (2.5).
  composer: 'composer-2.5-fast',
  'composer-fast': 'composer-2.5-fast',
  fast: 'composer-2.5-fast',
  'composer-full': 'composer-2.5',
  // Current Composer ids (identity — also documents the live names).
  'composer-2.5-fast': 'composer-2.5-fast',
  'composer-2.5': 'composer-2.5',
  // Retired Composer ids kept as passthrough for older cursor-agent builds.
  'composer-2-fast': 'composer-2-fast',
  'composer-2': 'composer-2',
  'composer-1.5': 'composer-1.5',
  auto: 'auto',
  sonnet: 'claude-4.6-sonnet-medium',
  'sonnet-4.6': 'claude-4.6-sonnet-medium',
  'sonnet-4.6-thinking': 'claude-4.6-sonnet-medium-thinking',
  'sonnet-4.5': 'claude-4.5-sonnet',
  'sonnet-4.5-thinking': 'claude-4.5-sonnet-thinking',
  'sonnet-4': 'claude-4-sonnet',
  opus: 'claude-opus-4-7-high',
  'opus-4.7': 'claude-opus-4-7-high',
  'opus-4.7-max': 'claude-opus-4-7-max',
  'opus-4.7-thinking': 'claude-opus-4-7-thinking-high',
  'opus-4.6': 'claude-4.6-opus-high',
  gpt: 'gpt-5.3-codex',
  codex: 'gpt-5.3-codex',
  'gpt-5.3-codex': 'gpt-5.3-codex',
  'gpt-5.3-codex-fast': 'gpt-5.3-codex-fast',
  'gpt-5.3-codex-high': 'gpt-5.3-codex-high',
  'gpt-5.2': 'gpt-5.2',
  // Grok ids are namespaced `cursor-` upstream. Without that prefix cursor-agent
  // rejects the run, so the bare `grok-*` spellings must never be emitted.
  grok: 'cursor-grok-4.5-high',
  'grok-4.5': 'cursor-grok-4.5-high',
  'grok-4.5-high': 'cursor-grok-4.5-high',
  'grok-4.5-fast': 'cursor-grok-4.5-high-fast',
  'grok-4.5-medium': 'cursor-grok-4.5-medium',
  'grok-4.5-low': 'cursor-grok-4.5-low',
  gemini: 'gemini-3.1-pro',
  'gemini-pro': 'gemini-3.1-pro',
  'gemini-flash': 'gemini-3.6-flash-high',
};

// `auto` lets Cursor pick whatever model the account is entitled to —
// safe default for users without a paid Composer seat. Power users
// can override per-invocation via `--model <id>` or globally via the env var
// CURSOR_PLUGIN_CC_DEFAULT_MODEL.
export const DEFAULT_MODEL = 'auto';

/**
 * @returns {string}
 */
export function defaultModel() {
  const fromEnv = process.env.CURSOR_PLUGIN_CC_DEFAULT_MODEL;
  if (fromEnv && fromEnv.trim().length > 0) {
    const key = fromEnv.trim().toLowerCase();
    return MODEL_ALIASES[key] ?? fromEnv.trim();
  }
  return DEFAULT_MODEL;
}

/**
 * @param {string|undefined} input
 * @returns {string}
 */
export function resolveModel(input) {
  if (!input || input.trim() === '') return defaultModel();
  const key = input.trim().toLowerCase();
  return MODEL_ALIASES[key] ?? input.trim();
}

/** @type {string|null} */
let cachedBin = null;

/**
 * @returns {Promise<string>}
 */
export async function resolveBin() {
  // The override costs nothing to read, so never cache it: caching would make
  // the env var read-once-per-process and the result depend on call order.
  const override = process.env.CURSOR_AGENT_BIN?.trim();
  if (override) return override;
  if (cachedBin) return cachedBin;
  for (const candidate of ['cursor-agent', 'agent']) {
    const res = await run('which', [candidate]);
    if (res.exitCode === 0 && res.stdout.trim()) {
      cachedBin = res.stdout.trim();
      return cachedBin;
    }
  }
  throw new Error(
    'cursor-agent not found on PATH. Install from https://cursor.com/install or run /cursor:setup.',
  );
}

/**
 * @typedef {Object} BuildArgsInput
 * @property {string} prompt
 * @property {string} model
 * @property {string=} resumeChatId
 * @property {boolean=} resumeLatest
 * @property {boolean=} readOnly          Blocks edits. Wins over `force`.
 * @property {boolean=} force             Default: true.
 */

/**
 * @param {BuildArgsInput} opts
 * @returns {string[]}
 */
export function buildArgs(opts) {
  const args = [
    '-p',
    '--output-format',
    'stream-json',
    // Finer-grained events so phase reporting can move while the agent works.
    '--stream-partial-output',
    '--trust',
    '--model',
    opts.model,
  ];
  if (opts.readOnly) {
    // Verified against cursor-agent 2026.07.23:
    //   --mode ask      writes blocked, final answer in the `result` event.
    //   --mode plan     writes blocked, but the answer is delivered as a
    //                   `createPlanToolCall` payload and `result` carries only
    //                   narration — the run looks empty to every consumer.
    //   --sandbox enabled  writes ALLOWED. Governs command execution, not edits.
    // So `ask` is the only mode that is both safe and readable. `--force` would
    // override it, which is why a read-only run must never pass it.
    args.push('--mode', 'ask');
  } else if (opts.force !== false) {
    args.push('--force');
  }
  if (opts.resumeChatId) args.push(`--resume=${opts.resumeChatId}`);
  // `--resume` takes an OPTIONAL chat id, so a bare `--resume` immediately
  // followed by the positional prompt swallows the prompt. `--continue` is the
  // boolean form and cannot.
  else if (opts.resumeLatest) args.push('--continue');
  args.push(opts.prompt);
  return args;
}

/**
 * @typedef {Object} DelegateOpts
 * @property {string} prompt
 * @property {string} model
 * @property {string=} resumeChatId
 * @property {boolean=} resumeLatest
 * @property {boolean=} readOnly
 * @property {boolean=} force
 * @property {string=} cwd
 * @property {number=} timeoutSec
 * @property {string} logPath
 * @property {(ev: Record<string, unknown>) => void=} onEvent
 * @property {(line: string) => void=} onRaw
 * @property {(pid: number) => void=} onSpawn
 */

/**
 * @typedef {Object} DelegateResult
 * @property {number} exitCode
 * @property {Record<string, unknown>[]} events
 * @property {boolean} killed             Killed by the timeout watchdog (abnormal).
 * @property {boolean} reaped             Reaped after emitting its result (normal).
 * @property {number=} pid
 */

/**
 * @param {DelegateOpts} opts
 * @returns {Promise<DelegateResult>}
 */
export async function runHeadless(opts) {
  const bin = await resolveBin();
  const args = buildArgs(opts);
  const child = spawn(bin, args, {
    cwd: opts.cwd ?? process.cwd(),
    stdio: ['ignore', 'pipe', 'pipe'],
    env: process.env,
    // Lead its own process group so cancellation can signal the whole tree —
    // cursor-agent shells out to run tests and builds, and those grandchildren
    // survive a bare pid kill.
    detached: process.platform !== 'win32',
    windowsHide: true,
  });
  if (typeof child.pid === 'number' && opts.onSpawn) opts.onSpawn(child.pid);
  if (!child.stdout || !child.stderr) {
    throw new Error('cursor-agent spawn failed: stdout/stderr not attached');
  }
  const childStdout = child.stdout;
  const childStderr = child.stderr;
  const logStream = createWriteStream(opts.logPath, { flags: 'a' });
  // A failed log write (ENOSPC/EACCES/missing dir) must not crash the process
  // and orphan the running cursor-agent — degrade to in-memory only.
  let logBroken = false;
  logStream.on('error', () => {
    logBroken = true;
  });
  const logSafe = (s) => {
    if (logBroken) return;
    try {
      logStream.write(s);
    } catch {
      logBroken = true;
    }
  };
  /** @type {Record<string, unknown>[]} */
  const events = [];
  let sawResult = false;
  let killed = false;
  let reaped = false;
  const signalTree = (signal) => {
    if (child.killed || child.exitCode !== null) return;
    try {
      killTree(child.pid, signal);
    } catch {
      // noop — the process may have exited between the check and the signal.
    }
  };

  const stdoutLines = createInterface({ input: childStdout, crlfDelay: Infinity });
  stdoutLines.on('line', (line) => {
    logSafe(line + '\n');
    if (opts.onRaw) opts.onRaw(line);
    const ev = parseLine(line);
    if (!ev) return;
    events.push(ev);
    if (opts.onEvent) opts.onEvent(ev);
    // Arm the post-result watchdog at most once — cursor-agent can emit
    // several `result` events, and re-arming would stack redundant timers.
    if (ev.type === 'result' && !sawResult) {
      sawResult = true;
      setTimeout(() => {
        if (!child.killed && child.exitCode === null) {
          // The run already delivered its result; this is a normal reap of a
          // lingering process, NOT a failure. Tracked separately from `killed`
          // so it cannot flip a successful job to `failed`.
          reaped = true;
          signalTree('SIGTERM');
          setTimeout(() => signalTree('SIGKILL'), 5_000);
        }
      }, 5_000);
    }
  });

  const stderrLines = createInterface({ input: childStderr, crlfDelay: Infinity });
  stderrLines.on('line', (line) => {
    logSafe(`# stderr: ${line}\n`);
  });

  let timeoutHandle;
  if (typeof opts.timeoutSec === 'number' && opts.timeoutSec > 0) {
    timeoutHandle = setTimeout(() => {
      killed = true;
      signalTree('SIGTERM');
      setTimeout(() => signalTree('SIGKILL'), 5_000);
    }, opts.timeoutSec * 1_000);
  }

  const exitCode = await new Promise((resolve) => {
    let settled = false;
    const done = (code) => {
      if (settled) return;
      settled = true;
      resolve(code);
    };
    // Without an 'error' handler a spawn failure (missing/non-executable
    // binary) emits an uncaught exception that kills the process.
    child.on('error', (err) => {
      logSafe(`# spawn error: ${err instanceof Error ? err.message : String(err)}\n`);
      done(sawResult ? 0 : 1);
    });
    child.on('close', (code) => {
      done(typeof code === 'number' ? code : sawResult ? 0 : 1);
    });
  });
  if (timeoutHandle) clearTimeout(timeoutHandle);
  await new Promise((resolve) => {
    try {
      logStream.end(() => resolve());
    } catch {
      resolve();
    }
  });
  return { exitCode, events, killed, reaped, pid: child.pid };
}

/**
 * @returns {Promise<{loggedIn: boolean, detail: string}>}
 */
export async function authStatus() {
  try {
    const bin = await resolveBin();
    const res = await run(bin, ['status'], { timeoutMs: 5_000 });
    const text = `${res.stdout}\n${res.stderr}`.toLowerCase();
    const loggedIn =
      res.exitCode === 0 &&
      (text.includes('logged in') || text.includes('authenticated') || text.includes('signed in'));
    return {
      loggedIn,
      detail: `${res.stdout}${res.stderr ? `\n${res.stderr}` : ''}`.trim(),
    };
  } catch (err) {
    return { loggedIn: false, detail: String(err) };
  }
}

/**
 * @returns {Promise<string[]>}
 */
export async function listModels() {
  try {
    const bin = await resolveBin();
    const res = await run(bin, ['--list-models'], { timeoutMs: 10_000 });
    if (res.exitCode !== 0) {
      const fallback = await run(bin, ['models'], { timeoutMs: 10_000 });
      // An unknown-subcommand usage banner on stdout is not a model list.
      if (fallback.exitCode !== 0) return [];
      return fallback.stdout
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean);
    }
    return res.stdout
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * @typedef {Object} McpEntry
 * @property {string} name
 * @property {string} status
 * @property {boolean} loaded
 */

/**
 * @returns {Promise<McpEntry[]>}
 */
export async function listConfiguredMcps() {
  try {
    const bin = await resolveBin();
    const res = await run(bin, ['mcp', 'list'], { timeoutMs: 5_000 });
    if (res.exitCode !== 0) return [];
    // Strip ANSI control sequences — cursor-agent writes them even under `run`.
    // eslint-disable-next-line no-control-regex
    const text = res.stdout.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');
    /** @type {McpEntry[]} */
    const out = [];
    for (const raw of text.split('\n')) {
      const line = raw.trim();
      if (!line || line.startsWith('Loading')) continue;
      const match = line.match(/^([^:\s]+):\s*(.+)$/);
      if (!match) continue;
      const name = match[1];
      const status = match[2].trim();
      const lower = status.toLowerCase();
      const loaded = lower.startsWith('loaded') || lower === 'ok' || lower.includes('approved');
      out.push({ name, status, loaded });
    }
    return out;
  } catch {
    return [];
  }
}
