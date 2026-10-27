export enum LogLevel {
    Debug = 'debug',
    Info = 'info',
    Warn = 'warn',
    Error = 'error',
}

export interface LoggerOptions {
    /** Defaults to enabled outside production (`NODE_ENV=production`). */
    readonly enabled?: boolean;
}

/** Node/SSR logger. Pass values directly to preserve objects, errors, and console formatting. */
export class Logger {
    public constructor(
        private readonly scope: string = 'toil',
        private readonly options: LoggerOptions = {},
    ) {}

    public log(level: LogLevel, ...values: unknown[]): void {
        const production = typeof process !== 'undefined' && process.env.NODE_ENV === 'production';
        if (!(this.options.enabled ?? !production)) return;
        const prefix = `[${this.scope}] ${level}:`;
        const [first, ...rest] = values;
        if (typeof first === 'string') console[level](`${prefix} ${first}`, ...rest);
        else console[level](prefix, ...values);
    }

    public debug(...values: unknown[]): void {
        this.log(LogLevel.Debug, ...values);
    }

    public info(...values: unknown[]): void {
        this.log(LogLevel.Info, ...values);
    }

    public warn(...values: unknown[]): void {
        this.log(LogLevel.Warn, ...values);
    }

    public error(...values: unknown[]): void {
        this.log(LogLevel.Error, ...values);
    }
}
