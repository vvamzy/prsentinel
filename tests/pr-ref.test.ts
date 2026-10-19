import { describe, it, expect } from 'vitest';
import { parsePrRef } from '../src/github/pr-ref.js';

describe('parsePrRef', () => {
  it('parses owner/repo#number', () => {
    expect(parsePrRef('acme/widgets#42')).toEqual({ owner: 'acme', repo: 'widgets', number: 42 });
  });

  it('parses a github.com pull URL', () => {
    expect(parsePrRef('https://github.com/acme/widgets/pull/42')).toEqual({
      owner: 'acme',
      repo: 'widgets',
      number: 42,
    });
  });

  it('accepts a URL with a trailing path', () => {
    expect(parsePrRef('https://github.com/acme/widgets/pull/42/files')?.number).toBe(42);
  });

  it('accepts a trailing query string', () => {
    expect(parsePrRef('https://github.com/acme/widgets/pull/42?diff=split')?.number).toBe(42);
  });

  it('strips a .git suffix', () => {
    expect(parsePrRef('https://github.com/acme/widgets.git/pull/7')?.repo).toBe('widgets');
  });

  it('tolerates surrounding whitespace', () => {
    expect(parsePrRef('  acme/widgets#42  ')?.number).toBe(42);
  });

  it('handles dotted and hyphenated names', () => {
    expect(parsePrRef('my-org/my.repo#1')).toEqual({
      owner: 'my-org',
      repo: 'my.repo',
      number: 1,
    });
  });

  it('rejects a missing number', () => {
    expect(parsePrRef('acme/widgets#')).toBeNull();
    expect(parsePrRef('acme/widgets')).toBeNull();
  });

  it('rejects a non-numeric number', () => {
    expect(parsePrRef('acme/widgets#abc')).toBeNull();
  });

  it('rejects zero and negatives', () => {
    expect(parsePrRef('acme/widgets#0')).toBeNull();
    expect(parsePrRef('acme/widgets#-3')).toBeNull();
  });

  it('rejects a bare path with no owner', () => {
    expect(parsePrRef('widgets#42')).toBeNull();
  });

  it('rejects empty input', () => {
    expect(parsePrRef('')).toBeNull();
  });

  it('does not treat an arbitrary URL as a pull request', () => {
    expect(parsePrRef('https://github.com/acme/widgets/issues/42')).toBeNull();
  });
});
