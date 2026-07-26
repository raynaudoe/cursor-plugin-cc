// Thin Promise wrapper around child_process.spawn with:
//   - no throw on non-zero exit (resolve with exitCode)
//   - optional timeout (SIGTERM, then SIGKILL after 5 s grace)
//   - stdout/stderr captured as strings
//
// Replaces the subset of `execa` that this plugin actually uses.

import { spawn, spawnSync } from 'node:child_process';

/**
 * Signal a process AND everything it spawned.
 *
 * `cursor-agent` shells out to run tests and build commands, so signalling only
 * the direct child leaves those grandchildren running. On POSIX we signal the
 * negative pid (the process group), which requires the child to have been
 * spawned with `detached: true` so that it leads its own group. Windows has no
 * process groups, so `taskkill /T` is the only reliable tree kill there.
 *
 * @param {number|undefined} pid
 * @param {NodeJS.Signals} [signal]
 * @returns {boolean}   True when a signal was actually delivered.
 */
export function killTree(pid, signal = 'SIGTERM') {
  if (typeof pid !== 'number' || !Number.isFinite(pid) || pid <= 0) return false;
  if (process.platform === 'win32') {
    const res = spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true });
    return res.status === 0;
  }
  try {
    process.kill(-pid, signal);
    return true;
  } catch (err) {
    // ESRCH on the group means it was never a group leader (or is already gone);
    // fall back to the bare pid so a non-detached child is still signalled.
    if (err?.code !== 'ESRCH') throw err;
    try {
      process.kill(pid, signal);
      return true;
    } catch {
      return false;
    }
  }
}

/**
 * @typedef {Object} RunOpts
 * @property {string=} cwd
 * @property {number=} timeoutMs          Kill the child after this many ms.
 * @property {NodeJS.ProcessEnv=} env
 */

/**
 * @typedef {Object} RunResult
 * @property {string} stdout
 * @property {string} stderr
 * @property {number} exitCode            -1 if we killed on timeout.
 * @property {boolean} timedOut
 */

/**
 * @param {string} cmd
 * @param {string[]} args
 * @param {RunOpts} [opts]
 * @returns {Promise<RunResult>}
 */
export function run(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, {
      cwd: opts.cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: opts.env ?? process.env,
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    if (child.stdout) {
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (d) => {
        stdout += d;
      });
    }
    if (child.stderr) {
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (d) => {
        stderr += d;
      });
    }
    let timeout;
    let killTimeout;
    if (typeof opts.timeoutMs === 'number' && opts.timeoutMs > 0) {
      timeout = setTimeout(() => {
        timedOut = true;
        try {
          child.kill('SIGTERM');
        } catch {
          // noop
        }
        killTimeout = setTimeout(() => {
          try {
            child.kill('SIGKILL');
          } catch {
            // noop
          }
        }, 5_000);
      }, opts.timeoutMs);
    }
    child.on('error', (err) => {
      if (timeout) clearTimeout(timeout);
      if (killTimeout) clearTimeout(killTimeout);
      resolve({
        stdout,
        stderr: stderr || String(err?.message ?? err ?? 'spawn error'),
        exitCode: -1,
        timedOut,
      });
    });
    child.on('close', (code) => {
      if (timeout) clearTimeout(timeout);
      if (killTimeout) clearTimeout(killTimeout);
      resolve({
        stdout,
        stderr,
        exitCode: typeof code === 'number' ? code : timedOut ? -1 : 1,
        timedOut,
      });
    });
  });
}
