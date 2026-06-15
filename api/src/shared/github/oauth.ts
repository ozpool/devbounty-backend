import { env } from '../config/env.js';

const AUTHORIZE_URL = 'https://github.com/login/oauth/authorize';
const TOKEN_URL = 'https://github.com/login/oauth/access_token';
const API_BASE = 'https://api.github.com';

// Abort any GitHub call that stalls, so a slow upstream can't pin a request
// handler open indefinitely.
const GITHUB_TIMEOUT_MS = 10_000;
function ghSignal(): AbortSignal {
  return AbortSignal.timeout(GITHUB_TIMEOUT_MS);
}

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
    signal: ghSignal(),
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
    signal: ghSignal(),
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

/**
 * List repositories where the user has admin access (candidates for bounties).
 * Pages through the GitHub result set (100/page) so a user with more than 100
 * repos doesn't silently lose the rest. Capped at MAX_REPO_PAGES as a backstop.
 */
const REPOS_PER_PAGE = 100;
const MAX_REPO_PAGES = 10; // up to 1000 repos

export async function listAdminRepos(accessToken: string): Promise<AdminRepo[]> {
  const out: AdminRepo[] = [];
  for (let page = 1; page <= MAX_REPO_PAGES; page++) {
    const url =
      `${API_BASE}/user/repos?per_page=${REPOS_PER_PAGE}&page=${page}` +
      `&affiliation=owner,organization_member`;
    const res = await fetch(url, {
      headers: { authorization: `Bearer ${accessToken}`, accept: 'application/vnd.github+json' },
      signal: ghSignal(),
    });
    if (!res.ok) throw new GithubError(`Listing repositories failed (${res.status})`);
    const data = (await res.json()) as Array<{
      full_name?: string;
      id?: number;
      private?: boolean;
      permissions?: { admin?: boolean };
    }>;
    for (const r of data) {
      if (
        r.permissions?.admin === true &&
        typeof r.full_name === 'string' &&
        typeof r.id === 'number'
      ) {
        out.push({ fullName: r.full_name, githubRepoId: r.id, private: Boolean(r.private) });
      }
    }
    // A short page means we've reached the end of the result set.
    if (data.length < REPOS_PER_PAGE) break;
  }
  return out;
}

export interface PullRequestState {
  merged: boolean;
  mergeCommitSha?: string;
  baseRepoId?: number;
}

/**
 * Fetch a pull request's merge state. Used by the maintainer manual-release path
 * to confirm a merge directly with GitHub when the webhook did not arrive — the
 * same trust source as the webhook, just pulled instead of pushed.
 */
export async function fetchPullRequest(
  owner: string,
  repo: string,
  prNumber: number,
  accessToken: string,
): Promise<PullRequestState> {
  const res = await fetch(`${API_BASE}/repos/${owner}/${repo}/pulls/${prNumber}`, {
    headers: { authorization: `Bearer ${accessToken}`, accept: 'application/vnd.github+json' },
    signal: ghSignal(),
  });
  if (!res.ok) throw new GithubError(`Fetching pull request failed (${res.status})`);
  const data = (await res.json()) as {
    merged?: boolean;
    merge_commit_sha?: string | null;
    base?: { repo?: { id?: number } };
  };
  return {
    merged: data.merged === true,
    mergeCommitSha: typeof data.merge_commit_sha === 'string' ? data.merge_commit_sha : undefined,
    baseRepoId: data.base?.repo?.id,
  };
}

export interface RepoMetadata {
  id: number;
  fullName: string;
}

/**
 * Resolve a repo's canonical numeric id from its owner/name using the caller's
 * token. Resolving server-side (rather than trusting an id from the request body)
 * proves the caller can actually see the repo and prevents binding our records to
 * a repo id the caller does not control.
 */
export async function fetchRepoMetadata(
  owner: string,
  repo: string,
  accessToken: string,
): Promise<RepoMetadata> {
  const res = await fetch(`${API_BASE}/repos/${owner}/${repo}`, {
    headers: { authorization: `Bearer ${accessToken}`, accept: 'application/vnd.github+json' },
    signal: ghSignal(),
  });
  if (!res.ok) throw new GithubError(`Fetching repository failed (${res.status})`);
  const data = (await res.json()) as { id?: number; full_name?: string };
  if (typeof data.id !== 'number') throw new GithubError('Malformed repository response');
  return { id: data.id, fullName: data.full_name ?? `${owner}/${repo}` };
}

/**
 * Install a pull_request webhook on a repo, pointing at our ingest URL and signed
 * with the given per-repo secret. Returns GitHub's hook id, which becomes the
 * lookup key (X-GitHub-Hook-ID) the ingest path matches deliveries against.
 */
export async function createRepoWebhook(
  owner: string,
  repo: string,
  accessToken: string,
  opts: { url: string; secret: string },
): Promise<{ id: number }> {
  const res = await fetch(`${API_BASE}/repos/${owner}/${repo}/hooks`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${accessToken}`,
      accept: 'application/vnd.github+json',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      name: 'web',
      active: true,
      events: ['pull_request'],
      config: { url: opts.url, content_type: 'json', secret: opts.secret },
    }),
    signal: ghSignal(),
  });
  if (!res.ok) throw new GithubError(`Creating repository webhook failed (${res.status})`);
  const data = (await res.json()) as { id?: number };
  if (typeof data.id !== 'number') throw new GithubError('Malformed webhook creation response');
  return { id: data.id };
}
