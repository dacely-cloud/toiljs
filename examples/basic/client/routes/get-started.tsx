export default function GetStarted() {
    return (
        <section className="get-started">
            <h1 className="gs-title">Get Started</h1>
            <p className="gs-desc">Everything you need to know to build with ToilJS.</p>

            {/* Setup */}
            <div className="gs-group">
                <h2 className="gs-group-title">Quick Setup</h2>

                <div className="gs-step">
                    <span className="gs-step-num">1</span>
                    <div>
                        <h3>Create a project</h3>
                        <pre><code>npm create toiljs@latest my-app</code></pre>
                    </div>
                </div>

                <div className="gs-step">
                    <span className="gs-step-num">2</span>
                    <div>
                        <h3>Install dependencies</h3>
                        <pre><code>cd my-app && npm install</code></pre>
                    </div>
                </div>

                <div className="gs-step">
                    <span className="gs-step-num">3</span>
                    <div>
                        <h3>Start the dev server</h3>
                        <pre><code>npm run dev</code></pre>
                    </div>
                </div>
            </div>

            {/* File structure */}
            <div className="gs-group">
                <h2 className="gs-group-title">Project Structure</h2>

                <div className="gs-info">
                    <div className="gs-info-icon">🗂</div>
                    <div>
                        <h3>File-based Routing</h3>
                        <p>Every <code>.tsx</code> file inside <code>client/routes/</code> becomes a page automatically. No router config needed.</p>
                        <pre><code>{`client/routes/
  index.tsx       →  /
  about.tsx       →  /about
  blog/[id].tsx   →  /blog/:id
  docs/[...slug]  →  /docs/*`}</code></pre>
                    </div>
                </div>

                <div className="gs-info">
                    <div className="gs-info-icon">🖼</div>
                    <div>
                        <h3>Public Folder</h3>
                        <p>Files placed in <code>public/</code> are copied directly to the root of the build output — reference them with an absolute path.</p>
                        <pre><code>{`public/
  index.html        →  /index.html
  robots.txt        →  /robots.txt
  images/logo.svg   →  /images/logo.svg`}</code></pre>
                    </div>
                </div>

                <div className="gs-info">
                    <div className="gs-info-icon">📐</div>
                    <div>
                        <h3>Layout</h3>
                        <p><code>client/layout.tsx</code> wraps every page. Use it for nav, footers, providers, or global styles.</p>
                    </div>
                </div>

                <div className="gs-info">
                    <div className="gs-info-icon">⚡</div>
                    <div>
                        <h3>Entry Point</h3>
                        <p><code>client/toil.tsx</code> is the app entry. Import global CSS and call <code>Toil.mount()</code> here — it's run once on startup.</p>
                    </div>
                </div>
            </div>

            {/* Navigation */}
            <div className="gs-group">
                <h2 className="gs-group-title">Navigation</h2>

                <div className="gs-info">
                    <div className="gs-info-icon">🔗</div>
                    <div>
                        <h3>Client-side Links</h3>
                        <p>Use <code>{'<Toil.Link>'}</code> instead of <code>{'<a>'}</code> for in-app navigation to get instant client-side transitions.</p>
                        <pre><code>{`<Toil.Link href="/about">About</Toil.Link>`}</code></pre>
                    </div>
                </div>
            </div>

            <div className="gs-actions">
                <Toil.Link href="/" className="btn btn-secondary">
                    ← Back home
                </Toil.Link>
                <a
                    href="https://toil.org/docs"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="btn btn-primary">
                    Read the Docs
                </a>
            </div>
        </section>
    );
}
