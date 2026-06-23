// Edge-SSR slots for the `/hello` route (`client/routes/hello.tsx`).
//
// In the single-wasm build the compiler GENERATES this exact module from the
// route's rendered template into `build/client/_ssr/hello.slots.ts` (the `Slot`
// enum mirrors the deployed `.slots` manifest's ids; `HASH` is the coherence
// hash the host checks against the template, the deploy-skew guard). The server
// `render` is built BEFORE template extraction, so the demo keeps a hand-fixed
// copy here, kept in sync with the generated one — `toiljs build` warns on a
// hash mismatch by failing the host's coherence check at request time.
//
// Keep `Slot`/`HASH` identical to `build/client/_ssr/hello.slots.ts`.

/** Stable hole ids for this route's template (document order). */
export enum Slot {
    name = 0,
    blurb = 1,
    services = 2,
}

/** Coherence hash (32 bytes) baked into the guest and echoed in every values
 * envelope; the host rejects a response whose hash != the deployed template. */
export const HASH: StaticArray<u8> = [
    0xcb, 0x12, 0x5e, 0x19, 0x46, 0x32, 0x58, 0x25, 0xd3, 0xf0, 0x44, 0xc5, 0x41, 0x0c, 0x34, 0x3b,
    0x69, 0xd3, 0x62, 0xb3, 0x24, 0x25, 0x79, 0xc4, 0x76, 0x89, 0xfb, 0x25, 0x6e, 0x35, 0x02, 0x31,
];
