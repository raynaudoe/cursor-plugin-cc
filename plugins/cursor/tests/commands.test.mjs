import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const COMMANDS_DIR = new URL('../commands', import.meta.url).pathname;
const MARKETPLACE_PATH = new URL('../../../.claude-plugin/marketplace.json', import.meta.url)
  .pathname;
const PLUGIN_JSON_PATH = new URL('../plugin.json', import.meta.url).pathname;

describe('slash command surface', () => {
  it('keeps the install id separate from the cursor command namespace', () => {
    const marketplace = JSON.parse(readFileSync(MARKETPLACE_PATH, 'utf8'));
    const plugin = JSON.parse(readFileSync(PLUGIN_JSON_PATH, 'utf8'));
    expect(marketplace.name).toBe('cursor-plugin-cc');
    expect(marketplace.plugins[0].name).toBe('ez');
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

  it('keeps every command wrapper on Bash(node:*) and quoted arguments', () => {
    for (const file of readdirSync(COMMANDS_DIR).filter((name) => name.endsWith('.md'))) {
      const source = readFileSync(join(COMMANDS_DIR, file), 'utf8');
      expect(source).toMatch(/allowed-tools: Bash\(node:\*\)/);
      expect(source).toMatch(/node "\$\{CLAUDE_PLUGIN_ROOT\}\/scripts\/.+\.mjs" -- "\$ARGUMENTS"/);
      expect(source).not.toMatch(/AskUserQuestion|Bash\(git:\*\)|Agent/);
    }
  });
});
