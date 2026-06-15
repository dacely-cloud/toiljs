/**
 * `toiljs create`, an interactive project scaffolder (Clack-powered) that wires a new
 * app to the enforced toiljs presets (tsconfig / eslint / prettier) and file-based routing.
 * Supports a non-interactive path via flags (`--yes`, `--template`, …) for scripting/CI.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
    cancel,
    confirm,
    intro,
    isCancel,
    multiselect,
    note,
    outro,
    select,
    spinner,
    text,
} from '@clack/prompts';
import { AI_HELPER_IDS, AI_HELPERS, aiHelperFiles, TOIL_DOCS, TOIL_ENV_DTS } from 'toiljs/compiler';
import pc from 'picocolors';

import {
    PKG_VERSION,
    type Preprocessor,
    PREPROCESSORS,
    requiredPackages,
    setStyleImports,
    styleEntry,
    type StyleFeatures,
    styleImportLines,
    TAILWIND_CSS,
    TAILWIND_ENTRY,
} from './features.js';
import { run } from './proc.js';
import { accent, dim, version } from './ui.js';
import { isPackageManager, isValidName, resolveProjectDir } from './validate.js';

export type Template = 'app' | 'minimal';

/** Human label for each preprocessor in the styling picker. */
const PREPROCESSOR_LABEL: Record<Preprocessor, string> = {
    css: 'Plain CSS',
    sass: 'Sass (SCSS)',
    less: 'Less',
    stylus: 'Stylus',
};

/** Default global stylesheet contents (palette base styles), shared by every preprocessor. */
const DEFAULT_STYLE_CONTENT =
    ':root {\n    color-scheme: dark;\n}\n\n' +
    'body {\n    margin: 0;\n    background: #080d11;\n    color: #f5f6fa;\n' +
    '    font-family: system-ui, -apple-system, sans-serif;\n    line-height: 1.6;\n}\n\n' +
    'a {\n    color: #2563ff;\n    text-decoration: none;\n}\n\n' +
    'a:hover {\n    color: #22e3ab;\n}\n\n' +
    'code {\n    background: #11161f;\n    color: #22e3ab;\n    padding: 0.1rem 0.4rem;\n' +
    '    border-radius: 4px;\n    font-size: 0.9em;\n}\n\n' +
    'h1 {\n    background: linear-gradient(90deg, #2563ff, #7c3aed, #22e3ab);\n' +
    '    -webkit-background-clip: text;\n    background-clip: text;\n    color: transparent;\n}\n';

/** A selectable template in the `create` wizard. */
interface TemplateOption {
    readonly value: Template;
    readonly label: string;
    readonly hint: string;
}

export interface CreateOptions {
    readonly name?: string;
    readonly template?: Template;
    readonly preprocessor?: Preprocessor;
    readonly tailwind?: boolean;
    /** AI assistant files to scaffold: `true` = all, `false` = none, omitted = ask. */
    readonly ai?: boolean;
    /** Enable build-time image optimization. Default `true`; omitted = ask. */
    readonly images?: boolean;
    readonly install?: boolean;
    readonly git?: boolean;
    readonly pm?: string;
    readonly yes?: boolean;
    readonly cwd: string;
}

/** Aborts the wizard cleanly on Ctrl-C / cancel, narrowing the prompt result to its value type. */
function bail<T>(value: T | symbol): asserts value is T {
    if (isCancel(value)) {
        cancel('Scaffolding cancelled.');
        process.exit(0);
    }
}

async function isEmptyDir(dir: string): Promise<boolean> {
    try {
        const entries = await fs.readdir(dir);
        return entries.length === 0;
    } catch {
        return true;
    }
}

/** Builds the full file map (relative path → contents) for a scaffolded project. */
function scaffold(
    name: string,
    template: Template,
    features: StyleFeatures,
    aiTools: readonly string[],
    images: boolean,
): Record<string, string> {
    const toilVersion = version();
    const devDependencies: Record<string, string> = {
        '@types/react': '^19.2.15',
        '@types/react-dom': '^19.2.3',
        eslint: '^10.2.0',
        prettier: '^3.8.1',
        toilscript: '^0.1.18',
        typescript: '^6.0.3',
    };
    for (const dep of requiredPackages(features).sort()) {
        devDependencies[dep] = PKG_VERSION[dep] ?? 'latest';
    }
    const pkg = {
        name: path.basename(name),
        private: true,
        type: 'module',
        scripts: {
            dev: 'toiljs dev',
            build: 'toiljs build',
            'build:server': 'toiljs build --server',
            lint: 'eslint client',
            typecheck: 'tsc --noEmit',
            format: 'prettier --write "client/**/*.{ts,tsx,css,scss,less}" "client/public/**/*.html" "server/**/*.ts"',
        },
        dependencies: {
            toiljs: `^${toilVersion}`,
            react: '^19.2.6',
            'react-dom': '^19.2.6',
        },
        devDependencies,
    };

    const files: Record<string, string> = {
        'package.json': JSON.stringify(pkg, null, 4) + '\n',
        'toil.config.ts':
            "import { defineConfig } from 'toiljs/compiler';\n\n" +
            'export default defineConfig({\n' +
            '    client: {\n' +
            '        // Optimize images at build time (resize/compress imported images).\n' +
            `        images: ${String(images)},\n` +
            '    },\n' +
            '});\n',
        'tsconfig.json':
            '{\n' +
            '    "extends": "toiljs/tsconfig",\n' +
            '    "compilerOptions": {\n' +
            '        "paths": { "shared/*": ["./shared/*"] }\n' +
            '    },\n' +
            '    "include": ["client", "shared", "toil-env.d.ts", "toil-routes.d.ts"]\n' +
            '}\n',
        'eslint.config.js': "import toiljs from 'toiljs/eslint';\n\nexport default toiljs;\n",
        '.prettierrc': '"toiljs/prettier"\n',
        // Generated files don't need formatting. (toilscript server decorators like @main /
        // @remote-on-functions are handled by the toiljs/prettier-plugin, so server/ is not ignored.)
        '.prettierignore':
            'node_modules\nbuild\n.toil\nshared/server.ts\ntoil-env.d.ts\ntoil-routes.d.ts\n',
        '.gitignore':
            'node_modules\nbuild\n.toil\nshared/server.ts\ntoil-env.d.ts\ntoil-routes.d.ts\n',
        // Use the project's pinned TypeScript (node_modules) instead of VS Code's bundled version.
        '.vscode/settings.json':
            JSON.stringify({ 'typescript.tsdk': 'node_modules/typescript/lib' }, null, 4) + '\n',
        'toil-env.d.ts': TOIL_ENV_DTS,
        // Stub typed-routes augmentation (RoutePath = string until the first dev/build regenerates it).
        'toil-routes.d.ts': '// AUTO-GENERATED by toil, do not edit.\nexport {};\n',
        'toilconfig.json':
            JSON.stringify(
                {
                    // `toiljs build` compiles every decorated server file (recursively) so
                    // dropped-in @data/@rest files are picked up; main.ts imports the surface
                    // modules so a direct `toilscript` run builds the same server.
                    entries: ['server/main.ts'],
                    targets: {
                        release: {
                            outFile: 'build/server/release.wasm',
                            textFile: 'build/server/release.wat',
                        },
                    },
                    options: {
                        sourceMap: false,
                        optimizeLevel: 3,
                        shrinkLevel: 1,
                        converge: true,
                        noAssert: false,
                        enable: [
                            'sign-extension',
                            'mutable-globals',
                            'nontrapping-f2i',
                            'bulk-memory',
                            'simd',
                            'reference-types',
                            'multi-value',
                        ],
                        runtime: 'stub',
                        // toiljs server globals (exports become ambient, used
                        // with no import -- e.g. `AuthService` for the
                        // post-quantum auth primitive), exactly like `crypto`.
                        lib: ['node_modules/toiljs/server/globals'],
                        // Reserve [0, 64 KiB) for the request envelope the
                        // edge writes at offset 0. Static data starts ABOVE
                        // it, so a large request can never overwrite guest
                        // state; the edge rejects envelopes past this window.
                        // Raise to accept larger request bodies (costs
                        // initial memory).
                        memoryBase: 65536,
                        initialMemory: 4,
                        debug: false,
                        trapMode: 'allow',
                    },
                },
                null,
                4,
            ) + '\n',
        'server/tsconfig.json':
            JSON.stringify(
                {
                    extends: 'toilscript/std/assembly.json',
                    include: ['./**/*.ts'],
                },
                null,
                4,
            ) + '\n',
        'README.md': [
            '# ' + path.basename(name),
            '',
            'A [toiljs](https://toil.org) app.',
            '',
            '## Develop',
            '',
            '    npm install',
            '    npm run dev',
            '',
            '## Build',
            '',
            '    npm run build',
            '',
        ].join('\n'),
    };

    // The `app` template's client UI + server are copied from examples/basic at runtime; `minimal`
    // ships an inline client + a minimal working server here.
    if (template === 'minimal') {
        Object.assign(files, minimalClient(name, features));
        Object.assign(files, minimalServer());
    }

    // Selected AI-assistant pointer files at the root (committed). The real docs are always seeded
    // under .toil/docs (gitignored; regenerated by dev/build) since the framework manages them.
    Object.assign(files, aiHelperFiles(aiTools));
    for (const [docName, content] of Object.entries(TOIL_DOCS)) {
        files[`.toil/docs/${docName}`] = content;
    }

    return files;
}

/**
 * Editor-only ambient declarations for the toiljs cookie globals (`Cookie` /
 * `Cookies` / `SecureCookies` / `SameSite` / ...). They are `@global` in the
 * runtime, so handlers use them without an import (like `crypto`); this gives the
 * editor their shapes. Auto-included via the server tsconfig and ignored by the
 * compiler. Keep in sync with `toiljs/server/runtime/http/*`.
 */
// Editor-only ambient declarations for the server-runtime globals, scaffolded
// into the server dir. Kept BYTE-IDENTICAL to `TOIL_SERVER_ENV_DTS` in
// src/compiler/generate.ts (which `toiljs build`/`dev` regenerate, and `doctor
// --fix` rewrites), so create / build / doctor never disagree and flip-flop.
export const TOIL_SERVER_ENV_DTS = `// AUTO-GENERATED by toil, do not edit. Editor-only ambient declarations for
// the toiljs server-runtime globals (Cookie, Cookies, SecureCookies, the
// cookie enums): @global in the runtime, used with no import. These alias the
// real runtime types so a global-built Cookie is exactly what Response.setCookie
// / SecureCookies.seal expect. The toilscript compiler registers them itself.
declare const SameSite: typeof import('toiljs/server/runtime/http/cookie').SameSite;
type SameSite = import('toiljs/server/runtime/http/cookie').SameSite;
declare const CookieEncoding: typeof import('toiljs/server/runtime/http/cookie').CookieEncoding;
type CookieEncoding = import('toiljs/server/runtime/http/cookie').CookieEncoding;
declare const CookiePrefix: typeof import('toiljs/server/runtime/http/cookie').CookiePrefix;
type CookiePrefix = import('toiljs/server/runtime/http/cookie').CookiePrefix;
declare const CookieValidation: typeof import('toiljs/server/runtime/http/cookie').CookieValidation;
type CookieValidation = import('toiljs/server/runtime/http/cookie').CookieValidation;
declare const Cookie: typeof import('toiljs/server/runtime/http/cookie').Cookie;
type Cookie = import('toiljs/server/runtime/http/cookie').Cookie;
declare const CookieMap: typeof import('toiljs/server/runtime/http/cookies').CookieMap;
type CookieMap = import('toiljs/server/runtime/http/cookies').CookieMap;
declare const Cookies: typeof import('toiljs/server/runtime/http/cookies').Cookies;
type Cookies = import('toiljs/server/runtime/http/cookies').Cookies;
declare const SecureCookies: typeof import('toiljs/server/runtime/http/securecookies').SecureCookies;
type SecureCookies = import('toiljs/server/runtime/http/securecookies').SecureCookies;
declare const Time: typeof import('toiljs/server/runtime/time').Time;
// Email, rate-limit, 2FA, and auth globals (server/globals/*), hand-declared
// because their AssemblyScript source can't be type-aliased from tsc.
declare enum EmailStatus { Sent, Disabled, Budget, RecipientCapped, Deduped, TryLater, BadRecipient, ProviderError }
declare namespace EmailService { function send(to: string, subject: string, body: string, purpose?: string, html?: string): EmailStatus; }
declare class RenderedEmail { subject: string; body: string; html: string; constructor(subject: string, body: string, html: string); }
declare class EmailTemplate { constructor(subject: string, body: string, html?: string); render(vars: Map<string, string>): RenderedEmail; send(to: string, vars: Map<string, string>, purpose?: string): EmailStatus; }
declare enum RateLimit { FixedWindow, SlidingWindow, TokenBucket }
declare class TwoFactorIssue { code: string; token: string; constructor(code: string, token: string); }
declare class TwoFactorChallenge { token: string; status: EmailStatus; constructor(token: string, status: EmailStatus); }
declare namespace TwoFactor { function setSecret(secret: Uint8Array): void; function issue(recipient: string, purpose: string, ttlSecs?: u64, digits?: i32): TwoFactorIssue; function send(recipient: string, purpose: string, ttlSecs?: u64, digits?: i32): TwoFactorChallenge; function verify(token: string, recipient: string, code: string): bool; }
declare namespace AuthService { const SESSION_COOKIE: string; const USER_COOKIE: string; const LOGIN_CONTEXT: string; const PUBLIC_KEY_LEN: i32; const SIGNATURE_LEN: i32; const DEFAULT_SESSION_TTL_SECS: u64; function setSecret(secret: Uint8Array): void; function hasSession(): bool; function getSessionBytes(): Uint8Array | null; function mintSession(userData: Uint8Array, ttlSecs?: u64): Cookie; function clearSession(): Cookie; function userCookie(userData: Uint8Array, ttlSecs?: u64): Cookie; function clearUserCookie(): Cookie; function buildLoginMessage(sub: string, aud: string, cid: Uint8Array, nonce: Uint8Array, iat: u64, exp: u64): Uint8Array; function verifyLogin(publicKey: Uint8Array, message: Uint8Array, signature: Uint8Array): bool; }
`;

/**
 * A minimal but working server for the `minimal` template (the `app` template copies
 * examples/basic/server). Same folder conventions as the full starter, just fewer files:
 * the entry in main.ts, the handler under core/, and a README mapping where new
 * routes/services/models go.
 */
function minimalServer(): Record<string, string> {
    return {
        'server/toil-server-env.d.ts': TOIL_SERVER_ENV_DTS,
        'server/core/AppHandler.ts':
            "import { ToilHandler, Request, Response, Method } from 'toiljs/server/runtime';\n\n" +
            '/** Every request enters here. Add `@rest` controllers under routes/ as you grow. */\n' +
            'export class AppHandler extends ToilHandler {\n' +
            '    public handle(req: Request): Response {\n' +
            '        if (req.method != Method.GET && req.method != Method.HEAD) {\n' +
            "            return Response.empty(405).setHeader('allow', 'GET, HEAD');\n" +
            '        }\n' +
            "        if (req.path == '/api/hello') {\n" +
            "            return Response.text('hello from toiljs\\n');\n" +
            '        }\n' +
            "        if (req.path == '/api/hash') {\n" +
            '            // `crypto` is a global (no import), synchronous Web Crypto.\n' +
            "            return Response.text(crypto.toHex(crypto.sha256Text(req.path)) + '\\n');\n" +
            '        }\n' +
            '        // Yield page routes and assets to the client: under `toiljs dev`\n' +
            '        // this falls through to Vite so the app renders at /.\n' +
            '        return Response.unhandled();\n' +
            '    }\n' +
            '}\n',
        'server/main.ts':
            "import { Server } from 'toiljs/server/runtime';\n" +
            "import { revertOnError } from 'toiljs/server/runtime/abort/abort';\n\n" +
            "import { AppHandler } from './core/AppHandler';\n\n" +
            '// As you add surface modules (@rest routes, @service/@remote RPC), import them here\n' +
            '// so a direct `toilscript` run builds the same server `toiljs build` does, e.g.:\n' +
            "//   import './routes/Players';\n\n" +
            '// Wire your handler here.\n' +
            'Server.handler = () => new AppHandler();\n\n' +
            '// Required: re-export the WASM entry points and the abort hook.\n' +
            "export * from 'toiljs/server/runtime/exports';\n" +
            'export function abort(message: string, fileName: string, line: u32, column: u32): void {\n' +
            '    revertOnError(message, fileName, line, column);\n' +
            '}\n',
        'server/README.md':
            '# server/\n\n' +
            'Your ToilScript backend, compiled to a single WebAssembly module. One folder per concern:\n\n' +
            '| Folder | What lives here |\n' +
            '| --- | --- |\n' +
            '| `main.ts` | The entry point: wires the handler and imports the surface modules. |\n' +
            '| `core/` | The request handler and shared app logic (state, helpers). |\n' +
            '| `models/` | `@data` classes, the typed wire model shared by HTTP and RPC. One type per file. |\n' +
            '| `routes/` | `@rest` controllers (HTTP). One controller per file, named after its class. |\n' +
            '| `services/` | `@service` classes and free `@remote` functions (typed RPC). |\n' +
            '| `scheduled/` | Reserved for scheduled tasks (not shipped yet). |\n\n' +
            'New decorated files are picked up automatically by `toiljs build`/`dev`; also add an import\n' +
            'in `main.ts` so a direct `toilscript` run builds the same server.\n',
    };
}

/** The inline client UI for the `minimal` template (the `app` template copies examples/basic/client). */
function minimalClient(name: string, features: StyleFeatures): Record<string, string> {
    const files: Record<string, string> = {
        'client/public/index.html':
            '<!doctype html>\n<html lang="en">\n  <head>\n' +
            '    <meta charset="utf-8" />\n' +
            '    <meta name="viewport" content="width=device-width, initial-scale=1" />\n' +
            '    <meta name="theme-color" content="#080D11" />\n' +
            '    <meta name="description" content="" />\n' +
            '    <link rel="icon" type="image/svg+xml" href="/favicon.svg" />\n' +
            '    <link rel="manifest" href="/manifest.webmanifest" />\n' +
            `    <title>${path.basename(name)}</title>\n` +
            '  </head>\n  <body>\n    <div id="root"></div>\n  </body>\n</html>\n',
        'client/public/favicon.svg':
            '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">\n' +
            '  <defs>\n' +
            '    <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">\n' +
            '      <stop offset="0" stop-color="#2563FF" />\n' +
            '      <stop offset="0.5" stop-color="#7C3AED" />\n' +
            '      <stop offset="1" stop-color="#22E3AB" />\n' +
            '    </linearGradient>\n' +
            '  </defs>\n' +
            '  <rect width="32" height="32" rx="7" fill="#080D11" />\n' +
            '  <path d="M9 10h14v3.2h-5.4V24h-3.2V13.2H9z" fill="url(#g)" />\n' +
            '</svg>\n',
        'client/public/robots.txt': 'User-agent: *\nAllow: /\n',
        'client/public/manifest.webmanifest':
            JSON.stringify(
                {
                    name: path.basename(name),
                    short_name: path.basename(name),
                    start_url: '/',
                    display: 'standalone',
                    background_color: '#080D11',
                    theme_color: '#080D11',
                    icons: [{ src: '/favicon.svg', type: 'image/svg+xml', sizes: 'any' }],
                },
                null,
                4,
            ) + '\n',
        'client/public/images/.gitkeep':
            '# Place images and other static assets here; served at /images/*.\n',
        'client/toil.tsx':
            "import { routes, layout, notFound, globalError, slots } from 'toiljs/routes';\n\n" +
            styleImportLines(features).join('\n') +
            '\n\n' +
            'Toil.mount(routes, layout, notFound, globalError, slots);\n',
        [`client/${styleEntry(features.preprocessor)}`]: DEFAULT_STYLE_CONTENT,
        'client/components/.gitkeep': '# Place shared React components here.\n',
        'client/layout.tsx': `import { type ReactNode } from 'react';

export default function Layout({ children }: { children?: ReactNode }) {
    return (
        <div style={{ maxWidth: 680, margin: '0 auto', padding: '3rem 1.5rem' }}>
            <header
                style={{
                    display: 'flex',
                    gap: '1rem',
                    alignItems: 'baseline',
                    borderBottom: '1px solid #1b2330',
                    paddingBottom: '0.75rem',
                    marginBottom: '1.5rem',
                }}>
                <strong style={{ color: '#2563FF', fontSize: '1.1rem' }}>${path.basename(name)}</strong>
                <nav style={{ display: 'flex', gap: '1rem' }}>
                    <Toil.Link href="/">home</Toil.Link>
                </nav>
            </header>
            {children}
        </div>
    );
}
`,
        'client/routes/index.tsx':
            'export default function Home() {\n' +
            '    return (\n        <main>\n' +
            '            <h1>Welcome to toiljs</h1>\n' +
            '            <p>File-based routing, bundled by Vite, zero config.</p>\n' +
            '        </main>\n    );\n}\n',
    };
    if (features.tailwind) files[`client/${TAILWIND_ENTRY}`] = TAILWIND_CSS;
    return files;
}

/**
 * Absolute path to the `app` starter client UI. There is a single source: `examples/basic/client`
 * (shipped in the package), the runnable example IS the create template, so there's nothing to
 * keep in sync.
 */
function appClientDir(): string {
    return path.resolve(
        path.dirname(fileURLToPath(import.meta.url)),
        '..',
        '..',
        'examples',
        'basic',
        'client',
    );
}

/** Absolute path to the `app` starter server (`examples/basic/server`), shipped in the package. */
function appServerDir(): string {
    return path.resolve(
        path.dirname(fileURLToPath(import.meta.url)),
        '..',
        '..',
        'examples',
        'basic',
        'server',
    );
}

/**
 * Applies the chosen styling to a copied template's client dir: renames the stylesheet to the
 * preprocessor's extension, adds the Tailwind entry, and rewrites `toil.tsx`'s style imports.
 */
async function applyStyling(clientDir: string, features: StyleFeatures): Promise<void> {
    // Plain CSS without Tailwind is exactly what the template ships, leave it byte-for-byte.
    if (features.preprocessor === 'css' && !features.tailwind) return;
    const entry = styleEntry(features.preprocessor);
    if (entry !== 'styles/main.css') {
        await fs.rename(path.join(clientDir, 'styles', 'main.css'), path.join(clientDir, entry));
    }
    if (features.tailwind) {
        await fs.writeFile(path.join(clientDir, TAILWIND_ENTRY), TAILWIND_CSS, 'utf8');
    }
    const toilPath = path.join(clientDir, 'toil.tsx');
    await fs.writeFile(
        toilPath,
        setStyleImports(await fs.readFile(toilPath, 'utf8'), features),
        'utf8',
    );
}

async function writeFiles(dir: string, files: Record<string, string>): Promise<void> {
    for (const [rel, contents] of Object.entries(files)) {
        const full = path.join(dir, rel);
        await fs.mkdir(path.dirname(full), { recursive: true });
        await fs.writeFile(full, contents, 'utf8');
    }
}

/** Runs the create flow (interactive unless `--yes`). */
export async function runCreate(opts: CreateOptions): Promise<void> {
    intro(accent(' toiljs create '));

    let name = opts.name;
    if (!name) {
        if (opts.yes) {
            name = 'my-toil-app';
        } else {
            const answer = await text({
                message: 'Project name',
                placeholder: 'my-toil-app',
                defaultValue: 'my-toil-app',
                validate: (v) => {
                    const result = isValidName(v || 'my-toil-app');
                    return result === true ? undefined : result;
                },
            });
            bail(answer);
            name = answer.trim() || 'my-toil-app';
        }
    }
    const valid = isValidName(name);
    if (valid !== true) {
        cancel(valid);
        process.exit(1);
    }

    const targetDir = resolveProjectDir(opts.cwd, name);
    if (targetDir === null) {
        cancel('Project name must stay inside the current directory (no "..", no absolute paths).');
        process.exit(1);
    }
    const rel = path.relative(opts.cwd, targetDir) || '.';

    if (!(await isEmptyDir(targetDir))) {
        if (opts.yes) {
            cancel(`Directory ${pc.cyan(rel)} is not empty.`);
            process.exit(1);
        }
        const proceed = await confirm({
            message: `Directory ${pc.cyan(rel)} is not empty. Scaffold into it anyway?`,
            initialValue: false,
        });
        bail(proceed);
        if (!proceed) {
            cancel('Scaffolding cancelled.');
            process.exit(0);
        }
    }

    let template: Template = opts.template ?? 'app';
    if (!opts.template && !opts.yes) {
        const templateOptions: TemplateOption[] = [
            {
                value: 'app',
                label: 'App',
                hint: 'the full ToilJS starter, landing page, layout, styles, demo routes',
            },
            { value: 'minimal', label: 'Minimal', hint: 'just a layout and a home route' },
        ];
        const choice = await select({
            message: 'Which template?',
            options: templateOptions,
            initialValue: 'app',
        });
        bail(choice);
        template = choice === 'minimal' ? 'minimal' : 'app';
    }

    let preprocessor: Preprocessor = opts.preprocessor ?? 'css';
    let tailwind = opts.tailwind ?? false;
    if (!opts.yes) {
        if (opts.preprocessor === undefined) {
            const choice = await select<Preprocessor>({
                message: 'Styling',
                options: PREPROCESSORS.map((value) => ({
                    value,
                    label: PREPROCESSOR_LABEL[value],
                })),
                initialValue: 'css',
            });
            bail(choice);
            preprocessor = choice;
        }
        if (opts.tailwind === undefined) {
            const tw = await confirm({ message: 'Add Tailwind CSS?', initialValue: false });
            bail(tw);
            tailwind = tw;
        }
    }
    const features: StyleFeatures = { preprocessor, tailwind };

    // AI assistant files: --ai = all, --no-ai = none, otherwise ask (default: all selected).
    let aiTools: string[] = opts.ai === false ? [] : [...AI_HELPER_IDS];
    if (opts.ai === undefined && !opts.yes) {
        const picked = await multiselect<string>({
            message: 'AI assistant files (read by Claude, Cursor, Codex, Copilot)',
            options: [
                ...AI_HELPERS.map((h) => ({ value: h.id, label: h.label })),
                { value: 'none', label: 'None' },
            ],
            initialValues: [...AI_HELPER_IDS],
            required: false,
        });
        bail(picked);
        // Selecting "None" (or deselecting everything) scaffolds no AI helper files.
        aiTools = picked.includes('none') ? [] : picked;
    }

    // Build-time image optimization: on by default (just press enter to keep it).
    let images = opts.images ?? true;
    if (opts.images === undefined && !opts.yes) {
        const im = await confirm({ message: 'Optimize images at build time?', initialValue: true });
        bail(im);
        images = im;
    }

    let initGit = opts.git ?? false;
    let install = opts.install ?? true;
    const pm = opts.pm ?? 'npm';
    if (!isPackageManager(pm)) {
        cancel(`Unsupported package manager: ${pm} (use npm, pnpm, yarn, or bun).`);
        process.exit(1);
    }
    if (!opts.yes) {
        if (opts.git === undefined) {
            const g = await confirm({
                message: 'Initialize a git repository?',
                initialValue: true,
            });
            bail(g);
            initGit = g;
        }
        if (opts.install === undefined) {
            const i = await confirm({ message: 'Install dependencies now?', initialValue: true });
            bail(i);
            install = i;
        }
    }

    const s = spinner();
    s.start('Scaffolding project');
    await writeFiles(targetDir, scaffold(name, template, features, aiTools, images));
    if (template === 'app') {
        // Copy the example client + server (the single starter source), set the <title>, then style.
        await fs.cp(appClientDir(), path.join(targetDir, 'client'), { recursive: true });
        // Only the canonical starter layout ships; anything else sitting in the example's
        // server/ (local experiments, scratch entries) stays out of scaffolded apps.
        const serverAllow = new Set([
            'main.ts',
            'README.md',
            'tsconfig.json',
            'toil-server-env.d.ts',
            'core',
            'models',
            'routes',
            'services',
            'scheduled',
        ]);
        const serverSrc = appServerDir();
        await fs.cp(serverSrc, path.join(targetDir, 'server'), {
            recursive: true,
            filter: (src) => {
                const rel = path.relative(serverSrc, src);
                if (rel === '') return true;
                return serverAllow.has(rel.split(path.sep)[0]);
            },
        });
        const indexHtml = path.join(targetDir, 'client', 'public', 'index.html');
        const html = await fs.readFile(indexHtml, 'utf8');
        await fs.writeFile(
            indexHtml,
            html.replace(/<title>[^<]*<\/title>/, `<title>${path.basename(name)}</title>`),
        );
        await applyStyling(path.join(targetDir, 'client'), features);
    }
    s.stop(`Scaffolded ${pc.cyan(rel)}`);

    if (initGit) {
        const g = spinner();
        g.start('Initializing git repository');
        try {
            await run('git', ['init', '-q'], targetDir);
            await run('git', ['add', '-A'], targetDir);
            g.stop('Initialized git repository');
        } catch {
            g.stop(pc.yellow('Skipped git init (git not available)'));
        }
    }

    if (install) {
        const i = spinner();
        i.start(`Installing dependencies with ${pm}`);
        try {
            await run(pm, ['install'], targetDir);
            i.stop('Installed dependencies');
        } catch {
            i.stop(pc.yellow(`Could not install with ${pm}, run it yourself later`));
            install = false;
        }
    }

    const steps: string[] = [];
    if (rel !== '.') steps.push(`cd ${rel}`);
    if (!install) steps.push('npm install');
    steps.push(`${accent('npm run dev')}   ${dim('start the dev server')}`);
    steps.push(`${accent('npm run build')} ${dim('build for production')}`);
    note(steps.map((l) => dim('  ') + l).join('\n'), 'Next steps');

    outro(`Created ${accent(path.basename(name))}, happy building! ${dim('(v' + version() + ')')}`);
}
