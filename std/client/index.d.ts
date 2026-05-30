/**
 * Ambient "native" types for the toiljs client framework.
 *
 * These are injected into the client target so users don't import them — the same
 * mechanism opnet-transform uses (a `declare global` block discovered via tsconfig).
 * Placeholder declarations; real framework globals land here.
 */

declare global {
    /** Global toil client handle, available without imports inside client code. */
    const toil: {
        readonly version: string;
    };
}

export {};
