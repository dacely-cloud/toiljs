/**
 * An edge-SSR route, server-rendered at the edge with no per-request React.
 *
 * `export const ssr = true` opts it into the template extractor: at build time
 * toil renders this page (under the real layout chain) ONCE into a
 * template-with-holes (`build/client/_ssr/hello.{tmpl,slots}` + the guest
 * `Slot` module), and the matching server `render` (see
 * `server/SsrHelloRender.ts`) fills only the holes per request. The edge
 * splices the values into the template, so this page is served about as fast as
 * a static file while still delivering real first-paint HTML and SEO, and the
 * browser hydrates it in place.
 *
 * The dynamic bits are wrapped in the hole markers from `toiljs/client`, which
 * are transparent in the browser (they just render their children) but are what
 * the build extractor and the server `render` key off:
 *
 *   - `<Hole>`    a text hole (React-escaped for you)
 *   - `<RawHtml>` a raw-HTML block (you own sanitisation)
 *   - `<Repeat>`  a repeated region, the row markup stamped per item
 *   - `<Island>`  a client-only escape hatch (empty server-side; appears after
 *                 hydration). Router-hook / browser-only bits live here so the
 *                 page renders under static markup.
 */
import { Hole, Island, RawHtml, Repeat, useLoaderData } from 'toiljs/client';

export const ssr = true;

export const metadata: Toil.Metadata = {
    title: 'Edge SSR',
    description: 'A server-rendered greeting, filled at the edge from a tiny values envelope.',
    openGraph: { title: 'Edge SSR, ToilJS', type: 'website' }
};

interface Service {
    name: string;
    region: string;
}

interface GreetingData {
    /** Who we are greeting (a text hole). */
    name: string;
    /** A short, pre-sanitised HTML blurb (a raw-HTML hole). */
    blurbHtml: string;
    /** A live status snapshot, stamped row by row (a repeat region). */
    services: Service[];
}

/**
 * This loader plays two roles:
 *
 *  1. BUILD: it is rendered once (with empty search params) so the extractor
 *     captures the holes; only the SHAPE matters there.
 *  2. CLIENT HYDRATION: after the edge serves the server-rendered HTML, the
 *     browser hydrates by re-rendering this component with THIS loader's data.
 *     For a byte-clean hydrate, that data must reproduce the values the SERVER
 *     `render` stamped (see `server/SsrHelloRender.ts`). So the greeting reads
 *     `?name=` here exactly as the server `render` does; if it didn't,
 *     `/hello?Bob` would hydrate the server's "Bob" back to the loader default
 *     and flash. (Holes that the client cannot reproduce belong in an
 *     `<Island>`.)
 */
export const loader = ({ searchParams }: { searchParams: URLSearchParams }): GreetingData => ({
    name: searchParams.get('name') || 'world',
    blurbHtml: 'Rendered at the <strong>edge</strong> from a tiny values envelope.',
    services: [
        { name: 'record', region: 'us-east' },
        { name: 'unique', region: 'eu-west' },
        { name: 'counter', region: 'ap-south' }
    ]
});

export default function Hello(): React.JSX.Element {
    const d = useLoaderData<typeof loader>();
    return (
        <section className="hello">
            <h1>
                Hello, <Hole id="name">{d.name}</Hole>!
            </h1>

            {/* A raw-HTML hole: the server is responsible for sanitising it. */}
            <p className="hello-blurb">
                <RawHtml id="blurb" html={d.blurbHtml} as="span" />
            </p>

            {/* A repeat region: the row markup is captured once and stamped per
                item. The nested <Hole>s are filled inside each stamped row. */}
            <h2>Service snapshot</h2>
            <ul className="hello-services">
                <Repeat id="services" each={d.services}>
                    {(s: Service) => (
                        <li>
                            <strong>
                                <Hole id="svcName">{s.name}</Hole>
                            </strong>
                            <span className="hello-region">
                                <Hole id="svcRegion">{s.region}</Hole>
                            </span>
                        </li>
                    )}
                </Repeat>
            </ul>

            {/* A client-only island: empty in the server HTML, rendered after
                hydration. Anything router-hook / browser-only lives here so the
                page above stays server-renderable. */}
            <Island>
                <p className="hello-island">
                    Hydrated in your browser at {new Date().toLocaleTimeString()}.
                </p>
            </Island>
        </section>
    );
}
