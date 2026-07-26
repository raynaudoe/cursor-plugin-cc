import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MODEL_ALIASES, buildArgs, resolveModel, runHeadless } from '../scripts/lib/cursor.mjs';
import { extractChatId, summariseEvents } from '../scripts/lib/parse.mjs';
import { HAPPY_FIXTURE, STUB_BIN, makeTempHome } from './helpers.mjs';

describe('buildArgs', () => {
  it('includes the expected flags by default', () => {
    const args = buildArgs({ prompt: 'hi', model: 'composer-2.5' });
    expect(args).toContain('-p');
    expect(args).toContain('--output-format');
    expect(args).toContain('stream-json');
    expect(args).toContain('--trust');
    expect(args).toContain('--model');
    expect(args).toContain('composer-2.5');
    expect(args.at(-1)).toBe('hi');
  });

  it('omits --force when force=false', () => {
    const args = buildArgs({ prompt: 'hi', model: 'auto', force: false });
    expect(args).not.toContain('--force');
  });

  it('adds --resume=<id> when resuming a specific chat', () => {
    const args = buildArgs({ prompt: 'hi', model: 'auto', resumeChatId: 'chat_xyz' });
    expect(args).toContain('--resume=chat_xyz');
  });

  it('uses --continue rather than a bare --resume so the prompt is not swallowed', () => {
    // `--resume` takes an OPTIONAL chat id, so `--resume <prompt>` consumes the
    // prompt and cursor-agent fails with "No prompt provided".
    const args = buildArgs({ prompt: 'keep going', model: 'auto', resumeLatest: true });
    expect(args).toContain('--continue');
    expect(args).not.toContain('--resume');
    expect(args[args.length - 1]).toBe('keep going');
  });

  it('read-only runs pass --mode ask and never --force', () => {
    const args = buildArgs({ prompt: 'review this', model: 'auto', readOnly: true });
    expect(args).toContain('--mode');
    expect(args[args.indexOf('--mode') + 1]).toBe('ask');
    // --force overrides the mode, so its absence is what makes the run safe.
    expect(args).not.toContain('--force');
    expect(args).not.toContain('--yolo');
  });

  it('never uses --mode plan for read-only runs', () => {
    // Verified live: plan mode blocks writes but delivers its answer as a
    // createPlanToolCall payload, leaving the `result` event with narration only.
    // A review run that way returns no findings at all.
    const args = buildArgs({ prompt: 'review this', model: 'auto', readOnly: true });
    expect(args).not.toContain('plan');
  });

  it('never uses --sandbox as the read-only mechanism', () => {
    // Verified live: `--sandbox enabled` still permits file writes.
    const args = buildArgs({ prompt: 'review this', model: 'auto', readOnly: true });
    expect(args).not.toContain('--sandbox');
  });

  it('read-only wins over an explicit force', () => {
    const args = buildArgs({ prompt: 'review this', model: 'auto', readOnly: true, force: true });
    expect(args).not.toContain('--force');
  });

  it('streams partial output so phase reporting can move', () => {
    const args = buildArgs({ prompt: 'hi', model: 'auto' });
    expect(args).toContain('--stream-partial-output');
  });
});

describe('model alias targets', () => {
  // Verified against `cursor-agent --list-models` (2026.07.23): every alias below
  // resolved to a live id. These assertions pin the shapes that have silently
  // drifted before — a bad target is only discovered when a real run is rejected.
  it('namespaces every Grok target with the cursor- prefix', () => {
    const grok = Object.entries(MODEL_ALIASES).filter(([alias]) => alias.startsWith('grok'));
    expect(grok.length).toBeGreaterThan(0);
    for (const [alias, target] of grok) {
      expect(target, alias).toMatch(/^cursor-grok-/);
    }
  });

  it('resolves in a single hop', () => {
    // Callers look up exactly once. A target that is itself a key is fine only if
    // it maps to itself; anything else would need a second hop and would silently
    // forward the wrong id.
    for (const [alias, target] of Object.entries(MODEL_ALIASES)) {
      if (!(target in MODEL_ALIASES)) continue;
      expect(MODEL_ALIASES[target], `${alias} -> ${target} is not a fixed point`).toBe(target);
    }
  });

  it('keeps retired Composer ids as the only self-referential passthroughs', () => {
    const identity = Object.entries(MODEL_ALIASES)
      .filter(([alias, target]) => alias === target)
      .map(([alias]) => alias)
      .sort();
    expect(identity).toEqual([
      'auto',
      'composer-1.5',
      'composer-2',
      'composer-2-fast',
      'composer-2.5',
      'composer-2.5-fast',
      'gpt-5.2',
      'gpt-5.3-codex',
      'gpt-5.3-codex-fast',
      'gpt-5.3-codex-high',
    ]);
  });
});

describe('resolveModel', () => {
  const prevDefault = process.env.CURSOR_PLUGIN_CC_DEFAULT_MODEL;
  afterEach(() => {
    if (prevDefault === undefined) delete process.env.CURSOR_PLUGIN_CC_DEFAULT_MODEL;
    else process.env.CURSOR_PLUGIN_CC_DEFAULT_MODEL = prevDefault;
  });

  it('maps aliases to real Cursor ids', () => {
    for (const [alias, model] of Object.entries(MODEL_ALIASES)) {
      expect(resolveModel(alias)).toBe(model);
    }
  });

  it('maps aliases case-insensitively after trimming', () => {
    expect(resolveModel(' Gemini ')).toBe(MODEL_ALIASES.gemini);
    expect(resolveModel('COMPOSER')).toBe(MODEL_ALIASES.composer);
    expect(resolveModel('OpUs')).toBe(MODEL_ALIASES.opus);
  });

  it('keeps retired Composer ids as passthrough for older cursor-agent builds', () => {
    expect(resolveModel('composer-2')).toBe('composer-2');
    expect(resolveModel('composer-2-fast')).toBe('composer-2-fast');
    expect(resolveModel('grok-4-20')).toBe('grok-4-20');
  });

  it('defaults to auto when empty (no env override)', () => {
    delete process.env.CURSOR_PLUGIN_CC_DEFAULT_MODEL;
    expect(resolveModel(undefined)).toBe('auto');
    expect(resolveModel('')).toBe('auto');
  });

  it('honours CURSOR_PLUGIN_CC_DEFAULT_MODEL when no input is given', () => {
    process.env.CURSOR_PLUGIN_CC_DEFAULT_MODEL = 'composer';
    expect(resolveModel(undefined)).toBe('composer-2.5-fast');
    process.env.CURSOR_PLUGIN_CC_DEFAULT_MODEL = 'some-custom-id';
    expect(resolveModel('')).toBe('some-custom-id');
  });

  it('explicit input wins over the env default', () => {
    process.env.CURSOR_PLUGIN_CC_DEFAULT_MODEL = 'composer';
    expect(resolveModel('opus')).toBe('claude-opus-4-7-high');
  });

  it('passes unknown ids through unchanged', () => {
    expect(resolveModel('some-new-model')).toBe('some-new-model');
  });
});

describe('runHeadless against stub binary', () => {
  let tmp;
  const prevBin = process.env.CURSOR_AGENT_BIN;
  const prevFixture = process.env.CURSOR_AGENT_STUB_FIXTURE;

  beforeEach(() => {
    tmp = makeTempHome();
    process.env.CURSOR_AGENT_BIN = STUB_BIN;
    process.env.CURSOR_AGENT_STUB_FIXTURE = HAPPY_FIXTURE;
  });

  afterEach(() => {
    if (prevBin === undefined) delete process.env.CURSOR_AGENT_BIN;
    else process.env.CURSOR_AGENT_BIN = prevBin;
    if (prevFixture === undefined) delete process.env.CURSOR_AGENT_STUB_FIXTURE;
    else process.env.CURSOR_AGENT_STUB_FIXTURE = prevFixture;
    tmp.cleanup();
  });

  it('streams events and writes raw log', async () => {
    const logPath = `${tmp.dir}/run.ndjson`;
    const result = await runHeadless({
      prompt: 'hi',
      model: 'composer-2.5',
      force: false,
      logPath,
      timeoutSec: 10,
    });
    expect(result.exitCode).toBe(0);
    expect(result.events.length).toBeGreaterThan(0);
    const raw = readFileSync(logPath, 'utf8');
    expect(raw.split('\n').filter(Boolean).length).toBeGreaterThan(0);
    expect(extractChatId(result.events)).toBe('chat_abc123');
    const summary = summariseEvents(result.events);
    expect(summary.filesTouched.length).toBeGreaterThan(0);
  });
});
