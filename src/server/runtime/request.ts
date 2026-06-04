/**
 * The incoming HTTP request handed to the user's handler. Decoded
 * from the wire envelope the host wrote at offset 0 of linear
 * memory. See `envelope.ts`.
 */

export enum Method {
    GET = 0,
    POST = 1,
    PUT = 2,
    DELETE = 3,
    PATCH = 4,
    HEAD = 5,
    OPTIONS = 6,
    UNKNOWN = 255,
}

export class Header {
    name: string;
    value: string;

    constructor(name: string, value: string) {
        this.name = name;
        this.value = value;
    }
}

export class Request {
    method: Method;
    path: string;
    headers: Array<Header>;
    body: Uint8Array;

    constructor(
        method: Method,
        path: string,
        headers: Array<Header>,
        body: Uint8Array,
    ) {
        this.method = method;
        this.path = path;
        this.headers = headers;
        this.body = body;
    }

    /**
     * Case-insensitive header lookup. Returns `null` if not present.
     * O(n) over the header list; the request typically carries fewer
     * than a dozen, so the linear scan is the right call.
     */
    header(name: string): string | null {
        const lower = name.toLowerCase();
        for (let i = 0; i < this.headers.length; i++) {
            if (this.headers[i].name.toLowerCase() == lower) {
                return this.headers[i].value;
            }
        }
        return null;
    }
}
