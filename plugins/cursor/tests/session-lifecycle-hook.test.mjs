import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createJob, readJob, SESSION_ID_ENV } from '../scripts/lib/jobs.mjs';
import { jobsDir, logsDir } from '../scripts/lib/paths.mjs';
import { makeTempHome } from './helpers.mjs';

const HOOK = fileURLToPath(new URL('../scripts/session-lifecycle-hook.mjs', import.meta.url));

function git(dir, args) {
  execFileSync('git', args, { cwd: dir, stdio: 'ignore' });
}

function initRepo(dir) {
  git(dir, ['init', '--quiet']);
  git(dir, ['config', 'user.email', 'test@example.com']);
  git(dir, ['config', 'user.name', 'Test']);
  git(dir, ['config', 'commit.gpgsign', 'false']);
  writeFileSync(join(dir, 'README.md'), 'hello\n');
  git(dir, ['add', '.']);
  git(dir, ['commit', '--quiet', '-m', 'init']);
}

/** Run the hook with JSON on stdin, as Claude Code invokes it. */
function runHook(event, input, env = {}) {
  return execFileSync(process.execPath, [HOOK, event], {
    input: JSON.stringify(input),
    env: { ...process.env, ...env },
    encoding: 'utf8',
  });
}

function ageFile(path, days) {
  const when = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  utimesSync(path, when, when);
}

describe('session lifecycle hook', () => {
  let home;
  let repo;
  const prevHome = process.env.CURSOR_PLUGIN_CC_HOME;
  const prevSession = process.env[SESSION_ID_ENV];

  beforeEach(() => {
    home = makeTempHome();
    repo = makeTempHome();
    process.env.CURSOR_PLUGIN_CC_HOME = home.dir;
    delete process.env[SESSION_ID_ENV];
    initRepo(repo.dir);
  });

  afterEach(() => {
    home.cleanup();
    repo.cleanup();
    if (prevHome === undefined) delete process.env.CURSOR_PLUGIN_CC_HOME;
    else process.env.CURSOR_PLUGIN_CC_HOME = prevHome;
    if (prevSession === undefined) delete process.env[SESSION_ID_ENV];
    else process.env[SESSION_ID_ENV] = prevSession;
  });

  it('SessionStart publishes the session id into CLAUDE_ENV_FILE', () => {
    const envFile = join(home.dir, 'env');
    writeFileSync(envFile, '');
    runHook(
      'SessionStart',
      { session_id: 'sess-abc', cwd: repo.dir },
      { CLAUDE_ENV_FILE: envFile },
    );
    expect(readFileSync(envFile, 'utf8')).toBe(`export ${SESSION_ID_ENV}='sess-abc'\n`);
  });

  it('SessionStart quotes a session id containing a single quote', () => {
    // The value is written into a shell-sourced file; the POSIX '\'' idiom is
    // what keeps it a single token.
    const envFile = join(home.dir, 'env');
    writeFileSync(envFile, '');
    runHook(
      'SessionStart',
      { session_id: "a'b; echo pwned", cwd: repo.dir },
      { CLAUDE_ENV_FILE: envFile },
    );
    const written = readFileSync(envFile, 'utf8').trim();
    expect(written).toBe(`export ${SESSION_ID_ENV}='a'\\''b; echo pwned'`);
    // Round-trip through a real shell: the payload must survive as literal text.
    const echoed = execFileSync('sh', ['-c', `. ${envFile}; printf %s "$${SESSION_ID_ENV}"`], {
      encoding: 'utf8',
    });
    expect(echoed).toBe("a'b; echo pwned");
  });

  it('SessionEnd cancels this session active jobs and leaves other sessions alone', () => {
    createJob({ id: 'mine', repoPath: repo.dir, prompt: 'p', model: 'm', sessionId: 'sess-a' });
    createJob({ id: 'theirs', repoPath: repo.dir, prompt: 'p', model: 'm', sessionId: 'sess-b' });
    runHook('SessionEnd', { session_id: 'sess-a', cwd: repo.dir });
    expect(readJob(repo.dir, 'mine')?.status).toBe('cancelled');
    expect(readJob(repo.dir, 'theirs')?.status).toBe('running');
  });

  it('SessionEnd never signals a non-positive pid', () => {
    // process.kill(-1, sig) broadcasts to every process this user owns. A failed
    // spawn used to persist exactly this record shape.
    createJob({
      id: 'poison',
      repoPath: repo.dir,
      prompt: 'p',
      model: 'm',
      sessionId: 'sess-a',
      background: true,
    });
    const file = join(jobsDir(repo.dir), 'poison.json');
    const rec = JSON.parse(readFileSync(file, 'utf8'));
    writeFileSync(file, JSON.stringify({ ...rec, pid: -1, agentPid: -1 }, null, 2));
    // Completing at all means no broadcast signal was attempted.
    expect(() => runHook('SessionEnd', { session_id: 'sess-a', cwd: repo.dir })).not.toThrow();
    expect(readJob(repo.dir, 'poison')?.status).toBe('cancelled');
  });

  it('SessionEnd prunes aged job records, logs and review diffs', () => {
    createJob({ id: 'fresh', repoPath: repo.dir, prompt: 'p', model: 'm', sessionId: 'sess-a' });
    // Already finished, so the reaper skips it. An active job gets cancelled
    // first, and that write refreshes its mtime, which correctly spares it.
    createJob({
      id: 'stale',
      repoPath: repo.dir,
      prompt: 'p',
      model: 'm',
      sessionId: 'sess-a',
      status: 'completed',
    });
    mkdirSync(logsDir(repo.dir), { recursive: true });
    const staleDiff = join(logsDir(repo.dir), 'aged.diff');
    const staleLog = join(logsDir(repo.dir), 'aged.ndjson');
    const freshDiff = join(logsDir(repo.dir), 'recent.diff');
    for (const p of [staleDiff, staleLog, freshDiff]) writeFileSync(p, 'x'.repeat(1024));
    for (const p of [staleDiff, staleLog, join(jobsDir(repo.dir), 'stale.json')]) ageFile(p, 60);

    runHook('SessionEnd', { session_id: 'sess-a', cwd: repo.dir });

    expect(existsSync(staleDiff), 'aged diff should be pruned').toBe(false);
    expect(existsSync(staleLog), 'aged log should be pruned').toBe(false);
    expect(existsSync(freshDiff), 'recent diff should survive').toBe(true);
    expect(readJob(repo.dir, 'stale'), 'aged record should be pruned').toBeNull();
    expect(readJob(repo.dir, 'fresh'), 'recent record should survive').not.toBeNull();
  });

  it('prunes even when there is no session id to reap against', () => {
    mkdirSync(logsDir(repo.dir), { recursive: true });
    const staleDiff = join(logsDir(repo.dir), 'aged.diff');
    writeFileSync(staleDiff, 'x');
    ageFile(staleDiff, 60);
    runHook('SessionEnd', { cwd: repo.dir });
    expect(existsSync(staleDiff)).toBe(false);
  });

  it('exits cleanly outside a git repository and on garbage input', () => {
    expect(() => runHook('SessionEnd', { cwd: home.dir })).not.toThrow();
    expect(() =>
      execFileSync(process.execPath, [HOOK, 'SessionEnd'], { input: 'not json', encoding: 'utf8' }),
    ).not.toThrow();
  });
});
