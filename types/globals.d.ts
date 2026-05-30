// Ambient toiljs client globals. Referenced by the generated `toil-env.d.ts`
// (`/// <reference types="toiljs/globals" />`). These classes are injected onto `globalThis`
// at runtime by the generated entry, so client code can use them with no import.
//
// This is a script-mode declaration file (no top-level import/export), so the `declare const`s
// are genuinely global; the `import('toiljs/io')` calls are type-only and resolve to the
// installed toiljs package.
declare const BinaryWriter: typeof import('toiljs/io').BinaryWriter;
declare const BinaryReader: typeof import('toiljs/io').BinaryReader;
declare const FastMap: typeof import('toiljs/io').FastMap;
declare const FastSet: typeof import('toiljs/io').FastSet;
