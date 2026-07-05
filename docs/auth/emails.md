# Customizing the auth emails

Built-in auth sends three transactional emails: the email-verification link, the password-reset link, and the two-factor code. Each ships with a plain, working default. You can replace any of them with your own branded template, and you never touch the auth code to do it.

## The three emails

| Email | When it sends | The value it gives your template |
| --- | --- | --- |
| Email verification | On register, when email confirmation is on | `link` (the confirm URL) |
| Password reset | On `POST /auth/reset/request` | `link` (the reset URL) |
| Two-factor code | On login or 2FA setup, for the email method | `code` (the numeric code) |

The defaults are intentionally minimal so a fresh project sends real, correct mail with no setup. To match your brand, override them.

## How to override

Drop a React template in your project's `emails/` folder with the reserved name for that email. If the file exists, the build uses it; if not, the default stands. This is the same `emails/*.tsx` system you use for your own mail (see [Email](../services/email.md)), so you get full markup and inline CSS.

| Reserved file | Overrides | Prop it must read |
| --- | --- | --- |
| `emails/auth-confirm.tsx` | Email verification | `link` |
| `emails/auth-reset.tsx` | Password reset | `link` |
| `emails/auth-2fa.tsx` | Two-factor code | `code` |

Each template is a default-exported React component. Read the one prop it is given, and it becomes a `{{token}}` hole the edge fills per send. Reading any other prop renders empty, so the build warns you.

```tsx
// emails/auth-confirm.tsx  ->  overrides the email-verification message.
export const subject = 'Verify your Acme account';

export default function AuthConfirm({ link }: { link: string }) {
    return (
        <div style={{ fontFamily: 'system-ui', padding: 24 }}>
            <h1 style={{ color: '#cb9820' }}>Welcome to Acme</h1>
            <p>Tap below to verify your email and finish signing up.</p>
            <p>
                <a
                    href={link}
                    style={{ background: '#cb9820', color: '#fff', padding: '10px 18px', borderRadius: 8, textDecoration: 'none' }}
                >
                    Verify my email
                </a>
            </p>
            <p style={{ color: '#666', fontSize: 13 }}>Or paste this link: {link}</p>
        </div>
    );
}
```

The reset template works the same way with the `link` prop.

## The subject line

For verification and reset, set the subject with `export const subject = '...'`. Leave it out and the default subject is used (`Confirm your account`, `Reset your password`).

The two-factor email is different: its subject is set by the framework because it changes with context (a login code versus a setup code). Your `emails/auth-2fa.tsx` override controls the body and HTML around the `code`, and the subject stays contextual. A `subject` export in that file is ignored.

```tsx
// emails/auth-2fa.tsx  ->  overrides the 2FA code message (subject is contextual).
export default function Auth2fa({ code }: { code: string }) {
    return (
        <div style={{ fontFamily: 'system-ui', padding: 24, textAlign: 'center' }}>
            <p>Your Acme verification code:</p>
            <p style={{ fontSize: 32, fontWeight: 700, letterSpacing: 6 }}>{code}</p>
            <p style={{ color: '#666' }}>It expires in a few minutes.</p>
        </div>
    );
}
```

## What you can and cannot put in

Each template is rendered once, at build time, into a static string of HTML with your styles inlined, and the prop becomes a fill hole. So a fixed layout and inline styles work, but per-send logic does not: a `{items.map(...)}` or a conditional runs at build, not per email. For these three messages that is all you need, one link or one code.

The only value auth hands each template is the one in the table above (`link` or `code`). There is no user name, no app name, no expiry value. Write those into the template text directly.

Styling rules are the same as any toiljs email: write inline `style={{ ... }}`, or import a stylesheet and its rules are inlined for you. A bare CSS import with no inlining has no effect in an email client. See [Email](../services/email.md) for the details.

## Delivery stays safe

You cannot weaken the security of these flows by overriding a template. Every auth email is sent detached (fire-and-forget), so the response time never reveals whether an address maps to an account. That holds whether the message is the default or your override. Overriding only changes what the email looks like, never how it is sent.

## Where the templates go

There is nothing to import and nothing to register. The build reads `emails/auth-*.tsx`, bakes the effective templates into the compiled server, and the auth controller sends them. Changing a template and rebuilding (or saving under `toiljs dev`) is all it takes.

## Related

- [Email](../services/email.md): the full `emails/*.tsx` system, `EmailService`, and `EmailTemplate`.
- [Configuration](./configuration.md): the auth secrets and the email provider a deployment must set.
- [Usage](./usage.md): enabling auth, the client API, and guarding routes.
