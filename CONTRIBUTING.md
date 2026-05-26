# Contributing to satim-sdk

Thanks for considering a contribution. This guide covers the conventions we want every PR to follow.

## Ground rules

1. **Zero runtime dependencies.** Anything added to `dependencies` in `package.json` is a non-starter. Dev-only tooling under `devDependencies` is fine if it earns its keep.
2. **Runtime-agnostic.** Code must work on Node 20+, Bun, Deno, and Cloudflare Workers. No `node:fs`, no `process.cwd()`, no Node-only APIs in `src/`. The Web Fetch API is the only network primitive.
3. **Immutable, fluent API.** Setters return a new instance — never mutate `this`. See `src/config.ts` for the pattern.
4. **Strict TypeScript.** No `any` in the public surface. Internal `any` should be load-bearing and commented.
5. **Security is a first-class concern.** Re-read `SECURITY.md` before touching credential handling, URL parsing, or amount conversion.

## Getting set up

```bash
git clone https://github.com/z3rco/satim-sdk.git
cd satim-sdk
bun install
bun run test
bun run typecheck
```

## Development workflow

1. **Open an issue first** for anything bigger than a typo so we can align on scope.
2. **Branch off `master`.** Name the branch by intent: `fix/...`, `feat/...`, `docs/...`, `refactor/...`.
3. **Write the test first** if you're fixing a bug. The failing test makes the regression boundary explicit.
4. **Run the full suite locally**: `bun run typecheck && bun run test && bun run build`.
5. **Open a PR** against `master`. Fill in the PR template.

## Commit messages

We use [Conventional Commits](https://www.conventionalcommits.org/):

- `feat: add reverseOrder amount verification`
- `fix: reject sub-centime amounts near MAX_SAFE_AMOUNT`
- `docs: clarify retry policy in ARCHITECTURE.md`
- `refactor: extract idempotency key derivation`
- `test: cover IPv6 SSRF edge cases`
- `chore: bump vitest`

Breaking changes get `!`: `feat!: drop Node 18 support`.

## Test expectations

- Every public method has a unit test for the happy path and at least one failure path.
- Network calls are mocked through `HttpClientService` substitutes — see `tests/integration.test.ts` for the pattern.
- Security-critical changes (SSRF, credential leakage, amount precision) get a test in `hardening.test.ts` or `adversarial.test.ts`.

## Documentation

- Public methods need TSDoc. The TSDoc feeds TypeDoc, which feeds the published API reference.
- Cross-module changes go in `ARCHITECTURE.md`.
- Module-scoped changes go in the relevant `src/**/README.md`.
- User-facing changes go in the README and `CHANGELOG.md` (under `[Unreleased]`).

## Reporting security issues

Do **not** open a public issue for security findings. Use [GitHub Security Advisories](https://github.com/z3rco/satim-sdk/security/advisories/new) instead.

## Code of conduct

This project is governed by the [Contributor Covenant](./CODE_OF_CONDUCT.md). Be kind. Be specific. Assume good faith.

## License

By contributing, you agree your contributions will be licensed under the [MIT License](./LICENSE.md).
