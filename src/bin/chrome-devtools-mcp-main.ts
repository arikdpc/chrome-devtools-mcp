/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import '../polyfill.js';

import process from 'node:process';

import {createMcpServer, logDisclaimers} from '../index.js';
import {logger, saveLogsToFile} from '../logger.js';
import {computeFlagUsage} from '../telemetry/flagUtils.js';
import {StdioServerTransport} from '../third_party/index.js';
import {checkForUpdates} from '../utils/check-for-updates.js';
import {VERSION} from '../version.js';

import {cliOptions, parseArguments} from './chrome-devtools-mcp-cli-options.js';

await checkForUpdates(
  'Run `npm install chrome-devtools-mcp@latest` to update.',
);

export const args = parseArguments(VERSION);

const logFile = args.logFile ? saveLogsToFile(args.logFile) : undefined;
if (
  process.env['CI'] ||
  process.env['CHROME_DEVTOOLS_MCP_NO_USAGE_STATISTICS']
) {
  console.error(
    "turning off usage statistics. process.env['CI'] || process.env['CHROME_DEVTOOLS_MCP_NO_USAGE_STATISTICS'] is set.",
  );
  args.usageStatistics = false;
}

if (process.env['CHROME_DEVTOOLS_MCP_CRASH_ON_UNCAUGHT'] !== 'true') {
  process.on('unhandledRejection', (reason, promise) => {
    logger('Unhandled promise rejection', promise, reason);
  });
}

logger(`Starting Chrome DevTools MCP Server v${VERSION}`);
const {server, clearcutLogger, shutdown} = await createMcpServer(args, {
  logFile,
});
const transport = new StdioServerTransport();
await server.connect(transport);
logger('Chrome DevTools MCP Server connected');
logDisclaimers(args);
void clearcutLogger?.logDailyActiveIfNeeded();
void clearcutLogger?.logServerStart(computeFlagUsage(args, cliOptions));

// Fire the per-session teardown on REAL disconnect/kill and AWAIT it before
// exiting. StdioServerTransport does not fire server.server.onclose on stdin
// EOF, and on client disconnect the subprocess is SIGTERM-killed first — so the
// fire-and-forget onclose (kept as a backup) never flushes and the per-session
// BrowserContext leaks in the shared Chrome reached via connect(). Awaiting
// shutdown() (→ disposeSession → sessionContext.close()) lets the CDP close
// flush before we exit. disposeSession() is idempotent; we also guard the exit
// so concurrent signals (e.g. SIGTERM + stdin 'end') don't double-run.
let shuttingDown = false;
async function gracefulShutdown(trigger: string): Promise<void> {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  logger(`Shutting down (${trigger}); tearing down session`);
  try {
    await shutdown();
  } catch (error) {
    logger('Error during shutdown teardown', error);
  }
  // Never close/disconnect the shared browser here — disposeSession() only
  // closes the per-session BrowserContext.
  process.exit(0);
}

process.on('SIGTERM', () => {
  void gracefulShutdown('SIGTERM');
});
process.on('SIGINT', () => {
  void gracefulShutdown('SIGINT');
});
process.stdin.on('end', () => {
  void gracefulShutdown('stdin end');
});
process.stdin.on('close', () => {
  void gracefulShutdown('stdin close');
});
