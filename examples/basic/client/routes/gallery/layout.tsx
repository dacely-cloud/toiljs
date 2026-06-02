import { type ReactNode } from 'react';

// This layout renders the normal page content AND a parallel `@modal` slot. The slot stays empty
// until an intercepting route fills it (see @modal/(.)photo/[id].tsx), at which point a modal appears
// over the gallery without leaving the page.
export default function GalleryLayout({ children }: { children?: ReactNode }) {
    return (
        <div>
            {children}
            <Toil.Slot name="modal" />
        </div>
    );
}
