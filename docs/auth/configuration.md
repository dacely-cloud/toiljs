# Configuring auth for production

Built-in auth runs locally with **zero configuration** — it falls back to published, insecure DEV secrets
so `toiljs dev` Just Works. **A deployment MUST replace all three secrets and pin its KEM key.** This page
is the checklist.

## The secrets

Auth reads these from the tenant environment store (locally, `.env.secrets`; on the edge, the per-host
secure env). They resolve **lazily** the first time auth runs, so no startup wiring is needed.

| Key | What it is | Dev fallback |
| --- | --- | --- |
| `AUTH_SESSION_SECRET` | HMAC-SHA256 key that signs the session cookie. Must be identical on every edge instance (a cookie minted anywhere must verify everywhere). | a public constant — **anyone can forge a session** |
| `AUTH_OPRF_SEED` | Master seed for the per-user OPRF salt key. Rotating it invalidates every password (users must re-register). | a hashed public constant |
| `AUTH_KEM_SK` | The server's ML-KEM-768 **secret** key (hex). Its public half is what the client encapsulates to. | a pinned dev key pair |

```bash
# .env.secrets   (gitignored; mode 0600 on the edge, NEVER under hosts/, NEVER in the .wasm)
AUTH_SESSION_SECRET=…64 hex chars (32 bytes)…
AUTH_OPRF_SEED=…64 hex chars (32 bytes)…
AUTH_KEM_SK=…hex of an ML-KEM-768 secret key…
```

### Generating them

`AUTH_SESSION_SECRET` and `AUTH_OPRF_SEED` are just 32 random bytes each:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

`AUTH_KEM_SK` is an ML-KEM-768 key pair. Generate it and keep BOTH halves — the secret goes in the env, the
public half is pinned in the client (next section):

```ts
import { ml_kem768 } from '@dacely/noble-post-quantum/ml-kem';
const { secretKey, publicKey } = ml_kem768.keygen();
console.log('AUTH_KEM_SK =', Buffer.from(secretKey).toString('hex'));
console.log('client serverKemPublicKey =', Buffer.from(publicKey).toString('hex'));
```

## Pin the client's KEM public key

The browser must know the server's genuine KEM public key to run the mutual-auth handshake — this is the
anti-phishing anchor. The `toiljs/client` `Auth` helper ships with the **dev** key pinned, so a deployment
MUST pass its own:

```ts
import { Auth } from 'toiljs/client';

const SERVER_KEM_PUBLIC_KEY = /* the publicKey bytes from AUTH_KEM_SK */;

await Auth.login(username, password, { serverKemPublicKey: SERVER_KEM_PUBLIC_KEY });
await Auth.register(username, password, { serverKemPublicKey: SERVER_KEM_PUBLIC_KEY });
```

Ship the public key with your client bundle (it's public — safe to embed). If it doesn't match the server's
`AUTH_KEM_SK`, login's `serverConfirm` check fails and the client aborts.

## Optional: audience & domain

Both are optional and have sensible defaults; set them for stability across host aliases:

| Key | Meaning | Default |
| --- | --- | --- |
| `TOIL_AUTH_AUDIENCE` | The service audience bound into the signed login message. | `"toil"` |
| `TOIL_AUTH_DOMAIN` | The `domain` input of the stable `ToilUserId` (`sha256(pubkey ‖ username ‖ domain)`). | the request `Host` header, else `localhost` |

Set `TOIL_AUTH_DOMAIN` explicitly if your site answers on multiple hostnames — otherwise the same user could
get different `ToilUserId`s from different aliases. Once users exist, changing it changes everyone's id, so
pick it before launch.

## Argon2id strength (known limitation)

The built-in controller currently uses **demo-light** Argon2id params (32 MiB, 2 iterations, 1 lane) so it
stays responsive in a browser tab. These are baked into the shipped controller today; **config-driven
tuning is a planned follow-up.** For a high-value production deployment you should either wait for the
config knob or hand-write your own controller with `≥ 256 MiB / ≥ 3 iterations`. The OPRF still provides the
primary offline-attack resistance regardless, but raise these before protecting anything sensitive.

The client always derives against whatever params the server returns in `/login/start`, so when the config
knob lands you can raise them server-side with **no client change**.

## Deploy checklist

- [ ] `AUTH_SESSION_SECRET` set (32 random bytes), identical on every edge instance.
- [ ] `AUTH_OPRF_SEED` set (32 random bytes).
- [ ] `AUTH_KEM_SK` set (an ML-KEM-768 secret key), and its **public** half pinned in the client via
      `serverKemPublicKey`.
- [ ] `TOIL_AUTH_DOMAIN` set if you serve multiple hostnames (stable `ToilUserId`).
- [ ] (Recommended) Argon2id params reviewed for your threat model.

The CLI doctor warns when `server.auth` is on and the secrets are missing — run it before you ship.
