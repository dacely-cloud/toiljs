export default function GetStarted() {
    return (
        <div className="gs-page">
            {/* Hero */}
            <div className="gs-hero">
                <h1 className="gs-title">Get Started</h1>
                <p className="gs-desc">Everything you need to build your first ToilJS app.</p>
            </div>

            {/* Info grid */}
            <section className="gs-section">
                <h2 className="gs-section-title">Project Structure</h2>
                <div className="gs-grid">
                    <div className="gs-card gs-card--accent1">
                        <div className="gs-card-icon">
                            <svg
                                width="22"
                                height="22"
                                viewBox="0 0 24 24"
                                fill="none"
                                stroke="currentColor"
                                strokeWidth="2"
                                strokeLinecap="round"
                                strokeLinejoin="round">
                                <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
                            </svg>
                        </div>
                        <h3>File-based Routing</h3>
                        <p>
                            Every <code>.tsx</code> file in <code>client/routes/</code> becomes a route. No config
                            required.
                        </p>
                        <pre>
                            <code>{`index.tsx     →  /
about.tsx     →  /about
[id].tsx      →  /:id
[...slug].tsx →  /*`}</code>
                        </pre>
                    </div>

                    <div className="gs-card gs-card--accent2">
                        <div className="gs-card-icon">
                            <svg
                                width="22"
                                height="22"
                                viewBox="0 0 24 24"
                                fill="none"
                                stroke="currentColor"
                                strokeWidth="2"
                                strokeLinecap="round"
                                strokeLinejoin="round">
                                <rect x="2" y="3" width="20" height="14" rx="2" />
                                <path d="M8 21h8M12 17v4" />
                            </svg>
                        </div>
                        <h3>Public Folder</h3>
                        <p>
                            Files in <code>public/</code> are copied as-is to the build root. Reference them with an
                            absolute path.
                        </p>
                        <pre>
                            <code>{`public/images/logo.svg
→  /images/logo.svg`}</code>
                        </pre>
                    </div>

                    <div className="gs-card gs-card--accent3">
                        <div className="gs-card-icon">
                            <svg
                                width="22"
                                height="22"
                                viewBox="0 0 24 24"
                                fill="none"
                                stroke="currentColor"
                                strokeWidth="2"
                                strokeLinecap="round"
                                strokeLinejoin="round">
                                <rect x="3" y="3" width="18" height="18" rx="2" />
                                <path d="M3 9h18M9 21V9" />
                            </svg>
                        </div>
                        <h3>Layout</h3>
                        <p>
                            <code>client/layout.tsx</code> wraps every page. Use it for your nav, footer, providers, and
                            global styles.
                        </p>
                    </div>

                    <div className="gs-card gs-card--accent4">
                        <div className="gs-card-icon">
                            <svg
                                width="22"
                                height="22"
                                viewBox="0 0 24 24"
                                fill="none"
                                stroke="currentColor"
                                strokeWidth="2"
                                strokeLinecap="round"
                                strokeLinejoin="round">
                                <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />
                            </svg>
                        </div>
                        <h3>Entry Point</h3>
                        <p>
                            <code>client/toil.tsx</code> is the app entry. Import global CSS and call{' '}
                            <code>Toil.mount()</code>, runs once on startup.
                        </p>
                    </div>
                </div>
            </section>

            {/* Navigation section */}
            <section className="gs-section">
                <h2 className="gs-section-title">Navigation</h2>
                <div className="gs-card gs-card--flat">
                    <div className="gs-card-icon">
                        <svg
                            width="22"
                            height="22"
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="2"
                            strokeLinecap="round"
                            strokeLinejoin="round">
                            <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
                            <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
                        </svg>
                    </div>
                    <h3>
                        Use <code>{'<Toil.Link>'}</code> for client-side navigation
                    </h3>
                    <p>
                        Avoids full page reloads and keeps transitions instant. Use a regular <code>{'<a>'}</code> only
                        for external links.
                    </p>
                    <pre>
                        <code>{`// ✅ Internal navigation
<Toil.Link href="/about">About</Toil.Link>

// ✅ External link
<a href="https://toil.org" target="_blank">Docs</a>`}</code>
                    </pre>
                </div>
            </section>

            <div className="gs-actions">
                <Toil.Link href="/" className="btn btn-secondary">
                    ← Back home
                </Toil.Link>
                <a href="https://toil.org/docs" target="_blank" rel="noopener noreferrer" className="btn btn-primary">
                    Read the Docs
                </a>
            </div>
        </div>
    );
}
