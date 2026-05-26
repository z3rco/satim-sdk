# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.0.0] - 2026-05-26

### Added

- `Satim` client with fluent immutable configuration API
- `register()` and `registerPreAuth()` for CIB and Edahabia payment registration
- `confirm()` with automatic amount verification to prevent partial-capture manipulation
- `status()` with automatic retry on transient failures
- `refund()` and `reverseOrder()` for post-capture operations
- `safeRegister()` and `safeRegisterPreAuth()` with deterministic idempotency keys derived from `merchantRef`
- `RegisterResponse` and `ConfirmResponse` typed wrappers with full status predicate set
- Zero-trust webhook handler with HMAC-SHA256 verification, replay protection, and distributed rate limiting
- SSRF protection against private IP ranges, cloud metadata endpoints, and non-standard IP encodings
- Credential isolation via module-private `WeakMap` — credentials never appear in `JSON.stringify()` or `console.log()` output
- IEEE 754-safe minor-unit conversion with sub-centime rejection
- Circuit breaker for transient failure isolation
- Full TypeScript strict-mode coverage with zero runtime dependencies
- Support for Node.js ≥ 20, Bun ≥ 1.0, Deno ≥ 1.28, and Cloudflare Workers

[Unreleased]: https://github.com/z3rco/satim-sdk/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/z3rco/satim-sdk/releases/tag/v1.0.0
