# Authentication red team audit

This audit covers the uncommitted Google sign-in and Google Authenticator changes
in ToilJS and toil-backend. It exercises the compiled controller, Node production
HTTP serving, native sync/async hosts, replay counters, and deterministic database
interleavings. Tests use locally generated signing keys and isolated databases;
no production accounts or external systems were attacked.

## Findings and fixes

| Finding | Severity and prerequisite | Evidence | Resolution |
| --- | --- | --- | --- |
| Revocation/factor lookup could trust an absent remote replica | High; multi-cell execution with replication lag | A query at a non-owning cell returned Ok(None) for a unique key owned elsewhere | Unique lookups now read the owning cell for both presence and absence. Inline non-owner reads fail closed; async reads bypass replica and negative caches and use the current-owner RPC. Placement denial remains unavailable, never absent. |
| Factor change survived a failed request without revoking earlier sessions | High; a database/host failure after the factor write | Injecting failure immediately after the original immutable factor claim left the old session accepted with HTTP 200 | The new policy and generation advance are one immutable epoch claim. Failure after that commit leaves the policy enforced and old sessions rejected. |
| Replacement TOTP guesses were limited only by source IP | High; an attacker already holds a session | Six distinct source IPs all reached code rejection instead of hitting an account limit | Replacement proof and login proof share the per-account five-per-minute limiter, independent of IP and challenge. The sixth replacement attempt returns 429. |
| A delayed wrong-code request overwrote a newer enrollment | Medium; concurrent setup/verification requests | Pause before the attempt update, replace enrollment, resume: the replacement's correct code failed | Wrong-attempt updates and expired/exhausted deletion now compare against the exact snapshot read. A stale request cannot overwrite or delete a replacement. |
| Third-party Google email was treated as independently confirmed | Medium; a Google account retains an external address whose ownership has changed | The original registration marked every verified Google email confirmed, including when tenant policy required confirmation | The host reports whether Google is authoritative for the email. Other addresses require independent confirmation when tenant policy requires it; the login issues no session and returns EmailNotConfirmedError. |
| Malformed second-factor identifiers reached persistent limiter/DB work | Medium; unauthenticated requests | An oversized identifier performed a database lookup; the endpoint also hex-encoded arbitrary identifiers before allocating a keyed limiter entry | Second-factor bodies are bounded, login challenge IDs must be exactly 16 bytes, and only existing unexpired challenges allocate keyed limiter entries. Oversized IDs are rejected before DB work. |
| The initial atomic redesign could replace another realm's factor policy | High; two routed domains share TOIL_AUTH_DOMAIN and a provider identity | A new regression test enabled different factors under both hosts, then signed into the first without its factor | Generation keys now include the normalized routed Host. A shared stable identity domain cannot merge security policies. This regression was caught and fixed while validating the redesign. |

The email distinction follows [Google's server-verification guidance](https://developers.google.com/identity/gsi/web/guides/verify-google-id-token).
The backend absence regression failed before the fix and passes afterward. A
loopback mesh test independently checks unique-owner current reads, authoritative
absence, and unavailable responses for authorization denial. This uses isolated
in-memory storage, not a deployed multi-region database.

Both verifiers also reject future or malformed optional `nbf` claims, with a
30-second tolerance, following the [JWT not-before requirement](https://www.rfc-editor.org/rfc/rfc7519.html#section-4.1.5).
This is defensive validation; the audit did not establish that Google currently
issues exploitable tokens carrying that claim.

## Regression coverage

`test/google-auth.test.ts` contains the failure injection, stale-enrollment race,
distributed replacement guesses, third-party email policy, and shared-identity
realm tests. Malformed second-factor requests are rejected before database access.
It also covers signature/claim rejection, browser nonce binding,
email collision without account linking, provider credential reset prevention,
deleted accounts, real Node production HTTP login, TOTP encryption, replay,
concurrent counter consumption, and factor disablement.

Additional cases verify that ordinary and verified-session revocations preserve
the factor, a stale verified revocation preserves a concurrently committed
factor, and writes to the old generation namespace cannot replace new state.
Session-state tests retain the three-read authorization budget and conditional
head-repair invariants. JWKS and codec tests cover bounded parsing and cache
failure behavior. Browser tests exercise production response policies with two
HTTP workers.

## Verification

The SDK suite passes 727 tests (5 skipped), including 17 Google/TOTP tests with
database limits enabled. Browser validation passes all 3 cases. SDK build, lint,
typecheck, example build, and native sync/async authentication checks pass.
The targeted ToilDB unique-owner suite passes 14 tests, and both current-owner
mesh tests pass. A broader filter also selected 3 live ScyllaDB cases; those
could not run because the configured localhost service refused the connection.

Run the SDK checks from the ToilJS checkout:

```sh
npm run build
npm run lint
npm run typecheck
npx vitest run
TOIL_DEV_CHECK_DB_LIMITS=1 npx vitest run test/google-auth.test.ts
TOILJS_BROWSER_TESTS=1 npx vitest run test/security-browser.test.ts
node build/cli/index.js build --root examples/basic
```

Run the backend checks from the toil-backend checkout:

```sh
cargo test --lib host::google::tests
cargo test --manifest-path toildb/Cargo.toml --lib unique_lookup_rejects_non_owner_absence
cargo test --manifest-path toildb/Cargo.toml --lib distinguish_denial_from_absence
TOIL_GOOGLE_AUTH_WASM=/root/toiljs/examples/basic/build/server/release.wasm \
  cargo test --lib compiled_google_auth_and_totp -- --ignored --test-threads=1
TOIL_GOOGLE_AUTH_WASM=/root/toiljs/examples/basic/build/server/release.wasm \
  TOIL_GOOGLE_AUTH_ASYNC=1 \
  cargo test --lib compiled_google_auth_and_totp -- --ignored --test-threads=1
```

The native fixture passes the default 128M gas limit in both modes. Measured sync
operations: initial Google login uses 6 reads/4 writes; authenticator setup uses
7 reads/1 write; confirmation uses 6 reads/3 writes; authenticator login proof uses
7 reads/2 writes. Initialization and invalid Google assertions use no database
operations. Confirmation measured about 126.1M gas, so long domains, custom user
codecs, registration hooks, and contention need workload-specific headroom.

## Deployment and limits

Deploy the matching backend first. Then upgrade every application instance before
enabling the new features. Session format 3 invalidates existing cookies and
older pending challenges. Its separate host-scoped generation keys prevent older
application code from overwriting atomic factor state. Existing AuthStateDb
factor records remain readable; this change does not require a database reset.
Administrative deletion explicitly revokes the selected account realm, including
when invoked from a Job without an HTTP request.

The audit does not establish production Google origin/client configuration,
mail delivery, deployed database failover behavior, or protection against all
possible vulnerabilities. Deterministic request races use the real compiled guest
and shared-store operations; they do not simulate mesh replication or storage
lease failures. Recovery for a lost authenticator remains an application-owned,
identity-verified operator process.
