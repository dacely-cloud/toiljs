/**
 * Resolve the dev / self-host email config: merge the typed `toil.config.ts`
 * `email` section (non-secret) with the reserved `TOIL_EMAIL_*` env keys (which
 * WIN, for edge parity + 12-factor), and pull the API key from
 * `TOIL_EMAIL_API_KEY` (a secret, only ever in `.env.secrets`/the environment).
 *
 * Mirrors the edge's `host/email.rs` (`EmailSection::from_reserved` + `resolve`):
 * provider parse, `from` validation, Gmail/SMTP defaults. Returns a `null`
 * config when email is simply not set up (silent), or a `warning` when it is
 * partially configured but invalid (logged at startup, treated as Disabled).
 */
import type { EmailBackendConfig } from 'toiljs/shared';

import { validFrom } from './validate.js';

export type ResolvedProvider = 'resend' | 'smtp';

export interface ResolvedSmtp {
    readonly host: string;
    readonly port: number;
    readonly user: string;
}

export interface ResolvedEmailConfig {
    readonly provider: ResolvedProvider;
    readonly from: string;
    readonly apiKey: string;
    readonly maxPerMin: number;
    readonly maxPerDay: number;
    readonly maxPerRecipientPerHour: number;
    /** Present iff `provider === 'smtp'`. */
    readonly smtp?: ResolvedSmtp;
}

export interface ResolveResult {
    /** The resolved config, or `null` when email is unconfigured / invalid. */
    readonly config: ResolvedEmailConfig | null;
    /** A reason email is off despite partial config (logged at startup). */
    readonly warning: string | null;
}

/** `TOIL_EMAIL_<NAME>` from the reserved map, trimmed; `undefined` if absent/empty. */
function envOf(reserved: Map<string, string>, name: string): string | undefined {
    const v = reserved.get(`TOIL_EMAIL_${name}`);
    const t = v?.trim();
    return t ? t : undefined;
}

function parseBool(v: string | undefined): boolean | undefined {
    if (v === undefined) return undefined;
    return v === '1' || v === 'true' || v === 'yes' || v === 'on';
}

function parseInt0(v: string | undefined, fallback: number): number {
    if (v === undefined) return fallback;
    const n = Number.parseInt(v, 10);
    return Number.isFinite(n) && n >= 0 ? n : fallback;
}

export function resolveEmailConfig(
    cfg: EmailBackendConfig | null | undefined,
    reserved: Map<string, string>,
): ResolveResult {
    const c = cfg ?? {};
    // Env (TOIL_EMAIL_*) overrides the config file; api key is env-only.
    const providerId = (envOf(reserved, 'PROVIDER') ?? c.provider ?? 'resend').toLowerCase();
    const from = envOf(reserved, 'FROM') ?? c.from?.trim();
    const apiKey = envOf(reserved, 'API_KEY');
    const enabled = parseBool(envOf(reserved, 'ENABLED'));

    // Unconfigured: explicitly disabled, or no `from` and no key at all -> silent off.
    if (enabled === false) return { config: null, warning: null };
    if (from === undefined && apiKey === undefined && cfg == null) {
        return { config: null, warning: null };
    }

    if (from === undefined) {
        return { config: null, warning: 'email config present but `from` is missing' };
    }
    if (!validFrom(from)) {
        return { config: null, warning: 'email `from` is not a valid address (CRLF or no `@`)' };
    }
    // The API-key requirement is PER PROVIDER: Resend authenticates with a key, and
    // Gmail SMTP needs an app password (also carried in the key), but a plain SMTP
    // relay (a local dev catch-all like Mailpit/MailHog on 127.0.0.1, or an internal
    // open relay) needs NO credential. Requiring a key for plain SMTP silently
    // disabled a perfectly good local-SMTP dev setup.
    let provider: ResolvedProvider;
    let smtp: ResolvedSmtp | undefined;
    if (providerId === 'resend') {
        if (apiKey === undefined) {
            return {
                config: null,
                warning: 'provider `resend` requires TOIL_EMAIL_API_KEY (in .env.secrets)',
            };
        }
        provider = 'resend';
    } else if (providerId === 'gmail' || providerId === 'smtp') {
        provider = 'smtp';
        const isGmail = providerId === 'gmail';
        const host =
            envOf(reserved, 'SMTP_HOST') ??
            c.smtp?.host?.trim() ??
            (isGmail ? 'smtp.gmail.com' : '');
        if (!host) {
            return { config: null, warning: 'provider `smtp` requires TOIL_EMAIL_SMTP_HOST' };
        }
        // Gmail always needs an app password; plain SMTP may be auth-less (the send
        // path omits `auth` when the key is empty). See providers.ts sendSmtp.
        if (isGmail && apiKey === undefined) {
            return {
                config: null,
                warning: 'provider `gmail` requires TOIL_EMAIL_API_KEY (a Gmail app password)',
            };
        }
        const port = parseInt0(envOf(reserved, 'SMTP_PORT'), c.smtp?.port ?? 0) || 587;
        const user = envOf(reserved, 'SMTP_USER') ?? c.smtp?.user?.trim() ?? from;
        smtp = { host, port, user };
    } else {
        return {
            config: null,
            warning: `unknown email provider "${providerId}" (resend|gmail|smtp)`,
        };
    }

    return {
        config: {
            provider,
            from,
            apiKey: apiKey ?? '',
            maxPerMin: parseInt0(envOf(reserved, 'MAX_PER_MIN'), c.maxPerMin ?? 60),
            maxPerDay: parseInt0(envOf(reserved, 'MAX_PER_DAY'), c.maxPerDay ?? 0),
            maxPerRecipientPerHour: parseInt0(
                envOf(reserved, 'MAX_PER_RECIPIENT_PER_HOUR'),
                c.maxPerRecipientPerHour ?? 5,
            ),
            smtp,
        },
        warning: null,
    };
}
