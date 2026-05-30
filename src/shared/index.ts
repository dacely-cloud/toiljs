/**
 * Shared primitives used across every toiljs target (client, compiler, cli, backend tooling).
 * Placeholder — real shared types/utilities land here.
 */

export const FRAMEWORK_NAME = 'toiljs';

export interface ToilTarget {
    readonly name: 'client' | 'compiler' | 'cli' | 'backend';
}
