#!/usr/bin/env node
// Claude Code's apiKeyHelper for runs connected with an API key: prints the key
// saved under AI connections, so the key reaches the CLI without sitting in the
// agent's environment (lib/connections.mjs).
import { readSecret } from './connections.mjs';

const key = readSecret(process.argv[2] === 'claude' ? 'claude' : '', 'apiKey');
if (!key) { console.error('No API key saved for this engine.'); process.exit(1); }
process.stdout.write(key);
