# Changelog

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
