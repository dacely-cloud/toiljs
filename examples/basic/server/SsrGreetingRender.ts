/**
 * A hand-written edge-SSR `render` for the `/hello` route, authored against the
 * generated typed `Slot` enum + `HASH`. It derives its data from the request
 * and fills the holes; the host splices these values into the precompiled
 * template. Registers itself with the `Ssr` router (compiler-injected in a real
 * build; explicit here).
 */
import { Request } from 'toiljs/server/runtime';
import { HtmlBuilder, SlotValues, Ssr } from 'toiljs/server/runtime';
import { HASH, Slot } from './ssr/greeting.slots';

function renderGreeting(req: Request): SlotValues | null {
    if (req.path != '/hello') return null;
    const v = new SlotValues(HASH);
    // A text hole: React-escaped (note the `&` and `<>` get entities).
    v.setText(Slot.greeting, 'world & <friends>');
    // A repeat region: three stamped rows.
    const rows = new HtmlBuilder();
    const items: string[] = ['a & b', '<c>', 'd'];
    for (let i = 0; i < items.length; i++) {
        rows.raw('<li>').text(items[i]).raw('</li>');
    }
    v.setRepeat(Slot.count, rows);
    return v;
}

Ssr.register(renderGreeting);
