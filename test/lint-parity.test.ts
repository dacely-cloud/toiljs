import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import rootConfig from '../oxlint.config';
import preset from '../presets/oxlint';

/** Snapshots are the effective configurations before the migration, including inherited presets. */
const aliases: Record<string, string> = {
    'no-octal': 'toiljs/no-octal',
    '@typescript-eslint/no-array-constructor': 'eslint/no-array-constructor',
    '@typescript-eslint/no-unused-expressions': 'eslint/no-unused-expressions',
    '@typescript-eslint/no-useless-constructor': 'eslint/no-useless-constructor',
    'react-refresh/only-export-components': 'react/only-export-components',
    'custom/no-uint8array-tostring': 'toiljs/no-uint8array-tostring',
    'padding-line-between-statements': 'style/padding-line-between-statements',
};
function translated(name: string): string {
    return (
        aliases[name] ??
        (name.startsWith('@typescript-eslint/')
            ? name.replace('@typescript-eslint/', 'typescript/')
            : name.startsWith('react-hooks/')
              ? name.replace('react-hooks/', 'react-hooks-js/')
              : name.includes('/')
                ? name
                : `eslint/${name}`)
    );
}

describe('ESLint rule parity', () => {
    for (const [name, config] of [
        ['root', rootConfig],
        ['preset', preset],
    ] as const) {
        it(`preserves every enabled ${name} rule, severity and option`, () => {
            const previous = JSON.parse(
                fs.readFileSync(
                    path.join(import.meta.dirname, `fixtures/${name}-eslint-rules.json`),
                    'utf8',
                ),
            ) as Record<string, unknown>;
            for (const [rule, setting] of Object.entries(previous)) {
                if (setting === 'off') continue;
                expect(config.rules?.[translated(rule)], rule).toEqual(setting);
            }
            expect(config.categories?.correctness).toBe('off');
            expect(config.options?.typeAware).toBe(true);
        });
    }
});
