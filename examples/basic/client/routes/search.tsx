import { useState } from 'react';

export const metadata: Toil.Metadata = {
    title: 'Search',
    description: 'Search every page by its metadata and jump straight to it.',
    keywords: ['search', 'find', 'pages', 'metadata']
};

// A tiny site-wide search box. `usePageSearch` queries the compiler-built index of every page's
// metadata (title/description/keywords/OpenGraph + static `searchHints` on dynamic routes), returns
// ranked matches with their route `path`, and `goTo` navigates to whichever one you pick.
export default function Search() {
    const [query, setQuery] = useState('');
    const { results, pages, goTo } = Toil.usePageSearch(query, { includeDynamic: true });

    return (
        <main>
            <h1>Search</h1>
            <p>
                Type to search across the metadata of all {pages.length} pages — title, description, keywords, and
                OpenGraph. Indexed at build by <code>client/routes/*</code>.
            </p>

            <input
                type="search"
                value={query}
                onChange={(e) => {
                    setQuery(e.target.value);
                }}
                placeholder="Search pages… (try “blog”, “features”, “started”)"
                aria-label="Search pages"
                autoFocus
                style={{ width: '100%', padding: '0.6rem 0.8rem', fontSize: '1rem' }}
            />

            {query.trim() !== '' && (
                <ul style={{ listStyle: 'none', padding: 0, marginTop: '1rem' }}>
                    {results.length === 0 && <li>No pages match “{query}”.</li>}
                    {results.map((r) => (
                        <li key={r.page.path} style={{ marginBottom: '0.75rem' }}>
                            <button
                                type="button"
                                onClick={() => {
                                    goTo(r);
                                }}
                                disabled={r.page.dynamic}
                                title={r.page.dynamic ? 'Dynamic route — needs params to open' : undefined}
                                style={{ textAlign: 'left', cursor: r.page.dynamic ? 'default' : 'pointer' }}>
                                <strong>{r.page.metadata.title ?? r.page.path}</strong> <code>{r.page.path}</code>
                                {r.page.metadata.description !== undefined && <div>{r.page.metadata.description}</div>}
                                <small>
                                    score {r.score.toFixed(1)} · matched {r.matches.join(', ')}
                                </small>
                            </button>
                        </li>
                    ))}
                </ul>
            )}
        </main>
    );
}
