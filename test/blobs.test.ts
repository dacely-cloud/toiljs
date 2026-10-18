import { spawnSync } from 'node:child_process';
import { createHash, createHmac } from 'node:crypto';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { startDevBlobStorage } from '../src/devserver/files/dev.js';
import { devEnvGet, devEnvGetSecure } from '../src/devserver/config/env.js';
import {
    startDiskBlobServer,
    blobRange,
    type DiskBlobServer,
} from '../src/devserver/files/disk.js';
import { WasmServerModule } from '../src/devserver/runtime/module.js';
import {
    uploadBlob,
    uploadBlobStream,
    readBlob,
    deleteBlob,
    type BlobUploadTicket,
} from '../src/client/files.js';

const root = mkdtempSync(join(tmpdir(), 'toil-blobs-'));
let store: DiskBlobServer;
let module: WasmServerModule;
const secret = 'public-test-secret-do-not-use';
const request = (path: string) => ({ method: 'POST', path, headers: [], body: new Uint8Array() });
function text(path: string): string {
    return new TextDecoder().decode(module.dispatch(request(path)).body);
}
function ticket(size: number): BlobUploadTicket {
    return JSON.parse(text('/upload/' + size)) as BlobUploadTicket;
}
function compile(source: string, out: string): void {
    writeFileSync(join(root, 'app.ts'), source);
    const compiled = spawnSync(
        process.execPath,
        [
            process.env.TOILSCRIPT_TEST_BIN ?? resolve('node_modules/toilscript/bin/toilscript.js'),
            'app.ts',
            '-o',
            out,
            '--runtime',
            'stub',
            '--memoryBase',
            '65536',
        ],
        { cwd: root, encoding: 'utf8' },
    );
    expect(compiled.status, compiled.stdout + compiled.stderr).toBe(0);
}
beforeAll(async () => {
    store = await startDiskBlobServer({
        directory: join(root, 'objects'),
        bucket: 'toil-dev',
        region: 'us-east-1',
        accessKey: 'test-access',
        secretKey: secret,
        sessionToken: 'test-token+/=%',
    });
    mkdirSync(join(root, 'node_modules'));
    symlinkSync(resolve('.'), join(root, 'node_modules/toiljs'));
    compile(
        `
import { Blobs, BlobStorage, Server, Response, Request, ToilHandler } from 'toiljs/server/runtime';
@data class Key { name:string='file'; constructor(name:string='file'){this.name=name;} }
const config=new BlobStorage('${store.endpoint}','toil-dev','us-east-1','test-access','${secret}','tenant','test-token+/=%');
const files=new Blobs<Key>('photos',config);
const automatic=new Blobs<Key>('default');
class Handler extends ToilHandler {
  handle(req:Request):Response {
    if(req.path.startsWith('/auto-upload/'))return Response.data(automatic.upload(new Key(),parseFloat(req.path.slice(13))));
    if(req.path=='/auto-get')return Response.text(automatic.downloadUrl(new Key()));
    if(req.path=='/special-upload')return Response.data(config.upload("tenant/photos/é !'()*%😀.bin",3,'application/octet-stream',Date.now()));
    if(req.path=='/special-get')return Response.text(config.presign('GET',"tenant/photos/é !'()*%😀.bin",Date.now()));
    if(req.path.startsWith('/upload/'))return Response.data(files.upload(new Key(),parseFloat(req.path.slice(8)),'image/jpeg'));
    if(req.path=='/delete')return Response.text(files.deleteUrl(new Key()));
    if(req.path=='/head')return Response.text(files.headUrl(new Key()));
    if(req.path=='/other')return Response.text(files.downloadUrl(new Key('other')));
    if(req.path=='/aws') {
      const aws=new BlobStorage('https://examplebucket.s3.amazonaws.com','examplebucket','us-east-1','AKIAIOSFODNN7EXAMPLE','wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY');
      return Response.text(aws.presign('GET','test.txt',1369353600000,86400));
    }
    return Response.text(files.downloadUrl(new Key()));
  }
}
Server.handler=():ToilHandler=>new Handler();
export * from 'toiljs/server/runtime/exports';
`,
        join(root, 'app.wasm'),
    );
    module = new WasmServerModule(join(root, 'app.wasm'));
    module.refresh();
});
afterAll(async () => {
    await store?.close();
    rmSync(root, { recursive: true, force: true });
});
it('matches the independently published AWS query-signature vector', () => {
    const url = new URL(text('/aws'));
    expect(url.searchParams.get('X-Amz-Date')).toBe('20130524T000000Z');
    expect(url.searchParams.get('X-Amz-Signature')).toBe(
        'aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404',
    );
});
it('signs an exact-size POST policy with independently calculated HMAC', () => {
    const signed = ticket(9),
        fields = Object.fromEntries(signed.fields.map((field) => [field.name, field.value]));
    const hmac = (key: Buffer | string, message: string) =>
        createHmac('sha256', key).update(message).digest();
    const day = fields['x-amz-date'].slice(0, 8);
    const key = hmac(hmac(hmac(hmac('AWS4' + secret, day), 'us-east-1'), 's3'), 'aws4_request');
    expect(fields['x-amz-signature']).toBe(hmac(key, fields.policy).toString('hex'));
    expect(JSON.parse(Buffer.from(fields.policy, 'base64').toString()).conditions).toContainEqual([
        'content-length-range',
        9,
        9,
    ]);
});
it('streams an upload beyond DB limits, supports ranges and replaces atomically', async () => {
    const size = 16 * 1024 * 1024 + 17;
    let generated = 0;
    const source = new ReadableStream<Uint8Array>({
        pull(controller) {
            const n = Math.min(16384, size - generated);
            if (n === 0) {
                controller.close();
                return;
            }
            const chunk = Uint8Array.from({ length: n }, (_, i) => (generated + i) % 251);
            generated += n;
            controller.enqueue(chunk);
        },
    });
    await uploadBlobStream(ticket(size), source);
    const response = await readBlob(text('/get'), { start: 1048571, end: 1048590 });
    expect(response.status).toBe(206);
    expect(response.headers.get('content-range')).toBe(`bytes 1048571-1048590/${size}`);
    expect([...new Uint8Array(await response.arrayBuffer())]).toEqual(
        Array.from({ length: 20 }, (_, i) => (1048571 + i) % 251),
    );
    const head = await fetch(text('/head'), { method: 'HEAD' });
    expect(head.headers.get('content-length')).toBe(String(size));
    const full = await readBlob(text('/get'));
    const digest = createHash('sha256');
    let downloaded = 0;
    for await (const chunk of full.body!) {
        downloaded += chunk.length;
        digest.update(chunk);
    }
    expect(downloaded).toBe(size);
    expect(full.headers.get('etag')).toBe('"' + digest.digest('hex') + '"');
    await uploadBlob(ticket(3), new Blob(['new']));
    expect(await (await readBlob(text('/get'))).text()).toBe('new');
});
it('rejects tampering, method changes, oversized bodies, and partial uploads without replacing a file', async () => {
    await uploadBlob(ticket(4), new Blob(['kept']));
    const signed = ticket(4);
    const fields = signed.fields.map((field) =>
        field.name === 'key' ? { ...field, value: field.value + '-other' } : field,
    );
    await expect(uploadBlob({ ...signed, fields }, new Blob(['evil']))).rejects.toThrow();
    const badBody = new FormData();
    for (const field of signed.fields) badBody.append(field.name, field.value);
    badBody.append('file', new Blob(['too large']), 'blob');
    try {
        const result = await fetch(signed.url, { method: 'POST', body: badBody });
        expect(result.ok).toBe(false);
    } catch {
        /* streaming rejection can close the request socket */
    }
    const broken = new ReadableStream<Uint8Array>({
        start(controller) {
            controller.enqueue(new TextEncoder().encode('bad'));
            controller.error(new Error('interrupted'));
        },
    });
    await expect(uploadBlobStream(signed, broken)).rejects.toThrow();
    expect(await (await readBlob(text('/get'))).text()).toBe('kept');
    const get = text('/get');
    expect((await fetch(get, { method: 'DELETE' })).status).toBe(403);
    const changed = new URL(get);
    changed.searchParams.set('X-Amz-Expires', '604800');
    expect((await fetch(changed)).status).toBe(403);
    expect((await fetch(text('/other'))).status).toBe(404);
});
it('returns suffix/unsatisfied ranges and deletes through a separately authorized URL', async () => {
    await uploadBlob(ticket(6), new Blob(['abcdef']));
    const url = text('/get');
    const suffix = await fetch(url, { headers: { Range: 'bytes=-2' } });
    expect(suffix.status).toBe(206);
    expect(await suffix.text()).toBe('ef');
    const bad = await fetch(url, { headers: { Range: 'bytes=6-' } });
    expect(bad.status).toBe(416);
    expect(bad.headers.get('content-range')).toBe('bytes */6');
    const fallback = await fetch(url, { headers: { Range: 'bytes=2-3', 'If-Range': '"old"' } });
    expect(fallback.status).toBe(200);
    expect(await fallback.text()).toBe('abcdef');
    await deleteBlob(text('/delete'));
    expect((await fetch(text('/get'))).status).toBe(404);
});
it('bounds range parsing without integer truncation', () => {
    expect(blobRange('bytes=1-999', 6)).toEqual({ start: 1, end: 5 });
    for (const value of [
        'bytes=-0',
        'bytes=9-2',
        'bytes=999999999999999999999999999-',
        'bytes=1-2,4-5',
        'items=0-1',
    ])
        expect(blobRange(value, 6)).toBeNull();
    expect(blobRange('bytes=0-', 0)).toBeNull();
});

it('preserves UTF-8 and reserved object-key bytes in signed paths', async () => {
    const signed = JSON.parse(text('/special-upload')) as BlobUploadTicket;
    await uploadBlob(signed, new Blob(['utf']));
    const url = text('/special-get');
    expect(url).toContain('%C3%A9%20%21%27%28%29%2A%25%F0%9F%98%80.bin');
    expect(await (await readBlob(url)).text()).toBe('utf');
});
it('cancels an upload source when fetch is aborted and retains the existing object', async () => {
    await uploadBlob(ticket(4), new Blob(['kept']));
    const controller = new AbortController();
    let pulls = 0,
        cancelled = false;
    let release: () => void = () => {};
    const paused = new Promise<void>((resolve) => {
        release = resolve;
    });
    const source = new ReadableStream<Uint8Array>({
        pull(stream) {
            if (pulls++ === 0) stream.enqueue(new Uint8Array(65536));
            else return paused;
        },
        cancel() {
            cancelled = true;
            release();
        },
    });
    const uploading = uploadBlobStream(ticket(1048576), source, controller.signal);
    const rejected = expect(uploading).rejects.toThrow();
    await expect.poll(() => pulls).toBeGreaterThan(1);
    controller.abort();
    try {
        await rejected;
        expect(cancelled).toBe(true);
    } finally {
        release();
    }
    expect(await (await readBlob(text('/get'))).text()).toBe('kept');
});
it('provides isolated dev credentials and persists objects across adapter restarts', async () => {
    const folder = join(root, 'automatic');
    let running = await startDevBlobStorage(folder);
    try {
        expect(running).not.toBeNull();
        expect(devEnvGet('BLOB_SECRET_ACCESS_KEY')).toBeNull();
        expect(devEnvGetSecure('BLOB_SECRET_ACCESS_KEY')).not.toBeNull();
        const signed = JSON.parse(text('/auto-upload/7')) as BlobUploadTicket;
        expect(JSON.stringify(signed)).not.toContain(devEnvGetSecure('BLOB_SECRET_ACCESS_KEY'));
        await uploadBlob(signed, new Blob(['persist']));
        await running!.close();
        running = await startDevBlobStorage(folder);
        expect(await (await readBlob(text('/auto-get'))).text()).toBe('persist');
    } finally {
        await running?.close();
    }
    expect(devEnvGetSecure('BLOB_SECRET_ACCESS_KEY')).toBeNull();
});
