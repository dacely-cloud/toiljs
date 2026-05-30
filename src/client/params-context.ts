/**
 * React context carrying the current route's dynamic params. The provider is set by {@link Router};
 * read it with the {@link useParams} hook rather than consuming the context directly.
 */
import { createContext } from 'react';

import type { RouteParams } from './match.js';

/** Holds the params extracted from the active route (e.g. `{ id }` for `/blog/:id`). */
export const ParamsContext = createContext<RouteParams>({});
