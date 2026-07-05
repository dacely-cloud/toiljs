# Authentication

Toil ships a complete, **post-quantum password login** you turn on with one line. No passwords on your
server, no third-party identity provider, no hand-written crypto: enable it and you get a `/auth/*` API,
signed sessions, `@auth`-guarded routes, and a stable per-user identity.

```ts
// toil.config.ts
import { defineConfig } from 'toiljs/compiler';

export default defineConfig({
    server: { auth: true }, // ← mounts the full /auth/* API + sessions
});
```

That is the whole setup. The build appends the framework's auth controller to your server, so `/auth/*`
is live and `@auth` works everywhere.

## What you get

| Endpoint | Purpose |
| --- | --- |
| `POST /auth/register/start`, `/register/finish` | Create an account (password never leaves the browser) |
| `POST /auth/login/start`, `/login/finish` | Log in; sets a signed session cookie |
| `GET /auth/me` *(`@auth`)* | The current user (`toilUserId` + `username`) |
| `POST /auth/logout` *(`@auth`)* | Clear the session |

Plus, in your own code:

- **`@auth`** on any route (or a whole `@rest` class) → 401 unless there's a valid session.
- **`AuthService.getUser()`** → the typed logged-in user.
- **`AuthService.userId()`** → the stable [`ToilUserId`](./extending.md#toiluserid) (a 256-bit id you can
  key your data on).
- **The client**: `import { Auth } from 'toiljs/client'`, then `Auth.register(username, password)` /
  `Auth.login(username, password)`. It does all the browser-side crypto and talks to `/auth/*` for you.

## A login page in full

```tsx
// client/routes/login.tsx
import { useState } from 'react';
import { Auth } from 'toiljs/client';

export default function Login() {
    const [u, setU] = useState('');
    const [p, setP] = useState('');
    const [msg, setMsg] = useState('');

    const register = async () => {
        try { await Auth.register(u, p); setMsg('registered, now log in'); }
        catch (e) { setMsg(parseError(e)); }
    };
    const login = async () => {
        try { await Auth.login(u, p); setMsg('logged in'); }   // sets the session cookie
        catch (e) { setMsg(parseError(e)); }
    };

    return (
        <main>
            <input value={u} onChange={(e) => setU(e.currentTarget.value)} placeholder="username" />
            <input value={p} type="password" onChange={(e) => setP(e.currentTarget.value)} placeholder="password" />
            <button onClick={register}>Register</button>
            <button onClick={login}>Log in</button>
            <p>{msg}</p>
        </main>
    );
}
```

```ts
// server/routes/Secret.ts, a route only a logged-in user can reach
import { Response } from 'toiljs/server/runtime';

@rest('secret')
class Secret {
    @auth                     // 401 without a valid session
    @get('/')
    public secret(): Response {
        const user = AuthService.getUser()!;      // typed: { toilUserId, username }
        return Response.text('hello ' + user.username + '\n');
    }
}
```

That's a real, production-grade auth system, the password is stretched with Argon2id in the browser into
an ML-DSA-44 key pair, your server only ever stores a public key, and login is a mutually-authenticated
ML-KEM-768 challenge. You didn't write any of it.

## Where to go next

- **[How it works](./how-it-works.md)**: the protocol (OPRF + Argon2id + ML-DSA + ML-KEM), sessions,
  cookies, and the `ToilUserId`, with sequence diagrams.
- **[Usage](./usage.md)**: enabling it, the client API, guarding routes, reading the user, the full wire
  contract of each endpoint.
- **[Configuration](./configuration.md)**: the secrets a deployment MUST set, the audience/domain, tuning
  Argon2id, and the deploy checklist.
- **[Extending & integrating](./extending.md)**: `ToilUserId`, keying your own data on a user, a custom
  user shape / opting out, and the `AuthService` primitive reference.
- **[Customizing the auth emails](./emails.md)**: replace the verification, password-reset, and 2FA
  emails with your own branded React templates by dropping `emails/auth-*.tsx` files.

> **One rule before you ship:** built-in auth runs with **insecure DEV fallback secrets** so it Just Works
> locally. A deployment MUST set `AUTH_SESSION_SECRET`, `AUTH_OPRF_SEED`, and `AUTH_KEM_SK`. See
> [Configuration](./configuration.md).
