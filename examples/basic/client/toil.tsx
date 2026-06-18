import { globalError, layout, notFound, routes, slots } from 'toiljs/routes';

import './styles/main.css';

Toil.mount(routes, layout, notFound, globalError, slots);
