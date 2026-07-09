import { describe, expect, it } from 'vitest';

import { buildRows, classifyBump, parseNcuJson, withheldUpgrades } from '../src/cli/updates';

describe('classifyBump', () => {
    it('classifies major / minor / patch from ranges', () => {
        expect(classifyBump('^19.2.6', '^20.0.0')).toBe('major');
        expect(classifyBump('^19.2.6', '^19.3.0')).toBe('minor');
        expect(classifyBump('^19.2.6', '^19.2.7')).toBe('patch');
        expect(classifyBump('1.2.3', '1.2.3')).toBe('other');
    });
});

describe('parseNcuJson', () => {
    it('parses the jsonUpgraded object, tolerating surrounding noise', () => {
        expect(parseNcuJson('{"react":"^19.3.0","eslint":"^10.4.1"}')).toEqual({
            react: '^19.3.0',
            eslint: '^10.4.1',
        });
        expect(parseNcuJson('npx noise\n{"a":"1.0.0"}\nbye')).toEqual({ a: '1.0.0' });
        expect(parseNcuJson('{}')).toEqual({});
        expect(parseNcuJson('not json')).toEqual({});
    });
});

describe('buildRows', () => {
    it('joins ncu output with current ranges and sorts major-first then by name', () => {
        const rows = buildRows(
            { react: '^20.0.0', eslint: '^10.4.1', vite: '^8.0.15' },
            { react: '^19.2.6', eslint: '^10.2.0', vite: '^8.0.14' },
        );
        expect(rows.map((r) => `${r.name}:${r.bump}`)).toEqual([
            'react:major',
            'eslint:minor',
            'vite:patch',
        ]);
        expect(rows[0]).toMatchObject({ name: 'react', from: '^19.2.6', to: '^20.0.0' });
    });

    it('marks a package missing from current deps with a "?" source', () => {
        const rows = buildRows({ foo: '^2.0.0' }, {});
        expect(rows[0]).toMatchObject({ name: 'foo', from: '?', to: '^2.0.0', bump: 'major' });
    });
});

describe('withheldUpgrades', () => {
    it('withholds an upgrade into typescript 7 (the native port has no compiler API)', () => {
        expect(withheldUpgrades({ typescript: '^7.0.2', react: '^20.0.0' })).toEqual(['typescript']);
    });

    it('still offers typescript bumps inside the supported major', () => {
        expect(withheldUpgrades({ typescript: '^6.1.0' })).toEqual([]);
    });

    it('ignores packages with no declared ceiling', () => {
        expect(withheldUpgrades({ vite: '^9.0.0', eslint: '^11.0.0' })).toEqual([]);
    });
});
