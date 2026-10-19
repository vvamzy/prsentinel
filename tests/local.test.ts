import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';

import {
  LOCAL_MODELS,
  buildServerArgs,
  ensureLocalServer,
  ensureModel,
  formatBytes,
  isLocalModel,
  modelCacheDir,
  modelFilename,
  resolveLocalModel,
  startLocalServer,
  stopLocalServers,
  type LocalModelSpec,
} from '../src/llm/local.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const CONTENT = Buffer.from('not a real GGUF, but byte-exact for hashing');
const GOOD_SHA = createHash('sha256').update(CONTENT).digest('hex');

function testSpec(overrides: Partial<LocalModelSpec> = {}): LocalModelSpec {
  return {
    id: 'test-model',
    url: 'https://example.test/models/test-model.gguf',
    bytes: CONTENT.length,
    sha256: GOOD_SHA,
    ctx: 4096,
    description: 'a fixture',
    ...overrides,
  };
}

/** A fetch that always answers with CONTENT. */
function okFetch(): typeof globalThis.fetch {
  return (async () => new Response(CONTENT)) as unknown as typeof globalThis.fetch;
}

/** Minimal stand-in for a spawned llama-server. */
class FakeChild extends EventEmitter {
  stdout = new PassThrough();
  stderr = new PassThrough();
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  signals: string[] = [];

  kill(signal?: NodeJS.Signals): boolean {
    const sig = signal ?? 'SIGTERM';
    this.signals.push(sig);
    setImmediate(() => {
      this.signalCode = sig;
      this.emit('exit', null, sig);
    });
    return true;
  }
}

// ---------------------------------------------------------------------------

describe('local model registry', () => {
  it('recognises the local/ prefix only', () => {
    expect(isLocalModel('local/qwen2.5-coder-7b-instruct')).toBe(true);
    expect(isLocalModel('openai/gpt-4o-mini')).toBe(false);
    expect(isLocalModel('localish/model')).toBe(false);
    expect(isLocalModel('')).toBe(false);
  });

  it('resolves a known model', () => {
    expect(resolveLocalModel('local/qwen2.5-coder-7b-instruct').id).toBe(
      'qwen2.5-coder-7b-instruct',
    );
  });

  it('lists every known model when the id is wrong', () => {
    expect(() => resolveLocalModel('local/nope')).toThrowError(/Unknown local model "nope"/);
    expect(() => resolveLocalModel('local/nope')).toThrowError(/local\/qwen2\.5-coder-7b-instruct/);
  });

  it('has plausible metadata for every bundled model', () => {
    const entries = Object.entries(LOCAL_MODELS);
    expect(entries.length).toBeGreaterThan(0);
    for (const [key, spec] of entries) {
      expect(key).toBe(spec.id);
      expect(spec.url).toMatch(/^https:\/\/huggingface\.co\/.+\/resolve\/main\/.+\.gguf$/);
      expect(spec.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(spec.bytes).toBeGreaterThan(100_000_000);
      expect(spec.ctx).toBeGreaterThanOrEqual(4096);
      // The free runner has 16 GB of RAM; a 14 GB Q4 model would not fit
      // alongside Node once the KV cache is allocated.
      expect(spec.bytes).toBeLessThan(12_000_000_000);
    }
  });

  it('derives the filename from the URL', () => {
    expect(modelFilename(testSpec())).toBe('test-model.gguf');
  });
});

describe('modelCacheDir', () => {
  it('defaults to a directory inside the repo root', () => {
    expect(modelCacheDir('/work/repo')).toContain('.prsentinel');
    expect(modelCacheDir('/work/repo')).toContain('models');
  });

  it('honours an override, and ignores a blank one', () => {
    expect(modelCacheDir('/work/repo', '/cache/models')).toBe('/cache/models');
    expect(modelCacheDir('/work/repo', '   ')).toContain('.prsentinel');
  });
});

describe('formatBytes', () => {
  it('scales units', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(4_683_073_536)).toBe('4.4 GB');
  });
});

describe('buildServerArgs', () => {
  it('binds to loopback and passes the model', () => {
    const args = buildServerArgs(testSpec(), '/cache/m.gguf', { port: 9099, threads: 4 });
    expect(args).toEqual([
      '--model', '/cache/m.gguf',
      '--host', '127.0.0.1',
      '--port', '9099',
      '--ctx-size', '4096',
      '--threads', '4',
      '--parallel', '1',
      '--no-webui',
    ]);
  });

  it('appends model-specific flags last', () => {
    const spec = testSpec({ extraArgs: ['--chat-template-kwargs', '{"enable_thinking":false}'] });
    const args = buildServerArgs(spec, '/m.gguf', { port: 1, threads: 1 });
    expect(args.slice(-2)).toEqual(['--chat-template-kwargs', '{"enable_thinking":false}']);
  });
});

describe('ensureModel', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'prsentinel-cache-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('downloads, verifies, and records a marker', async () => {
    const spec = testSpec();
    const path = await ensureModel(spec, { cacheDir: dir, fetchImpl: okFetch() });

    expect(existsSync(path)).toBe(true);
    expect(existsSync(`${path}.part`)).toBe(false);
    expect(existsSync(`${path}.sha256`)).toBe(true);
  });

  it('reuses the cache without touching the network', async () => {
    const spec = testSpec();
    await ensureModel(spec, { cacheDir: dir, fetchImpl: okFetch() });

    const exploding = (async () => {
      throw new Error('should not be called');
    }) as unknown as typeof globalThis.fetch;

    await expect(ensureModel(spec, { cacheDir: dir, fetchImpl: exploding })).resolves.toContain(
      'test-model.gguf',
    );
  });

  it('re-downloads when the cached size is wrong', async () => {
    const spec = testSpec();
    const path = await ensureModel(spec, { cacheDir: dir, fetchImpl: okFetch() });

    // Simulate a truncated file left behind by a killed job.
    writeFileSync(path, CONTENT.subarray(0, 4));
    const again = await ensureModel(spec, { cacheDir: dir, fetchImpl: okFetch() });
    expect(existsSync(again)).toBe(true);
    expect(existsSync(`${again}.part`)).toBe(false);
  });

  it('rejects a checksum mismatch and leaves no partial file', async () => {
    const spec = testSpec({ sha256: 'a'.repeat(64) });
    await expect(ensureModel(spec, { cacheDir: dir, fetchImpl: okFetch() })).rejects.toThrowError(
      /checksum mismatch/,
    );

    expect(existsSync(join(dir, 'test-model.gguf'))).toBe(false);
    expect(existsSync(join(dir, 'test-model.gguf.part'))).toBe(false);
  });

  it('surfaces a failed download', async () => {
    const spec = testSpec();
    const failing = (async () => new Response('nope', { status: 404, statusText: 'Not Found' })) as
      unknown as typeof globalThis.fetch;

    await expect(ensureModel(spec, { cacheDir: dir, fetchImpl: failing })).rejects.toThrowError(
      /download failed: 404/,
    );
  });
});

describe('startLocalServer', () => {
  it('waits for the health endpoint and reports a loopback base URL', async () => {
    const child = new FakeChild();
    const spawnImpl = (() => child) as unknown as typeof import('node:child_process').spawn;
    const fetchImpl = (async () => new Response('{"status":"ok"}')) as unknown as typeof globalThis.fetch;

    const server = await startLocalServer(testSpec(), '/cache/m.gguf', {
      port: 8123,
      threads: 4,
      spawnImpl,
      fetchImpl,
    });

    expect(server.baseUrl).toBe('http://127.0.0.1:8123/v1');
    expect(server.model).toBe('test-model');
    // The server must only ever be reachable on loopback.
    expect(server.baseUrl).not.toContain('0.0.0.0');

    await server.stop();
    expect(child.signals).toContain('SIGTERM');
  });

  it('reports the captured output when the server dies during startup', async () => {
    const child = new FakeChild();
    const spawnImpl = (() => {
      setImmediate(() => {
        child.stderr.write('llama_model_load: failed to load model\n');
        setImmediate(() => {
          child.exitCode = 1;
          child.emit('exit', 1, null);
        });
      });
      return child;
    }) as unknown as typeof import('node:child_process').spawn;
    const fetchImpl = (async () => {
      throw new Error('connection refused');
    }) as unknown as typeof globalThis.fetch;

    await expect(
      startLocalServer(testSpec(), '/cache/missing.gguf', {
        port: 8124,
        startTimeoutMs: 5_000,
        spawnImpl,
        fetchImpl,
      }),
    ).rejects.toThrowError(/exited before it was ready/);
  });
});

describe('ensureLocalServer', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'prsentinel-local-'));
  });

  afterEach(async () => {
    await stopLocalServers();
    rmSync(dir, { recursive: true, force: true });
  });

  it('starts one server per model even when asked twice', async () => {
    let spawned = 0;
    const spawnImpl = (() => {
      spawned++;
      return new FakeChild();
    }) as unknown as typeof import('node:child_process').spawn;
    // Serves model bytes to the download and an ok status to the health poll.
    const fetchImpl = (async (url: string) =>
      String(url).includes('/health') ? new Response('{"status":"ok"}') : new Response(CONTENT)) as
      unknown as typeof globalThis.fetch;

    // `verify: false` because the fixture bytes cannot match the real GGUF hash.
    const opts = { cacheDir: dir, fetchImpl, spawnImpl, port: 8125, verify: false } as const;
    const [a, b] = await Promise.all([
      ensureLocalServer('local/qwen2.5-coder-7b-instruct', opts),
      ensureLocalServer('local/qwen2.5-coder-7b-instruct', opts),
    ]);

    expect(a).toBe(b);
    expect(spawned).toBe(1);

    await stopLocalServers();
  });

  it('refuses an unknown model before spawning anything', async () => {
    let spawned = 0;
    const spawnImpl = (() => {
      spawned++;
      return new FakeChild();
    }) as unknown as typeof import('node:child_process').spawn;

    await expect(
      ensureLocalServer('local/not-a-model', { cacheDir: dir, spawnImpl }),
    ).rejects.toThrowError(/Unknown local model/);
    expect(spawned).toBe(0);
  });
});
