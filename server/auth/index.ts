/**
 * Escape-hatch marker for the built-in auth surface. A bare
 * `import 'toiljs/server/auth';` in `server/main.ts` is the lighter-weight opt-in
 * (an alternative to the canonical `server: { auth: true }` config flag): the
 * toiljs build DETECTS this import and appends the shipped `@user` shape +
 * `@rest('auth')` controller to the toilscript ENTRY set, so their decorators
 * weave and the controller self-mounts at `/auth/*`.
 *
 * This module is intentionally EMPTY (a pure marker). Framework-shipped
 * decorator sources under `node_modules` only weave when handed to toilscript as
 * explicit ENTRIES; a transitive `import` resolves them under the `~lib/` LIBRARY
 * prefix, where `@data`/`@rest`/`@user` do NOT weave — and, worse, would then
 * collide with the entry-injected copies as duplicate modules. So the barrel must
 * NOT itself import the controller; the build does the entry injection instead.
 */
export {};
