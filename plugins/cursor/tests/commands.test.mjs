import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const COMMANDS_DIR = new URL('../commands', import.meta.url).pathname;

describe('slash command surface', () => {
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

  it('keeps every command wrapper on Bash(node:*) and quoted arguments', () => {
    for (const file of readdirSync(COMMANDS_DIR).filter((name) => name.endsWith('.md'))) {
      const source = readFileSync(join(COMMANDS_DIR, file), 'utf8');
      expect(source).toMatch(/allowed-tools: Bash\(node:\*\)/);
      expect(source).toMatch(/node "\$\{CLAUDE_PLUGIN_ROOT\}\/scripts\/.+\.mjs" -- "\$ARGUMENTS"/);
      expect(source).not.toMatch(/AskUserQuestion|Bash\(git:\*\)|Agent/);
    }
  });
});
