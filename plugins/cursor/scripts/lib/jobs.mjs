import {
  existsSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { ensureDir, jobsDir, logsDir } from './paths.mjs';
import { killTree } from './run.mjs';

// Set by the SessionStart hook via $CLAUDE_ENV_FILE. Jobs are stamped with it so
// `/cursor:status` and friends show this Claude session's work rather than every
// job ever recorded for the repository across every terminal.
export const SESSION_ID_ENV = 'CURSOR_COMPANION_SESSION_ID';

/**
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string|null}
 */
export function currentSessionId(env = process.env) {
  const raw = env[SESSION_ID_ENV];
  return typeof raw === 'string' && raw.trim().length > 0 ? raw.trim() : null;
}

/**
 * Narrow a job list to the current Claude session.
 *
 * Degrades to a no-op when the session id is unknown (hook not installed, or the
 * companion invoked directly from a shell). Records written before the hook
 * existed carry no `sessionId` and are always kept, so upgrading never hides a
 * user's existing jobs.
 *
 * @param {JobRecord[]} jobs
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {JobRecord[]}
 */
export function filterForSession(jobs, env = process.env) {
  const sessionId = currentSessionId(env);
  if (!sessionId) return jobs;
  return jobs.filter((job) => !job.sessionId || job.sessionId === sessionId);
}

/**
 * @typedef {'queued'|'running'|'completed'|'failed'|'cancelled'|'done'} JobStatus
 */

/**
 * @typedef {Object} JobRecord
 * @property {string} id
 * @property {string} repoPath
 * @property {string} prompt
 * @property {string} model
 * @property {string=} cursorChatId
 * @property {number=} pid
 * @property {number=} agentPid
 * @property {string=} sessionId
 * @property {JobStatus} status
 * @property {string=} kind
 * @property {string=} kindLabel
 * @property {'review'|'task'|'debate'|string=} jobClass
 * @property {string=} title
 * @property {string=} phase
 * @property {number=} exitCode
 * @property {string} startedAt
 * @property {string=} finishedAt
 * @property {string=} completedAt
 * @property {string} rawLogPath
 * @property {string=} summary
 * @property {string=} resultText
 * @property {string[]=} filesTouched
 * @property {boolean=} background
 * @property {boolean=} cancelSignalled
 * @property {Record<string, unknown>=} request
 */

/**
 * @typedef {Object} CreateJobInit
 * @property {string} id
 * @property {string} repoPath
 * @property {string} prompt
 * @property {string} model
 * @property {boolean=} background
 * @property {JobStatus=} status
 * @property {string=} kind
 * @property {string=} kindLabel
 * @property {'review'|'task'|'debate'|string=} jobClass
 * @property {string=} title
 * @property {string=} phase
 * @property {string=} summary
 * @property {string=} sessionId
 * @property {Record<string, unknown>=} request
 */

/**
 * @param {string} repoPath
 * @param {string} id
 */
export function jobFilePath(repoPath, id) {
  return join(jobsDir(repoPath), `${id}.json`);
}

/**
 * @param {string} repoPath
 * @param {string} id
 */
export function rawLogPath(repoPath, id) {
  return join(logsDir(repoPath), `${id}.ndjson`);
}

function atomicWrite(target, data) {
  const tmp = `${target}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, data, 'utf8');
  try {
    renameSync(tmp, target);
  } catch (err) {
    // Don't leave the temp file behind if the rename fails.
    try {
      unlinkSync(tmp);
    } catch {
      // noop
    }
    throw err;
  }
}

/**
 * @param {unknown} status
 * @returns {'queued'|'running'|'completed'|'failed'|'cancelled'}
 */
export function normalizeStatus(status) {
  if (
    status === 'queued' ||
    status === 'running' ||
    status === 'failed' ||
    status === 'cancelled'
  ) {
    return status;
  }
  if (status === 'done' || status === 'completed') return 'completed';
  return 'running';
}

/**
 * Whether a status means a process is still expected to own this job.
 *
 * @param {unknown} status
 * @returns {boolean}
 */
export function isActiveStatus(status) {
  return status === 'queued' || status === 'running';
}

/**
 * @param {unknown} record
 * @returns {JobRecord|null}
 */
export function normalizeJobRecord(record) {
  if (!record || typeof record !== 'object' || typeof record.id !== 'string') return null;
  const normalized = {
    ...record,
    status: normalizeStatus(record.status),
  };
  if (normalized.finishedAt && !normalized.completedAt)
    normalized.completedAt = normalized.finishedAt;
  if (normalized.completedAt && !normalized.finishedAt)
    normalized.finishedAt = normalized.completedAt;
  return normalized;
}

/**
 * @param {CreateJobInit} init
 * @returns {JobRecord}
 */
export function createJob(init) {
  ensureDir(jobsDir(init.repoPath));
  ensureDir(logsDir(init.repoPath));
  const sessionId = init.sessionId ?? currentSessionId();
  /** @type {JobRecord} */
  const record = {
    id: init.id,
    repoPath: init.repoPath,
    prompt: init.prompt,
    model: init.model,
    status: normalizeStatus(init.status ?? 'running'),
    startedAt: new Date().toISOString(),
    rawLogPath: rawLogPath(init.repoPath, init.id),
    ...(sessionId ? { sessionId } : {}),
    ...(init.background ? { background: true } : {}),
    ...(init.kind ? { kind: init.kind } : {}),
    ...(init.kindLabel ? { kindLabel: init.kindLabel } : {}),
    ...(init.jobClass ? { jobClass: init.jobClass } : {}),
    ...(init.title ? { title: init.title } : {}),
    ...(init.phase ? { phase: init.phase } : {}),
    ...(init.summary ? { summary: init.summary } : {}),
    ...(init.request ? { request: init.request } : {}),
  };
  atomicWrite(jobFilePath(init.repoPath, init.id), JSON.stringify(record, null, 2));
  return record;
}

/**
 * @param {string} repoPath
 * @param {string} id
 * @returns {JobRecord|null}
 */
export function readJob(repoPath, id) {
  const file = jobFilePath(repoPath, id);
  if (!existsSync(file)) return null;
  try {
    const raw = readFileSync(file, 'utf8');
    const parsed = JSON.parse(raw);
    return normalizeJobRecord(parsed);
  } catch {
    return null;
  }
}

/**
 * @param {string} repoPath
 * @param {string} id
 * @param {Partial<JobRecord>} patch
 * @returns {JobRecord|null}
 */
export function updateJob(repoPath, id, patch) {
  const existing = readJob(repoPath, id);
  if (!existing) return null;
  const normalizedPatch = {
    ...patch,
    ...(patch.status ? { status: normalizeStatus(patch.status) } : {}),
  };
  const merged = { ...existing, ...normalizedPatch };
  // Read-modify-write is last-writer-wins; the one race we actively guard is a
  // background worker finishing (status → done/failed) AFTER the user cancelled
  // the job. A cancellation is terminal and must not be silently overwritten.
  if (
    existing.status === 'cancelled' &&
    normalizedPatch.status &&
    normalizedPatch.status !== 'cancelled'
  ) {
    merged.status = 'cancelled';
  }
  atomicWrite(jobFilePath(repoPath, id), JSON.stringify(merged, null, 2));
  return merged;
}

/**
 * @typedef {Object} ListOpts
 * @property {number=} limit
 * @property {JobStatus=} status
 */

/**
 * @param {string} repoPath
 * @param {ListOpts} [opts]
 * @returns {JobRecord[]}
 */
export function listJobs(repoPath, opts = {}) {
  const dir = jobsDir(repoPath);
  if (!existsSync(dir)) return [];
  const files = readdirSync(dir).filter((f) => f.endsWith('.json') && !f.includes('.tmp-'));
  /** @type {JobRecord[]} */
  const records = [];
  for (const f of files) {
    try {
      const raw = readFileSync(join(dir, f), 'utf8');
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && typeof parsed.id === 'string') {
        const normalized = normalizeJobRecord(parsed);
        if (normalized) records.push(normalized);
      }
    } catch {
      continue;
    }
  }
  records.sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1));
  const filtered = opts.status ? records.filter((r) => r.status === opts.status) : records;
  return typeof opts.limit === 'number' ? filtered.slice(0, opts.limit) : filtered;
}

/**
 * @param {string} repoPath
 * @param {number} [days]
 * @returns {number}
 */
export function pruneOlderThanDays(repoPath, days = 30) {
  const dir = jobsDir(repoPath);
  if (!existsSync(dir)) return 0;
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  let removed = 0;
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    try {
      const st = statSync(p);
      if (st.isFile() && st.mtimeMs < cutoff) {
        unlinkSync(p);
        removed += 1;
      }
    } catch {
      continue;
    }
  }
  const lDir = logsDir(repoPath);
  if (existsSync(lDir)) {
    for (const f of readdirSync(lDir)) {
      const p = join(lDir, f);
      try {
        const st = statSync(p);
        if (st.isFile() && st.mtimeMs < cutoff) unlinkSync(p);
      } catch {
        continue;
      }
    }
  }
  return removed;
}

// A signal target must be a real, positive pid. POSIX gives 0 and negative
// values broadcast semantics: kill(0, sig) hits our own process group and
// kill(-1, sig) hits every process this user can signal. A failed spawn can
// persist a non-positive pid, so this must be enforced before any kill.
function livePid(value) {
  return Number.isInteger(value) && value > 0 ? value : null;
}

function isProcessAlive(pid) {
  if (livePid(pid) === null) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * @param {string} repoPath
 * @param {string} id
 * @param {number} [graceMs]
 * @returns {Promise<JobRecord|null>}
 */
export async function cancelJob(repoPath, id, graceMs = 5_000) {
  const job = readJob(repoPath, id);
  if (!job) return null;
  if (!isActiveStatus(job.status)) return job;
  // NOTE: PIDs are recycled by the OS. If the recorded process already exited
  // and its PID was reused, the signals below could hit an unrelated process.
  // Only a record still marked queued/running is ever signalled, which narrows
  // the window but does not close it. We accept that rather than track a
  // process-group / start-time identity cross-platform.
  const agentPid = livePid(job.agentPid);
  // Only ever group-signal `agentPid`. cursor-agent is spawned detached and so
  // leads its own group, which is how the shell commands it runs get reaped.
  // `job.pid` is the companion process: on a FOREGROUND run that is us, sharing
  // the caller's process group, and group-signalling it would take down the
  // Bash tool that invoked the cancel.
  const workerPid = job.background === true ? livePid(job.pid) : null;
  const alive = () =>
    (agentPid !== null && isProcessAlive(agentPid)) ||
    (workerPid !== null && isProcessAlive(workerPid));

  let signalled = false;
  if (agentPid !== null && isProcessAlive(agentPid)) {
    try {
      signalled = killTree(agentPid, 'SIGTERM') || signalled;
    } catch {
      // ignore — may have exited
    }
  }
  if (workerPid !== null && workerPid !== process.pid && isProcessAlive(workerPid)) {
    try {
      process.kill(workerPid, 'SIGTERM');
      signalled = true;
    } catch {
      // ignore — may have exited
    }
  }

  const deadline = Date.now() + graceMs;
  while (Date.now() < deadline && alive()) {
    await new Promise((r) => setTimeout(r, 200));
  }
  if (agentPid !== null && isProcessAlive(agentPid)) {
    try {
      killTree(agentPid, 'SIGKILL');
    } catch {
      // ignore
    }
  }
  if (workerPid !== null && workerPid !== process.pid && isProcessAlive(workerPid)) {
    try {
      process.kill(workerPid, 'SIGKILL');
    } catch {
      // ignore
    }
  }

  return updateJob(repoPath, id, {
    status: 'cancelled',
    // `phase` is a denormalisation of status; leaving it at 'editing' makes
    // /cursor:status report a cancelled job as still editing. Matches what
    // session-lifecycle-hook.mjs already writes when it reaps a job.
    phase: 'cancelled',
    finishedAt: new Date().toISOString(),
    // Records whether a live process was actually signalled. `false` means the
    // job was already dead and we only tidied its record — worth telling the
    // user rather than implying we stopped something.
    cancelSignalled: signalled,
  });
}

/**
 * @param {string} repoPath
 * @returns {JobRecord[]}
 */
export function findRunningJobs(repoPath) {
  return listJobs(repoPath).filter((j) => isActiveStatus(j.status));
}

/**
 * @param {string} repoPath
 * @returns {JobRecord|null}
 */
export function mostRecentFinishedJob(repoPath) {
  const jobs = listJobs(repoPath).filter((j) => !isActiveStatus(j.status));
  return jobs[0] ?? null;
}
