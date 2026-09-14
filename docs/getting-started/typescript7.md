# TypeScript 7 toolchain migration

The framework, CLI, client, Vite builds, and declaration output use TypeScript 7.0.2 or newer
within major 7. The WebAssembly backend remains the toilscript dialect and is checked by the
toilscript compiler during `toiljs build --server`.

## Existing applications

1. Upgrade toiljs and run `toiljs doctor --fix`. Reinstall dependencies after the manifest changes.
2. Replace `eslint.config.js` with `oxlint.config.ts` importing the default from `toiljs/oxlint`.
3. Install `oxlint` and `oxlint-tsgolint`; set the lint script to `oxlint --type-aware client`.
4. Run `npm run build`, `npm run typecheck`, `npm run lint`, and `toiljs doctor`.

The new preset retains the former effective ESLint rules and severities. Native Oxlint handles
syntax checks and Fast Refresh. `oxlint-tsgolint` handles the strict semantic rules. React
Compiler checks use the React Hooks JavaScript plugin inside Oxlint, and the padding rule uses
the Stylistic plugin. Their ESLint peer dependency is a plugin dependency; no ESLint runner or
TypeScript ESLint parser is used.

The custom `toiljs/no-uint8array-tostring` rule queries the TypeScript 7 native checker through
its synchronous API. It follows aliases, unions, intersections, generic constraints and base
classes, and permits deliberate `toString()` overrides. It uses the current lint input, including
editor buffers. It does not infer byte types from variable names or annotations alone.

## Additional project rules

Move project overrides into the Oxlint configuration. Use `typescript/` for the native TypeScript
rules, `react/only-export-components` for Fast Refresh, and `react-hooks-js/` for the React Hooks
plugin. The custom byte-array rule is `toiljs/no-uint8array-tostring`; the padding rule is
`style/padding-line-between-statements`. Keep `options.typeAware: true` or pass `--type-aware`.

```ts
import toiljs from 'toiljs/oxlint';
import { defineConfig } from 'oxlint';

export default defineConfig({
    ...toiljs,
    options: { ...toiljs.options, typeAware: true },
    rules: {
        ...toiljs.rules,
        'typescript/no-floating-promises': 'error',
    },
});
```

TypeScript ESLint parser services are not available to Oxlint JavaScript plugins. Custom semantic
plugins must use the native TypeScript API, as the bundled byte-array rule does. Doctor reports
incomplete lint migration; it does not overwrite a custom ESLint configuration.

## Editor and compiler configuration

Enable the TypeScript native language server (`js/ts.experimental.useTsgo`) and install the
Oxlint editor extension. Remove legacy `typescript.tsdk` settings and JavaScript language-service
plugins. The native language server does not run toilscript's old `ts-plugin.cjs`; use the
WebAssembly build for server dialect diagnostics.

Remove compiler options deleted in TypeScript 7, including `baseUrl`. When removing `baseUrl`,
rewrite relative `paths` targets relative to the tsconfig file so resolution stays the same.
Doctor uses the native compiler to check inherited compiler options, including removed options.
Run `tsc --noEmit` to check the application types too.
The shipped client preset already uses bundler module resolution and explicit relative paths.

## Generated clients and metadata

The build preserves `ArrayBuffer` ownership in the generated RPC fetch helper. Regenerate
`shared/server.ts` with `toiljs build`; do not edit it manually. Metadata parsing supports literal
objects and arrays, `as const`, `satisfies`, and nested literal values without executing routes.
Parse errors fail the build rather than silently dropping SEO tags.

## Framework API documentation

`npm run docs` builds the framework and writes HTML reference pages and `api.json` to
`build/docs/`, using the TypeScript 7 native checker. The hand-written guides under `docs/`
remain the source for generated application documentation. TypeDoc and API Extractor are no
longer dependencies of the framework toolchain.
