import fs from 'node:fs';
import path from 'node:path';
import type { Response, Server } from '@dacely/hyper-express';
import { builtContentSecurityPolicy, withSecurityHeaders } from 'toiljs/shared';

/** Covers static assets, preflights, errors and fallback responses as well as HTML. */
export function installSecurityHeaders(app: Server): void {
    app.use((_request, response, next) => {
        for (const [name, value] of withSecurityHeaders([])) response.header(name, value, true);
        next();
    });
}

/** Promote the build's policy to an HTTP header, including on HEAD requests. */
export function sendSecureStaticFile(response: Response, file: string): void {
    if (/^\.html?$/i.test(path.extname(file))) {
        // Read policy and body from the same bytes, including during deploys.
        const body = fs.readFileSync(file);
        const policy = builtContentSecurityPolicy(body.toString('utf8'));
        if (policy !== null) response.header('content-security-policy', policy, true);
        response.header('content-type', 'text/html; charset=utf-8', true);
        response.send(body);
        return;
    }
    response.sendFile(file);
}

/** Security headers replace middleware defaults; repeated Set-Cookie still appends. */
export function writeResponseHeader(response: Response, name: string, value: string): void {
    const lower = name.toLowerCase();
    if (lower === 'content-security-policy' || lower === 'cross-origin-opener-policy') {
        response.header(name, value, true);
    } else {
        response.header(name, value);
    }
}
