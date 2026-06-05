import { describe, expect, it } from 'vitest';

import { parseError } from '../src/client/errors';

describe('parseError', () => {
    it('returns the message of an Error', () => {
        expect(parseError(new Error('boom'))).toBe('boom');
    });

    it('stringifies non-Error values', () => {
        expect(parseError('plain string')).toBe('plain string');
        expect(parseError(42)).toBe('42');
        expect(parseError(null)).toBe('null');
        expect(parseError(undefined)).toBe('undefined');
    });

    it('reads the message of an Error subclass', () => {
        class HttpError extends Error {}
        expect(parseError(new HttpError('not found'))).toBe('not found');
    });
});
