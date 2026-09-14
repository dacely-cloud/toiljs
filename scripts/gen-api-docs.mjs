/** Generate API reference pages using the TypeScript 7 native checker. */
import fs from 'node:fs';
import path from 'node:path';
import { API, SymbolFlags } from 'typescript/unstable/sync';

const root = path.resolve(import.meta.dirname, '..');
const out = path.join(root, 'build/docs');
const modules = ['client', 'compiler', 'logger', 'shared', 'backend', 'devserver', 'io'];
const escape = (value) =>
    String(value).replace(
        /[&<>"']/g,
        (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch],
    );
const page = (title, body) =>
    `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${escape(title)}</title><style>body{max-width:72rem;margin:3rem auto;padding:0 1rem;font:16px/1.6 system-ui}pre{white-space:pre-wrap;background:#f3f4f6;padding:1rem}a{color:#1656a8}article{border-bottom:1px solid #ddd;padding:1rem 0}</style><nav><a href="index.html">ToilJS API</a></nav><h1>${escape(title)}</h1>${body}</html>`;
fs.mkdirSync(out, { recursive: true });
const api = new API({ cwd: root });
let snapshot;
try {
    snapshot = api.updateSnapshot({
        openProjects: modules.map((name) => path.join(root, `tsconfig.${name}.json`)),
    });
    const index = [];
    for (const name of modules) {
        const project = snapshot.getProject(path.join(root, `tsconfig.${name}.json`));
        if (!project) throw new Error(`Missing documentation project: ${name}`);
        const source = project.program.getSourceFile(path.join(root, `src/${name}/index.ts`));
        if (!source) throw new Error(`Missing entry point: ${name}`);
        const checker = project.checker;
        const module = checker.getSymbolAtLocation(source);
        if (!module) throw new Error(`Cannot resolve exports: ${name}`);
        const entries = checker
            .getExportsOfModule(module)
            .map((exported) => {
                const symbol =
                    exported.flags & SymbolFlags.Alias
                        ? checker.getAliasedSymbol(exported)
                        : exported;
                const doc = checker.getDocumentationCommentOfSymbol(symbol);
                const type =
                    symbol.flags & SymbolFlags.Type
                        ? checker.getDeclaredTypeOfSymbol(symbol)
                        : checker.getTypeOfSymbol(symbol);
                const signature = type ? checker.typeToString(type, undefined, 1) : symbol.name;
                return { name: exported.name, doc, signature };
            })
            .sort((a, b) => a.name.localeCompare(b.name));
        if (!entries.length) throw new Error(`No documented exports: ${name}`);
        fs.writeFileSync(
            path.join(out, `${name}.html`),
            page(
                `toiljs/${name}`,
                entries
                    .map(
                        (entry) =>
                            `<article id="${escape(entry.name)}"><h2>${escape(entry.name)}</h2><pre>${escape(entry.signature)}</pre><p>${escape(entry.doc).replace(/\n/g, '<br>')}</p></article>`,
                    )
                    .join('\n'),
            ),
        );
        index.push({ module: name, exports: entries });
    }
    fs.writeFileSync(path.join(out, 'api.json'), JSON.stringify(index, null, 2) + '\n');
    fs.writeFileSync(
        path.join(out, 'index.html'),
        page(
            'ToilJS API reference',
            `<ul>${index.map((item) => `<li><a href="${item.module}.html">toiljs/${item.module}</a> (${item.exports.length} exports)</li>`).join('')}</ul>`,
        ),
    );
    console.log(`Generated TypeScript 7 API documentation in ${out}`);
} finally {
    snapshot?.dispose();
    api.close();
}
