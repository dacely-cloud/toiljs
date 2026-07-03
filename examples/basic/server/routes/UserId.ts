import { Response } from 'toiljs/server/runtime';

/**
 * Demo of `ToilUserId` — the stable 256-bit user identity derived from the ML-DSA login public key +
 * identifier (email/username) + tenant domain. Deterministic, opaque, O(1) to compare with `==` / `!=`.
 */
@rest('userid')
class UserIdDemo {
    @get('/demo')
    public demo(): Response {
        const key = new Uint8Array(1312); // an ML-DSA-44 public key (zeros for the demo)
        const a = ToilUserId.derive(key, 'alice@example.com', 'acme.dacely.com');
        const b = ToilUserId.derive(key, 'alice@example.com', 'acme.dacely.com');
        const c = ToilUserId.derive(key, 'bob@example.com', 'acme.dacely.com');
        // Same inputs => same id (a == b); a different identifier => a different id (a != c).
        const same = a == b;
        const diff = a != c;
        return Response.text(
            a.toHex() + '\nsame=' + same.toString() + ' diff=' + diff.toString() + '\n',
        );
    }
}
