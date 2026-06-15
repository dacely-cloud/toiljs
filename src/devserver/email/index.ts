/**
 * The dev / self-host email service — the full edge pipeline in Node, reusable
 * by the future self-host runtime (this folder has NO Vite/devserver coupling).
 *
 * Split for the sync-wasm constraint: `prepare()` is SYNCHRONOUS (parse +
 * validate + dedup + budget + per-recipient cap) and returns the terminal status
 * to hand the guest now; `deliver()` is ASYNC (the actual provider send). A
 * synchronous host (the dev server) fires `deliver()` and returns `Sent`
 * optimistically; an async-capable host (a future self-host) can `await deliver()`
 * for the true status.
 */
import { loadEnvFiles } from '../dotenv.js';
import { EmailCaps } from './caps.js';
import { resolveEmailConfig, type ResolvedEmailConfig } from './config.js';
import { sendVia, type OutboundMessage } from './providers.js';
import { EmailStatus } from './status.js';
import { validRecipient } from './validate.js';
import { parseEmailBlob, type ParsedEmail } from './wire.js';

import type { EmailBackendConfig } from 'toiljs/shared';

export { EmailStatus } from './status.js';
export type { ResolvedEmailConfig } from './config.js';

export interface PrepareResult {
    /** The status to return to the guest now. `Sent` means proceed to `deliver`. */
    readonly status: EmailStatus;
    /** The parsed message, present iff `status === Sent` (caller should deliver). */
    readonly parsed: ParsedEmail | null;
}

export class NodeEmailService {
    private readonly caps = new EmailCaps();
    constructor(private readonly config: ResolvedEmailConfig) {}

    /** The configured provider id (for the startup banner / logs). */
    get providerLabel(): string {
        return `${this.config.provider} (${this.config.from})`;
    }

    /**
     * Synchronous pre-send: parse the wire blob, validate the recipient, then
     * dedup + per-minute/day budget + per-recipient cap (all committing). Returns
     * a terminal status (`BadRecipient` / `Deduped` / `Budget` / `RecipientCapped`),
     * or `{ status: Sent, parsed }` meaning the caller should `deliver(parsed)`.
     */
    prepare(blob: Buffer, now: number = Date.now()): PrepareResult {
        const parsed = parseEmailBlob(blob);
        if (parsed === null || !validRecipient(parsed.to)) {
            return { status: EmailStatus.BadRecipient, parsed: null };
        }
        if (this.caps.isDuplicate(parsed.to, parsed.purpose, now)) {
            return { status: EmailStatus.Deduped, parsed: null };
        }
        if (!this.caps.budgetOk(this.config.maxPerMin, this.config.maxPerDay, now)) {
            return { status: EmailStatus.Budget, parsed: null };
        }
        if (!this.caps.recipientOk(parsed.to, this.config.maxPerRecipientPerHour, now)) {
            return { status: EmailStatus.RecipientCapped, parsed: null };
        }
        return { status: EmailStatus.Sent, parsed };
    }

    /** Actually send via the configured provider; resolves to the real status. */
    deliver(parsed: ParsedEmail): Promise<EmailStatus> {
        const msg: OutboundMessage = {
            from: this.config.from,
            to: parsed.to,
            subject: parsed.subject,
            body: parsed.body,
            html: parsed.html,
        };
        return sendVia(this.config, msg);
    }
}

// --- Process-level singleton (one project per dev/self-host process) ----------

let service: NodeEmailService | null = null;

export interface EmailInitResult {
    /** The service, or `null` when email is unconfigured / invalid. */
    readonly service: NodeEmailService | null;
    /** A note for the startup banner: the provider label, or a config warning. */
    readonly note: string | null;
}

/**
 * Build the email service from the `toil.config.ts` `email` section + the
 * project's `.env.secrets` (`TOIL_EMAIL_*`, holding the API key) and install it
 * as the process singleton. Call once at startup. Returns a startup note.
 */
export function initEmailService(
    root: string,
    cfgEmail: EmailBackendConfig | null | undefined,
): EmailInitResult {
    const reserved = loadEnvFiles(root).reserved;
    const { config, warning } = resolveEmailConfig(cfgEmail, reserved);
    service = config === null ? null : new NodeEmailService(config);
    return { service, note: service === null ? warning : service.providerLabel };
}

/** The installed email service, or `null` when email is not configured. */
export function getEmailService(): NodeEmailService | null {
    return service;
}

/** Reset the singleton (tests). */
export function resetEmailService(): void {
    service = null;
}
