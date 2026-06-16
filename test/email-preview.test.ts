import path from 'node:path';

import { createServer } from 'vite';
import { describe, expect, it } from 'vitest';

import { loadConfig } from '../src/compiler/config';
import {
    emailsVersion,
    listEmails,
    previewShellHtml,
    renderEmailByName,
} from '../src/compiler/email-preview';
import { createViteConfig } from '../src/compiler/vite';

const EXAMPLE = path.resolve(__dirname, '../examples/basic');

describe('email preview end-to-end (examples/basic)', () => {
    it('lists Welcome and inlines its emails/styles/email.css; client/* alias resolves', async () => {
        const cfg = await loadConfig({ root: EXAMPLE });
        const items = listEmails(cfg);
        expect(items.map((i) => i.name)).toContain('Welcome');

        const server = await createServer({
            ...(await createViteConfig(cfg)),
            server: { middlewareMode: true, hmr: false },
            appType: 'custom',
            logLevel: 'silent',
        });
        try {
            const r = await renderEmailByName(server, cfg, 'Welcome');
            if (!r) throw new Error('Welcome did not render');
            // tokens discovered from props
            expect(r.tokens).toEqual(['code', 'name']);
            // subject token template
            expect(r.subject).toBe('Welcome to toiljs, {{name}}');
            // .email-title { color: #f5f6fa } from emails/styles/email.css inlined onto the <h1>
            expect(r.html).toMatch(/<h1[^>]*style="[^"]*color:\s*#f5f6fa/i);
            // .email-card { background-color: #0e1520 } inlined onto the card <table>
            expect(r.html).toMatch(/<table[^>]*style="[^"]*background-color:\s*#0e1520/i);

            // The `client/*` reuse alias still resolves project CSS (the documented
            // `import 'client/styles/…'` path), independent of where the demo keeps its styles.
            const aliased = (await server.ssrLoadModule('client/styles/main.css?inline')) as {
                default?: unknown;
            };
            expect(typeof aliased.default).toBe('string');
        } finally {
            await server.close();
        }
    }, 30000);

    it('emailsVersion is a non-empty mtime:count fingerprint', async () => {
        const cfg = await loadConfig({ root: EXAMPLE });
        const v = emailsVersion(cfg);
        expect(v).toMatch(/^\d+(\.\d+)?:\d+$/);
        // at least Welcome.tsx + the client CSS files were counted
        expect(Number(v.split(':')[1])).toBeGreaterThan(1);
    });

    it('the preview shell wires the dev endpoints', () => {
        const html = previewShellHtml();
        expect(html).toContain("var BASE = '/__toil/emails'");
        for (const frag of ["BASE + '/list'", "BASE + '/render?name='", "BASE + '/version'"]) {
            expect(html).toContain(frag);
        }
        expect(html).toContain('/__toil/open?file='); // open-in-editor
    });
});
