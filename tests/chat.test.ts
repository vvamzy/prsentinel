import { describe, it, expect } from 'vitest';
import { findRootId, isOurThread, renderThread } from '../src/chat.js';

/**
 * Thread-reply decision logic.
 *
 * The rule we must never break: prsentinel replies inside a thread only when
 * the thread was started by prsentinel. Otherwise it would insert itself into
 * human conversations.
 */

const BOTS = ['prsentinel', 'github-actions[bot]'];

describe('findRootId', () => {
  const comments = [
    { id: 1, inReplyTo: null },
    { id: 2, inReplyTo: 1 },
    { id: 3, inReplyTo: 2 },
    { id: 4, inReplyTo: null },
  ];

  it('walks a chain back to its root', () => {
    expect(findRootId(3, 2, comments)).toBe(1);
  });

  it('returns the comment itself when it is already a root', () => {
    expect(findRootId(4, null, comments)).toBe(4);
  });

  it('stops safely on a dangling parent reference', () => {
    expect(findRootId(9, 999, comments)).toBe(999);
  });

  it('survives a cycle without hanging', () => {
    const cyclic = [
      { id: 1, inReplyTo: 2 },
      { id: 2, inReplyTo: 1 },
    ];
    expect(findRootId(1, 2, cyclic)).toBe(1);
  });
});

describe('isOurThread', () => {
  const comments = [
    { id: 10, author: 'prsentinel', inReplyTo: null },
    { id: 11, author: 'alice', inReplyTo: 10 },
  ];

  it('replies when the root comment is ours', () => {
    const trigger = { id: 11, body: 'are you sure?', path: 'a.ts', line: 3, inReplyToId: 10, author: 'alice' };
    expect(isOurThread(trigger, comments, BOTS)).toBe(true);
  });

  it('stays out of a human-only thread', () => {
    const human = [
      { id: 20, author: 'alice', inReplyTo: null },
      { id: 21, author: 'bob', inReplyTo: 20 },
    ];
    const trigger = { id: 21, body: 'agreed', path: 'a.ts', line: 3, inReplyToId: 20, author: 'bob' };
    expect(isOurThread(trigger, human, BOTS)).toBe(false);
  });

  it('never replies to its own comment', () => {
    const trigger = { id: 10, body: 'my own note', path: 'a.ts', line: 3, inReplyToId: null, author: 'prsentinel' };
    expect(isOurThread(trigger, comments, BOTS)).toBe(false);
  });

  it('replies when the root was posted by the GitHub Actions bot', () => {
    const viaActions = [{ id: 30, author: 'github-actions[bot]', inReplyTo: null }];
    const trigger = { id: 31, body: 'why?', path: 'a.ts', line: 1, inReplyToId: 30, author: 'alice' };
    expect(isOurThread(trigger, viaActions, BOTS)).toBe(true);
  });

  it('does not reply when the root cannot be found', () => {
    const trigger = { id: 99, body: 'hi', path: 'a.ts', line: 1, inReplyToId: 500, author: 'alice' };
    expect(isOurThread(trigger, comments, BOTS)).toBe(false);
  });
});

describe('renderThread', () => {
  it('renders in conversational order', () => {
    const comments = [
      { id: 1, author: 'prsentinel', body: 'This can be null.', inReplyTo: null },
      { id: 2, author: 'alice', body: 'It cannot.', inReplyTo: 1 },
      { id: 3, author: 'prsentinel', body: 'It can.', inReplyTo: 2 },
    ];
    const out = renderThread(1, comments);
    const lines = out.split('\n\n');
    expect(lines[0]).toContain('prsentinel');
    expect(lines[1]).toContain('alice');
    expect(lines[2]).toContain('It can.');
  });

  it('falls back to the single comment when children are unknown', () => {
    const comments = [{ id: 7, author: 'alice', body: 'hello', inReplyTo: null }];
    expect(renderThread(7, comments)).toContain('alice');
  });
});
