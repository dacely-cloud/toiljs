import { add } from '../../src/server';

describe('server', () => {
    it('adds two integers', () => {
        expect<i32>(add(1, 2)).toBe(3);
    });
});
