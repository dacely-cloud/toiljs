import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { AuthRoutesConfig } from '../../src/compiler/config.js';

export function scaffoldAuthApp(dir: string, policy: AuthRoutesConfig, configAuth = true) {
    mkdirSync(join(dir, 'node_modules'), { recursive: true });
    symlinkSync(resolve('.'), join(dir, 'node_modules/toiljs'));
    mkdirSync(join(dir, 'server'));
    writeFileSync(join(dir, 'package.json'), '{"type":"module"}');
    writeFileSync(
        join(dir, 'toil.config.mjs'),
        `export default ${JSON.stringify({
            client: { devtools: false, images: false, fonts: false },
            server: { auth: configAuth, authRoutes: policy, threads: 1 },
        })};`,
    );
    writeFileSync(
        join(dir, 'toilconfig.json'),
        JSON.stringify({
            entries: ['server/main.ts'],
            targets: { release: { outFile: 'build/server/release.wasm' } },
            options: {
                runtime: 'stub',
                memoryBase: 65536,
                optimizeLevel: 0,
                shrinkLevel: 0,
                lib: ['node_modules/toiljs/server/globals'],
            },
        }),
    );
    writeFileSync(
        join(dir, 'server/main.ts'),
        `
import 'toiljs/server/auth';
import { Server, RestHandler, ToilHandler, Response } from 'toiljs/server/runtime';
@rest('proof') class Proof {
 @auth @post('/fail') fail(): Response { return Response.text('auth: request failed\\n', 401).setHeader('x-proof-action', 'accepted'); }
}
Server.handler = (): ToilHandler => new RestHandler();
export * from 'toiljs/server/runtime/exports';
`,
    );
}
