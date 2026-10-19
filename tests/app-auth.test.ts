import { describe, it, expect, beforeEach } from 'vitest';
import { createVerify, generateKeyPairSync } from 'node:crypto';

import {
  buildAppJwt,
  normalizePrivateKey,
  GitHubAppAuth,
  type FetchLike,
} from '../src/github/app-auth.js';

/**
 * These tests verify the JWT *cryptographically* against a real RSA keypair
 * rather than just asserting it has three segments. A signature that does not
 * verify would fail at runtime with an opaque 401, and the whole App flow
 * depends on this one function being right.
 */

const { privateKey, publicKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});

const APP_ID = '123456';

function decodeSegment(seg: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(seg, 'base64url').toString('utf8')) as Record<string, unknown>;
}

function verifySignature(jwt: string): boolean {
  const [header, payload, signature] = jwt.split('.');
  const verifier = createVerify('sha256');
  verifier.update(`${header}.${payload}`);
  verifier.end();
  return verifier.verify(publicKey, Buffer.from(signature!, 'base64url'));
}

describe('normalizePrivateKey', () => {
  it('passes through a raw PEM', () => {
    const out = normalizePrivateKey(privateKey);
    expect(out).toContain('-----BEGIN');
    expect(out.endsWith('\n')).toBe(true);
  });

  it('expands literal backslash-n sequences', () => {
    const escaped = privateKey.replace(/\n/g, '\\n');
    const out = normalizePrivateKey(escaped);
    expect(out).toContain('-----BEGIN');
    expect(out).not.toContain('\\n');
    expect(out.split('\n').length).toBeGreaterThan(3);
  });

  it('decodes a base64-encoded PEM', () => {
    const encoded = Buffer.from(privateKey, 'utf8').toString('base64');
    expect(normalizePrivateKey(encoded)).toContain('-----BEGIN');
  });

  it('tolerates surrounding whitespace', () => {
    expect(normalizePrivateKey(`\n\n  ${privateKey}  \n`)).toContain('-----BEGIN');
  });

  it('throws a helpful error for garbage', () => {
    expect(() => normalizePrivateKey('not a key at all')).toThrow(/not a PEM private key/);
  });
});

describe('buildAppJwt', () => {
  it('produces a three-segment RS256 JWT', () => {
    const jwt = buildAppJwt(APP_ID, privateKey, 1_700_000_000);
    const parts = jwt.split('.');
    expect(parts).toHaveLength(3);
    expect(decodeSegment(parts[0]!)).toEqual({ alg: 'RS256', typ: 'JWT' });
  });

  it('the signature verifies against the public key', () => {
    const jwt = buildAppJwt(APP_ID, privateKey, 1_700_000_000);
    expect(verifySignature(jwt)).toBe(true);
  });

  it('is rejected when the payload is tampered with', () => {
    const jwt = buildAppJwt(APP_ID, privateKey, 1_700_000_000);
    const [header, , signature] = jwt.split('.');
    const tamperedPayload = Buffer.from(
      JSON.stringify({ iat: 0, exp: 9_999_999_999, iss: '999999' }),
      'utf8',
    ).toString('base64url');
    expect(verifySignature(`${header}.${tamperedPayload}.${signature}`)).toBe(false);
  });

  it('carries the expected claims', () => {
    const now = 1_700_000_000;
    const payload = decodeSegment(buildAppJwt(APP_ID, privateKey, now).split('.')[1]!);
    expect(payload.iss).toBe(APP_ID);
    expect(payload.iat).toBe(now - 60);
    expect(payload.exp).toBe(now + 540);
  });

  it('expires within GitHub\'s 10-minute limit', () => {
    const payload = decodeSegment(buildAppJwt(APP_ID, privateKey, 1_700_000_000).split('.')[1]!);
    const lifetime = (payload.exp as number) - (payload.iat as number);
    expect(lifetime).toBeLessThanOrEqual(600);
  });

  it('backdates iat so a small clock skew does not fail the request', () => {
    const now = 1_700_000_000;
    const payload = decodeSegment(buildAppJwt(APP_ID, privateKey, now).split('.')[1]!);
    expect(payload.iat as number).toBeLessThan(now);
  });

  it('accepts a base64-encoded key too', () => {
    const encoded = Buffer.from(privateKey, 'utf8').toString('base64');
    const jwt = buildAppJwt(APP_ID, encoded, 1_700_000_000);
    expect(verifySignature(jwt)).toBe(true);
  });
});

/** A scripted fetch double. */
function stubFetch(
  routes: Array<{ path: string; method: string; status: number; body: unknown }>,
): { impl: FetchLike; calls: Array<{ path: string; method: string }> } {
  const calls: Array<{ path: string; method: string }> = [];
  const impl: FetchLike = async (url, init) => {
    const path = url.replace('https://api.github.com', '');
    calls.push({ path, method: init.method });
    const route = routes.find((r) => r.path === path && r.method === init.method);
    if (!route) throw new Error(`no stub for ${init.method} ${path}`);
    return {
      ok: route.status >= 200 && route.status < 300,
      status: route.status,
      text: async () => JSON.stringify(route.body),
    };
  };
  return { impl, calls };
}

describe('GitHubAppAuth', () => {
  it('rejects missing credentials', () => {
    expect(() => new GitHubAppAuth({ appId: '', privateKey })).toThrow(/appId/);
    expect(() => new GitHubAppAuth({ appId: APP_ID, privateKey: '' })).toThrow(/privateKey/);
  });

  it('discovers the installation id for a repository', async () => {
    const { impl, calls } = stubFetch([
      { path: '/repos/acme/widgets/installation', method: 'GET', status: 200, body: { id: 42 } },
    ]);
    const auth = new GitHubAppAuth({ appId: APP_ID, privateKey }, impl);
    expect(await auth.installationIdFor('acme', 'widgets')).toBe(42);
    expect(calls[0]).toEqual({ path: '/repos/acme/widgets/installation', method: 'GET' });
  });

  it('mints an installation token', async () => {
    const { impl } = stubFetch([
      {
        path: '/app/installations/42/access_tokens',
        method: 'POST',
        status: 201,
        body: { token: 'ghs_abc', expires_at: futureIso() },
      },
    ]);
    const auth = new GitHubAppAuth({ appId: APP_ID, privateKey }, impl);
    expect(await auth.installationToken(42)).toBe('ghs_abc');
  });

  it('caches the token across calls', async () => {
    const { impl, calls } = stubFetch([
      {
        path: '/app/installations/42/access_tokens',
        method: 'POST',
        status: 201,
        body: { token: 'ghs_abc', expires_at: futureIso() },
      },
    ]);
    const auth = new GitHubAppAuth({ appId: APP_ID, privateKey }, impl);
    await auth.installationToken(42);
    await auth.installationToken(42);
    await auth.installationToken(42);
    expect(calls).toHaveLength(1);
  });

  it('refreshes a token that is about to expire', async () => {
    let n = 0;
    const impl: FetchLike = async () => {
      n++;
      return {
        ok: true,
        status: 201,
        text: async () =>
          JSON.stringify({
            token: `ghs_${n}`,
            // Already inside the refresh margin.
            expires_at: new Date(Date.now() + 60_000).toISOString(),
          }),
      };
    };
    const auth = new GitHubAppAuth({ appId: APP_ID, privateKey }, impl);
    expect(await auth.installationToken(42)).toBe('ghs_1');
    expect(await auth.installationToken(42)).toBe('ghs_2');
  });

  it('surfaces the API error body when the installation is missing', async () => {
    const { impl } = stubFetch([
      {
        path: '/repos/acme/widgets/installation',
        method: 'GET',
        status: 404,
        body: { message: 'Not Found' },
      },
    ]);
    const auth = new GitHubAppAuth({ appId: APP_ID, privateKey }, impl);
    await expect(auth.installationIdFor('acme', 'widgets')).rejects.toThrow(/404/);
  });

  it('reads the app slug', async () => {
    const { impl } = stubFetch([
      { path: '/app', method: 'GET', status: 200, body: { slug: 'prsentinel' } },
    ]);
    expect(await new GitHubAppAuth({ appId: APP_ID, privateKey }, impl).appSlug()).toBe(
      'prsentinel',
    );
  });

  it('authorizeRepository returns the token and a bot login', async () => {
    const { impl } = stubFetch([
      { path: '/app/installations/42/access_tokens', method: 'POST', status: 201, body: { token: 'ghs_xyz', expires_at: futureIso() } },
      { path: '/app', method: 'GET', status: 200, body: { slug: 'prsentinel' } },
    ]);
    const auth = new GitHubAppAuth({ appId: APP_ID, privateKey }, impl);
    const r = await auth.authorizeRepository('acme', 'widgets', 42);
    expect(r.token).toBe('ghs_xyz');
    expect(r.botLogin).toBe('prsentinel[bot]');
    expect(r.installationId).toBe(42);
  });

  it('falls back to a generic bot login when the slug lookup fails', async () => {
    const { impl } = stubFetch([
      { path: '/app/installations/42/access_tokens', method: 'POST', status: 201, body: { token: 'ghs_xyz', expires_at: futureIso() } },
      { path: '/app', method: 'GET', status: 403, body: { message: 'forbidden' } },
    ]);
    const auth = new GitHubAppAuth({ appId: APP_ID, privateKey }, impl);
    const r = await auth.authorizeRepository('acme', 'widgets', 42);
    expect(r.botLogin).toBe('github-actions[bot]');
  });
});

function futureIso(): string {
  return new Date(Date.now() + 60 * 60 * 1000).toISOString();
}
