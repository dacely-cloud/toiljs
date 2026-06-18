import { Response, RouteContext } from 'toiljs/server/runtime';

/**
 * Environment demo: per-tenant config + secrets, read from server code with no
 * import (`Environment` is a server global).
 *
 * Values come from out-of-band dotenv files the edge loads lazily and never
 * bundles into the `.wasm`: plain vars from `<host>.env`, secrets from
 * `<host>.env.secrets`. In `toiljs dev` those are `.env` / `.env.secrets` at the
 * project root — copy `.env.example` / `.env.secrets.example` to see this populate.
 *
 *   Environment.get("KEY")        -> a plain var, or null
 *   Environment.getSecure("KEY")  -> a secret, or null   (a secret is NEVER
 *                                    returned by get(), the buckets are disjoint)
 *
 * Reserved `TOIL_*` keys (e.g. the `TOIL_EMAIL_*` mailer config) are host-only:
 * the edge reads them, but they are unreachable through get()/getSecure().
 */
@rest('env')
class EnvDemo {
    /** GET /env/show -> the public vars, plus WHETHER the demo secret is set.
     *  We return the secret's presence, not its value: getSecure() hands the guest
     *  the real secret, but a demo must never echo a secret back over the wire. */
    @get('/show')
    public show(_ctx: RouteContext): Response {
        let greeting = '(unset)';
        const g = Environment.get('PUBLIC_GREETING');
        if (g != null) greeting = g;

        let region = '(unset)';
        const r = Environment.get('REGION');
        if (r != null) region = r;

        const apiKeySet = Environment.getSecure('DEMO_API_KEY') != null;

        const body =
            'PUBLIC_GREETING=' +
            greeting +
            '\n' +
            'REGION=' +
            region +
            '\n' +
            'DEMO_API_KEY set=' +
            (apiKeySet ? 'yes' : 'no') +
            '\n';
        return Response.text(body, 200);
    }
}
