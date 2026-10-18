// Generated from server/runtime by scripts/gen-server-types.mjs.
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
import { SlotValues } from './slots';
/** Serialise `v` into linear memory at `dst_ofs`; returns bytes written. On any
 * representability violation (counts/lengths over their field widths, or a
 * wrong-sized hash) a minimal 500 envelope is written instead so the host never
 * sees an encoder fault. */
export declare function encodeValues(v: SlotValues, dst_ofs: usize): u32;
/** Upper bound on the encoded size of `v`, used to size the response slot the
 * `render` export allocates before encoding. */
export declare function valuesEncodedBound(v: SlotValues): usize;
