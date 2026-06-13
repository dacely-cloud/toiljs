import { Request, Response, ToilHandler } from 'toiljs/server/runtime';

// AuthService is used with NO import (a global via toilscript --lib).
export class AuthTestHandler extends ToilHandler {
    public handle(req: Request): Response {
        const cid = new Uint8Array(16);
        const nonce = new Uint8Array(32);
        const msg = AuthService.buildLoginMessage('alice', 'toil-demo', cid, nonce, 1000, 2000);
        // Dummy pk/sig -> verify must be false (also exercises the host import binding).
        const pk = new Uint8Array(AuthService.PUBLIC_KEY_LEN);
        const sig = new Uint8Array(AuthService.SIGNATURE_LEN);
        const ok = AuthService.verifyLogin(pk, msg, sig);
        return Response.text('msglen=' + msg.length.toString() + ' verify=' + (ok ? '1' : '0') + '\n');
    }
}
