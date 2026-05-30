/**
 * toiljs client runtime, published as `toiljs/client`. Provides the router (mount/Router/Link),
 * navigation hooks, and route types consumed by the compiler-generated entry. Zero imports
 * needed in user route files beyond this package.
 */

export { mount, Router, Link, navigate, useParams, useNavigate, useLocation } from './runtime.js';
export type { RouteDef, LayoutLoader } from './runtime.js';
export { matchRoute } from './match.js';
export type { RouteParams } from './match.js';
export { connectChannel, useChannel, resolveChannelUrl } from './channel.js';
export type { Channel, ChannelOptions, ChannelHook, ChannelData } from './channel.js';
