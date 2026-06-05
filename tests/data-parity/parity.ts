// Cross-language @data byte-parity proof. Compiles spec.ts with the ToilScript
// fork (which has @data), then checks the TS codec (src/io/codec.ts) against it
// both directions, including byte-for-byte. Run with: node tests/data-parity/parity.ts
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { DataWriter, DataReader } from "../../src/io/codec.ts";

const here = dirname(fileURLToPath(import.meta.url));
const fork = "/root/toil-stuff/toilscript";
const spec = join(here, "spec.ts");
const tmp = mkdtempSync(join(tmpdir(), "parity-"));
const wasmPath = join(tmp, "spec.wasm");

const compile = spawnSync(
    "node",
    [join(fork, "bin", "toilscript.js"), spec, "-o", wasmPath, "--runtime", "stub", "--initialMemory", "32"],
    { stdio: "inherit" },
);
if (compile.status !== 0) {
    console.error("@data parity: COMPILE FAILED");
    rmSync(tmp, { recursive: true, force: true });
    process.exit(1);
}

function fail(msg: string): never {
    console.error("@data parity: FAIL,", msg);
    rmSync(tmp, { recursive: true, force: true });
    process.exit(1);
}
function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
}
const hex = (b: Uint8Array): string => Buffer.from(b).toString("hex");

const { instance } = await WebAssembly.instantiate(readFileSync(wasmPath), {
    env: { abort: (_m: number, _f: number, line: number) => { throw new Error("wasm abort @ line " + line); } },
});
const x = instance.exports as Record<string, CallableFunction> & { memory: WebAssembly.Memory };
const mem = x.memory;
const SCRATCH = 0x100000; // 1 MiB, above the low heap

// the known sample (must match spec.ts)
const ID = 0xcafebabedeadbeefn;
const COUNT = -42;
const FLAG = true;
const BIG = 123456789n;
const NAME = "cross-lang";
const fooId = (x.fooId() as number) >>> 0;

// 1) ToilScript encodes the sample; read its bytes out of linear memory.
const len = x.encodeSampleTo(SCRATCH) as number;
const wasmBytes = new Uint8Array(mem.buffer, SCRATCH, len).slice();

// 2) TS decodes the ToilScript bytes.
const r = new DataReader(wasmBytes);
if ((r.readU32() >>> 0) !== fooId) fail("typeId mismatch");
if (r.readU64() !== ID) fail("id (ToilScript -> TS)");
if (r.readI32() !== COUNT) fail("count (ToilScript -> TS)");
if (r.readBool() !== FLAG) fail("flag (ToilScript -> TS)");
if (r.readU128() !== BIG) fail("big (ToilScript -> TS)");
if (r.readString() !== NAME) fail("name (ToilScript -> TS)");
if (!r.ok || r.remaining() !== 0) fail("trailing/ok (ToilScript -> TS)");

// 3) TS encodes the same value; it must be byte-for-byte identical.
const w = new DataWriter();
w.writeU32(fooId).writeU64(ID).writeI32(COUNT).writeBool(FLAG).writeU128(BIG).writeString(NAME);
const tsBytes = w.toBytes();
if (!bytesEqual(tsBytes, wasmBytes)) fail(`byte mismatch\n  ToilScript: ${hex(wasmBytes)}\n  TS:         ${hex(tsBytes)}`);

// 4) ToilScript decodes the TS bytes and confirms the value.
new Uint8Array(mem.buffer, SCRATCH, tsBytes.length).set(tsBytes);
if ((x.checkBytes(SCRATCH, tsBytes.length) as number) !== 1) fail("ToilScript rejected TS bytes (TS -> ToilScript)");

console.log(`@data parity: PASS (ToilScript<->TS both ways, byte-for-byte, ${len} bytes)`);
rmSync(tmp, { recursive: true, force: true });
