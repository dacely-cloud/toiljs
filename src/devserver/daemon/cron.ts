/**
 * Cron BITMASK evaluation for the dev daemon scheduler. The catalog carries five
 * precomputed bitmasks (RECONCILIATION F6 / Part 5); this module does bit tests
 * against a wall-clock minute, NEVER a cron-string parse. The bit semantics match
 * the toilscript emitter (`expandCronField` in `dbcatalog.ts`):
 *
 *   minute  bits 0..59   hour bits 0..23   dom bits 1..31
 *   month   bits 1..12   dow  bits 0..6 (0 = Sunday)
 *
 * Standard cron semantics for day-of-month vs day-of-week: when BOTH fields are
 * restricted (not all bits set) the match is the UNION (either matches); when one
 * is unrestricted it does not constrain. The dev evaluator walks forward
 * minute-by-minute from "now" to the next matching minute, exactly as the edge
 * evaluates the same masks.
 */

import type { CronMasks } from './catalog.js';

/** All 60 minute bits set (bits 0..59). A field the emitter left fully open. */
const ALL_MINUTES = (1n << 60n) - 1n;
/** All 24 hour bits set (bits 0..23). */
const ALL_HOURS = (1 << 24) - 1;
/** dom bits 1..31 all set (bit 0 unused). `1 << 32` overflows in JS, so spell it. */
const ALL_DOM = 0xfffffffe;
/** month bits 1..12 all set (bit 0 unused). */
const ALL_MONTH = ((1 << 13) - 1) & ~1;
/** dow bits 0..6 all set. */
const ALL_DOW = (1 << 7) - 1;

function minuteBit(masks: CronMasks, minute: number): boolean {
    return (masks.minute & (1n << BigInt(minute))) !== 0n;
}

/** True when every cron field's bit is set for `date`'s local-time components. */
export function cronMatches(masks: CronMasks, date: Date): boolean {
    if (!minuteBit(masks, date.getMinutes())) return false;
    if ((masks.hour & (1 << date.getHours())) === 0) return false;
    if ((masks.month & (1 << date.getMonth() + 1)) === 0) return false;

    // dom/dow union rule (POSIX cron): if both are restricted, either may match.
    const domRestricted = (masks.dom & ALL_DOM) !== ALL_DOM;
    const dowRestricted = (masks.dow & ALL_DOW) !== ALL_DOW;
    const domHit = (masks.dom & (1 << date.getDate())) !== 0;
    const dowHit = (masks.dow & (1 << date.getDay())) !== 0;
    if (domRestricted && dowRestricted) {
        if (!domHit && !dowHit) return false;
    } else if (domRestricted) {
        if (!domHit) return false;
    } else if (dowRestricted) {
        if (!dowHit) return false;
    }
    return true;
}

/** True when a mask can never fire (all-zero) -> the schedule is rejected. */
export function cronNeverFires(masks: CronMasks): boolean {
    return (
        (masks.minute & ALL_MINUTES) === 0n ||
        (masks.hour & ALL_HOURS) === 0 ||
        (masks.month & ALL_MONTH) === 0 ||
        // dom OR dow must be able to fire (union); both empty => never.
        ((masks.dom & ALL_DOM) === 0 && (masks.dow & ALL_DOW) === 0)
    );
}

/**
 * The epoch-ms of the next minute (strictly after `fromMs`) whose components all
 * pass the masks, walking forward minute-by-minute. Returns `null` when no match
 * is found within `horizonMinutes` (a safety bound; an all-zero mask is caught by
 * {@link cronNeverFires} before this is called). Fires land on the :00 second of
 * the matching minute.
 */
export function nextCronFireMs(
    masks: CronMasks,
    fromMs: number,
    horizonMinutes = 366 * 24 * 60,
): number | null {
    // Start at the next whole minute boundary strictly after `fromMs`.
    const d = new Date(fromMs);
    d.setSeconds(0, 0);
    d.setMinutes(d.getMinutes() + 1);
    for (let i = 0; i < horizonMinutes; i++) {
        if (cronMatches(masks, d)) return d.getTime();
        d.setMinutes(d.getMinutes() + 1);
    }
    return null;
}
