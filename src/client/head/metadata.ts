/**
 * Route metadata, the declarative SEO counterpart to `useHead`/`<Head>`. A route file may
 * `export const metadata` (static) or `export const generateMetadata` (dynamic, using its loader
 * data); the compiler-driven loader resolves it to a {@link HeadSpec} that the router applies as the
 * route's baseline head (component-level `useHead`/`<Head>` still compose on top and can override).
 */
import { useHead, type HeadSpec, type LinkTag, type MetaTag } from './head.js';
import type { RouteParams } from '../routing/match.js';

/** OpenGraph fields, expanded to `og:*` meta tags. */
export interface OpenGraph {
    readonly title?: string;
    readonly description?: string;
    readonly type?: string;
    readonly url?: string;
    readonly image?: string;
    readonly siteName?: string;
}

/** A route's metadata. Convenience fields expand to the right `<meta>`/`<link>` tags. */
export interface Metadata {
    /** Document title. */
    readonly title?: string;
    /** Template applied to the title (`%s` = the title), e.g. `'%s · toiljs'`. */
    readonly titleTemplate?: string;
    /** `<meta name="description">`. */
    readonly description?: string;
    /** `<meta name="keywords">`, joined with `, ` if an array. */
    readonly keywords?: string | readonly string[];
    /** `<link rel="canonical">`. */
    readonly canonical?: string;
    /** `<meta name="robots">`, e.g. `'noindex, nofollow'`. */
    readonly robots?: string;
    /** `<meta name="theme-color">`. */
    readonly themeColor?: string;
    /** OpenGraph (`og:*`) tags. */
    readonly openGraph?: OpenGraph;
    /** Escape hatch: extra raw `<meta>` tags. */
    readonly meta?: readonly MetaTag[];
    /** Escape hatch: extra raw `<link>` tags. */
    readonly link?: readonly LinkTag[];
}

/** Arguments passed to {@link GenerateMetadata}: route params, query, and the loader's data. */
export interface GenerateMetadataArgs<T = unknown> {
    readonly params: RouteParams;
    readonly searchParams: URLSearchParams;
    readonly data: T;
}

/** A route's `export const generateMetadata`, dynamic metadata derived from params/query/loader data. */
export type GenerateMetadata<T = unknown> = (
    args: GenerateMetadataArgs<T>,
) => Metadata | Promise<Metadata>;

/** Expands a {@link Metadata} into a {@link HeadSpec} (title + concrete meta/link tags). */
export function resolveMetadata(metadata: Metadata): HeadSpec {
    const meta: MetaTag[] = [];
    if (metadata.description !== undefined) {
        meta.push({ name: 'description', content: metadata.description });
    }
    if (metadata.keywords !== undefined) {
        const content =
            typeof metadata.keywords === 'string'
                ? metadata.keywords
                : metadata.keywords.join(', ');
        meta.push({ name: 'keywords', content });
    }
    if (metadata.robots !== undefined) meta.push({ name: 'robots', content: metadata.robots });
    if (metadata.themeColor !== undefined) {
        meta.push({ name: 'theme-color', content: metadata.themeColor });
    }
    const og = metadata.openGraph;
    if (og) {
        const pairs: readonly [string, string | undefined][] = [
            ['og:title', og.title],
            ['og:description', og.description],
            ['og:type', og.type],
            ['og:url', og.url],
            ['og:image', og.image],
            ['og:site_name', og.siteName],
        ];
        for (const [property, content] of pairs) {
            if (content !== undefined) meta.push({ property, content });
        }
    }
    if (metadata.meta) meta.push(...metadata.meta);

    const link: LinkTag[] = [];
    if (metadata.canonical !== undefined) link.push({ rel: 'canonical', href: metadata.canonical });
    if (metadata.link) link.push(...metadata.link);

    return { title: metadata.title, titleTemplate: metadata.titleTemplate, meta, link };
}

/**
 * Applies a route-style {@link Metadata} object from inside any component for that component's
 * lifetime, reverting on unmount. The runtime counterpart of a route's `metadata` export, for
 * content that isn't itself a route file (a rendered article, a widget, ...). Composes through the
 * head manager like {@link useHead}; a route's own `metadata` (applied last) still wins for keys it
 * sets, so this fills in for routes that declare none. Resolved fresh each render, the head manager
 * dedupes by value, so passing a computed object is fine.
 */
export function useMetadata(metadata: Metadata): void {
    useHead(resolveMetadata(metadata));
}

/** Declarative form of {@link useMetadata}: `<Metadata title="…" openGraph={…} />`. Renders nothing. */
export function Metadata(props: Metadata): null {
    useMetadata(props);
    return null;
}
