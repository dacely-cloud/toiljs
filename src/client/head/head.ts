/**
 * Client-side document `<head>` management. `useHead` / `useTitle` / `<Head>` let any component
 * (layout or page) set the title and `<meta>` / `<link>` tags; entries compose across the tree
 * (later/deeper entries win per key) and are reverted when the component unmounts. Pure
 * `mergeHead` resolves the active entries; the manager reconciles `document.head`.
 */
import { useEffect } from 'react';

/** A `<meta>` tag. Use `name` or `property` (OpenGraph) as the dedup key; extra attrs pass through. */
export interface MetaTag {
    readonly name?: string;
    readonly property?: string;
    readonly content: string;
    readonly [attr: string]: string | undefined;
}

/** A `<link>` tag (deduped by `rel` + `href`); extra attrs pass through. */
export interface LinkTag {
    readonly rel: string;
    readonly href: string;
    readonly [attr: string]: string | undefined;
}

/** A head contribution from one component. */
export interface HeadSpec {
    /** Document title. */
    readonly title?: string;
    /** Template applied to a child's title, `%s` = the title (e.g. `'%s · toiljs'`). */
    readonly titleTemplate?: string;
    readonly meta?: readonly MetaTag[];
    readonly link?: readonly LinkTag[];
}

/** The resolved head after merging all active specs. */
export interface ResolvedHead {
    readonly title?: string;
    readonly meta: MetaTag[];
    readonly link: LinkTag[];
}

function metaKey(m: MetaTag): string {
    if (m.name !== undefined) return `name:${m.name}`;
    if (m.property !== undefined) return `property:${m.property}`;
    return `meta:${JSON.stringify(m)}`;
}

/**
 * Merges head specs in order: the last `title`/`titleTemplate` wins, `meta` dedupes by name/property
 * and `link` by rel+href (last wins). A `titleTemplate` formats the resolved title via `%s`.
 */
export function mergeHead(specs: readonly HeadSpec[]): ResolvedHead {
    let title: string | undefined;
    let titleTemplate: string | undefined;
    const meta = new Map<string, MetaTag>();
    const link = new Map<string, LinkTag>();
    for (const spec of specs) {
        if (spec.title !== undefined) title = spec.title;
        if (spec.titleTemplate !== undefined) titleTemplate = spec.titleTemplate;
        for (const m of spec.meta ?? []) meta.set(metaKey(m), m);
        for (const l of spec.link ?? []) link.set(`${l.rel}:${l.href}`, l);
    }
    const resolvedTitle =
        title !== undefined && titleTemplate !== undefined
            ? titleTemplate.replace('%s', title)
            : title;
    return { title: resolvedTitle, meta: [...meta.values()], link: [...link.values()] };
}

const entries = new Map<number, HeadSpec>();
let order: number[] = [];
let seq = 0;
let baseTitle: string | null = null;

function setAttrs(el: Element, attrs: Record<string, string | undefined>): void {
    el.setAttribute('data-toil-head', '');
    for (const [key, value] of Object.entries(attrs)) {
        if (value !== undefined) el.setAttribute(key, value);
    }
}

/** Reconciles `document.head` with the merged active specs. */
function apply(): void {
    if (typeof document === 'undefined') return;
    if (baseTitle === null) baseTitle = document.title;

    const resolved = mergeHead(order.map((id) => entries.get(id)).filter((s): s is HeadSpec => !!s));

    document.title = resolved.title ?? baseTitle;

    for (const stale of document.head.querySelectorAll('[data-toil-head]')) stale.remove();
    for (const m of resolved.meta) {
        const el = document.createElement('meta');
        setAttrs(el, m);
        document.head.appendChild(el);
    }
    for (const l of resolved.link) {
        const el = document.createElement('link');
        setAttrs(el, l);
        document.head.appendChild(el);
    }
}

function addHead(spec: HeadSpec): number {
    const id = ++seq;
    entries.set(id, spec);
    order.push(id);
    apply();
    return id;
}

function removeHead(id: number): void {
    entries.delete(id);
    order = order.filter((x) => x !== id);
    apply();
}

/**
 * Applies a head contribution for the lifetime of the calling component: title, `<meta>`, `<link>`.
 * Reverts on unmount. Compose freely — a root layout can set defaults a page overrides.
 */
export function useHead(spec: HeadSpec): void {
    const json = JSON.stringify(spec);
    useEffect(() => {
        const id = addHead(JSON.parse(json) as HeadSpec);
        return () => {
            removeHead(id);
        };
    }, [json]);
}

/** Sets `document.title` for the calling component's lifetime. */
export function useTitle(title: string): void {
    useHead({ title });
}

/** Declarative form of {@link useHead}: `<Head title="…" meta={[…]} />`. Renders nothing. */
export function Head(props: HeadSpec): null {
    useHead(props);
    return null;
}
