import cube from '../assets/cube.webp?toil';

export default function TestPage() {
    return (
        <div className="test-page">
            <img src="/images/test_image.webp" alt="Test" className="test-page-image" />
            {/* A `?toil` import auto-generates a blurred LQIP + dimensions; placeholder="blur" fades
                the real image in over it, and the aspect-ratio reserves space (no layout shift). */}
            <Toil.Image src={cube} alt="Cube" placeholder="blur" />
        </div>
    );
}
