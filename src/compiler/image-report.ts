import fs from 'node:fs';
import path from 'node:path';

import pc from 'picocolors';
import type { Logger, Plugin } from 'vite';

/** Raster/vector outputs the image pipeline may emit. */
const IMAGE_RE = /\.(png|jpe?g|webp|avif|gif|tiff|svg)$/i;

/** Formats a byte count like Vite's asset table (kB, base 1000). */
function kb(bytes: number): string {
    return `${(bytes / 1000).toFixed(2)} kB`;
}

interface Variant {
    readonly out: string;
    readonly outSize: number;
}

/**
 * Build-only plugin that reports which imported images the pipeline optimized, each source image,
 * its emitted variant(s), and the size saved. `public/` assets (copied as-is) never enter the
 * bundle, so they don't appear here. Logs nothing when no images were processed.
 *
 * `viteRoot` is Vite's root (the `.toil` dir) that emitted assets' `originalFileNames` are relative
 * to; `projectRoot` is used only to print friendly source paths.
 */
export function imageReportPlugin(projectRoot: string, viteRoot: string): Plugin {
    let logger: Logger | undefined;
    return {
        name: 'toil:image-report',
        apply: 'build',
        configResolved(config) {
            logger = config.logger;
        },
        writeBundle(_options, bundle) {
            // Group emitted image assets by their source file.
            const bySource = new Map<
                string,
                { label: string; inSize: number | null; variants: Variant[] }
            >();
            for (const file of Object.values(bundle)) {
                if (file.type !== 'asset' || !IMAGE_RE.test(file.fileName)) continue;
                const source = file.originalFileNames[0];
                const key = source ?? file.fileName;
                const outSize =
                    typeof file.source === 'string'
                        ? Buffer.byteLength(file.source)
                        : file.source.byteLength;

                let entry = bySource.get(key);
                if (!entry) {
                    let inSize: number | null = null;
                    let label = '(generated)';
                    if (source !== undefined) {
                        const abs = path.resolve(viteRoot, source);
                        label = path.relative(projectRoot, abs);
                        try {
                            inSize = fs.statSync(abs).size;
                        } catch {
                            inSize = null;
                        }
                    }
                    entry = { label, inSize, variants: [] };
                    bySource.set(key, entry);
                }
                entry.variants.push({ out: file.fileName, outSize });
            }

            if (bySource.size === 0 || !logger) return;

            const count = bySource.size;
            logger.info('');
            logger.info(pc.green(`  ✓ optimized ${String(count)} image${count === 1 ? '' : 's'}`));
            for (const { label, inSize, variants } of bySource.values()) {
                logger.info(`  ${pc.dim(label)}`);
                for (const v of variants) {
                    const saved =
                        inSize && inSize > 0
                            ? pc.green(`  -${String(Math.round((1 - v.outSize / inSize) * 100))}%`)
                            : '';
                    const from = inSize ? `${kb(inSize)} → ` : '';
                    logger.info(`    ${pc.dim('→')} ${v.out}  ${from}${kb(v.outSize)}${saved}`);
                }
            }
        },
    };
}
