import { GitHubAppAuth } from './app-auth.js';
import { GitHubClient } from './client.js';
import { log } from '../log.js';

/**
 * Credential resolution.
 *
 * prsentinel supports two ways to authenticate against GitHub:
 *
 *   1. A GitHub App (`app-id` + `app-private-key`). Preferred: the review is
 *      posted by `<slug>[bot]`, the token has its own rate limit, and it does
 *      not depend on the repository permitting `GITHUB_TOKEN` to write.
 *   2. A PAT or the workflow's `GITHUB_TOKEN` (`github-token`). Simplest to
 *      start with, and still fully supported.
 *
 * The App wins when both are present. This lives in its own module (rather
 * than inline in `index.ts`) because `index.ts` runs `main()` on import, which
 * makes it untestable.
 */

export interface AuthInputs {
  /** PAT or `GITHUB_TOKEN`; used when no App credentials are supplied. */
  token: string;
  appId: string;
  appPrivateKey: string;
  /** Optional pre-known installation id; discovered from the repo when absent. */
  installationId?: number;
  /** Bot logins from the `bot-login` input. */
  configuredBotLogins: string[];
  owner: string;
  repo: string;
}

export interface AuthResult {
  client: GitHubClient;
  /** Logins that should be treated as "us", App login first. */
  botLogins: string[];
  mode: 'app' | 'token';
}

/**
 * The subset of `GitHubAppAuth` that resolution needs. Narrowing it here lets
 * tests inject a double without an RSA key or a network.
 */
export interface AppAuthorizer {
  authorizeRepository(
    owner: string,
    repo: string,
    installationId?: number,
  ): Promise<{ token: string; botLogin: string; installationId: number }>;
}

export function hasAppCredentials(inputs: Pick<AuthInputs, 'appId' | 'appPrivateKey'>): boolean {
  return Boolean(inputs.appId && inputs.appPrivateKey);
}

export function hasAnyCredentials(inputs: Pick<AuthInputs, 'token' | 'appId' | 'appPrivateKey'>): boolean {
  return inputs.token !== '' || hasAppCredentials(inputs);
}

/**
 * Put the App login first, then the configured logins, without duplicates.
 * Order matters: `botLogins[0]` is used as the bot's own name in prompts and
 * in `@mention` parsing.
 */
export function mergeBotLogins(login: string, existing: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const candidate of [login, ...existing]) {
    const name = candidate.trim();
    if (name === '') continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(name);
  }
  return out;
}

export async function resolveAuth(
  inputs: AuthInputs,
  appAuth?: AppAuthorizer,
): Promise<AuthResult> {
  if (hasAppCredentials(inputs)) {
    const auth =
      appAuth ?? new GitHubAppAuth({ appId: inputs.appId, privateKey: inputs.appPrivateKey });

    const { token, botLogin, installationId } = await auth.authorizeRepository(
      inputs.owner,
      inputs.repo,
      inputs.installationId,
    );
    log.info(
      `Authenticated as GitHub App${botLogin ? ` (${botLogin})` : ''}, installation ${installationId}.`,
    );

    // A GitHub App is logged as `my-app[bot]` but mentioned as `@my-app`, so we
    // carry both identities. `botLogins[0]` stays the real login because that is
    // what appears as the author of existing reviews.
    const mention = botLogin.endsWith('[bot]') ? botLogin.slice(0, -'[bot]'.length) : '';

    return {
      client: new GitHubClient(token, inputs.owner, inputs.repo),
      botLogins: mergeBotLogins(botLogin, [mention, ...inputs.configuredBotLogins]),
      mode: 'app',
    };
  }

  return {
    client: new GitHubClient(inputs.token, inputs.owner, inputs.repo),
    botLogins: inputs.configuredBotLogins,
    mode: 'token',
  };
}
