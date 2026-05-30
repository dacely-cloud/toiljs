/**
 * Editor-only ambient stub for backend native instructions/decorators.
 *
 * The real declarations ship inside the toil AssemblyScript fork's std lib; `asc` ignores
 * this file. It exists purely so the IDE recognizes natives like `@main` in src/backend
 * until the fork is wired in.
 */

declare global {
    /** Marks the contract entry point. Provided natively by the toil AssemblyScript fork. */
    function main(target: unknown): void;
}

export {};
