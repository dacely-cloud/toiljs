/**
 * Parse a compiled artifact's `toil.surface` custom section. Emitted into EVERY
 * Toil artifact by the toilscript `buildToilSurface` pass (hot AND cold). The dev
 * server reads it to decide whether each artifact carries the daemon surface
 * (start the daemon emulator) or the stream surface (Phase 4, deferred).
 *
 * Byte layout (RECONCILIATION Part 5, all little-endian; mirrors the toilscript
 * `CatWriter` emitter byte-for-byte):
 *
 *   u16 format_version = 1
 *   u8  target_mode            (0 = hot, 1 = cold; there is no target_mode = 2)
 *   u8  reserved0
 *   u32 surface_flags          (bit0 rest, bit1 stream, bit2 daemon,
 *                               bit3 scheduled, bit4 database, bit5 render)
 *   u16 abi_version
 *   str build_id               (u32 len + UTF-8)
 *   u32 fingerprint
 *   u32 data_coherence_hash
 *   u32 pair_coherence_hash    (exactly THREE u32 after build_id, not four)
 *
 * Fail-closed per Part 5's host rule: an absent or unparseable section is a
 * corrupt Toil artifact -> do not start that artifact's emulator.
 */

import { DataReader } from 'toiljs/io';

import { customSection } from './sections.js';

export const SURFACE_FORMAT_VERSION = 1;
export const SURFACE_ABI_VERSION = 1;

const TARGET_HOT = 0;
const TARGET_COLD = 1;
const FLAG_REST = 1 << 0;
const FLAG_STREAM = 1 << 1;
const FLAG_DAEMON = 1 << 2;
const FLAG_SCHEDULED = 1 << 3;
const FLAG_DATABASE = 1 << 4;
const FLAG_RENDER = 1 << 5;
const FLAG_KNOWN_MASK =
    FLAG_REST | FLAG_STREAM | FLAG_DAEMON | FLAG_SCHEDULED | FLAG_DATABASE | FLAG_RENDER;

export interface SurfaceFlags {
    readonly rest: boolean;
    readonly stream: boolean;
    readonly daemon: boolean;
    readonly scheduled: boolean;
    readonly database: boolean;
    readonly render: boolean;
}

export interface Surface {
    /** 0 = hot, 1 = cold. */
    readonly targetMode: 'hot' | 'cold';
    readonly flags: SurfaceFlags;
    readonly abiVersion: number;
    readonly buildId: string;
    readonly fingerprint: number;
    readonly dataCoherenceHash: number;
    readonly pairCoherenceHash: number;
}

/** `'invalid'` => absent or corrupt (fail closed). Otherwise the parsed surface. */
export function parseSurface(wasm: Buffer): Surface | 'invalid' {
    let sec: Buffer | null;
    try {
        sec = customSection(wasm, 'toil.surface');
    } catch {
        return 'invalid'; // garbage section table
    }
    if (sec === null) return 'invalid';

    const r = new DataReader(sec);
    const version = r.readU16(); // format_version
    if (!r.ok || version !== SURFACE_FORMAT_VERSION) return 'invalid';
    const targetModeByte = r.readU8();
    if (!r.ok || (targetModeByte !== TARGET_HOT && targetModeByte !== TARGET_COLD)) {
        return 'invalid';
    }
    const targetMode = targetModeByte === TARGET_COLD ? 'cold' : 'hot';
    const reserved0 = r.readU8(); // reserved0
    if (!r.ok || reserved0 !== 0) return 'invalid';
    const f = r.readU32(); // surface_flags
    if (!r.ok || (f & ~FLAG_KNOWN_MASK) !== 0) return 'invalid';
    if ((f & FLAG_SCHEDULED) !== 0 && (f & FLAG_DAEMON) === 0) return 'invalid';
    if (targetMode === 'hot' && (f & (FLAG_DAEMON | FLAG_SCHEDULED)) !== 0) {
        return 'invalid';
    }
    if (targetMode === 'cold' && (f & (FLAG_REST | FLAG_STREAM | FLAG_RENDER)) !== 0) {
        return 'invalid';
    }
    const abiVersion = r.readU16();
    if (!r.ok || abiVersion !== SURFACE_ABI_VERSION) return 'invalid';
    const buildId = r.readString();
    const fingerprint = r.readU32();
    const dataCoherenceHash = r.readU32(); // exactly THREE u32 after build_id
    const pairCoherenceHash = r.readU32();
    if (!r.ok || r.remaining() !== 0) return 'invalid'; // PRESENT but corrupt => fail closed
    return {
        targetMode,
        flags: {
            rest: !!(f & 1),
            stream: !!(f & 2),
            daemon: !!(f & 4),
            scheduled: !!(f & 8),
            database: !!(f & 16),
            render: !!(f & 32),
        },
        abiVersion,
        buildId,
        fingerprint,
        dataCoherenceHash,
        pairCoherenceHash,
    };
}
