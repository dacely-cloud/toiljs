import { spawn } from 'node:child_process';

/**
 * Spawns `cmd args` in `cwd`, resolving on a 0 exit code and rejecting otherwise. On Windows the
 * `npm`/`pnpm`/`yarn` shims are `.cmd` files that need a shell; passing an args array with
 * `shell: true` is deprecated (DEP0190), so the whole command is passed as one string there
 * (args are fixed/allowlisted, never raw user input). POSIX spawns directly.
 */
export function run(cmd: string, args: string[], cwd: string): Promise<void> {
    return new Promise((resolve, reject) => {
        const onWindows = process.platform === 'win32';
        const child = onWindows
            ? spawn([cmd, ...args].join(' '), { cwd, stdio: 'ignore', shell: true })
            : spawn(cmd, args, { cwd, stdio: 'ignore' });
        child.on('error', reject);
        child.on('close', (code) =>
            code === 0 ? resolve() : reject(new Error(`${cmd} exited with code ${String(code)}`)),
        );
    });
}
