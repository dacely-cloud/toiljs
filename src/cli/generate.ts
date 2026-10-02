/** Generate project authentication credentials without rotating existing keys. */
import { randomBytes, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { parseEnv } from 'node:util';
import { ml_kem768 } from '@dacely/noble-post-quantum/ml-kem.js';

const PRIVATE_KEYS = ['AUTH_SESSION_SECRET', 'AUTH_OPRF_SEED', 'AUTH_KEM_SK'] as const;
const PUBLIC_KEY = 'VITE_AUTH_KEM_PUBLIC_KEY';

function read(file: string): string {
    const stat = fs.lstatSync(file, { throwIfNoEntry: false });
    if (!stat) return '';
    if (!stat.isFile()) throw new Error(`Expected a regular file: ${file}`);
    return fs.readFileSync(file, 'utf8');
}

function append(text: string, lines: string[]): string {
    if (!lines.length) return text;
    return text + (text && !text.endsWith('\n') ? '\n' : '') + lines.join('\n') + '\n';
}

/** Recover and validate the public half without replacing the server identity. */
function publicKeyFor(secret: string): string {
    try {
        if (!/^[0-9a-fA-F]{4800}$/.test(secret)) throw new Error();
        const sk = Buffer.from(secret, 'hex');
        const pk = ml_kem768.getPublicKey(sk);
        const { cipherText, sharedSecret } = ml_kem768.encapsulate(pk);
        if (!timingSafeEqual(sharedSecret, ml_kem768.decapsulate(cipherText, sk)))
            throw new Error();
        return Buffer.from(pk).toString('hex');
    } catch {
        throw new Error(
            'AUTH_KEM_SK is not a valid ML-KEM-768 secret key. Existing files were not changed.',
        );
    }
}

export function runGenerate(target: string | undefined, opts: { root?: string } = {}): void {
    if (target !== 'auth') throw new Error('Usage: toiljs generate auth [--root <dir>]');
    const root = path.resolve(opts.root ?? process.cwd());
    const envFile = path.join(root, '.env');
    const secretsFile = path.join(root, '.env.secrets');
    const ignoreFile = path.join(root, '.gitignore');
    const envText = read(envFile);
    const secretsText = read(secretsFile);
    const ignoreText = read(ignoreFile);
    const env = parseEnv(envText);
    const secrets = parseEnv(secretsText);

    for (const key of PRIVATE_KEYS) {
        if (Object.hasOwn(env, key))
            throw new Error(`Move ${key} from .env to .env.secrets before generating auth keys.`);
        if (Object.hasOwn(secrets, key) && !secrets[key]?.trim())
            throw new Error(
                `${key} is empty in .env.secrets. Remove the empty assignment to generate it.`,
            );
    }
    // A public key alone may belong to an existing deployment. Never replace its identity.
    if (Object.hasOwn(env, PUBLIC_KEY) && !secrets.AUTH_KEM_SK)
        throw new Error(
            'A public key already exists. Restore its matching AUTH_KEM_SK in .env.secrets; no keys were changed.',
        );

    const additions: string[] = [];
    let publicKey: string;
    if (secrets.AUTH_KEM_SK) {
        publicKey = publicKeyFor(secrets.AUTH_KEM_SK);
    } else {
        const pair = ml_kem768.keygen();
        publicKey = Buffer.from(pair.publicKey).toString('hex');
        additions.push(`AUTH_KEM_SK=${Buffer.from(pair.secretKey).toString('hex')}`);
    }
    if (Object.hasOwn(env, PUBLIC_KEY) && env[PUBLIC_KEY] !== publicKey)
        throw new Error(
            'VITE_AUTH_KEM_PUBLIC_KEY does not match AUTH_KEM_SK. Existing files were not changed. Restore the matching pair before continuing.',
        );

    for (const key of ['AUTH_SESSION_SECRET', 'AUTH_OPRF_SEED']) {
        if (!Object.hasOwn(secrets, key))
            additions.push(`${key}=${randomBytes(32).toString('hex')}`);
    }
    const publicAdditions = Object.hasOwn(env, PUBLIC_KEY) ? [] : [`${PUBLIC_KEY}=${publicKey}`];
    const ignoreLines = new Set(ignoreText.split(/\r?\n/));
    const ignoreAdditions = ['/.env', '/.env.secrets'].filter((line) => !ignoreLines.has(line));

    // Validate everything before touching disk. Save private material first so an interrupted
    // run can recover the public key from it. Tighten permissions before appending secrets.
    if (ignoreAdditions.length) fs.writeFileSync(ignoreFile, append(ignoreText, ignoreAdditions));
    if (fs.existsSync(secretsFile)) fs.chmodSync(secretsFile, 0o600);
    if (additions.length)
        fs.writeFileSync(secretsFile, append(secretsText, additions), { mode: 0o600 });
    if (publicAdditions.length)
        fs.writeFileSync(envFile, append(envText, publicAdditions), { mode: 0o600 });

    process.stdout.write(
        [
            `Authentication keys ready in ${root}. Existing credentials were preserved.`,
            '  .env.secrets: AUTH_SESSION_SECRET, AUTH_OPRF_SEED, AUTH_KEM_SK (private; mode 0600)',
            '  .env: VITE_AUTH_KEM_PUBLIC_KEY (public; pin it with Auth login/register options)',
            'Back up .env.secrets securely. This command does not rotate existing keys.',
            'For toil-backend, merge private settings into /run/toil/env/<host>.env.secrets',
            '(or TOIL_ENV_DIR); use toil env sync <host> if the env store is database-backed.',
            'Keep VITE_AUTH_KEM_PUBLIC_KEY in the project .env on the build machine, then rebuild',
            'and deploy the client. Backend runtime env changes cannot update the browser bundle.',
            '',
        ].join('\n'),
    );
}
