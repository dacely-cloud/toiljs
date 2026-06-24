import { routes, layout, notFound, globalError, slots } from 'toiljs/routes';

import './styles/main.css';

Toil.mount(routes, layout, notFound, globalError, slots);
