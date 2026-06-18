#!/usr/bin/env node
import { main as companionMain } from './cursor-companion.mjs';
import { invokedAsScript } from './lib/invoked.mjs';

export async function main(rawArgv = process.argv.slice(2)) {
  return companionMain(['debate', ...rawArgv]);
}

if (invokedAsScript(import.meta.url)) {
  main()
    .then((code) => process.exit(code))
    .catch((err) => {
      process.stderr.write(`debate failed: ${err instanceof Error ? err.message : String(err)}\n`);
      process.exit(1);
    });
}
