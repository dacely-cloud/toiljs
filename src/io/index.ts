/**
 * toiljs IO, native binary serialization + fast collections, exposed to the client both as
 * `toiljs/io` imports and as ambient globals (see the generated `.toil/toil-env.d.ts`).
 */
export { FastMap } from './FastMap.js';
export { FastSet } from './FastSet.js';
export { DataWriter, DataReader } from './codec.js';

export type { PropertyExtendedKey, FastRecord, IndexKey } from './FastMap.js';
export type { i8, i16, i32, i64, u8, u16, u32, u64, Selector, BufferLike } from './types.js';
