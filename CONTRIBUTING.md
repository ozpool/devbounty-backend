# Contributing to devbounty-backend

Full process lives in [`docs/ENGINEERING.md`](docs/ENGINEERING.md). The short
version:

## Branch model

- `main` is always green and always deployable. **No direct pushes.**
- One branch per issue: `<type>/<issue#>-<kebab-desc>`
  (e.g. `feat/17-siwe-nonce-endpoint`).
- Branches are **never deleted** — full audit trail (enforced by a Ruleset).
- Branches live < 3 days; rebase onto `main` daily.

## Commits

Conventional Commits 1.0 — `<type>(<scope>): <subject>`, imperative, ≤ 72 chars.
Enforced locally via the `commit-msg` husky hook and re-checked in CI against
the PR title (squash-merge uses the PR title as the commit message).

Types: `feat fix chore docs test refactor perf ci build style revert`.

## Pull requests

1. Open a PR with the template filled in. Link the issue with `Closes #N`.
2. CI must be green.
3. Complete the PR checklist and the linked issue's acceptance criteria.
4. **A human merges** (squash only). Tooling never clicks merge / auto-merge.

## Local setup

```bash
npm install                 # installs deps + husky hooks
docker compose -f docker-compose.dev.yml up -d   # Mongo (added in #38)
npm --workspace api run dev
```

## Forbidden patterns (auto request-changes)

See `docs/ENGINEERING.md` §14 — no `console.log` in committed code, no `any`,
no `.only`/`.skip` in tests, no `process.env.*` outside `config/env.ts`, no
hardcoded chain IDs/addresses, no Mongo writes from controllers, no JSON body
parse on `/webhooks/github` before HMAC verifies.
