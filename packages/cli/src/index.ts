#!/usr/bin/env node
import { LocalMail } from '@localmail/sdk';

import { runCli } from './cli.js';

runCli(process.argv.slice(2), {
  sdkFactory: (opts) => new LocalMail(opts),
  stdout: process.stdout,
  stderr: process.stderr,
  env: process.env,
}).then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    console.error('localmail: fatal error', error);
    process.exitCode = 1;
  },
);
