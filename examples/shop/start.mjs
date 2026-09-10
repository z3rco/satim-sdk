/**
 * Start the mock gateway and the demo shop together, interleaving their
 * output into one console so the whole payment flow reads top to bottom.
 *
 *     npm run shop
 */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { access } from "node:fs/promises";

const root = fileURLToPath(new URL("../..", import.meta.url));

try {
    await access(new URL("../../dist/index.js", import.meta.url));
} catch {
    console.error("\n  dist/ is missing — run `npm run build` first.\n");
    process.exit(1);
}

const children = [];

function run(name, file, colour, env = {}) {
    const child = spawn(process.execPath, [file], {
        cwd: root,
        env: { ...process.env, ...env },
        stdio: ["ignore", "pipe", "pipe"],
    });
    const prefix = `${colour}${name.padEnd(7)}\x1b[0m │ `;
    const pipe = (stream) => {
        let buffer = "";
        stream.on("data", (chunk) => {
            buffer += chunk.toString();
            const lines = buffer.split("\n");
            buffer = lines.pop();
            for (const line of lines) process.stdout.write(prefix + line + "\n");
        });
    };
    pipe(child.stdout);
    pipe(child.stderr);
    child.on("exit", (code) => {
        if (code) process.stdout.write(`${prefix}exited with code ${code}\n`);
        shutdown();
    });
    children.push(child);
    return child;
}

let closing = false;
function shutdown() {
    if (closing) return;
    closing = true;
    for (const child of children) child.kill("SIGTERM");
    setTimeout(() => process.exit(0), 150);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

run("gateway", "mock/gateway.mjs", "\x1b[35m", { QUIET: process.env.QUIET ?? "" });
// Give the gateway a moment so the shop's first request cannot race it.
setTimeout(() => run("shop", "examples/shop/server.mjs", "\x1b[36m"), 300);
