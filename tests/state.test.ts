import { describe, it, expect } from 'vitest';
import {
  encodeMarker,
  extractLastReviewedSha,
  findLastReviewedSha,
  parseSlashCommand,
  mentionNames,
} from '../src/state.js';

describe('markers', () => {
  it('round-trips a SHA', () => {
    const sha = 'abc123def456';
    const body = `Review body\n\n${encodeMarker(sha)}\n`;
    expect(extractLastReviewedSha(body)).toBe(sha);
  });

  it('returns null when no marker is present', () => {
    expect(extractLastReviewedSha('just a comment')).toBeNull();
  });
});

describe('findLastReviewedSha', () => {
  it('finds the newest marker from our own reviews', () => {
    const reviews = [
      { body: `old ${encodeMarker('aaaa111')}`, user: 'prsentinel' },
      { body: `new ${encodeMarker('bbbb222')}`, user: 'github-actions[bot]' },
    ];
    expect(findLastReviewedSha(reviews)).toBe('bbbb222');
  });

  it('ignores reviews from other authors', () => {
    const reviews = [{ body: encodeMarker('deadbeef'), user: 'someone-else' }];
    expect(findLastReviewedSha(reviews)).toBeNull();
  });

  it('ignores our reviews that lack a marker', () => {
    const reviews = [{ body: 'no marker here', user: 'prsentinel' }];
    expect(findLastReviewedSha(reviews)).toBeNull();
  });
});

describe('parseSlashCommand', () => {
  it('detects /review', () => {
    const r = parseSlashCommand('/review', 'prsentinel');
    expect(r?.command).toBe('review');
  });

  it('detects @bot explain', () => {
    const r = parseSlashCommand('@prsentinel explain this function', 'prsentinel');
    expect(r?.command).toBe('explain');
  });

  it('detects /generate-tests', () => {
    const r = parseSlashCommand('/generate-tests', 'prsentinel');
    expect(r?.command).toBe('generate-tests');
  });

  it('captures args', () => {
    const r = parseSlashCommand('@prsentinel explain the auth flow', 'prsentinel');
    expect(r?.args).toBe('the auth flow');
  });

  it('returns null for ordinary comments', () => {
    expect(parseSlashCommand('lgtm', 'prsentinel')).toBeNull();
  });

  it('accepts several candidate names at once', () => {
    const r = parseSlashCommand('@my-reviewer explain this', ['prsentinel', 'my-reviewer']);
    expect(r?.command).toBe('explain');
    expect(r?.args).toBe('this');
  });

  it('still finds the slash form when a name list is given', () => {
    expect(parseSlashCommand('/review all', ['prsentinel', 'my-reviewer'])?.command).toBe('review');
  });

  it('returns null when the name list is empty', () => {
    expect(parseSlashCommand('@prsentinel review', [])).toBeNull();
    expect(parseSlashCommand('@prsentinel review', '')).toBeNull();
  });

  it('does not match a name that is only a prefix of the mention', () => {
    // `@prsentinelx` must not be read as a mention of `prsentinel`.
    expect(parseSlashCommand('@prsentinelx review', 'prsentinel')?.command).not.toBe('review');
  });
});

describe('mentionNames', () => {
  it('strips the [bot] suffix from an App login', () => {
    expect(mentionNames(['prsentinel[bot]'])).toEqual(['prsentinel']);
  });

  it('leaves a plain login alone', () => {
    expect(mentionNames(['prsentinel'])).toEqual(['prsentinel']);
  });

  it('de-duplicates the login and its mention form', () => {
    expect(mentionNames(['prsentinel[bot]', 'prsentinel', 'github-actions[bot]'])).toEqual([
      'prsentinel',
      'github-actions',
    ]);
  });

  it('drops empty entries', () => {
    expect(mentionNames(['', '  ', 'prsentinel'])).toEqual(['prsentinel']);
  });

  it('handles the case where an App login is the only identity', () => {
    // The regression this guards: with App auth, `botLogins[0]` is
    // `my-app[bot]`, and matching that raw against a comment body never works.
    const names = mentionNames(['my-app[bot]', 'github-actions[bot]']);
    expect(parseSlashCommand('@my-app explain the retry logic', names)?.command).toBe('explain');
  });
});
