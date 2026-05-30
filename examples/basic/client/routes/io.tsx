import { Link } from 'toiljs/client';

// Note: BinaryWriter / BinaryReader / FastMap / FastSet are NATIVE globals in a toil app —
// no import needed. They're injected at runtime and typed via the generated .toil/toil-env.d.ts.
export default function IoDemo() {
    const writer = new BinaryWriter();
    writer.writeU32(42);
    writer.writeStringWithLength('hello toil');
    const bytes = writer.getBuffer();

    const reader = new BinaryReader(bytes);
    const n = reader.readU32();
    const s = reader.readStringWithLength();

    const seen = new FastSet<bigint>();
    seen.add(1n).add(2n).add(1n);

    return (
        <main>
            <h1>Native IO</h1>
            <p>
                <code>new BinaryWriter()</code> with no import — round-tripped {n} and &quot;{s}&quot; through{' '}
                {bytes.length} bytes; FastSet size {seen.size}.
            </p>
            <Link href="/">Back home</Link>
        </main>
    );
}
