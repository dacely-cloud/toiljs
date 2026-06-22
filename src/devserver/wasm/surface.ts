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
 * Fail-closed per Part 5's host rule: an ABSENT section is "legacy single
 * artifact, load as hot" (NOT a hard reject); a PRESENT-but-unparseable section is
 * a corrupt artifact -> do not start that artifact's emulator.
 */

import { DataReader } from 'toiljs/io';

import { customSection } from './sections.js';

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

/** `'absent'` => legacy single artifact (load as hot, no emulators).
 *  `'invalid'` => present but corrupt (fail closed). Otherwise the parsed surface. */
export function parseSurface(wasm: Buffer): Surface | 'absent' | 'invalid' {
    let sec: Buffer | null;
    try {
        sec = customSection(wasm, 'toil.surface');
    } catch {
        return 'invalid'; // garbage section table
    }
    if (sec === null) return 'absent';

    const r = new DataReader(sec);
    r.readU16(); // format_version
    const targetMode = r.readU8() === 1 ? 'cold' : 'hot';
    r.readU8(); // reserved0
    const f = r.readU32(); // surface_flags
    const abiVersion = r.readU16();
    const buildId = r.readString();
    const fingerprint = r.readU32();
    const dataCoherenceHash = r.readU32(); // exactly THREE u32 after build_id
    const pairCoherenceHash = r.readU32();
    if (!r.ok) return 'invalid'; // PRESENT but corrupt => fail closed
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
