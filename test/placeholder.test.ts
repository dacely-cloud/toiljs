import { describe, expect, it } from 'vitest';

import { FRAMEWORK_NAME } from '../src/shared/index';

describe('toiljs scaffold', () => {
    it('exposes the framework name', () => {
        expect(FRAMEWORK_NAME).toBe('toiljs');
    });
});
