/**
 * The dev / self-host email pipeline (src/devserver/email): wire parse,
 * recipient validation, in-process caps (dedup + per-recipient + per-min/day
 * budget), config resolution (toil.config + TOIL_EMAIL_* env), the Resend
 * transport, and the NodeEmailService prepare/deliver split. Mirrors the edge
 * (toil-backend host/email.rs, mailer.rs, email_budget.rs).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import { EmailCaps } from '../src/devserver/email/caps.js';
import { resolveEmailConfig, type ResolvedEmailConfig } from '../src/devserver/email/config.js';
import { NodeEmailService } from '../src/devserver/email/index.js';
import { sendResend } from '../src/devserver/email/providers.js';
import { EmailStatus } from '../src/devserver/email/status.js';
import { validFrom, validRecipient } from '../src/devserver/email/validate.js';
import { parseEmailBlob } from '../src/devserver/email/wire.js';

/** Encode an `email_send` blob exactly like the guest (`server/globals/email.ts`). */
function encodeBlob(to: string, subject: string, purpose: string, body: string, html: string): Buffer {
    const e = (s: string): Buffer => Buffer.from(s, 'utf8');
    const [t, s, p, b, h] = [e(to), e(subject), e(purpose), e(body), e(html)];
    const head = Buffer.alloc(14);
    head.writeUInt16LE(t.length, 0);
    head.writeUInt16LE(s.length, 2);
    head.writeUInt16LE(p.length, 4);
    head.writeUInt32LE(b.length, 6);
    head.writeUInt32LE(h.length, 10);
    return Buffer.concat([head, t, s, p, b, h]);
}

const reserved = (o: Record<string, string>): Map<string, string> => new Map(Object.entries(o));

describe('validate', () => {
    it('accepts plain addresses, rejects injection / multiple / malformed', () => {
        expect(validRecipient('user@example.com')).toBe(true);
        expect(validRecipient('a.b+tag@sub.example.co')).toBe(true);
        for (const bad of [
            'a@b.com\r\nBcc: evil@x.com',
            'a@b.com\nDATA',
            'a@b.com\0',
            'a@b.com,c@d.com',
            'a@b.com;c@d.com',
            'a@b.com c@d.com',
            '<a@b.com>',
            '"a"@b.com',
            '',
            'nobody',
            'a@b@c.com',
            '@b.com',
            'a@bcom',
            'a@.com',
            'a@b.',
        ]) {
            expect(validRecipient(bad), bad).toBe(false);
        }
    });

    it('validFrom is lenient but rejects header injection', () => {
        expect(validFrom('me@example.com')).toBe(true);
        expect(validFrom('a@b.com\r\nBcc: x')).toBe(false);
        expect(validFrom('no-at-sign')).toBe(false);
    });
});

describe('wire parse', () => {
    it('round-trips a well-formed blob', () => {
        const raw = encodeBlob('a@b.com', 'Hi', 'verify', '123456', '<b>x</b>');
        const p = parseEmailBlob(raw);
        expect(p).toEqual({ to: 'a@b.com', subject: 'Hi', purpose: 'verify', body: '123456', html: '<b>x</b>' });
    });

    it('rejects truncated / trailing-garbage / non-UTF8', () => {
        expect(parseEmailBlob(Buffer.alloc(4))).toBeNull(); // shorter than header
        const raw = encodeBlob('a@b.com', 's', 'p', 'body', '');
        expect(parseEmailBlob(raw.subarray(0, raw.length - 1))).toBeNull(); // truncated payload
        expect(parseEmailBlob(Buffer.concat([raw, Buffer.from([0xff])]))).toBeNull(); // trailing garbage
        const bad = Buffer.from(raw);
        bad[bad.length - 1] = 0xff; // corrupt last body byte -> invalid UTF-8
        expect(parseEmailBlob(bad)).toBeNull();
    });
});

describe('caps', () => {
    it('dedup collapses an identical (recipient, purpose) within the window', () => {
        const c = new EmailCaps();
        expect(c.isDuplicate('a@b.com', 'verify', 0)).toBe(false); // first
        expect(c.isDuplicate('a@b.com', 'verify', 1_000)).toBe(true); // repeat in window
        expect(c.isDuplicate('a@b.com', 'reset', 1_000)).toBe(false); // different purpose
        expect(c.isDuplicate('a@b.com', 'verify', 31_000)).toBe(false); // after the 30s window
    });

    it('per-recipient hourly cap holds then resets', () => {
        const c = new EmailCaps();
        expect(c.recipientOk('x@y.com', 2, 0)).toBe(true);
        expect(c.recipientOk('x@y.com', 2, 10)).toBe(true);
        expect(c.recipientOk('x@y.com', 2, 20)).toBe(false); // third over the cap
        expect(c.recipientOk('z@y.com', 2, 20)).toBe(true); // a different recipient is independent
        expect(c.recipientOk('x@y.com', 2, 3_600_001)).toBe(true); // next hour resets
    });

    it('per-minute and per-day budgets both gate, 0 = unlimited', () => {
        const c = new EmailCaps();
        expect(c.budgetOk(2, 0, 0)).toBe(true);
        expect(c.budgetOk(2, 0, 0)).toBe(true);
        expect(c.budgetOk(2, 0, 0)).toBe(false); // minute cap (2) exhausted at the same instant
        // A separate budget instance with only a day cap.
        const d = new EmailCaps();
        expect(d.budgetOk(0, 1, 0)).toBe(true);
        expect(d.budgetOk(0, 1, 0)).toBe(false); // day cap (1) exhausted
        // Unlimited (0/0) never blocks.
        const u = new EmailCaps();
        for (let i = 0; i < 100; i++) expect(u.budgetOk(0, 0, i)).toBe(true);
    });
});

describe('config resolution', () => {
    it('is unconfigured (silent) with no config + no env', () => {
        expect(resolveEmailConfig(null, reserved({}))).toEqual({ config: null, warning: null });
    });

    it('merges toil.config + env, api key from env, env wins', () => {
        const { config } = resolveEmailConfig(
            { provider: 'resend', from: 'cfg@x.com', maxPerMin: 10 },
            reserved({ TOIL_EMAIL_API_KEY: 're_k', TOIL_EMAIL_FROM: 'env@x.com' }),
        );
        expect(config).toMatchObject({ provider: 'resend', from: 'env@x.com', apiKey: 're_k', maxPerMin: 10 });
    });

    it('gmail resolves to smtp with defaults', () => {
        const { config } = resolveEmailConfig(
            { provider: 'gmail', from: 'me@gmail.com' },
            reserved({ TOIL_EMAIL_API_KEY: 'app-pw' }),
        );
        expect(config).toMatchObject({ provider: 'smtp', smtp: { host: 'smtp.gmail.com', port: 587, user: 'me@gmail.com' } });
    });

    it('warns (off) on partial/invalid config', () => {
        // from but no api key
        expect(resolveEmailConfig({ from: 'a@b.com' }, reserved({})).warning).toMatch(/API_KEY/);
        // bad from
        expect(resolveEmailConfig({ from: 'no-at' }, reserved({ TOIL_EMAIL_API_KEY: 'k' })).warning).toMatch(/from/);
        // smtp without host
        expect(
            resolveEmailConfig({ provider: 'smtp', from: 'a@b.com' }, reserved({ TOIL_EMAIL_API_KEY: 'k' })).warning,
        ).toMatch(/SMTP_HOST/);
        // unknown provider
        expect(
            resolveEmailConfig({ from: 'a@b.com' }, reserved({ TOIL_EMAIL_API_KEY: 'k', TOIL_EMAIL_PROVIDER: 'mailgun' }))
                .warning,
        ).toMatch(/unknown/);
    });

    it('TOIL_EMAIL_ENABLED=false disables silently', () => {
        expect(
            resolveEmailConfig({ provider: 'resend', from: 'a@b.com' }, reserved({ TOIL_EMAIL_API_KEY: 'k', TOIL_EMAIL_ENABLED: 'false' })),
        ).toEqual({ config: null, warning: null });
    });
});

describe('Resend transport', () => {
    afterEach(() => vi.unstubAllGlobals());

    const cfg: ResolvedEmailConfig = {
        provider: 'resend',
        from: 'noreply@x.com',
        apiKey: 're_secret',
        maxPerMin: 0,
        maxPerDay: 0,
        maxPerRecipientPerHour: 0,
    };

    it('2xx -> Sent, with the right payload + Bearer auth', async () => {
        const fetchMock = vi.fn(async () => new Response(null, { status: 200 }));
        vi.stubGlobal('fetch', fetchMock);
        const status = await sendResend(cfg, { from: cfg.from, to: 'a@b.com', subject: 'Hi', body: 'text', html: '<b>h</b>' });
        expect(status).toBe(EmailStatus.Sent);
        expect(fetchMock).toHaveBeenCalledTimes(1);
        const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
        expect((init.headers as Record<string, string>).authorization).toBe('Bearer re_secret');
        expect(JSON.parse(init.body as string)).toEqual({ from: 'noreply@x.com', to: ['a@b.com'], subject: 'Hi', text: 'text', html: '<b>h</b>' });
    });

    it('4xx -> ProviderError, no retry', async () => {
        const fetchMock = vi.fn(async () => new Response(null, { status: 422 }));
        vi.stubGlobal('fetch', fetchMock);
        const status = await sendResend(cfg, { from: cfg.from, to: 'a@b.com', subject: 's', body: 'b', html: '' });
        expect(status).toBe(EmailStatus.ProviderError);
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });
});

describe('NodeEmailService pipeline', () => {
    afterEach(() => vi.unstubAllGlobals());

    const base: ResolvedEmailConfig = {
        provider: 'resend',
        from: 'noreply@x.com',
        apiKey: 're_secret',
        maxPerMin: 0,
        maxPerDay: 0,
        maxPerRecipientPerHour: 0,
    };

    it('prepare returns terminal statuses and a parsed message to deliver', () => {
        const svc = new NodeEmailService(base);
        // Bad recipient.
        expect(svc.prepare(encodeBlob('not-an-email', 's', 'p', 'b', ''), 0).status).toBe(EmailStatus.BadRecipient);
        // Valid -> Sent + parsed.
        const ok = svc.prepare(encodeBlob('a@b.com', 's', 'verify', 'b', ''), 0);
        expect(ok.status).toBe(EmailStatus.Sent);
        expect(ok.parsed?.to).toBe('a@b.com');
        // Identical (to, purpose) again -> Deduped.
        expect(svc.prepare(encodeBlob('a@b.com', 's', 'verify', 'b', ''), 1_000).status).toBe(EmailStatus.Deduped);
    });

    it('enforces the per-minute budget', () => {
        const svc = new NodeEmailService({ ...base, maxPerMin: 2 });
        // Distinct recipients so dedup/recipient caps don't fire first.
        expect(svc.prepare(encodeBlob('a@x.com', 's', 'p', 'b', ''), 0).status).toBe(EmailStatus.Sent);
        expect(svc.prepare(encodeBlob('b@x.com', 's', 'p', 'b', ''), 0).status).toBe(EmailStatus.Sent);
        expect(svc.prepare(encodeBlob('c@x.com', 's', 'p', 'b', ''), 0).status).toBe(EmailStatus.Budget);
    });

    it('enforces the per-recipient hourly cap', () => {
        const svc = new NodeEmailService({ ...base, maxPerRecipientPerHour: 2 });
        // Same recipient, distinct purposes so dedup doesn't fire.
        expect(svc.prepare(encodeBlob('a@x.com', 's', 'p1', 'b', ''), 0).status).toBe(EmailStatus.Sent);
        expect(svc.prepare(encodeBlob('a@x.com', 's', 'p2', 'b', ''), 0).status).toBe(EmailStatus.Sent);
        expect(svc.prepare(encodeBlob('a@x.com', 's', 'p3', 'b', ''), 0).status).toBe(EmailStatus.RecipientCapped);
    });

    it('deliver actually sends via the provider', async () => {
        const fetchMock = vi.fn(async () => new Response(null, { status: 200 }));
        vi.stubGlobal('fetch', fetchMock);
        const svc = new NodeEmailService(base);
        const { parsed } = svc.prepare(encodeBlob('a@b.com', 's', 'p', 'b', ''), 0);
        expect(parsed).not.toBeNull();
        expect(await svc.deliver(parsed!)).toBe(EmailStatus.Sent);
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });
});
