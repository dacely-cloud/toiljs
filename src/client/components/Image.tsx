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
     * Fill the nearest positioned ancestor (the parent must be `position: relative|absolute|fixed`).
     * The image is absolutely positioned at 100% × 100%; `width`/`height` are ignored. Pair with
     * `objectFit` to control cropping.
     */
    fill?: boolean;
    /** `object-fit` for the rendered image (handy with `fill`). */
    objectFit?: CSSProperties['objectFit'];
    /**
     * Mark this as a high-priority (LCP) image: eager load + `fetchPriority="high"` and no lazy
     * loading. Use for above-the-fold hero images; everything else stays lazy. Default `false`.
     */
    priority?: boolean;
    /** Placeholder shown until the image loads: `'empty'` (default) or `'blur'` (needs `blurDataURL`). */
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

    // `fill` and the blur placeholder are applied via toil's shipped CSS classes (see `buildHtml`'s
    // `<style id="toil-base">`) rather than inline styles: the layout is then SSR-safe (it's in the
    // document, not injected by JS) AND the app can override it with its own CSS, which an inline
    // `style` would block. Only the genuinely per-instance bits that can't be a static class stay
    // inline — `objectFit` and the blur image URL — and the caller's own `style` still wins.
    const className =
        [userClassName, fill ? 'toil-img-fill' : undefined, showBlur ? 'toil-img-blur' : undefined]
            .filter(Boolean)
            .join(' ') || undefined;
    const dynamicStyle: CSSProperties = {
        ...(objectFit !== undefined ? { objectFit } : {}),
        ...(showBlur ? { backgroundImage: `url(${blurDataURL})` } : {}),
        ...style,
    };

    return (
        <img
            {...rest}
            className={className}
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
            style={Object.keys(dynamicStyle).length > 0 ? dynamicStyle : undefined}
        />
    );
}
