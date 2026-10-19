import { describe, it, expect, vi } from 'vitest';

import {
  resolveAuth,
  hasAppCredentials,
  hasAnyCredentials,
  mergeBotLogins,
  type AppAuthorizer,
  type AuthInputs,
} from '../src/github/auth.js';
import { mentionNames } from '../src/state.js';

function inputs(overrides: Partial<AuthInputs> = {}): AuthInputs {
  return {
    token: '',
    appId: '',
    appPrivateKey: '',
    configuredBotLogins: ['prsentinel', 'github-actions[bot]'],
    owner: 'acme',
    repo: 'widgets',
    ...overrides,
  };
}

/** Records what it was asked for and returns a canned token. */
function fakeAppAuth(
  result: { token: string; botLogin: string; installationId: number } = {
    token: 'ghs_installation',
    botLogin: 'prsentinel[bot]',
    installationId: 42,
  },
): { auth: AppAuthorizer; calls: Array<{ owner: string; repo: string; installationId?: number }> } {
  const calls: Array<{ owner: string; repo: string; installationId?: number }> = [];
  const auth: AppAuthorizer = {
    authorizeRepository: async (owner, repo, installationId) => {
      calls.push({ owner, repo, ...(installationId !== undefined ? { installationId } : {}) });
      return result;
    },
  };
  return { auth, calls };
}

describe('hasAppCredentials', () => {
  it('requires both an id and a key', () => {
    expect(hasAppCredentials({ appId: '1', appPrivateKey: 'pem' })).toBe(true);
    expect(hasAppCredentials({ appId: '1', appPrivateKey: '' })).toBe(false);
    expect(hasAppCredentials({ appId: '', appPrivateKey: 'pem' })).toBe(false);
    expect(hasAppCredentials({ appId: '', appPrivateKey: '' })).toBe(false);
  });
});

describe('hasAnyCredentials', () => {
  it('accepts a token alone', () => {
    expect(hasAnyCredentials({ token: 'ghp_x', appId: '', appPrivateKey: '' })).toBe(true);
  });

  it('accepts an App alone', () => {
    expect(hasAnyCredentials({ token: '', appId: '1', appPrivateKey: 'pem' })).toBe(true);
  });

  it('rejects nothing at all', () => {
    expect(hasAnyCredentials({ token: '', appId: '', appPrivateKey: '' })).toBe(false);
    expect(hasAnyCredentials({ token: '', appId: '1', appPrivateKey: '' })).toBe(false);
  });
});

describe('mergeBotLogins', () => {
  it('puts the App login first', () => {
    expect(mergeBotLogins('prsentinel[bot]', ['prsentinel'])).toEqual([
      'prsentinel[bot]',
      'prsentinel',
    ]);
  });

  it('drops duplicates case-insensitively', () => {
    expect(mergeBotLogins('prsentinel[bot]', ['PRSENTINEL[BOT]', 'github-actions[bot]'])).toEqual([
      'prsentinel[bot]',
      'github-actions[bot]',
    ]);
  });

  it('ignores empty and whitespace entries', () => {
    expect(mergeBotLogins('', ['prsentinel', '   '])).toEqual(['prsentinel']);
  });
});

describe('resolveAuth', () => {
  it('uses the App when both id and key are present', async () => {
    const { auth, calls } = fakeAppAuth();
    const res = await resolveAuth(
      inputs({ token: 'ghp_also_set', appId: '123', appPrivateKey: '-----BEGIN...' }),
      auth,
    );
    expect(res.mode).toBe('app');
    expect(calls).toEqual([{ owner: 'acme', repo: 'widgets' }]);
  });

  it('merges the App bot login ahead of the configured ones', async () => {
    const { auth } = fakeAppAuth({ token: 't', botLogin: 'prsentinel[bot]', installationId: 7 });
    const res = await resolveAuth(inputs({ appId: '1', appPrivateKey: 'k' }), auth);
    expect(res.botLogins[0]).toBe('prsentinel[bot]');
    expect(res.botLogins).toContain('github-actions[bot]');
  });

  it('includes the mention form so @mentions keep working under a custom slug', async () => {
    // Regression: an App is logged as `my-app[bot]` but mentioned as `@my-app`.
    // Without the mention form, `@my-app explain ...` silently stops matching.
    const { auth } = fakeAppAuth({ token: 't', botLogin: 'my-app[bot]', installationId: 7 });
    const res = await resolveAuth(inputs({ appId: '1', appPrivateKey: 'k' }), auth);
    expect(res.botLogins).toContain('my-app');
    expect(mentionNames(res.botLogins)).toContain('my-app');
  });

  it('passes a pre-known installation id straight through', async () => {
    const { auth, calls } = fakeAppAuth();
    await resolveAuth(inputs({ appId: '1', appPrivateKey: 'k', installationId: 99 }), auth);
    expect(calls[0]?.installationId).toBe(99);
  });

  it('omits installationId so it can be discovered when not configured', async () => {
    const { auth, calls } = fakeAppAuth();
    await resolveAuth(inputs({ appId: '1', appPrivateKey: 'k' }), auth);
    expect(calls[0]).not.toHaveProperty('installationId');
  });

  it('falls back to the token when no App credentials are set', async () => {
    const { auth, calls } = fakeAppAuth();
    const res = await resolveAuth(inputs({ token: 'ghp_token' }), auth);
    expect(res.mode).toBe('token');
    expect(res.botLogins).toEqual(['prsentinel', 'github-actions[bot]']);
    expect(calls).toHaveLength(0);
  });

  it('constructs a real App client when no authorizer is injected', async () => {
    // Guards against the `appAuth ?? new GitHubAppAuth(...)` branch being
    // accidentally dropped: a bogus key must fail loudly rather than silently
    // falling back to the token.
    await expect(
      resolveAuth(inputs({ token: 'ghp_fallback', appId: '1', appPrivateKey: 'not-a-key' })),
    ).rejects.toThrow(/not a PEM private key/);
  });

  it('does not call the network in token mode', async () => {
    const spy = vi.fn();
    // Ensure global fetch is untouched by the token path.
    vi.stubGlobal('fetch', spy);
    try {
      await resolveAuth(inputs({ token: 'ghp_token' }));
      expect(spy).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
