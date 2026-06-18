#!/usr/bin/env node
import { main as companionMain } from './cursor-companion.mjs';

export async function main(rawArgv) {
  return companionMain(['status', ...rawArgv]);
}

import { invokedAsScript as __isScript } from './lib/invoked.mjs';
const invokedAsScript = __isScript(import.meta.url);

if (invokedAsScript) {
  main(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((err) => {
      process.stderr.write(`status failed: ${err instanceof Error ? err.message : String(err)}\n`);
      process.exit(1);
    });
}
