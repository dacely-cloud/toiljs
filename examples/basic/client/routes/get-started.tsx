export default function GetStarted() {
    return (
        <section className="get-started">
            <h1 className="gs-title">Get Started</h1>
            <p className="gs-desc">
                Create a new ToilJS project in seconds.
            </p>

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

