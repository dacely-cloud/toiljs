import { add } from '../../src/backend';

describe('backend', () => {
    it('adds two integers', () => {
        expect<i32>(add(1, 2)).toBe(3);
    });
});
