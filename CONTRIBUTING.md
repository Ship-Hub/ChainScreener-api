# Contributing to Chain Screener API

Thank you for your interest in contributing! This document explains how to get started.

## Code of Conduct

This project follows the [Contributor Covenant Code of Conduct](CODE_OF_CONDUCT.md). By participating you agree to uphold it.

## How to Contribute

### Reporting Bugs

Use the [Bug Report](.github/ISSUE_TEMPLATE/bug_report.yml) issue template. Include:
- Steps to reproduce
- Expected vs. actual behaviour
- Node.js version, OS, and relevant environment variables (no secrets)

### Requesting Features

Use the [Feature Request](.github/ISSUE_TEMPLATE/feature_request.yml) issue template.

### Reporting Security Vulnerabilities

**Do not open a public issue.** See [SECURITY.md](SECURITY.md) for the private disclosure process.

## Development Workflow

1. **Fork** the repository and clone your fork.
2. **Create a feature branch** from `main`:
   ```bash
   git checkout -b feat/your-feature-name
   ```
3. **Install dependencies**:
   ```bash
   npm install
   cp .env.example .env
   npm run db:migrate
   ```
4. **Make your changes.**
5. **Run lint** before committing:
   ```bash
   npm run lint
   ```
6. **Build** to catch TypeScript errors:
   ```bash
   npm run build
   ```
7. **Commit** using [Conventional Commits](https://www.conventionalcommits.org/):
   - `feat: add holder enrichment endpoint`
   - `fix: correct swap delta calculation for V4 pools`
   - `docs: update indexer README`
   - `chore: upgrade viem to v2.22`
8. **Push** your branch and open a **Pull Request** against `main`.
9. Fill in the PR template completely.
10. A maintainer will review. Address any feedback, then a maintainer merges.

## Pull Request Requirements

- All CI checks must pass (lint + build).
- At least 1 maintainer approval is required.
- All review conversations must be resolved.
- No direct pushes to `main` â€” PRs only.

## Project Structure

```
src/
  app.ts           Fastify app factory
  server.ts        Entry point
  config/          Chain/DEX/platform configuration
  db/              Database client and migrations
  indexer/         Background indexer workers
  routes/          HTTP route handlers
  services/        Business logic
  shared/          Shared utilities (env, types)
  types/           Domain types
db/
  schema.sql       Database schema
```

## Environment Variables

See [.env.example](.env.example) for all required and optional variables. Never commit a `.env` file.

## Questions

Open a [Discussion](https://github.com/Ship-Hub/ChainScreener-api/discussions) for questions that are not bugs or feature requests.
