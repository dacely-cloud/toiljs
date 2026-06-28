// A minimal in-AssemblyScript test shim for this directory's assembly specs.
// `describe`/`it` run their bodies inline; `expect(x).toBe(y)` / `.toStrictEqual(y)` assert
// `x == y` (value-equality, which covers the bool / i32 / string the specs compare). A failed
// assertion aborts with the current test name; the vitest runner (../assembly.test.ts) compiles
// each spec with toilscript, runs `_start`, and surfaces the abort as a test failure.

let currentTest: string = '';

export function describe(_name: string, fn: () => void): void {
    fn();
}

export function it(name: string, fn: () => void): void {
    currentTest = name;
    fn();
}

export class Expectation<T> {
    private actual: T;
    constructor(actual: T) {
        this.actual = actual;
    }
    toBe(expected: T): void {
        assert(this.actual == expected, currentTest);
    }
    toStrictEqual(expected: T): void {
        assert(this.actual == expected, currentTest);
    }
}

export function expect<T>(actual: T): Expectation<T> {
    return new Expectation<T>(actual);
}
