import { defineConfig } from 'toiljs/compiler';

export default defineConfig({
    client: {
        // Optimize images at build time (resize/compress imported images).
        images: true,
    },
});
