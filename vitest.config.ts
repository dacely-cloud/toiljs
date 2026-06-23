import react from '@vitejs/plugin-react';
import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
    plugins: [react()],
    test: {
        globals: true,
        environment: 'node',
        // Generate src/compiler/toil-docs.generated.ts (gitignored, imported by
        // docs.ts) before the suite, so a fresh checkout can test without a build.
        globalSetup: ['./test/global-setup.ts'],
        include: ['test/**/*.test.ts', 'test/**/*.test.tsx', 'test/**/*.spec.ts'],
        // test/assembly holds toilscript specs run by as-pect, not vitest.
        exclude: [...configDefaults.exclude, 'test/assembly/**'],
        coverage: {
            provider: 'v8',
            reporter: ['text', 'json', 'html'],
            exclude: [
                'node_modules/',
                'build/',
                'browser/',
                'test/',
                '**/*.d.ts',
                '**/*.config.*',
                '**/mockData',
            ],
        },
    },
});
