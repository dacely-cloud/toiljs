/**
 * Per-request context handed to a `@route` method. Carries the captured path
 * params (`/todos/:id`), the parsed query string, and the raw `Request`. The
 * compiler builds one of these for you and injects it into any route method
 * that declares a `RouteContext` parameter.
 */

import { Request } from '../request';

export class RouteContext {
    /** The raw incoming request (method, path, headers, body). */
    request: Request;

    // Parallel arrays rather than a Map: a route has a handful of params, the
    // linear scan is cheaper than hashing, and it keeps the codec-free runtime small.
    private paramKeys: Array<string>;
    private paramVals: Array<string>;
    private queryKeys: Array<string> | null = null;
    private queryVals: Array<string> | null = null;

    constructor(request: Request, paramKeys: Array<string>, paramVals: Array<string>) {
        this.request = request;
        this.paramKeys = paramKeys;
        this.paramVals = paramVals;
    }

    /** A captured path parameter (`/todos/:id` gives `param("id")`), or "" if absent. */
    param(name: string): string {
        for (let i = 0; i < this.paramKeys.length; i++) {
            if (this.paramKeys[i] == name) return this.paramVals[i];
        }
        return '';
    }

    /** A query-string value (`?q=hi` gives `query("q")`), or "" if absent. Not URL-decoded in v1. */
    query(name: string): string {
        this.ensureQuery();
        const keys = this.queryKeys!;
        const vals = this.queryVals!;
        for (let i = 0; i < keys.length; i++) {
            if (keys[i] == name) return vals[i];
        }
        return '';
    }

    /** Case-insensitive request header, or null. Delegates to `Request.header`. */
    header(name: string): string | null {
        return this.request.header(name);
    }

    /** The raw request body decoded as UTF-8 text (used by the JSON stream codec). */
    text(): string {
        const body = this.request.body;
        if (body.length == 0) return '';
        return String.UTF8.decodeUnsafe(body.dataStart, body.byteLength);
    }

    private ensureQuery(): void {
        if (this.queryKeys != null) return;
        const keys = new Array<string>();
        const vals = new Array<string>();
        const path = this.request.path;
        const q = path.indexOf('?');
        if (q >= 0 && q + 1 < path.length) {
            const pairs = path.substring(q + 1).split('&');
            for (let i = 0; i < pairs.length; i++) {
                const pair = pairs[i];
                if (pair.length == 0) continue;
                const eq = pair.indexOf('=');
                if (eq < 0) {
                    keys.push(pair);
                    vals.push('');
                } else {
                    keys.push(pair.substring(0, eq));
                    vals.push(pair.substring(eq + 1));
                }
            }
        }
        this.queryKeys = keys;
        this.queryVals = vals;
    }
}
