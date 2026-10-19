import { createHash } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import {
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { cpus } from 'node:os';
import { join } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline as streamPipeline } from 'node:stream/promises';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';

import { log } from '../log.js';

/**
 * Self-contained local models.
 *
 * A model id of the form `local/<id>` means "run the model here, inside the
 * action container". Nothing is sent to a third party, and no API key is
 * needed.
 *
 * There is no bespoke inference code path: `llama-server` speaks the OpenAI
 * chat-completions API, so we start it on loopback and hand its base URL to the
 * existing `OpenAICompatProvider`. The whole review pipeline is unaware that
 * the model is local.
 *
 * The container is destroyed when the job ends, so there is nothing to tear
 * down beyond stopping the child process. What does *not* come for free is the
 * model weights: they are gigabytes, and the runner has no persistent disk.
 * `ensureModel` downloads to a cache directory that a workflow can restore with
 * `actions/cache`, and verifies a SHA-256 before reuse.
 */

export const LOCAL_MODEL_PREFIX = 'local/';

export interface LocalModelSpec {
  /** Id after the `local/` prefix. */
  id: string;
  /** Direct GGUF download URL. */
  url: string;
  /** Exact byte size, from the HuggingFace LFS pointer. Used to spot truncation. */
  bytes: number;
  /** SHA-256 of the GGUF, from the HuggingFace LFS pointer. */
  sha256: string;
  /** Context window to start the server with. */
  ctx: number;
  /** Extra llama-server flags, for models that need one (e.g. Qwen3 thinking). */
  extraArgs?: string[];
  description: string;
}

/**
 * Known local models, all Q4_K_M (the usual quality/size knee).
 *
 * Sizing assumes the free GitHub-hosted runner: 4 vCPU / 16 GB / 14 GB disk.
 * RAM is not the binding constraint — CPU throughput is — so these are the
 * largest models that still produce a review in a sensible time. Adding a model
 * is one entry, provided the byte size and SHA-256 come from the LFS pointer
 * rather than a by-hand guess.
 */
export const LOCAL_MODELS: Record<string, LocalModelSpec> = {
  'qwen2.5-coder-7b-instruct': {
    id: 'qwen2.5-coder-7b-instruct',
    url: 'https://huggingface.co/Qwen/Qwen2.5-Coder-7B-Instruct-GGUF/resolve/main/qwen2.5-coder-7b-instruct-q4_k_m.gguf',
    bytes: 4683073536,
    sha256: '509287f78cb4d4cf6b3843734733b914b2c158e43e22a7f4bf5e963800894d3c',
    ctx: 32768,
    description: 'Qwen2.5-Coder 7B Instruct, Q4_K_M (~4.4 GB). Default: best quality that fits the free runner.',
  },
  'qwen2.5-coder-3b-instruct': {
    id: 'qwen2.5-coder-3b-instruct',
    url: 'https://huggingface.co/Qwen/Qwen2.5-Coder-3B-Instruct-GGUF/resolve/main/qwen2.5-coder-3b-instruct-q4_k_m.gguf',
    bytes: 2104932800,
    sha256: '724fb256bec1ff062b2f65e4569e871ad2e95ab2a3989723d1769c54294730b7',
    ctx: 32768,
    description: 'Qwen2.5-Coder 3B Instruct, Q4_K_M (~2.0 GB). Roughly 2-3x faster, noticeably weaker.',
  },
  'qwen2.5-coder-1.5b-instruct': {
    id: 'qwen2.5-coder-1.5b-instruct',
    url: 'https://huggingface.co/Qwen/Qwen2.5-Coder-1.5B-Instruct-GGUF/resolve/main/qwen2.5-coder-1.5b-instruct-q4_k_m.gguf',
    bytes: 1117320768,
    sha256: 'cc324af070c2ecbfd324a30884d2f951a7ff756aba85cb811a6ec436933bb046',
    ctx: 32768,
    description: 'Qwen2.5-Coder 1.5B Instruct, Q4_K_M (~1.0 GB). Fastest, but expect noise.',
  },
};

export const DEFAULT_LOCAL_MODEL = 'qwen2.5-coder-7b-instruct';

/** True when `model` selects a model prsentinel runs itself. */
export function isLocalModel(model: string): boolean {
  return model.startsWith(LOCAL_MODEL_PREFIX);
}

/** Resolve `local/<id>`, or throw naming the models that do exist. */
export function resolveLocalModel(model: string): LocalModelSpec {
  const id = model.slice(LOCAL_MODEL_PREFIX.length);
  const spec = LOCAL_MODELS[id];
  if (!spec) {
    const known = Object.entries(LOCAL_MODELS)
      .map(([key, s]) => `  local/${key} — ${s.description}`)
      .join('\n');
    throw new Error(`Unknown local model "${id}". Available:\n${known}`);
  }
  return spec;
}

/** Where GGUF files live. Overridable so a workflow can point at a cache mount. */
export function modelCacheDir(repoRoot: string, override?: string): string {
  const trimmed = override?.trim();
  return trimmed ? trimmed : join(repoRoot, '.prsentinel', 'models');
}

/** Filename of the GGUF for a spec, taken from its URL. */
export function modelFilename(spec: LocalModelSpec): string {
  const slash = spec.url.lastIndexOf('/');
  return slash === -1 ? spec.url : spec.url.slice(slash + 1);
}

export function formatBytes(bytes: number): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value >= 10 || unit === 0 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

// ---------------------------------------------------------------------------
// Model acquisition
// ---------------------------------------------------------------------------

export interface EnsureModelOptions {
  cacheDir: string;
  /** Injected in tests. Defaults to the global fetch. */
  fetchImpl?: typeof globalThis.fetch;
  /** Skip the SHA-256 check. Only useful for debugging a corrupt download. */
  verify?: boolean;
}

/**
 * Return a path to the GGUF, downloading it if the cache is cold.
 *
 * A file is only trusted when its size matches the LFS pointer *and* a sibling
 * `.sha256` marker records the digest we verified when it arrived. That makes
 * the steady state cheap (two `stat` calls) while still catching a truncated or
 * corrupted download.
 */
export async function ensureModel(spec: LocalModelSpec, opts: EnsureModelOptions): Promise<string> {
  mkdirSync(opts.cacheDir, { recursive: true });

  const file = join(opts.cacheDir, modelFilename(spec));
  const marker = `${file}.sha256`;

  if (isCached(file, marker, spec)) {
    log.info(`Local model cached: ${file}`);
    return file;
  }

  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  const tmp = `${file}.part`;
  log.info(`Downloading ${spec.id} (${formatBytes(spec.bytes)}) — this happens once per cache miss.`);

  const hash = createHash('sha256');
  let received = 0;
  let lastLogged = 0;

  try {
    const res = await fetchImpl(spec.url, { redirect: 'follow' });
    if (!res.ok || !res.body) {
      throw new Error(`download failed: ${res.status} ${res.statusText}`);
    }
    const total = Number(res.headers.get('content-length') ?? '') || spec.bytes;

    const meter = new Transform({
      transform(chunk, _enc, cb) {
        const buf = chunk as Buffer;
        hash.update(buf);
        received += buf.length;
        if (received - lastLogged >= total / 10) {
          lastLogged = received;
          log.info(`  … ${Math.min(100, Math.round((received / total) * 100))}% (${formatBytes(received)})`);
        }
        cb(null, buf);
      },
    });

    await streamPipeline(
      Readable.fromWeb(res.body as WebReadableStream<Uint8Array>),
      meter,
      createWriteStream(tmp),
    );

    if (opts.verify !== false) {
      const digest = hash.digest('hex');
      if (digest !== spec.sha256) {
        throw new Error(`checksum mismatch for ${spec.id}: expected ${spec.sha256}, got ${digest}`);
      }
    }

    writeFileSync(marker, `${spec.sha256}\n`, 'utf8');
    renameSync(tmp, file);
    log.info(`Local model ready: ${file} (${formatBytes(received)})`);
    return file;
  } catch (err) {
    // A half-written file must never be mistaken for a cached one.
    try {
      if (existsSync(tmp)) unlinkSync(tmp);
    } catch {
      /* best effort */
    }
    throw err;
  }
}

function isCached(file: string, marker: string, spec: LocalModelSpec): boolean {
  try {
    if (!existsSync(file) || !existsSync(marker)) return false;
    if (statSync(file).size !== spec.bytes) return false;
    return readFileSync(marker, 'utf8').trim() === spec.sha256;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Server lifecycle
// ---------------------------------------------------------------------------

export interface LocalServerHandle {
  /** Base URL to hand to the OpenAI-compatible provider. */
  baseUrl: string;
  model: string;
  port: number;
  stop(): Promise<void>;
}

export interface StartServerOptions {
  /** Path to llama-server. Defaults to `$PRSENTINEL_LLAMA_SERVER` or PATH. */
  serverBin?: string;
  /** Defaults to `$PRSENTINEL_LOCAL_PORT` or 8080. */
  port?: number;
  /** Defaults to `$PRSENTINEL_LOCAL_THREADS` or the CPU count. */
  threads?: number;
  /** Defaults to `$PRSENTINEL_LOCAL_START_TIMEOUT_MS` or 5 minutes. */
  startTimeoutMs?: number;
  fetchImpl?: typeof globalThis.fetch;
  spawnImpl?: typeof spawn;
}

/** The llama-server argv, kept separate so it can be asserted in tests. */
export function buildServerArgs(
  spec: LocalModelSpec,
  modelPath: string,
  opts: { port: number; threads: number; parallel?: number },
): string[] {
  return [
    '--model', modelPath,
    '--host', '127.0.0.1',
    '--port', String(opts.port),
    '--ctx-size', String(spec.ctx),
    '--threads', String(opts.threads),
    // One slot: inference already saturates every core, so extra slots only
    // split the KV cache without adding throughput.
    '--parallel', String(opts.parallel ?? 1),
    '--no-webui',
    ...(spec.extraArgs ?? []),
  ];
}

function envPositiveInt(name: string): number | undefined {
  const raw = process.env[name];
  if (!raw) return undefined;
  const value = Number(raw);
  return Number.isInteger(value) && value > 0 ? value : undefined;
}

/** Start llama-server and wait until it answers its health endpoint. */
export async function startLocalServer(
  spec: LocalModelSpec,
  modelPath: string,
  opts: StartServerOptions = {},
): Promise<LocalServerHandle> {
  const bin = opts.serverBin ?? process.env.PRSENTINEL_LLAMA_SERVER ?? 'llama-server';
  const port = opts.port ?? envPositiveInt('PRSENTINEL_LOCAL_PORT') ?? 8080;
  const threads = opts.threads ?? envPositiveInt('PRSENTINEL_LOCAL_THREADS') ?? Math.max(1, cpus().length);
  const startTimeoutMs =
    opts.startTimeoutMs ?? envPositiveInt('PRSENTINEL_LOCAL_START_TIMEOUT_MS') ?? 300_000;
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  const spawnImpl = opts.spawnImpl ?? spawn;

  log.info(`Starting llama-server: ${bin} (threads=${threads}, ctx=${spec.ctx}, port=${port})`);

  const child = spawnImpl(bin, buildServerArgs(spec, modelPath, { port, threads }), {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env },
  });

  // Keep a ring buffer of output for the failure message, and surface only
  // genuine errors: llama.cpp logs a line per request, which would drown the
  // action log.
  const tail: string[] = [];
  const capture = (stream: NodeJS.ReadableStream | null): void => {
    if (!stream) return;
    let partial = '';
    stream.on('data', (chunk: Buffer) => {
      partial += chunk.toString('utf8');
      const lines = partial.split('\n');
      partial = lines.pop() ?? '';
      for (const line of lines) {
        const text = line.trim();
        if (text === '') continue;
        tail.push(text);
        if (tail.length > 50) tail.shift();
        if (/\b(error|failed|fatal)\b/i.test(text)) log.warn(`llama-server: ${text}`);
      }
    });
  };
  capture(child.stdout);
  capture(child.stderr);

  let exit: { code: number | null; signal: NodeJS.Signals | null } | null = null;
  child.once('exit', (code, signal) => {
    exit = { code, signal };
  });

  const baseUrl = `http://127.0.0.1:${port}/v1`;
  const deadline = Date.now() + startTimeoutMs;

  while (Date.now() < deadline) {
    const died = exit as { code: number | null; signal: NodeJS.Signals | null } | null;
    if (died) {
      throw new Error(
        `llama-server exited before it was ready (code=${died.code} signal=${died.signal}).\n${tail.join('\n')}`,
      );
    }
    try {
      const res = await fetchImpl(`http://127.0.0.1:${port}/health`);
      if (res.ok) {
        log.notice(`llama-server ready at ${baseUrl} (model=${spec.id})`);
        return { baseUrl, model: spec.id, port, stop: () => stopChild(child) };
      }
    } catch {
      /* not listening yet */
    }
    await delay(500);
  }

  await stopChild(child);
  throw new Error(`llama-server was not ready within ${startTimeoutMs} ms.\n${tail.join('\n')}`);
}

async function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;

  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        /* already gone */
      }
      resolve();
    }, 5_000);
    timer.unref?.();

    child.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });

    try {
      child.kill('SIGTERM');
    } catch {
      clearTimeout(timer);
      resolve();
    }
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

// ---------------------------------------------------------------------------
// Process-wide singleton
// ---------------------------------------------------------------------------

/**
 * One server per (model, cache dir) per process. Starting a second copy would
 * load several gigabytes twice and fight for the same cores.
 */
const running = new Map<string, Promise<LocalServerHandle>>();

/** Download if needed, then start (or reuse) the server for `model`. */
export async function ensureLocalServer(
  model: string,
  opts: EnsureModelOptions & StartServerOptions,
): Promise<LocalServerHandle> {
  const spec = resolveLocalModel(model);
  const key = `${spec.id}|${opts.cacheDir}`;

  const existing = running.get(key);
  if (existing) return existing;

  const pending = (async () => {
    const path = await ensureModel(spec, opts);
    return startLocalServer(spec, path, opts);
  })();

  running.set(key, pending);
  try {
    return await pending;
  } catch (err) {
    // Let a later call retry rather than caching a rejected promise.
    running.delete(key);
    throw err;
  }
}

/** Stop every server this process started. Safe to call more than once. */
export async function stopLocalServers(): Promise<void> {
  const pending = [...running.values()];
  running.clear();
  await Promise.all(
    pending.map(async (entry) => {
      try {
        const server = await entry;
        await server.stop();
        log.info(`llama-server stopped (model=${server.model})`);
      } catch {
        /* the server never started, or is already gone */
      }
    }),
  );
}
