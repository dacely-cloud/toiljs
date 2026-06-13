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

const DOW: string[] = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MON: string[] = [
    'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
    'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
];

function pad2(n: i32): string {
    return n < 10 ? '0' + n.toString() : n.toString();
}

/**
 * Format `epochSeconds` (Unix time, seconds since 1970-01-01T00:00:00Z) as an
 * IMF-fixdate string in GMT. Handles negative inputs (pre-epoch) correctly via
 * floored division.
 */
export function imfFixdate(epochSeconds: i64): string {
    // Floored division into whole days + remaining seconds-of-day.
    let days: i64 = epochSeconds / 86400;
    let secs: i64 = epochSeconds % 86400;
    if (secs < 0) {
        secs += 86400;
        days -= 1;
    }

    // 1970-01-01 is a Thursday (index 4 with Sun=0). Positive modulo.
    let wd = <i32>(((days % 7) + 4) % 7);
    if (wd < 0) wd += 7;

    // Civil date from day count (Hinnant). Shift epoch to 0000-03-01.
    const z: i64 = days + 719468;
    const era: i64 = (z >= 0 ? z : z - 146096) / 146097;
    const doe: i64 = z - era * 146097; // [0, 146096]
    const yoe: i64 = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365; // [0, 399]
    const y: i64 = yoe + era * 400;
    const doy: i64 = doe - (365 * yoe + yoe / 4 - yoe / 100); // [0, 365]
    const mp: i64 = (5 * doy + 2) / 153; // [0, 11]
    const d: i64 = doy - (153 * mp + 2) / 5 + 1; // [1, 31]
    const m: i64 = mp < 10 ? mp + 3 : mp - 9; // [1, 12]
    const year: i64 = y + (m <= 2 ? 1 : 0);

    const hour = <i32>(secs / 3600);
    const minute = <i32>((secs % 3600) / 60);
    const second = <i32>(secs % 60);

    return (
        DOW[wd] +
        ', ' +
        pad2(<i32>d) +
        ' ' +
        MON[<i32>m - 1] +
        ' ' +
        year.toString() +
        ' ' +
        pad2(hour) +
        ':' +
        pad2(minute) +
        ':' +
        pad2(second) +
        ' GMT'
    );
}
