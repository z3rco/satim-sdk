/**
 * Backwards-compatibility re-export. Real implementations live in
 * {@link ./responses/register} and {@link ./responses/confirm}. No logic
 * here — new code should import from the package root instead.
 * @file
 */

export { RegisterResponse } from "./responses/register.js";
export { ConfirmResponse } from "./responses/confirm.js";
