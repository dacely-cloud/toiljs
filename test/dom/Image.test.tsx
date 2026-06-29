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

    it('fill wraps the image in a box; the image lays out via a class, not inline styles', () => {
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
        // The image is wrapped in a <span> box the caller sizes, so it fills the box, not the page.
        const box = img.parentElement as HTMLElement;
        expect(box.tagName).toBe('SPAN');
        expect(box.classList.contains('toil-img-fill-box')).toBe(true);
    });

    it('puts the caller className/size on the fill box, the fill class on the image', () => {
        const { getByAltText } = render(
            <Image
                src="/bg.png"
                alt="bg2"
                fill
                width={400}
                height={300}
                className="hero"
            />,
        );
        const img = getByAltText('bg2') as HTMLImageElement;
        const box = img.parentElement as HTMLElement;
        // The caller's className + size land on the box (what they size); the image just fills it.
        expect(box.classList.contains('hero')).toBe(true);
        expect(box.classList.contains('toil-img-fill-box')).toBe(true);
        expect(box.style.width).toBe('400px');
        expect(box.style.height).toBe('300px');
        expect(img.classList.contains('toil-img-fill')).toBe(true);
        expect(img.getAttribute('style')).toBe(null);
        expect(img.hasAttribute('width')).toBe(false);
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
