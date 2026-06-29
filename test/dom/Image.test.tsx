// @vitest-environment jsdom
import { cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { Image } from '../../src/client/components/Image';

afterEach(cleanup);

describe('Image', () => {
    it('lazy-loads and decodes async by default, with the given dimensions', () => {
        const { getByAltText } = render(
            <Image
                src="/a.png"
                alt="a"
                width={200}
                height={100}
            />,
        );
        const img = getByAltText('a') as HTMLImageElement;
        expect(img.getAttribute('src')).toBe('/a.png');
        expect(img.getAttribute('loading')).toBe('lazy');
        expect(img.getAttribute('decoding')).toBe('async');
        expect(img.getAttribute('width')).toBe('200');
        expect(img.getAttribute('height')).toBe('100');
        expect(img.getAttribute('fetchpriority')).toBe('auto');
        // A plain image adds no inline style and no toil class (nothing to lay out).
        expect(img.getAttribute('style')).toBe(null);
        expect(img.className).toBe('');
    });

    it('priority images load eagerly with high fetch priority', () => {
        const { getByAltText } = render(
            <Image
                src="/hero.png"
                alt="hero"
                priority
            />,
        );
        const img = getByAltText('hero') as HTMLImageElement;
        expect(img.getAttribute('loading')).toBe('eager');
        expect(img.getAttribute('fetchpriority')).toBe('high');
    });

    it('fill drops width/height and lays out via the toil-img-fill class, not inline styles', () => {
        const { getByAltText } = render(
            <Image
                src="/bg.png"
                alt="bg"
                fill
                objectFit="cover"
            />,
        );
        const img = getByAltText('bg') as HTMLImageElement;
        expect(img.hasAttribute('width')).toBe(false);
        expect(img.hasAttribute('height')).toBe(false);
        // The fill layout comes from a shipped, overridable CSS class, NOT inline positioning.
        expect(img.classList.contains('toil-img-fill')).toBe(true);
        expect(img.style.position).toBe('');
        // objectFit is genuinely per-instance, so it stays inline.
        expect(img.style.objectFit).toBe('cover');
    });

    it('preserves the caller className alongside the fill class', () => {
        const { getByAltText } = render(
            <Image
                src="/bg.png"
                alt="bg2"
                fill
                className="hero"
            />,
        );
        const img = getByAltText('bg2') as HTMLImageElement;
        expect(img.classList.contains('hero')).toBe(true);
        expect(img.classList.contains('toil-img-fill')).toBe(true);
        expect(img.getAttribute('style')).toBe(null);
    });

    it('shows a blur placeholder until the image loads', () => {
        const { getByAltText } = render(
            <Image
                src="/p.png"
                alt="p"
                width={10}
                height={10}
                placeholder="blur"
                blurDataURL="data:image/x"
            />,
        );
        const img = getByAltText('p') as HTMLImageElement;
        expect(img.classList.contains('toil-img-blur')).toBe(true);
        expect(img.style.backgroundImage).toContain('data:image/x');
        fireEvent.load(img);
        expect(img.style.backgroundImage).toBe('');
        expect(img.classList.contains('toil-img-blur')).toBe(false);
    });
});
