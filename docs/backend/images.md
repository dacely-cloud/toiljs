# Server images

`Images` processes uploaded JPEG, PNG, and still WebP bytes in an Action, Job,
or Derive. It applies EXIF orientation before resizing, then removes EXIF,
XMP, IPTC, text, and comments. ICC profiles and PNG color descriptors remain
so stripping metadata does not silently change the intended color space.

```ts
const photo = Images.resize(request.body, 1600, 1600);
if (!photo.ok) return Response.text('Image rejected', 422);
return Response.bytes(photo.bytes, 200, photo.contentType);
```

`Images.stripExif(bytes, quality = 90)` retains the oriented dimensions.
`Images.resize(bytes, width, height, quality = 90)` fits inside a box while
preserving aspect ratio. `Images.thumbnail(bytes, width, height, quality = 90)`
center crops to that aspect ratio. Both avoid enlargement; a small thumbnail
can therefore be smaller than the requested dimensions. All return an
`ImageResult` with `ok`, `error`, `bytes`, `width`, `height`, `format`, and
`contentType`. JPEG input produces a newly encoded JPEG; PNG and WebP produce
an 8-bit PNG, preserving alpha. Quality is 1–100 and affects JPEG encoding.

Animated images and other formats are rejected. Inputs and outputs are limited
to 8 MiB, input dimensions to 8192 per side and 16 Mi pixels, and target
dimensions to 4096 per side. Each dispatch allows one processing attempt.
Queries cannot process images. Check `error` for `Invalid`, `Unsupported`,
`Limit`, `Busy`, `Timeout`, `Unavailable`, `Options`, `Kind`, or `Quota`.
An error has no output bytes. Processing consumes host gas for input copying,
source pixels, and output copying, independently of database budgets.

Dev runs the shared Rust codec as WASI in a disposable Node child process,
with a 768 MiB WebAssembly memory maximum and a five-second wall deadline.
The checked-in codec asset includes build hashes and dependency licenses in
`assets/`; maintainers rebuild it with `node scripts/build-image-codec.mjs`
from a sibling `toil-backend` checkout and the `wasm32-wasip1` Rust target.

Native deployments must build and install `toil-image-worker` beside `toil`,
or set `TOIL_IMAGE_WORKER_BIN` to its absolute path. The install script builds
both binaries. Each operation starts a disposable worker with a 768 MiB address
space limit, a two-second CPU limit (three-second hard limit), and a five-second
host deadline. The host admits at most two concurrent workers without queuing
input buffers. Operators may set `TOIL_IMAGE_MAX_CONCURRENT` (1–32) and
`TOIL_IMAGE_PIXELS_PER_MINUTE` (default 256 Mi pixels per tenant host, per
backend process). Busy workers and exhausted quotas return explicit errors.
These limits apply separately on each backend process.
The tenant's memory, request-body, response-size, and gas limits also apply;
worker limits do not raise those limits.

Use [Blobs](../database/blobs.md) for direct streaming storage of large originals.
`Images` accepts bounded bytes and returns bounded bytes; it does not fetch an
arbitrary URL or automatically resize `Toil.Image` URLs.
