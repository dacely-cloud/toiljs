import { type ComponentPropsWithRef, type CSSProperties, type ReactNode, useState } from 'react';

/**
 * Props for {@link Image}: every standard `<img>` attribute, plus toil's layout/loading controls.
 * `src` and `alt` are required (`alt` is enforced for accessibility, pass `alt=""` for decorative
 * images). `width`/`height` (or `fill`) reserve space to prevent layout shift.
 */
export interface ImageProps extends Omit<
    ComponentPropsWithRef<'img'>,
    'loading' | 'placeholder' | 'width' | 'height'
> {
    src: string;
    alt: string;
    /** Intrinsic width in px. Set together with `height` to reserve space (avoids layout shift). */
    width?: number;
    /** Intrinsic height in px. Set together with `width` to reserve space (avoids layout shift). */
    height?: number;
    /**
     * Fill a box toil wraps around the image (a relatively-positioned, block-level `<span>`), so the
     * image can never escape to fill the page. Size the box via `width`/`height` or `style` (e.g.
     * `style={{ aspectRatio: '16/9' }}`); `className`/`style` apply to the box, not the `<img>`. Pair
     * with `objectFit` to control cropping.
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
     * Placeholder shown until the image loads: `'empty'` (default) or `'blur'`. `'blur'` needs
     * `blurDataURL` AND a reserved size (`width`+`height`, or `fill`) — without a box there's nothing
     * to paint it in. Layout shift is prevented by the reserved size, not by the placeholder.
     */
    placeholder?: 'empty' | 'blur';
    /** A tiny (base64) image shown blurred behind the image while it loads, when `placeholder="blur"`. */
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
        src,
        alt,
        width,
        height,
        fill = false,
        objectFit,
        priority = false,
        placeholder = 'empty',
        blurDataURL,
        className: userClassName,
        style,
        onLoad,
        ...rest
    } = props;

    const [loaded, setLoaded] = useState(false);
    const showBlur = placeholder === 'blur' && blurDataURL !== undefined && !loaded;

    // Layout + the blur placeholder come from toil's shipped CSS classes (see `buildHtml`'s
    // `<style id="toil-base">`) rather than inline styles, so they're SSR-safe AND overridable by the
    // app's CSS. Only genuinely per-instance bits stay inline: `objectFit` and the blur image URL. For
    // a non-`fill` image the caller's `className`/`style` ride on the <img>; for `fill` they go on the
    // wrapper box (below) instead, since that box is what the caller sizes.
    const imgClass =
        [fill ? 'toil-img-fill' : userClassName, showBlur ? 'toil-img-blur' : undefined]
            .filter(Boolean)
            .join(' ') || undefined;
    const imgStyle: CSSProperties = {
        ...(objectFit !== undefined ? { objectFit } : {}),
        ...(showBlur ? { backgroundImage: `url(${blurDataURL})` } : {}),
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

    // `fill`: the image is absolutely positioned, so without a positioned ancestor it escapes to fill
    // the nearest positioned one (often the whole page). Wrap it in our OWN relatively-positioned,
    // block-level box so it can only ever fill THIS box, which the caller sizes via `width`/`height`
    // or `style` (e.g. `<Image fill width={400} height={300} />` or `style={{ aspectRatio: '16/9' }}`).
    const boxStyle: CSSProperties = {
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
