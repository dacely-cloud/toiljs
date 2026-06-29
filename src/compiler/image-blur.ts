import type { Plugin } from 'vite';

/** An image import carrying the `?toil` flag: `import hero from './hero.webp?toil'`. */
const TOIL_QUERY = /[?&]toil(?:&|$)/;
/** Raster formats sharp can downscale into an LQIP. (SVG/animated stay as-is — no blur.) */
const RASTER = /\.(?:png|jpe?g|webp|avif|gif|tiff?)(?:\?|$)/i;

/**
 * Auto-generates a tiny blurred base64 LQIP (low-quality image placeholder) for raster images imported
 * with the `?toil` flag, and returns a `{ src, width, height, blurDataURL }` object that `Toil.Image`
 * consumes to auto-fill its `blurDataURL` (`placeholder="blur"`) and its aspect-ratio — the way Next.js
 * bakes a `blurDataURL` for static image imports. Runs in dev and build (Vite `load`); `sharp` is loaded
 * lazily so it only costs anything when a `?toil` import is actually resolved.
 *
 * Usage: `import hero from './hero.webp?toil'` then `<Toil.Image src={hero} placeholder="blur" />`.
 * The bare `src` is re-imported with no query, so Vite/imagetools still optimize + hash the real asset
 * (this plugin only adds the placeholder + intrinsic size); it skips itself on that bare import.
 */
export function imageBlurPlugin(): Plugin {
    return {
        name: 'toil:image-blur',
        enforce: 'pre',
        async load(id) {
            if (!TOIL_QUERY.test(id) || !RASTER.test(id)) return undefined;
            const file = id.replace(/\?.*$/, '');
            const { default: sharp } = await import('sharp');
            const meta = await sharp(file).metadata();
            // ~24px longest edge, blurred, webp — a few hundred base64 bytes, inlined as a data URI.
            const lqip = await sharp(file)
                .resize(24, 24, { fit: 'inside' })
                .blur()
                .webp({ quality: 40 })
                .toBuffer();
            const blurDataURL = `data:image/webp;base64,${lqip.toString('base64')}`;
            return (
                `import src from ${JSON.stringify(file)};\n` +
                `export default { src, width: ${meta.width ?? 0}, height: ${meta.height ?? 0}, ` +
                `blurDataURL: ${JSON.stringify(blurDataURL)} };\n`
            );
        },
    };
}
