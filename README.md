# devbounty-backend

Backend for **DevBounty**, a decentralized bug-bounty platform. Sponsors fund
bounties in USDC held by an on-chain escrow; when a maintainer merges the pull
request that fixes the issue, the escrow releases the funds to the hunter.

## How it works

1. A sponsor funds a bounty in USDC into the escrow contract.
2. A hunter claims it and opens a pull request with the fix.
3. A maintainer merges the pull request; GitHub sends a webhook.
4. The API verifies the webhook, matches the merge to the bounty, and releases
   the escrowed funds on-chain.
5. An indexer tracks the contract's events to keep records and the leaderboard
   in sync.

## Architecture

An npm-workspaces monorepo:

| Workspace    | Purpose                                  |
| ------------ | ---------------------------------------- |
| `api/`       | Express HTTP API and the chain indexer.  |
| `contracts/` | Hardhat project for the escrow contract. |

## Tech stack

TypeScript, Express, MongoDB (Mongoose), zod, pino, viem, SIWE and JWT for auth.
Contracts use Hardhat and OpenZeppelin. Tests run on vitest.

## Requirements

- Node.js 20–22
- MongoDB
- An Arbitrum Sepolia RPC URL

## Setup

```bash
npm install
cp api/.env.example api/.env   # then fill in the values
```

## Usage

Run scripts inside the `api` workspace:

```bash
npm -w @devbounty/api run dev        # start the API in watch mode
npm -w @devbounty/api run test       # run the test suite
npm -w @devbounty/api run lint       # lint
npm -w @devbounty/api run typecheck  # type-check
```

## License

[MIT](LICENSE)
