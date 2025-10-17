import 'dotenv/config';
import mongoose from 'mongoose';

const {
  MONGODB_URI,
  PUBLIC_BASE_URL,
  API_ACTIVE_BASE_URL,
  API_FALLBACK_BASE_URLS = 'https://beatloop-api.onrender.com',
  RENDER_EXTERNAL_URL
} = process.env;

if (!MONGODB_URI) {
  console.error('❌  MONGODB_URI is required for the migration script.');
  process.exit(1);
}

const LOCALHOST_RE = /^https?:\/\/(?:localhost|127(?:\.\d+){3})(?::\d+)?$/i;
const LEGACY_ORIGIN = 'https://api.beatloop.co';

function ensureHttpsForBeatloopHost(urlString) {
  if (!urlString || typeof urlString !== 'string') return urlString;
  if (!/^https?:\/\//i.test(urlString)) return urlString;
  try {
    const parsed = new URL(urlString);
    const hostname = (parsed.hostname || '').toLowerCase();
    if (!hostname.endsWith('beatloop.co') && hostname !== 'beatloop.co' && hostname !== 'www.beatloop.co') {
      return urlString;
    }
    if (parsed.protocol === 'https:') return urlString.replace(/\/+$/, '');
    const pathname = parsed.pathname && parsed.pathname !== '/' ? parsed.pathname : '';
    const rebuilt = `https://${parsed.host}${pathname}${parsed.search || ''}${parsed.hash || ''}`;
    return rebuilt.replace(/\/+$/, '');
  } catch {
    if (/^http:\/\/(?:[\w-]+\.)*beatloop\.co(?::\d+)?/i.test(urlString)) {
      return urlString.replace(/^http:/i, 'https:').replace(/\/+$/, '');
    }
    return urlString;
  }
}

function sanitizeBaseCandidate(value) {
  if (!value || typeof value !== 'string') return '';
  const trimmed = value.trim();
  if (!trimmed) return '';
  try {
    const parsed = new URL(ensureHttpsForBeatloopHost(trimmed));
    const pathname = parsed.pathname && parsed.pathname !== '/' ? parsed.pathname : '';
    return `${parsed.protocol}//${parsed.host}${pathname}`.replace(/\/+$/, '');
  } catch {
    return '';
  }
}

function pickActiveBase() {
  const candidates = new Set([
    API_ACTIVE_BASE_URL,
    PUBLIC_BASE_URL,
    RENDER_EXTERNAL_URL,
    ...API_FALLBACK_BASE_URLS.split(/[\s,]+/)
  ]);

  for (const candidate of candidates) {
    const sanitized = sanitizeBaseCandidate(candidate);
    if (!sanitized) continue;
    if (LOCALHOST_RE.test(sanitized)) continue;
    return sanitized;
  }

  throw new Error('Unable to determine an active API base URL for migration.');
}

function rewriteLegacyUrl(url, targetOrigin) {
  if (!url || typeof url !== 'string') return url;
  try {
    const parsed = new URL(url);
    if (parsed.origin !== LEGACY_ORIGIN) return url;
    return `${targetOrigin}${parsed.pathname}${parsed.search}${parsed.hash}`;
  } catch {
    return url;
  }
}

const TrackSchema = new mongoose.Schema(
  {
    audioUrl: String,
    coverUrl: String,
    updatedAt: { type: Date, default: Date.now }
  },
  { collection: 'tracks' }
);

const Track = mongoose.model('Track', TrackSchema);

async function run() {
  const targetOrigin = pickActiveBase();
  console.log(`➡️  Rewriting legacy media URLs to: ${targetOrigin}`);

  await mongoose.connect(MONGODB_URI, { dbName: 'beatloop' });

  const filter = {
    $or: [
      { audioUrl: { $regex: '^https://api\\.beatloop\\.co/' } },
      { coverUrl: { $regex: '^https://api\\.beatloop\\.co/' } }
    ]
  };

  const cursor = Track.find(filter).lean().cursor();
  let processed = 0;
  let modified = 0;

  for await (const track of cursor) {
    processed += 1;
    const updates = {};

    const updatedAudio = rewriteLegacyUrl(track.audioUrl, targetOrigin);
    if (updatedAudio !== track.audioUrl) {
      updates.audioUrl = updatedAudio;
    }

    const updatedCover = rewriteLegacyUrl(track.coverUrl, targetOrigin);
    if (updatedCover !== track.coverUrl) {
      updates.coverUrl = updatedCover;
    }

    if (Object.keys(updates).length > 0) {
      updates.updatedAt = new Date();
      await Track.updateOne({ _id: track._id }, { $set: updates });
      modified += 1;
    }
  }

  await mongoose.disconnect();
  console.log(`✅  Migration complete. Processed ${processed} tracks; updated ${modified}.`);
}

run().catch(err => {
  console.error('❌  Migration failed:', err);
  mongoose.disconnect().catch(() => {});
  process.exit(1);
});
