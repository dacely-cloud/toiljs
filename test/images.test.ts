import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import sharp from 'sharp';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { WasmServerModule } from '../src/devserver/runtime/module.js';
import { buildImageImports, freshImageState } from '../src/devserver/images/index.js';
import { DbFunctionKind } from '../src/devserver/db/types.js';

const root = mkdtempSync(join(tmpdir(), 'toil-images-'));
let module: WasmServerModule;
let png: Buffer, jpeg: Buffer;
beforeAll(async () => {
    mkdirSync(join(root, 'node_modules'));
    symlinkSync(resolve('.'), join(root, 'node_modules/toiljs'));
    const source = `
import { Images, Server, Response, Request, ToilHandler } from 'toiljs/server/runtime';
class Handler extends ToilHandler {
  handle(request:Request):Response {
    let result=request.path=='/resize'?Images.resize(request.body,3,3):request.path=='/thumbnail'?Images.thumbnail(request.body,2,2):Images.stripExif(request.body);
    if(request.path=='/twice')result=Images.stripExif(request.body);
    if(!result.ok)return Response.text((<i32>result.error).toString(),422);
    const response=Response.bytes(result.bytes,200,result.contentType);
    response.setHeader('x-width',result.width.toString());response.setHeader('x-height',result.height.toString());
    return response;
  }
}
Server.handler=():ToilHandler=>new Handler();
export * from 'toiljs/server/runtime/exports';
`;
    writeFileSync(join(root, 'app.ts'), source);
    const compiled = spawnSync(
        process.execPath,
        [
            process.env.TOILSCRIPT_TEST_BIN ?? resolve('node_modules/toilscript/bin/toilscript.js'),
            'app.ts',
            '-o',
            join(root, 'app.wasm'),
            '--runtime',
            'stub',
            '--memoryBase',
            '65536',
        ],
        { cwd: root, encoding: 'utf8' },
    );
    expect(compiled.status, compiled.stdout + compiled.stderr).toBe(0);
    module = new WasmServerModule(join(root, 'app.wasm'));
    module.refresh();
    const raw = Buffer.alloc(8 * 4 * 4);
    for (let y = 0; y < 4; y++)
        for (let x = 0; x < 8; x++) {
            const color =
                y < 2
                    ? x < 4
                        ? [255, 0, 0, 255]
                        : [0, 255, 0, 255]
                    : x < 4
                      ? [0, 0, 255, 255]
                      : [255, 255, 255, 255];
            raw.set(color, (y * 8 + x) * 4);
        }
    png = await sharp(raw, { raw: { width: 8, height: 4, channels: 4 } })
        .png()
        .withMetadata({
            orientation: 6,
            exif: { IFD0: { ImageDescription: 'private-location-and-camera' } },
        })
        .toBuffer();
    jpeg = await sharp({
        create: { width: 36, height: 20, channels: 3, background: { r: 20, g: 120, b: 200 } },
    })
        .jpeg()
        .withMetadata({
            orientation: 6,
            exif: { IFD0: { ImageDescription: 'private-location-and-camera' } },
        })
        .toBuffer();
});
afterAll(() => rmSync(root, { recursive: true, force: true }));
const run = (path: string, body: Buffer) =>
    module.dispatch({ method: 'POST', path, headers: [], body });
it('applies PNG EXIF orientation and strips private metadata while retaining color', async () => {
    const response = run('/strip', png);
    expect(response.status).toBe(200);
    const metadata = await sharp(response.body).metadata();
    expect([metadata.width, metadata.height]).toEqual([4, 8]);
    expect(metadata.exif).toBeUndefined();
    expect(metadata.xmp).toBeUndefined();
    expect(metadata.orientation).toBeUndefined();
    expect(metadata.icc).toEqual((await sharp(png).metadata()).icc);
    const pixels = await sharp(response.body).raw().toBuffer({ resolveWithObject: true });
    expect([...pixels.data.subarray(0, 4)]).toEqual([0, 0, 255, 255]);
});
it('normalizes JPEG orientation, re-encodes, and strips EXIF', async () => {
    const response = run('/strip', jpeg);
    expect(response.status).toBe(200);
    const metadata = await sharp(response.body).metadata();
    expect(metadata.format).toBe('jpeg');
    expect([metadata.width, metadata.height]).toEqual([20, 36]);
    expect(metadata.exif).toBeUndefined();
    expect(metadata.orientation).toBeUndefined();
});
it('fits inside bounds and center-crops thumbnails after orientation', async () => {
    const resized = run('/resize', png),
        cropped = run('/thumbnail', png);
    expect(resized.status).toBe(200);
    expect(cropped.status).toBe(200);
    const a = await sharp(resized.body).metadata(),
        b = await sharp(cropped.body).metadata();
    expect([a.width, a.height]).toEqual([1, 3]);
    expect([b.width, b.height]).toEqual([2, 2]);
    expect(a.hasAlpha).toBe(true);
    expect(b.hasAlpha).toBe(true);
});
it('reports invalid inputs and per-request quota without trapping or reusing old output', () => {
    const invalid = run('/strip', Buffer.from('not an image'));
    expect(invalid.status).toBe(422);
    expect(Buffer.from(invalid.body).toString()).toBe('3');
    const twice = run('/twice', png);
    expect(twice.status).toBe(422);
    expect(Buffer.from(twice.body).toString()).toBe('10');
    expect(run('/strip', png).status).toBe(200);
});
it('gates Queries and validates pointers and byte limits before processing', () => {
    const ref = { memory: new WebAssembly.Memory({ initial: 1 }) };
    const state = freshImageState();
    const imports = buildImageImports(ref, state, () => DbFunctionKind.Query);
    expect(imports['image.process'](0, 0, 0, 0, 0, 90)).toBe(-9);
    const actions = buildImageImports(ref, state, () => DbFunctionKind.Action);
    expect(actions['image.process'](0, 8 * 1024 * 1024 + 1, 0, 0, 0, 90)).toBe(-4);
    state.calls = 0;
    expect(() => actions['image.process'](65536, 1, 0, 0, 0, 90)).toThrow(/bounds/);
});
it('ships a codec with a declared 768 MiB memory maximum', () => {
    const bytes = readFileSync(resolve('assets/image-codec.wasm'));
    let position = 8;
    const uleb = () => {
        let n = 0,
            shift = 0,
            b;
        do {
            b = bytes[position++];
            n |= (b & 127) << shift;
            shift += 7;
        } while (b & 128);
        return n;
    };
    let found = false;
    while (position < bytes.length) {
        const kind = bytes[position++],
            length = uleb(),
            end = position + length;
        if (kind === 5) {
            expect(uleb()).toBe(1);
            expect(uleb()).toBe(1);
            uleb();
            expect(uleb()).toBe(12288);
            found = true;
            break;
        }
        position = end;
    }
    expect(found).toBe(true);
});
