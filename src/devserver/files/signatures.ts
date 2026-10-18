import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

export interface BlobDiskCredentials {
    bucket: string;
    region: string;
    accessKey: string;
    secretKey: string;
    sessionToken?: string;
}
export function awsUri(text: string): string {
    return encodeURIComponent(text).replace(
        /[!'()*]/g,
        (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase(),
    );
}
export function signingKey(config: BlobDiskCredentials, day: string): Buffer {
    const hmac = (key: Buffer | string, text: string) =>
        createHmac('sha256', key).update(text).digest();
    return hmac(
        hmac(hmac(hmac('AWS4' + config.secretKey, day), config.region), 's3'),
        'aws4_request',
    );
}
function checkSignature(signature: string, expected: Buffer): void {
    if (
        !/^[0-9a-f]{64}$/.test(signature) ||
        !timingSafeEqual(Buffer.from(signature, 'hex'), expected)
    )
        throw new Error('Invalid blob signature');
}
function issuedAt(text: string): number {
    if (!/^\d{8}T\d{6}Z$/.test(text)) throw new Error('Invalid blob signing date');
    const iso = `${text.slice(0, 4)}-${text.slice(4, 6)}-${text.slice(6, 8)}T${text.slice(9, 11)}:${text.slice(11, 13)}:${text.slice(13, 15)}.000Z`;
    const millis = Date.parse(iso);
    if (!Number.isFinite(millis) || new Date(millis).toISOString() !== iso)
        throw new Error('Invalid blob signing date');
    return millis;
}
function credential(
    config: BlobDiskCredentials,
    value: string,
    stamp: string,
    token: string | undefined,
): string {
    const scope = `${stamp.slice(0, 8)}/${config.region}/s3/aws4_request`;
    if (value !== config.accessKey + '/' + scope || token !== (config.sessionToken ?? undefined))
        throw new Error('Invalid blob credential');
    return scope;
}
export function verifyBlobUrl(
    method: string,
    url: URL,
    host: string,
    config: BlobDiskCredentials,
    now: number,
): void {
    const fields = new Map<string, string>();
    const allowed = new Set([
        'X-Amz-Algorithm',
        'X-Amz-Credential',
        'X-Amz-Date',
        'X-Amz-Expires',
        'X-Amz-SignedHeaders',
        'X-Amz-Signature',
        'X-Amz-Security-Token',
    ]);
    for (const [key, value] of url.searchParams) {
        if (!allowed.has(key) || fields.has(key)) throw new Error('Invalid blob query');
        fields.set(key, value);
    }
    const get = (name: string): string => {
        const value = fields.get(name);
        if (value === undefined) throw new Error('Missing blob authorization');
        return value;
    };
    const stamp = get('X-Amz-Date'),
        issued = issuedAt(stamp),
        expires = Number(get('X-Amz-Expires'));
    if (
        !/^\d+$/.test(get('X-Amz-Expires')) ||
        !Number.isInteger(expires) ||
        expires < 1 ||
        expires > 604800 ||
        issued > now + 60000 ||
        now > issued + expires * 1000
    )
        throw new Error('Expired blob URL');
    if (get('X-Amz-Algorithm') !== 'AWS4-HMAC-SHA256' || get('X-Amz-SignedHeaders') !== 'host')
        throw new Error('Invalid blob signing algorithm');
    const scope = credential(
        config,
        get('X-Amz-Credential'),
        stamp,
        fields.get('X-Amz-Security-Token'),
    );
    const query = [...fields]
        .filter(([key]) => key !== 'X-Amz-Signature')
        .map(([key, value]) => [awsUri(key), awsUri(value)])
        .sort(([a, av], [b, bv]) => (a < b ? -1 : a > b ? 1 : av < bv ? -1 : av > bv ? 1 : 0))
        .map(([key, value]) => key + '=' + value)
        .join('&');
    const canonical = `${method}\n${url.pathname}\n${query}\nhost:${host}\n\nhost\nUNSIGNED-PAYLOAD`;
    const text = `AWS4-HMAC-SHA256\n${stamp}\n${scope}\n${createHash('sha256').update(canonical).digest('hex')}`;
    checkSignature(
        get('X-Amz-Signature'),
        createHmac('sha256', signingKey(config, stamp.slice(0, 8)))
            .update(text)
            .digest(),
    );
}
export interface VerifiedBlobUpload {
    key: string;
    size: number;
    contentType: string;
}
/** Accept exactly the policy subset emitted by BlobStorage. Unknown conditions
 * fail closed rather than quietly weakening a signed upload restriction. */
export function verifyBlobUpload(
    fields: ReadonlyMap<string, string>,
    config: BlobDiskCredentials,
    now: number,
    maxBytes: number,
): VerifiedBlobUpload {
    const get = (name: string): string => {
        const value = fields.get(name);
        if (value === undefined) throw new Error('Missing blob upload field');
        return value;
    };
    const stamp = get('x-amz-date'),
        issued = issuedAt(stamp);
    credential(config, get('x-amz-credential'), stamp, fields.get('x-amz-security-token'));
    if (
        get('x-amz-algorithm') !== 'AWS4-HMAC-SHA256' ||
        get('success_action_status') !== '204' ||
        get('Content-Disposition') !== 'attachment'
    )
        throw new Error('Invalid blob upload fields');
    const policy = get('policy');
    if (
        policy.length > 12000 ||
        !/^([A-Za-z0-9+/]{4})*([A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(policy)
    )
        throw new Error('Invalid blob policy encoding');
    checkSignature(
        get('x-amz-signature'),
        createHmac('sha256', signingKey(config, stamp.slice(0, 8)))
            .update(policy)
            .digest(),
    );
    const parsed: unknown = JSON.parse(Buffer.from(policy, 'base64').toString('utf8'));
    if (
        typeof parsed !== 'object' ||
        parsed === null ||
        !('expiration' in parsed) ||
        typeof parsed.expiration !== 'string' ||
        !('conditions' in parsed) ||
        !Array.isArray(parsed.conditions)
    )
        throw new Error('Invalid blob policy');
    const expires = Date.parse(parsed.expiration);
    if (
        !Number.isFinite(expires) ||
        issued > now + 60000 ||
        expires < issued ||
        expires > issued + 900000 ||
        now > expires
    )
        throw new Error('Expired blob upload');
    const checked = new Set<string>();
    let size: number | undefined;
    for (const condition of parsed.conditions as unknown[]) {
        if (Array.isArray(condition)) {
            const range = condition as unknown[];
            if (
                size !== undefined ||
                range.length !== 3 ||
                range[0] !== 'content-length-range' ||
                typeof range[1] !== 'number' ||
                range[1] !== range[2] ||
                !Number.isSafeInteger(range[1]) ||
                range[1] < 0 ||
                range[1] > maxBytes
            )
                throw new Error('Invalid blob size condition');
            size = range[1];
            continue;
        }
        if (
            typeof condition !== 'object' ||
            condition === null ||
            Object.keys(condition).length !== 1
        )
            throw new Error('Unsupported blob policy condition');
        const entries: Array<[string, unknown]> = Object.entries(condition);
        const [name, value] = entries[0];
        if (
            checked.has(name) ||
            typeof value !== 'string' ||
            value !== (name === 'bucket' ? config.bucket : fields.get(name))
        )
            throw new Error('Blob upload condition mismatch');
        checked.add(name);
    }
    for (const name of fields.keys())
        if (name !== 'policy' && name !== 'x-amz-signature' && !checked.has(name))
            throw new Error('Unsigned blob upload field');
    if (!checked.has('bucket') || size === undefined)
        throw new Error('Missing blob upload restriction');
    const key = get('key'),
        contentType = get('Content-Type');
    if (
        Buffer.byteLength(key) < 1 ||
        Buffer.byteLength(key) > 1024 ||
        contentType.length < 1 ||
        contentType.length > 128 ||
        /[^\x20-\x7e]/.test(contentType)
    )
        throw new Error('Invalid blob metadata');
    return { key, size, contentType };
}
