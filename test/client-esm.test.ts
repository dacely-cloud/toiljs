import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { expect, it } from 'vitest';

it('loads the built client in Node ESM without consumer import patches', (): void => {
    const entry: string = pathToFileURL(resolve(import.meta.dirname, '../build/client/index.js')).href;
    const result: SpawnSyncReturns<string> = spawnSync(
        process.execPath,
        ['--input-type=module', '-e', `const client = await import(${JSON.stringify(entry)}); if (typeof client.Router !== 'function' || typeof client.useHead !== 'function') process.exit(1);`],
        { encoding: 'utf8' },
    );
    expect(result.status, result.stderr).toBe(0);
});
