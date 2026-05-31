import { describe, expect, it } from 'vitest';

import { resolveChannelUrl } from '../src/client/channel/channel';

describe('resolveChannelUrl', () => {
    it('uses ws:// over http and the default /_toil path', () => {
        expect(resolveChannelUrl(undefined, { protocol: 'http:', host: 'localhost:3000' })).toBe(
            'ws://localhost:3000/_toil',
        );
    });

    it('uses wss:// over https', () => {
        expect(resolveChannelUrl('/_toil', { protocol: 'https:', host: 'app.example.com' })).toBe(
            'wss://app.example.com/_toil',
        );
    });

    it('normalizes a path without a leading slash', () => {
        expect(resolveChannelUrl('live', { protocol: 'http:', host: 'h:1' })).toBe('ws://h:1/live');
    });
});
