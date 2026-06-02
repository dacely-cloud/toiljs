// Dynamic metadata from the route param, so the tab reads "Blog post 42 | ToilJS".
export const generateMetadata: Toil.GenerateMetadata = ({ params }) => ({
    title: `Blog post ${params.id}`,
    description: `Reading blog post ${params.id}.`
});

// The per-post title above is dynamic, so it can't be statically indexed for site search. These
// static hints make the blog discoverable from the /search page anyway (see usePageSearch).
export const searchHints: Toil.SearchHints = {
    title: 'Blog',
    description: 'Articles and updates from the ToilJS example app.',
    keywords: ['blog', 'posts', 'articles']
};

export default function BlogPost() {
    const { id } = Toil.useParams();
    return (
        <main>
            <h1>Blog post {id}</h1>
            <p>
                Dynamic route from <code>client/routes/blog/[id].tsx</code>.
            </p>
            <Toil.Link href="/features">See every feature</Toil.Link>
        </main>
    );
}
