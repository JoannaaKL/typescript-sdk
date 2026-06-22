import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import process from 'node:process';
import { setInterval } from 'node:timers';

import { McpServer } from '@modelcontextprotocol/server';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';

// Reproduces the wrapper-command scenario from issue #2023: this process stands
// in for `npx`/`uvx`/`python -m`, spawning the "real" server as a grandchild of
// the client. The grandchild is intentionally NOT detached, so it inherits this
// process's group. Killing only this process's pid (the pre-fix behavior) would
// leave the grandchild running as an orphan; a process-group / tree kill reaps
// both.
const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    stdio: 'ignore'
});

// Hand the grandchild's pid back to the test through a file it can poll. Written
// synchronously before we connect so it is present by the time the client's
// connect() resolves.
const pidFile = process.env.CHILD_PID_FILE;
if (pidFile) {
    writeFileSync(pidFile, String(child.pid));
}

const transport = new StdioServerTransport();
const server = new McpServer({
    name: 'server-with-child-process',
    version: '1.0.0'
});

await server.connect(transport);

// Stay alive after stdin closes so that close() observes a still-running process
// (exitCode === null) and exercises the tree-kill path rather than the process
// exiting on its own.
setInterval(() => {}, 60_000);
