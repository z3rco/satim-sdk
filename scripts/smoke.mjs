/**
 * Consumer smoke test for the built package.
 *
 * `tsc` succeeding does not mean the output is loadable: extensionless
 * relative imports compile fine and then fail in Node's ESM resolver at
 * the consumer's first `import`. This script loads `dist/` the way a
 * consumer does — plain Node, no bundler, no TypeScript — and asserts the
 * runtime-agnostic guarantees the package advertises.
 *
 * Run after `npm run build`.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";

const dist = fileURLToPath(new URL("../dist", import.meta.url));

const { Satim, WebhookHandler, deriveOrderNumber, sha256Hex, toMinorUnits } =
    await import(join(dist, "index.js"));

// 1. No `node:` imports anywhere in the shipped JS — this is what keeps the
//    package loadable on Vercel Edge and on Workers without `nodejs_compat`.
const offenders = [];
(function walk(dir) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) walk(path);
        else if (entry.name.endsWith(".js") && /from\s+["']node:/.test(readFileSync(path, "utf8"))) {
            offenders.push(path);
        }
    }
})(dist);
assert.deepEqual(offenders, [], `dist must not import node: builtins, found: ${offenders}`);

// 2. The public surface loads and behaves.
const satim = new Satim({ username: "u", password: "p", terminalId: "t" });
const configured = satim.amount(5000).returnUrl("https://shop.example/return");
assert.notEqual(satim, configured, "setters must return a new instance");
assert.match(JSON.stringify(satim), /\[REDACTED\]/, "credentials must be redacted in JSON");
assert.equal(String(satim), "[SatimConfig credentials=REDACTED]");

assert.equal(sha256Hex("abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
assert.equal(toMinorUnits(50.5), 5050);
assert.match(deriveOrderNumber("cart-1"), /^[a-z0-9]{10}$/);

const handler = configured.createWebhookHandler({
    onResolveAmount: () => 100,
    suppressMultiInstanceWarning: true,
});
assert.ok(handler instanceof WebhookHandler);
assert.deepEqual(await handler.inspect({ garbage: true }), { verified: false, reason: "invalid_source" });

console.log("smoke: dist loads in plain Node ESM, no node: imports, public API behaves");
