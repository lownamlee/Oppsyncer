# Contributing to Oppsyncer

Thank you for helping improve Oppsyncer.

## Development

1. Install Node.js 22 and pnpm 10.
2. Run `pnpm install`.
3. Run `pnpm run check` before opening a pull request.

`pnpm run check` runs the type-aware linter, behavioral tests, strict TypeScript
checks, and the production build.

## Pull requests

- Keep changes focused and explain the synchronization behavior they affect.
- Add or update tests for state-machine and safety changes.
- Never commit GitHub access tokens, vault contents, or plugin `data.json` files.
- Preserve the rule that the coordinated branch is never force-updated.

By contributing, you agree that your contribution is licensed under the
AGPL-3.0-only license used by this repository.
