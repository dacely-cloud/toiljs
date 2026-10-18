import { Environment } from '../../globals/environment';
import { HmacImportParams, HmacParams, ALG_SHA_256, FMT_RAW, USAGE_SIGN } from 'crypto';
import { base64UrlEncode } from '../http/base64';

function utf8(text: string): Uint8Array {
    return Uint8Array.wrap(String.UTF8.encode(text));
}
function hmac(key: Uint8Array, text: string): Uint8Array {
    const imported = crypto.subtle.importKey(
        FMT_RAW,
        key,
        new HmacImportParams(ALG_SHA_256),
        false,
        USAGE_SIGN,
    );
    return crypto.subtle.sign(new HmacParams(), imported, utf8(text));
}
function uri(text: string): string {
    return encodeURIComponent(text)
        .replaceAll('!', '%21')
        .replaceAll("'", '%27')
        .replaceAll('(', '%28')
        .replaceAll(')', '%29')
        .replaceAll('*', '%2A');
}
function pathUri(text: string): string {
    const parts = text.split('/');
    for (let i = 0; i < parts.length; i++) {
        if (parts[i] == '.' || parts[i] == '..') throw new Error('Invalid blob path');
        parts[i] = uri(parts[i]);
    }
    return parts.join('/');
}
function safePath(text: string, allowSlash: bool): bool {
    for (let i = 0; i < text.length; i++) {
        const c = text.charCodeAt(i);
        if (
            (c >= 48 && c <= 57) ||
            (c >= 65 && c <= 90) ||
            (c >= 97 && c <= 122) ||
            c == 45 ||
            c == 95 ||
            (allowSlash && (c == 47 || c == 46 || c == 126))
        )
            continue;
        return false;
    }
    return true;
}
function required(name: string, secure: bool = false): string {
    const value = secure ? Environment.getSecure(name) : Environment.get(name);
    if (value == null || value.length == 0)
        throw new Error('Blob storage is not configured: ' + name);
    return value;
}
function ttl(seconds: i32): void {
    if (seconds < 1 || seconds > 900) throw new Error('Blob URL lifetime must be 1..900 seconds');
}

@data
export class BlobField {
    name: string = '';
    value: string = '';
    constructor(name: string = '', value: string = '') {
        this.name = name;
        this.value = value;
    }
}

/** Send these fields first and the file last as multipart/form-data. */
@data
export class BlobUpload {
    url: string = '';
    fields: BlobField[] = [];
    size: f64 = 0;
    expiresAt: f64 = 0;
}

/** Server-only credentials for a bucket endpoint supporting SigV4 POST policies.
 * The endpoint includes the bucket, e.g. https://bucket.s3.region.amazonaws.com
 * or https://storage.example/bucket. Use credentials limited to this bucket/prefix. */
export class BlobStorage {
    private origin: string = '';
    private host: string = '';
    private basePath: string = '';
    private cachedDate: string = '';
    private cachedKey: Uint8Array = new Uint8Array(0);
    constructor(
        public readonly endpoint: string,
        public readonly bucket: string,
        public readonly region: string,
        private accessKey: string,
        private secretKey: string,
        public readonly prefix: string = '',
        private sessionToken: string = '',
    ) {
        while (endpoint.endsWith('/')) endpoint = endpoint.slice(0, endpoint.length - 1);
        this.endpoint = endpoint;
        const scheme = endpoint.startsWith('https://')
            ? 8
            : endpoint.startsWith('http://127.0.0.1:')
              ? 7
              : 0;
        if (scheme == 0)
            throw new Error('Blob endpoint must use HTTPS (loopback HTTP is allowed in dev)');
        const slash = endpoint.indexOf('/', scheme);
        this.origin = slash < 0 ? endpoint : endpoint.slice(0, slash);
        this.host = this.origin.slice(scheme);
        this.basePath = slash < 0 ? '' : endpoint.slice(slash);
        if (this.host != this.host.toLowerCase() || this.host.length == 0 || this.host.length > 260)
            throw new Error('Invalid blob endpoint host');
        for (let i = 0; i < this.host.length; i++) {
            const c = this.host.charCodeAt(i);
            if (!((c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c == 45 || c == 46 || c == 58))
                throw new Error('Invalid blob endpoint host');
        }
        if (
            !safePath(this.basePath, true) ||
            !safePath(prefix, true) ||
            prefix.length > 256 ||
            prefix.startsWith('/') ||
            prefix.endsWith('/') ||
            prefix.includes('//')
        )
            throw new Error('Invalid blob prefix or endpoint path');
        pathUri(this.basePath);
        pathUri(prefix);
        if (
            endpoint.length > 1024 ||
            sessionToken.length > 4096 ||
            accessKey.length > 128 ||
            secretKey.length > 1024 ||
            region.length > 64
        )
            throw new Error('Blob configuration exceeds size limits');
        if (
            bucket.length == 0 ||
            bucket.length > 63 ||
            bucket.includes('/') ||
            bucket.includes('"') ||
            region.length == 0 ||
            !safePath(region, false) ||
            accessKey.length == 0 ||
            accessKey.includes('/') ||
            secretKey.length == 0
        )
            throw new Error('Invalid blob credentials');
    }
    static fromEnvironment(): BlobStorage {
        const prefix = Environment.get('BLOB_PREFIX');
        const token = Environment.getSecure('BLOB_SESSION_TOKEN');
        return new BlobStorage(
            required('BLOB_ENDPOINT'),
            required('BLOB_BUCKET'),
            required('BLOB_REGION'),
            required('BLOB_ACCESS_KEY_ID', true),
            required('BLOB_SECRET_ACCESS_KEY', true),
            prefix == null ? '' : prefix,
            token == null ? '' : token,
        );
    }
    private key(date: string): Uint8Array {
        if (this.cachedDate != date) {
            this.cachedKey = hmac(
                hmac(hmac(hmac(utf8('AWS4' + this.secretKey), date), this.region), 's3'),
                'aws4_request',
            );
            this.cachedDate = date;
        }
        return this.cachedKey;
    }
    private stamp(atMillis: i64): string {
        const iso = new Date(atMillis).toISOString();
        if (iso.length != 24) throw new Error('Invalid blob signing clock');
        return iso.slice(0, 19).replaceAll('-', '').replaceAll(':', '') + 'Z';
    }
    /** Useful for server-side storage adapters; application ACLs run before signing. */
    presign(method: string, objectKey: string, atMillis: i64, expiresSecs: i32 = 60): string {
        if (expiresSecs < 1 || expiresSecs > 604800) throw new Error('Invalid blob URL lifetime');
        if (method != 'GET' && method != 'HEAD' && method != 'DELETE')
            throw new Error('Invalid blob URL method');
        if (objectKey.length == 0 || utf8(objectKey).length > 1024)
            throw new Error('Invalid blob object key');
        const date = this.stamp(atMillis),
            day = date.slice(0, 8);
        const scope = day + '/' + this.region + '/s3/aws4_request';
        const fields = new Array<string>();
        fields.push('X-Amz-Algorithm=AWS4-HMAC-SHA256');
        fields.push('X-Amz-Credential=' + uri(this.accessKey + '/' + scope));
        fields.push('X-Amz-Date=' + date);
        fields.push('X-Amz-Expires=' + expiresSecs.toString());
        if (this.sessionToken.length > 0)
            fields.push('X-Amz-Security-Token=' + uri(this.sessionToken));
        fields.push('X-Amz-SignedHeaders=host');
        const query = fields.join('&');
        const path = this.basePath + '/' + pathUri(objectKey);
        const canonical =
            method +
            '\n' +
            path +
            '\n' +
            query +
            '\nhost:' +
            this.host +
            '\n\nhost\nUNSIGNED-PAYLOAD';
        const toSign =
            'AWS4-HMAC-SHA256\n' +
            date +
            '\n' +
            scope +
            '\n' +
            crypto.toHex(crypto.sha256(utf8(canonical)));
        return (
            this.origin +
            path +
            '?' +
            query +
            '&X-Amz-Signature=' +
            crypto.toHex(hmac(this.key(day), toSign))
        );
    }
    upload(
        objectKey: string,
        size: f64,
        contentType: string,
        atMillis: i64,
        expiresSecs: i32 = 300,
    ): BlobUpload {
        ttl(expiresSecs);
        if (size < 0 || size > 1073741824 || Math.floor(size) != size || !isFinite(size))
            throw new Error('Blob upload size must be 0..1 GiB');
        if (contentType.length == 0 || contentType.length > 128 || !contentType.includes('/'))
            throw new Error('Invalid blob content type');
        for (let i = 0; i < contentType.length; i++) {
            const c = contentType.charCodeAt(i);
            if (c < 32 || c > 126) throw new Error('Invalid blob content type');
        }
        if (objectKey.length == 0 || utf8(objectKey).length > 1024)
            throw new Error('Invalid blob object key');
        const date = this.stamp(atMillis),
            day = date.slice(0, 8),
            scope = day + '/' + this.region + '/s3/aws4_request';
        const ticket = new BlobUpload();
        ticket.url = this.endpoint;
        ticket.size = size;
        ticket.expiresAt = <f64>(atMillis + <i64>expiresSecs * 1000);
        ticket.fields.push(new BlobField('key', objectKey));
        ticket.fields.push(new BlobField('Content-Type', contentType));
        ticket.fields.push(new BlobField('Content-Disposition', 'attachment'));
        ticket.fields.push(new BlobField('success_action_status', '204'));
        ticket.fields.push(new BlobField('x-amz-algorithm', 'AWS4-HMAC-SHA256'));
        ticket.fields.push(new BlobField('x-amz-credential', this.accessKey + '/' + scope));
        ticket.fields.push(new BlobField('x-amz-date', date));
        if (this.sessionToken.length > 0)
            ticket.fields.push(new BlobField('x-amz-security-token', this.sessionToken));
        let conditions = '{"bucket":' + JSON.stringify<string>(this.bucket) + '}';
        for (let i = 0; i < ticket.fields.length; i++) {
            const field = ticket.fields[i];
            conditions +=
                ',{' +
                JSON.stringify<string>(field.name) +
                ':' +
                JSON.stringify<string>(field.value) +
                '}';
        }
        conditions +=
            ',["content-length-range",' +
            (<u64>size).toString() +
            ',' +
            (<u64>size).toString() +
            ']';
        const policyText =
            '{"expiration":' +
            JSON.stringify<string>(new Date(atMillis + <i64>expiresSecs * 1000).toISOString()) +
            ',"conditions":[' +
            conditions +
            ']}';
        let policy = base64UrlEncode(utf8(policyText)).replaceAll('-', '+').replaceAll('_', '/');
        while (policy.length % 4 != 0) policy += '=';
        ticket.fields.push(new BlobField('policy', policy));
        ticket.fields.push(
            new BlobField('x-amz-signature', crypto.toHex(hmac(this.key(day), policy))),
        );
        return ticket;
    }
}

/** A typed file namespace. Bytes stream directly between client and storage;
 * keys remain ordinary @data values, with access controlled by application routes. */
export class Blobs<K> {
    private storage: BlobStorage | null;
    constructor(
        private namespace: string,
        storage: BlobStorage | null = null,
    ) {
        if (namespace.length == 0 || namespace.length > 64 || !safePath(namespace, false))
            throw new Error('Invalid blob namespace');
        this.storage = storage;
    }
    private config(): BlobStorage {
        let storage = this.storage;
        if (storage == null) {
            storage = BlobStorage.fromEnvironment();
            this.storage = storage;
        }
        return storage;
    }
    private objectKey(key: K): string {
        const storage = this.config();
        const prefix = storage.prefix.length == 0 ? '' : storage.prefix + '/';
        const bytes = key.encode();
        if (bytes.length > 4096) throw new Error('Encoded blob key exceeds 4096 bytes');
        return prefix + this.namespace + '/' + crypto.toHex(crypto.sha256(bytes));
    }
    upload(
        key: K,
        size: f64,
        contentType: string = 'application/octet-stream',
        expiresSecs: i32 = 300,
    ): BlobUpload {
        return this.config().upload(
            this.objectKey(key),
            size,
            contentType,
            Date.now(),
            expiresSecs,
        );
    }
    downloadUrl(key: K, expiresSecs: i32 = 60): string {
        ttl(expiresSecs);
        return this.config().presign('GET', this.objectKey(key), Date.now(), expiresSecs);
    }
    headUrl(key: K, expiresSecs: i32 = 60): string {
        ttl(expiresSecs);
        return this.config().presign('HEAD', this.objectKey(key), Date.now(), expiresSecs);
    }
    deleteUrl(key: K, expiresSecs: i32 = 60): string {
        ttl(expiresSecs);
        return this.config().presign('DELETE', this.objectKey(key), Date.now(), expiresSecs);
    }
}
