# Changelog

## [v0.0.102] - 2026-07-05

- No changes


## [v0.0.101] - 2026-07-05

- No changes


## [v0.0.100] - 2026-07-05

- No changes


## [v0.0.99] - 2026-07-05

- No changes


## [v0.0.98] - 2026-07-05

- No changes


## [v0.0.97] - 2026-07-05

- No changes


## [v0.0.96] - 2026-07-05

- No changes


## [v0.0.95] - 2026-07-05

- No changes


## [v0.0.94] - 2026-07-05

- No changes


## [v0.0.93] - 2026-07-05

- No changes


## [v0.0.92] - 2026-07-05

- No changes


## [v0.0.91] - 2026-07-05

- No changes


## [v0.0.89] - 2026-07-04

- No changes


## [v0.0.87] - 2026-07-03

- No changes


## [v0.0.85] - 2026-07-03

- No changes


## [v0.0.84] - 2026-07-02

- No changes


## [v0.0.83] - 2026-07-01

- No changes


## [v0.0.82] - 2026-07-01

- No changes


## [v0.0.81] - 2026-06-29

- No changes


## [v0.0.81] - 2026-06-29

- `Image` `placeholder="blur"` now works without manual setup. Importing with the `?toil` flag (`import hero from './hero.webp?toil'`) runs a build-time `sharp` step that generates a tiny resized + blurred base64 LQIP plus the intrinsic dimensions, and `Image` consumes that object to auto-fill the blur placeholder and aspect-ratio (the Next.js static-import model).
- A plain string `src` with no `blurDataURL` now falls back to a neutral skeleton shimmer instead of rendering nothing.
- `width`+`height` (or the `?toil` dimensions) emit an explicit `aspect-ratio`, so the image reserves space and can't shift layout on load — for both the plain and `fill` paths. Rebuild to pick up the updated shell CSS.

## [v0.0.80] - 2026-06-29

- No changes


## [v0.0.80] - 2026-06-29

- Fix `Image` `fill`: it no longer absolutely-positions the image, which (without a positioned, sized ancestor) made it either fill the whole page or collapse to a zero-height box and vanish. `fill` now lays out in-block — it fills its box's width at natural height, or covers the box when sized via `width`/`height`/`aspectRatio` — so it can't escape or disappear. Rebuild to pick up the updated shell CSS.

## [v0.0.79] - 2026-06-29

- No changes


## [v0.0.79] - 2026-06-29

- Add `SlotValues.setTitle(s)`: a guest `render` can set a per-request SSR `<title>` (e.g. a data-driven blog or profile title). The host splices it into the document title and strips the internal carrier header so it never reaches the client. Build-time titles (static metadata / the component head) are unchanged; `setTitle` only overrides when the guest opts in.

## [v0.0.78] - 2026-06-29

- No changes


## [v0.0.78] - 2026-06-29

- Render component-level head server-side: `useHead`/`useTitle`/`<Head>` set in a layout or page (not just a route's static `metadata`) now appear in the SSR HTML, deduped against the route's SEO and owned by the client head manager on hydration.

## [v0.0.77] - 2026-06-29

- No changes


## [v0.0.77] - 2026-06-29

- Remove `titleTemplate` from the head/metadata API. It only applied client-side (never in the SSR HTML) and confusingly diverged the server vs client `<title>`. Set a route's full title directly; a layout's `<Head title>` is still the fallback for routes that set none.
- SSR routes referencing an imported image asset (which resolves to a dev-only URL) now fall back to client rendering with a clear warning instead of baking a URL that 404s in production. Reference images on SSR routes via a public/ string path (`src="/images/x.webp"`) for full SSR.
- `Image` `fill` now wraps the image in its own positioned, block-level box (sized via `width`/`height` or `style`), so it can only ever fill that box — never the whole page; `className`/`style` apply to the box.

## [v0.0.76] - 2026-06-29

- SSR routes now render their per-page SEO in the served `<head>`: each `ssr=true` route bakes its resolved metadata (title, description, canonical, og:* incl `og:image`, twitter, jsonLd) into the template head, at parity with the static prerendered page. Previously every SSR route served the generic shell `<head>`, so per-route titles/descriptions and social-preview images were missing server-side.
- `Image`'s `fill` and blur placeholder now lay out via overridable CSS classes (`toil-img-fill` / `toil-img-blur`, shipped in the shell `<head>`) instead of forced-inline styles, so they are SSR-safe and the app's own CSS can override them.

## [v0.0.75] - 2026-06-29

- No changes


## [v0.0.75] - 2026-06-29

- Fix the dev-server module validator to accept the `analytics_read` + `analytics_list_sites` host imports, so an app using toilscript's `Analytics` API loads under `toiljs dev` SSR (0.0.74 shipped the runtime stubs but the validator still rejected the imports).
- Stream the `@connect`-staged egress as the connection's initial frames.

## [v0.0.74] - 2026-06-28

### Other Changes

- fix(client): make Link inert for a missing href instead of throwing ([#204](https://github.com/dacely-cloud/toiljs/pull/204)) by @BlobMaster41




## [v0.0.74] - 2026-06-28

- Add the dev-server analytics runtime: `env.analytics_read` + `env.analytics_list_sites` stubs, so toilscript 0.1.49's `Analytics` API works under `toiljs dev` (mirrors the edge ABI: bounds, UTF-8, cursor pagination).
- Fix the production server (`npm start`) to serve each route's prerendered `<route>/index.html` instead of the root shell, so per-page metadata shows in view-source.
- Keep the dev toolbar/overlay out of production builds.
- Make `Link` inert for a missing `href` instead of throwing (#204).

## [v0.0.73] - 2026-06-26

- No changes


## [v0.0.72] - 2026-06-26

- No changes


## [v0.0.71] - 2026-06-26

- No changes


## [v0.0.70] - 2026-06-26

- No changes


## [v0.0.69] - 2026-06-25

- No changes


## [v0.0.68] - 2026-06-25

- No changes


## [v0.0.67] - 2026-06-24

- No changes


## [v0.0.66] - 2026-06-24

- No changes


## [v0.0.65] - 2026-06-24

- No changes


## [v0.0.64] - 2026-06-24

- No changes


## [v0.0.63] - 2026-06-24

### Other Changes

- fix(ssr): emit Suspense markers so edge-SSR documents hydrate cleanly ([#202](https://github.com/dacely-cloud/toiljs/pull/202)) by @BlobMaster41
- fix(example): remove @stream Echo from examples/basic so it builds ([#203](https://github.com/dacely-cloud/toiljs/pull/203)) by @BlobMaster41




## [v0.0.62] - 2026-06-24

### Other Changes

- fix(ssr): client-render SSR documents instead of hydrating ([#200](https://github.com/dacely-cloud/toiljs/pull/200)) by @BlobMaster41
- feat(ssr): true hydration (renderToString + text-boundary markers) ([#201](https://github.com/dacely-cloud/toiljs/pull/201)) by @BlobMaster41




## [v0.0.61] - 2026-06-24

### Other Changes

- feat(toiljs): two-pass build + cold-artifact daemon dev runtime (M1 Phase 0) ([#196](https://github.com/dacely-cloud/toiljs/pull/196)) by @BlobMaster41
- feat(ssr): auto-generate the SSR slots module (no committed copy) + generate TOIL_DOCS from docs/*.md ([#197](https://github.com/dacely-cloud/toiljs/pull/197)) by @BlobMaster41
- SSR gap fixes + docs em-dash cleanup + CI ([#198](https://github.com/dacely-cloud/toiljs/pull/198)) by @BlobMaster41
- fix(devserver): only enforce DB route-kind gating when the guest declares it ([#199](https://github.com/dacely-cloud/toiljs/pull/199)) by @BlobMaster41




## [v0.0.60] - 2026-06-21

- No changes


## [v0.0.59] - 2026-06-20

### Other Changes

- fix(deps): 0 npm-audit vulnerabilities ([#194](https://github.com/dacely-cloud/toiljs/pull/194)) by @BlobMaster41
- chore(release): 0.0.59 ([#195](https://github.com/dacely-cloud/toiljs/pull/195)) by @BlobMaster41




## [v0.0.58] - 2026-06-20

### Other Changes

- chore(release): 0.0.58 ([#193](https://github.com/dacely-cloud/toiljs/pull/193)) by @BlobMaster41




## [v0.0.56] - 2026-06-18

### Other Changes

- feat(toildb): membership family dev emulator ([#181](https://github.com/dacely-cloud/toiljs/pull/181)) by @BlobMaster41
- feat(toildb): capacity family dev emulator ([#182](https://github.com/dacely-cloud/toiljs/pull/182)) by @BlobMaster41




## [v0.0.54] - 2026-06-17

- No changes


## [v0.0.53] - 2026-06-17

- No changes


## [v0.0.52] - 2026-06-17

### Other Changes

- feat(doctor): warn when a script wraps toiljs in npx ([#173](https://github.com/dacely-cloud/toiljs/pull/173)) by @BlobMaster41
- feat(auth): Toil PQ-Auth — post-quantum password login (OPRF keyed salt + ML-KEM mutual auth) ([#174](https://github.com/dacely-cloud/toiljs/pull/174)) by @BlobMaster41




## [v0.0.51] - 2026-06-16

### Other Changes

- fix(dev): restore cooked terminal input mode on shutdown ([#172](https://github.com/dacely-cloud/toiljs/pull/172)) by @BlobMaster41




## [v0.0.50] - 2026-06-16

### Other Changes

- chore(deps): toilscript ^0.1.27 + drop duplicate RateLimit decl ([#171](https://github.com/dacely-cloud/toiljs/pull/171)) by @BlobMaster41




## [v0.0.49] - 2026-06-16

### Other Changes

- fix(dev): harden Ctrl+C/watcher, recolor vite (ssr) log, graceful update, copy ([#170](https://github.com/dacely-cloud/toiljs/pull/170)) by @BlobMaster41




## [v0.0.48] - 2026-06-16

### Other Changes

- chore(deps): bump toilscript to ^0.1.26 (TS2395 @data editor fix) ([#169](https://github.com/dacely-cloud/toiljs/pull/169)) by @BlobMaster41




## [v0.0.47] - 2026-06-16

### Other Changes

- feat(email): brand Welcome email + preview; fix Ctrl+C orphan + log color ([#168](https://github.com/dacely-cloud/toiljs/pull/168)) by @BlobMaster41




## [v0.0.46] - 2026-06-16

### Other Changes

- ⬆️(deps-dev): Bump @microsoft/api-extractor from 7.58.8 to 7.58.9 in the dev-deps group ([#158](https://github.com/dacely-cloud/toiljs/pull/158)) by @dependabot[bot]
- fix(dx): cover emails/ in scaffold tsconfig + prettier-ignore generated files ([#166](https://github.com/dacely-cloud/toiljs/pull/166)) by @BlobMaster41
- feat(dev): email preview tool + client CSS reuse in emails ([#167](https://github.com/dacely-cloud/toiljs/pull/167)) by @BlobMaster41




## [v0.0.45] - 2026-06-16

### Other Changes

- feat(dev): fully implement email in dev mode (+ reusable Node mailer) ([#165](https://github.com/dacely-cloud/toiljs/pull/165)) by @BlobMaster41




## [v0.0.43] - 2026-06-15

### Other Changes

- fix(dx): type getUser/RateLimitService/TwoFactor in the editor; hydration-safe example (v0.0.43) ([#161](https://github.com/dacely-cloud/toiljs/pull/161)) by @BlobMaster41




## [v0.0.42] - 2026-06-15

### Other Changes

- chore(example): single-wasm demo (drop test-fixture tenants) ([#159](https://github.com/dacely-cloud/toiljs/pull/159)) by @BlobMaster41
- fix(dx): suppress AS235 + editor types (Time, decorators via toilscript 0.1.24) — v0.0.42 ([#160](https://github.com/dacely-cloud/toiljs/pull/160)) by @BlobMaster41




## [v0.0.41] - 2026-06-15

### Other Changes

- fix(dev): stop emails rebuild loop + editor types for server globals (v0.0.41) ([#157](https://github.com/dacely-cloud/toiljs/pull/157)) by @BlobMaster41




## [v0.0.40] - 2026-06-15

### Other Changes

- feat: email globals (EmailService/EmailTemplate/2FA) + React emails/ pipeline + client.ip ([#152](https://github.com/dacely-cloud/toiljs/pull/152)) by @BlobMaster41
- chore(emails): install juice@^12.1.0 for build-time CSS inlining ([#153](https://github.com/dacely-cloud/toiljs/pull/153)) by @BlobMaster41
- docs: Email and Rate limiting guides ([#154](https://github.com/dacely-cloud/toiljs/pull/154)) by @BlobMaster41
- chore: require toilscript ^0.1.23 (@ratelimit decorator) ([#155](https://github.com/dacely-cloud/toiljs/pull/155)) by @BlobMaster41
- chore: release v0.0.40 ([#156](https://github.com/dacely-cloud/toiljs/pull/156)) by @BlobMaster41




## [v0.0.39] - 2026-06-13

- No changes


## [v0.0.38] - 2026-06-13

### Other Changes

- fix(server-env): auto-generate the cookie-globals d.ts (fixes Cookie TS2345) ([#151](https://github.com/dacely-cloud/toiljs/pull/151)) by @BlobMaster41




## [v0.0.37] - 2026-06-13

### Other Changes

- fix(auth): PQ login over HTTP + full @auth session ([#150](https://github.com/dacely-cloud/toiljs/pull/150)) by @BlobMaster41




## [v0.0.36] - 2026-06-13

- No changes


## [v0.0.34] - 2026-06-13

### Other Changes

- feat(server): global cookie library (Cookie / Cookies / SecureCookies) covering RFC 6265bis attributes, prefixes, percent/base64url encoding, signing (HMAC-SHA256), and encryption (AES-256-GCM), with as-pect and end-to-end tests by @BlobMaster41
- fix: bignum @data fields cross JSON as decimal strings (exact past 2^53), toolchain on toilscript ^0.1.21 by @BlobMaster41
- test(rpc): regression test for the bignum JSON wire format by @BlobMaster41
- refactor(server): structured server layout (core/models/routes/services/scheduled) in the example and create templates by @BlobMaster41


## [v0.0.33] - 2026-06-12

### Other Changes

- feat(cli): frame the update warning in its own bordered box by @BlobMaster41
- feat(cli): randomized banner taglines by @BlobMaster41
- docs(readme): new positioning, table of contents, edge runtime capabilities and roadmap by @BlobMaster41


## [v0.0.32] - 2026-06-12

### Other Changes

- feat(cli): warn on every command when a newer toiljs is available ([#139](https://github.com/dacely-cloud/toiljs/pull/139)) by @BlobMaster41




## [v0.0.31] - 2026-06-12

### Other Changes

- v0.0.30: Web Crypto demo, oversized envelope handling, lazy uWS loading ([#136](https://github.com/dacely-cloud/toiljs/pull/136)) by @BlobMaster41
- ⬆️(deps-dev): Bump @microsoft/api-extractor from 7.58.7 to 7.58.8 in the dev-deps group ([#134](https://github.com/dacely-cloud/toiljs/pull/134)) by @dependabot[bot]
- ⬆️(deps): Bump sharp from 0.34.5 to 0.35.0 in the production-deps group ([#135](https://github.com/dacely-cloud/toiljs/pull/135)) by @dependabot[bot]
- deps: switch hyper-express to @dacely/hyper-express@6.17.4 ([#137](https://github.com/dacely-cloud/toiljs/pull/137)) by @BlobMaster41
- release 0.0.31: @dacely/hyper-express + @dacely/toilscript-loader, drop external direct deps ([#138](https://github.com/dacely-cloud/toiljs/pull/138)) by @BlobMaster41




## [v0.0.29] - 2026-06-08

### Other Changes

- fix(dev): buffer Vite proxy responses + yield page routes to the client ([#129](https://github.com/dacely-cloud/toiljs/pull/129)) by @BlobMaster41
- chore: bump toolchain to toilscript ^0.1.18 ([#130](https://github.com/dacely-cloud/toiljs/pull/130)) by @BlobMaster41
- chore: release v0.0.29 ([#131](https://github.com/dacely-cloud/toiljs/pull/131)) by @BlobMaster41




## [v0.0.28] - 2026-06-08

### Other Changes

- feat(dev): Web Crypto host functions in the dev server ([#127](https://github.com/dacely-cloud/toiljs/pull/127)) by @BlobMaster41
- harden(dev): bounds-safe params reader + short-GCM guard in the crypto mock ([#128](https://github.com/dacely-cloud/toiljs/pull/128)) by @BlobMaster41





## [v0.0.26] - 2026-06-08

### Other Changes

- fix(dev): color server build/rebuild logs + format server files ([#125](https://github.com/dacely-cloud/toiljs/pull/125)) by @BlobMaster41




## [v0.0.25] - 2026-06-07

### Other Changes

- fix(build)+feat(dev): visible server build + server-side hot reload ([#124](https://github.com/dacely-cloud/toiljs/pull/124)) by @BlobMaster41




## [v0.0.24] - 2026-06-07

### Other Changes

- feat(create): default install to Yes ([#123](https://github.com/dacely-cloud/toiljs/pull/123)) by @BlobMaster41




## [v0.0.23] - 2026-06-07

### Other Changes

- fix(create): scaffold a real server + compile all server files (fixes missing shared/) ([#122](https://github.com/dacely-cloud/toiljs/pull/122)) by @BlobMaster41




## [v0.0.22] - 2026-06-06

### Other Changes

- fix(example): server memory is per-request, not persistent ([#120](https://github.com/dacely-cloud/toiljs/pull/120)) by @BlobMaster41
- chore: target toilscript ^0.1.15 (lint-clean generated client); toiljs 0.0.22 ([#121](https://github.com/dacely-cloud/toiljs/pull/121)) by @BlobMaster41




## [v0.0.21] - 2026-06-06

### Other Changes

- chore: target toilscript ^0.1.14 (typed @data editor members); toiljs 0.0.21 ([#119](https://github.com/dacely-cloud/toiljs/pull/119)) by @BlobMaster41




## [v0.0.20] - 2026-06-06

### Other Changes

- fix(cli): toiljs build/dev build the server first; editor-clean example ([#117](https://github.com/dacely-cloud/toiljs/pull/117)) by @BlobMaster41
- feat(rest): return Response with headers + @data body; editor sees @data members + decorated classes ([#118](https://github.com/dacely-cloud/toiljs/pull/118)) by @BlobMaster41




## [v0.0.19] - 2026-06-06

### Other Changes

- feat(devtools): include the route's source code in AI prompts ([#108](https://github.com/dacely-cloud/toiljs/pull/108)) by @BlobMaster41
- fix(security): dev-endpoint hardening + full-codebase audit fixes ([#109](https://github.com/dacely-cloud/toiljs/pull/109)) by @BlobMaster41
- refactor(server): expose runtime as the toiljs/server/runtime library… ([#110](https://github.com/dacely-cloud/toiljs/pull/110)) by @BlobMaster41
- feat: server/runtime export + typed @data RPC client (Server, codec, doctor) ([#111](https://github.com/dacely-cloud/toiljs/pull/111)) by @BlobMaster41
- fix(io/cli): codec buffer-growth crash + i256, doctor --fix hardening ([#112](https://github.com/dacely-cloud/toiljs/pull/112)) by @BlobMaster41
- chore: toiljs 0.0.17 + RPC example demo + toolchain on toilscript 0.1.9 ([#113](https://github.com/dacely-cloud/toiljs/pull/113)) by @BlobMaster41
- fix(compiler): server-first build order + actionable error for missing shared/server ([#114](https://github.com/dacely-cloud/toiljs/pull/114)) by @BlobMaster41
- feat: prettier formats toilscript server (plugin) + doctor coverage; toilscript ^0.1.10 ([#115](https://github.com/dacely-cloud/toiljs/pull/115)) by @BlobMaster41
- feat(rest): @rest/@route HTTP layer + generated Server.REST fetch client ([#116](https://github.com/dacely-cloud/toiljs/pull/116)) by @BlobMaster41




## [v0.0.16] - 2026-06-03

### Other Changes

- feat: client/server config split, server rename, enforced client tooling ([#1](https://github.com/dacely-cloud/toiljs/pull/1)) by @BlobMaster41
- Epic branded CLI + interactive `toiljs create` ([#3](https://github.com/dacely-cloud/toiljs/pull/3)) by @BlobMaster41
- Client/server config split, src/server rename, enforced client tooling ([#2](https://github.com/dacely-cloud/toiljs/pull/2)) by @BlobMaster41
- feat: client WebSocket channel for the backend /_toil endpoint ([#7](https://github.com/dacely-cloud/toiljs/pull/7)) by @BlobMaster41
- feat: native BinaryWriter/BinaryReader + FastMap/FastSet (toiljs/io) ([#6](https://github.com/dacely-cloud/toiljs/pull/6)) by @BlobMaster41
- chore: remove all references ([#8](https://github.com/dacely-cloud/toiljs/pull/8)) by @BlobMaster41
- feat: harden the hyper-express backend server ([#9](https://github.com/dacely-cloud/toiljs/pull/9)) by @BlobMaster41
- feat: catch-all routes + custom 404 page ([#10](https://github.com/dacely-cloud/toiljs/pull/10)) by @BlobMaster41
- style: drop banner comments (TSDoc only) ([#11](https://github.com/dacely-cloud/toiljs/pull/11)) by @BlobMaster41
- feat: serve Vite dev through the hyper-express/uWS proxy ([#12](https://github.com/dacely-cloud/toiljs/pull/12)) by @BlobMaster41
- revert: drop the dev proxy (dev = plain Vite) ([#13](https://github.com/dacely-cloud/toiljs/pull/13)) by @BlobMaster41
- chore: unify test dirs (AssemblyScript specs under test/assembly) ([#14](https://github.com/dacely-cloud/toiljs/pull/14)) by @BlobMaster41
- feat(cli): brand color palette + tagline ([#15](https://github.com/dacely-cloud/toiljs/pull/15)) by @BlobMaster41
- fix(config): load toil.config via native ESM import ([#16](https://github.com/dacely-cloud/toiljs/pull/16)) by @BlobMaster41
- fix(io): ambient globals via toiljs/globals (toil-env.d.ts = pure reference) ([#17](https://github.com/dacely-cloud/toiljs/pull/17)) by @BlobMaster41
- feat(scaffold): brand default app styles ([#18](https://github.com/dacely-cloud/toiljs/pull/18)) by @BlobMaster41
- fix(io): self-contained toil-env.d.ts (fixes TS2304) ([#19](https://github.com/dacely-cloud/toiljs/pull/19)) by @BlobMaster41
- fix: inline toil-env globals + spawn DEP0190 + drop Next mentions (0.0.3) ([#21](https://github.com/dacely-cloud/toiljs/pull/21)) by @BlobMaster41
- feat(create): scaffold the WASM server (toilscript) setup ([#22](https://github.com/dacely-cloud/toiljs/pull/22)) by @BlobMaster41
- feat: one-command client+server build; example mirrors server setup ([#23](https://github.com/dacely-cloud/toiljs/pull/23)) by @BlobMaster41
- chore: say toilscript not AssemblyScript; clarify server eslint ignore ([#24](https://github.com/dacely-cloud/toiljs/pull/24)) by @BlobMaster41
- fix(compiler): extensionless route imports (TS5097) ([#25](https://github.com/dacely-cloud/toiljs/pull/25)) by @BlobMaster41
- feat(client): prefetch route chunks for visible & hovered links ([#26](https://github.com/dacely-cloud/toiljs/pull/26)) by @BlobMaster41
- refactor(client): split runtime.tsx into focused modules ([#27](https://github.com/dacely-cloud/toiljs/pull/27)) by @BlobMaster41
- feat(compiler): user-owned public/index.html template + static assets ([#28](https://github.com/dacely-cloud/toiljs/pull/28)) by @BlobMaster41
- feat(client): user-owned entry (client/toil.tsx), styles/components dirs, public/images, prettier HTML ([#29](https://github.com/dacely-cloud/toiljs/pull/29)) by @BlobMaster41
- feat(client): Toil native global + style-import types (TS2882) ([#30](https://github.com/dacely-cloud/toiljs/pull/30)) by @BlobMaster41
- feat(compiler): unified build/ output (build/client + build/server) ([#31](https://github.com/dacely-cloud/toiljs/pull/31)) by @BlobMaster41
- feat(cli): style-compiler choice, Tailwind, and toiljs configure ([#32](https://github.com/dacely-cloud/toiljs/pull/32)) by @BlobMaster41
- chore: strip inline comments (TSDoc only) + server tsconfig for toilscript ([#33](https://github.com/dacely-cloud/toiljs/pull/33)) by @BlobMaster41
- feat(compiler): move public/ under client (client/public) ([#34](https://github.com/dacely-cloud/toiljs/pull/34)) by @BlobMaster41
- fix(client): navigate via startTransition (kill Suspense flash) ([#35](https://github.com/dacely-cloud/toiljs/pull/35)) by @BlobMaster41
- fix(cli): robust toiljs configure + non-interactive flags ([#36](https://github.com/dacely-cloud/toiljs/pull/36)) by @BlobMaster41
- feat(client): Link forwards full anchor API + replace/prefetch ([#37](https://github.com/dacely-cloud/toiljs/pull/37)) by @BlobMaster41
- feat(client): NavLink (active class + aria-current) ([#38](https://github.com/dacely-cloud/toiljs/pull/38)) by @BlobMaster41
- feat(client): useRouter / usePathname / useSearchParams + history nav ([#39](https://github.com/dacely-cloud/toiljs/pull/39)) by @BlobMaster41
- feat(client): scroll management (top / restore / #hash) + scroll prop ([#40](https://github.com/dacely-cloud/toiljs/pull/40)) by @BlobMaster41
- feat(client): useNavigationPending() for loading indicators ([#41](https://github.com/dacely-cloud/toiljs/pull/41)) by @BlobMaster41
- feat(client): nested layouts (routes/**/layout.tsx) ([#42](https://github.com/dacely-cloud/toiljs/pull/42)) by @BlobMaster41
- feat(client): loading.tsx + error.tsx ([#43](https://github.com/dacely-cloud/toiljs/pull/43)) by @BlobMaster41
- feat(routing): optional catch-all [[...slug]] + route groups (group) ([#44](https://github.com/dacely-cloud/toiljs/pull/44)) by @BlobMaster41
- feat(create): AI-assistant helper files → .toil/docs ([#45](https://github.com/dacely-cloud/toiljs/pull/45)) by @BlobMaster41
- feat(create): AI assistant files are now selectable ([#46](https://github.com/dacely-cloud/toiljs/pull/46)) by @BlobMaster41
- feat(client): head/metadata API + file-based metadata ([#47](https://github.com/dacely-cloud/toiljs/pull/47)) by @BlobMaster41
- fix: audit findings ([#48](https://github.com/dacely-cloud/toiljs/pull/48)) by @BlobMaster41
- feat(compiler): image-import module declarations (svg/png/…) ([#49](https://github.com/dacely-cloud/toiljs/pull/49)) by @BlobMaster41
- feat(compiler): accept toiljs.config.* as well ([#50](https://github.com/dacely-cloud/toiljs/pull/50)) by @BlobMaster41
- refactor(client): organize src/client by feature ([#51](https://github.com/dacely-cloud/toiljs/pull/51)) by @BlobMaster41
- feat(compiler): clear error for empty import specifiers ([#52](https://github.com/dacely-cloud/toiljs/pull/52)) by @BlobMaster41
- feat(create): app template = the basic example (verbatim) ([#53](https://github.com/dacely-cloud/toiljs/pull/53)) by @BlobMaster41
- feat(create): explicit None option for AI assistant files ([#54](https://github.com/dacely-cloud/toiljs/pull/54)) by @BlobMaster41
- feat(create): scaffold .vscode/settings.json (workspace TS sdk) ([#55](https://github.com/dacely-cloud/toiljs/pull/55)) by @BlobMaster41
- feat(client): route data loaders (loader + useLoaderData) ([#56](https://github.com/dacely-cloud/toiljs/pull/56)) by @BlobMaster41
- refactor(create): single starter source (examples/basic/client), drop templates/ ([#57](https://github.com/dacely-cloud/toiljs/pull/57)) by @BlobMaster41
- chore: fix stale templates/app comments ([#58](https://github.com/dacely-cloud/toiljs/pull/58)) by @BlobMaster41
- feat(client): typed routes (Link/navigate hrefs + useParams) ([#59](https://github.com/dacely-cloud/toiljs/pull/59)) by @BlobMaster41
- docs: fill .toil/docs (real content, not TODO) ([#60](https://github.com/dacely-cloud/toiljs/pull/60)) by @BlobMaster41
- test: jsdom runtime tests (navigation / scroll / Link / NavLink) ([#61](https://github.com/dacely-cloud/toiljs/pull/61)) by @BlobMaster41
- feat(routing): template.tsx + global-error.tsx (+ loader spinner, eslint loader export) ([#62](https://github.com/dacely-cloud/toiljs/pull/62)) by @BlobMaster41
- fix(routing): instant page switches (no more freeze on navigation) ([#63](https://github.com/dacely-cloud/toiljs/pull/63)) by @BlobMaster41
- feat(client): <Image> + <Script> components ([#64](https://github.com/dacely-cloud/toiljs/pull/64)) by @BlobMaster41
- feat(loader): typed useLoaderData + cache control ([#65](https://github.com/dacely-cloud/toiljs/pull/65)) by @BlobMaster41
- feat(loader): useLoaderData(loader) form + allow revalidate export ([#66](https://github.com/dacely-cloud/toiljs/pull/66)) by @BlobMaster41
- feat(images): build-time image optimization (on by default) ([#67](https://github.com/dacely-cloud/toiljs/pull/67)) by @BlobMaster41
- feat(actions): mutations via useAction + <Form> ([#68](https://github.com/dacely-cloud/toiljs/pull/68)) by @BlobMaster41
- fix(loader): instant navigation (stop re-suspending no-loader routes) ([#69](https://github.com/dacely-cloud/toiljs/pull/69)) by @BlobMaster41
- feat(images): log optimized images during build ([#70](https://github.com/dacely-cloud/toiljs/pull/70)) by @BlobMaster41
- fix(routing): restore smooth nav transition (and keep loading spinners) ([#71](https://github.com/dacely-cloud/toiljs/pull/71)) by @BlobMaster41
- feat(dev): error overlay for uncaught render/async errors ([#73](https://github.com/dacely-cloud/toiljs/pull/73)) by @BlobMaster41
- feat(routing): parallel + intercepting routes ([#72](https://github.com/dacely-cloud/toiljs/pull/72)) by @BlobMaster41
- feat(head): metadata API (export const metadata / generateMetadata) ([#74](https://github.com/dacely-cloud/toiljs/pull/74)) by @BlobMaster41
- feat(seo): per-route build-time SEO + AI/social toolset ([#75](https://github.com/dacely-cloud/toiljs/pull/75)) by @BlobMaster41
- feat(fonts): preload bundled fonts at build (+ log) ([#77](https://github.com/dacely-cloud/toiljs/pull/77)) by @BlobMaster41
- fix(loader): show loading.tsx when revalidating the current route ([#76](https://github.com/dacely-cloud/toiljs/pull/76)) by @BlobMaster41
- feat(routing): opt-in animated view transitions ([#78](https://github.com/dacely-cloud/toiljs/pull/78)) by @BlobMaster41
- fix(head): per-route metadata wins over layout useHead defaults ([#79](https://github.com/dacely-cloud/toiljs/pull/79)) by @BlobMaster41
- fix(compiler): stop editors flagging route exports (metadata/loader/…) as unused ([#80](https://github.com/dacely-cloud/toiljs/pull/80)) by @BlobMaster41
- fix(routing): wire slots into mount, stop @slot routes recursing; full feature demo ([#82](https://github.com/dacely-cloud/toiljs/pull/82)) by @BlobMaster41
- fix(build): resolve node-polyfill shims for symlinked consumers; absolute demo asset paths ([#83](https://github.com/dacely-cloud/toiljs/pull/83)) by @BlobMaster41
- docs: README ([#81](https://github.com/dacely-cloud/toiljs/pull/81)) by @BlobMaster41
- feat(cli): add `toiljs doctor` ([#84](https://github.com/dacely-cloud/toiljs/pull/84)) by @BlobMaster41
- feat(cli): add `toiljs update` ([#85](https://github.com/dacely-cloud/toiljs/pull/85)) by @BlobMaster41
- feat(search): build-time page search + usePageSearch ([#86](https://github.com/dacely-cloud/toiljs/pull/86)) by @BlobMaster41
- fix(pkg): correct package description ([#87](https://github.com/dacely-cloud/toiljs/pull/87)) by @BlobMaster41
- fix(compiler): resolve broken vite-imagetools/client type reference ([#90](https://github.com/dacely-cloud/toiljs/pull/90)) by @BlobMaster41
- style: fix syntax ([#89](https://github.com/dacely-cloud/toiljs/pull/89)) by @BlobMaster41
- fix(readme): absolute logo URL for npm ([#91](https://github.com/dacely-cloud/toiljs/pull/91)) by @BlobMaster41
- build(cli): bundle the CLI, stop @clack leaking into consumers ([#93](https://github.com/dacely-cloud/toiljs/pull/93)) by @BlobMaster41
- feat(head): component metadata (useMetadata/<Metadata>) + href() helper ([#92](https://github.com/dacely-cloud/toiljs/pull/92)) by @BlobMaster41
- feat(ssg): build-time prerender for dynamic routes via generateStaticParams ([#94](https://github.com/dacely-cloud/toiljs/pull/94)) by @BlobMaster41
- feat(routing): loader transition off by default (opt-in client.transitions) ([#95](https://github.com/dacely-cloud/toiljs/pull/95)) by @BlobMaster41
- fix(routing): no empty page on navigation + fade-in ([#96](https://github.com/dacely-cloud/toiljs/pull/96)) by @BlobMaster41
- feat(seo): full page index in llms.txt (static + SSG, with metadata) ([#97](https://github.com/dacely-cloud/toiljs/pull/97)) by @BlobMaster41
- feat(dev): dev toolbar (Phase 1) ([#98](https://github.com/dacely-cloud/toiljs/pull/98)) by @BlobMaster41
- feat(dev): dev toolbar Data + Head/SEO tabs (Phase 2) ([#99](https://github.com/dacely-cloud/toiljs/pull/99)) by @BlobMaster41
- feat(devtools): AI assist + command palette (Phase 3) ([#100](https://github.com/dacely-cloud/toiljs/pull/100)) by @BlobMaster41
- docs(devtools): README section + export AiProvider for typed config ([#101](https://github.com/dacely-cloud/toiljs/pull/101)) by @BlobMaster41
- fix(devtools): cache getSnapshot to stop Data-tab infinite loop ([#102](https://github.com/dacely-cloud/toiljs/pull/102)) by @BlobMaster41
- fix(devtools): show vite version + tidy no-loader Data tab ([#104](https://github.com/dacely-cloud/toiljs/pull/104)) by @BlobMaster41
- fix(routing): hold previous page during navigation instead of blanking ([#103](https://github.com/dacely-cloud/toiljs/pull/103)) by @BlobMaster41
- feat(routing): prefetch loader data on hover so navigation feels instant ([#105](https://github.com/dacely-cloud/toiljs/pull/105)) by @BlobMaster41
- refactor(routing): drop the page fade-in ([#106](https://github.com/dacely-cloud/toiljs/pull/106)) by @BlobMaster41
- fix(pkg): add repository field for npm provenance ([#107](https://github.com/dacely-cloud/toiljs/pull/107)) by @BlobMaster41




All notable changes to this project will be documented in this file.

This changelog is automatically generated from merged pull requests.
