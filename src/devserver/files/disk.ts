import { createHash, randomBytes } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, open, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { join } from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import busboy from 'busboy';
import {
    verifyBlobUpload,
    verifyBlobUrl,
    type BlobDiskCredentials,
    type VerifiedBlobUpload,
} from './signatures.js';

export interface DiskBlobOptions extends BlobDiskCredentials {
    directory: string;
    /** Test/development clock; production storage supplies its own clock. */
    now?: () => number;
    maxBytes?: number;
}
interface Manifest {
    body: string;
    size: number;
    contentType: string;
    etag: string;
    modified: number;
}
export interface DiskBlobServer {
    endpoint: string;
    vars: ReadonlyMap<string, string>;
    secrets: ReadonlyMap<string, string>;
    close(): Promise<void>;
}
/** One strict RFC 7233 byte range. Multiple ranges are intentionally unsupported. */
export function blobRange(header: string, size: number): { start: number; end: number } | null {
    const match = /^bytes=(\d*)-(\d*)$/.exec(header);
    if (match === null || size === 0 || (match[1] === '' && match[2] === '')) return null;
    const first = match[1] === '' ? null : Number(match[1]),
        last = match[2] === '' ? null : Number(match[2]);
    if (
        (first !== null && !Number.isSafeInteger(first)) ||
        (last !== null && !Number.isSafeInteger(last))
    )
        return null;
    if (first === null)
        return last === null || last === 0
            ? null
            : { start: Math.max(0, size - last), end: size - 1 };
    if (first >= size || (last !== null && last < first)) return null;
    return { start: first, end: last === null ? size - 1 : Math.min(last, size - 1) };
}

/** Loopback-only S3 policy emulator for dev. Stream bodies never enter Wasm or
 * the record store. Immutable body generations + an atomic manifest rename
 * keep interrupted replacement uploads from exposing incomplete objects. */
export async function startDiskBlobServer(options: DiskBlobOptions): Promise<DiskBlobServer> {
    const basePath = '/' + awsBucketPath(options.bucket);
    await mkdir(options.directory, { recursive: true });
    const now = options.now ?? Date.now,
        maxBytes = options.maxBytes ?? 1073741824;
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 0 || maxBytes > 1073741824)
        throw new Error('Invalid dev blob size limit');
    const locks = new Map<string, Promise<void>>();
    const pending = new Set<Promise<void>>();
    let activeUploads = 0;
    async function locked<T>(key: string, body: () => Promise<T>): Promise<T> {
        const previous = locks.get(key) ?? Promise.resolve();
        let release: () => void = () => {};
        const current = new Promise<void>((resolve) => {
            release = resolve;
        });
        locks.set(key, current);
        await previous;
        try {
            return await body();
        } finally {
            release();
            if (locks.get(key) === current) locks.delete(key);
        }
    }
    const objectId = (key: string) =>
        createHash('sha256').update(options.bucket).update('\0').update(key).digest('hex');
    const remove = async (path: string): Promise<void> => {
        await unlink(path).catch((error: unknown) => {
            if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT'))
                throw error;
        });
    };
    async function manifest(id: string): Promise<Manifest | null> {
        try {
            const parsed: unknown = JSON.parse(
                await readFile(join(options.directory, id + '.json'), 'utf8'),
            );
            if (
                typeof parsed !== 'object' ||
                parsed === null ||
                !('body' in parsed) ||
                typeof parsed.body !== 'string' ||
                !new RegExp('^' + id + '-[a-f0-9]{32}\\.blob$').test(parsed.body) ||
                !('size' in parsed) ||
                typeof parsed.size !== 'number' ||
                !Number.isSafeInteger(parsed.size) ||
                parsed.size < 0 ||
                parsed.size > maxBytes ||
                !('contentType' in parsed) ||
                typeof parsed.contentType !== 'string' ||
                /[^\x20-\x7e]/.test(parsed.contentType) ||
                parsed.contentType.length > 128 ||
                !('etag' in parsed) ||
                typeof parsed.etag !== 'string' ||
                !/^"[a-f0-9]{64}"$/.test(parsed.etag) ||
                !('modified' in parsed) ||
                typeof parsed.modified !== 'number' ||
                !Number.isFinite(parsed.modified)
            )
                throw new Error('Invalid blob manifest');
            return parsed as Manifest;
        } catch (error) {
            if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return null;
            throw error;
        }
    }
    async function upload(req: IncomingMessage, res: ServerResponse): Promise<void> {
        if (activeUploads >= 4) {
            res.writeHead(503, { 'retry-after': '1' }).end();
            req.resume();
            return;
        }
        const fields = new Map<string, string>();
        const temporary = join(options.directory, '.upload-' + randomBytes(16).toString('hex'));
        let verified: VerifiedBlobUpload | null = null,
            total = 0,
            digest = '';
        let fileCount = 0,
            aborted = false;
        const jobs: Promise<void>[] = [];
        const parser = busboy({
            headers: req.headers,
            limits: {
                fieldSize: 12000,
                fieldNameSize: 128,
                fields: 12,
                files: 1,
                parts: 13,
                fileSize: maxBytes + 1,
                headerPairs: 32,
            },
        });
        activeUploads++;
        const fail = (reason: string): void => {
            parser.destroy(new Error(reason));
        };
        parser.on('field', (name, value, info) => {
            if (fileCount !== 0 || info.nameTruncated || info.valueTruncated || fields.has(name)) {
                fail('Invalid blob fields');
                return;
            }
            fields.set(name, value);
        });
        parser.on('partsLimit', () => fail('Too many blob parts'));
        parser.on('fieldsLimit', () => fail('Too many blob fields'));
        parser.on('filesLimit', () => fail('Too many blob files'));
        parser.on('file', (name, file) => {
            file.on('error', () => {});
            fileCount++;
            try {
                if (name !== 'file' || fileCount !== 1) throw new Error('Invalid blob file field');
                verified = verifyBlobUpload(fields, options, now(), maxBytes);
            } catch (error) {
                file.resume();
                parser.destroy(error instanceof Error ? error : new Error('Invalid blob upload'));
                return;
            }
            const expected = verified.size;
            const hash = createHash('sha256');
            const guard = new Transform({
                transform(chunk: Buffer, _encoding, callback) {
                    total += chunk.length;
                    if (total > expected) {
                        callback(new Error('Blob exceeds declared size'));
                        return;
                    }
                    hash.update(chunk);
                    callback(null, chunk);
                },
                flush(callback) {
                    if (total !== expected || file.truncated) {
                        callback(new Error('Incomplete blob'));
                        return;
                    }
                    digest = '"' + hash.digest('hex') + '"';
                    callback();
                },
            });
            const job = pipeline(
                file,
                guard,
                createWriteStream(temporary, { flags: 'wx', mode: 0o600 }),
            );
            jobs.push(job);
            void job.catch((error: unknown) => {
                aborted = true;
                parser.destroy(error instanceof Error ? error : new Error('Blob stream failed'));
            });
        });
        try {
            await pipeline(req, parser);
            await Promise.all(jobs);
            // Assigned in the file event, which has completed before parser EOF.
            const accepted = verified as VerifiedBlobUpload | null;
            if (aborted || accepted === null || fileCount !== 1 || digest === '')
                throw new Error('Missing or incomplete blob');
            const id = objectId(accepted.key);
            await locked(id, async () => {
                const old = await manifest(id);
                const body = id + '-' + randomBytes(16).toString('hex') + '.blob';
                const path = join(options.directory, body),
                    manifestTemp = path + '.json';
                let committed = false;
                try {
                    await rename(temporary, path);
                    const data: Manifest = {
                        body,
                        size: total,
                        contentType: accepted.contentType,
                        etag: digest,
                        modified: now(),
                    };
                    await writeFile(manifestTemp, JSON.stringify(data), {
                        flag: 'wx',
                        mode: 0o600,
                    });
                    await rename(manifestTemp, join(options.directory, id + '.json'));
                    committed = true;
                } finally {
                    if (!committed) await remove(path);
                    await remove(manifestTemp);
                }
                if (old !== null) await remove(join(options.directory, old.body)).catch(() => {});
            });
            res.writeHead(204, { etag: digest }).end();
        } finally {
            activeUploads--;
            if (!parser.destroyed) parser.destroy();
            await Promise.allSettled(jobs);
            await remove(temporary);
        }
    }
    const server = createServer((req, res) => {
        let failureStatus = 500;
        const work = (async () => {
            res.setHeader('access-control-allow-origin', '*');
            res.setHeader('access-control-allow-methods', 'GET, HEAD, POST, DELETE, OPTIONS');
            res.setHeader(
                'access-control-allow-headers',
                'Range, Content-Type, If-Range, If-Match',
            );
            res.setHeader(
                'access-control-expose-headers',
                'ETag, Content-Range, Content-Length, Content-Type, Accept-Ranges',
            );
            res.setHeader('x-content-type-options', 'nosniff');
            res.setHeader('content-security-policy', "default-src 'none'; sandbox");
            res.setHeader('cache-control', 'private, no-store');
            const url = new URL(req.url ?? '/', endpoint);
            if (req.method === 'OPTIONS') {
                res.writeHead(204).end();
                return;
            }
            if (req.method === 'POST' && url.pathname === basePath && url.search === '') {
                failureStatus = 400;
                await upload(req, res);
                return;
            }
            if (
                !['GET', 'HEAD', 'DELETE'].includes(req.method ?? '') ||
                !url.pathname.startsWith(basePath + '/')
            ) {
                res.writeHead(404).end();
                req.resume();
                return;
            }
            failureStatus = 403;
            verifyBlobUrl(req.method ?? '', url, req.headers.host ?? '', options, now());
            failureStatus = 500;
            const key = decodeURIComponent(url.pathname.slice(basePath.length + 1));
            if (Buffer.byteLength(key) < 1 || Buffer.byteLength(key) > 1024)
                throw new Error('Invalid blob key');
            const id = objectId(key);
            if (req.method === 'DELETE') {
                await locked(id, async () => {
                    const old = await manifest(id);
                    await remove(join(options.directory, id + '.json'));
                    if (old !== null)
                        await remove(join(options.directory, old.body)).catch(() => {});
                });
                res.writeHead(204).end();
                return;
            }
            const data = await manifest(id);
            if (data === null) {
                res.writeHead(404).end();
                return;
            }
            if (req.headers['if-match'] !== undefined && req.headers['if-match'] !== data.etag) {
                res.writeHead(412).end();
                return;
            }
            const handle = await open(join(options.directory, data.body), 'r').catch(
                (error: unknown) => {
                    if (error instanceof Error && 'code' in error && error.code === 'ENOENT')
                        return null;
                    throw error;
                },
            );
            if (handle === null) {
                res.writeHead(404).end();
                return;
            }
            let ownsHandle = true;
            try {
                res.setHeader('content-type', data.contentType);
                res.setHeader('content-disposition', 'attachment');
                res.setHeader('etag', data.etag);
                res.setHeader('last-modified', new Date(data.modified).toUTCString());
                res.setHeader('accept-ranges', 'bytes');
                let range: { start: number; end: number } | undefined;
                if (
                    req.method === 'GET' &&
                    req.headers.range !== undefined &&
                    (req.headers['if-range'] === undefined || req.headers['if-range'] === data.etag)
                ) {
                    const parsed = blobRange(req.headers.range, data.size);
                    if (parsed === null) {
                        res.writeHead(416, { 'content-range': `bytes */${data.size}` }).end();
                        return;
                    }
                    range = parsed;
                    res.setHeader(
                        'content-range',
                        `bytes ${range.start}-${range.end}/${data.size}`,
                    );
                }
                res.setHeader(
                    'content-length',
                    range === undefined ? data.size : range.end - range.start + 1,
                );
                if (req.method === 'HEAD') {
                    res.writeHead(200).end();
                    return;
                }
                res.writeHead(range === undefined ? 200 : 206);
                const stream = createReadStream(join(options.directory, data.body), {
                    fd: handle.fd,
                    autoClose: false,
                    ...range,
                });
                ownsHandle = false;
                try {
                    await pipeline(stream, res);
                } finally {
                    await handle.close();
                }
            } finally {
                if (ownsHandle) await handle.close();
            }
        })();
        pending.add(work);
        void work
            .catch(() => {
                if (!res.headersSent && !res.destroyed) res.writeHead(failureStatus).end();
                else if (!res.destroyed) res.destroy();
                req.resume();
            })
            .finally(() => pending.delete(work));
    });
    server.requestTimeout = 300000;
    // Dev is deliberately loopback-only; use a configured HTTPS S3 endpoint for remote clients.
    await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => {
            server.off('error', reject);
            resolve();
        });
    });
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('Missing blob listener');
    const endpoint = `http://127.0.0.1:${address.port}${basePath}`;
    return {
        endpoint,
        vars: new Map([
            ['BLOB_ENDPOINT', endpoint],
            ['BLOB_BUCKET', options.bucket],
            ['BLOB_REGION', options.region],
            ['BLOB_PREFIX', ''],
        ]),
        secrets: new Map([
            ['BLOB_ACCESS_KEY_ID', options.accessKey],
            ['BLOB_SECRET_ACCESS_KEY', options.secretKey],
            ...(options.sessionToken === undefined
                ? []
                : [['BLOB_SESSION_TOKEN', options.sessionToken] as [string, string]]),
        ]),
        async close() {
            const closed = new Promise<void>((resolve, reject) =>
                server.close((error) => (error === undefined ? resolve() : reject(error))),
            );
            server.closeAllConnections();
            await closed;
            await Promise.allSettled(pending);
        },
    };
}
function awsBucketPath(bucket: string): string {
    if (!/^[a-z0-9][a-z0-9.-]{0,62}$/.test(bucket) || bucket === '.' || bucket === '..')
        throw new Error('Invalid dev blob bucket');
    return bucket;
}
