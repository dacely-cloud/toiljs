/** toiljs shared ESLint flat config: `import toiljs from 'toiljs/eslint'; export default toiljs;` */
import eslintReact from '@eslint-react/eslint-plugin';
import eslint from '@eslint/js';
import reactHooks from 'eslint-plugin-react-hooks';
import reactRefresh from 'eslint-plugin-react-refresh';
import tseslint from 'typescript-eslint';

import noUint8ArrayToString from './no-uint8array-tostring.js';

export default tseslint.config(
    { ignores: ['dist', 'build', '.toil', 'node_modules', 'toil-env.d.ts', 'server/**'] },
    {
        extends: [
            eslint.configs.recommended,
            ...tseslint.configs.recommended,
            ...tseslint.configs.strictTypeChecked,
        ],
        files: ['**/*.{ts,tsx}'],
        languageOptions: {
            ecmaVersion: 2023,
            parserOptions: {
                projectService: true,
            },
        },
        plugins: {
            'react-hooks': reactHooks,
            'react-refresh': reactRefresh,
            '@eslint-react': eslintReact,
            custom: noUint8ArrayToString,
        },
        rules: {
            ...reactHooks.configs.recommended.rules,
            // Route files conventionally export `loader` / `revalidate` / `metadata` /
            // `generateMetadata` / `searchHints` alongside the default component; the toil compiler
            // consumes them at runtime/build. Allow them (plus primitive constants) so Fast Refresh
            // doesn't flag the pattern.
            'react-refresh/only-export-components': [
                'warn',
                {
                    allowConstantExport: true,
                    allowExportNames: [
                        'loader',
                        'revalidate',
                        'metadata',
                        'generateMetadata',
                        'searchHints',
                    ],
                },
            ],
            'no-undef': 'off',
            '@typescript-eslint/no-unused-vars': 'off',
            'no-empty': 'off',
            '@typescript-eslint/restrict-template-expressions': 'off',
            '@typescript-eslint/only-throw-error': 'off',
            '@typescript-eslint/no-unnecessary-condition': 'off',
            '@typescript-eslint/unbound-method': 'warn',
            '@typescript-eslint/no-confusing-void-expression': 'off',
            '@typescript-eslint/no-extraneous-class': 'off',
            'no-async-promise-executor': 'off',
            '@typescript-eslint/no-misused-promises': 'off',
            '@typescript-eslint/no-unnecessary-type-parameters': 'off',
            '@typescript-eslint/no-duplicate-enum-values': 'off',
            'prefer-spread': 'off',
            '@typescript-eslint/no-empty-object-type': 'off',
            '@typescript-eslint/no-floating-promises': 'off',
            '@typescript-eslint/ban-ts-comment': 'off',
            'no-constant-binary-expression': 'off',
            'no-useless-assignment': 'off',
            '@typescript-eslint/no-unsafe-assignment': 'off',
            '@typescript-eslint/no-unsafe-call': 'off',
            '@typescript-eslint/no-unsafe-member-access': 'off',
            '@typescript-eslint/no-unsafe-argument': 'off',
            '@typescript-eslint/no-unnecessary-type-conversion': 'warn',
            'react-hooks/set-state-in-effect': 'warn',
            'custom/no-uint8array-tostring': 'error',
            'padding-line-between-statements': [
                'error',
                { blankLine: 'always', prev: 'block-like', next: '*' },
            ],
            '@typescript-eslint/no-deprecated': 'off',
            '@typescript-eslint/no-unnecessary-type-arguments': 'off',
        },
    },
    {
        files: ['**/*.js'],
        ...tseslint.configs.disableTypeChecked,
    },
);
