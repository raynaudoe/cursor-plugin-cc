#!/usr/bin/env node
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';

import { join, resolve } from 'node:path';

const repoRoot = resolve(new URL('../..', import.meta.url).pathname);
const pluginRoot = join(repoRoot, 'plugins', 'cursor');

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

const pkg = readJson(join(pluginRoot, 'package.json'));
readJson(join(pluginRoot, 'package-lock.json'));
readJson(join(repoRoot, '.claude-plugin', 'marketplace.json'));

// Claude Code discovers a plugin manifest at `<plugin>/.claude-plugin/plugin.json`.
// A manifest at the plugin root fails `claude plugin validate` and the declared
// version is discarded, so pin the supported location.
readJson(join(pluginRoot, '.claude-plugin', 'plugin.json'));
if (existsSync(join(pluginRoot, 'plugin.json'))) {
  throw new Error(
    'plugins/cursor/plugin.json must live at plugins/cursor/.claude-plugin/plugin.json.',
  );
}

const runtimeDeps = [
  ...Object.keys(pkg.dependencies ?? {}),
  ...Object.keys(pkg.optionalDependencies ?? {}),
  ...Object.keys(pkg.peerDependencies ?? {}),
];

if (runtimeDeps.length > 0) {
  throw new Error(`Runtime dependencies are not allowed: ${runtimeDeps.join(', ')}`);
}

const forbidden = [];

function walk(dir) {
  if (!existsSync(dir)) return;
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    const stat = statSync(path);
    if (stat.isDirectory()) {
      if (name === 'node_modules' || name === 'coverage') continue;
      if (name === 'dist') forbidden.push(path);
      walk(path);
      continue;
    }
    if (path.endsWith('.ts') || path.endsWith('.tsx')) forbidden.push(path);
  }
}

walk(pluginRoot);

if (forbidden.length > 0) {
  throw new Error(`Forbidden generated or TypeScript files found:\n${forbidden.join('\n')}`);
}

console.log('Repo guardrails passed.');
