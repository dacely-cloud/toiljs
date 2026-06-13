/**
 * Serialiser for the SSR **values envelope** (guest -> host), byte-for-byte
 * compatible with `toil-backend/src/host/template/assemble.rs::decode_values`.
 *
 * Layout (LE, no padding):
 *
 *   u16  status
 *   [32] template_hash
 *   u16  n_headers
 *   for each header: u16 name_len, u16 val_len, [u8] name, [u8] val
 *   u16  n_slots
 *   for each value: u16 slot_id, u8 kind, u32 value_len, [u8] value
 *
 * The host keys values by `slot_id` and inserts each at the manifest-fixed
 * offset, so the guest can never choose where bytes land.
 */

import {
    utf8Length,
    writeBytes,
    writeU16,
    writeU32,
    writeU8,
    writeUtf8,
} from '../memory';
import { HASH_LEN, SlotValues } from './slots';

/** Serialise `v` into linear memory at `dst_ofs`; returns bytes written. On any
 * representability violation (counts/lengths over their field widths, or a
 * wrong-sized hash) a minimal 500 envelope is written instead so the host never
 * sees an encoder fault. */
export function encodeValues(v: SlotValues, dst_ofs: usize): u32 {
    if (v.templateHash.length != HASH_LEN) return encodeFallback(dst_ofs);
    if (v.headers.length > 0xffff || v.slots.length > 0xffff) return encodeFallback(dst_ofs);
    for (let i = 0; i < v.headers.length; i++) {
        const h = v.headers[i];
        if (utf8Length(h.name) > 0xffff || utf8Length(h.value) > 0xffff) {
            return encodeFallback(dst_ofs);
        }
    }
    for (let i = 0; i < v.slots.length; i++) {
        if (<u64>v.slots[i].bytes.length > <u64>0xffffffff) return encodeFallback(dst_ofs);
    }

    let cur: usize = dst_ofs;

    writeU16(cur, v.status);
    cur += 2;

    for (let i = 0; i < HASH_LEN; i++) {
        writeU8(cur + <usize>i, v.templateHash[i]);
    }
    cur += <usize>HASH_LEN;

    writeU16(cur, <u16>v.headers.length);
    cur += 2;
    for (let i = 0; i < v.headers.length; i++) {
        const h = v.headers[i];
        writeU16(cur, <u16>utf8Length(h.name));
        cur += 2;
        writeU16(cur, <u16>utf8Length(h.value));
        cur += 2;
        cur += writeUtf8(cur, h.name);
        cur += writeUtf8(cur, h.value);
    }

    writeU16(cur, <u16>v.slots.length);
    cur += 2;
    for (let i = 0; i < v.slots.length; i++) {
        const s = v.slots[i];
        writeU16(cur, s.slotId);
        cur += 2;
        writeU8(cur, s.kind);
        cur += 1;
        writeU32(cur, <u32>s.bytes.length);
        cur += 4;
        cur += writeBytes(cur, s.bytes);
    }

    return <u32>(cur - dst_ofs);
}

/** Upper bound on the encoded size of `v`, used to size the response slot the
 * `render` export allocates before encoding. */
export function valuesEncodedBound(v: SlotValues): usize {
    // status + hash + n_headers + n_slots field overheads.
    let bound: usize = 2 + <usize>HASH_LEN + 2 + 2;
    for (let i = 0; i < v.headers.length; i++) {
        const h = v.headers[i];
        bound += 4 + <usize>utf8Length(h.name) + <usize>utf8Length(h.value);
    }
    for (let i = 0; i < v.slots.length; i++) {
        bound += 7 + <usize>v.slots[i].bytes.length;
    }
    return bound;
}

function encodeFallback(dst_ofs: usize): u32 {
    // status=500, zeroed 32-byte hash (host rejects as a coherence mismatch),
    // 0 headers, 0 slots.
    writeU16(dst_ofs, 500);
    let cur = dst_ofs + 2;
    for (let i = 0; i < HASH_LEN; i++) {
        writeU8(cur + <usize>i, 0);
    }
    cur += <usize>HASH_LEN;
    writeU16(cur, 0);
    writeU16(cur + 2, 0);
    return <u32>(2 + HASH_LEN + 2 + 2);
}
