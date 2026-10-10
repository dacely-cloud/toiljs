import { subset, validRange } from 'semver';
import { TEST_DEPENDENCIES } from './testing.js';

/** Reject ranges that can install an unsupported native test runner or browser driver major. */
export function isSupportedTestingRange(name: string, range: string): boolean {
    const supported: string | undefined = TEST_DEPENDENCIES[name];
    return supported === undefined || (validRange(range) !== null && subset(range, supported));
}

/** Explicit sources are user pins; validate the installed package instead of rewriting the source. */
export function isTestingSource(range: string): boolean {
    return /^(file:|workspace:|link:|git[+:]|https?:|github:|npm:)/.test(range);
}
