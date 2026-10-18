// Generated from server/runtime by scripts/gen-server-types.mjs.
/**
 * IMF-fixdate formatting for the cookie `Expires` attribute, e.g.
 * `Sun, 06 Nov 1994 08:49:37 GMT` (RFC 9110 §5.6.7, the only date format
 * RFC 6265bis permits a server to emit).
 *
 * Pure integer math (no `Date` dependency) so it is deterministic and unit
 * testable: the civil-from-days conversion is Howard Hinnant's algorithm,
 * valid across the whole proleptic Gregorian range. Internal to the cookie
 * library (not a global).
 */
/**
 * Format `epochSeconds` (Unix time, seconds since 1970-01-01T00:00:00Z) as an
 * IMF-fixdate string in GMT. Handles negative inputs (pre-epoch) correctly via
 * floored division.
 */
export declare function imfFixdate(epochSeconds: i64): string;
