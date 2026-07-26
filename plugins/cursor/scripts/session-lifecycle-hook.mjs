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

async function reapSessionJobs(cwd, sessionId) {
  if (!sessionId) return;
  if (!(await isGitRepo(cwd))) return;
  const root = await repoRoot(cwd);
  for (const job of listJobs(root)) {
    if (job.sessionId !== sessionId) continue;
    if (!isActiveStatus(job.status)) continue;
    // cursor-agent leads its own process group, so this also reaps the shell
    // commands it spawned. The worker is signalled by bare pid: group-signalling
    // it could reach processes we do not own.
    if (typeof job.agentPid === 'number') {
      try {
        killTree(job.agentPid, 'SIGTERM');
      } catch {
        // Already gone.
      }
    }
    // `job.pid > 0` is load-bearing: a failed spawn can persist a non-positive
    // pid, and process.kill(-1, sig) broadcasts to every process this user owns.
    if (
      Number.isInteger(job.pid) &&
      job.pid > 0 &&
      job.background === true &&
      job.pid !== process.pid
    ) {
      try {
        process.kill(job.pid, 'SIGTERM');
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
