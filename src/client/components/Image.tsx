import { useState, type CSSProperties, type ComponentPropsWithRef, type ReactNode } from 'react';

/**
 * Props for {@link Image}: every standard `<img>` attribute, plus toil's layout/loading controls.
 * `src` and `alt` are required (`alt` is enforced for accessibility — pass `alt=""` for decorative
 * images). `width`/`height` (or `fill`) reserve space to prevent layout shift.
 */
export interface ImageProps
    extends Omit<ComponentPropsWithRef<'img'>, 'loading' | 'placeholder' | 'width' | 'height'> {
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
     * Mark this as a high-priority (LCP) image: eager load + `fetchpriority="high"` and no lazy
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
 * `priority`, and can fade in from a `blur` placeholder. This is a client-only component — there is
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
        style,
        onLoad,
        ...rest
    } = props;

    const [loaded, setLoaded] = useState(false);
    const showBlur = placeholder === 'blur' && blurDataURL !== undefined && !loaded;

    const layoutStyle: CSSProperties = fill
        ? { position: 'absolute', inset: 0, width: '100%', height: '100%' }
        : {};
    const blurStyle: CSSProperties = showBlur
        ? {
              backgroundImage: `url(${blurDataURL})`,
              backgroundSize: 'cover',
              backgroundPosition: 'center',
              filter: 'blur(20px)',
          }
        : {};

    return (
        <img
            {...rest}
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
            style={{ ...layoutStyle, objectFit, ...blurStyle, ...style }}
        />
    );
}
