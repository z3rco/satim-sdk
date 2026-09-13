# Support

This SDK is an independent open source project. It has no affiliation with SATIM or the
CIB interbank network.

## Routing

| Subject | Channel |
| - | - |
| Usage questions, integration help, design ideas | [GitHub Discussions](https://github.com/z3rco/satim-sdk/discussions) |
| Reproducible bugs, concrete feature requests | [GitHub Issues](https://github.com/z3rco/satim-sdk/issues) |
| Vulnerabilities | [Security Advisories](https://github.com/z3rco/satim-sdk/security/advisories/new). Never a public issue |
| Credentials, terminal provisioning, entitlements, settlement, CIBWeb access | SATIM directly. Nothing in this repository can change any of it |

## Before opening an issue

1. Search existing [issues](https://github.com/z3rco/satim-sdk/issues) and
   [discussions](https://github.com/z3rco/satim-sdk/discussions).
2. Check the [API reference](https://z3rco.github.io/satim-sdk/), [README](./README.md)
   and the module READMEs under `src/`.
3. Confirm you are on the [latest release](https://github.com/z3rco/satim-sdk/releases).
4. Run `satim.checkCapabilities()` if the failure is a permission or credential error. It
   tells a wrong password apart from an operation your terminal is not entitled to use.

## What a bug report must contain

| Field | Detail |
| - | - |
| Version | SDK version and runtime with version (Node, Bun, Deno, Workers) |
| Mode | test or production gateway |
| Call | the method, and the setters applied before it |
| Observed | the error class, `errorCategory`, `httpStatus` and gateway `ErrorCode` if present |
| Expected | what you expected instead |
| Repro | the smallest snippet that reproduces it |

Never paste credentials, raw request bodies, full PANs, or unredacted gateway responses.
Use `getRawResponse()`, which redacts PII, and strip anything else by hand.
