import { customSection } from '../wasm/sections.js';
import { DbFunctionKind } from './types.js';

export interface RouteKindEntry {
    readonly method: number;
    readonly kind: DbFunctionKind;
    readonly pattern: string;
}

const SECTION = 'toildb.route_kinds';
const VERSION = 1;
const MAX_ROUTES = 2048;
const MAX_PATTERN_BYTES = 2048;

const METHOD_CODES: Readonly<Record<string, number>> = {
    GET: 0,
    POST: 1,
    PUT: 2,
    DELETE: 3,
    PATCH: 4,
    HEAD: 5,
    OPTIONS: 6,
};

export function parseRouteKinds(wasm: Buffer): readonly RouteKindEntry[] {
    let section: Buffer | null;
    try {
        section = customSection(wasm, SECTION);
    } catch {
        return [];
    }
    if (section === null) return [];

    const r = new Reader(section);
    const version = r.u16();
    if (!r.ok || version !== VERSION) return [];
    const count = r.u16();
    if (!r.ok || count > MAX_ROUTES) return [];

    const routes: RouteKindEntry[] = [];
    for (let i = 0; i < count && r.ok; i++) {
        const method = r.u8();
        const kindByte = r.u8();
        const pattern = r.string();
        const kind =
            kindByte === 0 ? DbFunctionKind.Query : kindByte === 1 ? DbFunctionKind.Action : null;
        if (
            !r.ok ||
            method < 0 ||
            method > 6 ||
            kind === null ||
            pattern.length === 0 ||
            !pattern.startsWith('/')
        )
            return [];
        routes.push({ method, kind, pattern });
    }
    if (!r.ok || r.remaining() !== 0) return [];
    return routes;
}

export function routeKindForRequest(
    routes: readonly RouteKindEntry[],
    method: string,
    path: string,
): DbFunctionKind | null {
    const methodCode = METHOD_CODES[method.toUpperCase()];
    if (methodCode === undefined) return null;
    for (const route of routes) {
        if (route.method === methodCode && routeMatches(route.pattern, path)) return route.kind;
    }
    return null;
}

function routeMatches(pattern: string, pathWithQuery: string): boolean {
    const q = pathWithQuery.indexOf('?');
    const path = q >= 0 ? pathWithQuery.slice(0, q) : pathWithQuery;
    const patternSegs = pattern.split('/').filter(Boolean);
    const pathSegs = path.split('/').filter(Boolean);
    if (patternSegs.length !== pathSegs.length) return false;
    for (let i = 0; i < patternSegs.length; i++) {
        const p = patternSegs[i] ?? '';
        const a = pathSegs[i] ?? '';
        if (p.startsWith(':') && p.length > 1 && a.length > 0) continue;
        if (p !== a) return false;
    }
    return true;
}

class Reader {
    private pos = 0;
    ok = true;

    constructor(private readonly bytes: Buffer) {}

    remaining(): number {
        return this.bytes.length - this.pos;
    }

    u8(): number {
        if (!this.ok || this.pos + 1 > this.bytes.length) {
            this.ok = false;
            return 0;
        }
        return this.bytes[this.pos++] ?? 0;
    }

    u16(): number {
        if (!this.ok || this.pos + 2 > this.bytes.length) {
            this.ok = false;
            return 0;
        }
        const out = this.bytes.readUInt16LE(this.pos);
        this.pos += 2;
        return out;
    }

    u32(): number {
        if (!this.ok || this.pos + 4 > this.bytes.length) {
            this.ok = false;
            return 0;
        }
        const out = this.bytes.readUInt32LE(this.pos);
        this.pos += 4;
        return out;
    }

    string(): string {
        const len = this.u32();
        if (!this.ok || len > MAX_PATTERN_BYTES || this.pos + len > this.bytes.length) {
            this.ok = false;
            return '';
        }
        const out = this.bytes.toString('utf8', this.pos, this.pos + len);
        this.pos += len;
        return out;
    }
}
