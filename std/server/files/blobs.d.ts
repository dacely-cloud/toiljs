// Generated from server/runtime by scripts/gen-server-types.mjs.
export declare class BlobField {
    name: string;
    value: string;
    constructor(name?: string, value?: string);
}
/** Send these fields first and the file last as multipart/form-data. */
export declare class BlobUpload {
    url: string;
    fields: BlobField[];
    size: f64;
    expiresAt: f64;
}
/** Server-only credentials for a bucket endpoint supporting SigV4 POST policies.
 * The endpoint includes the bucket, e.g. https://bucket.s3.region.amazonaws.com
 * or https://storage.example/bucket. Use credentials limited to this bucket/prefix. */
export declare class BlobStorage {
    readonly endpoint: string;
    readonly bucket: string;
    readonly region: string;
    private accessKey;
    private secretKey;
    readonly prefix: string;
    private sessionToken;
    private origin;
    private host;
    private basePath;
    private cachedDate;
    private cachedKey;
    constructor(endpoint: string, bucket: string, region: string, accessKey: string, secretKey: string, prefix?: string, sessionToken?: string);
    static fromEnvironment(): BlobStorage;
    private key;
    private stamp;
    /** Useful for server-side storage adapters; application ACLs run before signing. */
    presign(method: string, objectKey: string, atMillis: i64, expiresSecs?: i32): string;
    upload(objectKey: string, size: f64, contentType: string, atMillis: i64, expiresSecs?: i32): BlobUpload;
}
/** A typed file namespace. Bytes stream directly between client and storage;
 * keys remain ordinary @data values, with access controlled by application routes. */
export declare class Blobs<K> {
    private namespace;
    private storage;
    constructor(namespace: string, storage?: BlobStorage | null);
    private config;
    private objectKey;
    upload(key: K, size: f64, contentType?: string, expiresSecs?: i32): BlobUpload;
    downloadUrl(key: K, expiresSecs?: i32): string;
    headUrl(key: K, expiresSecs?: i32): string;
    deleteUrl(key: K, expiresSecs?: i32): string;
}
