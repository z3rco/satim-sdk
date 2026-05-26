/**
 * Backwards-compatibility re-export.
 *
 * Tests and downstream consumers may import response wrappers from
 * `./responses`; the actual implementations live in
 * {@link ./responses/register} and {@link ./responses/confirm}, with
 * runtime schema validation in {@link ./responses/schema}.
 *
 * No logic lives in this file. New code should import from the package
 * root: `import { RegisterResponse, ConfirmResponse } from "satim-module"`.
 * @file
 */

export { RegisterResponse } from "./responses/register";
export { ConfirmResponse } from "./responses/confirm";
