# devbounty-backend

> Decentralized bug-bounty platform. Smart-contract escrow on **Arbitrum Sepolia**
> (USDC) released by GitHub merge webhooks, with reputation leaderboards.

An npm-workspaces monorepo for the **Express API**, the **chain indexer**, and the
**Hardhat smart contracts**. The Next.js frontend lives in a separate repo.

## Status

Bootstrapping — see the
[milestones](https://github.com/ozpool/Devbounty-backend-/milestones) and
[issues](https://github.com/ozpool/Devbounty-backend-/issues) for progress.

## Local guardrails

- Conventional Commits enforced by a `commit-msg` hook (commitlint).
- `pre-commit` runs a repo-hygiene gate + prettier (lint-staged).
- See [`CONTRIBUTING.md`](CONTRIBUTING.md) for the branch / PR workflow.
