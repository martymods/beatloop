import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import dns from 'dns/promises';

const uploadsRoot = path.join(process.cwd(), 'uploads');
fs.mkdirSync(uploadsRoot, { recursive: true });

const {
  S3_BUCKET = '',
  S3_REGION = '',
  S3_ENDPOINT = '',
  S3_FORCE_PATH_STYLE = '',
  S3_PUBLIC_BASE_URL = ''
} = process.env;

const AWS_ACCESS_KEY_ID = process.env.AWS_ACCESS_KEY_ID || process.env.S3_ACCESS_KEY_ID || '';
const AWS_SECRET_ACCESS_KEY =
  process.env.AWS_SECRET_ACCESS_KEY || process.env.S3_SECRET_ACCESS_KEY || '';
const AWS_SESSION_TOKEN = process.env.AWS_SESSION_TOKEN || process.env.S3_SESSION_TOKEN || '';

const s3Configured = Boolean(S3_BUCKET && S3_REGION);
const s3HasCredentials = Boolean(AWS_ACCESS_KEY_ID && AWS_SECRET_ACCESS_KEY);
const s3Enabled = s3Configured && s3HasCredentials;

if (s3Configured && !s3HasCredentials) {
  console.warn('⚠️  S3 credentials not provided. Falling back to local uploads storage.');
}

const FORCE_PATH_STYLE = /^true$/i.test(S3_FORCE_PATH_STYLE || '');

let S3_PUBLIC_BASE = '';
let S3_PUBLIC_BASE_HOST = '';
let S3_PUBLIC_BASE_RESOLVES = true;

const rawS3PublicBase = (S3_PUBLIC_BASE_URL || '').trim();
if (rawS3PublicBase) {
  try {
    const candidate = rawS3PublicBase.includes('://')
      ? rawS3PublicBase
      : `https://${rawS3PublicBase}`;
    const parsed = new URL(candidate);
    const pathPart = parsed.pathname && parsed.pathname !== '/'
      ? parsed.pathname.replace(/\/+$/, '')
      : '';
    S3_PUBLIC_BASE = `${parsed.protocol}//${parsed.host}${pathPart}`.replace(/\/+$/, '');
    S3_PUBLIC_BASE_HOST = (parsed.hostname || '').toLowerCase();
  } catch (error) {
    console.warn('⚠️  Invalid S3_PUBLIC_BASE_URL; falling back to local uploads base.', error);
    S3_PUBLIC_BASE = '';
    S3_PUBLIC_BASE_HOST = '';
  }
}

if (S3_PUBLIC_BASE && S3_PUBLIC_BASE_HOST) {
  try {
    await dns.lookup(S3_PUBLIC_BASE_HOST);
  } catch (error) {
    console.warn(
      `⚠️  S3_PUBLIC_BASE_URL host failed DNS lookup: ${S3_PUBLIC_BASE_HOST}. Falling back to local uploads base.`
    );
    S3_PUBLIC_BASE_RESOLVES = false;
  }
}

const s3PublicUrlAvailable = Boolean(S3_PUBLIC_BASE && S3_PUBLIC_BASE_RESOLVES);

if (s3Enabled && !s3PublicUrlAvailable) {
  console.warn(
    '⚠️  S3 uploads enabled but S3_PUBLIC_BASE_URL is missing or unreachable. Falling back to local storage.'
  );
}

let s3Client = null;
if (s3Enabled) {
  try {
    s3Client = createS3Client({
      bucket: S3_BUCKET,
      region: S3_REGION,
      endpoint: S3_ENDPOINT,
      forcePathStyle: FORCE_PATH_STYLE,
      credentials: {
        accessKeyId: AWS_ACCESS_KEY_ID,
        secretAccessKey: AWS_SECRET_ACCESS_KEY,
        sessionToken: AWS_SESSION_TOKEN
      }
    });
  } catch (error) {
    console.error('Failed to initialize S3 client:', error);
    s3Client = null;
  }
}

function normalizedKey(rawKey) {
  if (!rawKey) return '';
  return String(rawKey).replace(/^\/+/, '');
}

export function durableStorageEnabled() {
  return Boolean(s3Enabled && s3Client && s3PublicUrlAvailable);
}

export function getUploadsRoot() {
  return uploadsRoot;
}

export function localPathForKey(key) {
  return path.join(uploadsRoot, normalizedKey(key));
}

export function durablePublicUrlForKey(key) {
  if (!s3Enabled) return null;
  if (!key) return null;
  if (!S3_PUBLIC_BASE || !S3_PUBLIC_BASE_RESOLVES) return null;
  return `${S3_PUBLIC_BASE}/${normalizedKey(key)}`;
}

export async function writeStreamToUploads({ key, stream, contentType }) {
  if (!key) throw new Error('storage key required');
  if (!stream) throw new Error('storage stream required');
  const normalized = normalizedKey(key);
  const { buffer, size } = await streamToBuffer(stream);

  if (s3Enabled && s3Client && s3PublicUrlAvailable) {
    await s3Client.putObject({
      key: normalized,
      body: buffer,
      contentType: contentType || undefined
    });
    return { key: normalized, size };
  }

  const filePath = path.join(uploadsRoot, normalized);
  await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
  await fs.promises.writeFile(filePath, buffer);
  return { key: normalized, size, path: filePath };
}

export async function writeBufferToUploads({ key, buffer, contentType }) {
  const normalized = normalizedKey(key);
  if (!Buffer.isBuffer(buffer)) {
    buffer = Buffer.from(buffer);
  }

  if (s3Enabled && s3Client && s3PublicUrlAvailable) {
    await s3Client.putObject({
      key: normalized,
      body: buffer,
      contentType: contentType || undefined
    });
    return { key: normalized, size: buffer.length };
  }

  const filePath = path.join(uploadsRoot, normalized);
  await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
  await fs.promises.writeFile(filePath, buffer);
  return { key: normalized, size: buffer.length, path: filePath };
}

export async function deleteUploadKey(key) {
  if (!key) return;
  const normalized = normalizedKey(key);
  if (!normalized) return;

  if (s3Enabled && s3Client) {
    try {
      await s3Client.deleteObject(normalized);
    } catch {
      /* noop */
    }
    return;
  }

  const filePath = path.join(uploadsRoot, normalized);
  await fs.promises.unlink(filePath).catch(() => {});
}

export async function ensureKeyFromLocalFile({ key, filePath, contentType }) {
  const normalized = normalizedKey(key);
  const stream = fs.createReadStream(filePath);
  return writeStreamToUploads({ key: normalized, stream, contentType });
}

async function streamToBuffer(stream) {
  if (Buffer.isBuffer(stream)) {
    return { buffer: stream, size: stream.length };
  }

  const chunks = [];
  let size = 0;
  for await (const chunk of stream) {
    const bufferChunk = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    chunks.push(bufferChunk);
    size += bufferChunk.length;
  }

  return { buffer: Buffer.concat(chunks, size), size };
}

function createS3Client({ bucket, region, endpoint, forcePathStyle, credentials }) {
  const normalizedEndpoint = (endpoint || '').trim();
  const endpointUrl = normalizedEndpoint
    ? new URL(normalizedEndpoint.includes('://') ? normalizedEndpoint : `https://${normalizedEndpoint}`)
    : null;

  return {
    async putObject({ key, body, contentType }) {
      const payload = Buffer.isBuffer(body) ? body : Buffer.from(body || []);
      const url = buildS3Url({ bucket, region, endpointUrl, forcePathStyle, key });
      await sendSignedRequest({
        method: 'PUT',
        url,
        region,
        credentials,
        body: payload,
        contentType
      });
    },

    async deleteObject(key) {
      const url = buildS3Url({ bucket, region, endpointUrl, forcePathStyle, key });
      await sendSignedRequest({ method: 'DELETE', url, region, credentials, body: null });
    }
  };
}

function buildS3Url({ bucket, region, endpointUrl, forcePathStyle, key }) {
  const encodedKey = encodeS3Key(key);

  if (endpointUrl) {
    const url = new URL(endpointUrl.toString());
    if (forcePathStyle) {
      const trimmedPath = url.pathname ? url.pathname.replace(/\/+$/, '') : '';
      if (trimmedPath && trimmedPath.endsWith(`/${bucket}`)) {
        url.pathname = appendPath(trimmedPath, encodedKey);
      } else {
        url.pathname = appendPath(url.pathname, `${bucket}/${encodedKey}`);
      }
    } else {
      if (!url.hostname.startsWith(`${bucket}.`)) {
        url.hostname = `${bucket}.${url.hostname}`;
      }
      url.pathname = appendPath(url.pathname, encodedKey);
    }
    return url;
  }

  if (forcePathStyle) {
    return new URL(`https://s3.${region}.amazonaws.com/${bucket}/${encodedKey}`);
  }

  return new URL(`https://${bucket}.s3.${region}.amazonaws.com/${encodedKey}`);
}

function appendPath(basePath, suffix) {
  const base = basePath ? basePath.replace(/\/+$/, '') : '';
  const combined = `${base}/${suffix}`.replace(/\/{2,}/g, '/');
  return combined.startsWith('/') ? combined : `/${combined}`;
}

async function sendSignedRequest({ method, url, region, credentials, body, contentType }) {
  const upperMethod = method.toUpperCase();
  const payloadBuffer = body ? (Buffer.isBuffer(body) ? body : Buffer.from(body)) : Buffer.alloc(0);
  const payloadHash = hashSha256(payloadBuffer);

  const headers = {};
  if (contentType) {
    headers['content-type'] = contentType;
  }
  if (upperMethod === 'PUT') {
    headers['content-length'] = String(payloadBuffer.length);
  }

  const signedHeaders = signAwsRequest({
    method: upperMethod,
    url,
    headers,
    payloadHash,
    region,
    credentials
  });

  const response = await fetch(url, {
    method: upperMethod,
    headers: signedHeaders,
    body: upperMethod === 'PUT' ? payloadBuffer : undefined
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => '');
    throw new Error(
      `S3 ${upperMethod} ${url.pathname} failed: ${response.status} ${response.statusText}` +
        (errorText ? ` - ${errorText}` : '')
    );
  }
}

function signAwsRequest({ method, url, headers, payloadHash, region, credentials }) {
  const now = new Date();
  const amzDate = formatAmzDate(now);
  const dateStamp = amzDate.slice(0, 8);

  const canonicalHeadersMap = new Map();
  canonicalHeadersMap.set('host', url.host);
  canonicalHeadersMap.set('x-amz-date', amzDate);
  canonicalHeadersMap.set('x-amz-content-sha256', payloadHash);

  if (credentials.sessionToken) {
    canonicalHeadersMap.set('x-amz-security-token', credentials.sessionToken);
  }

  for (const [key, value] of Object.entries(headers || {})) {
    if (value === undefined || value === null) continue;
    canonicalHeadersMap.set(key.toLowerCase(), String(value));
  }

  const sortedHeaderEntries = Array.from(canonicalHeadersMap.entries()).sort((a, b) =>
    a[0].localeCompare(b[0])
  );

  const canonicalHeaders = sortedHeaderEntries
    .map(([key, value]) => `${key}:${value.trim().replace(/\s+/g, ' ')}`)
    .join('\n');
  const signedHeaders = sortedHeaderEntries.map(([key]) => key).join(';');

  const canonicalUri = buildCanonicalUri(url.pathname);
  const canonicalQuerystring = buildCanonicalQuery(url.searchParams);
  const canonicalRequest = [
    method,
    canonicalUri,
    canonicalQuerystring,
    canonicalHeaders + '\n',
    signedHeaders,
    payloadHash
  ].join('\n');

  const credentialScope = `${dateStamp}/${region}/s3/aws4_request`;
  const stringToSign = [
    'AWS4-HMAC-SHA256',
    amzDate,
    credentialScope,
    hashSha256(canonicalRequest)
  ].join('\n');

  const signingKey = getSignatureKey(credentials.secretAccessKey, dateStamp, region, 's3');
  const signature = hmacSha256(signingKey, stringToSign).toString('hex');

  const finalHeaders = {};
  for (const [key, value] of sortedHeaderEntries) {
    finalHeaders[key] = value;
  }

  finalHeaders.authorization =
    `AWS4-HMAC-SHA256 Credential=${credentials.accessKeyId}/${credentialScope}, ` +
    `SignedHeaders=${signedHeaders}, Signature=${signature}`;

  return finalHeaders;
}

function buildCanonicalUri(pathname) {
  if (!pathname || pathname === '/') return '/';
  const segments = pathname.split('/').map((segment) => encodeRfc3986(decodeURIComponent(segment)));
  if (segments[0] === '') {
    return '/' + segments.slice(1).join('/');
  }
  return '/' + segments.join('/');
}

function buildCanonicalQuery(searchParams) {
  if (!searchParams) return '';
  const pairs = Array.from(searchParams.entries()).map(([key, value]) => [
    encodeRfc3986(key),
    encodeRfc3986(value)
  ]);
  if (!pairs.length) return '';
  pairs.sort((a, b) => (a[0] === b[0] ? a[1].localeCompare(b[1]) : a[0].localeCompare(b[0])));
  return pairs.map(([key, value]) => `${key}=${value}`).join('&');
}

function encodeS3Key(key) {
  return key
    .split('/')
    .map((part) => encodeRfc3986(part))
    .join('/');
}

function encodeRfc3986(value) {
  return encodeURIComponent(value).replace(/[!'()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
}

function formatAmzDate(date) {
  const pad = (num) => String(num).padStart(2, '0');
  return (
    date.getUTCFullYear().toString() +
    pad(date.getUTCMonth() + 1) +
    pad(date.getUTCDate()) +
    'T' +
    pad(date.getUTCHours()) +
    pad(date.getUTCMinutes()) +
    pad(date.getUTCSeconds()) +
    'Z'
  );
}

function hashSha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function hmacSha256(key, data) {
  return crypto.createHmac('sha256', key).update(data).digest();
}

function getSignatureKey(secretAccessKey, dateStamp, regionName, serviceName) {
  const kDate = hmacSha256(`AWS4${secretAccessKey}`, dateStamp);
  const kRegion = hmacSha256(kDate, regionName);
  const kService = hmacSha256(kRegion, serviceName);
  return hmacSha256(kService, 'aws4_request');
}
