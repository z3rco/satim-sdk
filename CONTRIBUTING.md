# Contributing

## 1. Hard rules

A change that violates any of these is rejected regardless of merit.

| ID | Rule |
| - | - |
| R1 | Zero runtime dependencies. Nothing is added to `dependencies` in `package.json`. Dev only tooling is acceptable when it earns its keep |
| R2 | Runtime agnostic. No `node:` imports, no `process.cwd()`, no Node only API in `src/`. Web standard globals only. `process.env` is read exactly once, guarded by a `typeof process` check, for the TLS guard |
| R3 | Immutable fluent API. Setters clone and return the clone. They never mutate `this`. Pattern: `src/config.ts` |
| R4 | Strict TypeScript. No `any` in the public surface. An internal `any` must be load bearing and carry a comment saying why |
| R5 | The invariants in [ARCHITECTURE.md](./ARCHITECTURE.md) section 4 hold after your change, or the change explains in the PR why the invariant itself was wrong |

Before touching credential handling, URL parsing, retry policy or amount conversion, read
[SECURITY.md](./SECURITY.md) first.

## 2. Setup

```bash
git clone https://github.com/z3rco/satim-sdk.git
cd satim-sdk
bun install
bun run test
bun run typecheck
```

## 3. Workflow

1. Open an issue first for anything larger than a typo, so scope is agreed before work starts.
2. Branch off `master`, named by intent: `fix/`, `feat/`, `docs/`, `refactor/`, `test/`, `chore/`.
3. For a bug fix, write the failing test first. It makes the regression boundary explicit.
4. Run the full gate locally: `bun run typecheck`, `bun run test`, `bun run build`, `npm run smoke`.
5. Open a PR against `master` and fill in the template.

CI runs the same gate on Node 20, 22 and 24 plus Bun, and loads the built package in plain
Node. CodeQL runs on every push and weekly.

## 4. Commit format

[Conventional Commits](https://www.conventionalcommits.org/). Breaking changes take `!`.

```
feat: add reverseOrder amount verification
fix: reject sub centime amounts near MAX_SAFE_AMOUNT
docs: correct the retry policy table
refactor: extract idempotency key derivation
test: cover IPv6 SSRF edge cases
chore: bump vitest
feat!: drop Node 18 support
```

## 5. Test requirements

| Change | Required coverage |
| - | - |
| New public method | happy path plus at least one failure path |
| Bug fix | a test that fails before the fix |
| SSRF, credential handling, amount precision, retry policy | a case in `tests/hardening.test.ts` or `tests/adversarial.test.ts` |
| Predicate logic | the combination table in `tests/app.test.ts` stays exhaustive |
| Anything touching the wire | mock through an `HttpClientService` substitute, see `tests/integration.test.ts` |

Never add a test that performs a real network call.

## 6. Documentation requirements

| Change scope | Update |
| - | - |
| Public method or option | TSDoc on the declaration. It feeds TypeDoc and the published reference |
| Cross module behaviour, invariant, or state machine | `ARCHITECTURE.md` |
| Single module internals | the relevant `src/**/README.md` |
| Anything a caller can observe | `README.md` and `CHANGELOG.md` under `[Unreleased]` |
| Security posture | `SECURITY.md`, including the residual risk column |

Documentation is ASCII only. No em dashes, no smart quotes, no box drawing.

## 7. Security reports

Do not open a public issue for a security finding. Use
[GitHub Security Advisories](https://github.com/z3rco/satim-sdk/security/advisories/new).

## 8. Conduct and licence

This project follows the [Contributor Covenant](./CODE_OF_CONDUCT.md). Contributions are
licensed under the [MIT License](./LICENSE.md).
