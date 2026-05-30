/**
 * Minimal logger placeholder for toiljs. Swapped for the real implementation later.
 */

export enum LogLevel {
    Debug = 'debug',
    Info = 'info',
    Warn = 'warn',
    Error = 'error',
}

export class Logger {
    public constructor(private readonly scope: string = 'toil') {}

    public log(level: LogLevel, message: string): void {
        console.log(`[${this.scope}] ${level}: ${message}`);
    }

    public info(message: string): void {
        this.log(LogLevel.Info, message);
    }
}
