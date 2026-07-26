import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const COMMANDS_DIR = new URL('../commands', import.meta.url).pathname;
const AGENTS_DIR = new URL('../agents', import.meta.url).pathname;
const MARKETPLACE_PATH = new URL('../../../.claude-plugin/marketplace.json', import.meta.url)
  .pathname;
const PLUGIN_JSON_PATH = new URL('../.claude-plugin/plugin.json', import.meta.url).pathname;
const SKILLS_DIR = new URL('../skills', import.meta.url).pathname;
const HOOKS_PATH = new URL('../hooks/hooks.json', import.meta.url).pathname;

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
      'debate.md',
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

  it('keeps debate as a read-only two-model orchestration prompt', () => {
    const source = readCommand('debate.md');
    expect(source).toMatch(/disable-model-invocation: true/);
    expect(source).toMatch(/allowed-tools: Bash\(node:\*\), AskUserQuestion/);
    expect(source).toMatch(/AskUserQuestion/);
    expect(source).toContain('Gemini + Composer (Recommended)');
    expect(source).toContain('--models gemini,composer');
    expect(source).toContain(
      'node "${CLAUDE_PLUGIN_ROOT}/scripts/cursor-companion.mjs" debate "$ARGUMENTS"',
    );
    expect(source).toContain(
      'If neither `--wait` nor `--background` is present, still run the debate in the foreground and wait for all turns to finish.',
    );
    expect(source).toContain(
      'Never set `run_in_background: true` unless the raw arguments literally include `--background`.',
    );
    expect(source).toMatch(/run_in_background: true/);
    expect(source).not.toMatch(/subagent_type|Agent|Bash\(git:\*\)|^!`node/m);
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
    expect(source).toMatch(/Default to foreground/);
    expect(source).toMatch(/Supported aliases include .*gemini/);
    expect(source).toMatch(/preserve that exact flag and value/);
    expect(source).toMatch(/Do not call `review`, `adversarial-review`, `result`, or `cancel`/);
    expect(source).toMatch(/Return the stdout of the `cursor-companion` command exactly as-is/);
  });

  it('pins an explicit Bash timeout that outlives the runtime watchdog', () => {
    // Without this the 120 s default budget backgrounds the shell and the user
    // is handed a shell id instead of Cursor's answer.
    for (const source of [readAgent('cursor-rescue.md'), readCommand('rescue.md')]) {
      expect(source).toMatch(/570000/);
    }
  });

  it('lets a backgrounded rescue resolve its own job instead of returning a bare id', () => {
    const agent = readAgent('cursor-rescue.md');
    expect(agent).toMatch(/status <job-id> --wait/);
    expect(readCommand('rescue.md')).toMatch(/status <job-id> --wait/);
  });

  it('binds the prompting skill to the rescue subagent', () => {
    const source = readAgent('cursor-rescue.md');
    expect(source).toMatch(/^skills:\n {2}- cursor-prompting$/m);
  });
});

describe('shipped skills', () => {
  const SKILLS = ['cursor-result-handling', 'cursor-prompting'];
  // AGENTS.md rule 8: Cursor prompts must never advertise Codex-only controls.
  const CODEX_ONLY = [
    /--effort/,
    /\bspark\b/i,
    /gpt-5/i,
    /--write\b/,
    /review gate/i,
    /\bcodex\b/i,
  ];

  it.each(SKILLS)('%s ships a parseable skill with frontmatter', (name) => {
    const source = readFileSync(join(SKILLS_DIR, name, 'SKILL.md'), 'utf8');
    expect(source.startsWith('---\n')).toBe(true);
    expect(source).toMatch(new RegExp(`^name: ${name}$`, 'm'));
    expect(source).toMatch(/^description: .+$/m);
    expect(source).toMatch(/^user-invocable: false$/m);
  });

  it.each(SKILLS)('%s advertises no Codex-only controls', (name) => {
    const source = readFileSync(join(SKILLS_DIR, name, 'SKILL.md'), 'utf8');
    for (const pattern of CODEX_ONLY) {
      expect(source).not.toMatch(pattern);
    }
  });

  it('forbids auto-applying review fixes', () => {
    const source = readFileSync(join(SKILLS_DIR, 'cursor-result-handling', 'SKILL.md'), 'utf8');
    expect(source).toMatch(/strictly forbidden/);
  });
});

describe('session lifecycle hooks', () => {
  it('registers SessionStart and SessionEnd only', () => {
    const hooks = JSON.parse(readFileSync(HOOKS_PATH, 'utf8'));
    expect(Object.keys(hooks.hooks).sort()).toEqual(['SessionEnd', 'SessionStart']);
    // AGENTS.md rule 8: no stop-time review gate until Cursor actually has one.
    expect(hooks.hooks.Stop).toBeUndefined();
  });

  it('invokes the lifecycle script through CLAUDE_PLUGIN_ROOT', () => {
    const raw = readFileSync(HOOKS_PATH, 'utf8');
    expect(raw).toMatch(/\$\{CLAUDE_PLUGIN_ROOT\}\/scripts\/session-lifecycle-hook\.mjs/);
  });
});
