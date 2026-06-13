import { Method, Request, Response, ToilHandler } from 'toiljs/server/runtime';
import { DataReader } from 'data';

// Reads {sub, aud, cid, nonce, iat, exp, pk, sig} as a binary body, rebuilds
// the login message with the AS AuthService (server-authoritative encoding),
// and verifies the client signature. Proves the full client->edge chain.
export class AuthVerifyHandler extends ToilHandler {
    public handle(req: Request): Response {
        if (req.method != Method.POST) return Response.empty(405);
        const r = new DataReader(req.body);
        const sub = r.readString();
        const aud = r.readString();
        const cid = r.readBytes();
        const nonce = r.readBytes();
        const iat = r.readU64();
        const exp = r.readU64();
        const pk = r.readBytes();
        const sig = r.readBytes();
        const msg = AuthService.buildLoginMessage(sub, aud, cid, nonce, iat, exp);
        const ok = AuthService.verifyLogin(pk, msg, sig);
        return Response.text((ok ? '1' : '0') + '\n');
    }
}
