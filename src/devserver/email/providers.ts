/**
 * Provider transports for the dev / self-host mailer, mirroring the edge's
 * `mailer.rs`: Resend over `fetch` (`send_resend`) and SMTP over nodemailer
 * (`send_smtp`). Both retry transient failures with capped backoff; a permanent
 * rejection is terminal (`ProviderError`).
 *
 * nodemailer is imported lazily, so a Resend-only project never loads it.
 */
import { EmailStatus } from './status.js';
import type { ResolvedEmailConfig } from './config.js';

const MAX_ATTEMPTS = 3;
const BACKOFF_BASE_MS = 200;
const POST_TIMEOUT_MS = 10_000;

/** The concrete parts of one send (already validated + rendered). */
export interface OutboundMessage {
    readonly from: string;
    readonly to: string;
    readonly subject: string;
    /** Plain-text body (may be empty when only `html` is set). */
    readonly body: string;
    /** Optional HTML body (empty = plain-text send). */
    readonly html: string;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Classify an HTTP status (or `null` for a transport failure): 2xx → `Sent`,
 * 4xx → terminal `ProviderError` (a bad address keeps being bad), else
 * (5xx / transport) → retry.
 */
function classifyHttp(status: number | null): EmailStatus | 'retry' {
    if (status !== null && status >= 200 && status < 300) return EmailStatus.Sent;
    if (status !== null && status >= 400 && status < 500) return EmailStatus.ProviderError;
    return 'retry';
}

/** Drive one Resend POST with retry. */
export async function sendResend(
    cfg: ResolvedEmailConfig,
    msg: OutboundMessage,
): Promise<EmailStatus> {
    const payload: Record<string, unknown> = {
        from: msg.from,
        to: [msg.to],
        subject: msg.subject,
    };
    if (msg.body.length > 0) payload.text = msg.body;
    if (msg.html.length > 0) payload.html = msg.html;

    let backoff = BACKOFF_BASE_MS;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        let status: number | null = null;
        try {
            const res = await fetch('https://api.resend.com/emails', {
                method: 'POST',
                headers: {
                    authorization: `Bearer ${cfg.apiKey}`,
                    'content-type': 'application/json',
                },
                body: JSON.stringify(payload),
                signal: AbortSignal.timeout(POST_TIMEOUT_MS),
            });
            status = res.status;
        } catch {
            status = null; // transport error → retry
        }
        const verdict = classifyHttp(status);
        if (verdict !== 'retry') return verdict;
        if (attempt === MAX_ATTEMPTS) break;
        await sleep(backoff);
        backoff *= 2;
    }
    return EmailStatus.ProviderError;
}

/** Send one email over SMTP (nodemailer) with retry. */
export async function sendSmtp(
    cfg: ResolvedEmailConfig,
    msg: OutboundMessage,
): Promise<EmailStatus> {
    const smtp = cfg.smtp;
    if (smtp === undefined) return EmailStatus.ProviderError; // resolve() guarantees Some for smtp

    let transporter: import('nodemailer').Transporter;
    try {
        const nodemailer = await import('nodemailer');
        transporter = nodemailer.createTransport({
            host: smtp.host,
            port: smtp.port,
            secure: smtp.port === 465, // 465 = implicit TLS; else STARTTLS
            auth: { user: smtp.user, pass: cfg.apiKey },
            connectionTimeout: POST_TIMEOUT_MS,
            greetingTimeout: POST_TIMEOUT_MS,
        });
    } catch {
        // nodemailer not installed: SMTP unavailable.
        return EmailStatus.ProviderError;
    }

    let backoff = BACKOFF_BASE_MS;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        try {
            await transporter.sendMail({
                from: msg.from,
                to: msg.to,
                subject: msg.subject,
                text: msg.body.length > 0 ? msg.body : undefined,
                html: msg.html.length > 0 ? msg.html : undefined,
            });
            return EmailStatus.Sent;
        } catch (e) {
            // SMTP 5xx is a PERMANENT failure (bad auth / rejected recipient):
            // terminal. 4xx / transport errors are transient: retry with backoff.
            const code = (e as { responseCode?: number }).responseCode;
            if (typeof code === 'number' && code >= 500) return EmailStatus.ProviderError;
            if (attempt === MAX_ATTEMPTS) break;
            await sleep(backoff);
            backoff *= 2;
        }
    }
    return EmailStatus.ProviderError;
}

/** Dispatch to the configured provider. */
export function sendVia(cfg: ResolvedEmailConfig, msg: OutboundMessage): Promise<EmailStatus> {
    return cfg.provider === 'resend' ? sendResend(cfg, msg) : sendSmtp(cfg, msg);
}
