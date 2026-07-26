#!/usr/bin/env node
// Session lifecycle for Cursor jobs.
//
// SessionStart publishes the Claude session id into the environment shared by
// every later companion invocation, so jobs can be stamped with it. Without that
// stamp `/cursor:status` shows every job ever recorded for the repository, from
// every terminal and every past session.
//
// SessionEnd reaps whatever is still running. Background workers are spawned
// detached, so nothing else would ever stop them — they outlive Claude Code and
// keep burning Cursor quota against a session that no longer exists.
import { appendFileSync, readFileSync } from 'node:fs';
import { isGitRepo, repoRoot } from './lib/git.mjs';
import { isActiveStatus, listJobs, SESSION_ID_ENV, updateJob } from './lib/jobs.mjs';
import { killTree } from './lib/run.mjs';

function readHookInput() {
  try {
    const raw = readFileSync(0, 'utf8').trim();
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function shellEscape(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function publishSessionId(sessionId) {
  const envFile = process.env.CLAUDE_ENV_FILE;
  if (!envFile || !sessionId) return;
  appendFileSync(envFile, `export ${SESSION_ID_ENV}=${shellEscape(sessionId)}\n`, 'utf8');
}

// SIGTERM is only a request. Anything still alive after a short grace gets
// SIGKILL, mirroring cancelJob — otherwise a process that ignores SIGTERM keeps
// consuming quota while its now-terminal record blocks any later cleanup.
const KILL_GRACE_MS = 2_000;

async function escalate(pids) {
  if (pids.length === 0) return;
  await new Promise((resolve) => setTimeout(resolve, KILL_GRACE_MS));
  for (const pid of pids) {
    try {
      process.kill(pid, 0);
    } catch {
      continue; // Already exited.
    }
    try {
      killTree(pid, 'SIGKILL');
    } catch {
      // Raced with exit.
    }
  }
}

async function reapSessionJobs(cwd, sessionId) {
  if (!sessionId) return;
  if (!(await isGitRepo(cwd))) return;
  const root = await repoRoot(cwd);
  /** @type {number[]} */
  const pendingKills = [];
  for (const job of listJobs(root)) {
    if (job.sessionId !== sessionId) continue;
    if (!isActiveStatus(job.status)) continue;
    // Both pids lead their own process group — cursor-agent via runHeadless and
    // the worker via spawnWorker, each spawned detached — so group-signalling
    // reaps the shell commands they spawned without reaching anything we do not
    // own. SIGTERM here is a request; escalate() SIGKILLs whatever survives.
    //
    // `pid > 0` is load-bearing throughout: a failed spawn can persist a
    // non-positive pid, and process.kill(-1, sig) broadcasts to every process
    // this user owns.
    if (Number.isInteger(job.agentPid) && job.agentPid > 0) {
      try {
        killTree(job.agentPid, 'SIGTERM');
        pendingKills.push(job.agentPid);
      } catch {
        // Already gone.
      }
    }
    if (
      Number.isInteger(job.pid) &&
      job.pid > 0 &&
      job.background === true &&
      job.pid !== process.pid
    ) {
      try {
        process.kill(job.pid, 'SIGTERM');
        pendingKills.push(job.pid);
      } catch {
        // Already gone.
      }
    }
    updateJob(root, job.id, {
      status: 'cancelled',
      finishedAt: new Date().toISOString(),
      phase: 'cancelled',
      summary: 'Cancelled because the Claude Code session ended.',
    });
  }
  await escalate(pendingKills);
}

async function main() {
  const input = readHookInput();
  const event = process.argv[2] ?? input.hook_event_name ?? '';
  const sessionId = input.session_id ?? process.env[SESSION_ID_ENV] ?? null;

  if (event === 'SessionStart') {
    publishSessionId(sessionId);
    return;
  }
  if (event === 'SessionEnd') {
    await reapSessionJobs(input.cwd || process.cwd(), sessionId);
  }
}

// A hook must never break the session it is attached to.
main().catch(() => {
  process.exitCode = 0;
});
