/**
 * Edge-SSR hole markers. A route opts into server rendering by wrapping its
 * dynamic bits in these components; the compiler's template extractor finds
 * them deterministically (rather than guessing which `{expr}` is dynamic).
 *
 * The markers are TRANSPARENT at runtime: in the browser `<Hole>` renders its
 * children, `<Repeat>` renders `each.map(...)`, `<RawHtml>` renders a
 * `dangerouslySetInnerHTML` wrapper, `<Island>` renders its children. So the
 * client's React tree is exactly the normal app.
 *
 * Under the BUILD extractor (which calls {@link __setSsrBuild}(true) before
 * `renderToStaticMarkup`), each marker instead emits a unique PUA sentinel
 * token marking an insertion point. The extractor strips the tokens, records
 * their byte offsets, and emits the `.tmpl` + `.slots`. PUA codepoints
 * (U+E000..) never occur in real HTML and React serialises them verbatim, so
 * the tokens are collision-proof and strip to zero bytes.
 *
 * Because the static scaffold around every hole is React's OWN
 * `renderToStaticMarkup` output, the browser's `hydrateRoot` sees byte-
 * identical markup as long as the guest escapes hole values the same way React
 * does (it does: see `server/runtime/ssr/escape.ts`).
 */

import { createElement, Fragment, type ReactNode, useEffect, useState } from 'react';

/** Token framing codepoints (Unicode Private Use Area). */
export const SENTINEL_START = String.fromCharCode(0xe000);
export const SENTINEL_SEP = String.fromCharCode(0xe001);
export const SENTINEL_END = String.fromCharCode(0xe002);

/** Kind chars embedded in a sentinel token. Lowercase letters; `R`/`r` open and
 * close a repeat region. */
export const enum HoleKindChar {
    Text = 't',
    Raw = 'h',
    Attr = 'a',
    RepeatOpen = 'R',
    RepeatClose = 'r',
}

let ssrBuild = false;

/** Build-extractor switch. Flipped on around a `renderToStaticMarkup` pass so
 * the markers emit sentinels; left `false` in the browser bundle so they are
 * transparent. */
export function __setSsrBuild(on: boolean): void {
    ssrBuild = on;
}

/** `true` while the extractor is rendering (test/diagnostic use). */
export function __isSsrBuild(): boolean {
    return ssrBuild;
}

/** A self-closing insertion-point token, e.g. `␀t<id>␂`. */
function token(kind: HoleKindChar, id: string): string {
    return SENTINEL_START + kind + id + SENTINEL_END;
}

/** Wrap a string so a component always returns a `ReactElement` (a Fragment
 * with one text child renders the string verbatim). */
function textNode(s: string): ReactNode {
    return createElement(Fragment, null, s);
}

export interface HoleProps {
    /** Stable hole name; the extractor maps it to a numeric slot id. */
    id: string;
    children?: ReactNode;
}

/** A scalar text hole. Client: renders `children`. Build: a text insertion
 * point the guest fills with the React-escaped value. */
export function Hole(props: HoleProps): ReactNode {
    if (ssrBuild) return textNode(token(HoleKindChar.Text, props.id));
    return createElement(Fragment, null, props.children);
}

/**
 * An attribute-value hole. Unlike the child markers, an attribute is not a child
 * node, so this is a *function* used in attribute position rather than a JSX
 * element:
 *
 * ```tsx
 * <a href={attr('profileUrl', d.url)} class={attr('cls', d.cls)}>…</a>
 * ```
 *
 * Browser: returns `value` unchanged, so the attribute renders normally. Build:
 * returns a PUA sentinel token, so the extractor records an `attr` slot at the
 * attribute's byte offset (the token sits between the quotes and strips to zero
 * bytes). The guest fills it per request with the React-escaped value (kind
 * `attr`), which the host splices at that offset — exactly like a text hole, but
 * inside an attribute. It composes with surrounding literal text
 * (`` `btn ${attr('x', v)}` ``), and `setAttr`/`HtmlBuilder.attr` produce the
 * value on the server side.
 */
export function attr(id: string, value: string): string {
    return ssrBuild ? token(HoleKindChar.Attr, id) : value;
}

export interface RawHtmlProps {
    id: string;
    /** Raw HTML string. The author owns sanitisation (same as React
     * `dangerouslySetInnerHTML`). */
    html: string;
    /** Wrapper element tag (raw HTML needs a host element to live in so server
     * and client DOM match). Defaults to `div`. */
    as?: keyof React.JSX.IntrinsicElements;
}

/** A raw-HTML block hole. Client: `<as dangerouslySetInnerHTML>`. Build:
 * `<as>SENTINEL</as>` so the `.tmpl` carries the wrapper and the guest fills
 * its inner HTML. */
export function RawHtml(props: RawHtmlProps): ReactNode {
    const tag = props.as ?? 'div';
    if (ssrBuild) {
        return createElement(tag, null, token(HoleKindChar.Raw, props.id));
    }
    return createElement(tag, { dangerouslySetInnerHTML: { __html: props.html } });
}

export interface RepeatProps<T> {
    id: string;
    /** The data rows. The build extractor requires a representative sample with
     * at least one row to capture the row sub-template. */
    each: readonly T[];
    children: (item: T, index: number) => ReactNode;
}

/** A repeat region. Client: `each.map(children)`. Build: a region wrapping
 * exactly ONE representative row (so the extractor captures the row sub-
 * template + its nested holes); the host inserts the guest's pre-stamped,
 * concatenated rows at the region offset. */
export function Repeat<T>(props: RepeatProps<T>): ReactNode {
    if (ssrBuild) {
        const sample = props.each.length > 0 ? props.each[0] : undefined;
        return createElement(
            Fragment,
            null,
            token(HoleKindChar.RepeatOpen, props.id),
            sample !== undefined ? props.children(sample, 0) : null,
            token(HoleKindChar.RepeatClose, props.id),
        );
    }
    return createElement(
        Fragment,
        null,
        props.each.map((item, i) => props.children(item, i)),
    );
}

export interface IslandProps {
    children?: ReactNode;
}

/** A client-only escape hatch for content outside the server-template subset.
 * Build: renders nothing (empty in the server HTML). Client: ALSO renders nothing
 * on the first (hydration) render, so it matches the empty server markup, then a
 * mount effect reveals `children` on the next commit. Rendering the children
 * during hydration instead would diverge from the server's empty markup and trip
 * a hydration mismatch. So an island gets no first-paint / SEO, by design. */
export function Island(props: IslandProps): ReactNode {
    const [hydrated, setHydrated] = useState(false);
    useEffect(() => {
        setHydrated(true);
    }, []);
    if (ssrBuild || !hydrated) return null;
    return createElement(Fragment, null, props.children);
}
