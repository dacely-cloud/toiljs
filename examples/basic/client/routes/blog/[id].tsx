// Dynamic metadata from the route param, so the tab reads "Blog post 42 | ToilJS".
export const generateMetadata: Toil.GenerateMetadata = ({ params }) => ({
    title: `Blog post ${params.id}`,
    description: `Reading blog post ${params.id}.`,
});

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
