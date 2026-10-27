import { afterEach, describe, expect, it, vi } from 'vitest';
import { Logger, LogLevel } from '../src/logger/index.js';

afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
});

describe('Node/SSR Logger', () => {
    it('prints every level and preserves arbitrary values in dev', () => {
        vi.stubEnv('NODE_ENV', 'development');
        const circular: { self?: unknown } = {};
        circular.self = circular;
        const error = new Error('failed');
        const logger = new Logger('app');
        for (const level of Object.values(LogLevel)) {
            const output = vi.spyOn(console, level).mockImplementation(() => {});
            logger[level]('message', circular, error, 42n, null, undefined);
            expect(output).toHaveBeenCalledWith(
                `[app] ${level}: message`,
                circular,
                error,
                42n,
                null,
                undefined,
            );
        }
    });

    it('defaults to quiet in production and supports explicit opt-in', () => {
        vi.stubEnv('NODE_ENV', 'production');
        const output = vi.spyOn(console, 'info').mockImplementation(() => {});
        new Logger().info('hidden');
        expect(output).not.toHaveBeenCalled();
        new Logger('app', { enabled: true }).info({ answer: 42 });
        expect(output).toHaveBeenCalledWith('[app] info:', { answer: 42 });
    });

    it('supports disabling logs in dev, including direct log calls', () => {
        vi.stubEnv('NODE_ENV', 'development');
        const output = vi.spyOn(console, 'error').mockImplementation(() => {});
        new Logger('app', { enabled: false }).log(LogLevel.Error, 'hidden');
        expect(output).not.toHaveBeenCalled();
    });

    it('preserves console format placeholders', () => {
        vi.stubEnv('NODE_ENV', 'development');
        const output = vi.spyOn(console, 'info').mockImplementation(() => {});
        new Logger('app').info('count: %d', 42);
        expect(output).toHaveBeenCalledWith('[app] info: count: %d', 42);
    });
});
