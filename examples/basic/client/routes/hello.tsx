/**
 * An edge-SSR route. `export const ssr = true` opts it into the template
 * extractor: at build time toil renders it once into a template-with-holes
 * (`_ssr/hello.{tmpl,slots}` + a guest `Slot` module); at request time the edge
 * splices the guest's hole values into that template (no per-request render).
 *
 * SSR routes must render under static markup: use the hole markers (`Hole`,
 * `Repeat`, `RawHtml`) and `useLoaderData`, and keep router-hook-dependent or
 * client-only bits inside an `<Island>`.
 */
import { Hole, Repeat, useLoaderData } from 'toiljs/client';

export const ssr = true;

interface HelloData {
    name: string;
    items: string[];
}

export const loader = ({ params }: { params: Record<string, string> }): HelloData => ({
    name: params.name ?? 'world',
    items: ['alpha', 'beta', 'gamma'],
});

export default function Hello(): React.JSX.Element {
    const d = useLoaderData<typeof loader>();
    return (
        <section>
            <h1>
                Hello <Hole id="name">{d.name}</Hole>
            </h1>
            <ul>
                <Repeat id="items" each={d.items}>
                    {(s: string) => (
                        <li>
                            <Hole id="item">{s}</Hole>
                        </li>
                    )}
                </Repeat>
            </ul>
        </section>
    );
}
