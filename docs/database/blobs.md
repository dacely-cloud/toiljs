# Blobs

`Blobs<K>` stores files under typed `@data` keys. Clients stream uploads and
downloads directly to storage, including HTTP byte ranges. The framework creates
signed upload tickets and URLs; your routes decide who may receive them.

Production uses a bucket endpoint that supports **S3 Signature V4 POST policies**
and signed GET/HEAD/DELETE URLs. `toiljs dev` supplies a loopback disk adapter and
persists files under `.toil/blobs/` when remote storage is unconfigured. File
bytes have separate storage and transfer costs from ToilDB records.

## Server

Import the API from `toiljs/server/runtime`:

```ts
import { Blobs, Response } from 'toiljs/server/runtime';

@data
class PhotoId {
  id: string = '';
  constructor(id: string = '') { this.id = id; }
}

const photos = new Blobs<PhotoId>('photos');
```

After checking the caller's permission for a photo, issue its upload ticket:

```ts
const ticket = photos.upload(new PhotoId('photo-123'), fileSize, 'image/jpeg');
return Response.data(ticket, 201);
```

The ticket fixes the **exact byte length**, object key, content type, disposition,
and expiration. Uploads accept 0–1 GiB. Their default lifetime is five minutes;
all `Blobs` ticket/URL lifetimes accept 1–900 seconds. Namespace names contain
1–64 letters, digits, underscores or hyphens. Encoded keys are limited to 4096 bytes and hashed into opaque
object names; the same namespace and key address the same object. Include the
owner in the key when files belong to different users.

Issue a URL after checking read access:

```ts
const url = photos.downloadUrl(new PhotoId('photo-123')); // defaults to 60 seconds
const head = photos.headUrl(new PhotoId('photo-123'));
const remove = photos.deleteUrl(new PhotoId('photo-123'));
```

The URL authorizes its specific HTTP method. GET URLs permit byte-range reads of
the authorized object. HEAD returns metadata; DELETE removes the object. URLs and
upload tickets are bearer credentials and can be reused until they expire; store
file keys in application data and issue fresh URLs when needed. Account/session
revocation does not invalidate an already issued storage URL. Uploads replace
existing objects after the complete transfer succeeds. An interrupted upload
preserves the previous object. A lost success response can leave the caller
uncertain; retrying the same key replaces that object again. Database updates and
file transfers have independent commits.

`BlobStorage` also accepts explicit server-only endpoint/credential configuration
for applications with multiple buckets. Its lower-level `presign` method supports
the S3 protocol's seven-day maximum; the `Blobs` convenience API caps lifetimes at
15 minutes. A configured `Blobs` instance caches its storage credentials. Recreate
resident instances when rotating their configuration.

## Client

```ts
import { uploadBlob, readBlob } from 'toiljs/files';

// ticket is the JSON BlobUpload returned by an authorized application endpoint.
await uploadBlob(ticket, selectedFile);

const response = await readBlob(downloadUrl);
const stream = response.body; // ReadableStream<Uint8Array>

const range = await readBlob(downloadUrl, { start: 1024, end: 2047 });
// Range end is inclusive; a successful range response has status 206.
```

`uploadBlob` sends a File/Blob as multipart form data with the signed fields first
and the file last. `uploadBlobStream(ticket, readableStream, signal)` sends a
ReadableStream on platforms supporting streaming fetch request bodies; Node uses
`duplex: 'half'`. It checks the transferred length and cancels the source on
failure or abort. An optional AbortSignal is supported by every client helper.
`deleteBlob(deleteUrl)` sends the authorized DELETE. Native/mobile clients may use
the same ticket fields with their own multipart HTTP client.

Downloads preserve backpressure and do not buffer the response body. `readBlob`
rejects a range request if storage returns a full response instead of 206. The
dev adapter supports a single closed, open-ended or suffix byte range and returns
416 for unsatisfiable ranges. Its ETag-based If-Range handling falls back to a
full response when the object changed.

## Storage configuration

Configure these **plain environment variables** on the server:

```dotenv
BLOB_ENDPOINT=https://my-bucket.s3.us-east-1.amazonaws.com
BLOB_BUCKET=my-bucket
BLOB_REGION=us-east-1
BLOB_PREFIX=my-application
```

The endpoint includes the bucket. Path-style endpoints such as
`https://storage.example/my-bucket` work too. Prefixes may contain slash-separated
path segments. Put credentials in **secrets**, such as `.env.secrets` in dev:

```dotenv
BLOB_ACCESS_KEY_ID=...
BLOB_SECRET_ACCESS_KEY=...
# Optional, for temporary credentials:
BLOB_SESSION_TOKEN=...
```

Use credentials restricted to the application's bucket/prefix. Configure bucket
CORS for your application origin, POST/GET/HEAD/DELETE, request headers
`Content-Type`, `Range`, `If-Range`, `If-Match`, and exposed headers `ETag`,
`Content-Length`, `Content-Range`, `Content-Type`, `Accept-Ranges`. Keep credentials
on the server. The uploaded content disposition defaults to attachment; validate
file content separately when serving user uploads as images or other formats.

Allow the storage origin in the application's browser policy as well as bucket
CORS. For example, in `toil.config.ts`:

```ts
export default defineConfig({
  client: {
    cspSources: {
      'connect-src': ['https://my-bucket.s3.us-east-1.amazonaws.com'],
      'img-src': ['https://my-bucket.s3.us-east-1.amazonaws.com'],
    },
  },
});
```

Import `defineConfig` from `toiljs/compiler`. `connect-src` permits the fetch
helpers; `img-src` permits displaying images directly from storage. Add the
origin to `media-src` when playing stored audio or video. For the loopback disk
adapter, add `http://127.0.0.1:*` to the needed directives in your development
configuration because its port changes on restart. See
[browser security configuration](../concepts/security.md#allowing-additional-resources).

The disk adapter is development-only and binds to 127.0.0.1 on an ephemeral port.
Its credentials are random per start and remain in the secrets bucket; restarting
preserves objects and requires fresh URLs. Remote clients need a configured HTTPS
storage endpoint. A partial remote configuration is an error and does not switch
to disk storage. Disk uploads use bounded streams and atomic manifest replacement;
process crashes can leave unused temporary/body files in the dev directory.

The implementation is checked against the [AWS query-signature test vector](https://docs.aws.amazon.com/AmazonS3/latest/developerguide/sigv4-query-string-auth.html)
and follows the [S3 POST policy format](https://docs.aws.amazon.com/AmazonS3/latest/developerguide/sigv4-HTTPPOSTConstructPolicy.html).
Storage providers must implement these operations; compatibility varies among
services exposing an S3 API. Live AWS credentials are not required for local dev.
