export interface ThreadedRequest {
    readonly id: number;
    readonly method: string;
    readonly url: string;
    readonly path: string;
    readonly headers: readonly (readonly [string, string])[];
    readonly body: string;
    readonly clientIp: string;
}

export interface ThreadedHttpResponse {
    readonly kind: 'response';
    readonly status: number;
    readonly headers: readonly (readonly [string, string])[];
    readonly body: string;
    readonly sendfile: string | null;
}

export interface ThreadedFallbackResponse {
    readonly kind: 'fallback';
}

export type ThreadedReply = ThreadedHttpResponse | ThreadedFallbackResponse;

export type WorkerToPrimaryMessage =
    | { readonly toil: 'ready'; readonly port: number; readonly workerId: number }
    | { readonly toil: 'clientCount'; readonly count: number; readonly workerId: number }
    | { readonly toil: 'request'; readonly request: ThreadedRequest };

export type PrimaryToWorkerMessage =
    | {
          readonly toil: 'start';
          readonly workerId: number;
          readonly options: unknown;
      }
    | { readonly toil: 'reply'; readonly id: number; readonly reply: ThreadedReply }
    | { readonly toil: 'broadcast'; readonly message: string }
    | { readonly toil: 'shutdown' };

export function encodeBody(body: Uint8Array): string {
    return Buffer.from(body.buffer, body.byteOffset, body.length).toString('base64');
}

export function decodeBody(body: string): Uint8Array {
    return Buffer.from(body, 'base64');
}

export function isWorkerToPrimaryMessage(value: unknown): value is WorkerToPrimaryMessage {
    if (typeof value !== 'object' || value === null) return false;
    const message = value as Record<string, unknown>;
    return message.toil === 'ready' || message.toil === 'clientCount' || message.toil === 'request';
}

export function isPrimaryToWorkerMessage(value: unknown): value is PrimaryToWorkerMessage {
    if (typeof value !== 'object' || value === null) return false;
    const message = value as Record<string, unknown>;
    return (
        message.toil === 'start' ||
        message.toil === 'reply' ||
        message.toil === 'broadcast' ||
        message.toil === 'shutdown'
    );
}
