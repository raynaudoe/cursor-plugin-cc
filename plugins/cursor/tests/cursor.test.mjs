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

  it('adds --cloud and --resume when requested', () => {
    const args = buildArgs({
      prompt: 'hi',
      model: 'auto',
      cloud: true,
      resumeChatId: 'chat_xyz',
    });
    expect(args).toContain('--cloud');
    expect(args).toContain('--resume=chat_xyz');
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
