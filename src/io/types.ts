/**
 * Branded numeric width aliases used by the binary IO classes. They are plain `number`/`bigint`
 * at runtime, the names document intent.
 */
export type i8 = number;
export type i16 = number;
export type i32 = number;
export type i64 = bigint;

export type u8 = number;
export type u16 = number;
export type u32 = number;
export type u64 = bigint;

/** A method/route selector encoded as a `u32` on the wire. */
export type Selector = number;

/** Anything that can back a {@link DataReader}. */
export type BufferLike = Uint8Array;
