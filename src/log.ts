/**
 * Minimal structured logger.
 *
 * GitHub Actions annotates `::error::`/`::warning::` lines, so we emit those
 * when running in CI and fall back to plain stderr locally. Multi-line
 * messages are base64-encoded so Actions doesn't truncate them.
 */

const IS_ACTIONS = process.env.GITHUB_ACTIONS === 'true';

function emit(level: 'info' | 'notice' | 'warning' | 'error', msg: string): void {
  if (!IS_ACTIONS) {
    const stream = level === 'error' ? process.stderr : process.stdout;
    stream.write(`[${level}] ${msg}\n`);
    return;
  }
  const levelTag =
    level === 'error' ? 'error' : level === 'warning' ? 'warning' : level === 'notice' ? 'notice' : 'debug';
  if (msg.includes('\n')) {
    const encoded = Buffer.from(msg, 'utf8').toString('base64');
    process.stdout.write(`::${levelTag}::${encoded}\n`);
  } else {
    process.stdout.write(`::${levelTag}::${msg}\n`);
  }
}

export const log = {
  info: (msg: string) => emit('info', msg),
  notice: (msg: string) => emit('notice', msg),
  warn: (msg: string) => emit('warning', msg),
  error: (msg: string) => emit('error', msg),
  /** Key/value pair dump for run summaries. */
  kv: (pairs: Record<string, string | number | boolean>) => {
    const line = Object.entries(pairs)
      .map(([k, v]) => `${k}=${v}`)
      .join(' ');
    emit('info', line);
  },
};

/** Format a TokenUsage for humans. */
export function formatUsage(input: number, output: number): string {
  return `${input} in / ${output} out tokens`;
}
