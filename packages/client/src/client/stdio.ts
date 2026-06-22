import type { ChildProcess, IOType } from 'node:child_process';
import { execFile } from 'node:child_process';
import process from 'node:process';
import type { Stream } from 'node:stream';
import { PassThrough } from 'node:stream';

import type { JSONRPCMessage, Transport } from '@modelcontextprotocol/core';
import { ReadBuffer, SdkError, SdkErrorCode, serializeMessage } from '@modelcontextprotocol/core';
import spawn from 'cross-spawn';

export type StdioServerParameters = {
    /**
     * The executable to run to start the server.
     */
    command: string;

    /**
     * Command line arguments to pass to the executable.
     */
    args?: string[];

    /**
     * The environment to use when spawning the process.
     *
     * If not specified, the result of {@linkcode getDefaultEnvironment} will be used.
     */
    env?: Record<string, string>;

    /**
     * How to handle stderr of the child process. This matches the semantics of Node's `child_process.spawn`.
     *
     * The default is `"inherit"`, meaning messages to stderr will be printed to the parent process's stderr.
     */
    stderr?: IOType | Stream | number;

    /**
     * The working directory to use when spawning the process.
     *
     * If not specified, the current working directory will be inherited.
     */
    cwd?: string;

    /**
     * Maximum size of the read buffer in bytes. If a single message exceeds
     * this size the transport will emit an error and close.
     *
     * Defaults to 10 MB.
     */
    maxBufferSize?: number;
};

/**
 * Environment variables to inherit by default, if an environment is not explicitly given.
 */
export const DEFAULT_INHERITED_ENV_VARS =
    process.platform === 'win32'
        ? [
              'APPDATA',
              'HOMEDRIVE',
              'HOMEPATH',
              'LOCALAPPDATA',
              'PATH',
              'PROCESSOR_ARCHITECTURE',
              'SYSTEMDRIVE',
              'SYSTEMROOT',
              'TEMP',
              'USERNAME',
              'USERPROFILE',
              'PROGRAMFILES'
          ]
        : /* list inspired by the default env inheritance of sudo */
          ['HOME', 'LOGNAME', 'PATH', 'SHELL', 'TERM', 'USER'];

/**
 * Returns a default environment object including only environment variables deemed safe to inherit.
 */
export function getDefaultEnvironment(): Record<string, string> {
    const env: Record<string, string> = {};

    for (const key of DEFAULT_INHERITED_ENV_VARS) {
        const value = process.env[key];
        if (value === undefined) {
            continue;
        }

        if (value.startsWith('()')) {
            // Skip functions, which are a security risk.
            continue;
        }

        env[key] = value;
    }

    return env;
}

/**
 * Terminate a spawned child process together with all of its descendants.
 *
 * MCP servers are frequently launched through a wrapper command (`npx`, `uvx`,
 * `python -m`, a shell script, …) that forks the real server as its own child.
 * Signaling only the direct child — as {@linkcode ChildProcess.kill} does —
 * leaves those descendants running as orphans. This helper signals the whole
 * tree:
 *
 * - **POSIX**: the child is spawned with `detached: true`, so it leads its own
 *   process group whose id equals its pid. `process.kill(-pid, signal)` delivers
 *   `signal` to every member of that group atomically, including descendants
 *   whose immediate parent has already exited.
 * - **Windows**: there is no process-group signaling, so `taskkill /T /F` walks
 *   and terminates the tree by pid. `/F` is always a forced kill, which matches
 *   Node's existing Windows behavior (`ChildProcess.kill()` maps to
 *   `TerminateProcess` regardless of the signal); the `signal` argument
 *   therefore only affects POSIX.
 *
 * Any failure — most commonly the tree already being gone — falls back to a
 * direct {@linkcode ChildProcess.kill} and is otherwise swallowed: `close()` is
 * best-effort and must never reject because cleanup raced with a natural exit.
 * The returned promise never rejects.
 */
function killProcessTree(childProcess: ChildProcess, signal: 'SIGTERM' | 'SIGKILL'): Promise<void> {
    const pid = childProcess.pid;

    // Without a pid we cannot address the group/tree; signal the handle directly.
    if (pid === undefined) {
        try {
            childProcess.kill(signal);
        } catch {
            // ignore — the process is already gone
        }
        return Promise.resolve();
    }

    if (process.platform === 'win32') {
        return new Promise<void>(resolve => {
            execFile('taskkill', ['/T', '/F', '/PID', String(pid)], { windowsHide: true }, error => {
                if (error) {
                    // taskkill failed (e.g. the tree already exited); fall back to
                    // a direct kill so a still-running direct child is reaped.
                    try {
                        childProcess.kill(signal);
                    } catch {
                        // ignore — the process is already gone
                    }
                }
                resolve();
            });
        });
    }

    // POSIX: the negative pid targets the entire process group led by the child.
    try {
        process.kill(-pid, signal);
    } catch {
        // The group may already be gone, or we may lack permission to signal
        // every member; fall back to signaling just the direct child.
        try {
            childProcess.kill(signal);
        } catch {
            // ignore — the process is already gone
        }
    }
    return Promise.resolve();
}

/**
 * Client transport for stdio: this will connect to a server by spawning a process and communicating with it over stdin/stdout.
 *
 * This transport is only available in Node.js environments.
 */
export class StdioClientTransport implements Transport {
    private _process?: ChildProcess;
    private _readBuffer: ReadBuffer;
    private _serverParams: StdioServerParameters;
    private _stderrStream: PassThrough | null = null;

    onclose?: () => void;
    onerror?: (error: Error) => void;
    onmessage?: (message: JSONRPCMessage) => void;

    constructor(server: StdioServerParameters) {
        this._serverParams = server;
        this._readBuffer = new ReadBuffer({ maxBufferSize: server.maxBufferSize });
        if (server.stderr === 'pipe' || server.stderr === 'overlapped') {
            this._stderrStream = new PassThrough();
        }
    }

    /**
     * Starts the server process and prepares to communicate with it.
     */
    async start(): Promise<void> {
        if (this._process) {
            throw new Error(
                'StdioClientTransport already started! If using Client class, note that connect() calls start() automatically.'
            );
        }

        return new Promise((resolve, reject) => {
            this._process = spawn(this._serverParams.command, this._serverParams.args ?? [], {
                // merge default env with server env because mcp server needs some env vars
                env: {
                    ...getDefaultEnvironment(),
                    ...this._serverParams.env
                },
                stdio: ['pipe', 'pipe', this._serverParams.stderr ?? 'inherit'],
                shell: false,
                // Spawn the child in its own process group on POSIX so the whole
                // tree (e.g. `npx`/`uvx`/`python -m` wrappers and their server
                // children) can be signaled at once via the negative PID in
                // `close()`. On Windows this is intentionally left off: `detached`
                // there breaks stdio redirection for wrapper commands such as
                // `npx` (see git history), and the process tree is reaped with
                // `taskkill /T` instead.
                detached: process.platform !== 'win32',
                windowsHide: process.platform === 'win32',
                cwd: this._serverParams.cwd
            });

            this._process.on('error', error => {
                reject(error);
                this.onerror?.(error);
            });

            this._process.on('spawn', () => {
                resolve();
            });

            this._process.on('close', _code => {
                this._process = undefined;
                this.onclose?.();
            });

            this._process.stdin?.on('error', error => {
                this.onerror?.(error);
            });

            this._process.stdout?.on('data', chunk => {
                try {
                    this._readBuffer.append(chunk);
                    this.processReadBuffer();
                } catch (error) {
                    this.onerror?.(error as Error);
                    this.close().catch(() => {});
                }
            });

            this._process.stdout?.on('error', error => {
                this.onerror?.(error);
            });

            if (this._stderrStream && this._process.stderr) {
                this._process.stderr.pipe(this._stderrStream);
            }
        });
    }

    /**
     * The `stderr` stream of the child process, if {@linkcode StdioServerParameters.stderr} was set to `"pipe"` or `"overlapped"`.
     *
     * If `stderr` piping was requested, a `PassThrough` stream is returned _immediately_, allowing callers to
     * attach listeners before the `start` method is invoked. This prevents loss of any early
     * error output emitted by the child process.
     */
    get stderr(): Stream | null {
        if (this._stderrStream) {
            return this._stderrStream;
        }

        return this._process?.stderr ?? null;
    }

    /**
     * The child process pid spawned by this transport.
     *
     * This is only available after the transport has been started.
     */
    get pid(): number | null {
        return this._process?.pid ?? null;
    }

    private processReadBuffer() {
        while (true) {
            try {
                const message = this._readBuffer.readMessage();
                if (message === null) {
                    break;
                }

                this.onmessage?.(message);
            } catch (error) {
                this.onerror?.(error as Error);
            }
        }
    }

    async close(): Promise<void> {
        if (this._process) {
            const processToClose = this._process;
            this._process = undefined;

            const closePromise = new Promise<void>(resolve => {
                processToClose.once('close', () => {
                    resolve();
                });
            });

            try {
                processToClose.stdin?.end();
            } catch {
                // ignore
            }

            await Promise.race([closePromise, new Promise(resolve => setTimeout(resolve, 2000).unref())]);

            if (processToClose.exitCode === null) {
                // Graceful: signal the whole process tree with SIGTERM and give
                // it a chance to shut down before escalating.
                await killProcessTree(processToClose, 'SIGTERM');

                await Promise.race([closePromise, new Promise(resolve => setTimeout(resolve, 2000).unref())]);
            }

            if (processToClose.exitCode === null) {
                // Forceful: the tree ignored SIGTERM, so SIGKILL it.
                await killProcessTree(processToClose, 'SIGKILL');
            }
        }

        this._readBuffer.clear();
    }

    send(message: JSONRPCMessage): Promise<void> {
        return new Promise(resolve => {
            if (!this._process?.stdin) {
                throw new SdkError(SdkErrorCode.NotConnected, 'Not connected');
            }

            const json = serializeMessage(message);
            if (this._process.stdin.write(json)) {
                resolve();
            } else {
                this._process.stdin.once('drain', resolve);
            }
        });
    }
}
