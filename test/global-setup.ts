import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Vitest global setup: generate `src/compiler/toil-docs.generated.ts` before the
 * suite runs. `src/compiler/docs.ts` imports that module, but it is gitignored
 * and only (re)created by the build's `gen:docs` step, so a fresh checkout that
 * runs the tests without a prior build would otherwise fail to resolve it
 * ("Cannot find module './toil-docs.generated.js'"). Running the same generator
 * the npm scripts use keeps the tests self-contained. Runs once per vitest
 * invocation, so it also covers `npx vitest` / watch mode.
 */
export default function setup(): void {
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
    execFileSync('node', ['scripts/gen-toil-docs.mjs'], { cwd: root, stdio: 'ignore' });
}
