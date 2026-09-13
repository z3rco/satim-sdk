## Summary

> Replace: what changed and why, in one paragraph. State the observable behaviour before
> and after.

## Type

- [ ] Bug fix (no API change)
- [ ] Feature (no API change)
- [ ] Breaking change
- [ ] Documentation
- [ ] Internal refactor or chore

## Gate

- [ ] `bun run typecheck` passes
- [ ] `bun run test` passes
- [ ] `bun run build` passes
- [ ] `npm run smoke` passes
- [ ] Tests added or updated; a bug fix has a test that failed before the fix

## Rules (CONTRIBUTING.md section 1)

- [ ] No new runtime dependency
- [ ] No `node:` import and no Node only API in `src/`
- [ ] New setters clone and return the clone
- [ ] No `any` added to the public surface
- [ ] The invariants in ARCHITECTURE.md section 4 still hold

## Blast radius

> Replace: which of these the change touches, or "none". Retry policy, breaker accounting,
> credential handling, SSRF rules, amount conversion, predicate contract, webhook marking.

## Documentation

- [ ] TSDoc on any new or changed public declaration
- [ ] ARCHITECTURE.md updated for cross module behaviour
- [ ] Module README updated for module internals
- [ ] README.md and CHANGELOG.md updated for caller visible changes
- [ ] SECURITY.md updated if the security posture moved

## Related issues

> Replace: for example, Closes #123.
