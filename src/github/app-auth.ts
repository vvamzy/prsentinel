import { createSign } from 'node:crypto';

/**
 * GitHub App authentication.
 *
 * A GitHub App authenticates in two steps:
 *
 *   1. Sign a short-lived JWT with the App's private key (RS256).
 *   2. Exchange that JWT for an *installation* access token, which is what
 *      actually acts on a repository.
 *
 * We implement step 1 with `node:crypto` rather than adding a dependency.
 * RS256 is a plain RSASSA-PKCS1-v1_5 signature over the base64url-encoded
 * header and payload — about thirty lines — and keeping the dependency set
 * tiny is a deliberate project goal (see CONTRIBUTING.md).
 *
 * Why an App at all:
 *   - it posts as `your-app[bot]` instead of `github-actions[bot]`, so the PR
 *     timeline is not a wall of indistinguishable bot noise;
 *   - it has its own rate limit, separate from `GITHUB_TOKEN`;
 *   - it does not depend on the repository allowing `GITHUB_TOKEN` to write,
 *     which many orgs disable;
 *   - a review posted by an App *does* trigger other workflows, whereas one
 *     posted by `GITHUB_TOKEN` silently does not.
 */

const API_BASE = 'https://api.github.com';
const API_VERSION = '2022-11-28';

/** Refresh an installation token when it has less than this long to live. */
const REFRESH_MARGIN_MS = 5 * 60 * 1000;

/** App JWTs must expire within 10 minutes; stay comfortably inside that. */
const JWT_LIFETIME_SECONDS = 540;
const JWT_CLOCK_SKEW_SECONDS = 60;

export type FetchLike = (
  input: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body?: string;
  },
) => Promise<{ ok: boolean; status: number; text: () => Promise<string> }>;

export interface AppCredentials {
  /** The App's numeric id, as a string. */
  appId: string;
  /** PEM private key. May be raw, `\n`-escaped, or base64-encoded. */
  privateKey: string;
}

export interface InstallationToken {
  token: string;
  expiresAt: string;
}

function b64url(input: string): string {
  return Buffer.from(input, 'utf8').toString('base64url');
}

/**
 * Accept the private key in whichever shape a user managed to paste it.
 *
 * All three of these are common in the wild, and a PEM that arrives with
 * literal backslash-n sequences is the single most frequent setup mistake:
 *
 *   -----BEGIN RSA PRIVATE KEY-----\nMIIE...
 *   -----BEGIN RSA PRIVATE KEY-----\nMIIE...   (as consecutive newlines)
 *   LS0tLS1CRUdJTiBSU0EgUFJJVkFURSBLRVktLS0tLQ...   (base64 of the above)
 */
export function normalizePrivateKey(input: string): string {
  let key = input.trim();

  if (key.includes('\\n')) key = key.replace(/\\n/g, '\n');
  if (key.includes('-----BEGIN')) return ensureTrailingNewline(key);

  // Possibly base64-encoded PEM (a common way to smuggle it through a secret).
  const decoded = Buffer.from(key, 'base64').toString('utf8');
  if (decoded.includes('-----BEGIN')) return ensureTrailingNewline(decoded.trim());

  throw new Error(
    'app-private-key is not a PEM private key. Provide the contents of the .pem file, ' +
      'or its base64 encoding. Literal "\\n" sequences are handled.',
  );
}

function ensureTrailingNewline(key: string): string {
  return key.endsWith('\n') ? key : `${key}\n`;
}

/**
 * Build a signed App JWT.
 *
 * `nowSeconds` is injectable so tests can pin time instead of sleeping.
 */
export function buildAppJwt(
  appId: string,
  privateKey: string,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): string {
  const pem = normalizePrivateKey(privateKey);

  const header = { alg: 'RS256', typ: 'JWT' };
  const payload = {
    // Backdate slightly so a small clock difference does not invalidate us.
    iat: nowSeconds - JWT_CLOCK_SKEW_SECONDS,
    exp: nowSeconds + JWT_LIFETIME_SECONDS,
    iss: appId,
  };

  const signingInput = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`;

  // "sha256" with an RSA key means RSASSA-PKCS1-v1_5, i.e. RS256.
  const signer = createSign('sha256');
  signer.update(signingInput);
  signer.end();
  const signature = signer.sign(pem);

  return `${signingInput}.${signature.toString('base64url')}`;
}

/**
 * Mints and caches installation tokens.
 *
 * Tokens are valid for an hour; we refresh a few minutes early. Caching
 * matters because a single review run makes several GitHub calls and we do not
 * want to burn a token exchange on each one.
 */
export class GitHubAppAuth {
  private readonly appId: string;
  private readonly privateKey: string;
  private readonly fetchImpl: FetchLike;
  private readonly cache = new Map<number, InstallationToken>();

  constructor(creds: AppCredentials, fetchImpl?: FetchLike) {
    if (!creds.appId) throw new Error('GitHubAppAuth requires an appId');
    if (!creds.privateKey) throw new Error('GitHubAppAuth requires a privateKey');
    this.appId = creds.appId;
    this.privateKey = creds.privateKey;
    this.fetchImpl = fetchImpl ?? (globalThis.fetch as unknown as FetchLike);
  }

  /** A fresh App JWT for the current moment. */
  jwt(nowSeconds?: number): string {
    return buildAppJwt(this.appId, this.privateKey, nowSeconds);
  }

  private async request(
    path: string,
    method: 'GET' | 'POST',
    bearer: string,
  ): Promise<unknown> {
    const res = await this.fetchImpl(`${API_BASE}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${bearer}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': API_VERSION,
        'User-Agent': 'prsentinel',
      },
    });

    const text = await res.text();
    if (!res.ok) {
      throw new Error(`GitHub API ${method} ${path} failed: ${res.status} ${truncate(text)}`);
    }
    try {
      return JSON.parse(text);
    } catch {
      throw new Error(`GitHub API ${method} ${path} returned non-JSON: ${truncate(text)}`);
    }
  }

  /**
   * Find the installation id for a repository.
   *
   * `GET /repos/{owner}/{repo}/installation` answers with the App JWT, so the
   * user never has to look the id up by hand.
   */
  async installationIdFor(owner: string, repo: string): Promise<number> {
    const data = (await this.request(
      `/repos/${owner}/${repo}/installation`,
      'GET',
      this.jwt(),
    )) as { id?: number };
    if (typeof data.id !== 'number') {
      throw new Error(
        `The App is not installed on ${owner}/${repo}, or the app-id does not match the installation.`,
      );
    }
    return data.id;
  }

  /** The App's slug, used to derive its bot login (`<slug>[bot]`). */
  async appSlug(): Promise<string> {
    const data = (await this.request('/app', 'GET', this.jwt())) as { slug?: string };
    return data.slug ?? '';
  }

  /** Mint (or reuse) an installation token. */
  async installationToken(installationId: number): Promise<string> {
    const cached = this.cache.get(installationId);
    if (cached && !isExpiringSoon(cached.expiresAt)) {
      return cached.token;
    }

    const data = (await this.request(
      `/app/installations/${installationId}/access_tokens`,
      'POST',
      this.jwt(),
    )) as { token?: string; expires_at?: string };

    if (!data.token || !data.expires_at) {
      throw new Error('Installation token response was missing token or expires_at');
    }

    this.cache.set(installationId, { token: data.token, expiresAt: data.expires_at });
    return data.token;
  }

  /**
   * End-to-end convenience: work out the installation for a repo and mint a
   * token for it. Returns the token plus the App's bot login.
   */
  async authorizeRepository(
    owner: string,
    repo: string,
    knownInstallationId?: number,
  ): Promise<{ token: string; botLogin: string; installationId: number }> {
    const installationId = knownInstallationId ?? (await this.installationIdFor(owner, repo));
    const [token, slug] = await Promise.all([
      this.installationToken(installationId),
      // A missing slug is not fatal — we fall back to a generic bot login.
      this.appSlug().catch(() => ''),
    ]);
    return {
      token,
      botLogin: slug ? `${slug}[bot]` : 'github-actions[bot]',
      installationId,
    };
  }
}

function isExpiringSoon(expiresAt: string): boolean {
  const t = Date.parse(expiresAt);
  if (Number.isNaN(t)) return true;
  return t - Date.now() < REFRESH_MARGIN_MS;
}

function truncate(s: string, n = 300): string {
  return s.length <= n ? s : `${s.slice(0, n)}…`;
}
