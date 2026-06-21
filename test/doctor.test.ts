import { describe, expect, it } from 'vitest';

import {
    checkAuthSecrets,
    checkBasePath,
    checkDevScripts,
    checkDuplicatePatterns,
    type CheckGroup,
    checkMigrationsDir,
    checkMountSlots,
    checkNode,
    checkPeer,
    checkPrettierPlugin,
    checkRelativeAssets,
    checkRestDispatch,
    checkRootElement,
    checkRpcWiring,
    checkSeoUrl,
    checkServerTsPlugin,
    checkStyling,
    findRelativeAssets,
    satisfiesMin,
    summarize,
} from '../src/cli/diagnostics';

describe('satisfiesMin', () => {
    it('compares against a >= minimum, ignoring range prefixes', () => {
        expect(satisfiesMin('25.8.0', '>=24.0.0')).toBe(true);
        expect(satisfiesMin('20.0.0', '>=24.0.0')).toBe(false);
        expect(satisfiesMin('^19.2.6', '>=18.0.0')).toBe(true); // declared caret range, compared by floor
        expect(satisfiesMin('6.0.0', '>=6.0.0')).toBe(true);
        expect(satisfiesMin('5.9.9', '>=6.0.0')).toBe(false);
    });
});

describe('checkMountSlots', () => {
    it('warns when mount() omits slots, passes when present', () => {
        expect(checkMountSlots('Toil.mount(routes, layout, notFound, globalError);').status).toBe(
            'warn',
        );
        expect(
            checkMountSlots('Toil.mount(routes, layout, notFound, globalError, slots);').status,
        ).toBe('pass');
    });

    it('warns when there is no entry or no mount() call', () => {
        expect(checkMountSlots(null).status).toBe('warn');
        expect(checkMountSlots('export const x = 1;').status).toBe('warn');
    });
});

describe('findRelativeAssets / checkRelativeAssets', () => {
    it('flags root-relative asset paths but not absolute, url, or expression refs', () => {
        const issues = findRelativeAssets([
            {
                path: 'client/components/Header.tsx',
                source: [
                    '<img src="images/logo.svg" />', // broken: relative asset
                    '<img src="/images/logo.svg" />', // ok: root-absolute
                    '<img src="https://cdn/x.png" />', // ok: url
                    '<img src={logo} />', // ok: expression (not a string literal)
                    '<a href="/about">about</a>', // ok: no extension, route
                ].join('\n'),
            },
        ]);
        expect(issues).toHaveLength(1);
        expect(issues[0]).toMatchObject({ line: 1, value: 'images/logo.svg' });
        expect(checkRelativeAssets(issues).status).toBe('warn');
        expect(checkRelativeAssets([]).status).toBe('pass');
    });
});

describe('config + environment checks', () => {
    it('checkBasePath: root or wrapped in slashes passes, otherwise warns', () => {
        expect(checkBasePath('/').status).toBe('pass');
        expect(checkBasePath('/app/').status).toBe('pass');
        expect(checkBasePath('/app').status).toBe('warn');
    });

    it('checkSeoUrl: warns only when seo is configured without a url', () => {
        expect(checkSeoUrl(false, false).status).toBe('pass');
        expect(checkSeoUrl(true, true).status).toBe('pass');
        expect(checkSeoUrl(true, false).status).toBe('warn');
    });

    it('checkNode / checkPeer reflect version satisfaction', () => {
        expect(checkNode('25.0.0', '>=24.0.0').status).toBe('pass');
        expect(checkNode('18.0.0', '>=24.0.0').status).toBe('fail');
        expect(checkPeer('react', null, '>=18.0.0').status).toBe('fail');
        expect(checkPeer('react', '^17.0.0', '>=18.0.0').status).toBe('warn');
        expect(checkPeer('react', '^19.0.0', '>=18.0.0').status).toBe('pass');
    });

    it('checkDuplicatePatterns flags repeated route URLs', () => {
        expect(checkDuplicatePatterns(['/', '/about', '/blog/:id']).status).toBe('pass');
        expect(checkDuplicatePatterns(['/a', '/a']).status).toBe('warn');
    });

    it('checkRootElement requires an id="root" mount target', () => {
        expect(checkRootElement('<div id="root"></div>').status).toBe('pass');
        expect(checkRootElement('<div id="app"></div>').status).toBe('fail');
        expect(checkRootElement(null).status).toBe('fail');
    });

    it('checkStyling fails when an imported preprocessor/Tailwind is not installed', () => {
        expect(
            checkStyling({
                preprocessorImported: 'sass',
                preprocessorInstalled: false,
                tailwindImported: false,
                tailwindInstalled: false,
            }).status,
        ).toBe('fail');
        expect(
            checkStyling({
                preprocessorImported: 'sass',
                preprocessorInstalled: true,
                tailwindImported: true,
                tailwindInstalled: false,
            }).status,
        ).toBe('fail');
        expect(
            checkStyling({
                preprocessorImported: 'css',
                preprocessorInstalled: true,
                tailwindImported: false,
                tailwindInstalled: false,
            }).status,
        ).toBe('pass');
    });
});

describe('checkRpcWiring', () => {
    const wired = {
        buildServerWired: true,
        tsconfigWired: true,
        gitignoreWired: true,
        toilscriptOk: true,
    };

    it('passes when fully wired', () => {
        expect(checkRpcWiring(wired).status).toBe('pass');
    });

    it('warns and lists every missing piece', () => {
        const c = checkRpcWiring({
            buildServerWired: false,
            tsconfigWired: false,
            gitignoreWired: false,
            toilscriptOk: false,
        });
        expect(c.status).toBe('warn');
        expect(c.detail).toContain('toilscript');
        expect(c.detail).toContain('--rpcModule');
        expect(c.detail).toContain('tsconfig');
        expect(c.detail).toContain('.gitignore');
        expect(c.fix).toContain('--fix');
    });

    it('warns on a single missing piece', () => {
        const c = checkRpcWiring({ ...wired, gitignoreWired: false });
        expect(c.status).toBe('warn');
        expect(c.detail).toContain('.gitignore');
    });
});

describe('checkRestDispatch', () => {
    it('passes when there are no @rest controllers', () => {
        expect(checkRestDispatch({ hasControllers: false, dispatched: false }).status).toBe('pass');
    });

    it('passes when controllers are dispatched', () => {
        expect(checkRestDispatch({ hasControllers: true, dispatched: true }).status).toBe('pass');
    });

    it('warns when controllers exist but nothing dispatches them', () => {
        const c = checkRestDispatch({ hasControllers: true, dispatched: false });
        expect(c.status).toBe('warn');
        expect(c.detail).toContain('Rest.dispatch');
        expect(c.fix).toContain('RestHandler');
    });
});

describe('checkPrettierPlugin', () => {
    it('passes when present', () => {
        expect(checkPrettierPlugin(true).status).toBe('pass');
    });
    it('warns (not fails) when missing, pointing at --fix', () => {
        const c = checkPrettierPlugin(false);
        expect(c.status).toBe('warn');
        expect(c.fix).toContain('--fix');
    });
});

describe('checkServerTsPlugin', () => {
    it('passes when the toilscript LS plugin is wired', () => {
        expect(checkServerTsPlugin(true).status).toBe('pass');
    });
    it('warns (not fails) when missing, naming the TS2339 false positive and --fix', () => {
        const c = checkServerTsPlugin(false);
        expect(c.status).toBe('warn');
        expect(c.detail).toContain('TS2339');
        expect(c.fix).toContain('--fix');
    });
});

describe('checkAuthSecrets', () => {
    it('passes when auth is not used', () => {
        expect(checkAuthSecrets({ usesAuth: false, sessionSecretSet: false }).status).toBe('pass');
    });
    it('passes when auth is used and the session secret is set', () => {
        expect(checkAuthSecrets({ usesAuth: true, sessionSecretSet: true }).status).toBe('pass');
    });
    it('warns about session forgery when auth is used but the secret is unset', () => {
        const c = checkAuthSecrets({ usesAuth: true, sessionSecretSet: false });
        expect(c.status).toBe('warn');
        expect(c.detail).toContain('AUTH_SESSION_SECRET');
        expect(c.detail).toContain('forge');
        expect(c.fix).toContain('.env.secrets');
    });
});

describe('checkMigrationsDir', () => {
    it('passes when the server/migrations/ folder exists', () => {
        expect(checkMigrationsDir(true).status).toBe('pass');
    });
    it('warns (not fails) when missing, naming the convention and the update fix', () => {
        const c = checkMigrationsDir(false);
        expect(c.status).toBe('warn');
        expect(c.detail).toContain('migration.ts');
        expect(c.fix).toContain('toiljs update');
    });
});

describe('summarize', () => {
    it('tallies pass/warn/fail across groups', () => {
        const groups: CheckGroup[] = [
            {
                title: 'A',
                checks: [
                    { id: '1', label: 'x', status: 'pass' },
                    { id: '2', label: 'y', status: 'warn' },
                ],
            },
            { title: 'B', checks: [{ id: '3', label: 'z', status: 'fail' }] },
        ];
        expect(summarize(groups)).toEqual({ pass: 1, warn: 1, fail: 1 });
    });
});

describe('checkDevScripts', () => {
    it('passes when no script wraps toiljs in npx', () => {
        const c = checkDevScripts({ dev: 'toiljs dev', build: 'toiljs build' });
        expect(c.status).toBe('pass');
    });

    it('warns and names the offending scripts using npx toiljs', () => {
        const c = checkDevScripts({ dev: 'npx toiljs dev', build: 'toiljs build' });
        expect(c.status).toBe('warn');
        expect(c.detail).toContain('dev');
        expect(c.detail).not.toContain('build');
        expect(c.fix).toMatch(/toiljs <cmd>/);
    });

    it('does not flag unrelated npx usage or substrings', () => {
        expect(checkDevScripts({ x: 'npx create-toiljs my-app' }).status).toBe('pass');
        expect(checkDevScripts({ x: 'echo npxtoiljs' }).status).toBe('pass');
        expect(checkDevScripts({}).status).toBe('pass');
    });
});
