import { useRef, type ReactNode, type SyntheticEvent } from 'react';

import { useAction, type ActionState, type RevalidateTarget } from '../routing/action.js';

/** Props for {@link Form}. */
export interface FormProps {
    /** Handles the submission, receiving the form's `FormData`. May be async. */
    action: (data: FormData) => void | Promise<void>;
    /** Loader data to revalidate after a successful submit. Default `true` (the current route). */
    revalidate?: RevalidateTarget;
    /** Called after a successful submit. */
    onSuccess?: () => void;
    /** Called when the action throws. */
    onError?: (error: unknown) => void;
    /** Reset the form fields after a successful submit. Default `false`. */
    resetOnSuccess?: boolean;
    className?: string;
    /**
     * Form contents. Pass a render function to receive live submit state, e.g. to disable the
     * button while pending: `{({ pending }) => <button disabled={pending}>Save</button>}`.
     */
    children?: ReactNode | ((state: ActionState<void>) => ReactNode);
}

/**
 * A `<form>` that runs an {@link useAction} on submit (no page reload) and revalidates loader data
 * on success, the write half of the loader/action data loop. Tracks pending/error state, which a
 * render-function child can read.
 */
export function Form({
    action,
    revalidate,
    onSuccess,
    onError,
    resetOnSuccess = false,
    className,
    children,
}: FormProps): ReactNode {
    const formRef = useRef<HTMLFormElement | null>(null);
    const handle = useAction((data: FormData) => action(data), {
        revalidate,
        onError,
        onSuccess: () => {
            if (resetOnSuccess) formRef.current?.reset();
            onSuccess?.();
        },
    });

    const onSubmit = (event: SyntheticEvent<HTMLFormElement>): void => {
        event.preventDefault();
        formRef.current = event.currentTarget;
        void handle.run(new FormData(event.currentTarget));
    };

    return (
        <form
            ref={formRef}
            className={className}
            onSubmit={onSubmit}>
            {typeof children === 'function'
                ? children({ pending: handle.pending, error: handle.error, data: handle.data })
                : children}
        </form>
    );
}
