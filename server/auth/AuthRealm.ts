import { Server } from 'toiljs/server/runtime';

/** The routed Host, normalized identically for cookies and authentication storage. */
export class AuthRealm {
    static normalize(raw: string): string {
        let host = raw.toLowerCase();
        if (host.startsWith('[')) {
            const close = host.indexOf(']');
            if (close >= 0) host = host.slice(0, close + 1);
        } else {
            const colon = host.lastIndexOf(':');
            if (colon > 0) host = host.slice(0, colon);
        }
        return host;
    }
    static current(): string {
        const req = Server.currentRequest;
        if (req == null) return '';
        const raw = req.header('host');
        return raw == null ? '' : AuthRealm.normalize(raw);
    }
}
