import fs from 'fs';
import path from 'path';
import { PassThrough, Readable } from 'stream';
import { pipeline } from 'stream/promises';
import { S3Client, PutObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';

const uploadsRoot = path.join(process.cwd(), 'uploads');
fs.mkdirSync(uploadsRoot, { recursive: true });

const {
  S3_BUCKET = '',
  S3_REGION = '',
  S3_ENDPOINT = '',
  S3_FORCE_PATH_STYLE = '',
  S3_PUBLIC_BASE_URL = ''
} = process.env;

const s3Enabled = Boolean(S3_BUCKET && S3_REGION);

let s3Client = null;
if (s3Enabled) {
  s3Client = new S3Client({
    region: S3_REGION,
    endpoint: S3_ENDPOINT || undefined,
    forcePathStyle: /^true$/i.test(S3_FORCE_PATH_STYLE || '') || undefined
  });
}

function normalizedKey(rawKey) {
  if (!rawKey) return '';
  return String(rawKey).replace(/^\/+/, '');
}

export function durableStorageEnabled() {
  return s3Enabled;
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
  const trimmedBase = (S3_PUBLIC_BASE_URL || '').trim();
  if (!trimmedBase) return null;
  const base = trimmedBase.includes('://') ? trimmedBase : `https://${trimmedBase}`;
  return `${base.replace(/\/+$/, '')}/${normalizedKey(key)}`;
}

function createCountingStream() {
  const counter = new PassThrough();
  let size = 0;
  counter.on('data', (chunk) => {
    size += chunk.length;
  });
  counter.getSize = () => size;
  return counter;
}

export async function writeStreamToUploads({ key, stream, contentType }) {
  if (!key) throw new Error('storage key required');
  if (!stream) throw new Error('storage stream required');
  const normalized = normalizedKey(key);
  const counter = createCountingStream();

  if (s3Enabled && s3Client) {
    const uploadStream = new PassThrough();
    const uploadPromise = s3Client.send(new PutObjectCommand({
      Bucket: S3_BUCKET,
      Key: normalized,
      Body: uploadStream,
      ContentType: contentType || undefined
    }));
    await pipeline(stream, counter, uploadStream);
    await uploadPromise;
    return { key: normalized, size: counter.getSize() };
  }

  const filePath = path.join(uploadsRoot, normalized);
  await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
  const fileStream = fs.createWriteStream(filePath);
  await pipeline(stream, counter, fileStream);
  return { key: normalized, size: counter.getSize(), path: filePath };
}

export async function writeBufferToUploads({ key, buffer, contentType }) {
  const readable = Readable.from(buffer);
  return writeStreamToUploads({ key, stream: readable, contentType });
}

export async function deleteUploadKey(key) {
  if (!key) return;
  const normalized = normalizedKey(key);
  if (!normalized) return;

  if (s3Enabled && s3Client) {
    try {
      await s3Client.send(new DeleteObjectCommand({ Bucket: S3_BUCKET, Key: normalized }));
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
