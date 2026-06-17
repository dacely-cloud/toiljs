import { ristretto255_oprf } from '@noble/curves/ed25519.js';
import { ml_dsa44 } from '@dacely/noble-post-quantum/ml-dsa.js';
import { argon2id } from 'hash-wasm';

const oprf = ristretto255_oprf.oprf;
const enc = (s) => new TextEncoder().encode(s);
const u32 = (n) => { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, n, true); return b; };
const lp = (b) => { const o = new Uint8Array(4 + b.length); o.set(u32(b.length)); o.set(b, 4); return o; };
const cat = (...a) => { const o = new Uint8Array(a.reduce((s, x) => s + x.length, 0)); let p = 0; for (const x of a) { o.set(x, p); p += x.length; } return o; };

class R { constructor(b){ this.b=b; this.p=0; this.v=new DataView(b.buffer,b.byteOffset,b.byteLength);} u8(){return this.b[this.p++];} u32(){const x=this.v.getUint32(this.p,true);this.p+=4;return x;} bytes(){const n=this.u32();const x=this.b.slice(this.p,this.p+n);this.p+=n;return x;} }

async function register(username) {
  const pw = enc('correct horse battery staple');
  const { blind, blinded } = oprf.blind(pw);
  const start = await fetch('http://localhost:3000/auth/register/start', { method:'POST', headers:{'content-type':'application/octet-stream'}, body: cat(lp(enc(username)), lp(blinded)) });
  const sb = new Uint8Array(await start.arrayBuffer());
  if (!start.ok) return `start HTTP ${start.status}: ${Buffer.from(sb).toString('utf8').trim()}`;
  const r = new R(sb);
  const status = r.u8(); const mem = r.u32(); const iters = r.u32(); const par = r.u32();
  const salt = r.bytes(); const evaluated = r.bytes();
  const oprfOut = oprf.finalize(pw, blind, evaluated);
  const seed = await argon2id({ password: oprfOut, salt, iterations: iters, parallelism: par, memorySize: mem, hashLength: 32, outputType: 'binary' });
  const kp = ml_dsa44.keygen(seed);
  const regMsg = cat(new Uint8Array([1]), lp(enc(username)), lp(kp.publicKey));
  const proof = ml_dsa44.sign(regMsg, kp.secretKey, { context: enc('qauth:register:v1') });
  const fin = await fetch('http://localhost:3000/auth/register/finish', { method:'POST', headers:{'content-type':'application/octet-stream'}, body: cat(lp(enc(username)), lp(kp.publicKey), lp(proof)) });
  const fb = new Uint8Array(await fin.arrayBuffer());
  if (!fin.ok) return `finish HTTP ${fin.status}: "${Buffer.from(fb).toString('utf8').trim()}"`;
  return `finish HTTP ${fin.status}, status byte = ${fb[0]} (0 = ok)`;
}

const user = 'fresh_' + Math.floor(Math.random() * 1e6);
console.log('1st register of', user, '->', await register(user));
console.log('2nd register of', user, '->', await register(user));
