import { routes, layout, notFound } from 'toiljs/routes';

import './styles/main.css';

// The app entry. Customize global setup here (providers, styles, etc.), then mount.
// `Toil` is a native global (like the IO classes) — no import from 'toiljs/client' needed.
Toil.mount(routes, layout, notFound);
