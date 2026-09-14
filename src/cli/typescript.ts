import { minVersion, satisfies, subset, validRange } from 'semver';

/** TypeScript 7 is the only supported compiler major. */
export const TYPESCRIPT_SUPPORTED = '>=7.0.2 <8.0.0';
export const TYPESCRIPT_FIX_RANGE = '^7.0.2';

export function isSupportedTypeScriptVersion(version: string): boolean {
    return satisfies(version, TYPESCRIPT_SUPPORTED);
}

/** Reject tags, aliases, prereleases and ranges that can install a different compiler major. */
export function isSupportedTypeScriptRange(range: string): boolean {
    if (!validRange(range)) return false;
    const min = minVersion(range);
    return (
        min !== null &&
        isSupportedTypeScriptVersion(min.version) &&
        subset(range, TYPESCRIPT_SUPPORTED)
    );
}
