import { defineConfig } from 'toiljs/compiler';

// Client and server options go here. Output defaults to build/client and build/server.
export default defineConfig({
    // Opt into the framework's built-in post-quantum auth: the build appends the shipped
    // `@rest('auth')` controller (`/auth/register|login/start|finish`, email verification,
    // password reset, `/auth/me`, `/auth/logout`) to the toilscript entry set. This app keeps its
    // own `@user` (server/routes/Session.ts), so the controller runs in EXTEND mode and reuses it.
    server: {
        auth: true
    },
    client: {
        // Animate page transitions (View Transitions API; respects prefers-reduced-motion).
        viewTransitions: false,
        // Build-time SEO: bakes these into the HTML <head> (for JS-less crawlers) and generates
        // robots.txt (with AI-crawler directives), sitemap.xml, and llms.txt.
        seo: {
            url: 'https://toil.example',
            title: 'ToilJS',
            description: 'Planet-scale apps from a single repo.',
            openGraph: {
                type: 'website',
                siteName: 'ToilJS',
                image: 'https://toil.example/images/logo.svg',
            },
            jsonLd: { '@context': 'https://schema.org', '@type': 'WebSite', name: 'ToilJS' },
            robots: { ai: 'allow' },
            llms: { instructions: 'ToilJS is a full-stack TypeScript framework. Docs live at /get-started.' }
        }
    }
});
