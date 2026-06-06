import prettier from 'prettier';
import { describe, expect, it } from 'vitest';

import * as plugin from '../presets/prettier-plugin.js';

function fmt(src: string): Promise<string> {
    return prettier.format(src, {
        parser: 'typescript',
        plugins: [plugin],
        tabWidth: 4,
        singleQuote: true,
        semi: true,
    });
}

// The plugin lets prettier format toilscript server code, whose native decorators on free
// functions (@main, @remote function) are not valid JS/TS grammar (so stock prettier throws).
describe('toiljs prettier-plugin', () => {
    it('formats a free @remote function and keeps the decorator', async () => {
        const out = await fmt('@remote\nfunction ping(n:i32):i32{return n+1}\n');
        expect(out).toContain('@remote');
        expect(out).toContain('function ping(n: i32): i32 {');
        expect(out).not.toContain('toil-decorator'); // marker fully restored
    });

    it('formats @main', async () => {
        const out = await fmt('@main\nfunction run():i32{return 42}\n');
        expect(out).toMatch(/@main\nfunction run\(\): i32 \{/);
    });

    it('handles @remote export function', async () => {
        const out = await fmt('@remote\nexport function pong():void{}\n');
        expect(out).toContain('@remote\nexport function pong(): void {}');
    });

    it('leaves class/method decorators untouched', async () => {
        const out = await fmt('@data\nclass A{ x:i32=0 }\n');
        expect(out).toContain('@data');
        expect(out).toContain('class A {');
    });

    it('is idempotent', async () => {
        const once = await fmt('@remote\nfunction f():void{}\n@main\nfunction g():void{}\n');
        expect(await fmt(once)).toBe(once);
    });
});
