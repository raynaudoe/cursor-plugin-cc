import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const COMMANDS_DIR = new URL('../commands', import.meta.url).pathname;
const AGENTS_DIR = new URL('../agents', import.meta.url).pathname;
const MARKETPLACE_PATH = new URL('../../../.claude-plugin/marketplace.json', import.meta.url)
  .pathname;
const PLUGIN_JSON_PATH = new URL('../plugin.json', import.meta.url).pathname;

function readCommand(file) {
  return readFileSync(join(COMMANDS_DIR, file), 'utf8');
}

function readAgent(file) {
  return readFileSync(join(AGENTS_DIR, file), 'utf8');
}

function promptFiles() {
  return [
    ...readdirSync(COMMANDS_DIR)
      .filter((name) => name.endsWith('.md'))
      .map((name) => join(COMMANDS_DIR, name)),
    ...readdirSync(AGENTS_DIR)
      .filter((name) => name.endsWith('.md'))
      .map((name) => join(AGENTS_DIR, name)),
  ];
}

describe('slash command surface', () => {
  it('keeps the install id separate from the cursor command namespace', () => {
    const marketplace = JSON.parse(readFileSync(MARKETPLACE_PATH, 'utf8'));
    const plugin = JSON.parse(readFileSync(PLUGIN_JSON_PATH, 'utf8'));
    expect(marketplace.name).toBe('cursor-plugin-cc');
    expect(marketplace.owner.name).toBe('ez');
    expect(marketplace.plugins[0].name).toBe('cursor');
    expect(plugin.name).toBe('cursor');
  });

  it('exposes only the Codex-style Cursor commands', () => {
    const commands = readdirSync(COMMANDS_DIR)
      .filter((name) => name.endsWith('.md'))
      .sort();
    expect(commands).toEqual([
      'adversarial-review.md',
      'cancel.md',
      'rescue.md',
      'result.md',
      'review.md',
      'setup.md',
      'status.md',
    ]);
  });

  it('keeps prompt files free of unsupported Codex-only references', () => {
    for (const file of promptFiles()) {
      const source = readFileSync(file, 'utf8');
      expect(source, file).not.toMatch(
        /Codex|\/codex|codex-companion|--effort|spark|gpt-5|--write|codex-cli-runtime|gpt-5-4-prompting|npm install|review-gate|Bash\(npm/,
      );
    }
  });

  it('keeps management commands as direct cursor-companion calls', () => {
    const direct = {
      'cancel.md': 'cancel',
      'result.md': 'result',
      'status.md': 'status',
    };
    for (const [file, subcommand] of Object.entries(direct)) {
      const source = readCommand(file);
      expect(source).toMatch(/disable-model-invocation: true/);
      expect(source).toMatch(/allowed-tools: Bash\(node:\*\)/);
      expect(source).toContain(
        `!` +
          '`' +
          `node "\${CLAUDE_PLUGIN_ROOT}/scripts/cursor-companion.mjs" ${subcommand} "$ARGUMENTS"` +
          '`',
      );
      expect(source).not.toMatch(/AskUserQuestion|Bash\(git:\*\)|Agent/);
    }

    const setup = readCommand('setup.md');
    expect(setup).toMatch(/allowed-tools: Bash\(node:\*\)/);
    expect(setup).toContain(
      'node "${CLAUDE_PLUGIN_ROOT}/scripts/cursor-companion.mjs" setup --json "$ARGUMENTS"',
    );
    expect(setup).not.toMatch(/AskUserQuestion|Bash\(npm:\*\)|Agent/);
  });

  it('keeps review commands as Codex-style orchestration prompts, not subagents', () => {
    for (const [file, subcommand] of [
      ['review.md', 'review'],
      ['adversarial-review.md', 'adversarial-review'],
    ]) {
      const source = readCommand(file);
      expect(source).toMatch(/disable-model-invocation: true/);
      expect(source).toMatch(
        /allowed-tools: Read, Glob, Grep, Bash\(node:\*\), Bash\(git:\*\), AskUserQuestion/,
      );
      expect(source).toMatch(/AskUserQuestion/);
      expect(source).toMatch(/run_in_background: true/);
      expect(source).toContain(
        `node "\${CLAUDE_PLUGIN_ROOT}/scripts/cursor-companion.mjs" ${subcommand} "$ARGUMENTS"`,
      );
      expect(source).toMatch(/Run in background/);
      expect(source).not.toMatch(/subagent_type|Agent|^!`node/m);
    }
  });

  it('routes rescue through the cursor-rescue subagent like the Codex plugin', () => {
    const source = readCommand('rescue.md');
    expect(source).toMatch(/allowed-tools: Bash\(node:\*\), AskUserQuestion, Agent/);
    expect(source).toMatch(/subagent_type: "cursor:cursor-rescue"/);
    expect(source).toMatch(/task-resume-candidate --json/);
    expect(source).not.toMatch(/^!`node/m);
    expect(source).toMatch(/Skill\(cursor:cursor-rescue\)/);
    expect(source).toMatch(/Skill\(cursor:rescue\)/);
    expect(source).toMatch(/run the `cursor:cursor-rescue` subagent in the background/);
    expect(source).toMatch(/default to foreground/);
    expect(source).toMatch(/Leave `--resume` and `--fresh` in the forwarded request/);
  });

  it('keeps the cursor-rescue subagent as a Codex-style thin forwarder', () => {
    const source = readAgent('cursor-rescue.md');
    expect(source).toMatch(/model: sonnet/);
    expect(source).toMatch(/Selection guidance:/);
    expect(source).toMatch(/prefer foreground for a small, clearly bounded rescue request/);
    expect(source).toMatch(/prefer background execution/);
    expect(source).toMatch(
      /Do not call `review`, `adversarial-review`, `status`, `result`, or `cancel`/,
    );
    expect(source).toMatch(/Return the stdout of the `cursor-companion` command exactly as-is/);
  });
});
