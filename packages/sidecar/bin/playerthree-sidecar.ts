#!/usr/bin/env node
// playerthree-sidecar: the sidecar host for non-JS game servers; see src/cli.ts.
import { main } from '../src/cli.ts';

process.exitCode = await main(process.argv.slice(2));
