import type { KnownCommand } from '../state.js';
import { reviewCommand } from './review.js';
import { explainCommand } from './explain.js';
import { generateTestsCommand } from './generate-tests.js';
import { resolveCommand } from './resolve.js';
import type { CommandHandler } from './shared.js';

/**
 * Slash-command registry.
 *
 * Adding a command is a two-line change: write a handler and register it here.
 * `state.ts` owns which commands the parser recognises; this owns which of them
 * actually do something. A recognised-but-unregistered command falls back to
 * the help text rather than failing.
 */
export const COMMANDS: Partial<Record<KnownCommand, CommandHandler>> = {
  review: reviewCommand,
  explain: explainCommand,
  'generate-tests': generateTestsCommand,
  resolve: resolveCommand,
};

export function getCommandHandler(command: KnownCommand): CommandHandler | null {
  return COMMANDS[command] ?? null;
}

/** Human-readable help, posted when someone triggers an unsupported command. */
export function commandHelp(): string {
  return [
    '### prsentinel commands',
    '',
    '| Command | What it does |',
    '|---|---|',
    '| `/review` | Review the changes since the last review. |',
    '| `/review all` | Review the whole pull request. |',
    '| `/review <path>` | Re-review one file or directory. |',
    '| `/explain` | Explain what the change does. |',
    '| `/explain <path> <question>` | Answer a question about a file. |',
    '| `/generate-tests [path]` | Propose tests for the changed code. |',
    '| `/resolve` | Resolve the review threads prsentinel opened. |',
    '',
    'You can also mention the bot, e.g. `@prsentinel explain the retry logic`.',
  ].join('\n');
}

export type { CommandHandler } from './shared.js';
