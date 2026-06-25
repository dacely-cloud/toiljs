// A TYPED @stream fixture: @stream({ message: ChatMsg }) makes @message receive the DECODED @data
// (doc 03 2.5), not raw bytes. The hook replies with the decoded text's length, so a host round-trip
// proves the @data decode ran at runtime (not just compiled). The seed* exports hand the host a real
// ChatMsg.encode() payload so the test never hand-crafts the @data wire format.

@data
class ChatMsg {
  text: string = '';
}

@stream({ message: ChatMsg })
class TypedChat {
  @message
  onMsg(m: ChatMsg): StreamOutbound {
    // Reply with the DECODED text length (one byte): "hi" -> 2 proves the decode produced the string.
    const r = new Uint8Array(1);
    r[0] = <u8>m.text.length;
    return StreamOutbound.reply(r);
  }
}

// Seed buffer: the guest encodes a ChatMsg the host feeds back, so the host never hand-crafts @data
// bytes (the encode/decode pair is the wire contract). A StaticArray<u8>'s pointer IS its data start.
let seedBuf = new StaticArray<u8>(64);
let seedLen: i32 = 0;

export function seedHi(): void {
  const m = new ChatMsg();
  m.text = 'hi';
  const b = m.encode();
  seedLen = b.length;
  for (let i = 0, n = b.length; i < n; i++) seedBuf[i] = b[i];
}

export function seedOffset(): i32 {
  return changetype<i32>(seedBuf);
}

export function seedLength(): i32 {
  return seedLen;
}
