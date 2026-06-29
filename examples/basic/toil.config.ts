import { defineConfig } from 'toiljs/compiler';

// Client and server options go here. Output defaults to build/client and build/server.
export default defineConfig({
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
