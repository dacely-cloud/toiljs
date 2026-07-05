# The Toil global (reference)

Almost the entire toiljs client API hangs off one global object, `Toil`, so your route files need no imports for the everyday things. This page is the full index: every `Toil.*` member, its TypeScript signature, and a one-line description, grouped by area. Reach for it when you know roughly what you want and just need the exact name or shape; the deeper guides (linked per section) explain the concepts.

`Toil` is not a hand-written object. It is the module namespace of the `toiljs/client` package, exposed as a global. The compiler writes a `toil-env.d.ts` at your project root containing `declare const Toil: typeof import('toiljs/client')`, so `Toil` is typed as the whole package and every member autocompletes with no import. Put another way: anything you could `import { X } from 'toiljs/client'` is reachable as `Toil.X`.

A few members are also bare globals, handed to you the same way. `Server` (the typed backend client) and `parseError` are global on their own and additionally live under `Toil` (so `Server` and `Toil.Server` are the same value, likewise `parseError`). `FastMap`, `FastSet`, `DataWriter`, and `DataReader` (the fast collections and compact binary codec from `toiljs/io`, see [Data types](../backend/data.md)) are bare globals only: they are not under `Toil`, so write `new DataWriter()`, never `new Toil.DataWriter()`.

## Components (JSX)

Drop-in components you render in JSX. See [Images](./images.md), [Scripts](./scripts.md), [Fetching data](./data-fetching.md), and [Metadata and SEO](./metadata.md) for the detail.

| Member | Signature | Description |
| --- | --- | --- |
| `Toil.Image` | `Image(props: ImageProps): ReactNode` | A drop-in `<img>` that reserves space (no layout shift), lazy-loads, and can fade in from a blur placeholder. See [Images](./images.md). |
| `Toil.Script` | `Script(props: ScriptProps): ReactNode` | Loads an external or inline `<script>` with a load `strategy`, deduplicated so it runs at most once. Renders nothing. See [Scripts](./scripts.md). |
| `Toil.Form` | `Form(props: FormProps): ReactNode` | A `<form>` that runs an action on submit (no reload) and revalidates loader data on success. See [Fetching data](./data-fetching.md). |
| `Toil.Slot` | `Slot(props: SlotProps): ReactNode` | Renders the parallel-route slot named `props.name` (`{ name: string; fallback?: ReactNode }`) for the current URL. See [Routing](./routing.md). |
| `Toil.Head` | `Head(props: HeadSpec): null` | Declarative form of `useHead`: `<Toil.Head title="..." meta={[...]} />`. Renders nothing. See [Metadata and SEO](./metadata.md). |
| `Toil.Metadata` | `Metadata(props: Metadata): null` | Declarative form of `useMetadata`: `<Toil.Metadata title="..." openGraph={...} />`. Renders nothing. See [Metadata and SEO](./metadata.md). |
| `Toil.Router` | `Router(props: { routes; layout?; notFound?; globalError?; slots? }): ReactNode` | The app router element. `Toil.mount` renders this for you, so you rarely use it directly. |

## SSR marker primitives

These mark a route's dynamic bits so the edge can server-render it (the compiler's template extractor finds them deterministically). They are transparent at runtime: in the browser they render exactly the normal tree. See [Components](./components.md) and [Rendering and SSR](./rendering.md).

| Member | Signature | Description |
| --- | --- | --- |
| `Toil.Hole` | `Hole(props: HoleProps): ReactNode` | A scalar text hole (`{ id: string; children?: ReactNode }`); renders `children` in the browser, a text insertion point under the SSR extractor. |
| `Toil.Repeat` | `Repeat<T>(props: RepeatProps<T>): ReactNode` | A repeat region (`{ id; each: readonly T[]; children: (item: T, index: number) => ReactNode }`); `each.map(children)` in the browser. |
| `Toil.RawHtml` | `RawHtml(props: RawHtmlProps): ReactNode` | A raw-HTML block hole (`{ id; html; as? }`); wraps `dangerouslySetInnerHTML` in a host element (default `div`). |
| `Toil.attr` | `attr(id: string, value: string): string` | An attribute-value hole, used in attribute position (`href={Toil.attr('u', d.url)}`); returns `value` unchanged in the browser. |
| `Toil.Island` | `Island(props: IslandProps): ReactNode` | A client-only escape hatch (`{ children? }`); renders nothing on the server and first paint, then reveals `children` after mount (so no SSR / SEO, by design). |

## Navigation

Client-side links and imperative navigation. Detailed guide: [Navigation](./navigation.md).

| Member | Signature | Description |
| --- | --- | --- |
| `Toil.Link` | `Link(props: LinkProps): ReactNode` | A client-side navigation `<a>`: no full reload, prefetches on hover/focus, falls through to the browser for external / `target` / `download` / `#hash` links. |
| `Toil.NavLink` | `NavLink(props: NavLinkProps): ReactNode` | A `Link` that adds an active class (default `"active"`) and `aria-current="page"` when it points at the current page. |
| `Toil.matchActive` | `matchActive(linkPath: string, currentPath: string, end: boolean): boolean` | Whether a link to `linkPath` is active for `currentPath` (the pure rule behind `NavLink`). |
| `Toil.navigate` | `navigate(href: Href, options?: NavigateOptions): void` | Navigate in code (no hook needed), pushing history or replacing with `{ replace: true }`. |
| `Toil.back` | `back(): void` | Go back one history entry. |
| `Toil.forward` | `forward(): void` | Go forward one history entry. |
| `Toil.refresh` | `refresh(): void` | Re-render the current route and re-run its loader (its `loading.tsx` shows while it re-fetches). |
| `Toil.href` | `href(path: string): Href` | Assert a runtime-built string is a valid `Href`. Escape hatch for a path assembled from data. |
| `Toil.prefetch` | `prefetch(href: string): void` | Warm a route's chunk ahead of navigation; a no-op for external, unknown, or already-warmed targets. |
| `Toil.setViewTransitions` | `setViewTransitions(enabled: boolean): void` | Enable animated View Transitions for navigation (normally set once from `client.viewTransitions`). |
| `Toil.setTransitions` | `setTransitions(enabled: boolean): void` | Keep the current page visible until the next route is ready (normally set once from `client.transitions`). |

## Routing and location hooks

Hooks a component uses to read where it is and to get a router handle.

| Member | Signature | Description |
| --- | --- | --- |
| `Toil.useParams` | `useParams<T extends RouteParams = RouteParams>(): T` | Read the dynamic route params, e.g. `{ id }` for `/blog/[id]`. Values are always strings. |
| `Toil.useNavigate` | `useNavigate(): (href: Href, options?: NavigateOptions) => void` | Returns the bare `navigate` function. |
| `Toil.useRouter` | `useRouter(): RouterInstance` | Returns the router handle (`push` / `replace` / `back` / `forward` / `refresh` / `revalidate` / `prefetch`). |
| `Toil.useLocation` | `useLocation(): string` | The current pathname, re-read on each navigation (an alias of `usePathname`). |
| `Toil.usePathname` | `usePathname(): string` | The current pathname, e.g. `"/blog/42"`. |
| `Toil.useSearchParams` | `useSearchParams(): URLSearchParams` | The query string as a `URLSearchParams`, re-read on each navigation. |
| `Toil.useNavigationPending` | `useNavigationPending(): boolean` | `true` while a navigation is in flight (drives a top loading bar). |
| `Toil.matchRoute` | `matchRoute(pattern: string, pathname: string): RouteParams \| null` | Pure route matcher: extract params, or `null` if the pattern does not match. |

## Route data and mutations

Loaders read data on navigation, actions write it. See [Fetching data](./data-fetching.md).

| Member | Signature | Description |
| --- | --- | --- |
| `Toil.useLoaderData` | `useLoaderData<L extends LoaderFunction>(loader: L): Awaited<ReturnType<L>>` | Read the data the current route's `loader` returned. Passing `loader` infers the type; the no-arg `useLoaderData<T>()` returns `unknown` unless you supply `T`. |
| `Toil.revalidate` | `revalidate(href?: string): void` | Invalidate loader data and re-render so the active route (or a given href) re-fetches. Call after a mutation; usable outside React. |
| `Toil.invalidateLoaderData` | `invalidateLoaderData(href?: string): void` | Drop cached loader data (all routes, or one href) without re-rendering. |
| `Toil.useAction` | `useAction<TInput = void, TData = unknown>(fn: (input: TInput) => TData \| Promise<TData>, options?: UseActionOptions<TData>): ActionHandle<TInput, TData>` | Run a mutation with pending / error / result tracking; revalidates loader data on success. |

## Head and metadata

Set the document `<head>` from a component or resolve a route's metadata. See [Metadata and SEO](./metadata.md).

| Member | Signature | Description |
| --- | --- | --- |
| `Toil.useHead` | `useHead(spec: HeadSpec): void` | Apply a title / `<meta>` / `<link>` contribution for the component's lifetime (reverts on unmount, composes across the tree). |
| `Toil.useTitle` | `useTitle(title: string): void` | Set `document.title` for the component's lifetime. |
| `Toil.mergeHead` | `mergeHead(specs: readonly HeadSpec[]): ResolvedHead` | Merge head specs in order: the last `title` wins, `meta` dedupes by name/property, `link` by rel+href. |
| `Toil.useMetadata` | `useMetadata(metadata: Metadata): void` | Apply a route-style `Metadata` object from inside any component (the runtime counterpart of a route's `metadata` export). |
| `Toil.resolveMetadata` | `resolveMetadata(metadata: Metadata): HeadSpec` | Expand a `Metadata` object into a title plus concrete `<meta>` / `<link>` tags. |

## Page search

Query the statically-baked index of your pages' metadata. See [Search](./search.md).

| Member | Signature | Description |
| --- | --- | --- |
| `Toil.searchPages` | `searchPages(query: string, options?: PageSearchOptions): PageSearchResult[]` | Rank the registered page index against a query (pure, framework-agnostic; AND semantics across terms). |
| `Toil.usePageSearch` | `usePageSearch(query: string, options?: PageSearchOptions): PageSearch` | React binding for `searchPages`, memoized, with a `goTo` helper that navigates to a match. |
| `Toil.registerPages` | `registerPages(pages: readonly PageMeta[]): void` | Replace the live page index. Called once at startup by the generated bundle; rarely called by user code. |
| `Toil.getPages` | `getPages(): readonly PageMeta[]` | The registered page index (every page, including dynamic ones). Empty before registration. |
| `Toil.pagePath` | `pagePath(target: string \| PageMeta \| PageSearchResult): string` | Normalize a result / page / raw path to its route path string. |

## Realtime

Open a channel or a typed stream to the backend. See [Channels](../realtime/channels.md) and [Streams](../realtime/streams.md).

| Member | Signature | Description |
| --- | --- | --- |
| `Toil.connectChannel` | `connectChannel(onMessage: (data: ChannelData) => void, options?: ChannelOptions): Channel` | Open a WebSocket channel to the backend, invoking `onMessage` per frame; returns `send` / `close`. |
| `Toil.useChannel` | `useChannel(options?: ChannelOptions): ChannelHook` | React hook over `connectChannel`: connects on mount, tracks `connected` + `messages`, exposes `send`. |
| `Toil.resolveChannelUrl` | `resolveChannelUrl(path?: string, location?: { protocol: string; host: string }): string` | Derive the channel's `ws(s)://` URL from the current page location. |
| `Toil.makeStreamClient` | `makeStreamClient(routes: Record<string, string>, origin?: string, encoders?: Record<string, (msg: never) => Uint8Array>): StreamClient` | Build the `Server.Stream` client from the generated route map. Used by generated code; rarely called directly. |

## Backend client, errors, bootstrap

| Member | Signature | Description |
| --- | --- | --- |
| `Toil.Server` | `Server.REST.<controller>.<route>(args)` / `Server.Stream.<class>.connect(path?)` / `Server.<service>.<method>(args)` | The typed backend surface. Its shape is generated into `shared/server.ts`; this global is the runtime behind it. See [Fetching data](./data-fetching.md). |
| `Toil.parseError` | `parseError(err: unknown): string` | Extract a human-readable message from an unknown thrown value: `Error.message`, else `String(err)`. |
| `Toil.mount` | `mount(routes: RouteDef[], layout?: LayoutLoader, notFound?: NotFoundLoader, globalError?: ErrorComponentLoader, slots?: Record<string, RouteDef[]>): void` | Boot the app into `#root` and start idle link prefetching. Called by the generated entry file; you rarely call it yourself. |

## Auth

The whole password-auth client lives under `Toil.Auth`, and its error family is exposed on `Toil.*` (and mirrored under `Toil.Auth.*`) so you can branch on it. The password never leaves the browser. See [Auth](../auth/README.md).

| Member | Signature | Description |
| --- | --- | --- |
| `Toil.Auth.register` | `register(username: string, password: string, email: string, opts?: AuthOptions): Promise<void>` | Create an account (only a derived public key is ever sent). Throws `UsernameTakenError` / `EmailInUseError` on conflict. |
| `Toil.Auth.login` | `login(username: string, password: string, opts?: AuthOptions): Promise<Uint8Array>` | Log in with mutual authentication; resolves to the opaque session token. |
| `Toil.Auth.confirmEmail` | `confirmEmail(token: string, opts?: AuthOptions): Promise<void>` | Confirm an account from the one-time token in the emailed link. |
| `Toil.Auth.resendConfirmation` | `resendConfirmation(email: string, opts?: AuthOptions): Promise<void>` | Ask the server to re-send the confirmation email (never reveals whether the address exists). |
| `Toil.Auth.requestPasswordReset` | `requestPasswordReset(email: string, opts?: AuthOptions): Promise<void>` | Begin a password reset by emailing a link (anti-enumeration: always resolves). |
| `Toil.Auth.resetPassword` | `resetPassword(token: string, newPassword: string, opts?: AuthOptions): Promise<void>` | Complete a reset from the token plus a new password. |
| `Toil.Auth.verifyTwoFactor` | `verifyTwoFactor(twoFaId: string, code: string, opts?: AuthOptions): Promise<Uint8Array>` | Finish a 2FA login by submitting the code for `twoFaId`; resolves to the session token. |
| `Toil.Auth.setupTwoFactor` | `setupTwoFactor(method: number, opts?: AuthOptions): Promise<void>` | Begin enabling or disabling 2FA for the current session user (pass a `TwoFactorMethod` value). |
| `Toil.Auth.confirmTwoFactorSetup` | `confirmTwoFactorSetup(code: string, opts?: AuthOptions): Promise<void>` | Confirm a pending `setupTwoFactor` with the delivered code. |
| `Toil.Auth.twoFactorStatus` | `twoFactorStatus(opts?: AuthOptions): Promise<number>` | The current user's 2FA method (a `TwoFactorMethod` value; `0` means off). |
| `Toil.Auth.TwoFactorMethod` | `{ None: 0, Email: 1 }` | The 2FA method values, mirroring the server enum. |

The typed error surface (each error carries a stable `code`, and every subclass maps 1:1 to an `AuthErrorCode`):

| Member | Signature | Description |
| --- | --- | --- |
| `Toil.AuthError` | `class AuthError extends Error { readonly code: AuthErrorCode }` | Base class for every auth error. `err instanceof Toil.AuthError` narrows the whole family; `err.code` discriminates within it. |
| `Toil.AuthErrorCode` | `enum AuthErrorCode` (string values) | The stable, machine-readable discriminant carried as `err.code`. Branch on this, never on `err.message` or `err.name`. |
| `Toil.UsernameTakenError` | `class UsernameTakenError extends AuthError` | register: the username is already registered (`AuthErrorCode.UsernameTaken`). |
| `Toil.EmailInUseError` | `class EmailInUseError extends AuthError` | register: the email is already in use (`AuthErrorCode.EmailInUse`). |
| `Toil.InvalidCredentialsError` | `class InvalidCredentialsError extends AuthError` | login: wrong username or password (`AuthErrorCode.InvalidCredentials`). |
| `Toil.EmailNotConfirmedError` | `class EmailNotConfirmedError extends AuthError` | login: valid credential, but the email is not confirmed (`AuthErrorCode.EmailNotConfirmed`). |
| `Toil.TwoFactorRequiredError` | `class TwoFactorRequiredError extends AuthError { readonly twoFaId: string }` | login: a second factor is required; echo `err.twoFaId` to `verifyTwoFactor` (`AuthErrorCode.TwoFactorRequired`). |
| `Toil.ServerAuthFailedError` | `class ServerAuthFailedError extends AuthError` | login/2fa: the server failed to prove its identity, possible MITM (`AuthErrorCode.ServerAuthFailed`). |
| `Toil.TwoFactorCodeError` | `class TwoFactorCodeError extends AuthError` | 2fa: the code was wrong, expired, or already used (`AuthErrorCode.TwoFactorCodeInvalid`). |
| `Toil.ConfirmationInvalidError` | `class ConfirmationInvalidError extends AuthError` | confirm: the confirmation link was invalid or expired (`AuthErrorCode.ConfirmationInvalid`). |
| `Toil.PasswordResetInvalidError` | `class PasswordResetInvalidError extends AuthError` | reset: the reset link was invalid or expired (`AuthErrorCode.PasswordResetInvalid`). |

The `AuthErrorCode` string values:

```ts
enum AuthErrorCode {
  RequestFailed = 'request_failed',
  ProtocolError = 'protocol_error',
  UsernameTaken = 'username_taken',
  EmailInUse = 'email_in_use',
  RegistrationRejected = 'registration_rejected',
  InvalidCredentials = 'invalid_credentials',
  EmailNotConfirmed = 'email_not_confirmed',
  TwoFactorRequired = 'two_factor_required',
  ServerAuthFailed = 'server_auth_failed',
  TwoFactorCodeInvalid = 'two_factor_code_invalid',
  TwoFactorSetupFailed = 'two_factor_setup_failed',
  ConfirmationInvalid = 'confirmation_invalid',
  PasswordResetInvalid = 'password_reset_invalid',
}
```

Catch by class for the common branches, or on `err.code` for a precise check:

```tsx
try {
  const token = await Toil.Auth.login(username, password);
  // ... persist the session token and redirect
} catch (err) {
  if (err instanceof Toil.EmailNotConfirmedError) return promptEmailConfirmation();
  if (err instanceof Toil.TwoFactorRequiredError) return promptTwoFactorCode(err.twoFaId);
  if (err instanceof Toil.AuthError && err.code === Toil.AuthErrorCode.InvalidCredentials) {
    return setError('Incorrect username or password.');
  }
  throw err;
}
```

## A note on types

Every member above is a value, and values on `Toil.*` need no import: `Toil.Link`, `Toil.useParams`, `Toil.Auth.login`. Types are different. In type position, only a small set are namespaced as `Toil.<Type>`, because the generated `toil-env.d.ts` aliases exactly these under a `declare namespace Toil` block:

`LoaderArgs`, `LoaderFunction`, `Revalidate`, `Metadata`, `GenerateMetadata`, `GenerateStaticParams`, `StaticParams`, `RouteErrorProps`, `Href`, `RoutePath`, `PageMeta`, `SearchHints`.

So a loader can annotate its argument with no import:

```tsx
export const loader = async ({ params }: Toil.LoaderArgs) => { /* ... */ };
```

Every other exported type (for example `LinkProps`, `NavLinkState`, `NavigateOptions`, `RouterInstance`, `ImageProps`, `ScriptProps`, `FormProps`, `ActionState`) is not in that namespace, so it must be imported from the package:

```tsx
import type { ImageProps } from 'toiljs/client';
```

## Related

- [Navigation](./navigation.md): links, active state, and navigating in code.
- [Components](./components.md): the built-in components and the SSR marker primitives.
- [Fetching data](./data-fetching.md): the `Server` client, loaders, actions, and forms.
- [Metadata and SEO](./metadata.md): titles, descriptions, and social-share tags per route.
- [Auth](../auth/README.md): the full password-auth client and its error handling.
