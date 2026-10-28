import { beforeEach, expect, it } from 'vitest';
import {
    __resetRatelimitForTests,
    ratelimitCheck,
    STRATEGY_TRAILING,
} from '../src/devserver/config/ratelimit.js';
beforeEach(__resetRatelimitForTests);
it('enforces an exact trailing hour across aligned boundaries and computes the earliest retry', () => {
    const check = (now: number, key = 'user') =>
        ratelimitCheck(1, STRATEGY_TRAILING, 10, 3600, key, now);
    for (let i = 0; i < 10; i++) expect(check(3599999).allowed).toBe(true);
    expect(check(3600000)).toEqual({ allowed: false, retryAfterSecs: 3600 });
    expect(check(7199998)).toEqual({ allowed: false, retryAfterSecs: 1 });
    expect(check(7199998, 'another').allowed).toBe(true);
    for (let i = 0; i < 10; i++) expect(check(7199999).allowed).toBe(true);
    expect(check(7199999).allowed).toBe(false);
});
it('matches a timestamp-log reference through bursts, expiry and prefix compaction', () => {
    const accepted: number[] = [];
    let now = 0;
    for (let i = 0; i < 10000; i++) {
        now += (Math.imul(i, 104729) >>> 0) % 300;
        while (accepted.length && accepted[0] <= now - 10000) accepted.shift();
        const allowed = accepted.length < 17;
        const expected = allowed ? 0 : Math.max(1, Math.ceil((accepted[0] + 10000 - now) / 1000));
        expect(ratelimitCheck(2, STRATEGY_TRAILING, 17, 10, 'user', now)).toEqual({
            allowed,
            retryAfterSecs: expected,
        });
        if (allowed) accepted.push(now);
    }
});
