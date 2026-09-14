/** Oxlint plugin using the TypeScript 7 native checker for branded byte arrays. */
import path from 'node:path';
import { API } from 'typescript/unstable/sync';
import { SyntaxKind } from 'typescript/unstable/ast';

function isUint8ArrayType(type, checker, ancestors = new Set()) {
    if (!type || ancestors.has(type.id)) return false;
    const seen = new Set(ancestors).add(type.id);
    if (type.getSymbol()?.name === 'Uint8Array') return true;
    if (type.getBaseTypes()?.some((base) => isUint8ArrayType(base, checker, seen))) return true;
    if (type.isIntersectionType())
        return type.getTypes().some((part) => isUint8ArrayType(part, checker, seen));
    if (type.isUnionType()) {
        const parts = type.getTypes();
        return parts.length > 0 && parts.every((part) => isUint8ArrayType(part, checker, seen));
    }
    const constraint = checker.getBaseConstraintOfType(type);
    return constraint && constraint.id !== type.id
        ? isUint8ArrayType(constraint, checker, seen)
        : false;
}

const DEFAULT_OWNERS = new Set([
    'Object',
    'Uint8Array',
    'Int8Array',
    'Uint8ClampedArray',
    'Int16Array',
    'Uint16Array',
    'Int32Array',
    'Uint32Array',
    'Float32Array',
    'Float64Array',
    'BigInt64Array',
    'BigUint64Array',
]);

function hasOverride(symbol) {
    for (const handle of symbol?.declarations ?? []) {
        let node = handle.resolve()?.parent;
        while (node) {
            if (
                [
                    SyntaxKind.ClassDeclaration,
                    SyntaxKind.ClassExpression,
                    SyntaxKind.InterfaceDeclaration,
                ].includes(node.kind)
            ) {
                const name = node.name?.text;
                if (name && !DEFAULT_OWNERS.has(name)) return true;
                break;
            }
            node = node.parent;
        }
    }
    return false;
}

function hasCustomToString(type, checker) {
    if (hasOverride(checker.getPropertyOfType(type, 'toString'))) return true;
    const apparent = checker.getApparentType(type);
    return (
        apparent &&
        apparent.id !== type.id &&
        hasOverride(checker.getPropertyOfType(apparent, 'toString'))
    );
}

export const rule = {
    meta: {
        type: 'problem',
        docs: {
            description:
                'Disallow the default Uint8Array.toString(), including branded byte types.',
        },
        schema: [],
        messages: {
            noUint8ArrayToString:
                '{{typeName}}.toString() returns comma-separated decimals (e.g. "0,32,70,107"), not a hex string. Use Buffer.from(arr).toString("hex") or toHex() instead.',
        },
    },
    create(context) {
        const calls = [];
        return {
            CallExpression(node) {
                const callee = node.callee;
                if (
                    callee.type === 'MemberExpression' &&
                    callee.property.type === 'Identifier' &&
                    callee.property.name === 'toString' &&
                    node.arguments.length === 0
                )
                    calls.push(node);
            },
            'Program:exit'() {
                if (calls.length === 0) return;
                const file = path.resolve(context.filename);
                // Use the actual lint input, including editor buffers and fix passes.
                const api = new API({
                    cwd: context.cwd,
                    fs: {
                        readFile: (name) =>
                            path.resolve(name) === file ? context.sourceCode.text : undefined,
                    },
                });
                let snapshot;
                try {
                    snapshot = api.updateSnapshot({ openFiles: [file] });
                    const project = snapshot.getDefaultProjectForFile(file);
                    if (!project) throw new Error(`No TypeScript 7 project for ${file}`);
                    const checker = project.checker;
                    const source = project.program.getSourceFile(file);
                    if (!source) throw new Error(`No TypeScript 7 source file for ${file}`);
                    const wanted = new Map(
                        calls.map((node) => [node.callee.object.range.join(':'), undefined]),
                    );
                    function visit(node) {
                        const key = `${node.getStart(source)}:${node.end}`;
                        if (wanted.has(key)) wanted.set(key, node);
                        node.forEachChild(visit);
                    }
                    visit(source);
                    const receivers = calls.map((node) => {
                        const receiver = wanted.get(node.callee.object.range.join(':'));
                        if (!receiver) throw new Error(`Cannot map byte-array receiver in ${file}`);
                        return receiver;
                    });
                    const types = checker.getTypeAtLocation(receivers);
                    for (let i = 0; i < calls.length; i++) {
                        const type = types[i];
                        if (isUint8ArrayType(type, checker) && !hasCustomToString(type, checker)) {
                            context.report({
                                node: calls[i],
                                messageId: 'noUint8ArrayToString',
                                data: { typeName: checker.typeToString(type) },
                            });
                        }
                    }
                } finally {
                    snapshot?.dispose();
                    api.close();
                }
            },
        };
    },
};

export default {
    meta: { name: 'toiljs', version: '2.0.0' },
    rules: {
        'no-uint8array-tostring': rule,
        // Legacy octal literals are invalid in modules; retain this check for script inputs too.
        'no-octal': {
            meta: {
                type: 'problem',
                schema: [],
                messages: { octal: 'Octal literals should not be used.' },
            },
            create: (context) => ({
                Literal(node) {
                    if (typeof node.value === 'number' && /^0[0-7]+$/.test(node.raw))
                        context.report({ node, messageId: 'octal' });
                },
            }),
        },
    },
};
