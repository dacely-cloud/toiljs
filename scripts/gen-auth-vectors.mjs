// Reproducible protocol vectors for ports of the native/mobile client.
// These fixed seeds and expanded keys are public TEST material only.
import { createHash, createHmac } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { ristretto255_oprf } from '@noble/curves/ed25519.js';
import { ml_dsa44 } from '@dacely/noble-post-quantum/ml-dsa.js';
import { ml_kem768 } from '@dacely/noble-post-quantum/ml-kem.js';
import { argon2id } from 'hash-wasm';
import { DataWriter } from '../build/io/codec.js';
import {
    buildLoginMessage,
    buildRegisterMessage,
    LOGIN_CONTEXT,
    REGISTER_CONTEXT,
    SESSION_KEY_LABEL,
    SERVER_CONFIRM_LABEL,
} from '../build/client/auth.js';
const utf8 = (value) => new TextEncoder().encode(value);
const hex = (value) => Buffer.from(value).toString('hex');
const sequence = (length, start = 0) => Uint8Array.from({ length }, (_, i) => (i + start) & 255);
const sha256 = (bytes) => createHash('sha256').update(bytes).digest();
const hmac = (key, bytes) => createHmac('sha256', key).update(bytes).digest();
const username = 'vector-user',
    email = 'vector@example.com',
    domain = 'vectors.toil.example';
const password = 'PaKsswörd-12!';
const passwordBytes = utf8(password.normalize('NFKC'));
const oprf = ristretto255_oprf.oprf;
const oprfSeed = new Uint8Array(32).fill(0xa3);
const { blind, blinded } = oprf.blind(passwordBytes, (length) => new Uint8Array(length).fill(0x5a));
const serverOprf = oprf.deriveKeyPair(oprfSeed, utf8(username));
const evaluated = oprf.blindEvaluate(serverOprf.secretKey, blinded);
const oprfOutput = oprf.finalize(passwordBytes, blind, evaluated);
const salt = sequence(16, 0x20),
    memKiB = 32768,
    iterations = 2,
    parallelism = 1;
const signingSeed = await argon2id({
    password: oprfOutput,
    salt,
    memorySize: memKiB,
    iterations,
    parallelism,
    hashLength: 32,
    outputType: 'binary',
});
const signing = ml_dsa44.keygen(signingSeed);
const registerMessage = buildRegisterMessage(username, signing.publicKey);
const registerSignature = ml_dsa44.sign(registerMessage, signing.secretKey, {
    context: utf8(REGISTER_CONTEXT),
    extraEntropy: false,
});
const kemSeed = sequence(64, 0x60),
    encapsulationSeed = new Uint8Array(32).fill(0x77);
const kem = ml_kem768.keygen(kemSeed);
const { cipherText, sharedSecret } = ml_kem768.encapsulate(kem.publicKey, encapsulationSeed);
const serverKemKeyId = sha256(kem.publicKey);
const cid = sequence(32, 0x10),
    nonce = sequence(32, 0x40),
    iat = 1700000000n,
    exp = iat + 120n;
const message = buildLoginMessage(
    username,
    domain,
    cid,
    nonce,
    iat,
    exp,
    cipherText,
    memKiB,
    iterations,
    parallelism,
    serverKemKeyId,
);
const loginSignature = ml_dsa44.sign(message, signing.secretKey, {
    context: utf8(LOGIN_CONTEXT),
    extraEntropy: false,
});
const transcriptHash = sha256(message);
const sessionKey = hmac(sharedSecret, Buffer.concat([utf8(SESSION_KEY_LABEL), transcriptHash]));
const serverConfirm = hmac(sessionKey, Buffer.concat([utf8(SERVER_CONFIRM_LABEL), transcriptHash]));
const idPreimage = new DataWriter()
    .writeBytes(utf8('toil.userid.v1'))
    .writeBytes(signing.publicKey)
    .writeBytes(utf8(username))
    .writeBytes(utf8(domain))
    .toBytes();
const vector = {
    format: 'toil-auth-protocol-v1',
    description: 'PUBLIC TEST SEEDS AND KEYS. Never use in a deployment.',
    username,
    email,
    domain,
    password,
    passwordNfkcUtf8: hex(passwordBytes),
    memKiB,
    iterations,
    parallelism,
    salt: hex(salt),
    oprfSeed: hex(oprfSeed),
    blind: hex(blind),
    blinded: hex(blinded),
    evaluated: hex(evaluated),
    oprfOutput: hex(oprfOutput),
    signingSeed: hex(signingSeed),
    mldsaPublicKey: hex(signing.publicKey),
    registerContext: REGISTER_CONTEXT,
    registerMessage: hex(registerMessage),
    registerSignature: hex(registerSignature),
    kemSeed: hex(kemSeed),
    encapsulationSeed: hex(encapsulationSeed),
    kemPublicKey: hex(kem.publicKey),
    kemSecretKey: hex(kem.secretKey),
    ciphertext: hex(cipherText),
    sharedSecret: hex(sharedSecret),
    serverKemKeyId: hex(serverKemKeyId),
    cid: hex(cid),
    nonce: hex(nonce),
    iat: iat.toString(),
    exp: exp.toString(),
    loginContext: LOGIN_CONTEXT,
    loginMessage: hex(message),
    loginSignature: hex(loginSignature),
    transcriptHash: hex(transcriptHash),
    sessionKey: hex(sessionKey),
    serverConfirm: hex(serverConfirm),
    initialUserId: hex(sha256(idPreimage)),
};
writeFileSync(
    new URL('../docs/auth/vectors-v1.json', import.meta.url),
    JSON.stringify(vector, null, 2) + '\n',
);
