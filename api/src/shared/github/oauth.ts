import { env } from '../config/env.js';

const AUTHORIZE_URL = 'https://github.com/login/oauth/authorize';
const TOKEN_URL = 'https://github.com/login/oauth/access_token';
const API_BASE = 'https://api.github.com';

export class GithubError extends Error {}

function callbackUrl(): string {
  return `${env.API_PUBLIC_BASE_URL}/auth/github/callback`;
}

/** Build the GitHub authorize URL the browser is redirected to. */
export function buildAuthorizeUrl(state: string): string {
  const params = new URLSearchParams({
    client_id: env.GITHUB_OAUTH_CLIENT_ID,
    redirect_uri: callbackUrl(),
    scope: env.GITHUB_OAUTH_SCOPES,
    state,
    allow_signup: 'false',
  });
  return `${AUTHORIZE_URL}?${params.toString()}`;
}

export interface ExchangedToken {
  accessToken: string;
  scopes: string[];
}

/** Exchange an OAuth code for an access token. */
export async function exchangeCodeForToken(code: string): Promise<ExchangedToken> {
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({
      client_id: env.GITHUB_OAUTH_CLIENT_ID,
      client_secret: env.GITHUB_OAUTH_CLIENT_SECRET,
      code,
      redirect_uri: callbackUrl(),
    }),
  });
  if (!res.ok) throw new GithubError(`Token exchange failed (${res.status})`);
  const data = (await res.json()) as { access_token?: string; scope?: string; error?: string };
  if (!data.access_token) throw new GithubError(data.error ?? 'No access token returned');
  return {
    accessToken: data.access_token,
    scopes: data.scope ? data.scope.split(',').filter(Boolean) : [],
  };
}

export interface GithubUser {
  id: number;
  login: string;
}

/** Fetch the authenticated GitHub user. */
export async function fetchGitHubUser(accessToken: string): Promise<GithubUser> {
  const res = await fetch(`${API_BASE}/user`, {
    headers: { authorization: `Bearer ${accessToken}`, accept: 'application/vnd.github+json' },
  });
  if (!res.ok) throw new GithubError(`Fetching GitHub user failed (${res.status})`);
  const data = (await res.json()) as { id?: number; login?: string };
  if (typeof data.id !== 'number' || typeof data.login !== 'string') {
    throw new GithubError('Malformed GitHub user response');
  }
  return { id: data.id, login: data.login };
}

export interface AdminRepo {
  fullName: string;
  githubRepoId: number;
  private: boolean;
}

/** List repositories where the user has admin access (candidates for bounties). */
export async function listAdminRepos(accessToken: string): Promise<AdminRepo[]> {
  const url = `${API_BASE}/user/repos?per_page=100&affiliation=owner,organization_member`;
  const res = await fetch(url, {
    headers: { authorization: `Bearer ${accessToken}`, accept: 'application/vnd.github+json' },
  });
  if (!res.ok) throw new GithubError(`Listing repositories failed (${res.status})`);
  const data = (await res.json()) as Array<{
    full_name?: string;
    id?: number;
    private?: boolean;
    permissions?: { admin?: boolean };
  }>;
  return data
    .filter(
      (r) =>
        r.permissions?.admin === true &&
        typeof r.full_name === 'string' &&
        typeof r.id === 'number',
    )
    .map((r) => ({
      fullName: r.full_name as string,
      githubRepoId: r.id as number,
      private: Boolean(r.private),
    }));
}
