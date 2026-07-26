import { spawn } from 'node:child_process';
import { utimesSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  cancelJob,
  createJob,
  currentSessionId,
  filterForSession,
  findRunningJobs,
  jobFilePath,
  listJobs,
  mostRecentFinishedJob,
  pruneOlderThanDays,
  readJob,
  SESSION_ID_ENV,
  updateJob,
} from '../scripts/lib/jobs.mjs';
import { makeTempHome } from './helpers.mjs';

describe('jobs registry', () => {
  let tmp;
  const prevHome = process.env.CURSOR_PLUGIN_CC_HOME;
  const repo = '/tmp/some-repo-path';

  beforeEach(() => {
    tmp = makeTempHome();
    process.env.CURSOR_PLUGIN_CC_HOME = tmp.dir;
  });

  afterEach(() => {
    if (prevHome === undefined) delete process.env.CURSOR_PLUGIN_CC_HOME;
    else process.env.CURSOR_PLUGIN_CC_HOME = prevHome;
    tmp.cleanup();
  });

  it('creates, reads, and updates a job atomically', () => {
    const job = createJob({ id: 'job1', repoPath: repo, prompt: 'do it', model: 'composer-2.5' });
    expect(job.status).toBe('running');
    const read = readJob(repo, 'job1');
    expect(read?.prompt).toBe('do it');
    const updated = updateJob(repo, 'job1', {
      status: 'completed',
      exitCode: 0,
      finishedAt: new Date().toISOString(),
    });
    expect(updated?.status).toBe('completed');
  });

  it('lists jobs sorted newest first and filters by status', () => {
    createJob({ id: 'a', repoPath: repo, prompt: 'a', model: 'x' });
    createJob({ id: 'b', repoPath: repo, prompt: 'b', model: 'x' });
    updateJob(repo, 'a', { status: 'completed', finishedAt: new Date().toISOString() });
    const all = listJobs(repo);
    expect(all.length).toBe(2);
    const running = listJobs(repo, { status: 'running' });
    expect(running.map((j) => j.id)).toEqual(['b']);
    expect(findRunningJobs(repo).map((j) => j.id)).toEqual(['b']);
    expect(mostRecentFinishedJob(repo)?.id).toBe('a');
  });

  it('prunes stale job files', () => {
    createJob({ id: 'old', repoPath: repo, prompt: 'old', model: 'x' });
    createJob({ id: 'new', repoPath: repo, prompt: 'new', model: 'x' });
    const stalePath = jobFilePath(repo, 'old');
    const past = new Date(Date.now() - 60 * 24 * 3600 * 1000);
    utimesSync(stalePath, past, past);
    const removed = pruneOlderThanDays(repo, 30);
    expect(removed).toBeGreaterThanOrEqual(1);
    expect(readJob(repo, 'old')).toBeNull();
    expect(readJob(repo, 'new')).not.toBeNull();
  });

  it('cancelJob SIGTERMs a live background worker pid and marks cancelled', async () => {
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      stdio: 'ignore',
      detached: false,
    });
    try {
      await new Promise((r) => setTimeout(r, 50));
      createJob({ id: 'live', repoPath: repo, prompt: 'p', model: 'm' });
      // `background: true` is required: cancelJob only signals `job.pid` for
      // background workers, because on a foreground run that pid is the
      // companion itself.
      updateJob(repo, 'live', { pid: child.pid, background: true });
      const cancelled = await cancelJob(repo, 'live', 500);
      expect(cancelled?.status).toBe('cancelled');
      expect(cancelled?.cancelSignalled).toBe(true);
    } finally {
      if (!child.killed) child.kill('SIGKILL');
    }
  });

  it('cancelJob on unknown id returns null', async () => {
    const res = await cancelJob(repo, 'nope');
    expect(res).toBeNull();
  });

  it('normalizes legacy done jobs to completed', () => {
    createJob({ id: 'done1', repoPath: repo, prompt: 'p', model: 'm' });
    updateJob(repo, 'done1', { status: 'done' });
    expect(readJob(repo, 'done1')?.status).toBe('completed');
  });

  it('cancelJob on already-finished job returns unchanged record', async () => {
    createJob({ id: 'done1', repoPath: repo, prompt: 'p', model: 'm' });
    updateJob(repo, 'done1', { status: 'completed' });
    const res = await cancelJob(repo, 'done1');
    expect(res?.status).toBe('completed');
  });

  it('cancelJob reaps the cursor-agent process group, not just the direct child', async () => {
    // A detached `sh` that spawns a sleeping grandchild: the shape cursor-agent
    // creates when it shells out to run tests. A bare pid kill leaves the
    // grandchild running.
    const child = spawn('sh', ['-c', 'sleep 30 & wait'], { detached: true, stdio: 'ignore' });
    try {
      await new Promise((r) => setTimeout(r, 50));
      createJob({ id: 'tree', repoPath: repo, prompt: 'p', model: 'm' });
      updateJob(repo, 'tree', { agentPid: child.pid });
      const cancelled = await cancelJob(repo, 'tree', 2_000);
      expect(cancelled?.status).toBe('cancelled');
      expect(cancelled?.cancelSignalled).toBe(true);
      await new Promise((r) => setTimeout(r, 200));
      expect(() => process.kill(child.pid, 0)).toThrow();
    } finally {
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {
        // already reaped
      }
    }
  });

  it('cancelJob reports when there was no live process to signal', async () => {
    createJob({ id: 'stale', repoPath: repo, prompt: 'p', model: 'm' });
    const cancelled = await cancelJob(repo, 'stale', 100);
    expect(cancelled?.status).toBe('cancelled');
    expect(cancelled?.cancelSignalled).toBe(false);
  });

  it('never group-signals a foreground job pid', async () => {
    // On a foreground run `job.pid` is the companion itself, sharing the caller's
    // process group. Group-signalling it would kill the Bash tool that invoked us.
    createJob({ id: 'fg', repoPath: repo, prompt: 'p', model: 'm' });
    updateJob(repo, 'fg', { pid: process.pid });
    const cancelled = await cancelJob(repo, 'fg', 100);
    expect(cancelled?.status).toBe('cancelled');
    expect(cancelled?.cancelSignalled).toBe(false);
  });
});

describe('session scoping', () => {
  let home;
  let repo;
  const prevSession = process.env[SESSION_ID_ENV];

  beforeEach(() => {
    home = makeTempHome();
    process.env.CURSOR_PLUGIN_CC_HOME = home.dir;
    repo = '/tmp/session-repo';
    delete process.env[SESSION_ID_ENV];
  });

  afterEach(() => {
    home.cleanup();
    delete process.env.CURSOR_PLUGIN_CC_HOME;
    if (prevSession === undefined) delete process.env[SESSION_ID_ENV];
    else process.env[SESSION_ID_ENV] = prevSession;
  });

  it('stamps the session id from the environment', () => {
    process.env[SESSION_ID_ENV] = 'sess-a';
    createJob({ id: 'a1', repoPath: repo, prompt: 'p', model: 'm' });
    expect(readJob(repo, 'a1')?.sessionId).toBe('sess-a');
  });

  it('omits the field entirely when the hook has not run', () => {
    createJob({ id: 'n1', repoPath: repo, prompt: 'p', model: 'm' });
    expect(readJob(repo, 'n1')).not.toHaveProperty('sessionId');
    expect(currentSessionId({})).toBeNull();
  });

  it('hides other sessions but keeps this one and pre-hook records', () => {
    process.env[SESSION_ID_ENV] = 'sess-a';
    createJob({ id: 'mine', repoPath: repo, prompt: 'p', model: 'm' });
    process.env[SESSION_ID_ENV] = 'sess-b';
    createJob({ id: 'theirs', repoPath: repo, prompt: 'p', model: 'm' });
    delete process.env[SESSION_ID_ENV];
    createJob({ id: 'legacy', repoPath: repo, prompt: 'p', model: 'm' });

    process.env[SESSION_ID_ENV] = 'sess-a';
    const visible = filterForSession(listJobs(repo))
      .map((job) => job.id)
      .sort();
    expect(visible).toEqual(['legacy', 'mine']);
  });

  it('degrades to showing everything when the session id is unknown', () => {
    process.env[SESSION_ID_ENV] = 'sess-a';
    createJob({ id: 'mine', repoPath: repo, prompt: 'p', model: 'm' });
    delete process.env[SESSION_ID_ENV];
    expect(filterForSession(listJobs(repo))).toHaveLength(1);
  });
});
