import { describe, it, expect } from 'vitest';
import {
  encodeMarker,
  extractLastReviewedSha,
  findLastReviewedSha,
  parseSlashCommand,
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
});
