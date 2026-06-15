// EmailService + EmailTemplate + the `EmailStatus` enum: the guest surface for
// the per-tenant outbound email primitive, available as a no-import global (the
// toilscript `--lib` mechanism, like `AuthService` and `RateLimitService`). A
// handler calls `EmailService.send(...)` for a one-off, or defines a reusable
// `EmailTemplate` (with `{{placeholder}}` interpolation, plain text and/or HTML)
// and calls `template.send(to, vars)`.
//
// The host hands the message to the off-core mailer and SUSPENDS the call until
// the provider responds (on the async edge executor) without blocking the
// worker. `purpose` is a short tag ("verify", "reset", ...) the host folds into
// its dedup + per-recipient abuse keys; it is never logged raw. The recipient is
// validated at the host boundary (no header injection / multiple addresses) and
// the send is capped per tenant.
//
// Backed by the `email_send` host import (toil-backend `email_send_import.rs`,
// and the toiljs dev-server mock). A tenant that never sends email never imports
// `email_send`, so AssemblyScript tree-shakes it; a module that does must be
// deployed to an edge built with the `email` feature.

// Host import: submit one email and resolve to its status code. `reqPtr`/`reqLen`
// is the length-prefixed request blob (header below). Suspends the wasm call
// until the off-core send completes.
// @ts-ignore: decorator
@external('env', 'email_send')
declare function __toilEmailSend(reqPtr: usize, reqLen: i32): i32;

/**
 * The result of a send. Kept in sync with `EmailStatus` in toil-backend
 * `email.rs` (`#[repr(i32)]`). `Sent` and `Deduped` are success; the rest say
 * why it was not delivered and whether a retry could help.
 */
export enum EmailStatus {
    /** Accepted by the provider. */
    Sent = 0,
    /** This host has no `[email]` capability (or it is disabled / not on this path). */
    Disabled = 1,
    /** The tenant's per-minute budget is exhausted. Retriable later. */
    Budget = 2,
    /** The per-recipient hourly cap was hit. Terminal for this recipient/window. */
    RecipientCapped = 3,
    /** An identical recent (recipient, purpose) send was collapsed. Treat as sent. */
    Deduped = 4,
    /** The mailer was saturated / a queue was full. Retriable; back off. */
    TryLater = 5,
    /** The recipient failed host-side validation (CRLF, multiple addresses, malformed). */
    BadRecipient = 6,
    /** The provider rejected the send, or transport failed after retries. Terminal. */
    ProviderError = 7,
}

export namespace EmailService {
    /** Header: u16 to_len | u16 subject_len | u16 purpose_len | u32 body_len | u32 html_len. */
    const HEADER_LEN: i32 = 14;

    /**
     * Send one email to `to` and return its {@link EmailStatus}. Suspends until
     * the off-core mailer reports a result.
     *
     * `body` is the plain-text body; pass a non-empty `html` to send an HTML
     * message (then `body` is the plain-text alternative — set both for the best
     * deliverability, or leave `body` empty for HTML-only). `purpose` is a short,
     * non-PII tag used for host-side dedup/abuse keying.
     */
    export function send(
        to: string,
        subject: string,
        body: string,
        purpose: string = 'tx',
        html: string = '',
    ): EmailStatus {
        const toB = Uint8Array.wrap(String.UTF8.encode(to));
        const subjB = Uint8Array.wrap(String.UTF8.encode(subject));
        const purpB = Uint8Array.wrap(String.UTF8.encode(purpose));
        const bodyB = Uint8Array.wrap(String.UTF8.encode(body));
        const htmlB = Uint8Array.wrap(String.UTF8.encode(html));

        const total =
            HEADER_LEN + toB.length + subjB.length + purpB.length + bodyB.length + htmlB.length;
        const buf = new Uint8Array(total);
        const base = buf.dataStart;

        // Little-endian header (wasm stores are LE), then the five payloads in
        // the order the host parser expects: to, subject, purpose, body, html.
        store<u16>(base, <u16>toB.length, 0);
        store<u16>(base, <u16>subjB.length, 2);
        store<u16>(base, <u16>purpB.length, 4);
        store<u32>(base, <u32>bodyB.length, 6);
        store<u32>(base, <u32>htmlB.length, 10);

        let off = base + HEADER_LEN;
        memory.copy(off, toB.dataStart, toB.length);
        off += toB.length;
        memory.copy(off, subjB.dataStart, subjB.length);
        off += subjB.length;
        memory.copy(off, purpB.dataStart, purpB.length);
        off += purpB.length;
        memory.copy(off, bodyB.dataStart, bodyB.length);
        off += bodyB.length;
        memory.copy(off, htmlB.dataStart, htmlB.length);

        return <EmailStatus>__toilEmailSend(base, total);
    }
}

/** One template rendered against a variable map: the concrete parts to send. */
export class RenderedEmail {
    subject: string;
    body: string;
    html: string;
    constructor(subject: string, body: string, html: string) {
        this.subject = subject;
        this.body = body;
        this.html = html;
    }
}

/**
 * A reusable email template with `{{placeholder}}` interpolation, defined once
 * and sent many times with different variables:
 *
 *   const welcome = new EmailTemplate(
 *     'Welcome, {{name}}!',
 *     'Hi {{name}}, your code is {{code}}.',
 *     '<h1>Welcome, {{name}}</h1><p>Your code is <b>{{code}}</b>.</p>',
 *   );
 *   const vars = new Map<string,string>();
 *   vars.set('name', 'Alice'); vars.set('code', '123456');
 *   welcome.send('alice@example.com', vars, 'welcome');
 *
 * `{{ key }}` (with surrounding spaces) is accepted; an unknown placeholder
 * renders to the empty string. `html` is optional — omit it for a plain-text
 * template.
 */
export class EmailTemplate {
    private subjectTpl: string;
    private bodyTpl: string;
    private htmlTpl: string;

    constructor(subject: string, body: string, html: string = '') {
        this.subjectTpl = subject;
        this.bodyTpl = body;
        this.htmlTpl = html;
    }

    /** Render the template against `vars` without sending (preview / testing). */
    render(vars: Map<string, string>): RenderedEmail {
        return new RenderedEmail(
            interpolate(this.subjectTpl, vars),
            interpolate(this.bodyTpl, vars),
            this.htmlTpl.length > 0 ? interpolate(this.htmlTpl, vars) : '',
        );
    }

    /** Render and send to `to`. Returns the send's {@link EmailStatus}. */
    send(to: string, vars: Map<string, string>, purpose: string = 'tx'): EmailStatus {
        const r = this.render(vars);
        return EmailService.send(to, r.subject, r.body, purpose, r.html);
    }
}

/**
 * Substitute every `{{key}}` in `pattern` with `vars.get(key)`. Surrounding
 * whitespace in the placeholder is ignored (`{{ name }}` == `{{name}}`); an
 * unknown key renders to the empty string; an unterminated `{{` is emitted
 * literally. Module-private (not part of the `--lib` global surface).
 */
function interpolate(pattern: string, vars: Map<string, string>): string {
    let out = '';
    let i = 0;
    const n = pattern.length;
    while (i < n) {
        const open = pattern.indexOf('{{', i);
        if (open < 0) {
            out += pattern.substring(i);
            break;
        }
        out += pattern.substring(i, open);
        const close = pattern.indexOf('}}', open + 2);
        if (close < 0) {
            out += pattern.substring(open); // unterminated -> literal
            break;
        }
        const key = pattern.substring(open + 2, close).trim();
        if (vars.has(key)) out += vars.get(key);
        i = close + 2;
    }
    return out;
}
