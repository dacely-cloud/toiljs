// End-to-end check of the @user / @auth / session surface against the compiled
// server wasm via the dev-mode dispatcher (one fresh instance per request).
//
//   1. POST /session/dev-login(root)   -> 200, sets __Host-toil_sess + __Secure-toil_user
//   2. GET  /session/me  (with session) -> 200, returns the typed user (root, admin, 0)
//   3. GET  /session/me  (no cookie)    -> 401 (the @auth guard)
//   4. GET  /session/me  (tampered)     -> 401 (HMAC verify fails)
//   5. companion cookie decodes to the same user (mirrors the client getUser())
//
// Run: node e2e_session.mjs

import { WasmServerModule } from 'toiljs/devserver';
import { DataWriter, DataReader } from 'toiljs/io';

const wasm = new WasmServerModule(new URL('./build/server/release.wasm', import.meta.url).pathname);
wasm.refresh();
if (!wasm.available) throw new Error('release.wasm not loaded; run the server build first');

const dispatch = (method, path, headers = [], body = new Uint8Array(0)) =>
    wasm.dispatch({ method, path, headers, body });

const setCookies = (res) => res.headers.filter(([n]) => n.toLowerCase() === 'set-cookie').map(([, v]) => v);
const cookiePair = (setCookieLine) => setCookieLine.split(';', 1)[0]; // name=value

let failures = 0;
const check = (label, cond) => {
    console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}`);
    if (!cond) failures++;
};

// 1. dev-login -------------------------------------------------------------
const loginBody = new DataWriter().writeString('root').toBytes();
const login = dispatch('POST', '/session/dev-login', [], loginBody);
check('dev-login status 200', login.status === 200);

const cookies = setCookies(login).map(cookiePair);
const sessionCookie = cookies.find((c) => c.startsWith('__Host-toil_sess='));
const userCookie = cookies.find((c) => c.startsWith('__Secure-toil_user='));
check('session cookie set (__Host-toil_sess)', !!sessionCookie);
check('companion cookie set (__Secure-toil_user)', !!userCookie);

// 2. /me with the session cookie -> typed user ------------------------------
const me = dispatch('GET', '/session/me', [['cookie', sessionCookie]]);
check('/me with session -> 200', me.status === 200);
if (me.status === 200) {
    const r = new DataReader(me.body);
    const username = r.readString();
    const admin = r.readU8() !== 0;
    const score = r.readU64();
    check('/me user.username == "root"', username === 'root');
    check('/me user.admin == true', admin === true);
    check('/me user.score == 0n', score === 0n);
}

// 3. /me with no cookie -> 401 ---------------------------------------------
const meAnon = dispatch('GET', '/session/me', []);
check('/me without session -> 401', meAnon.status === 401);

// 4. /me with a tampered session cookie -> 401 ------------------------------
const tampered = sessionCookie.slice(0, -2) + (sessionCookie.endsWith('AA') ? 'BB' : 'AA');
const meTampered = dispatch('GET', '/session/me', [['cookie', tampered]]);
check('/me with tampered session -> 401', meTampered.status === 401);

// 5. companion cookie decodes to the user (mirrors client getUser) ----------
const b64url = userCookie.slice('__Secure-toil_user='.length);
const bin = Buffer.from(b64url.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
const ur = new DataReader(new Uint8Array(bin));
ur.readU32(); // dataId prefix (Account codec)
const cu = ur.readString();
check('companion cookie user == "root"', cu === 'root');

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
