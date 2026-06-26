import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { main as adversarialMain } from '../scripts/adversarial-review.mjs';
import { main as companionMain } from '../scripts/cursor-companion.mjs';
import { main as debateMain } from '../scripts/debate.mjs';
import { main as rescueMain } from '../scripts/rescue.mjs';
import { main as reviewMain } from '../scripts/review.mjs';
import { MODEL_ALIASES } from '../scripts/lib/cursor.mjs';
import { createJob, listJobs, updateJob } from '../scripts/lib/jobs.mjs';
import {
  ADVERSARIAL_JSON_FIXTURE,
  DEBATE_CONSENSUS_FIXTURE,
  DEBATE_NON_JSON_FIXTURE,
  HAPPY_FIXTURE,
  REVIEW_HAPPY_FIXTURE,
  STUB_BIN,
  makeTempHome,
} from './helpers.mjs';

function git(dir, args) {
  execFileSync('git', args, { cwd: dir, stdio: 'ignore' });
}

function gitOut(dir, args) {
  return execFileSync('git', args, { cwd: dir }).toString().trim();
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

async function waitFor(predicate, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await predicate();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('Timed out waiting for condition.');
}

describe('cursor companion runtime', () => {
  let tmp;
  const prevHome = process.env.CURSOR_PLUGIN_CC_HOME;
  const prevBin = process.env.CURSOR_AGENT_BIN;
  const prevFix = process.env.CURSOR_AGENT_STUB_FIXTURE;
  const prevArgvLog = process.env.CURSOR_AGENT_STUB_ARGV_LOG;
  const prevArgvLogMode = process.env.CURSOR_AGENT_STUB_ARGV_LOG_MODE;
  const prevCwd = process.cwd();

  beforeEach(() => {
    tmp = makeTempHome();
    process.env.CURSOR_PLUGIN_CC_HOME = tmp.dir;
    process.env.CURSOR_AGENT_BIN = STUB_BIN;
    process.env.CURSOR_AGENT_STUB_FIXTURE = HAPPY_FIXTURE;
    delete process.env.CURSOR_AGENT_STUB_ARGV_LOG;
    delete process.env.CURSOR_AGENT_STUB_ARGV_LOG_MODE;
    process.chdir(tmp.dir);
  });

  afterEach(() => {
    process.chdir(prevCwd);
    if (prevHome === undefined) delete process.env.CURSOR_PLUGIN_CC_HOME;
    else process.env.CURSOR_PLUGIN_CC_HOME = prevHome;
    if (prevBin === undefined) delete process.env.CURSOR_AGENT_BIN;
    else process.env.CURSOR_AGENT_BIN = prevBin;
    if (prevFix === undefined) delete process.env.CURSOR_AGENT_STUB_FIXTURE;
    else process.env.CURSOR_AGENT_STUB_FIXTURE = prevFix;
    if (prevArgvLog === undefined) delete process.env.CURSOR_AGENT_STUB_ARGV_LOG;
    else process.env.CURSOR_AGENT_STUB_ARGV_LOG = prevArgvLog;
    if (prevArgvLogMode === undefined) delete process.env.CURSOR_AGENT_STUB_ARGV_LOG_MODE;
    else process.env.CURSOR_AGENT_STUB_ARGV_LOG_MODE = prevArgvLogMode;
    tmp.cleanup();
  });

  it('setup reports ready against the stub Cursor CLI', async () => {
    let out = '';
    const outSpy = vi.spyOn(process.stdout, 'write').mockImplementation((s) => {
      out += s;
      return true;
    });
    try {
      const code = await companionMain(['setup', '--json']);
      expect(code).toBe(0);
    } finally {
      outSpy.mockRestore();
    }
    const payload = JSON.parse(out);
    expect(payload.ready).toBe(true);
    expect(payload.cursor.detail).toContain('cursor-agent-stub');
    expect(payload.models).toContain('composer-2.5-fast');
  });

  it('review rejects custom focus text', async () => {
    initRepo(tmp.dir);
    writeFileSync(join(tmp.dir, 'README.md'), 'hello again\n');
    await expect(reviewMain(['--', 'focus on auth'])).rejects.toThrow(
      /does not support custom focus/i,
    );
  });

  it('normal review records a completed job and stores the review output', async () => {
    process.env.CURSOR_AGENT_STUB_FIXTURE = REVIEW_HAPPY_FIXTURE;
    initRepo(tmp.dir);
    writeFileSync(join(tmp.dir, 'README.md'), 'hello again\n');
    const outSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    try {
      const code = await reviewMain(['--wait']);
      expect(code).toBe(0);
    } finally {
      outSpy.mockRestore();
    }
    const job = listJobs(tmp.dir)[0];
    expect(job.status).toBe('completed');
    expect(job.kindLabel).toBe('review');
    expect(job.cursorChatId).toBe('chat_review_001');
    expect(job.resultText).toMatch(/APPROVE WITH NITS/);
  });

  it('normal review supports branch diffs with --base', async () => {
    process.env.CURSOR_AGENT_STUB_FIXTURE = REVIEW_HAPPY_FIXTURE;
    initRepo(tmp.dir);
    const baseBranch = gitOut(tmp.dir, ['rev-parse', '--abbrev-ref', 'HEAD']);
    git(tmp.dir, ['checkout', '--quiet', '-b', 'feature']);
    writeFileSync(join(tmp.dir, 'README.md'), 'feature\n');
    git(tmp.dir, ['commit', '--quiet', '-am', 'change readme']);
    const outSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    try {
      const code = await reviewMain(['--wait', '--base', baseBranch]);
      expect(code).toBe(0);
    } finally {
      outSpy.mockRestore();
    }
    expect(listJobs(tmp.dir)[0].prompt).toContain(`vs ${baseBranch}`);
  });

  it('adversarial review renders structured JSON findings', async () => {
    process.env.CURSOR_AGENT_STUB_FIXTURE = ADVERSARIAL_JSON_FIXTURE;
    initRepo(tmp.dir);
    mkdirSync(join(tmp.dir, 'src'));
    writeFileSync(join(tmp.dir, 'src', 'app.js'), 'export const value = items[0].id;\n');
    const outSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    try {
      const code = await adversarialMain(['--wait', '--', 'challenge empty states']);
      expect(code).toBe(0);
    } finally {
      outSpy.mockRestore();
    }
    const job = listJobs(tmp.dir)[0];
    expect(job.status).toBe('completed');
    expect(job.kindLabel).toBe('adversarial-review');
    expect(job.resultText).toMatch(/Cursor Adversarial Review/);
    expect(job.resultText).toMatch(/Missing empty-state guard/);
  });

  it('debate forwards both resolved models and stops after early consensus', async () => {
    process.env.CURSOR_AGENT_STUB_FIXTURE = DEBATE_CONSENSUS_FIXTURE;
    initRepo(tmp.dir);
    const argvLog = join(tmp.dir, 'debate-argv.ndjson');
    process.env.CURSOR_AGENT_STUB_ARGV_LOG = argvLog;
    process.env.CURSOR_AGENT_STUB_ARGV_LOG_MODE = 'append';
    const outSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    try {
      const code = await debateMain([
        '--models',
        'gemini,composer',
        '--rounds',
        '5',
        '--',
        'should we add this API boundary',
      ]);
      expect(code).toBe(0);
    } finally {
      outSpy.mockRestore();
    }
    const job = listJobs(tmp.dir)[0];
    expect(job.status).toBe('completed');
    expect(job.kindLabel).toBe('debate');
    expect(job.jobClass).toBe('debate');
    expect(job.model).toBe('gemini-3.1-pro,composer-2.5-fast');
    expect(job.resultText).toContain('# Cursor Debate Consensus');
    expect(job.resultText).toContain('Consensus: reached');
    expect(job.resultText).toContain('Rounds used: 1 of 5');
    expect(job.resultText).toContain('Model A=gemini-3.1-pro');
    expect(job.resultText).toContain('Model B=composer-2.5-fast');
    const invocations = readFileSync(argvLog, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(invocations).toHaveLength(2);
    const models = invocations.map((argv) => argv[argv.indexOf('--model') + 1]);
    expect(models).toEqual(['gemini-3.1-pro', 'composer-2.5-fast']);
  });

  it('debate rejects rounds outside 1..5', async () => {
    await expect(debateMain(['--rounds', '6', '--', 'evaluate this plan'])).rejects.toThrow(
      /--rounds must be an integer from 1 to 5/,
    );
    await expect(debateMain(['--rounds', '0', '--', 'evaluate this plan'])).rejects.toThrow(
      /--rounds must be an integer from 1 to 5/,
    );
  });

  it('debate preserves non-JSON model output without crashing', async () => {
    process.env.CURSOR_AGENT_STUB_FIXTURE = DEBATE_NON_JSON_FIXTURE;
    initRepo(tmp.dir);
    const outSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    try {
      const code = await debateMain([
        '--models',
        'gemini,composer',
        '--rounds',
        '1',
        '--',
        'evaluate this architecture',
      ]);
      expect(code).toBe(0);
    } finally {
      outSpy.mockRestore();
    }
    const job = listJobs(tmp.dir)[0];
    expect(job.status).toBe('completed');
    expect(job.resultText).toContain('Consensus: not reached');
    expect(job.resultText).toContain('Non-JSON output preserved');
    expect(job.resultText).toContain('I need more repository evidence');
  });

  it('background debate queues a worker and exposes the consensus result', async () => {
    process.env.CURSOR_AGENT_STUB_FIXTURE = DEBATE_CONSENSUS_FIXTURE;
    initRepo(tmp.dir);
    let launch = '';
    const outSpy = vi.spyOn(process.stdout, 'write').mockImplementation((s) => {
      launch += s;
      return true;
    });
    try {
      const code = await debateMain([
        '--background',
        '--models',
        'gemini,composer',
        '--rounds',
        '1',
        '--',
        'compare these options',
      ]);
      expect(code).toBe(0);
    } finally {
      outSpy.mockRestore();
    }
    expect(launch).toMatch(/started in the background/);
    const job = await waitFor(() => {
      const latest = listJobs(tmp.dir)[0];
      return latest && latest.status === 'completed' ? latest : null;
    });
    expect(job.kindLabel).toBe('debate');

    let status = '';
    const statusSpy = vi.spyOn(process.stdout, 'write').mockImplementation((s) => {
      status += s;
      return true;
    });
    try {
      await companionMain(['status']);
    } finally {
      statusSpy.mockRestore();
    }
    expect(status).toContain(job.id);
    expect(status).toContain('debate');

    let result = '';
    const resultSpy = vi.spyOn(process.stdout, 'write').mockImplementation((s) => {
      result += s;
      return true;
    });
    try {
      await companionMain(['result', job.id]);
    } finally {
      resultSpy.mockRestore();
    }
    expect(result).toContain('# Cursor Debate Consensus');
    expect(result).toContain('Consensus: reached');
  });

  it('rescue forwards model aliases and records raw Cursor output', async () => {
    initRepo(tmp.dir);
    const argvLog = join(tmp.dir, 'argv.json');
    process.env.CURSOR_AGENT_STUB_ARGV_LOG = argvLog;
    const outSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    try {
      const code = await rescueMain(['--model', 'composer', '--', 'fix the failing test']);
      expect(code).toBe(0);
    } finally {
      outSpy.mockRestore();
    }
    const job = listJobs(tmp.dir)[0];
    expect(job.status).toBe('completed');
    expect(job.kindLabel).toBe('rescue');
    expect(job.model).toBe('composer-2.5-fast');
    expect(job.resultText).toMatch(/Added src\/foo.ts/);
    const argv = JSON.parse(readFileSync(argvLog, 'utf8'));
    expect(argv).toContain('--model');
    expect(argv).toContain('composer-2.5-fast');
  });

  it('rescue forwards every configured model alias to cursor-agent', async () => {
    initRepo(tmp.dir);
    const argvLog = join(tmp.dir, 'rescue-model-aliases.ndjson');
    process.env.CURSOR_AGENT_STUB_ARGV_LOG = argvLog;
    process.env.CURSOR_AGENT_STUB_ARGV_LOG_MODE = 'append';
    const aliases = Object.entries(MODEL_ALIASES);
    const outSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    try {
      for (const [alias] of aliases) {
        const code = await rescueMain(['--model', alias, '--', `check ${alias} routing`]);
        expect(code).toBe(0);
      }
    } finally {
      outSpy.mockRestore();
    }

    const invocations = readFileSync(argvLog, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(invocations).toHaveLength(aliases.length);

    const forwardedModels = invocations.map((argv) => argv[argv.indexOf('--model') + 1]);
    expect(forwardedModels).toEqual(aliases.map(([, model]) => model));
    expect(forwardedModels).toContain(MODEL_ALIASES.gemini);
  });

  it('background rescue queues a worker and exposes it through status/result', async () => {
    initRepo(tmp.dir);
    let launch = '';
    const outSpy = vi.spyOn(process.stdout, 'write').mockImplementation((s) => {
      launch += s;
      return true;
    });
    try {
      const code = await rescueMain(['--background', '--', 'fix later']);
      expect(code).toBe(0);
    } finally {
      outSpy.mockRestore();
    }
    expect(launch).toMatch(/started in the background/);
    const job = await waitFor(() => {
      const latest = listJobs(tmp.dir)[0];
      return latest && latest.status === 'completed' ? latest : null;
    });
    let status = '';
    const statusSpy = vi.spyOn(process.stdout, 'write').mockImplementation((s) => {
      status += s;
      return true;
    });
    try {
      await companionMain(['status']);
    } finally {
      statusSpy.mockRestore();
    }
    expect(status).toMatch(/# Cursor Status/);
    expect(status).toContain(job.id);
    let result = '';
    const resultSpy = vi.spyOn(process.stdout, 'write').mockImplementation((s) => {
      result += s;
      return true;
    });
    try {
      await companionMain(['result', job.id]);
    } finally {
      resultSpy.mockRestore();
    }
    expect(result).toMatch(/Added src\/foo.ts/);
    expect(result).toMatch(/cursor-agent --resume=chat_abc123/);
  });

  it('task-resume-candidate returns the latest finished rescue chat', async () => {
    initRepo(tmp.dir);
    const outSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    try {
      await rescueMain(['--', 'fix a thing']);
    } finally {
      outSpy.mockRestore();
    }
    let out = '';
    const candidateSpy = vi.spyOn(process.stdout, 'write').mockImplementation((s) => {
      out += s;
      return true;
    });
    try {
      await companionMain(['task-resume-candidate', '--json']);
    } finally {
      candidateSpy.mockRestore();
    }
    const payload = JSON.parse(out);
    expect(payload.available).toBe(true);
    expect(payload.candidate.cursorChatId).toBe('chat_abc123');
  });

  it('cancel targets the single active job', async () => {
    initRepo(tmp.dir);
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      stdio: 'ignore',
    });
    try {
      createJob({
        id: 'live',
        repoPath: tmp.dir,
        prompt: 'running',
        model: 'auto',
        status: 'running',
        kindLabel: 'rescue',
        jobClass: 'task',
      });
      updateJob(tmp.dir, 'live', { pid: child.pid });
      const outSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
      try {
        const code = await companionMain(['cancel']);
        expect(code).toBe(0);
      } finally {
        outSpy.mockRestore();
      }
      expect(listJobs(tmp.dir)[0].status).toBe('cancelled');
    } finally {
      if (!child.killed) child.kill('SIGKILL');
    }
  });
});
