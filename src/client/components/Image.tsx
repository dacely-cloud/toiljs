import { type ComponentPropsWithRef, type CSSProperties, type ReactNode, useState } from 'react';

/**
 * Props for {@link Image}: every standard `<img>` attribute, plus toil's layout/loading controls.
 * `src` and `alt` are required (`alt` is enforced for accessibility, pass `alt=""` for decorative
 * images). `width`/`height` (or `fill`) reserve space to prevent layout shift.
 */
/** A toil image source carrying an auto-generated blur LQIP + intrinsic size, produced by importing an
 * image with the `?toil` flag (`import hero from './hero.webp?toil'`). Pass it straight to `Image`. */
export interface ToilImageSource {
    src: string;
    width?: number;
    height?: number;
    blurDataURL?: string;
}

export interface ImageProps extends Omit<
    ComponentPropsWithRef<'img'>,
    'loading' | 'placeholder' | 'width' | 'height' | 'src'
> {
    /** The image URL, or a `?toil` import object that auto-fills the blur placeholder + aspect-ratio. */
    src: string | ToilImageSource;
    alt: string;
    /** Intrinsic width in px. Set together with `height` to reserve space (avoids layout shift). */
    width?: number;
    /** Intrinsic height in px. Set together with `width` to reserve space (avoids layout shift). */
    height?: number;
    /**
     * Make the image fill the width of a box toil wraps around it (a block-level `<span>`), scaling to
     * its natural height — or, if you size the box (`width`/`height`, or `style` like
     * `aspectRatio: '16/9'`), the image covers that box, cropped per `objectFit` (default `cover`).
     * The image flows in-block (never absolutely positioned), so it can't escape to fill the page or
     * collapse to nothing. `className`/`style` apply to the box, not the `<img>`.
     */
    fill?: boolean;
    /** `object-fit` for the rendered image (handy with `fill`). */
    objectFit?: CSSProperties['objectFit'];
    /**
     * Mark this as a high-priority (LCP) image: eager load + `fetchPriority="high"` and no lazy
     * loading. Use for above-the-fold hero images; everything else stays lazy. Default `false`.
     */
    priority?: boolean;
    /**
     * Placeholder shown until the image loads: `'empty'` (default) or `'blur'`. `'blur'` paints the
     * `blurDataURL` (auto-filled from a `?toil` import, or passed) blurred, or a neutral skeleton
     * shimmer if there's none. It needs a reserved size (`width`+`height`, or `fill`) to paint into —
     * which also prevents layout shift (the placeholder is cosmetic; the reserved size is what holds).
     */
    placeholder?: 'empty' | 'blur';
    /**
     * A tiny base64 image shown blurred while the real image loads (with `placeholder="blur"`).
     * Auto-generated when you import via `?toil` (`import hero from './hero.webp?toil'`); pass it
     * explicitly only for a string `src`. Omit it to fall back to a neutral skeleton shimmer.
     */
    blurDataURL?: string;
}

/**
 * A drop-in `<img>` replacement that prevents layout shift and lazy-loads by default. It reserves
 * space from `width`/`height` (or fills its container with `fill`), decodes async, lazy-loads unless
 * `priority`, and can fade in from a `blur` placeholder. This is a client-only component, there is
 * no server-side resizing; pass an already-optimized `src` (Vite hashes imported assets for you).
 */
export function Image(props: ImageProps): ReactNode {
    const {
        src: srcProp,
        alt,
        width: widthProp,
        height: heightProp,
        fill = false,
        objectFit,
        priority = false,
        placeholder = 'empty',
        blurDataURL: blurDataURLProp,
        className: userClassName,
        style,
        onLoad,
        ...rest
    } = props;

    // `src` may be a plain URL or a `?toil` import object; unpack it and let explicit props win, so a
    // `?toil` import auto-fills the blur placeholder + aspect-ratio with no extra props.
    const source = typeof srcProp === 'string' ? null : srcProp;
    const src = typeof srcProp === 'string' ? srcProp : srcProp.src;
    const width = widthProp ?? source?.width;
    const height = heightProp ?? source?.height;
    const blurDataURL = blurDataURLProp ?? source?.blurDataURL;

    const [loaded, setLoaded] = useState(false);
    // The placeholder paints while the real image loads, then drops on load. With a `blurDataURL`
    // (auto-filled by a `?toil` import, or passed) it's that tiny image blurred; otherwise it's a
    // neutral skeleton shimmer — so `placeholder="blur"` is never a silent no-op. It only shows if
    // there's a reserved box to paint into (give `width`+`height`, or use `fill` in a sized parent).
    const showPlaceholder = placeholder === 'blur' && !loaded;
    const placeholderClass = !showPlaceholder
        ? undefined
        : blurDataURL !== undefined
          ? 'toil-img-blur'
          : 'toil-img-skeleton';
    // Reserve space so the image can't shift layout when it loads: an explicit aspect-ratio derived
    // from width+height survives responsive `width:100%` CSS (bare width/height attributes do not).
    const aspectRatio =
        width !== undefined && height !== undefined ? `${width} / ${height}` : undefined;

    // Layout + placeholder come from toil's shipped CSS classes (see `buildHtml`'s `<style id="toil-
    // base">`) not inline styles, so they're SSR-safe AND overridable. Only per-instance bits stay
    // inline: `objectFit`, the aspect-ratio, and the blur image URL. For a non-`fill` image the
    // caller's `className`/`style` ride on the <img>; for `fill` they go on the wrapper box below.
    const imgClass =
        [fill ? 'toil-img-fill' : userClassName, placeholderClass].filter(Boolean).join(' ') ||
        undefined;
    const imgStyle: CSSProperties = {
        ...(objectFit !== undefined ? { objectFit } : {}),
        ...(showPlaceholder && blurDataURL !== undefined
            ? { backgroundImage: `url(${blurDataURL})` }
            : {}),
        ...(fill || aspectRatio === undefined ? {} : { aspectRatio }),
        ...(fill ? {} : style),
    };

    const img = (
        <img
            {...rest}
            className={imgClass}
            src={src}
            alt={alt}
            width={fill ? undefined : width}
            height={fill ? undefined : height}
            loading={priority ? 'eager' : 'lazy'}
            decoding="async"
            fetchPriority={priority ? 'high' : 'auto'}
            onLoad={(event) => {
                setLoaded(true);
                onLoad?.(event);
            }}
            style={Object.keys(imgStyle).length > 0 ? imgStyle : undefined}
        />
    );

    if (!fill) return img;

    // `fill`: the image flows in-block at 100% of its box's width (scaling to natural height), or
    // covers the box if the caller sizes it (`width`/`height`, or `style` like `aspectRatio`). It is
    // NEVER absolutely positioned, so it can't escape to fill the page nor collapse to a zero-height
    // box. We still wrap it so the caller's `width`/`height`/`style` size the box, not the raw `<img>`.
    const boxStyle: CSSProperties = {
        ...(aspectRatio !== undefined ? { aspectRatio } : {}),
        ...(width !== undefined ? { width } : {}),
        ...(height !== undefined ? { height } : {}),
        ...style,
    };
    return (
        <span
            className={[userClassName, 'toil-img-fill-box'].filter(Boolean).join(' ') || undefined}
            style={Object.keys(boxStyle).length > 0 ? boxStyle : undefined}
        >
            {img}
        </span>
    );
}
