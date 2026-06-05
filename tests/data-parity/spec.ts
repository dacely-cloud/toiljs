// ToilScript side of the cross-language @data parity proof. Compiled by the
// ToilScript fork (which has @data + std/assembly/data.ts). Exposes a known sample so the
// TS codec can be checked against it byte-for-byte, both directions.
//
// A fixed scratch region (high in linear memory, away from the low heap) is used
// to move bytes across the JS boundary without the loader.

@data
class Foo {
  id: u64 = 0;
  count: i32 = 0;
  flag: bool = false;
  big: u128 = u128.Zero;
  name: string = "";
}

function sample(): Foo {
  const f = new Foo();
  f.id = 0xCAFEBABEDEADBEEF;
  f.count = -42;
  f.flag = true;
  f.big = u128.fromU64(123456789);
  f.name = "cross-lang";
  return f;
}

export function fooId(): u32 {
  return Foo.dataId();
}

/** Encode the sample, copy it to `out`, return the byte length. */
export function encodeSampleTo(out: usize): i32 {
  const bytes = sample().encode();
  memory.copy(out, bytes.dataStart, <usize>bytes.length);
  return bytes.length;
}

/** Decode `len` bytes at `inp` and return 1 if they equal the sample, else 0. */
export function checkBytes(inp: usize, len: i32): i32 {
  const bytes = new Uint8Array(len);
  memory.copy(bytes.dataStart, inp, <usize>len);
  const f = Foo.decode(bytes);
  const s = sample();
  const ok = f.id == s.id && f.count == s.count && f.flag == s.flag && f.big == s.big && f.name == s.name;
  return ok ? 1 : 0;
}
