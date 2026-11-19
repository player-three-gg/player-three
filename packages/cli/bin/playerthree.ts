#!/usr/bin/env node
// playerthree: the CLI entry (lint, audit, dev, db reset); see src/main.ts.
import { main } from '../src/main.ts';

process.exitCode = await main(process.argv.slice(2));
