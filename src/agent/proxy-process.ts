import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { createServer } from 'node:net';
import { join, resolve } from 'node:path';

export interface RuntimeProxyConnection {
  baseUrl: string;
  token: string;
}

let connectionPromise: Promise<RuntimeProxyConnection> | null = null;
let child: ChildProcessWithoutNullStreams | null = null;

async function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(() => {
        if (address && typeof address === 'object') resolvePort(address.port);
        else reject(new Error('Failed to allocate local proxy port'));
      });
    });
  });
}

function proxyBinaryPath(): string {
  if (process.env.PI_PROXY_BIN?.trim()) return process.env.PI_PROXY_BIN.trim();
  const exe = process.platform === 'win32' ? 'pi-runtime-proxy.exe' : 'pi-runtime-proxy';
  const candidates = [
    resolve(process.cwd(), 'runtime-proxy', 'target', 'debug', exe),
    resolve(process.cwd(), 'runtime-proxy', 'target', 'release', exe),
    join(process.resourcesPath ?? process.cwd(), 'runtime-proxy', exe),
  ];
  const found = candidates.find((candidate) => existsSync(candidate));
  if (found) return found;
  throw new Error(
    `Pi runtime proxy binary not found. Run "npm run proxy:build" or set PI_PROXY_BIN. Looked for: ${candidates.join(', ')}`,
  );
}

async function waitForHealth(baseUrl: string, token: string): Promise<void> {
  const deadline = Date.now() + 15_000;
  let lastError: unknown = null;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${baseUrl}/api/health`, {
        headers: { authorization: `Bearer ${token}` },
      });
      if (response.ok) return;
      lastError = new Error(`health returned ${response.status}`);
    } catch (err) {
      lastError = err;
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 200));
  }
  throw new Error(
    `Timed out waiting for Pi runtime proxy: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
  );
}

export async function ensureRuntimeProxy(): Promise<RuntimeProxyConnection> {
  if (connectionPromise) return connectionPromise;
  connectionPromise = (async () => {
    const externalUrl = process.env.PI_PROXY_URL?.trim();
    const externalToken = process.env.PI_PROXY_TOKEN?.trim();
    if (externalUrl) {
      const token = externalToken || '';
      await waitForHealth(externalUrl.replace(/\/$/, ''), token);
      return { baseUrl: externalUrl.replace(/\/$/, ''), token };
    }

    const port = process.env.PI_PROXY_PORT?.trim()
      ? Number(process.env.PI_PROXY_PORT.trim())
      : await freePort();
    if (!Number.isFinite(port) || port <= 0) throw new Error('Invalid PI_PROXY_PORT');
    const token = externalToken || randomUUID();
    const baseUrl = `http://127.0.0.1:${port}`;
    const bin = proxyBinaryPath();

    child = spawn(bin, [], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        PI_PROXY_HOST: '127.0.0.1',
        PI_PROXY_PORT: String(port),
        PI_PROXY_TOKEN: token,
      },
      stdio: 'pipe',
      windowsHide: true,
    });
    child.stdout.on('data', (chunk) => process.stdout.write(`[pi-proxy] ${chunk.toString()}`));
    child.stderr.on('data', (chunk) => process.stderr.write(`[pi-proxy] ${chunk.toString()}`));
    child.on('exit', (code, signal) => {
      if (child) {
        process.stderr.write(`[pi-proxy] exited code=${code ?? 'null'} signal=${signal ?? 'null'}\n`);
      }
      child = null;
      connectionPromise = null;
    });

    await waitForHealth(baseUrl, token);
    return { baseUrl, token };
  })();
  return connectionPromise;
}

export async function shutdownRuntimeProxy(): Promise<void> {
  const proc = child;
  child = null;
  connectionPromise = null;
  if (!proc || proc.killed) return;
  await new Promise<void>((resolveShutdown) => {
    const timer = setTimeout(() => {
      try {
        proc.kill('SIGKILL');
      } catch {
        // best effort
      }
      resolveShutdown();
    }, 2_000);
    proc.once('exit', () => {
      clearTimeout(timer);
      resolveShutdown();
    });
    try {
      proc.kill('SIGTERM');
    } catch {
      clearTimeout(timer);
      resolveShutdown();
    }
  });
}
