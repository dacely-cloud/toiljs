// @vitest-environment jsdom
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
    DevErrorBoundary,
    DevErrorOverlay,
    initDevErrorOverlay,
} from '../../src/client/dev/error-overlay';

afterEach(cleanup);

function Boom(): never {
    throw new Error('render boom');
}

describe('dev error overlay', () => {
    it('surfaces an uncaught render error', () => {
        // React logs caught boundary errors to console.error — silence it for a clean test run.
        const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
        const { getByRole } = render(
            <>
                <DevErrorBoundary>
                    <Boom />
                </DevErrorBoundary>
                <DevErrorOverlay />
            </>,
        );
        expect(getByRole('alert').textContent).toContain('render boom');
        spy.mockRestore();
    });

    it('surfaces an unhandled window error and dismisses it', async () => {
        initDevErrorOverlay();
        const { findByRole, queryByRole, getByText } = render(<DevErrorOverlay />);
        act(() => {
            window.dispatchEvent(new ErrorEvent('error', { error: new Error('async boom') }));
        });
        const alert = await findByRole('alert');
        expect(alert.textContent).toContain('async boom');
        fireEvent.click(getByText('Dismiss'));
        expect(queryByRole('alert')).toBeNull();
    });
});
