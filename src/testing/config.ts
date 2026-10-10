import path from 'node:path';
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { webdriverio } from '@vitest/browser-webdriverio';
import { defineConfig } from 'vitest/config';
import type { UserConfig } from 'vite';

/** Framework defaults for Node unit tests and real Chrome component tests. */
export interface TestConfigOptions {
    readonly root?: string;
    readonly headless?: boolean;
    readonly chromeArgs?: readonly string[];
    readonly unitInclude?: readonly string[];
    readonly browserInclude?: readonly string[];
}

/**
 * Creates independent unit and browser projects with React, client/shared aliases, toiljs
 * globals, and V8 coverage. Pass the result to Vitest's mergeConfig to extend any setting.
 */
export function defineTestConfig(options: TestConfigOptions = {}): UserConfig {
    const root: string = path.resolve(options.root ?? process.cwd());
    const browserBinary: string | undefined = process.env.TOIL_TEST_BROWSER_BINARY;
    const driverBinary: string | undefined = process.env.TOIL_TEST_CHROMEDRIVER;
    const setup: string = fileURLToPath(new URL('./setup.js', import.meta.url));
    return defineConfig({
        root,
        publicDir: path.join(root, 'client/public'),
        plugins: [react()],
        resolve: {
            alias: { client: path.join(root, 'client'), shared: path.join(root, 'shared') },
            dedupe: ['react', 'react-dom'],
        },
        test: {
            coverage: {
                provider: 'v8',
                reporter: ['text', 'html', 'json', 'lcov'],
                reportsDirectory: path.join(root, 'coverage'),
                include: ['client/**/*.{ts,tsx}', 'shared/**/*.{ts,tsx}'],
                exclude: ['**/*.d.ts', '**/*.{test,spec}.{ts,tsx}', 'shared/server.ts'],
            },
            projects: [
                {
                    extends: true,
                    test: {
                        name: 'unit',
                        environment: 'node',
                        include: [
                            ...(options.unitInclude ?? [
                                '{client,tests,test}/**/*.{test,spec}.{ts,tsx}',
                            ]),
                        ],
                        exclude: [
                            '**/*.browser.{test,spec}.{ts,tsx}',
                            '**/node_modules/**',
                            '**/build/**',
                        ],
                        setupFiles: [setup],
                    },
                },
                {
                    extends: true,
                    test: {
                        name: 'browser',
                        include: [
                            ...(options.browserInclude ?? [
                                '{client,tests,test}/**/*.browser.{test,spec}.{ts,tsx}',
                            ]),
                        ],
                        setupFiles: [setup],
                        browser: {
                            enabled: true,
                            headless: options.headless ?? true,
                            provider: webdriverio({
                                logLevel: 'error',
                                capabilities: {
                                    // Vitest's provider switches its test iframe with the Classic API.
                                    'wdio:enforceWebDriverClassic': true,
                                    ...(driverBinary
                                        ? { 'wdio:chromedriverOptions': { binary: driverBinary } }
                                        : {}),
                                    'goog:chromeOptions': {
                                        ...(browserBinary ? { binary: browserBinary } : {}),
                                        args: [...(options.chromeArgs ?? [])],
                                    },
                                },
                            }),
                            instances: [{ browser: 'chrome' }],
                        },
                    },
                },
            ],
        },
    });
}
