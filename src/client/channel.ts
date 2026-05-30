/**
 * Client for the toil backend's WebSocket channel (served by the hyper-express/uWS backend at
 * `/_toil`). Supports text and binary (`ArrayBuffer`) frames, auto-reconnect, and a React hook.
 */
import { useCallback, useEffect, useRef, useState } from 'react';

/** A frame received from / sent to the channel. */
export type ChannelData = string | ArrayBuffer;

/** Whatever `WebSocket.send` accepts (string / BufferSource / Blob), per the DOM lib. */
export type SendData = Parameters<WebSocket['send']>[0];

export interface ChannelOptions {
    /** Channel path on the toil backend. Default `/_toil`. */
    readonly path?: string;
    /** Full `ws(s)://` URL override (takes precedence over `path`). */
    readonly url?: string;
    /** Auto-reconnect after an unexpected close. Default `true`. */
    readonly reconnect?: boolean;
    /** Reconnect delay in ms. Default `1000`. */
    readonly reconnectDelay?: number;
}

export interface Channel {
    /** Sends a text or binary frame (no-op until the socket is open). */
    send(data: SendData): void;
    /** Closes the channel and stops reconnecting. */
    close(): void;
}

/** Derives the channel's `ws(s)://` URL from the current page location. */
export function resolveChannelUrl(
    path: string = '/_toil',
    location: { protocol: string; host: string } = window.location,
): string {
    const scheme = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const normalized = path.startsWith('/') ? path : `/${path}`;
    return `${scheme}//${location.host}${normalized}`;
}

/**
 * Opens a channel to the backend, invoking `onMessage` for each frame. Reconnects on unexpected
 * close unless disabled. Returns a handle to `send()` and `close()`.
 */
export function connectChannel(
    onMessage: (data: ChannelData) => void,
    options: ChannelOptions = {},
): Channel {
    const url = options.url ?? resolveChannelUrl(options.path);
    const reconnect = options.reconnect ?? true;
    const delay = options.reconnectDelay ?? 1000;

    let socket: WebSocket | null = null;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const open = (): void => {
        const ws = new WebSocket(url);
        ws.binaryType = 'arraybuffer';
        socket = ws;
        ws.addEventListener('message', (event: MessageEvent) => {
            if (typeof event.data === 'string') onMessage(event.data);
            else if (event.data instanceof ArrayBuffer) onMessage(event.data);
        });
        ws.addEventListener('close', () => {
            if (!stopped && reconnect) timer = setTimeout(open, delay);
        });
    };
    open();

    return {
        send: (data: SendData): void => {
            if (socket && socket.readyState === WebSocket.OPEN) socket.send(data);
        },
        close: (): void => {
            stopped = true;
            if (timer !== undefined) clearTimeout(timer);
            socket?.close();
        },
    };
}

export interface ChannelHook {
    /** Whether the socket is currently open. */
    readonly connected: boolean;
    /** Frames received so far, in order. */
    readonly messages: ChannelData[];
    /** Sends a text or binary frame. */
    send: (data: SendData) => void;
}

/**
 * React hook wrapping {@link connectChannel}: connects on mount, tracks `connected` state and the
 * received `messages`, and cleans up on unmount.
 */
export function useChannel(options: ChannelOptions = {}): ChannelHook {
    const { path, url, reconnect, reconnectDelay } = options;
    const [connected, setConnected] = useState<boolean>(false);
    const [messages, setMessages] = useState<ChannelData[]>([]);
    const socketRef = useRef<WebSocket | null>(null);

    useEffect(() => {
        const target = url ?? resolveChannelUrl(path);
        const shouldReconnect = reconnect ?? true;
        const delay = reconnectDelay ?? 1000;
        let stopped = false;
        let timer: ReturnType<typeof setTimeout> | undefined;

        const open = (): void => {
            const ws = new WebSocket(target);
            ws.binaryType = 'arraybuffer';
            socketRef.current = ws;
            ws.addEventListener('open', () => {
                if (!stopped) setConnected(true);
            });
            ws.addEventListener('message', (event: MessageEvent) => {
                if (typeof event.data === 'string') {
                    const data = event.data;
                    setMessages((prev) => [...prev, data]);
                } else if (event.data instanceof ArrayBuffer) {
                    const data = event.data;
                    setMessages((prev) => [...prev, data]);
                }
            });
            ws.addEventListener('close', () => {
                if (stopped) return;
                setConnected(false);
                if (shouldReconnect) timer = setTimeout(open, delay);
            });
        };
        open();

        return () => {
            stopped = true;
            if (timer !== undefined) clearTimeout(timer);
            socketRef.current?.close();
        };
    }, [path, url, reconnect, reconnectDelay]);

    const send = useCallback((data: SendData): void => {
        const socket = socketRef.current;
        if (socket && socket.readyState === WebSocket.OPEN) socket.send(data);
    }, []);

    return { connected, messages, send };
}
