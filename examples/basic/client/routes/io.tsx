export default function IoDemo() {
    const writer = new DataWriter();
    writer.writeU32(42).writeString('hello toil');
    const bytes = writer.toBytes();

    const reader = new DataReader(bytes);
    const n = reader.readU32();
    const s = reader.readString();

    const seen = new FastSet<bigint>();
    seen.add(1n).add(2n).add(1n);

    return (
        <main>
            <h1>Native IO</h1>
            <p>
                <code>new DataWriter()</code> with no import, round-tripped {n} and &quot;{s}&quot; through{' '}
                {bytes.length} bytes; FastSet size {seen.size}.
            </p>
            <Toil.Link href="/">Back home</Toil.Link>
        </main>
    );
}
