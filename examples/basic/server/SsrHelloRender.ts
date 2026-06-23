/**
 * The edge-SSR `render` for the `/hello` route (`client/routes/hello.tsx`).
 *
 * In the single-wasm build, SSR is part of the normal server build: the
 * compiler renders the opted-in route into a template-with-holes and emits the
 * typed `Slot` enum + `HASH` (see `server/ssr/hello.slots.ts`); this function
 * fills only the holes per request, and the edge splices the values into the
 * template. The host never re-runs React — it just stamps the values envelope
 * this returns into the precompiled template, so the route serves about as fast
 * as a static file.
 *
 * It derives its data from the request, fills the typed `Slot`s on a
 * `SlotValues`, and self-registers with the `Ssr` router. `main.ts` imports
 * this module so the server build discovers it (the side-effect `Ssr.register`
 * call is what wires it in). A render returns `SlotValues` for a path it owns,
 * or `null` to let the next registered renderer try.
 *
 * Hole escaping mirrors React exactly (`setText`/`HtmlBuilder.text` React-escape
 * for you; `setRaw` is verbatim, so YOU own its sanitisation), which is what
 * lets the browser hydrate the spliced markup with no re-render.
 */
import { HtmlBuilder, Request, SlotValues, Ssr } from 'toiljs/server/runtime';
import { HASH, Slot } from './ssr/hello.slots';

class Service {
    constructor(
        public name: string,
        public region: string,
    ) {}
}

/** Pull the greeting target from `?name=...`, defaulting to `world` (matches the
 * route loader's default). Kept tiny — the point is to show a real per-request
 * derivation, not a query parser. */
function greetingName(req: Request): string {
    const q = req.path.indexOf('?');
    if (q < 0) return 'world';
    const query = req.path.substring(q + 1);
    const parts = query.split('&');
    for (let i = 0; i < parts.length; i++) {
        const kv = parts[i];
        if (kv.startsWith('name=')) {
            const v = kv.substring(5);
            return v.length > 0 ? v : 'world';
        }
    }
    return 'world';
}

function renderHello(req: Request): SlotValues | null {
    // The guest re-derives WHICH route this is from the path (the template name
    // is not in the request envelope), exactly as a @rest controller matches its
    // own prefix. Match `/hello` with or without a query string.
    if (req.path != '/hello' && !req.path.startsWith('/hello?')) return null;

    const v = new SlotValues(HASH);

    // A text hole: React-escaped (so e.g. `?name=<a>&b` is safe).
    v.setText(Slot.name, greetingName(req));

    // A raw-HTML hole: inserted verbatim, so the author owns sanitisation. This
    // is a fixed, trusted blurb (no request data) — matches the route's sample.
    v.setRaw(Slot.blurb, 'Rendered at the <strong>edge</strong> from a tiny values envelope.');

    // A repeat region: stamp the captured row markup once per item. The row
    // sub-template is `<li><strong>{svcName}</strong>` +
    // `<span class="hello-region">{svcRegion}</span></li>`; `text(...)` escapes
    // each nested hole exactly as React does, so the stamped rows are byte-
    // identical to a client render.
    const services: Service[] = [
        new Service('record', 'us-east'),
        new Service('unique', 'eu-west'),
        new Service('counter', 'ap-south'),
    ];
    const rows = new HtmlBuilder();
    for (let i = 0; i < services.length; i++) {
        const s = services[i];
        rows.raw('<li><strong>')
            .text(s.name)
            .raw('</strong><span class="hello-region">')
            .text(s.region)
            .raw('</span></li>');
    }
    v.setRepeat(Slot.services, rows);

    return v;
}

// Side-effect registration: `main.ts` imports this module so the build compiles
// it in and this renderer joins the SSR router. (In a fully-generated build the
// compiler injects this registration for auto-discovered routes; the demo wires
// it explicitly, the documented escape hatch.)
Ssr.register(renderHello);
