export interface BlobUploadTicket {
    url: string;
    fields: readonly { name: string; value: string }[];
    size: number;
    expiresAt: number;
}

/** Upload a File/Blob directly; FormData streams the bytes without app chunking. */
export async function uploadBlob(
    ticket: BlobUploadTicket,
    file: Blob,
    signal?: AbortSignal,
): Promise<void> {
    if (file.size !== ticket.size) throw new Error('Blob size differs from upload ticket');
    const body = new FormData();
    for (const field of ticket.fields) body.append(field.name, field.value);
    body.append('file', file, 'blob');
    const result = await fetch(ticket.url, {
        method: 'POST',
        body,
        signal,
        credentials: 'omit',
        redirect: 'error',
    });
    if (!result.ok) throw new Error(`Blob upload failed (${result.status})`);
}

/** Upload a ReadableStream using streaming fetch (Node and browsers that support
 * request streams). File/Blob callers should use uploadBlob for wider support. */
export async function uploadBlobStream(
    ticket: BlobUploadTicket,
    source: ReadableStream<Uint8Array>,
    signal?: AbortSignal,
): Promise<void> {
    const boundary = 'toil-' + crypto.randomUUID();
    let prefix = '';
    for (const field of ticket.fields) {
        if (!/^[A-Za-z0-9_-]+$/.test(field.name)) throw new Error('Invalid blob form field');
        prefix += `--${boundary}\r\nContent-Disposition: form-data; name="${field.name}"\r\n\r\n${field.value}\r\n`;
    }
    prefix += `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="blob"\r\nContent-Type: application/octet-stream\r\n\r\n`;
    const encoder = new TextEncoder(),
        reader = source.getReader();
    let started = false,
        complete = false,
        total = 0;
    const body = new ReadableStream<Uint8Array>({
        async pull(controller) {
            if (!started) {
                started = true;
                controller.enqueue(encoder.encode(prefix));
                return;
            }
            try {
                const next = await reader.read();
                if (next.done) {
                    if (total !== ticket.size)
                        throw new Error('Blob stream size differs from upload ticket');
                    complete = true;
                    controller.enqueue(encoder.encode(`\r\n--${boundary}--\r\n`));
                    controller.close();
                    reader.releaseLock();
                } else {
                    total += next.value.byteLength;
                    if (total > ticket.size) throw new Error('Blob stream exceeds upload ticket');
                    controller.enqueue(next.value);
                }
            } catch (error) {
                controller.error(error);
                await reader.cancel(error);
                reader.releaseLock();
            }
        },
        async cancel(reason) {
            if (!complete) {
                await reader.cancel(reason);
                reader.releaseLock();
            }
        },
    });
    try {
        const options: RequestInit & { duplex: 'half' } = {
            method: 'POST',
            headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
            body,
            signal,
            credentials: 'omit',
            redirect: 'error',
            duplex: 'half',
        };
        const result = await fetch(ticket.url, options);
        if (!result.ok) throw new Error(`Blob upload failed (${result.status})`);
    } finally {
        if (!complete) {
            try {
                await reader.cancel();
                reader.releaseLock();
            } catch {
                /* fetch may already have canceled the source */
            }
        }
    }
}
export interface BlobRange {
    start: number;
    end?: number;
}

/** Return the streaming Response. Consume response.body or pipe it onward. */
export async function readBlob(
    url: string,
    range?: BlobRange,
    signal?: AbortSignal,
): Promise<Response> {
    const headers: Record<string, string> = {};
    if (range !== undefined) {
        if (
            !Number.isSafeInteger(range.start) ||
            range.start < 0 ||
            (range.end !== undefined &&
                (!Number.isSafeInteger(range.end) || range.end < range.start))
        )
            throw new Error('Invalid blob range');
        headers.Range = `bytes=${range.start}-${range.end ?? ''}`;
    }
    const result = await fetch(url, { headers, signal, credentials: 'omit', redirect: 'error' });
    if (!result.ok) throw new Error(`Blob download failed (${result.status})`);
    if (range !== undefined && result.status !== 206) {
        await result.body?.cancel();
        throw new Error('Storage did not honor the blob range');
    }
    return result;
}
export async function deleteBlob(url: string, signal?: AbortSignal): Promise<void> {
    const result = await fetch(url, {
        method: 'DELETE',
        signal,
        credentials: 'omit',
        redirect: 'error',
    });
    if (!result.ok) throw new Error(`Blob deletion failed (${result.status})`);
}
