# Testing and coverage

Every new toiljs project includes Vitest 5, real Chrome tests through WebdriverIO,
and V8 coverage. The `app`, `minimal`, and `agent` templates install the tooling
alongside the other development dependencies. Tests run without starting or building
any backend.

## Run the starter examples

```bash
npm test                 # Node unit tests
npm run test:watch        # Watch unit tests
npm run test:browser      # Real Chrome component tests
npm run test:all          # Unit and browser projects together
npm run test:coverage     # Both projects with coverage
```

The starter includes `client/lib/Greeting.ts` and `tests/Greeting.test.ts`:

```ts
import { expect, test } from 'vitest';
import { Greeting } from '../client/lib/Greeting';

test('trims the supplied name', (): void => {
    expect(Greeting.message('  Ada  ')).toBe('Hello, Ada!');
});
```

`tests/TestCounter.browser.test.tsx` renders a React component, clicks its button
with `page` from `vitest/browser`, and checks that its count changes. It also uses
`Toil.Link`, so the example verifies framework globals in a real browser.

## Configuration and globals

The generated `vitest.config.ts` uses the framework preset:

```ts
import { defineTestConfig } from 'toiljs/vitest';

export default defineTestConfig();
```

The preset installs the React Vite plugin, `client` and `shared` aliases, and two
independent projects:

| Project | Files | Runtime |
| --- | --- | --- |
| `unit` | `*.test.ts`, `*.test.tsx`, `*.spec.ts`, `*.spec.tsx` under `client/`, `tests/`, or `test/`, excluding browser files | Node |
| `browser` | `*.browser.test.ts`, `*.browser.test.tsx`, `*.browser.spec.ts`, `*.browser.spec.tsx` under those folders | Chrome, headless by default |

The setup registers `Toil`, `Server`, `FastMap`, `FastSet`, `DataWriter`, `DataReader`,
and `parseError`. It does not mount the app or launch a server. Mock typed backend
calls with Vitest mocks or `vi.stubGlobal('Server', yourTypedMock)` when a component
needs data. AssemblyScript backend code requires separate WebAssembly integration
tests; this preset covers JavaScript and React code.

Pass `root`, `headless`, `chromeArgs`, `unitInclude`, or `browserInclude` to
`defineTestConfig` to change its defaults. Use `mergeConfig` from `vitest/config`
for other settings, such as coverage thresholds or additional aliases. A custom
configuration can import `toiljs/vitest/setup` as a setup file to register globals.

WebdriverIO discovers Chrome and manages ChromeDriver automatically. To use specific
binaries, set `TOIL_TEST_BROWSER_BINARY` and `TOIL_TEST_CHROMEDRIVER` independently.
Browser tests need Chrome and its OS libraries installed; downloads need network
access on the first run. A Linux container running as root may need explicit
`chromeArgs: ['--no-sandbox']` in its test config.

## Coverage reports

`npm run test:coverage` produces terminal, HTML, JSON, and LCOV reports under
`coverage/`. Open `coverage/index.html` for the HTML report. Client and shared
TypeScript files are included, with declarations, tests, and generated
`shared/server.ts` excluded. The `coverage/` directory is gitignored.

```bash
npx toiljs test --coverage                     # Unit coverage only
npx toiljs test --browser --coverage           # Browser coverage only
npx toiljs test --all --coverage --coverage.thresholds.lines=80
```

## Existing projects

After updating toiljs, run `npx toiljs test`. It adds missing test scripts and installs
missing Vitest, WebdriverIO, and coverage packages using your project's package
manager. If no Vitest or Vite config exists, it also writes the preset and examples,
preserving any files already at those paths. Existing custom configs and scripts
are preserved. Keep Vitest and `@vitest/coverage-v8` on matching versions; the native
preset requires Vitest 5.

Other Vitest options and file filters pass through:

```bash
npx toiljs test Greeting
npx toiljs test --browser TestCounter
npx toiljs test --all --reporter=verbose
npx toiljs test --root ./apps/dashboard --watch
```

With the native preset, `toiljs test` selects `unit`, `--browser` selects `browser`,
and `--all` runs both. An explicit `--project` selects your requested project.
A custom configuration keeps its own project selection; `--browser` is forwarded
to Vitest. Failed tests return a nonzero exit status for CI.
