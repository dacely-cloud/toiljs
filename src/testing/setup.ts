import * as Toil from 'toiljs/client';
import { DataReader, DataWriter, FastMap, FastSet } from 'toiljs/io';

/** Install the same ambient runtime as a generated toiljs client entry, without mounting an app. */
Object.assign(globalThis, {
    Toil,
    DataReader,
    DataWriter,
    FastMap,
    FastSet,
    Server: Toil.Server,
    parseError: Toil.parseError,
});
