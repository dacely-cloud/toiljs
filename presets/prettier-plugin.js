/**
 * Prettier plugin that lets prettier format toilscript server code, which uses native
 * decorators on free functions (`@main`, `@remote function ...`). Those are valid
 * toilscript but not valid ECMAScript/TypeScript grammar, so prettier's parser rejects
 * them outright.
 *
 * The fix is a parse-time/print-time round-trip: in `preprocess` each function decorator
 * is rewritten to a marker block comment (which the TS parser accepts), and the estree
 * printer's `printComment` renders that marker back as the original `@decorator`. Class
 * and method decorators are already valid grammar and pass through untouched.
 */
import * as tsPlugin from 'prettier/plugins/typescript';
import * as estreePlugin from 'prettier/plugins/estree';

const baseTs = tsPlugin.parsers.typescript;
const baseEstree = estreePlugin.printers.estree;

const MARKER = '::toil-decorator ';
// One-or-more bare decorators (`@name`, no args) immediately before a function declaration.
const FN_DECORATORS =
    /((?:@[A-Za-z_$][\w$]*[ \t]*\r?\n[ \t]*)+)((?:export[ \t]+)?(?:default[ \t]+)?(?:async[ \t]+)?function\b)/g;
const ONE_DECORATOR = /@([A-Za-z_$][\w$]*)([ \t]*\r?\n[ \t]*)/g;

function preprocess(text, options) {
    const pre = baseTs.preprocess ? baseTs.preprocess(text, options) : text;
    return pre.replace(FN_DECORATORS, (_match, decorators, fn) => {
        const masked = decorators.replace(
            ONE_DECORATOR,
            (_d, name, gap) => `/*${MARKER}${name}*/${gap}`,
        );
        return masked + fn;
    });
}

export const parsers = {
    typescript: { ...baseTs, preprocess },
};

export const printers = {
    estree: {
        ...baseEstree,
        printComment(path, options) {
            const comment = path.node ?? path.getValue();
            const value = comment?.value;
            if (typeof value === 'string' && value.startsWith(MARKER)) {
                return '@' + value.slice(MARKER.length).trim();
            }
            return baseEstree.printComment(path, options);
        },
    },
};
