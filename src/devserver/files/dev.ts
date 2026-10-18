import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { loadEnvFiles } from '../config/dotenv.js';
import { installDevBlobEnvironment } from '../config/env.js';
import { startDiskBlobServer } from './disk.js';

/** Configured remote storage wins. Partial remote config stays visible as a
 * configuration error rather than unexpectedly writing to a local directory. */
export async function startDevBlobStorage(
    root: string,
): Promise<{ close(): Promise<void> } | null> {
    const env = loadEnvFiles(root);
    if (
        ['BLOB_ENDPOINT', 'BLOB_BUCKET', 'BLOB_REGION'].some((key) => env.vars.has(key)) ||
        ['BLOB_ACCESS_KEY_ID', 'BLOB_SECRET_ACCESS_KEY', 'BLOB_SESSION_TOKEN'].some((key) =>
            env.secrets.has(key),
        )
    )
        return null;
    const store = await startDiskBlobServer({
        directory: join(root, '.toil', 'blobs'),
        bucket: 'toil-dev',
        region: 'us-east-1',
        accessKey: 'toil-dev',
        secretKey: randomBytes(32).toString('hex'),
    });
    const vars = new Map(store.vars);
    const prefix = env.vars.get('BLOB_PREFIX');
    if (prefix !== undefined) vars.set('BLOB_PREFIX', prefix);
    const uninstall = installDevBlobEnvironment({ vars, secrets: store.secrets });
    return {
        async close() {
            uninstall();
            await store.close();
        },
    };
}
