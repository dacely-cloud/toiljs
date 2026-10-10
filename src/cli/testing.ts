/** Shared testing dependencies, scripts, and examples for every project template and legacy setup. */
export const TEST_DEPENDENCIES: Readonly<Record<string, string>> = {
    vitest: '^5.0.3',
    '@vitest/browser-webdriverio': '^5.0.0',
    '@vitest/coverage-v8': '^5.0.3',
    webdriverio: '^10.0.2',
};

/** The default test command runs unit tests; real-browser and combined runs have explicit scripts. */
export const TEST_SCRIPTS: Readonly<Record<string, string>> = {
    test: 'toiljs test',
    'test:watch': 'toiljs test --watch',
    'test:browser': 'toiljs test --browser',
    'test:all': 'toiljs test --all',
    'test:coverage': 'toiljs test --all --coverage',
};

/** A useful pure unit example and an interactive React example, independent of server availability. */
export function testingFiles(): Readonly<Record<string, string>> {
    return {
        'vitest.config.ts':
            "import { defineTestConfig } from 'toiljs/vitest';\n\nexport default defineTestConfig();\n",
        'client/lib/Greeting.ts': [
            '/** Formats a greeting, treating blank input as an unnamed guest. */',
            'export class Greeting {',
            '    public static message(name: string): string {',
            "        const recipient: string = name.trim() || 'guest';",
            '        return `Hello, ${recipient}!`;',
            '    }',
            '}',
            '',
        ].join('\n'),
        'tests/Greeting.test.ts': [
            "import { expect, test } from 'vitest';",
            "import { Greeting } from '../client/lib/Greeting';",
            '',
            "test('trims the supplied name', (): void => {",
            "    expect(Greeting.message('  Ada  ')).toBe('Hello, Ada!');",
            '});',
            '',
            "test('greets an unnamed guest', (): void => {",
            "    expect(Greeting.message('   ')).toBe('Hello, guest!');",
            '});',
            '',
        ].join('\n'),
        'client/components/TestCounter.tsx': [
            "import { useState, type ReactElement } from 'react';",
            '',
            '/** A small component used by the starter browser test. */',
            'export function TestCounter(): ReactElement {',
            '    const [count, setCount] = useState<number>(0);',
            '    return (',
            '        <section>',
            '            <Toil.Link href="/">Home</Toil.Link>',
            '            <button onClick={(): void => setCount(count + 1)}>Count: {count}</button>',
            '        </section>',
            '    );',
            '}',
            '',
        ].join('\n'),
        'tests/TestCounter.browser.test.tsx': [
            "import { afterEach, expect, test } from 'vitest';",
            "import { page } from 'vitest/browser';",
            "import { createRoot, type Root } from 'react-dom/client';",
            "import { TestCounter } from '../client/components/TestCounter';",
            '',
            'let root: Root | null = null;',
            'afterEach((): void => {',
            '    root?.unmount();',
            '    root = null;',
            '    document.body.replaceChildren();',
            '});',
            '',
            "test('increments when clicked in a real browser', async (): Promise<void> => {",
            "    const host: HTMLDivElement = document.createElement('div');",
            '    document.body.append(host);',
            '    root = createRoot(host);',
            '    root.render(<TestCounter />);',
            "    await expect.element(page.getByRole('link', { name: 'Home' })).toHaveAttribute('href', '/');",
            "    await page.getByRole('button', { name: 'Count: 0' }).click();",
            "    await expect.element(page.getByRole('button', { name: 'Count: 1' })).toBeVisible();",
            '});',
            '',
        ].join('\n'),
    };
}
