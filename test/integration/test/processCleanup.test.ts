import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable, Writable } from 'node:stream';

import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { Server } from '@modelcontextprotocol/server';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';

// Use the local fixtures directory alongside this test file
const FIXTURES_DIR = path.resolve(__dirname, './__fixtures__');

/** True while the process with the given pid still exists. */
const isProcessAlive = (pid: number): boolean => {
    try {
        // Signal 0 performs error checking without actually delivering a signal.
        process.kill(pid, 0);
        return true;
    } catch (error: unknown) {
        // ESRCH = no such process; EPERM = exists but we cannot signal it (alive).
        if (error && typeof error === 'object' && 'code' in error && error.code === 'EPERM') {
            return true;
        }
        return false;
    }
};

/** Poll until `pid` is gone or the deadline elapses; returns true if it died. */
const waitForProcessExit = async (pid: number, timeoutMs: number): Promise<boolean> => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (!isProcessAlive(pid)) {
            return true;
        }
        await new Promise(resolve => setTimeout(resolve, 20));
    }
    return !isProcessAlive(pid);
};

describe('Process cleanup', () => {
    vi.setConfig({ testTimeout: 15_000 }); // 15 second timeout (needs margin for CI; close() alone can take ~4s for hanging servers)

    it('server should exit cleanly after closing transport', async () => {
        const server = new Server(
            {
                name: 'test-server',
                version: '1.0.0'
            },
            {
                capabilities: {}
            }
        );

        const mockReadable = new Readable({
                read() {
                    this.push(null); // signal EOF
                }
            }),
            mockWritable = new Writable({
                write(chunk, encoding, callback) {
                    callback();
                }
            });

        // Attach mock streams to process for the server transport
        const transport = new StdioServerTransport(mockReadable, mockWritable);
        await server.connect(transport);

        // Close the transport
        await transport.close();

        // ensure a proper disposal mock streams
        mockReadable.destroy();
        mockWritable.destroy();

        // If we reach here without hanging, the test passes
        // The test runner will fail if the process hangs
        expect(true).toBe(true);
    });

    it('onclose should be called exactly once', async () => {
        const client = new Client({
            name: 'test-client',
            version: '1.0.0'
        });

        const transport = new StdioClientTransport({
            command: 'node',
            args: ['--import', 'tsx', 'testServer.ts'],
            cwd: FIXTURES_DIR
        });

        await client.connect(transport);

        let onCloseWasCalled = 0;
        client.onclose = () => {
            onCloseWasCalled++;
        };

        await client.close();

        // A short delay to allow the close event to propagate
        await new Promise(resolve => setTimeout(resolve, 50));

        expect(onCloseWasCalled).toBe(1);
    });

    it('should exit cleanly for a server that hangs', async () => {
        const client = new Client({
            name: 'test-client',
            version: '1.0.0'
        });

        const transport = new StdioClientTransport({
            command: 'node',
            args: ['--import', 'tsx', 'serverThatHangs.ts'],
            cwd: FIXTURES_DIR
        });

        await client.connect(transport);
        await client.setLoggingLevel('debug');
        client.setNotificationHandler('notifications/message', notification => {
            console.debug('server log: ' + notification.params.data);
        });
        const serverPid = transport.pid!;

        await client.close();

        // A short delay to allow the close event to propagate
        await new Promise(resolve => setTimeout(resolve, 50));

        try {
            process.kill(serverPid, 9);
            throw new Error('Expected server to be dead but it is alive');
        } catch (error: unknown) {
            // 'ESRCH' the process doesn't exist
            if (error && typeof error === 'object' && 'code' in error && error.code === 'ESRCH') {
                // success
            } else throw error;
        }
    });

    // Regression test for #2023: when a server is launched via a wrapper command
    // that forks the real server as a descendant, close() must reap the whole
    // tree, not just the direct child. The fixture stands in for the wrapper and
    // spawns a grandchild that shares its process group; before the fix that
    // grandchild survived close() as an orphan.
    //
    // Process groups are POSIX-only; on Windows the equivalent path uses
    // taskkill /T and there is no process-group semantics to exercise here.
    it.runIf(process.platform !== 'win32')('should kill the whole process tree, not just the direct child', async () => {
        const tmpDir = mkdtempSync(path.join(tmpdir(), 'mcp-orphan-'));
        const pidFile = path.join(tmpDir, 'child.pid');

        const client = new Client({
            name: 'test-client',
            version: '1.0.0'
        });

        const transport = new StdioClientTransport({
            command: 'node',
            args: ['--import', 'tsx', 'serverWithChildProcess.ts'],
            cwd: FIXTURES_DIR,
            env: { ...process.env, CHILD_PID_FILE: pidFile } as Record<string, string>
        });

        try {
            await client.connect(transport);
            const wrapperPid = transport.pid!;

            // Wait for the fixture to spawn its grandchild and report the pid.
            let grandchildPid: number | undefined;
            const deadline = Date.now() + 5000;
            while (Date.now() < deadline) {
                try {
                    const raw = readFileSync(pidFile, 'utf8').trim();
                    if (raw) {
                        grandchildPid = Number(raw);
                        break;
                    }
                } catch {
                    // file not written yet
                }
                await new Promise(resolve => setTimeout(resolve, 20));
            }

            expect(grandchildPid, 'fixture did not report its grandchild pid').toBeDefined();
            expect(isProcessAlive(grandchildPid!), 'grandchild should be running before close()').toBe(true);

            await client.close();

            // The grandchild must die along with the wrapper. Before the fix it
            // would survive as an orphan and this would time out / return false.
            const wrapperDied = await waitForProcessExit(wrapperPid, 5000);
            const grandchildDied = await waitForProcessExit(grandchildPid!, 5000);

            expect(wrapperDied, 'wrapper process should be reaped by close()').toBe(true);
            expect(grandchildDied, 'orphaned grandchild should be reaped by close()').toBe(true);
        } finally {
            rmSync(tmpDir, { recursive: true, force: true });
        }
    });
});
