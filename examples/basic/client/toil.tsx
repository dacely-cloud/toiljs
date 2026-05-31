import { routes, layout, notFound, globalError } from 'toiljs/routes';

import './styles/main.css';



Toil.mount(routes, layout, notFound, globalError);
