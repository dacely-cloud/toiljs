// The feature hub: one place that links to a live demo of every ToilJS capability. Its own tab
// title comes from the `metadata` export below (rendered as "Features | ToilJS" via the layout
// template) and is baked into build/client/features/index.html at build time.
// Server-render this static page so it paints instantly (no blank-until-JS flash).
export const ssr = true;

export const metadata: Toil.Metadata = {
    title: 'Features',
    description:
        'Live demos of every ToilJS feature: routing, data, REST + RPC, post-quantum auth and sessions, cookies, Web Crypto, head/SEO, components, realtime, and binary IO.',
    openGraph: { title: 'Every ToilJS feature, demoed', type: 'website' }
};

const groups: { heading: string; items: { href: Toil.Href; label: string; note: string }[] }[] = [
    {
        heading: 'Routing',
        items: [
            { href: '/blog/42', label: 'Dynamic route', note: 'blog/[id].tsx, /blog/42' },
            { href: '/docs/getting/started', label: 'Catch-all', note: 'docs/[...slug].tsx' },
            {
                href: '/files',
                label: 'Optional catch-all',
                note: 'files/[[...slug]].tsx, matches /files and /files/a/b'
            },
            { href: '/privacy', label: 'Route group', note: '(legal)/privacy.tsx, no URL segment' },
            { href: '/gallery', label: 'Parallel + intercepting', note: '@modal/(.)photo/[id], a real modal route' },
            { href: '/features/template', label: 'Templates', note: 'template.tsx remounts on every navigation' },
            { href: '/features/error', label: 'Error boundary', note: 'error.tsx catches a thrown route' }
        ]
    },
    {
        heading: 'Data',
        items: [
            { href: '/loader-demo', label: 'Loader + revalidate', note: 'data before render, cached, refetchable' },
            {
                href: '/features/actions',
                label: 'Actions + Form',
                note: 'useAction / <Form>, pending state, revalidate'
            },
            { href: '/io', label: 'Binary IO', note: 'DataWriter / DataReader / FastSet, no import' }
        ]
    },
    {
        heading: 'Server API',
        items: [
            { href: '/rest', label: 'REST controllers', note: '@rest / @get / @post, typed body + RouteContext' },
            { href: '/rpc', label: 'Typed RPC', note: '@service / @remote, called as Server.* with no fetch' },
            { href: '/search', label: 'Search', note: 'server-backed search endpoint' }
        ]
    },
    {
        heading: 'Auth and security',
        items: [
            {
                href: '/pq',
                label: 'Post-quantum auth',
                note: 'ML-DSA-44: derive + sign in the browser, edge verifies (crypto.mldsa_verify)'
            },
            {
                href: '/auth',
                label: 'Sessions and @user / @auth',
                note: 'signed session cookie, guarded /session/me, typed getUser()'
            },
            {
                href: '/cookies',
                label: 'Cookies and SecureCookies',
                note: 'Cookie builder + HMAC-signed / AES-GCM cookies, no import'
            },
            { href: '/crypto', label: 'Web Crypto', note: 'crypto.sha256 / subtle, global, runs in the server wasm' }
        ]
    },
    {
        heading: 'Head and SEO',
        items: [
            { href: '/features/seo', label: 'Route metadata', note: 'export const metadata, title override' },
            { href: '/features/head', label: 'Imperative head', note: 'useTitle / useHead / <Head>' }
        ]
    },
    {
        heading: 'Components and runtime',
        items: [
            { href: '/features/script', label: 'Script', note: 'Toil.Script with a load strategy' }
        ]
    },
    {
        heading: 'Realtime and streams',
        items: [
            {
                href: '/features/realtime',
                label: 'Realtime socket',
                note: 'Toil.useChannel -> a resident @stream box at /echo'
            },
            {
                href: '/features/stream',
                label: 'Typed @stream',
                note: 'Server.Stream.Echo.connect(), a resident per-connection box'
            }
        ]
    }
];

export default function Features() {
    return (
        <main>
            <h1>Every feature, live</h1>
            <p>
                Each link is a working demo served from <code>client/routes/</code>. Watch the tab title change as you
                navigate, that is the per-route <code>metadata</code> at work.
            </p>
            {groups.map((g) => (
                <section key={g.heading} style={{ marginTop: 24 }}>
                    <h2 style={{ fontSize: '1rem', opacity: 0.7 }}>{g.heading}</h2>
                    <ul style={{ display: 'grid', gap: 8, listStyle: 'none', padding: 0 }}>
                        {g.items.map((it) => (
                            <li key={it.href}>
                                <Toil.Link href={it.href} style={{ fontWeight: 600 }}>
                                    {it.label}
                                </Toil.Link>
                                <span style={{ opacity: 0.6 }}> , {it.note}</span>
                            </li>
                        ))}
                    </ul>
                </section>
            ))}
            <p style={{ marginTop: 24 }}>
                <Toil.Link href="/">Back home</Toil.Link>
            </p>
        </main>
    );
}
