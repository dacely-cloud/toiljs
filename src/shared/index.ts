/**
 * Shared primitives used across every toiljs target (client, compiler, cli, server tooling).
 * Placeholder, real shared types/utilities land here.
 */

export const FRAMEWORK_NAME = 'toiljs';

export interface ToilTarget {
    readonly name: 'client' | 'compiler' | 'cli' | 'server';
}

/** SMTP connection config (non-secret) for the `smtp` / `gmail` providers. */
export interface SmtpBackendConfig {
    /** SMTP host. Empty + provider `gmail` defaults to `smtp.gmail.com`. */
    readonly host?: string;
    /** Submission port. `0`/unset defaults to 587 (STARTTLS); 465 = implicit TLS. */
    readonly port?: number;
    /** SMTP username. Defaults to `from`. */
    readonly user?: string;
}

/**
 * The **non-secret** email backend config — the typed `email` section of
 * `toil.config.ts` (`server.email`), consumed by the dev server and the future
 * Node self-host. The provider API key / SMTP password is a SECRET and is NEVER
 * here: it comes from `.env.secrets` (`TOIL_EMAIL_API_KEY`). Any `TOIL_EMAIL_*`
 * env var overrides the matching field here.
 *
 * Mirrors the edge's `TOIL_EMAIL_*` keys (toil-backend `host/email.rs`
 * `EmailSection`). Lives in `toiljs/shared` so both the compiler (config schema)
 * and the dev server (resolver) can reference it regardless of build order.
 */
export interface EmailBackendConfig {
    /** `"resend"` (JSON API) | `"gmail"` | `"smtp"` (SMTP). Default `"resend"`. */
    readonly provider?: 'resend' | 'gmail' | 'smtp';
    /** The "from" address. Validated (single address, no CRLF). */
    readonly from?: string;
    /** Per-process send ceiling, sends/minute (rolling). `0` = unlimited. Default 60. */
    readonly maxPerMin?: number;
    /** Per-process send ceiling, sends/day (rolling). `0` = unlimited. Default 0. */
    readonly maxPerDay?: number;
    /** Per-recipient hourly cap (anti-abuse). Default 5. */
    readonly maxPerRecipientPerHour?: number;
    /** SMTP connection details (the `gmail` / `smtp` providers). */
    readonly smtp?: SmtpBackendConfig;
}
