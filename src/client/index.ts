/**
 * toiljs client runtime, published as `toiljs/client`. Re-exports the router (mount/Router/Link),
 * navigation hooks, prefetching, and the route types consumed by the compiler-generated entry.
 * Zero imports needed in user route files beyond this package.
 *
 * Internals are split by concern: route `types`, history-based `navigation`, the params
 * `params-context` + `hooks`, `lazy` component resolution, the `Link`/`Router` components,
 * `mount`, `match` (pure matcher), `prefetch` (link prefetcher), and `channel` (WebSocket helper).
 */

export { mount } from './routing/mount.js';
export { Router } from './routing/Router.js';
export { Link } from './navigation/Link.js';
export type { LinkProps } from './navigation/Link.js';
export { NavLink, matchActive } from './navigation/NavLink.js';
export type { NavLinkProps, NavLinkState } from './navigation/NavLink.js';
export { navigate, back, forward, refresh } from './navigation/navigation.js';
export type { NavigateOptions } from './navigation/navigation.js';
export {
    useParams,
    useNavigate,
    useLocation,
    usePathname,
    useSearchParams,
    useRouter,
    useNavigationPending,
} from './routing/hooks.js';
export type { RouterInstance } from './routing/hooks.js';
export { useLoaderData, revalidate, invalidateLoaderData } from './routing/loader.js';
export type { LoaderArgs, LoaderFunction, LoaderData, Revalidate } from './routing/loader.js';
export { useAction } from './routing/action.js';
export type {
    UseActionOptions,
    ActionState,
    ActionHandle,
    RevalidateTarget,
} from './routing/action.js';
export { prefetch } from './navigation/prefetch.js';
export type {
    RouteDef,
    LayoutLoader,
    LayoutComponentLoader,
    NotFoundLoader,
    RouteErrorProps,
    Register,
    RoutePath,
    Href,
} from './types.js';
export { matchRoute } from './routing/match.js';
export type { RouteParams } from './routing/match.js';
export { connectChannel, useChannel, resolveChannelUrl } from './channel/channel.js';
export type { Channel, ChannelOptions, ChannelHook, ChannelData } from './channel/channel.js';
export { useHead, useTitle, Head, mergeHead } from './head/head.js';
export type { HeadSpec, MetaTag, LinkTag, ResolvedHead } from './head/head.js';
export { resolveMetadata } from './head/metadata.js';
export type { Metadata, GenerateMetadata, GenerateMetadataArgs, OpenGraph } from './head/metadata.js';
export { Image } from './components/Image.js';
export type { ImageProps } from './components/Image.js';
export { Script } from './components/Script.js';
export type { ScriptProps, ScriptStrategy } from './components/Script.js';
export { Form } from './components/Form.js';
export type { FormProps } from './components/Form.js';
export { Slot } from './components/Slot.js';
export type { SlotProps } from './components/Slot.js';
