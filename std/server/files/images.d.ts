// Generated from server/runtime by scripts/gen-server-types.mjs.
export declare enum ImageError {
    None = 0,
    Invalid = 2,
    Unsupported = 3,
    Limit = 4,
    Busy = 5,
    Timeout = 6,
    Unavailable = 7,
    Options = 8,
    Kind = 9,
    Quota = 10
}
export declare enum ImageFormat {
    Png = 1,
    Jpeg = 2
}
export declare class ImageResult {
    error: ImageError;
    bytes: Uint8Array;
    width: u32;
    height: u32;
    format: ImageFormat;
    get ok(): bool;
    get contentType(): string;
}
export declare class Images {
    private static run;
    /** Re-encode without EXIF/XMP/IPTC/text/comments, applying orientation.
     * Retains ICC profiles and PNG color descriptors. JPEG is re-encoded. */
    static stripExif(input: Uint8Array, quality?: i32): ImageResult;
    /** Fit inside the box, retaining aspect ratio and avoiding enlargement. */
    static resize(input: Uint8Array, width: i32, height: i32, quality?: i32): ImageResult;
    /** Center crop to the requested aspect ratio, avoiding enlargement. */
    static thumbnail(input: Uint8Array, width: i32, height: i32, quality?: i32): ImageResult;
}
