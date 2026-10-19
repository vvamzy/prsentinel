import type { KnownCommand } from '../state.js';
import { reviewCommand } from './review.js';
import { explainCommand } from './explain.js';
import { generateTestsCommand } from './generate-tests.js';
import type { CommandHandler } from './shared.js';

/**
 * Slash-command registry.
 *
 * Adding a command is a two-line change: write a handler and register it here.
 * `resolve` is parsed by state.ts but not implemented — it needs thread ids
 * from GraphQL, which is Phase 3 work.
 */
export const COMMANDS: Partial<Record<KnownCommand, CommandHandler>> = {
  review: reviewCommand,
  explain: explainCommand,
  'generate-tests': generateTestsCommand,
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
    '',
    'You can also mention the bot, e.g. `@prsentinel explain the retry logic`.',
  ].join('\n');
}

export type { CommandHandler } from './shared.js';
