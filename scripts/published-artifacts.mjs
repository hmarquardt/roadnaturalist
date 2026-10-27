// Verify a catalog's artifact plane where it actually lives: the data origin.
//
// The regional partitions and the derived corridor-metrics cells are on `data.roadnaturalist.com`, not in the Pages
// payload and not in Git (`*.parquet` is ignored), so a clean checkout has no local copy to hash. A release from
// such a checkout must not silently skip the gate, and must not pretend a local byte check happened: this module
// walks the same object set the publisher and the auditor use (`regional-objects.mjs`), proves every declared
// object is online with the declared byte length and content type, and re-fetches a bounded digest sample so a
// same-length corruption does not pass unnoticed. Byte-for-byte verification of the whole plane stays the job of
// `npm run audit:regional:remote`, which is a data-release gate rather than a deploy gate.
import { createHash } from 'node:crypto';
import { regionalObjectSet } from './regional-objects.mjs';

const sha256 = buffer => createHash('sha256').update(buffer).digest('hex');

export async function verifyPublishedArtifacts(catalog, { concurrency = 8, digestSample = 4, timeoutMs = 30000 } = {}) {
  const objects = regionalObjectSet(catalog);
  const problems = [];
  let checked = 0;
  const queue = [...objects];

  const worker = async () => {
    while (queue.length) {
      const object = queue.shift();
      let response;
      try {
        response = await fetch(new URL(object.key, catalog.assetBaseUrl), { method: 'HEAD',
          // Cloudflare compresses JSON on the fly and then omits content-length on a HEAD response, which would read
          // as a zero-length object; asking for the identity encoding keeps the declared length of the object itself.
          headers: { 'accept-encoding': 'identity' }, signal: AbortSignal.timeout(timeoutMs) });
      } catch (error) { problems.push(`${object.key}: unreachable (${error.message})`); continue; }
      if (response.status !== 200) { problems.push(`${object.key}: HTTP ${response.status}`); continue; }
      const length = Number(response.headers.get('content-length'));
      if (length !== object.bytes) {
        problems.push(`${object.key}: published length ${length}, catalog declares ${object.bytes}`);
        continue;
      }
      const type = (response.headers.get('content-type') ?? '').split(';')[0].trim();
      if (type !== object.type) { problems.push(`${object.key}: published content-type ${type}, expected ${object.type}`); continue; }
      checked += 1;
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, objects.length) }, worker));

  // The digest sample is the cheapest evidence that length alone is not being trusted: the smallest objects on the
  // plane, chosen deterministically, are read in full and hashed against the catalog.
  const sample = [...objects].sort((left, right) => left.bytes - right.bytes).slice(0, digestSample);
  for (const object of sample) {
    let response;
    try {
      response = await fetch(new URL(object.key, catalog.assetBaseUrl),
        { headers: { 'accept-encoding': 'identity' }, signal: AbortSignal.timeout(timeoutMs) });
    } catch (error) { problems.push(`${object.key}: unreachable for the digest sample (${error.message})`); continue; }
    if (response.status !== 200) { problems.push(`${object.key}: HTTP ${response.status} for the digest sample`); continue; }
    const body = Buffer.from(await response.arrayBuffer());
    if (body.length !== object.bytes || sha256(body) !== object.sha256) {
      problems.push(`${object.key}: digest sample does not match the catalog`);
    }
  }
  return { problems, checked, sampled: sample.length, total: objects.length };
}
