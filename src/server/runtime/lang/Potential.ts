/**
 * `Potential<T>` is just `T | null`. Mirrors btc-runtime's
 * convention so the runtime's optional fields read consistently.
 */
export type Potential<T> = T | null;
