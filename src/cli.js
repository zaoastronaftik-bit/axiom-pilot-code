#!/usr/bin/env node
// Source compatibility shim; build first with npm run build.
import { main } from '../dist/cli.js';
main().catch(error => { console.error(error.message); process.exitCode = 1; });
