const GitHubIcon = () => (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
        <path d="M12 2C6.477 2 2 6.477 2 12c0 4.418 2.865 8.166 6.839 9.489.5.092.682-.217.682-.482 0-.237-.009-.868-.013-1.703-2.782.604-3.369-1.341-3.369-1.341-.454-1.154-1.11-1.462-1.11-1.462-.908-.62.069-.608.069-.608 1.003.07 1.531 1.03 1.531 1.03.892 1.529 2.341 1.087 2.91.832.092-.647.35-1.088.636-1.338-2.22-.253-4.555-1.11-4.555-4.943 0-1.091.39-1.984 1.029-2.683-.103-.253-.446-1.27.098-2.647 0 0 .84-.269 2.75 1.025A9.578 9.578 0 0 1 12 6.836a9.59 9.59 0 0 1 2.504.337c1.909-1.294 2.747-1.025 2.747-1.025.546 1.377.202 2.394.1 2.647.64.699 1.028 1.592 1.028 2.683 0 3.842-2.339 4.687-4.566 4.935.359.309.678.919.678 1.852 0 1.336-.012 2.415-.012 2.743 0 .267.18.579.688.481C19.138 20.163 22 16.418 22 12c0-5.523-4.477-10-10-10z" />
    </svg>
);

const icons = {
    hmr: (
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />
        </svg>
    ),
    routing: (
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
        </svg>
    ),
    typescript: (
        <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
            <rect x="2" y="2" width="20" height="20" rx="3" fill="currentColor" />
            <path d="M13.5 12H15.5V18H17V12H19V10.5H13.5V12Z" fill="var(--bg)" />
            <path d="M11 10.5C9.07 10.5 7.5 12.07 7.5 14C7.5 15.45 8.38 16.69 9.65 17.23L7.5 18H11C12.93 18 14.5 16.43 14.5 14.5C14.5 13.26 13.86 12.17 12.9 11.55C12.42 11.22 11.73 10.5 11 10.5ZM11 12C12.1 12 13 12.9 13 14C13 15.1 12.1 16 11 16H9.72C9.28 15.57 9 14.81 9 14C9 12.9 9.9 12 11 12Z" fill="var(--bg)" />
        </svg>
    ),
    builds: (
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z" />
            <polyline points="3.27 6.96 12 12.01 20.73 6.96" />
            <line x1="12" y1="22.08" x2="12" y2="12" />
        </svg>
    ),
};

const features = [
    { icon: icons.hmr,        label: 'Instant HMR' },
    { icon: icons.routing,    label: 'File Routing' },
    { icon: icons.typescript, label: 'TypeScript' },
    { icon: icons.builds,     label: 'Optimized Builds' },
];

export default function Home() {
    return (
        <section className="hero">
            <div className="hero-logo">
                <img src="images/logo.svg" className="hero-logo-glow" alt="" aria-hidden="true" width={96} height={96} />
                <img src="images/logo.svg" className="hero-logo-img" alt="ToilJS" width={96} height={96} />
            </div>

            <h1 className="hero-title">ToilJS</h1>

            <p className="hero-tagline">
                Next-gen React.<br />
                <span>Zero config.</span>
            </p>

            <p className="hero-desc">
                File-based routing, blazing-fast HMR, and full TypeScript.
                <br />All powered by Vite.
            </p>

            <ul className="features">
                {features.map(f => (
                    <li key={f.label} className="feature-badge">
                        {f.icon}{f.label}
                    </li>
                ))}
            </ul>

            <div className="hero-cta">
                <Toil.Link href="/get-started" className="btn btn-primary">
                    Get Started
                </Toil.Link>
                <a className="btn btn-secondary" href="https://github.com/btc-vision/toiljs" target="_blank" rel="noopener noreferrer">
                        <GitHubIcon />
                        GitHub
                    </a>
            </div>
        </section>
    );
}
