import type { MouseEvent, ReactNode } from 'react';

import { navigate } from './navigation.js';
import { prefetch } from './prefetch.js';

/**
 * Client-side navigation link. Falls back to default browser behavior for modified clicks, and
 * prefetches the target route's chunk on hover/focus so the click navigates instantly.
 */
export function Link(props: { href: string; className?: string; children?: ReactNode }): ReactNode {
    const { href, className, children } = props;
    const onClick = (e: MouseEvent): void => {
        if (
            e.defaultPrevented ||
            e.button !== 0 ||
            e.metaKey ||
            e.ctrlKey ||
            e.shiftKey ||
            e.altKey
        )
            return;
        e.preventDefault();
        navigate(href);
    };
    const onIntent = (): void => {
        prefetch(href);
    };
    return (
        <a
            href={href}
            className={className}
            onClick={onClick}
            onPointerEnter={onIntent}
            onFocus={onIntent}>
            {children}
        </a>
    );
}
