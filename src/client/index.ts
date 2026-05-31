/**
 * toiljs client runtime, published as `toiljs/client`. Re-exports the router (mount/Router/Link),
 * navigation hooks, prefetching, and the route types consumed by the compiler-generated entry.
 * Zero imports needed in user route files beyond this package.
 *
 * Internals are split by concern: route `types`, history-based `navigation`, the params
 * `params-context` + `hooks`, `lazy` component resolution, the `Link`/`Router` components,
 * `mount`, `match` (pure matcher), `prefetch` (link prefetcher), and `channel` (WebSocket helper).
 */

export { mount } from './mount.js';
export { Router } from './Router.js';
export { Link } from './Link.js';
export type { LinkProps } from './Link.js';
export { NavLink, matchActive } from './NavLink.js';
export type { NavLinkProps, NavLinkState } from './NavLink.js';
export { navigate } from './navigation.js';
export type { NavigateOptions } from './navigation.js';
export { useParams, useNavigate, useLocation } from './hooks.js';
export { prefetch } from './prefetch.js';
export type { RouteDef, LayoutLoader, NotFoundLoader } from './types.js';
export { matchRoute } from './match.js';
export type { RouteParams } from './match.js';
export { connectChannel, useChannel, resolveChannelUrl } from './channel.js';
export type { Channel, ChannelOptions, ChannelHook, ChannelData } from './channel.js';
