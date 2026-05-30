import { mount } from 'toiljs/client';
import { routes, layout, notFound } from 'toiljs/routes';

import './styles/main.css';

// The app entry. Customize global setup here (providers, styles, etc.), then mount.
mount(routes, layout, notFound);
