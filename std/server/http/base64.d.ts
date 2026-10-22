// Generated from server/runtime by scripts/gen-server-types.mjs.
/** Unpadded RFC 4648 base64url; at most 64 KiB of input. */
export declare function base64UrlEncode(data: Uint8Array): string;
/** Accept URL/standard alphabets and ignored padding/ASCII whitespace, as before. */
export declare function base64UrlDecode(s: string): Uint8Array | null;
