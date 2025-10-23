import 'dotenv/config';
import express from 'express';
import http from 'http';
import https from 'https';
import { Server as SocketIOServer } from 'socket.io';
import mongoose from 'mongoose';
import cors from 'cors';
import morgan from 'morgan';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import multer from 'multer';
import { parseBuffer } from 'music-metadata';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import { lookup as mimeLookup, extension as mimeExtension } from 'mime-types';
import dns from 'dns/promises';
import { Readable } from 'stream';
import zlib from 'zlib';
import {
  durablePublicUrlForKey,
  durableStorageEnabled,
  getDurablePublicBase,
  getUploadsRoot,
  uploadsStorageAvailable,
  uploadsUsingLocalFallback,
  writeBufferToUploads,
  deleteUploadKey,
  localPathForKey
} from './storage/uploads.js';

const REDIRECT_STATUS_CODES = new Set([301, 302, 303, 307, 308]);

class PolyfillHeaders {
  constructor(raw = {}) {
    this.map = new Map();
    Object.entries(raw).forEach(([key, value]) => {
      if (!key) return;
      const normalizedKey = String(key).toLowerCase();
      if (Array.isArray(value)) {
        this.map.set(normalizedKey, value.join(', '));
      } else if (typeof value === 'string') {
        this.map.set(normalizedKey, value);
      }
    });
  }

  get(name) {
    if (typeof name !== 'string') return null;
    return this.map.get(name.toLowerCase()) ?? null;
  }

  has(name) {
    if (typeof name !== 'string') return false;
    return this.map.has(name.toLowerCase());
  }
}

class PolyfillResponse {
  constructor(bodyBuffer, statusCode, headers, url) {
    this.url = url;
    this.status = statusCode;
    this.statusText = http.STATUS_CODES?.[statusCode] || '';
    this.ok = statusCode >= 200 && statusCode < 300;
    this.headers = new PolyfillHeaders(headers);
    this._buffer = bodyBuffer;
  }

  async arrayBuffer() {
    const view = this._buffer;
    return view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength);
  }

  async text() {
    return this._buffer.toString('utf8');
  }

  async json() {
    const raw = await this.text();
    return JSON.parse(raw);
  }
}

function decodeBody(buffer, encoding) {
  if (!encoding) return buffer;
  const normalized = String(encoding).toLowerCase();
  try {
    if (normalized === 'gzip' || normalized === 'x-gzip') {
      return zlib.gunzipSync(buffer);
    }
    if (normalized === 'deflate') {
      return zlib.inflateSync(buffer);
    }
    if (normalized === 'br') {
      return zlib.brotliDecompressSync(buffer);
    }
  } catch (error) {
    console.warn('Failed to decode response body', error);
  }
  return buffer;
}

function normalizeHeaders(initHeaders = {}) {
  const result = {};
  if (Array.isArray(initHeaders)) {
    initHeaders.forEach(([key, value]) => {
      if (!key) return;
      result[key] = value;
    });
    return result;
  }
  if (initHeaders instanceof Map) {
    initHeaders.forEach((value, key) => {
      if (!key) return;
      result[key] = value;
    });
    return result;
  }
  if (initHeaders && typeof initHeaders.forEach === 'function') {
    initHeaders.forEach((value, key) => {
      if (!key) return;
      result[key] = value;
    });
    return result;
  }
  if (typeof initHeaders === 'object' && initHeaders) {
    return { ...initHeaders };
  }
  return result;
}

function createAbortError() {
  const error = new Error('The operation was aborted');
  error.name = 'AbortError';
  return error;
}

function createPolyfillFetch(maxRedirects = 4) {
  const performRequest = async (input, init = {}, redirectCount = 0) => {
    const url = input instanceof URL ? input : new URL(String(input));
    const method = typeof init.method === 'string' ? init.method.toUpperCase() : 'GET';
    const headers = normalizeHeaders(init.headers);
    const body = init.body;
    const transport = url.protocol === 'https:' ? https : http;

    const options = {
      method,
      headers,
      hostname: url.hostname,
      port: url.port || (url.protocol === 'https:' ? 443 : 80),
      path: `${url.pathname || ''}${url.search || ''}` || '/',
    };

    return new Promise((resolve, reject) => {
      let settled = false;
      const request = transport.request(options, (response) => {
        const chunks = [];
        response.on('data', (chunk) => chunks.push(chunk));
        response.on('end', async () => {
          if (settled) return;
          settled = true;
          const statusCode = response.statusCode || 0;
          const location = response.headers?.location;
          if (
            location &&
            REDIRECT_STATUS_CODES.has(statusCode) &&
            redirectCount < maxRedirects
          ) {
            const nextUrl = new URL(location, url);
            const nextInit = { ...init };
            if (statusCode === 303 || (statusCode === 301 && method === 'POST')) {
              nextInit.method = 'GET';
              delete nextInit.body;
            }
            resolve(performRequest(nextUrl, nextInit, redirectCount + 1));
            return;
          }
          const buffer = Buffer.concat(chunks);
          const decoded = decodeBody(buffer, response.headers?.['content-encoding']);
          resolve(
            new PolyfillResponse(
              decoded,
              statusCode,
              response.headers || {},
              url.href
            )
          );
        });
      });

      request.on('error', (error) => {
        if (settled) return;
        settled = true;
        reject(error);
      });

      if (init.signal) {
        const { signal } = init;
        const abortHandler = () => {
          if (settled) return;
          settled = true;
          request.destroy(createAbortError());
          reject(createAbortError());
        };
        if (signal.aborted) {
          abortHandler();
          return;
        }
        signal.addEventListener('abort', abortHandler, { once: true });
        request.on('close', () => signal.removeEventListener('abort', abortHandler));
      }

      if (body instanceof Uint8Array || body instanceof ArrayBuffer) {
        request.end(Buffer.from(body));
      } else if (typeof body === 'string') {
        request.end(body);
      } else if (body) {
        if (typeof body.pipe === 'function') {
          body.pipe(request);
          return;
        }
        request.end(String(body));
      } else {
        request.end();
      }
    });
  };

  return (input, init) => performRequest(input, init);
}

const fetch = globalThis.fetch || createPolyfillFetch();

if (!globalThis.fetch) {
  globalThis.fetch = fetch;
}

/* ============================ ENV ============================ */
const {
  PORT = 10000,                              // Render uses this
  JWT_SECRET = 'dev_secret_change_me',
  MONGODB_URI,
  PUBLIC_BASE_URL = `http://localhost:${PORT}`,
  FRONTEND_ORIGINS = 'https://beatloop-eotg.onrender.com,https://www.beatloop.co,https://beatloop.co,http://localhost:8080',
  API_FALLBACK_BASE_URLS = 'https://beatloop-api.onrender.com',
  RENDER_EXTERNAL_URL,
  SOUNDCLOUD_CLIENT_ID = '',
  SOUNDCLOUD_CLIENT_SECRET = '',
  SOUNDCLOUD_REDIRECT_URI = '',
  SOUNDCLOUD_SUCCESS_REDIRECT = '',
  SOUNDCLOUD_FAILURE_REDIRECT = '',
  OPENAI_API_KEY = '',
  MEDIA_TMZ_FEED_URL = 'https://www.tmz.com/category/hip-hop/feed/',
  MEDIA_CACHE_TTL_MS = '600000'
} = process.env;

const RENDER_ENV_MARKERS = [
  'RENDER',
  'RENDER_EXTERNAL_URL',
  'RENDER_EXTERNAL_HOSTNAME',
  'RENDER_SERVICE_ID',
  'RENDER_INSTANCE_ID',
  'RENDER_REGION'
];

const RUNNING_IN_PRODUCTION = Boolean(
  process.env.NODE_ENV === 'production' ||
    RENDER_ENV_MARKERS.some((key) => Boolean(process.env[key]))
);
const DURABLE_UPLOADS_REQUIRED_MESSAGE =
  'Durable uploads storage is required in production. Configure S3_BUCKET, S3_REGION, S3_PUBLIC_BASE_URL and AWS credentials.';
const durableUploadsActive = durableStorageEnabled();
const uploadsAvailable = uploadsStorageAvailable();
const localUploadsFallbackActive = uploadsUsingLocalFallback();

if (RUNNING_IN_PRODUCTION && !uploadsAvailable) {
  throw new Error(DURABLE_UPLOADS_REQUIRED_MESSAGE);
}

if (!durableUploadsActive && localUploadsFallbackActive) {
  console.warn(
    '⚠️  Durable storage not configured; using local uploads directory. Uploaded files may be lost on redeploy.'
  );
}

if (!MONGODB_URI) {
  console.warn('⚠️  MONGODB_URI not set. Add it in .env / Render Environment.');
}

const MEDIA_CACHE_TTL = Number.isFinite(Number(MEDIA_CACHE_TTL_MS))
  ? Number(MEDIA_CACHE_TTL_MS)
  : 10 * 60 * 1000;
const MEDIA_SOURCE_NAME = 'TMZ Hip-Hop';
const MEDIA_STORAGE_PREFIX = 'media';
const MEDIA_SUMMARY_MODEL = 'gpt-4o-mini';
const tmzFeedCache = { at: 0, items: [] };

const SESSION_EMPTY_TTL_MS = 3 * 60 * 1000;
const SESSION_MAX_LIFETIME_MS = 12 * 60 * 60 * 1000; // 12-hour hard cutoff for stale sessions
const PLAYER_COLOR_PALETTE = [
  '#f97316',
  '#22d3ee',
  '#a855f7',
  '#facc15',
  '#34d399',
  '#fb7185',
  '#60a5fa',
  '#f472b6',
  '#4ade80',
  '#fbbf24'
];
const PROFILE_COLOR_DEFAULT = '#7c3aed';
const LEADERBOARD_THRESHOLDS = Object.freeze({ likes: 12, reposts: 4 });
const LEADERBOARD_WEIGHTS = Object.freeze({ plays: 15, comments: 9, likes: 2, reposts: 3 });

function parseProfileColor(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const hex = trimmed.startsWith('#') ? trimmed.slice(1) : trimmed;
  if (/^[0-9a-fA-F]{6}$/.test(hex)) return `#${hex.toLowerCase()}`;
  if (/^[0-9a-fA-F]{3}$/.test(hex)) {
    return `#${hex.toLowerCase().split('').map((ch) => ch + ch).join('')}`;
  }
  return null;
}

function resolveProfileColor(value, fallback = PROFILE_COLOR_DEFAULT) {
  const normalized = parseProfileColor(value);
  return normalized || fallback;
}

function normalizeMime(value) {
  if (typeof value !== 'string') return '';
  if (!value) return '';
  const base = value.split(';', 1)[0]?.trim() || '';
  return base.toLowerCase();
}

function buildNormalizedMimeMap(map) {
  return Object.fromEntries(
    Object.entries(map).map(([key, ext]) => [normalizeMime(key), ext])
  );
}

const IMAGE_MIME_EXT = buildNormalizedMimeMap({
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/jpg': '.jpg',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'image/svg+xml': '.svg',
  'image/bmp': '.bmp'
});
const AUDIO_MIME_EXT = buildNormalizedMimeMap({
  'audio/mpeg': '.mp3',
  'audio/mp3': '.mp3',
  'audio/wav': '.wav',
  'audio/x-wav': '.wav',
  'audio/wave': '.wav',
  'audio/webm': '.webm',
  'audio/ogg': '.ogg',
  'audio/flac': '.flac',
  'audio/x-flac': '.flac',
  'audio/aac': '.aac',
  'audio/mp4': '.m4a',
  'audio/x-m4a': '.m4a',
  'audio/aiff': '.aiff',
  'audio/x-aiff': '.aiff'
});
const AUDIO_ALLOWED_MIME = new Set(Object.keys(AUDIO_MIME_EXT));
const MESSAGE_ALLOWED_MIME = new Set([
  ...Object.keys(IMAGE_MIME_EXT),
  ...Object.keys(AUDIO_MIME_EXT)
]);
/* ============================ DB ============================ */
await mongoose.connect(MONGODB_URI, { dbName: 'beatloop' });

/* -------------------- Mongoose models -------------------- */
const UserSchema = new mongoose.Schema({
  name: { type: String, index: true },       // enforced unique in app layer
  email: { type: String, unique: true, index: true },
  passwordHash: String,
  avatarUrl: String,
  avatarStorageKey: { type: String, default: '' },
  firstName: { type: String, default: '' },
  lastName: { type: String, default: '' },
  displayName: { type: String, default: '' },
  profileColor: { type: String, default: PROFILE_COLOR_DEFAULT },
  tagUrl: String,            // 10-sec sound tag URL
  tagStorageKey: { type: String, default: '' },
  tagDurationSec: Number,
  totalOnlineSec: { type: Number, default: 0 },
  lastPingAt: Date,
  createdAt: { type: Date, default: Date.now }
});

const SessionSchema = new mongoose.Schema({
  name: String,
  hostUserId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  tempo: { type: Number, default: 92 },
  maxPlayers: { type: Number, default: 8 },
  createdAt: { type: Date, default: Date.now },
  isActive: { type: Boolean, default: true },
  lastEmptyAt: Date, // used for 3-minute reap
  participants: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
  participantsHistory: {
    type: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
    default: []
  },
  grid: {
    type: Object,
    default: {
      rows: 8,
      cols: 16,
      map: {} // { "row-col": 0/1 }
    }
  },
  playerColors: {
    type: Object,
    default: {}
  }
});

const TrackSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  title: { type: String, default: '' },
  artist: { type: String, default: '' },
  bpm: { type: Number, default: 0 },
  audioUrl: { type: String, required: true },
  coverUrl: { type: String, default: '' },
  audioDurationSec: { type: Number, default: 0 },
  caption: { type: String, default: '' },
  source: { type: String, enum: ['upload', 'soundcloud'], default: 'upload', index: true },
  sourceId: { type: String, default: null, index: true },
  sourcePermalinkUrl: { type: String, default: '' },
  sourceData: { type: Object, default: {} },
  streamUrl: { type: String, default: '' },
  streamProtocol: { type: String, default: '' },
  streamMimeType: { type: String, default: '' },
  albumId: { type: mongoose.Schema.Types.ObjectId, ref: 'Album', default: null, index: true },
  albumTrackOrder: { type: Number, default: 0 },
  createdAt: { type: Date, default: Date.now },
  bumpedAt: { type: Date, default: Date.now, index: true },
  updatedAt: { type: Date, default: Date.now }
});

TrackSchema.pre('save', function(next) {
  this.updatedAt = new Date();
  next();
});

TrackSchema.index({ userId: 1, source: 1, sourceId: 1 }, { unique: true, sparse: true });

const TrackStatsSchema = new mongoose.Schema({
  trackId: { type: mongoose.Schema.Types.ObjectId, ref: 'Track', unique: true, index: true },
  plays: { type: Number, default: 0 },
  likes: { type: Number, default: 0 },
  reposts: { type: Number, default: 0 },
  comments: { type: Number, default: 0 },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
});

TrackStatsSchema.pre('save', function(next) {
  this.updatedAt = new Date();
  next();
});

const TrackEventSchema = new mongoose.Schema({
  trackId: { type: mongoose.Schema.Types.ObjectId, ref: 'Track', required: true, index: true },
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  type: { type: String, enum: ['play', 'like', 'repost', 'comment', 'backfill'], required: true },
  count: { type: Number, default: 1 },
  createdAt: { type: Date, default: Date.now },
  metadata: {
    type: Object,
    default: {}
  }
});
TrackEventSchema.index(
  { trackId: 1, userId: 1, type: 1 },
  { unique: true, partialFilterExpression: { type: 'repost' } }
);

const TrackCommentSchema = new mongoose.Schema({
  trackId: { type: mongoose.Schema.Types.ObjectId, ref: 'Track', required: true, index: true },
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  text: { type: String, required: true },
  timeSec: { type: Number, default: 0 },
  createdAt: { type: Date, default: Date.now },
  clientId: { type: String, default: null },
  userSnapshot: {
    name: { type: String, default: '' },
    displayName: { type: String, default: '' },
    email: { type: String, default: '' },
    avatar: { type: String, default: '' },
    avatarStorageKey: { type: String, default: '' }
  }
});

TrackCommentSchema.index({ trackId: 1, clientId: 1 }, { unique: true, sparse: true });

const MediaStorySchema = new mongoose.Schema({
  url: { type: String, required: true, unique: true, index: true },
  title: { type: String, default: '' },
  excerpt: { type: String, default: '' },
  imageUrl: { type: String, default: '' },
  watermarkedImageKey: { type: String, default: '' },
  summary: { type: String, default: '' },
  summaryModel: { type: String, default: '' },
  summaryError: { type: String, default: '' },
  shareSlug: { type: String, default: '', unique: true, sparse: true },
  likeUserIds: { type: [mongoose.Schema.Types.ObjectId], ref: 'User', default: [] },
  dislikeUserIds: { type: [mongoose.Schema.Types.ObjectId], ref: 'User', default: [] },
  commentCount: { type: Number, default: 0 },
  publishedAt: { type: Date, default: null },
  source: { type: String, default: MEDIA_SOURCE_NAME },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
});

MediaStorySchema.pre('save', function mediaStoryPreSave(next) {
  this.updatedAt = new Date();
  next();
});

const MediaCommentSchema = new mongoose.Schema({
  storyId: { type: mongoose.Schema.Types.ObjectId, ref: 'MediaStory', required: true, index: true },
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  body: { type: String, default: '' },
  imageStorageKey: { type: String, default: '' },
  imageUrl: { type: String, default: '' },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
});

MediaCommentSchema.pre('save', function mediaCommentPreSave(next) {
  this.updatedAt = new Date();
  next();
});

MediaCommentSchema.index({ storyId: 1, createdAt: -1 });

const MessageAttachmentSchema = new mongoose.Schema({
  fileName: { type: String, required: true },
  originalName: { type: String, default: '' },
  mimeType: { type: String, default: '' },
  size: { type: Number, default: 0 },
  type: { type: String, enum: ['image', 'audio'], required: true }
}, { _id: false });

const DirectMessageSchema = new mongoose.Schema({
  conversationKey: { type: String, index: true },
  senderId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  recipientId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  body: { type: String, default: '' },
  attachments: { type: [MessageAttachmentSchema], default: [] },
  editedAt: { type: Date, default: null },
  deletedAt: { type: Date, default: null },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
});

DirectMessageSchema.pre('validate', function(next) {
  this.conversationKey = conversationKeyFor(this.senderId, this.recipientId) || this.conversationKey;
  if (!this.conversationKey) {
    return next(new Error('invalid conversation participants'));
  }
  next();
});

DirectMessageSchema.pre('save', function(next) {
  this.updatedAt = new Date();
  next();
});

DirectMessageSchema.index({ conversationKey: 1, createdAt: 1 });
DirectMessageSchema.index({ senderId: 1, recipientId: 1, createdAt: -1 });

const StudioSoundSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  type: { type: String, enum: ['loop', 'instrument'], required: true, index: true },
  name: { type: String, required: true },
  storageKey: { type: String, required: true },
  originalName: { type: String, default: '' },
  mimeType: { type: String, default: '' },
  size: { type: Number, default: 0 },
  durationSec: { type: Number, default: 0 },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
});

StudioSoundSchema.index({ type: 1, createdAt: -1 });
StudioSoundSchema.index({ userId: 1, createdAt: -1 });

StudioSoundSchema.pre('save', function(next) {
  this.updatedAt = new Date();
  next();
});

const User = mongoose.model('User', UserSchema);
const Session = mongoose.model('Session', SessionSchema);
const Track = mongoose.model('Track', TrackSchema);
const TrackStat = mongoose.model('TrackStat', TrackStatsSchema);
const TrackEvent = mongoose.model('TrackEvent', TrackEventSchema);
const TrackComment = mongoose.model('TrackComment', TrackCommentSchema);
const MediaStory = mongoose.model('MediaStory', MediaStorySchema);
const MediaComment = mongoose.model('MediaComment', MediaCommentSchema);
const DirectMessage = mongoose.model('DirectMessage', DirectMessageSchema);
const StudioSound = mongoose.model('StudioSound', StudioSoundSchema);
const AlbumTrackRefSchema = new mongoose.Schema({
  trackId: { type: mongoose.Schema.Types.ObjectId, ref: 'Track', required: true },
  order: { type: Number, default: 0 }
}, { _id: false });

const AlbumSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  title: { type: String, default: '' },
  caption: { type: String, default: '' },
  coverUrl: { type: String, default: '' },
  coverStorageKey: { type: String, default: '' },
  source: { type: String, default: '' },
  sourceId: { type: String, default: null, index: true },
  sourcePermalinkUrl: { type: String, default: '' },
  sourceData: { type: Object, default: {} },
  trackIds: { type: [AlbumTrackRefSchema], default: [] },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
});

AlbumSchema.pre('save', function(next) {
  this.updatedAt = new Date();
  next();
});

AlbumSchema.index({ userId: 1, source: 1, sourceId: 1 }, { unique: true, sparse: true });

const Album = mongoose.model('Album', AlbumSchema);

const PlaylistTrackRefSchema = new mongoose.Schema({
  trackId: { type: mongoose.Schema.Types.ObjectId, ref: 'Track', required: true },
  order: { type: Number, default: 0 }
}, { _id: false });

const PlaylistSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  title: { type: String, default: '' },
  coverUrl: { type: String, default: '' },
  coverStorageKey: { type: String, default: '' },
  trackIds: { type: [PlaylistTrackRefSchema], default: [] },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
});

PlaylistSchema.pre('save', function(next) {
  this.updatedAt = new Date();
  next();
});

const Playlist = mongoose.model('Playlist', PlaylistSchema);

const SoundCloudAccountSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, unique: true, index: true },
  soundcloudUserId: { type: Number, index: true },
  username: { type: String, default: '' },
  permalinkUrl: { type: String, default: '' },
  avatarUrl: { type: String, default: '' },
  avatarStorageKey: { type: String, default: '' },
  accessToken: { type: String, required: true },
  refreshToken: { type: String, default: '' },
  scope: { type: [String], default: [] },
  expiresAt: { type: Date, default: null },
  lastSyncAt: { type: Date, default: null },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
});

SoundCloudAccountSchema.pre('save', function(next) {
  this.updatedAt = new Date();
  next();
});

const SoundCloudAccount = mongoose.model('SoundCloudAccount', SoundCloudAccountSchema);

/* ============================ APP ============================ */
const app = express();
app.set('trust proxy', true);

/* ---- CORS (Express + Socket.IO use the SAME rule) ---- */
function normalizeOrigin(value) {
  if (!value) return null;
  try {
    const url = new URL(value);
    // Normalize by stripping search/hash and forcing lower-case host.
    const host = url.hostname?.toLowerCase?.();
    if (host) {
      return `${url.protocol}//${host}${url.port ? `:${url.port}` : ''}`;
    }
    return url.origin;
  } catch {
    return value.replace(/\/+$/, '').trim();
  }
}

const FRONTENDS = new Set(
  FRONTEND_ORIGINS
    .split(/[\s,]+/)
    .map(s => normalizeOrigin(s.trim()))
    .filter(Boolean)
);

const corsOptions = {
  origin(origin, cb) {
    if (!origin) return cb(null, true); // server-to-server or same-origin
    try {
      const url = new URL(origin);
      const hostname = url.hostname?.toLowerCase?.() || '';
      const normalizedOrigin = `${url.protocol}//${hostname}${url.port ? `:${url.port}` : ''}`;

      const allowed =
        FRONTENDS.has(normalizedOrigin) ||
        /\.onrender\.com$/.test(hostname) ||
        hostname === 'beatloop.co' ||
        hostname === 'www.beatloop.co' ||
        hostname.endsWith('.beatloop.co');

      return cb(allowed ? null : new Error(`CORS blocked: ${origin}`), allowed);
    } catch {
      return cb(new Error('CORS bad origin'), false);
    }
  },
  methods: ['GET','POST','PUT','PATCH','DELETE','OPTIONS'],
  allowedHeaders: ['Content-Type','Authorization'],
  credentials: true,
  optionsSuccessStatus: 204
};

app.use(cors(corsOptions));
app.options('*', cors(corsOptions));
app.use(morgan('dev'));
app.use(express.json({ limit: '5mb' }));
const projectRoot = process.cwd();
const uploadsRoot = getUploadsRoot();
const trackAudioDir = path.join(uploadsRoot, 'tracks');
const trackCoverDir = path.join(uploadsRoot, 'covers');
const messageAttachmentDir = path.join(uploadsRoot, 'messages');
const PROXIED_STORAGE_PREFIXES = new Set(['tracks', 'covers', 'messages', 'avatars', 'tags', 'studio', 'media']);
const DURABLE_STORAGE_PREFIXES = new Set(['tracks', 'covers', 'messages', 'avatars', 'tags', 'studio', 'media']);
fs.mkdirSync(trackAudioDir, { recursive: true });
fs.mkdirSync(trackCoverDir, { recursive: true });
fs.mkdirSync(messageAttachmentDir, { recursive: true });

const DURABLE_UPLOADS_UNAVAILABLE_RESPONSE = {
  error: 'uploads are temporarily unavailable: durable storage is not configured'
};

function ensureDurableUploadsEnabled(res) {
  if (RUNNING_IN_PRODUCTION && !uploadsAvailable) {
    res.status(503).json(DURABLE_UPLOADS_UNAVAILABLE_RESPONSE);
    return false;
  }
  return true;
}

const UPLOAD_CACHE_CONTROL = 'public, max-age=604800, immutable';

function setUploadHeaders(res, filePath) {
  const mimeType = mimeLookup(filePath);
  if (mimeType) {
    res.setHeader('Content-Type', mimeType);
  }
  res.setHeader('Accept-Ranges', 'bytes');
  res.setHeader('Cache-Control', UPLOAD_CACHE_CONTROL);
  res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
}

const DURABLE_UPLOAD_HEADER_PASSTHROUGH = [
  'cache-control',
  'content-type',
  'content-length',
  'accept-ranges',
  'etag',
  'last-modified',
  'content-range',
  'content-encoding',
  'content-disposition',
  'vary'
];

app.get('/uploads/:prefix/*', async (req, res, next) => {
  const { prefix } = req.params;
  if (!PROXIED_STORAGE_PREFIXES.has(prefix) || !durableUploadsActive) {
    return next();
  }

  const remainder = (req.params[0] || '').replace(/^\/+/, '');
  const key = normalizeUploadKey(prefix, remainder);
  if (!key) {
    return res.status(404).end();
  }

  const durableUrl = durablePublicUrlForKey(key);
  if (!durableUrl) {
    return res.status(404).end();
  }

  try {
    const response = await fetch(durableUrl);
    if (response.status === 404) {
      return res.status(404).end();
    }

    if (!(response.ok || response.status === 304)) {
      return res.status(502).json({ error: 'Failed to proxy upload' });
    }

    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
    for (const headerName of DURABLE_UPLOAD_HEADER_PASSTHROUGH) {
      const headerValue = response.headers.get(headerName);
      if (headerValue) {
        res.setHeader(headerName, headerValue);
      }
    }

    res.status(response.status);

    if (!response.body) {
      return res.end();
    }

    return Readable.fromWeb(response.body).pipe(res);
  } catch (error) {
    console.error('Failed to proxy durable upload', { key, error });
    return res.status(502).json({ error: 'Failed to retrieve upload' });
  }
});

app.use(
  '/uploads',
  express.static(uploadsRoot, {
    setHeaders: setUploadHeaders
  })
);

const LOCALHOST_RE = /^https?:\/\/(?:localhost|127(?:\.\d+){3})(?::\d+)?$/i;
const MARKETING_HOSTS = new Set(['beatloop.co', 'www.beatloop.co']);
const BEATLOOP_HOST_CHECK = host => {
  if (!host) return false;
  const lower = host.toLowerCase();
  return lower === 'beatloop.co' || lower === 'www.beatloop.co' || lower.endsWith('.beatloop.co');
};
const FALLBACK_BASE_CANDIDATES = new Set(
  (API_FALLBACK_BASE_URLS || '')
    .split(/[\s,]+/)
    .map(s => s.trim())
    .filter(Boolean)
);
if (RENDER_EXTERNAL_URL) {
  FALLBACK_BASE_CANDIDATES.add(RENDER_EXTERNAL_URL);
}

const UNIQUE_FALLBACKS = new Set();

function ensureHttpsForBeatloopHost(urlString) {
  if (!urlString || typeof urlString !== 'string') return urlString;
  if (!/^https?:\/\//i.test(urlString)) return urlString;
  try {
    const parsed = new URL(urlString);
    const hostname = (parsed.hostname || '').toLowerCase();
    if (!BEATLOOP_HOST_CHECK(hostname)) return urlString;
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

function safeHostname(value) {
  if (!value || typeof value !== 'string') return '';
  try {
    const parsed = new URL(value);
    return (parsed.hostname || '').toLowerCase();
  } catch {
    return '';
  }
}

function sanitizeBaseCandidate(value) {
  if (!value || typeof value !== 'string') return '';
  const trimmed = value.trim();
  if (!trimmed) return '';
  try {
    const parsed = new URL(ensureHttpsForBeatloopHost(trimmed));
    const pathname = parsed.pathname && parsed.pathname !== '/' ? parsed.pathname : '';
    const rebuilt = `${parsed.protocol}//${parsed.host}${pathname}${parsed.search || ''}${parsed.hash || ''}`;
    return rebuilt.replace(/\/+$/, '');
  } catch {
    return '';
  }
}

async function hostResolves(host) {
  if (!host) return false;
  try {
    await dns.lookup(host);
    return true;
  } catch {
    return false;
  }
}

const RAW_PUBLIC_BASE = (PUBLIC_BASE_URL || '').trim();
let ENV_PUBLIC_BASE = '';
let ENV_PUBLIC_HOST = '';
let ENV_PUBLIC_IS_LOCAL = false;
let ENV_PUBLIC_IS_MARKETING = false;
let ENV_PUBLIC_RESOLVES = true;
let VERIFIED_FALLBACK_BASES = [];

if (RAW_PUBLIC_BASE) {
  if (/^https?:\/\//i.test(RAW_PUBLIC_BASE)) {
    try {
      const parsed = new URL(RAW_PUBLIC_BASE);
      const path = parsed.pathname && parsed.pathname !== '/' ? parsed.pathname : '';
      const base = `${parsed.protocol}//${parsed.host}${path}`.replace(/\/+$/, '');
      ENV_PUBLIC_BASE = ensureHttpsForBeatloopHost(base);
      ENV_PUBLIC_HOST = (parsed.hostname || '').toLowerCase();
    } catch {
      ENV_PUBLIC_BASE = ensureHttpsForBeatloopHost(RAW_PUBLIC_BASE).replace(/\/+$/, '');
    }
  }

  if (ENV_PUBLIC_BASE) {
    ENV_PUBLIC_IS_LOCAL = LOCALHOST_RE.test(ENV_PUBLIC_BASE);
    ENV_PUBLIC_IS_MARKETING = MARKETING_HOSTS.has(ENV_PUBLIC_HOST);
  }
}

if (ENV_PUBLIC_HOST && !ENV_PUBLIC_IS_LOCAL) {
  ENV_PUBLIC_RESOLVES = await hostResolves(ENV_PUBLIC_HOST);
  if (!ENV_PUBLIC_RESOLVES) {
    console.warn(`⚠️  PUBLIC_BASE_URL host failed DNS lookup: ${ENV_PUBLIC_HOST}`);
  }
}

async function buildVerifiedFallbacks() {
  const result = [];
  for (const candidate of FALLBACK_BASE_CANDIDATES) {
    const sanitized = sanitizeBaseCandidate(candidate);
    if (!sanitized) continue;
    if (UNIQUE_FALLBACKS.has(sanitized)) continue;
    if (ENV_PUBLIC_BASE && sanitized === ensureHttpsForBeatloopHost(ENV_PUBLIC_BASE)) continue;

    const hostname = safeHostname(sanitized);
    if (!hostname) continue;

    let resolves = true;
    if (!LOCALHOST_RE.test(sanitized)) {
      resolves = await hostResolves(hostname);
    }

    if (!resolves) {
      console.warn(`⚠️  API fallback skipped (DNS failed): ${sanitized}`);
      continue;
    }

    UNIQUE_FALLBACKS.add(sanitized);
    result.push(sanitized);
  }
  return result;
}

VERIFIED_FALLBACK_BASES = await buildVerifiedFallbacks();

function requestBaseFromHeaders(req) {
  if (!req) return null;
  const headers = req.headers || {};
  const headerValue = value => (typeof value === 'string' ? value.split(',')[0].trim() : '');
  const forwardedHost = headerValue(headers['x-forwarded-host']);
  const forwardedProto = headerValue(headers['x-forwarded-proto']);
  const origin = headerValue(headers.origin);
  const hostHeader = forwardedHost || headerValue(headers.host) || (typeof req.get === 'function' ? headerValue(req.get('host')) : '');
  const protocol = forwardedProto || (origin ? origin.split('://')[0] : '') || req.protocol || 'http';

  if (hostHeader) {
    const base = `${protocol}://${hostHeader}`.replace(/\/+$/, '');
    return ensureHttpsForBeatloopHost(base);
  }
  if (origin) {
    return ensureHttpsForBeatloopHost(origin).replace(/\/+$/, '');
  }
  return null;
}

function effectivePublicBase(req) {
  const requestBase = requestBaseFromHeaders(req);
  const requestIsLocal = requestBase ? LOCALHOST_RE.test(requestBase) : false;
  const requestHostname = requestBase ? safeHostname(requestBase) : '';
  const envMatchesRequest =
    !!ENV_PUBLIC_HOST && !!requestHostname && ENV_PUBLIC_HOST === requestHostname;

  const canUseEnvBase = Boolean(
    ENV_PUBLIC_BASE &&
      (!ENV_PUBLIC_IS_MARKETING || !requestBase || requestIsLocal) &&
      (ENV_PUBLIC_IS_LOCAL || ENV_PUBLIC_RESOLVES) &&
      (!requestHostname || envMatchesRequest)
  );

  if (canUseEnvBase) {
    return ensureHttpsForBeatloopHost(ENV_PUBLIC_BASE);
  }

  if (requestBase) {
    return ensureHttpsForBeatloopHost(requestBase);
  }

  if (VERIFIED_FALLBACK_BASES.length > 0) {
    return VERIFIED_FALLBACK_BASES[0];
  }

  if (ENV_PUBLIC_BASE) {
    return ensureHttpsForBeatloopHost(ENV_PUBLIC_BASE);
  }

  return `http://localhost:${PORT}`;
}

function normalizeUploadKey(folder, name) {
  if (!folder && !name) return '';
  if (folder && typeof name === 'string' && name) {
    const joined = `${folder}/${name}`.replace(/^\/+/, '');
    return joined.replace(/^uploads\//, '');
  }
  if (typeof folder === 'string' && !name) {
    return folder.replace(/^\/+/, '').replace(/^uploads\//, '');
  }
  return '';
}

function rewriteDurableUrlToProxy(req, absoluteUrl) {
  if (!absoluteUrl || typeof absoluteUrl !== 'string') return '';
  if (!durableStorageEnabled()) return '';

  const { url: durableBaseUrl, host: durableBaseHost } = getDurablePublicBase();
  if (!durableBaseUrl || !durableBaseHost) return '';

  try {
    const parsed = new URL(absoluteUrl);
    if ((parsed.hostname || '').toLowerCase() !== durableBaseHost) {
      return '';
    }

    const baseUrl = new URL(durableBaseUrl);
    const basePath = (baseUrl.pathname || '').replace(/\/+$/, '');
    let relativePath = parsed.pathname || '';

    if (basePath && basePath !== '/') {
      if (!relativePath.startsWith(basePath)) {
        return '';
      }
      const remainder = relativePath.slice(basePath.length);
      if (remainder && !remainder.startsWith('/')) {
        return '';
      }
      relativePath = remainder;
    }

    relativePath = relativePath.replace(/^\/+/, '');
    const key = normalizeUploadKey(relativePath);
    if (!key) return '';

    const prefix = key.split('/')[0];
    if (!PROXIED_STORAGE_PREFIXES.has(prefix)) return '';

    const base = effectivePublicBase(req);
    const search = parsed.search || '';
    const hash = parsed.hash || '';
    return `${base}/uploads/${key}${search}${hash}`;
  } catch {
    return '';
  }
}

function publicUploadUrl(req, folderOrKey, maybeFilename) {
  if (/^https?:\/\//i.test(folderOrKey || '')) {
    const proxied = rewriteDurableUrlToProxy(req, folderOrKey);
    return proxied || ensureHttpsForBeatloopHost(folderOrKey);
  }
  if (/^https?:\/\//i.test(maybeFilename || '')) {
    const proxied = rewriteDurableUrlToProxy(req, maybeFilename);
    return proxied || ensureHttpsForBeatloopHost(maybeFilename);
  }

  const key = normalizeUploadKey(folderOrKey, maybeFilename);
  if (!key) return '';

  const prefix = key.split('/')[0];
  if (
    maybeFilename === undefined &&
    durableStorageEnabled() &&
    DURABLE_STORAGE_PREFIXES.has(prefix) &&
    !PROXIED_STORAGE_PREFIXES.has(prefix)
  ) {
    const durableUrl = durablePublicUrlForKey(key);
    if (durableUrl) return durableUrl;
  }

  const base = effectivePublicBase(req);
  return `${base}/uploads/${key}`;
}

const STATIC_ASSET_MOUNTS = [
  { mount: '/audio', dir: 'audio' },
  { mount: '/img', dir: 'img' }
];

for (const { mount, dir } of STATIC_ASSET_MOUNTS) {
  const absoluteDir = path.join(projectRoot, dir);
  if (!fs.existsSync(absoluteDir)) continue;
  app.use(mount, express.static(absoluteDir, {
    fallthrough: true,
    maxAge: '7d',
    redirect: false
  }));
}

/* ---- Health check ---- */
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', uptime: process.uptime(), db: mongoose.connection.readyState });
});

/* ============================ HELPERS ============================ */
function sign(user) {
  return jwt.sign({ uid: user._id }, JWT_SECRET, { expiresIn: '30d' });
}

function normalizeEmail(value) {
  if (typeof value !== 'string') return '';
  const trimmed = value.trim();
  if (!trimmed) return '';
  return trimmed.toLowerCase();
}

async function auth(req, res, next) {
  const hdr = req.headers.authorization || '';
  const token = hdr.startsWith('Bearer ') ? hdr.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'missing token' });
  try {
    const { uid } = jwt.verify(token, JWT_SECRET);
    req.user = await User.findById(uid);
    if (!req.user) return res.status(401).json({ error: 'bad user' });
    next();
  } catch {
    return res.status(401).json({ error: 'invalid token' });
  }
}

function isAbsoluteUrl(value) {
  return typeof value === 'string' && /^https?:\/\//i.test(value);
}

function presentStoredUploadUrl(req, url, storageKey) {
  const rawUrl = typeof url === 'string' ? url : '';
  if (isAbsoluteUrl(rawUrl)) {
    const proxied = rewriteDurableUrlToProxy(req, rawUrl);
    return proxied || rawUrl;
  }
  const fallback = typeof storageKey === 'string' && storageKey ? storageKey : rawUrl;
  const key = normalizeUploadKey(fallback);
  if (!key) return rawUrl;
  return publicUploadUrl(req, key);
}

function resolveArtistFromUser(user) {
  if (!user) return '';
  const display = typeof user.displayName === 'string' ? user.displayName.trim() : '';
  if (display) return display;
  const first = typeof user.firstName === 'string' ? user.firstName.trim() : '';
  const last = typeof user.lastName === 'string' ? user.lastName.trim() : '';
  const combined = [first, last].filter(Boolean).join(' ').trim();
  if (combined) return combined;
  if (typeof user.name === 'string' && user.name.trim()) return user.name.trim();
  return typeof user.email === 'string' ? user.email : '';
}

const MEDIA_ALLOWED_IMAGE_HOSTS = new Set([
  'www.tmz.com',
  'tmz.com',
  'tmz.prod.cd.beachfrontcdn.com',
  'tmz-prod.s3.amazonaws.com',
  'tmz-prod.aws.hmn.md',
  'tmz-prod.s3.amazonaws.com',
  'tmz-prod.akamaized.net',
  'tmz-prod.a.akamaihd.net',
  'tmz-prod-tmznet.storage.googleapis.com'
]);

function decodeHtmlEntities(value) {
  if (typeof value !== 'string' || !value.includes('&')) return value || '';
  return value.replace(/&(#?(x)?[0-9a-zA-Z]+);/g, (_match, entity) => {
    if (!entity) return '&';
    if (entity[0] === '#') {
      const base = entity[1] && entity[1].toLowerCase() === 'x' ? 16 : 10;
      const numeric = entity.slice(base === 16 ? 2 : 1);
      const codePoint = parseInt(numeric, base);
      if (Number.isFinite(codePoint)) {
        try {
          return String.fromCodePoint(codePoint);
        } catch {
          return '';
        }
      }
    }
    const named = entity.toLowerCase();
    switch (named) {
      case 'amp':
        return '&';
      case 'lt':
        return '<';
      case 'gt':
        return '>';
      case 'quot':
        return '"';
      case 'apos':
      case '#39':
        return "'";
      case 'nbsp':
        return ' ';
      default:
        return '';
    }
  });
}

function stripHtmlTags(value) {
  if (typeof value !== 'string') return '';
  return decodeHtmlEntities(
    value.replace(/<!\[CDATA\[([\s\S]*?)]]>/gi, '$1').replace(/<[^>]+>/g, ' ')
  )
    .replace(/\s+/g, ' ')
    .trim();
}

function extractTagValue(block, tagName) {
  if (!block) return '';
  const pattern = new RegExp(`<${tagName}[^>]*>([\\s\\S]*?)<\\/${tagName}>`, 'i');
  const match = pattern.exec(block);
  if (!match) return '';
  return stripHtmlTags(match[1]);
}

function extractFirstImageUrl(block) {
  if (!block) return '';
  const mediaMatch = block.match(/<media:content[^>]*url="([^"]+)"/i);
  if (mediaMatch && mediaMatch[1]) return mediaMatch[1];
  const enclosureMatch = block.match(/<enclosure[^>]*url="([^"]+)"/i);
  if (enclosureMatch && enclosureMatch[1]) return enclosureMatch[1];
  const imgMatch = block.match(/<img[^>]+src="([^"]+)"/i);
  if (imgMatch && imgMatch[1]) return imgMatch[1];
  return '';
}

function sanitizeMediaTitle(value) {
  if (typeof value !== 'string') return '';
  return value.trim().slice(0, 240);
}

function sanitizeMediaExcerpt(value) {
  if (typeof value !== 'string') return '';
  return value.trim().slice(0, 800);
}

function sanitizeMediaUrl(value) {
  if (typeof value !== 'string') return '';
  const trimmed = value.trim();
  if (!trimmed) return '';
  try {
    const parsed = new URL(trimmed, MEDIA_TMZ_FEED_URL);
    return parsed.href;
  } catch {
    return '';
  }
}

function sanitizeMediaPublishedAt(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function sanitizeMediaCommentBody(value) {
  if (typeof value !== 'string') return '';
  return value.trim().slice(0, 1200);
}

async function resolveViewerFromRequest(req) {
  const hdr = req.headers.authorization || '';
  const token = hdr.startsWith('Bearer ') ? hdr.slice(7) : null;
  if (!token) return null;
  try {
    const { uid } = jwt.verify(token, JWT_SECRET);
    if (!uid) return null;
    return await User.findById(uid);
  } catch {
    return null;
  }
}

async function ensureMediaShareSlug(doc) {
  if (!doc) return '';
  if (doc.shareSlug) return doc.shareSlug;
  const base = sanitizeMediaTitle(doc.title || 'story')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'story';
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const candidate = attempt === 0 ? base : `${base}-${crypto.randomBytes(2).toString('hex')}`;
    // eslint-disable-next-line no-await-in-loop
    const exists = await MediaStory.exists({ shareSlug: candidate });
    if (!exists) {
      doc.shareSlug = candidate;
      return candidate;
    }
  }
  const fallback = crypto.randomBytes(6).toString('hex');
  doc.shareSlug = fallback;
  return fallback;
}

function parseTmzFeed(xml) {
  if (typeof xml !== 'string' || !xml) return [];
  const items = [];
  const itemRegex = /<item>([\s\S]*?)<\/item>/gi;
  let match;
  while ((match = itemRegex.exec(xml))) {
    const block = match[1] || '';
    const title = sanitizeMediaTitle(extractTagValue(block, 'title'));
    const url = sanitizeMediaUrl(extractTagValue(block, 'link'));
    if (!url) continue;
    const description = sanitizeMediaExcerpt(extractTagValue(block, 'description'));
    const published = sanitizeMediaPublishedAt(extractTagValue(block, 'pubDate'));
    const image = sanitizeMediaUrl(extractFirstImageUrl(block));
    items.push({
      title,
      url,
      excerpt: description,
      image,
      publishedAt: published ? published.toISOString() : null
    });
    if (items.length >= 32) break;
  }
  return items;
}

async function fetchTmzHipHopFeed() {
  const nowTs = Date.now();
  if (tmzFeedCache.items.length && nowTs - tmzFeedCache.at < MEDIA_CACHE_TTL) {
    return tmzFeedCache.items;
  }

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000).unref();
    const response = await fetch(MEDIA_TMZ_FEED_URL, { signal: controller.signal });
    clearTimeout(timeout);
    if (!response.ok) {
      throw new Error(`TMZ feed ${response.status}`);
    }
    const text = await response.text();
    const parsed = parseTmzFeed(text);
    tmzFeedCache.at = Date.now();
    tmzFeedCache.items = parsed;
    return parsed;
  } catch (error) {
    console.warn('Failed to refresh TMZ feed', error);
    return tmzFeedCache.items.length ? tmzFeedCache.items : [];
  }
}

async function summarizeMediaStory({ title, excerpt, url }) {
  if (!OPENAI_API_KEY) {
    return { text: '', model: '', error: 'missing_api_key' };
  }

  const payload = {
    model: MEDIA_SUMMARY_MODEL,
    temperature: 0.4,
    max_tokens: 220,
    messages: [
      {
        role: 'system',
        content: 'You are Beatloop Media. Summarize hip-hop news into 2-3 neutral sentences in our own words. Mention verified facts only.'
      },
      {
        role: 'user',
        content: [
          `Title: ${title || 'Untitled'}`,
          `Source: ${url || 'unknown'}`,
          excerpt ? `Snippet: ${excerpt}` : 'Snippet: (not provided)'
        ].join('\n')
      }
    ]
  };

  try {
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload)
    });
    if (!response.ok) {
      const errText = await response.text().catch(() => '');
      return { text: '', model: payload.model, error: `openai_${response.status}:${errText.slice(0, 200)}` };
    }
    const data = await response.json();
    const text = data?.choices?.[0]?.message?.content?.trim() || '';
    return { text, model: data?.model || payload.model, error: '' };
  } catch (error) {
    console.warn('OpenAI summary failed', error);
    return { text: '', model: MEDIA_SUMMARY_MODEL, error: error.message || 'openai_error' };
  }
}

function presentMediaStory(req, doc, viewer) {
  if (!doc) return null;
  const viewerId = viewer?._id ? viewer._id.toString() : '';
  const likeIds = Array.isArray(doc.likeUserIds) ? doc.likeUserIds.map((id) => id.toString()) : [];
  const dislikeIds = Array.isArray(doc.dislikeUserIds) ? doc.dislikeUserIds.map((id) => id.toString()) : [];
  const key = doc.watermarkedImageKey || '';
  const watermarked = key ? publicUploadUrl(req, key) : '';
  const shareBase = effectivePublicBase(req);
  const slug = doc.shareSlug || doc._id?.toString();
  const shareUrl = slug ? `${shareBase}/media?story=${encodeURIComponent(slug)}` : `${shareBase}/media`;
  return {
    id: doc._id,
    url: doc.url,
    title: doc.title || '',
    excerpt: doc.excerpt || '',
    summary: doc.summary || '',
    summaryModel: doc.summaryModel || '',
    summaryError: doc.summaryError || '',
    imageUrl: doc.imageUrl || '',
    watermarkedImageUrl: watermarked,
    likeCount: likeIds.length,
    dislikeCount: dislikeIds.length,
    commentCount: Number(doc.commentCount) || 0,
    liked: Boolean(viewerId && likeIds.includes(viewerId)),
    disliked: Boolean(viewerId && dislikeIds.includes(viewerId)),
    shareSlug: slug,
    shareUrl,
    source: doc.source || MEDIA_SOURCE_NAME,
    publishedAt: doc.publishedAt || null,
    createdAt: doc.createdAt || null,
    updatedAt: doc.updatedAt || null
  };
}

async function presentMediaComment(req, commentDoc, userCache = new Map()) {
  if (!commentDoc) return null;
  let author = null;
  const userId = commentDoc.userId;
  if (userId) {
    const key = userId.toString();
    if (userCache.has(key)) {
      author = userCache.get(key);
    } else {
      // eslint-disable-next-line no-await-in-loop
      const user = await User.findById(userId);
      if (user) {
        author = {
          id: user._id,
          name: resolveArtistFromUser(user),
          avatarUrl: presentStoredUploadUrl(req, user.avatarUrl, user.avatarStorageKey)
        };
        userCache.set(key, author);
      }
    }
  }
  const imageKey = commentDoc.imageStorageKey || '';
  return {
    id: commentDoc._id,
    storyId: commentDoc.storyId,
    body: commentDoc.body || '',
    imageUrl: imageKey ? publicUploadUrl(req, imageKey) : commentDoc.imageUrl || '',
    createdAt: commentDoc.createdAt || null,
    author
  };
}

async function fetchRemoteImage(url) {
  const normalized = sanitizeMediaUrl(url);
  if (!normalized) throw new Error('invalid_url');
  const parsed = new URL(normalized);
  const hostname = (parsed.hostname || '').toLowerCase();
  const allowed = [...MEDIA_ALLOWED_IMAGE_HOSTS].some(
    (candidate) => hostname === candidate || hostname.endsWith(`.${candidate.replace(/^\./, '')}`)
  );
  if (!allowed && !hostname.includes('tmz')) {
    throw new Error('host_not_allowed');
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000).unref();
  const response = await fetch(normalized, { signal: controller.signal });
  clearTimeout(timeout);
  if (!response.ok) {
    throw new Error(`image_${response.status}`);
  }
  const contentType = response.headers.get('content-type') || 'application/octet-stream';
  const buffer = Buffer.from(await response.arrayBuffer());
  return { buffer, contentType };
}

/* ============================ MEDIA ============================ */
const mediaRouter = express.Router();

const mediaImageUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 6 * 1024 * 1024 }
});

const mediaCommentUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 4 * 1024 * 1024 }
});

mediaRouter.get('/hiphop', async (req, res) => {
  const items = await fetchTmzHipHopFeed();
  res.json({ items });
});

mediaRouter.get('/stories', async (req, res) => {
  const viewer = await resolveViewerFromRequest(req);
  const docs = await MediaStory.find({}).sort({ updatedAt: -1 }).limit(120);
  const stories = docs.map((doc) => presentMediaStory(req, doc, viewer));
  res.json({ stories });
});

mediaRouter.get('/story', async (req, res) => {
  const { url, id, slug } = req.query || {};
  const viewer = await resolveViewerFromRequest(req);
  let storyDoc = null;
  if (id) {
    storyDoc = await MediaStory.findById(id);
  } else if (slug) {
    storyDoc = await MediaStory.findOne({ shareSlug: String(slug) });
  } else if (url) {
    storyDoc = await MediaStory.findOne({ url: sanitizeMediaUrl(String(url)) });
  }
  if (!storyDoc) {
    return res.status(404).json({ error: 'not_found' });
  }
  res.json({ story: presentMediaStory(req, storyDoc, viewer) });
});

mediaRouter.post('/summarize', auth, async (req, res) => {
  const { url, title, excerpt, image, publishedAt } = req.body || {};
  const normalizedUrl = sanitizeMediaUrl(url);
  if (!normalizedUrl) {
    return res.status(400).json({ error: 'url_required' });
  }

  let story = await MediaStory.findOne({ url: normalizedUrl });
  if (!story) {
    story = new MediaStory({ url: normalizedUrl, createdBy: req.user._id });
  }

  story.title = sanitizeMediaTitle(title) || story.title || 'Untitled';
  story.excerpt = sanitizeMediaExcerpt(excerpt) || story.excerpt || '';
  const sanitizedImage = sanitizeMediaUrl(image);
  if (sanitizedImage) {
    story.imageUrl = sanitizedImage;
  }
  const published = sanitizeMediaPublishedAt(publishedAt);
  if (published) {
    story.publishedAt = published;
  }
  story.updatedBy = req.user._id;

  const summaryResult = await summarizeMediaStory({
    title: story.title,
    excerpt: story.excerpt,
    url: story.url
  });

  if (summaryResult.text) {
    story.summary = summaryResult.text;
    story.summaryModel = summaryResult.model;
    story.summaryError = '';
  } else if (summaryResult.error) {
    story.summaryError = summaryResult.error;
  }

  await ensureMediaShareSlug(story);
  await story.save();

  res.json({
    story: presentMediaStory(req, story, req.user),
    summaryGenerated: Boolean(summaryResult.text),
    summaryError: summaryResult.error || ''
  });
});

mediaRouter.post('/stories/:id/image', auth, mediaImageUpload.single('image'), async (req, res) => {
  const { id } = req.params;
  const story = await MediaStory.findById(id);
  if (!story) {
    return res.status(404).json({ error: 'not_found' });
  }

  if (!req.file || !req.file.buffer) {
    return res.status(400).json({ error: 'image_required' });
  }

  const mimeType = normalizeMime(req.file.mimetype || '');
  if (!IMAGE_MIME_EXT[mimeType]) {
    return res.status(400).json({ error: 'unsupported_type' });
  }

  const ext = IMAGE_MIME_EXT[mimeType] || '.jpg';
  const key = `${MEDIA_STORAGE_PREFIX}/stories/${story._id}-${Date.now()}${ext}`;

  await writeBufferToUploads({ key, buffer: req.file.buffer, contentType: mimeType });

  story.watermarkedImageKey = key;
  const sourceUrl = sanitizeMediaUrl(req.body?.sourceUrl);
  if (sourceUrl && !story.imageUrl) {
    story.imageUrl = sourceUrl;
  }
  story.updatedBy = req.user._id;
  await story.save();

  res.json({ story: presentMediaStory(req, story, req.user) });
});

async function updateMediaReaction(req, res, type) {
  const { id } = req.params;
  const story = await MediaStory.findById(id);
  if (!story) {
    return res.status(404).json({ error: 'not_found' });
  }
  const userId = req.user._id.toString();
  const likes = new Set((story.likeUserIds || []).map((value) => value.toString()));
  const dislikes = new Set((story.dislikeUserIds || []).map((value) => value.toString()));

  if (type === 'like') {
    if (likes.has(userId)) {
      likes.delete(userId);
    } else {
      likes.add(userId);
      dislikes.delete(userId);
    }
  } else if (type === 'dislike') {
    if (dislikes.has(userId)) {
      dislikes.delete(userId);
    } else {
      dislikes.add(userId);
      likes.delete(userId);
    }
  }

  story.likeUserIds = Array.from(likes).map((value) => new mongoose.Types.ObjectId(value));
  story.dislikeUserIds = Array.from(dislikes).map((value) => new mongoose.Types.ObjectId(value));
  story.updatedBy = req.user._id;
  await story.save();

  res.json({ story: presentMediaStory(req, story, req.user) });
}

mediaRouter.post('/stories/:id/like', auth, (req, res) => updateMediaReaction(req, res, 'like'));
mediaRouter.post('/stories/:id/dislike', auth, (req, res) => updateMediaReaction(req, res, 'dislike'));

mediaRouter.get('/stories/:id/comments', async (req, res) => {
  const { id } = req.params;
  const story = await MediaStory.findById(id);
  if (!story) {
    return res.status(404).json({ error: 'not_found' });
  }
  const docs = await MediaComment.find({ storyId: story._id }).sort({ createdAt: -1 }).limit(200);
  const cache = new Map();
  const comments = [];
  for (const doc of docs) {
    // eslint-disable-next-line no-await-in-loop
    const payload = await presentMediaComment(req, doc, cache);
    if (payload) comments.push(payload);
  }
  res.json({ comments });
});

mediaRouter.post('/stories/:id/comments', auth, mediaCommentUpload.single('image'), async (req, res) => {
  const { id } = req.params;
  const story = await MediaStory.findById(id);
  if (!story) {
    return res.status(404).json({ error: 'not_found' });
  }

  const body = sanitizeMediaCommentBody(req.body?.body || '');
  if (!body && !req.file) {
    return res.status(400).json({ error: 'comment_required' });
  }

  let imageKey = '';
  if (req.file && req.file.buffer) {
    const mimeType = normalizeMime(req.file.mimetype || '');
    if (!IMAGE_MIME_EXT[mimeType]) {
      return res.status(400).json({ error: 'unsupported_type' });
    }
    const ext = IMAGE_MIME_EXT[mimeType] || '.jpg';
    imageKey = `${MEDIA_STORAGE_PREFIX}/comments/${story._id}/${Date.now()}-${crypto.randomBytes(4).toString('hex')}${ext}`;
    await writeBufferToUploads({ key: imageKey, buffer: req.file.buffer, contentType: mimeType });
  }

  const comment = new MediaComment({
    storyId: story._id,
    userId: req.user._id,
    body,
    imageStorageKey: imageKey
  });
  await comment.save();

  story.commentCount = Number(story.commentCount || 0) + 1;
  story.updatedBy = req.user._id;
  await story.save();

  const payload = await presentMediaComment(req, comment);
  res.status(201).json({ comment: payload });
});

mediaRouter.post('/proxy-image', auth, async (req, res) => {
  const { url } = req.body || {};
  try {
    const { buffer, contentType } = await fetchRemoteImage(url);
    res.setHeader('Content-Type', contentType);
    res.setHeader('Cache-Control', 'no-store');
    res.send(buffer);
  } catch (error) {
    res.status(400).json({ error: error.message || 'proxy_failed' });
  }
});

app.use('/api/media', mediaRouter);

function presentAlbumTrack(req, trackDoc, albumDoc) {
  if (!trackDoc) return null;
  const order = Number.isFinite(trackDoc.albumTrackOrder)
    ? trackDoc.albumTrackOrder
    : (Array.isArray(albumDoc?.trackIds)
      ? albumDoc.trackIds.find(entry => entry.trackId?.toString() === trackDoc._id?.toString())?.order || 0
      : 0);
  return {
    id: trackDoc._id,
    title: trackDoc.title || 'Untitled',
    order,
    url: presentStoredUploadUrl(req, trackDoc.audioUrl, trackDoc.audioUrl),
    duration: trackDoc.audioDurationSec || null,
    albumId: albumDoc?._id || null,
    source: trackDoc.source || 'upload',
    sourceId: trackDoc.sourceId || '',
    sourcePermalinkUrl: trackDoc.sourcePermalinkUrl || '',
    streamUrl: trackDoc.streamUrl || presentStoredUploadUrl(req, trackDoc.audioUrl, trackDoc.audioUrl),
    streamProtocol: trackDoc.streamProtocol || ''
  };
}

function presentAlbum(req, albumDoc, { ownerSummary = null, trackDocs = [] } = {}) {
  if (!albumDoc) return null;
  const cover = presentStoredUploadUrl(req, albumDoc.coverUrl, albumDoc.coverStorageKey);
  const tracks = [];
  if (Array.isArray(albumDoc.trackIds) && albumDoc.trackIds.length) {
    const trackMap = new Map(
      trackDocs.map(doc => [doc?._id?.toString(), doc])
    );
    const sortedRefs = albumDoc.trackIds
      .slice()
      .sort((a, b) => (Number(a?.order) || 0) - (Number(b?.order) || 0));
    for (const ref of sortedRefs) {
      const trackId = ref?.trackId?.toString?.();
      if (!trackId) continue;
      const trackDoc = trackMap.get(trackId);
      const payload = presentAlbumTrack(req, trackDoc, albumDoc);
      if (payload) {
        payload.order = Number(ref?.order) || payload.order || 0;
        tracks.push(payload);
      }
    }
  }

  return {
    id: albumDoc._id,
    title: albumDoc.title || 'Untitled Album',
    caption: albumDoc.caption || '',
    cover,
    coverStorageKey: albumDoc.coverStorageKey || '',
    source: albumDoc.source || '',
    sourceId: albumDoc.sourceId || '',
    sourcePermalinkUrl: albumDoc.sourcePermalinkUrl || '',
    createdAt: albumDoc.createdAt,
    updatedAt: albumDoc.updatedAt,
    userId: albumDoc.userId,
    ownerId: idToString(albumDoc.userId),
    user: ownerSummary,
    tracks,
    db: true
  };
}

function presentPlaylistTrack(req, trackDoc, playlistDoc) {
  if (!trackDoc) return null;
  const audioUrl = presentStoredUploadUrl(req, trackDoc.audioUrl, trackDoc.audioUrl);
  if (!audioUrl) return null;
  const order = Array.isArray(playlistDoc?.trackIds)
    ? playlistDoc.trackIds.find((entry) => entry?.trackId?.toString() === trackDoc._id?.toString())?.order || 0
    : 0;
  return {
    id: trackDoc._id,
    title: trackDoc.title || 'Untitled',
    order,
    url: audioUrl,
    duration: Number.isFinite(trackDoc.audioDurationSec) ? trackDoc.audioDurationSec : null,
    cover: presentStoredUploadUrl(req, trackDoc.coverUrl, trackDoc.coverUrl) || '',
    ownerId: idToString(trackDoc.userId),
    artist: trackDoc.artist || '',
    streamUrl: trackDoc.streamUrl || audioUrl,
    streamProtocol: trackDoc.streamProtocol || ''
  };
}

function presentPlaylist(req, playlistDoc, { ownerSummary = null, trackDocs = [] } = {}) {
  if (!playlistDoc) return null;
  const cover = presentStoredUploadUrl(req, playlistDoc.coverUrl, playlistDoc.coverStorageKey);
  const trackMap = new Map(trackDocs.map((doc) => [doc?._id?.toString(), doc]));
  const tracks = Array.isArray(playlistDoc.trackIds)
    ? playlistDoc.trackIds
        .slice()
        .sort((a, b) => (Number(a?.order) || 0) - (Number(b?.order) || 0))
        .map((ref) => presentPlaylistTrack(req, trackMap.get(ref?.trackId?.toString()), playlistDoc))
        .filter(Boolean)
    : [];

  return {
    id: playlistDoc._id,
    title: playlistDoc.title || 'Untitled Playlist',
    cover,
    coverStorageKey: playlistDoc.coverStorageKey || '',
    createdAt: playlistDoc.createdAt,
    updatedAt: playlistDoc.updatedAt,
    userId: playlistDoc.userId,
    ownerId: idToString(playlistDoc.userId),
    user: ownerSummary,
    tracks,
    trackCount: tracks.length
  };
}

function presentTrack(req, trackDoc, ownerSummary = null) {
  if (!trackDoc) return null;
  const audioUrl = presentStoredUploadUrl(req, trackDoc.audioUrl, trackDoc.audioUrl);
  if (!audioUrl) return null;
  const cover = presentStoredUploadUrl(req, trackDoc.coverUrl, trackDoc.coverUrl) || '';
  return {
    id: trackDoc._id,
    title: trackDoc.title || 'Untitled',
    caption: trackDoc.caption || '',
    audioUrl,
    coverUrl: cover,
    duration: Number.isFinite(trackDoc.audioDurationSec) ? trackDoc.audioDurationSec : null,
    artist: trackDoc.artist || '',
    bpm: Number.isFinite(trackDoc.bpm) ? trackDoc.bpm : 0,
    createdAt: trackDoc.createdAt,
    updatedAt: trackDoc.updatedAt,
    userId: trackDoc.userId,
    ownerId: idToString(trackDoc.userId),
    albumId: trackDoc.albumId || null,
    albumTrackOrder: Number.isFinite(trackDoc.albumTrackOrder) ? trackDoc.albumTrackOrder : null,
    source: trackDoc.source || 'upload',
    sourceId: trackDoc.sourceId || '',
    sourcePermalinkUrl: trackDoc.sourcePermalinkUrl || '',
    streamUrl: trackDoc.streamUrl || audioUrl,
    streamProtocol: trackDoc.streamProtocol || '',
    streamMimeType: trackDoc.streamMimeType || '',
    user: ownerSummary
  };
}

async function userSummary(reqOrUser, maybeUser) {
  const hasReq = maybeUser !== undefined;
  const req = hasReq ? reqOrUser : null;
  const u = hasReq ? maybeUser : reqOrUser;
  if (!u) return null;
  return {
    id: u._id,
    name: u.name,
    email: u.email,
    avatar: presentStoredUploadUrl(req, u.avatarUrl, u.avatarStorageKey),
    tagUrl: presentStoredUploadUrl(req, u.tagUrl, u.tagStorageKey),
    tagDurationSec: u.tagDurationSec,
    joinedAt: u.createdAt,
    firstName: u.firstName,
    lastName: u.lastName,
    displayName: u.displayName,
    profileColor: resolveProfileColor(u.profileColor)
  };
}

function resolveUserDisplayName(user) {
  if (!user) return '';
  const display = typeof user.displayName === 'string' ? user.displayName.trim() : '';
  if (display) return display;
  const first = typeof user.firstName === 'string' ? user.firstName.trim() : '';
  const last = typeof user.lastName === 'string' ? user.lastName.trim() : '';
  const combined = [first, last].filter(Boolean).join(' ').trim();
  if (combined) return combined;
  const name = typeof user.name === 'string' ? user.name.trim() : '';
  if (name) return name;
  const email = typeof user.email === 'string' ? user.email.trim() : '';
  if (email) return email;
  return '';
}

const SOUNDCLOUD_AUTHORIZE_URL = 'https://secure.soundcloud.com/authorize';
const SOUNDCLOUD_TOKEN_URL = 'https://api.soundcloud.com/oauth2/token';
const SOUNDCLOUD_API_BASE = 'https://api.soundcloud.com';
const SOUNDCLOUD_STATE_TTL_MS = 10 * 60 * 1000;
const SOUNDCLOUD_TOKEN_EXPIRY_BUFFER_MS = 60 * 1000;

const soundCloudAuthStates = new Map();

function soundCloudConfigured() {
  return Boolean(SOUNDCLOUD_CLIENT_ID && SOUNDCLOUD_CLIENT_SECRET && SOUNDCLOUD_REDIRECT_URI);
}

function pruneSoundCloudAuthStates() {
  const now = Date.now();
  for (const [state, entry] of soundCloudAuthStates.entries()) {
    if (!entry || now - (entry.createdAt || 0) > SOUNDCLOUD_STATE_TTL_MS) {
      soundCloudAuthStates.delete(state);
    }
  }
}

if (typeof setInterval === 'function') {
  const timer = setInterval(pruneSoundCloudAuthStates, SOUNDCLOUD_STATE_TTL_MS);
  if (typeof timer?.unref === 'function') timer.unref();
}

function normalizeSoundCloudRedirect(value) {
  if (!value || typeof value !== 'string') return '';
  const trimmed = value.trim();
  if (!trimmed) return '';
  try {
    const parsed = new URL(trimmed, PUBLIC_BASE_URL);
    if (!/^https?:$/.test(parsed.protocol)) return '';
    return parsed.toString();
  } catch {
    return '';
  }
}

function appendQueryParam(urlString, key, value) {
  if (!urlString) return '';
  try {
    const parsed = new URL(urlString);
    parsed.searchParams.set(key, value);
    return parsed.toString();
  } catch {
    try {
      const parsed = new URL(urlString, PUBLIC_BASE_URL);
      parsed.searchParams.set(key, value);
      return parsed.toString();
    } catch {
      if (urlString.includes('?')) {
        return `${urlString}&${encodeURIComponent(key)}=${encodeURIComponent(value)}`;
      }
      return `${urlString}?${encodeURIComponent(key)}=${encodeURIComponent(value)}`;
    }
  }
}

function registerSoundCloudState(state, { userId, redirectUrl = '' } = {}) {
  if (!state || !userId) return;
  soundCloudAuthStates.set(state, {
    userId: userId.toString(),
    redirectUrl: normalizeSoundCloudRedirect(redirectUrl),
    createdAt: Date.now()
  });
}

function consumeSoundCloudState(state) {
  if (!state) return null;
  const entry = soundCloudAuthStates.get(state);
  soundCloudAuthStates.delete(state);
  if (!entry) return null;
  if (!entry.userId) return null;
  const age = Date.now() - (entry.createdAt || 0);
  if (age > SOUNDCLOUD_STATE_TTL_MS) return null;
  return entry;
}

function parseSoundCloudScope(scopeValue) {
  if (!scopeValue) return [];
  if (Array.isArray(scopeValue)) return scopeValue.filter(Boolean).map(String);
  if (typeof scopeValue === 'string') {
    return scopeValue
      .split(/[\s,]+/)
      .map((part) => part.trim())
      .filter(Boolean);
  }
  return [];
}

function computeSoundCloudExpiry(expiresInSeconds) {
  if (!Number.isFinite(expiresInSeconds)) return null;
  const ms = Number(expiresInSeconds) * 1000;
  if (!Number.isFinite(ms) || ms <= 0) return null;
  return new Date(Date.now() + ms);
}

async function requestSoundCloudToken(params) {
  const form = new URLSearchParams({
    client_id: SOUNDCLOUD_CLIENT_ID,
    client_secret: SOUNDCLOUD_CLIENT_SECRET,
    ...params
  });

  const response = await fetch(SOUNDCLOUD_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form.toString()
  });

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`SoundCloud token request failed (${response.status}): ${text || response.statusText}`);
  }

  return response.json();
}

async function exchangeSoundCloudCode(code) {
  return requestSoundCloudToken({
    grant_type: 'authorization_code',
    code,
    redirect_uri: SOUNDCLOUD_REDIRECT_URI
  });
}

async function refreshSoundCloudTokens(refreshToken) {
  return requestSoundCloudToken({
    grant_type: 'refresh_token',
    refresh_token: refreshToken
  });
}

async function ensureFreshSoundCloudAccess(account, { forceRefresh = false } = {}) {
  if (!account) {
    throw new Error('SoundCloud account missing');
  }

  const expiresAt = account.expiresAt ? new Date(account.expiresAt).getTime() : 0;
  const now = Date.now();
  if (!forceRefresh && account.accessToken) {
    if (!expiresAt || expiresAt - SOUNDCLOUD_TOKEN_EXPIRY_BUFFER_MS > now) {
      return account.accessToken;
    }
  }

  if (!account.refreshToken) {
    if (account.accessToken && !forceRefresh) {
      return account.accessToken;
    }
    throw new Error('SoundCloud session expired');
  }

  const refreshed = await refreshSoundCloudTokens(account.refreshToken);
  account.accessToken = refreshed.access_token || account.accessToken;
  if (refreshed.refresh_token) {
    account.refreshToken = refreshed.refresh_token;
  }
  account.scope = parseSoundCloudScope(refreshed.scope);
  account.expiresAt = computeSoundCloudExpiry(refreshed.expires_in);
  await account.save();
  return account.accessToken;
}

async function soundCloudFetch(account, path, { method = 'GET', query = null, headers = {}, body = null } = {}, attempt = 0) {
  if (!account) throw new Error('SoundCloud account missing');

  const accessToken = await ensureFreshSoundCloudAccess(account, { forceRefresh: attempt > 1 });
  const hasAbsolute = typeof path === 'string' && /^https?:\/\//i.test(path);
  const url = new URL(hasAbsolute ? path : `${SOUNDCLOUD_API_BASE}${path}`);
  if (query && typeof query === 'object') {
    for (const [key, value] of Object.entries(query)) {
      if (value === undefined || value === null) continue;
      url.searchParams.set(key, String(value));
    }
  }

  const requestHeaders = new Headers({ Authorization: `OAuth ${accessToken}` });
  if (headers && typeof headers === 'object') {
    for (const [key, value] of Object.entries(headers)) {
      if (value === undefined || value === null) continue;
      requestHeaders.set(key, value);
    }
  }

  let bodyPayload = undefined;
  if (body !== null && body !== undefined) {
    if (typeof body === 'string' || body instanceof URLSearchParams) {
      bodyPayload = body;
    } else {
      bodyPayload = JSON.stringify(body);
      if (!requestHeaders.has('Content-Type')) {
        requestHeaders.set('Content-Type', 'application/json');
      }
    }
  }

  const response = await fetch(url, {
    method,
    headers: requestHeaders,
    body: bodyPayload
  });

  if (response.status === 401 && attempt < 2) {
    if (account.refreshToken) {
      await ensureFreshSoundCloudAccess(account, { forceRefresh: true });
      return soundCloudFetch(account, path, { method, query, headers, body }, attempt + 1);
    }
  }

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`SoundCloud API ${response.status}: ${text || response.statusText}`);
  }

  const contentType = response.headers.get('content-type') || '';
  if (contentType.includes('application/json')) {
    return response.json();
  }
  return response.text();
}

function normalizeSoundCloudArtworkUrl(url) {
  if (!url || typeof url !== 'string') return '';
  let normalized = url.trim();
  if (!normalized) return '';
  normalized = normalized.replace('http://', 'https://');
  if (normalized.includes('-large.')) {
    normalized = normalized.replace('-large.', '-t500x500.');
  }
  return normalized;
}

async function persistSoundCloudArtwork(url, { prefix = 'covers/soundcloud' } = {}) {
  const normalized = normalizeSoundCloudArtworkUrl(url);
  if (!normalized) return null;
  try {
    const response = await fetch(normalized);
    if (!response.ok) {
      return null;
    }
    const arrayBuffer = await response.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    const contentType = response.headers.get('content-type') || 'image/jpeg';
    const mimeExt = mimeExtension(contentType) || ''; // returns without dot
    let extension = mimeExt ? (mimeExt.startsWith('.') ? mimeExt : `.${mimeExt}`) : '';
    if (!extension) {
      try {
        const parsed = new URL(normalized);
        extension = path.extname(parsed.pathname) || '.jpg';
      } catch {
        extension = '.jpg';
      }
    }
    const key = `${prefix}/${crypto.randomUUID().replace(/-/g, '')}${extension}`;
    await writeBufferToUploads({ key, buffer, contentType });
    return { key, size: buffer.length, contentType };
  } catch (error) {
    console.warn('Failed to persist SoundCloud artwork', error);
    return null;
  }
}

function sanitizeSoundCloudCaption(value) {
  if (typeof value !== 'string') return '';
  const trimmed = value.trim();
  if (!trimmed) return '';
  return trimmed.slice(0, 500);
}

function soundCloudDurationMsToSeconds(ms) {
  if (!Number.isFinite(ms)) return null;
  const seconds = Number(ms) / 1000;
  if (!Number.isFinite(seconds)) return null;
  return Math.round(seconds * 1000) / 1000;
}

async function resolveSoundCloudStream(account, track) {
  if (!track) return null;
  const transcodings = track?.media?.transcodings;
  if (!Array.isArray(transcodings) || !transcodings.length) return null;
  const preferred = transcodings.find((entry) => entry?.format?.protocol === 'hls') || transcodings[0];
  if (!preferred?.url) return null;
  const resolved = await soundCloudFetch(account, preferred.url);
  const streamUrl = typeof resolved === 'object' ? resolved?.url : null;
  if (!streamUrl) return null;
  return {
    url: streamUrl,
    protocol: preferred?.format?.protocol || '',
    mimeType: preferred?.format?.mime_type || '',
    preset: preferred?.preset || ''
  };
}

function resolveSoundCloudTrackArtist(track) {
  if (!track) return '';
  const metadataArtist = track?.publisher_metadata?.artist;
  if (metadataArtist) return metadataArtist;
  const userArtist = track?.user?.username || track?.user?.full_name;
  if (userArtist) return userArtist;
  return '';
}

function mapSoundCloudTrackCatalog(track, existingDoc) {
  if (!track) return null;
  const duration = soundCloudDurationMsToSeconds(track.duration);
  return {
    id: track.id,
    title: track.title,
    permalinkUrl: track.permalink_url || '',
    artworkUrl: normalizeSoundCloudArtworkUrl(track.artwork_url || track.user?.avatar_url || ''),
    bpm: Number.isFinite(track.bpm) ? Number(track.bpm) : null,
    duration: duration || null,
    description: sanitizeSoundCloudCaption(track.description || ''),
    createdAt: track.created_at || null,
    importedTrackId: existingDoc ? existingDoc._id : null,
    updatedAt: track.last_modified || track.display_date || null
  };
}

function mapSoundCloudPlaylistCatalog(playlist, existingDoc) {
  if (!playlist) return null;
  return {
    id: playlist.id,
    title: playlist.title || playlist.name,
    type: playlist.playlist_type || '',
    trackCount: playlist.track_count || (Array.isArray(playlist.tracks) ? playlist.tracks.length : 0),
    permalinkUrl: playlist.permalink_url || '',
    artworkUrl: normalizeSoundCloudArtworkUrl(playlist.artwork_url || playlist.user?.avatar_url || ''),
    description: sanitizeSoundCloudCaption(playlist.description || ''),
    importedAlbumId: existingDoc ? existingDoc._id : null
  };
}

async function importSoundCloudTrack({ account, userDoc, trackId, trackData = null }) {
  const scTrack = trackData && trackData.id ? trackData : await soundCloudFetch(account, `/tracks/${trackId}`);
  if (!scTrack || !scTrack.id) {
    throw new Error('SoundCloud track not found');
  }

  const stream = await resolveSoundCloudStream(account, scTrack);
  if (!stream?.url) {
    throw new Error('SoundCloud track does not have a playable stream');
  }

  let artworkKey = null;
  const artworkCandidate = scTrack.artwork_url || scTrack.user?.avatar_url || '';
  if (artworkCandidate) {
    const stored = await persistSoundCloudArtwork(artworkCandidate, { prefix: 'covers/soundcloud' });
    artworkKey = stored?.key || null;
  }

  const caption = sanitizeSoundCloudCaption(scTrack.description || '');
  const bpm = Number.isFinite(scTrack.bpm) ? Math.max(0, Math.min(Number(scTrack.bpm), 999)) : 0;
  const durationSec = soundCloudDurationMsToSeconds(scTrack.duration) || 0;
  const artist = resolveSoundCloudTrackArtist(scTrack) || resolveArtistFromUser(userDoc) || userDoc.email;

  const query = {
    userId: userDoc._id,
    source: 'soundcloud',
    sourceId: String(scTrack.id)
  };

  const existingDoc = await Track.findOne(query);
  const update = {
    $set: {
      title: scTrack.title || 'Untitled',
      artist,
      bpm,
      audioUrl: stream.url,
      audioDurationSec: durationSec,
      caption,
      source: 'soundcloud',
      sourceId: String(scTrack.id),
      sourcePermalinkUrl: scTrack.permalink_url || '',
      sourceData: {
        track: {
          id: scTrack.id,
          permalink_url: scTrack.permalink_url || '',
          uri: scTrack.uri || '',
          waveform_url: scTrack.waveform_url || ''
        }
      },
      streamUrl: stream.url,
      streamProtocol: stream.protocol || '',
      streamMimeType: stream.mimeType || '',
      bumpedAt: new Date()
    },
    $setOnInsert: {
      userId: userDoc._id,
      createdAt: new Date()
    }
  };

  if (artworkKey) {
    update.$set.coverUrl = artworkKey;
  }

  const updatedDoc = await Track.findOneAndUpdate(query, update, {
    upsert: true,
    new: true,
    setDefaultsOnInsert: true
  });

  if (artworkKey && existingDoc?.coverUrl && existingDoc.coverUrl !== artworkKey) {
    await deleteUploadKey(existingDoc.coverUrl).catch(() => {});
  }

  return { trackDoc: updatedDoc, scTrack, stream };
}

async function importSoundCloudPlaylist({ account, userDoc, playlistId }) {
  const playlist = await soundCloudFetch(account, `/playlists/${playlistId}`);
  if (!playlist || !playlist.id) {
    throw new Error('SoundCloud playlist not found');
  }

  const playlistTracks = Array.isArray(playlist.tracks) ? playlist.tracks : [];
  const importedTracks = [];
  for (let index = 0; index < playlistTracks.length; index += 1) {
    const entry = playlistTracks[index];
    const scTrackId = entry?.id || entry;
    if (!scTrackId) continue;
    try {
      const { trackDoc } = await importSoundCloudTrack({ account, userDoc, trackId: scTrackId, trackData: entry });
      if (trackDoc) {
        trackDoc.albumId = null;
        trackDoc.albumTrackOrder = index;
        importedTracks.push(trackDoc);
      }
    } catch (err) {
      console.warn('SoundCloud track import failed within playlist', scTrackId, err);
    }
  }

  const trackRefs = importedTracks.map((doc, idx) => ({ trackId: doc._id, order: idx }));

  let coverStorageKey = null;
  const artworkCandidate = playlist.artwork_url || playlist.user?.avatar_url || '';
  if (artworkCandidate) {
    const stored = await persistSoundCloudArtwork(artworkCandidate, { prefix: 'covers/soundcloud-albums' });
    coverStorageKey = stored?.key || null;
  } else if (importedTracks[0]?.coverUrl) {
    coverStorageKey = importedTracks[0].coverUrl;
  }

  const caption = sanitizeSoundCloudCaption(playlist.description || '');

  const query = {
    userId: userDoc._id,
    source: 'soundcloud',
    sourceId: String(playlist.id)
  };

  const existingAlbum = await Album.findOne(query);

  const update = {
    $set: {
      title: playlist.title || playlist.name || 'Untitled Album',
      caption,
      trackIds: trackRefs,
      source: 'soundcloud',
      sourceId: String(playlist.id),
      sourcePermalinkUrl: playlist.permalink_url || '',
      sourceData: {
        playlist_type: playlist.playlist_type || '',
        track_count: playlist.track_count || trackRefs.length
      }
    },
    $setOnInsert: {
      userId: userDoc._id,
      createdAt: new Date()
    }
  };

  if (coverStorageKey) {
    update.$set.coverStorageKey = coverStorageKey;
    update.$set.coverUrl = coverStorageKey;
  }

  const albumDoc = await Album.findOneAndUpdate(query, update, {
    upsert: true,
    new: true,
    setDefaultsOnInsert: true
  });

  if (coverStorageKey && existingAlbum?.coverStorageKey && existingAlbum.coverStorageKey !== coverStorageKey) {
    await deleteUploadKey(existingAlbum.coverStorageKey).catch(() => {});
  }

  if (albumDoc?._id && trackRefs.length) {
    await Promise.all(trackRefs.map((ref) => {
      if (!ref?.trackId) return Promise.resolve();
      return Track.updateOne({ _id: ref.trackId }, {
        albumId: albumDoc._id,
        albumTrackOrder: ref.order
      });
    }));
  }

  return { albumDoc, importedTracks };
}

function presentStudioSound(req, doc, ownerSummary = null) {
  if (!doc) return null;
  const storageKey = typeof doc.storageKey === 'string' ? doc.storageKey : '';
  const fallback = typeof doc.fileUrl === 'string' ? doc.fileUrl : '';
  const url = storageKey ? publicUploadUrl(req, storageKey) : publicUploadUrl(req, fallback);
  const ownerId = idToString(doc.userId);
  const owner = ownerSummary ? {
    id: ownerSummary.id,
    name: ownerSummary.name,
    displayName: ownerSummary.displayName,
    firstName: ownerSummary.firstName,
    lastName: ownerSummary.lastName,
    profileColor: ownerSummary.profileColor
  } : null;
  const ownerDisplay = resolveUserDisplayName(ownerSummary);
  return {
    id: doc._id,
    type: doc.type,
    name: doc.name,
    url,
    ownerId,
    ownerDisplay,
    owner,
    size: typeof doc.size === 'number' ? doc.size : null,
    durationSec: typeof doc.durationSec === 'number' ? doc.durationSec : null,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt
  };
}

function asObjectId(value) {
  if (!value) return null;
  try {
    return new mongoose.Types.ObjectId(value);
  } catch {
    return null;
  }
}

function idToString(value) {
  if (!value) return null;
  try {
    if (typeof value === 'string') {
      const trimmed = value.trim();
      return trimmed && trimmed !== 'null' && trimmed !== 'undefined' ? trimmed : null;
    }
    if (value instanceof mongoose.Types.ObjectId) {
      return value.toString();
    }
    if (typeof value === 'object' && typeof value.toString === 'function') {
      const str = value.toString();
      return str && str !== '[object Object]' ? str : null;
    }
  } catch {
    return null;
  }
  return null;
}

function conversationKeyFor(a, b) {
  const left = asObjectId(a);
  const right = asObjectId(b);
  if (!left || !right) return null;
  const [first, second] = [left.toString(), right.toString()].sort();
  return `${first}:${second}`;
}

function sanitizeMessageBody(value) {
  if (typeof value !== 'string') return '';
  const trimmed = value.trim();
  if (!trimmed) return '';
  return trimmed.slice(0, 2000);
}

function attachmentTypeFor(mimeType) {
  const normalized = normalizeMime(mimeType);
  if (!normalized) return 'audio';
  if (IMAGE_MIME_EXT[normalized]) return 'image';
  return 'audio';
}

function presentMessageAttachment(req, attachment) {
  if (!attachment || !attachment.fileName) return null;
  const mimeType = attachment.mimeType || '';
  const raw = attachment.fileName;
  const hasPrefix = typeof raw === 'string' && raw.includes('/');
  const key = hasPrefix ? normalizeUploadKey(raw) : '';
  return {
    url: hasPrefix ? (key ? publicUploadUrl(req, key) : '') : publicUploadUrl(req, 'messages', raw),
    mimeType,
    type: attachment.type || attachmentTypeFor(mimeType),
    originalName: attachment.originalName || '',
    size: Number.isFinite(attachment.size) ? attachment.size : 0
  };
}

function presentMessage(req, doc, viewerId) {
  if (!doc) return null;
  const raw = typeof doc.toObject === 'function' ? doc.toObject() : doc;
  const senderId = idToString(raw.senderId);
  const recipientId = idToString(raw.recipientId);
  const deletedAt = raw.deletedAt ? new Date(raw.deletedAt) : null;
  const attachments = Array.isArray(raw.attachments)
    ? raw.attachments.map(att => presentMessageAttachment(req, att)).filter(Boolean)
    : [];

  return {
    id: idToString(raw._id),
    senderId,
    recipientId,
    body: deletedAt ? '' : (raw.body || ''),
    attachments: deletedAt ? [] : attachments,
    createdAt: raw.createdAt || null,
    updatedAt: raw.updatedAt || raw.createdAt || null,
    editedAt: raw.editedAt || null,
    deletedAt,
    isSender: viewerId ? idToString(viewerId) === senderId : false
  };
}

function normalizeUserForConversation(summary, fallback = {}, req) {
  if (!summary && !fallback) return null;
  const base = summary || {};
  const alt = fallback || {};
  const avatarValue = base.avatar || alt.avatarUrl || '';
  const avatarStorageKey = base.avatarStorageKey || alt.avatarStorageKey || '';
  return {
    id: idToString(base.id) || idToString(alt._id) || idToString(alt.id),
    name: base.name || alt.name || '',
    email: base.email || alt.email || '',
    avatar: presentStoredUploadUrl(req, avatarValue, avatarStorageKey),
    displayName: base.displayName || alt.displayName || '',
    firstName: base.firstName || alt.firstName || '',
    lastName: base.lastName || alt.lastName || '',
    joinedAt: base.joinedAt || alt.createdAt || alt.joinedAt || null,
    profileColor: resolveProfileColor(base.profileColor || alt.profileColor)
  };
}

function sanitizeCount(value) {
  const num = Number(value);
  if (!Number.isFinite(num) || num <= 0) return 0;
  return Math.floor(num);
}

function coerceDate(value) {
  if (!value) return null;
  if (value instanceof Date) {
    const time = value.getTime();
    return Number.isFinite(time) ? value : null;
  }
  if (typeof value === 'number') {
    const num = Number(value);
    if (!Number.isFinite(num)) return null;
    if (num > 1e12) return new Date(num);
    if (num > 1e9) return new Date(num * 1000);
    return new Date(num);
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return null;
    if (/^\d+(?:\.\d+)?$/.test(trimmed)) {
      return coerceDate(Number(trimmed));
    }
    const parsed = Date.parse(trimmed);
    if (!Number.isNaN(parsed)) return new Date(parsed);
  }
  return null;
}

function statsSummary(doc) {
  if (!doc) {
    return { plays: 0, likes: 0, reposts: 0, comments: 0 };
  }
  const { plays = 0, likes = 0, reposts = 0, comments = 0 } = doc;
  return {
    plays: Number(plays) || 0,
    likes: Number(likes) || 0,
    reposts: Number(reposts) || 0,
    comments: Number(comments) || 0
  };
}

async function trackById(id) {
  if (!id) return null;
  return Track.findById(id);
}

async function incrementTrackStats({
  trackId,
  userId,
  field,
  count = 1,
  type,
  metadata = {},
  skipEvent = false
}) {
  const inc = sanitizeCount(count) || 0;
  if (!trackId || !userId || !field || !type || inc <= 0) {
    const existing = await TrackStat.findOne({ trackId });
    return existing || await TrackStat.findOneAndUpdate(
      { trackId },
      { $setOnInsert: { trackId } },
      { new: true, upsert: true }
    );
  }

  const update = { $inc: { [field]: inc }, $setOnInsert: { trackId } };
  const stats = await TrackStat.findOneAndUpdate({ trackId }, update, { new: true, upsert: true });

  if (!skipEvent) {
    const timestamp = coerceDate(metadata.timestamp) || new Date();
    const meta = { ...metadata };
    delete meta.timestamp;
    if (!meta.source) meta.source = 'live';
    try {
      await TrackEvent.create({
        trackId,
        userId,
        type,
        count: inc,
        createdAt: timestamp,
        metadata: meta
      });
    } catch (err) {
      console.warn('Failed to record track event', err);
    }
  }

  return stats;
}

function commentSummary(req, doc) {
  if (!doc) return null;
  const snapshot = doc.userSnapshot || {};
  return {
    id: doc._id,
    text: doc.text,
    time: Number(doc.timeSec) || 0,
    createdAt: doc.createdAt,
    userId: doc.userId,
    user: snapshot?.email || '',
    displayName: snapshot?.displayName || snapshot?.name || '',
    avatar: presentStoredUploadUrl(req, snapshot?.avatar, snapshot?.avatarStorageKey),
    clientId: doc.clientId || null
  };
}

function commentSnapshot(req, user) {
  if (!user) {
    return { name: '', displayName: '', email: '', avatar: '', avatarStorageKey: '' };
  }
  return {
    name: typeof user.name === 'string' ? user.name : '',
    displayName: typeof user.displayName === 'string' ? user.displayName : '',
    email: typeof user.email === 'string' ? user.email : '',
    avatar: presentStoredUploadUrl(req, user.avatarUrl, user.avatarStorageKey),
    avatarStorageKey: typeof user.avatarStorageKey === 'string' ? user.avatarStorageKey : ''
  };
}

function computeLeaderboardScore(stats) {
  const plays = Number(stats?.plays) || 0;
  const comments = Number(stats?.comments) || 0;
  const likes = Number(stats?.likes) || 0;
  const reposts = Number(stats?.reposts) || 0;

  const playsScore = plays * LEADERBOARD_WEIGHTS.plays;
  const commentsScore = comments * LEADERBOARD_WEIGHTS.comments;
  const likesQualified = likes >= LEADERBOARD_THRESHOLDS.likes;
  const repostQualified = reposts >= LEADERBOARD_THRESHOLDS.reposts;
  const likesScore = likesQualified ? likes * LEADERBOARD_WEIGHTS.likes : 0;
  const repostScore = repostQualified ? reposts * LEADERBOARD_WEIGHTS.reposts : 0;

  let baseScore = playsScore + commentsScore + likesScore + repostScore;
  let categoriesActive = 0;
  if (plays > 0) categoriesActive += 1;
  if (comments > 0) categoriesActive += 1;
  if (likesQualified) categoriesActive += 1;
  if (repostQualified) categoriesActive += 1;
  if (categoriesActive >= 3) {
    baseScore += Math.round(baseScore * 0.2);
  }
  if (likesQualified && repostQualified) {
    baseScore += Math.round((likesScore + repostScore) * 0.6);
  }
  return baseScore;
}

function toIdString(value) {
  if (!value) return null;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed || trimmed === 'null' || trimmed === 'undefined' || trimmed === '[object Object]') {
      return null;
    }
    const match = trimmed.match(/([0-9a-f]{24})/i);
    return match ? match[1].toLowerCase() : trimmed;
  }
  if (typeof value === 'number') {
    return Number.isFinite(value) ? String(value) : null;
  }
  if (typeof value === 'object') {
    if (value instanceof mongoose.Types.ObjectId) {
      return value.toHexString();
    }
    if (typeof value.$oid === 'string') return toIdString(value.$oid);
    if (typeof value._id !== 'undefined') {
      const nested = value._id;
      if (nested && nested !== value) return toIdString(nested);
    }
    if (typeof value.id !== 'undefined') {
      const nested = value.id;
      if (nested && nested !== value) return toIdString(nested);
    }
    if (typeof value.toHexString === 'function') return toIdString(value.toHexString());
    if (typeof value.toString === 'function' && value.toString !== Object.prototype.toString) {
      const str = value.toString();
      if (str && str !== '[object Object]') {
        const match = str.match(/([0-9a-f]{24})/i);
        return match ? match[1].toLowerCase() : str;
      }
    }
  }
  const str = String(value);
  if (!str || str === 'null' || str === 'undefined' || str === '[object Object]') return null;
  const match = str.match(/([0-9a-f]{24})/i);
  return match ? match[1].toLowerCase() : str;
}

function ensureGridShape(sessionDoc) {
  if (!sessionDoc.grid || typeof sessionDoc.grid !== 'object') {
    sessionDoc.grid = { rows: 8, cols: 16, map: {} };
  }
  if (!sessionDoc.grid.map || typeof sessionDoc.grid.map !== 'object') {
    sessionDoc.grid.map = {};
  }
  return sessionDoc.grid;
}

function ensurePlayerColors(sessionDoc, userId) {
  if (!sessionDoc.playerColors || typeof sessionDoc.playerColors !== 'object') {
    sessionDoc.playerColors = {};
  }
  const primary = toIdString(userId);
  const fallbackRaw = String(userId ?? '').trim();
  const fallback = (!fallbackRaw || fallbackRaw === 'null' || fallbackRaw === 'undefined' || fallbackRaw === '[object Object]')
    ? null
    : fallbackRaw;
  if (primary && sessionDoc.playerColors[primary]) return sessionDoc.playerColors[primary];
  if (primary && fallback && sessionDoc.playerColors[fallback]) {
    sessionDoc.playerColors[primary] = sessionDoc.playerColors[fallback];
    delete sessionDoc.playerColors[fallback];
    if (typeof sessionDoc.markModified === 'function') sessionDoc.markModified('playerColors');
    return sessionDoc.playerColors[primary];
  }
  if (!primary && fallback && sessionDoc.playerColors[fallback]) return sessionDoc.playerColors[fallback];
  const used = new Set(Object.values(sessionDoc.playerColors || {}));
  let color = PLAYER_COLOR_PALETTE.find(c => !used.has(c));
  if (!color) {
    color = `#${crypto.randomBytes(3).toString('hex')}`;
  }
  const key = primary || fallback;
  if (key) {
    sessionDoc.playerColors[key] = color;
    if (typeof sessionDoc.markModified === 'function') {
      sessionDoc.markModified('playerColors');
    }
  }
  return color;
}

function participantKey(value) {
  const normalized = toIdString(value);
  if (normalized) return normalized;
  const raw = String(value ?? '').trim();
  if (!raw || raw === 'null' || raw === 'undefined' || raw === '[object Object]') {
    return null;
  }
  return raw;
}

function ensureParticipantHistory(sessionDoc, userId) {
  if (!Array.isArray(sessionDoc.participantsHistory)) {
    sessionDoc.participantsHistory = [];
  }
  const key = participantKey(userId);
  if (!key) return false;
  const exists = sessionDoc.participantsHistory.some(entry => participantKey(entry) === key);
  if (exists) return false;
  sessionDoc.participantsHistory.push(userId);
  if (typeof sessionDoc.markModified === 'function') {
    sessionDoc.markModified('participantsHistory');
  }
  return true;
}

async function rosterFor(sessionDoc, req) {
  const ids = (sessionDoc.participants || []).map(id => new mongoose.Types.ObjectId(id));
  if (!ids.length) return [];
  const users = await User.find({ _id: { $in: ids } }).select('name email avatarUrl avatarStorageKey tagUrl tagStorageKey createdAt profileColor');
  return users.map(u => ({
    id: u._id,
    name: u.name,
    email: u.email,
    avatar: presentStoredUploadUrl(req, u.avatarUrl, u.avatarStorageKey),
    tagUrl: presentStoredUploadUrl(req, u.tagUrl, u.tagStorageKey),
    joinedAt: u.createdAt,
    profileColor: resolveProfileColor(u.profileColor),
    color: (() => {
      const idStr = toIdString(u._id);
      if (idStr && sessionDoc.playerColors?.[idStr]) return sessionDoc.playerColors[idStr];
      const fallback = String(u._id ?? '').trim();
      if (!fallback || fallback === 'null' || fallback === 'undefined' || fallback === '[object Object]') return null;
      return sessionDoc.playerColors?.[fallback] || null;
    })()
  }));
}

async function participantHistoryFor(sessionDoc, req) {
  const rawKeys = [];
  for (const entry of sessionDoc.participantsHistory || []) {
    const key = participantKey(entry);
    if (key && !rawKeys.includes(key)) rawKeys.push(key);
  }
  if (!rawKeys.length) return [];
  const objectIds = rawKeys
    .map(key => {
      try {
        return new mongoose.Types.ObjectId(key);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
  if (!objectIds.length) return [];
  const users = await User.find({ _id: { $in: objectIds } }).select('name email avatarUrl avatarStorageKey tagUrl tagStorageKey createdAt profileColor');
  const userMap = new Map(users.map(u => [participantKey(u._id), u]));
  const ordered = [];
  const seen = new Set();
  for (const key of rawKeys) {
    if (seen.has(key)) continue;
    const user = userMap.get(key);
    if (!user) continue;
    seen.add(key);
    ordered.push({
      id: user._id,
      name: user.name,
      email: user.email,
      avatar: presentStoredUploadUrl(req, user.avatarUrl, user.avatarStorageKey),
      tagUrl: presentStoredUploadUrl(req, user.tagUrl, user.tagStorageKey),
      joinedAt: user.createdAt,
      profileColor: resolveProfileColor(user.profileColor)
    });
  }
  return ordered;
}

/* ============================ AUTH ============================ */
app.post('/api/auth/signup', async (req, res) => {
  const { name, email, password, avatarUrl, firstName, lastName, displayName } = req.body || {};
  const normalizedEmail = normalizeEmail(email);
  const passwordValue = typeof password === 'string' ? password : '';
  if (!normalizedEmail || !passwordValue) {
    return res.status(400).json({ error: 'email & password required' });
  }

  const exists = await User.findOne({ email: normalizedEmail });
  if (exists) return res.status(409).json({ error: 'email already exists' });

  const providedName = typeof name === 'string' ? name.trim() : '';
  let finalName = providedName || normalizedEmail.split('@')[0];
  if (finalName) {
    const nameTaken = await User.exists({ name: finalName });
    if (nameTaken) return res.status(409).json({ error: 'username already taken' });
  }

  const first = typeof firstName === 'string' ? firstName.trim() : '';
  const last = typeof lastName === 'string' ? lastName.trim() : '';
  const display = (() => {
    if (typeof displayName === 'string' && displayName.trim()) return displayName.trim();
    const combined = [first, last].filter(Boolean).join(' ').trim();
    if (combined) return combined;
    if (providedName) return providedName;
    if (finalName) return finalName;
    return normalizedEmail.split('@')[0];
  })();

  const passwordHash = await bcrypt.hash(passwordValue, 10);
  const user = await User.create({
    name: finalName,
    email: normalizedEmail,
    passwordHash,
    avatarUrl: typeof avatarUrl === 'string' ? avatarUrl : '',
    firstName: first,
    lastName: last,
    displayName: display
  });
  res.json({ token: sign(user), user: await userSummary(req, user) });
});

app.post('/api/auth/login', async (req, res) => {
  const { email, password } = req.body || {};
  const normalizedEmail = normalizeEmail(email);
  const passwordValue = typeof password === 'string' ? password : '';
  if (!normalizedEmail || !passwordValue) {
    return res.status(400).json({ error: 'email & password required' });
  }
  const user = await User.findOne({ email: normalizedEmail });
  if (!user) return res.status(401).json({ error: 'invalid credentials' });
  if (!user.passwordHash) return res.status(401).json({ error: 'invalid credentials' });
  const ok = await bcrypt.compare(passwordValue, user.passwordHash);
  if (!ok) return res.status(401).json({ error: 'invalid credentials' });
  res.json({ token: sign(user), user: await userSummary(req, user) });
});

app.get('/api/auth/me', auth, async (req, res) => {
  res.json({ user: await userSummary(req, req.user) });
});

/* ============================ SoundCloud integration ============================ */
app.get('/api/integrations/soundcloud/session', auth, async (req, res) => {
  try {
    if (!soundCloudConfigured()) {
      return res.json({ available: false, connected: false });
    }

    const account = await SoundCloudAccount.findOne({ userId: req.user._id });
    if (!account) {
      return res.json({
        available: true,
        connected: false,
        account: null
      });
    }

    const avatarUrl = account.avatarStorageKey
      ? publicUploadUrl(req, account.avatarStorageKey)
      : account.avatarUrl || '';

    res.json({
      available: true,
      connected: true,
      account: {
        username: account.username || '',
        permalinkUrl: account.permalinkUrl || '',
        avatar: avatarUrl,
        scope: account.scope || [],
        expiresAt: account.expiresAt,
        lastSyncAt: account.lastSyncAt,
        soundcloudUserId: account.soundcloudUserId || null
      }
    });
  } catch (err) {
    console.error('SoundCloud session lookup failed', err);
    res.status(500).json({ error: 'soundcloud session lookup failed' });
  }
});

app.get('/api/integrations/soundcloud/authorize', auth, (req, res) => {
  if (!soundCloudConfigured() || !SOUNDCLOUD_REDIRECT_URI) {
    return res.status(503).json({ error: 'soundcloud integration unavailable' });
  }

  const redirectParam = typeof req.query?.redirect === 'string' ? req.query.redirect : '';
  const state = crypto.randomBytes(24).toString('hex');
  registerSoundCloudState(state, { userId: req.user._id, redirectUrl: redirectParam });

  const authorizeUrl = new URL(SOUNDCLOUD_AUTHORIZE_URL);
  authorizeUrl.searchParams.set('client_id', SOUNDCLOUD_CLIENT_ID);
  authorizeUrl.searchParams.set('response_type', 'code');
  authorizeUrl.searchParams.set('redirect_uri', SOUNDCLOUD_REDIRECT_URI);
  authorizeUrl.searchParams.set('scope', '*');
  authorizeUrl.searchParams.set('state', state);

  res.json({ url: authorizeUrl.toString(), state });
});

app.get('/api/integrations/soundcloud/callback', async (req, res) => {
  if (!soundCloudConfigured()) {
    return res.status(503).send('SoundCloud integration disabled');
  }

  const { code, state, error: errorParam } = req.query || {};

  if (errorParam) {
    const stateEntry = state ? consumeSoundCloudState(state) : null;
    const failureBase = stateEntry?.redirectUrl || normalizeSoundCloudRedirect(SOUNDCLOUD_FAILURE_REDIRECT) || '';
    if (failureBase) {
      return res.redirect(appendQueryParam(failureBase, 'error', String(errorParam)));
    }
    return res.status(400).send(`SoundCloud authorization failed: ${errorParam}`);
  }

  if (!code || !state) {
    return res.status(400).send('Missing authorization code or state');
  }

  const stateEntry = consumeSoundCloudState(state);
  if (!stateEntry) {
    return res.status(400).send('SoundCloud authorization state expired');
  }

  let userDoc = null;
  try {
    userDoc = await User.findById(stateEntry.userId);
  } catch (lookupError) {
    console.error('SoundCloud callback user lookup failed', lookupError);
  }

  if (!userDoc) {
    const failureBase = stateEntry.redirectUrl || normalizeSoundCloudRedirect(SOUNDCLOUD_FAILURE_REDIRECT) || '';
    if (failureBase) {
      return res.redirect(appendQueryParam(failureBase, 'error', 'user_missing'));
    }
    return res.status(400).send('User session expired');
  }

  try {
    const tokenResponse = await exchangeSoundCloudCode(code);
    if (!tokenResponse?.access_token) {
      throw new Error('SoundCloud did not return an access token');
    }

    let account = await SoundCloudAccount.findOne({ userId: userDoc._id });
    if (!account) {
      account = new SoundCloudAccount({ userId: userDoc._id });
    }

    account.accessToken = tokenResponse.access_token;
    if (tokenResponse.refresh_token) {
      account.refreshToken = tokenResponse.refresh_token;
    }
    account.scope = parseSoundCloudScope(tokenResponse.scope);
    account.expiresAt = computeSoundCloudExpiry(tokenResponse.expires_in);
    account.lastSyncAt = new Date();
    await account.save();

    let profile = null;
    try {
      profile = await soundCloudFetch(account, '/me');
    } catch (profileError) {
      console.warn('SoundCloud profile fetch failed', profileError);
    }

    if (profile) {
      account.soundcloudUserId = profile.id || account.soundcloudUserId || null;
      account.username = profile.username || profile.permalink || account.username || '';
      account.permalinkUrl = profile.permalink_url || account.permalinkUrl || '';
      if (profile.avatar_url) {
        account.avatarUrl = profile.avatar_url;
      }
      await account.save();
    }

    const successBase = stateEntry.redirectUrl || normalizeSoundCloudRedirect(SOUNDCLOUD_SUCCESS_REDIRECT) || '';
    if (successBase) {
      return res.redirect(appendQueryParam(successBase, 'connected', '1'));
    }

    res.send('SoundCloud connected. You can close this window.');
  } catch (callbackError) {
    console.error('SoundCloud callback failed', callbackError);
    const failureBase = stateEntry.redirectUrl || normalizeSoundCloudRedirect(SOUNDCLOUD_FAILURE_REDIRECT) || '';
    if (failureBase) {
      return res.redirect(appendQueryParam(failureBase, 'error', 'soundcloud_callback'));
    }
    res.status(500).send('SoundCloud authorization failed');
  }
});

app.post('/api/integrations/soundcloud/disconnect', auth, async (req, res) => {
  if (!soundCloudConfigured()) {
    return res.json({ ok: true });
  }

  try {
    const account = await SoundCloudAccount.findOne({ userId: req.user._id });
    if (!account) {
      return res.json({ ok: true });
    }

    const avatarKey = account.avatarStorageKey || '';
    await SoundCloudAccount.deleteOne({ _id: account._id });
    if (avatarKey) {
      await deleteUploadKey(avatarKey).catch(() => {});
    }

    res.json({ ok: true });
  } catch (err) {
    console.error('SoundCloud disconnect failed', err);
    res.status(500).json({ error: 'failed to disconnect soundcloud' });
  }
});

app.get('/api/integrations/soundcloud/catalog', auth, async (req, res) => {
  if (!soundCloudConfigured()) {
    return res.status(503).json({ error: 'soundcloud integration unavailable' });
  }

  try {
    const account = await SoundCloudAccount.findOne({ userId: req.user._id });
    if (!account) {
      return res.status(404).json({ error: 'soundcloud account not connected' });
    }

    const profile = await soundCloudFetch(account, '/me');
    const tracksResponse = await soundCloudFetch(account, '/me/tracks', { query: { limit: 200 } });
    const playlistsResponse = await soundCloudFetch(account, '/me/playlists', { query: { limit: 200 } });

    const trackCollection = Array.isArray(tracksResponse?.collection)
      ? tracksResponse.collection
      : Array.isArray(tracksResponse)
        ? tracksResponse
        : [];
    const playlistCollection = Array.isArray(playlistsResponse?.collection)
      ? playlistsResponse.collection
      : Array.isArray(playlistsResponse)
        ? playlistsResponse
        : [];

    const trackIds = trackCollection.map((track) => String(track?.id || '')).filter(Boolean);
    const existingTracks = trackIds.length
      ? await Track.find({ userId: req.user._id, source: 'soundcloud', sourceId: { $in: trackIds } }).select('_id sourceId')
      : [];
    const trackMap = new Map(existingTracks.map((doc) => [doc.sourceId, doc]));
    const tracks = trackCollection
      .map((track) => mapSoundCloudTrackCatalog(track, trackMap.get(String(track?.id || ''))))
      .filter(Boolean);

    const playlistIds = playlistCollection.map((pl) => String(pl?.id || '')).filter(Boolean);
    const existingAlbums = playlistIds.length
      ? await Album.find({ userId: req.user._id, source: 'soundcloud', sourceId: { $in: playlistIds } }).select('_id sourceId')
      : [];
    const albumMap = new Map(existingAlbums.map((doc) => [doc.sourceId, doc]));
    const playlists = playlistCollection
      .map((pl) => mapSoundCloudPlaylistCatalog(pl, albumMap.get(String(pl?.id || ''))))
      .filter(Boolean);

    const avatarUrl = account.avatarStorageKey
      ? publicUploadUrl(req, account.avatarStorageKey)
      : account.avatarUrl || profile?.avatar_url || '';

    res.json({
      account: {
        username: account.username || profile?.username || '',
        permalinkUrl: account.permalinkUrl || profile?.permalink_url || '',
        avatar: avatarUrl,
        scope: account.scope || [],
        lastSyncAt: account.lastSyncAt
      },
      tracks,
      playlists
    });
  } catch (err) {
    console.error('SoundCloud catalog fetch failed', err);
    res.status(502).json({ error: 'soundcloud catalog request failed' });
  }
});

app.post('/api/integrations/soundcloud/import', auth, async (req, res) => {
  if (!soundCloudConfigured()) {
    return res.status(503).json({ error: 'soundcloud integration unavailable' });
  }

  if (!ensureDurableUploadsEnabled(res)) {
    return;
  }

  const body = req.body || {};
  const trackIds = Array.isArray(body.trackIds) ? body.trackIds : [];
  const playlistIds = Array.isArray(body.playlistIds) ? body.playlistIds : [];

  const normalizedTrackIds = Array.from(new Set(trackIds.map((id) => String(id).trim()).filter(Boolean)));
  const normalizedPlaylistIds = Array.from(new Set(playlistIds.map((id) => String(id).trim()).filter(Boolean)));

  if (!normalizedTrackIds.length && !normalizedPlaylistIds.length) {
    return res.status(400).json({ error: 'no soundcloud items requested' });
  }

  try {
    const account = await SoundCloudAccount.findOne({ userId: req.user._id });
    if (!account) {
      return res.status(404).json({ error: 'soundcloud account not connected' });
    }

    const ownerSummary = await userSummary(req, req.user);
    const importedTrackIds = [];
    const importedAlbumIds = [];

    for (const trackId of normalizedTrackIds) {
      try {
        const { trackDoc } = await importSoundCloudTrack({ account, userDoc: req.user, trackId });
        if (trackDoc?._id) {
          importedTrackIds.push(trackDoc._id.toString());
        }
      } catch (trackError) {
        console.warn('SoundCloud track import failed', trackId, trackError);
      }
    }

    for (const playlistId of normalizedPlaylistIds) {
      try {
        const result = await importSoundCloudPlaylist({ account, userDoc: req.user, playlistId });
        if (result?.albumDoc?._id) {
          importedAlbumIds.push(result.albumDoc._id.toString());
          for (const doc of result.importedTracks || []) {
            if (doc?._id) importedTrackIds.push(doc._id.toString());
          }
        }
      } catch (playlistError) {
        console.warn('SoundCloud playlist import failed', playlistId, playlistError);
      }
    }

    const allTrackIds = Array.from(new Set(importedTrackIds)).map((id) => asObjectId(id)).filter(Boolean);
    const trackDocs = allTrackIds.length ? await Track.find({ _id: { $in: allTrackIds } }) : [];
    const trackDocMap = new Map(trackDocs.map((doc) => [doc._id.toString(), doc]));
    const tracks = trackDocs.map((doc) => presentTrack(req, doc, ownerSummary)).filter(Boolean);

    const albumObjectIds = Array.from(new Set(importedAlbumIds)).map((id) => asObjectId(id)).filter(Boolean);
    const albumDocs = albumObjectIds.length ? await Album.find({ _id: { $in: albumObjectIds } }) : [];

    const albumTrackIds = new Set();
    for (const album of albumDocs) {
      if (!Array.isArray(album.trackIds)) continue;
      for (const ref of album.trackIds) {
        const tid = toIdString(ref?.trackId);
        if (tid) albumTrackIds.add(tid);
      }
    }

    const missingTrackIds = Array.from(albumTrackIds).filter((id) => !trackDocMap.has(id)).map((id) => asObjectId(id)).filter(Boolean);
    if (missingTrackIds.length) {
      const extraDocs = await Track.find({ _id: { $in: missingTrackIds } });
      for (const doc of extraDocs) {
        trackDocMap.set(doc._id.toString(), doc);
      }
    }

    const albums = albumDocs.map((album) => {
      const trackDocsForAlbum = Array.isArray(album.trackIds)
        ? album.trackIds
          .map((ref) => trackDocMap.get(toIdString(ref?.trackId)))
          .filter(Boolean)
        : [];
      return presentAlbum(req, album, { ownerSummary, trackDocs: trackDocsForAlbum });
    }).filter(Boolean);

    account.lastSyncAt = new Date();
    await account.save();

    res.json({
      tracks,
      albums
    });
  } catch (err) {
    console.error('SoundCloud import failed', err);
    res.status(500).json({ error: 'soundcloud import failed' });
  }
});

/* ---- profile update: change username (unique) and/or avatarUrl ---- */
async function handleProfileUpdate(req, res) {
  const { name, avatarUrl, firstName, lastName, displayName, profileColor } = req.body || {};
  if (name !== undefined) {
    const trimmed = typeof name === 'string' ? name.trim() : '';
    if (trimmed) {
      const taken = await User.exists({ name: trimmed, _id: { $ne: req.user._id } });
      if (taken) return res.status(409).json({ error: 'username already taken' });
      req.user.name = trimmed;
    }
  }
  if (firstName !== undefined) {
    req.user.firstName = typeof firstName === 'string' ? firstName.trim() : '';
  }
  if (lastName !== undefined) {
    req.user.lastName = typeof lastName === 'string' ? lastName.trim() : '';
  }
  if (displayName !== undefined) {
    const trimmed = typeof displayName === 'string' ? displayName.trim() : '';
    req.user.displayName = trimmed;
  }
  if (profileColor !== undefined) {
    if (profileColor === null) {
      req.user.profileColor = PROFILE_COLOR_DEFAULT;
    } else if (typeof profileColor === 'string') {
      const normalizedColor = parseProfileColor(profileColor);
      if (!normalizedColor) {
        const trimmed = profileColor.trim();
        if (trimmed) {
          return res.status(400).json({ error: 'invalid profile color' });
        }
        req.user.profileColor = PROFILE_COLOR_DEFAULT;
      } else {
        req.user.profileColor = normalizedColor;
      }
    } else {
      return res.status(400).json({ error: 'invalid profile color' });
    }
  }
  if (avatarUrl !== undefined) {
    req.user.avatarUrl = avatarUrl;
    req.user.avatarStorageKey = '';
  }
  await req.user.save();
  res.json({ user: await userSummary(req, req.user) });
}

app.patch('/api/users/profile', auth, handleProfileUpdate);
app.put('/api/users/profile', auth, handleProfileUpdate);

app.get('/api/users/me', auth, async (req, res) => {
  res.json({ user: await userSummary(req, req.user) });
});

app.get('/api/users/directory', async (req, res) => {
  try {
    const limitParam = Number.parseInt(req.query?.limit, 10);
    const limit = Number.isFinite(limitParam) ? Math.min(Math.max(limitParam, 1), 500) : 120;
    const users = await User.find()
      .sort({ createdAt: -1 })
      .limit(limit)
      .select('name email avatarUrl avatarStorageKey tagUrl tagStorageKey totalOnlineSec createdAt displayName firstName lastName tagDurationSec profileColor');

    const directory = users.map(u => ({
      id: u._id,
      name: u.name,
      email: u.email,
      avatar: presentStoredUploadUrl(req, u.avatarUrl, u.avatarStorageKey),
      tagUrl: presentStoredUploadUrl(req, u.tagUrl, u.tagStorageKey),
      tagDurationSec: u.tagDurationSec,
      joinedAt: u.createdAt,
      totalOnlineSec: typeof u.totalOnlineSec === 'number' ? u.totalOnlineSec : 0,
      displayName: u.displayName,
      firstName: u.firstName,
      lastName: u.lastName,
      profileColor: resolveProfileColor(u.profileColor)
    }));

    res.json({ users: directory });
  } catch (err) {
    console.error('Failed to load user directory', err);
    res.status(500).json({ error: 'failed to load user directory' });
  }
});

app.get('/api/users/library', async (req, res) => {
  try {
    const query = req.query || {};
    const rawUserId = typeof query.userId === 'string' ? query.userId.trim() : '';
    const normalizedUserId = rawUserId.startsWith('id:') ? rawUserId.slice(3).trim() : rawUserId;
    const emailParam = typeof query.email === 'string' ? query.email.trim() : '';

    let userDoc = null;
    if (normalizedUserId) {
      const objectId = asObjectId(normalizedUserId);
      if (objectId) {
        userDoc = await User.findById(objectId);
      }
    }

    if (!userDoc && emailParam) {
      const normalizedEmail = normalizeEmail(emailParam);
      if (normalizedEmail) {
        userDoc = await User.findOne({ email: normalizedEmail });
      }
    }

    if (!userDoc) {
      return res.status(404).json({ error: 'user not found' });
    }

    const ownerSummary = await userSummary(req, userDoc);

    const trackDocs = await Track.find({ userId: userDoc._id }).sort({ createdAt: -1 }).lean();
    const tracks = trackDocs
      .map((doc) => {
        const url = presentStoredUploadUrl(req, doc.audioUrl, doc.audioUrl);
        if (!url) return null;
        return {
          id: doc._id,
          title: doc.title || 'Untitled',
          caption: doc.caption || '',
          url,
          cover: presentStoredUploadUrl(req, doc.coverUrl, doc.coverUrl) || '',
          createdAt: doc.createdAt,
          updatedAt: doc.updatedAt || null,
          albumId: doc.albumId || null,
          albumTrackOrder: Number.isFinite(doc.albumTrackOrder) ? doc.albumTrackOrder : null,
          duration: Number.isFinite(doc.audioDurationSec) ? doc.audioDurationSec : null,
          ownerId: idToString(doc.userId),
          user: ownerSummary,
          source: doc.source || 'upload',
          sourceId: doc.sourceId || '',
          sourcePermalinkUrl: doc.sourcePermalinkUrl || '',
          streamUrl: doc.streamUrl || url,
          streamProtocol: doc.streamProtocol || ''
        };
      })
      .filter(Boolean);

    const albumDocs = await Album.find({ userId: userDoc._id })
      .sort({ updatedAt: -1, createdAt: -1, _id: -1 })
      .lean();

    const playlistDocs = await Playlist.find({ userId: userDoc._id })
      .sort({ updatedAt: -1, createdAt: -1, _id: -1 })
      .lean();

    const albumTrackIdStrings = [];
    for (const albumDoc of albumDocs) {
      if (!Array.isArray(albumDoc.trackIds)) continue;
      for (const ref of albumDoc.trackIds) {
        const id = toIdString(ref?.trackId);
        if (id) albumTrackIdStrings.push(id);
      }
    }

    const playlistTrackIdStrings = [];
    for (const playlistDoc of playlistDocs) {
      if (!Array.isArray(playlistDoc.trackIds)) continue;
      for (const ref of playlistDoc.trackIds) {
        const id = toIdString(ref?.trackId);
        if (id) playlistTrackIdStrings.push(id);
      }
    }

    const combinedTrackIds = [...albumTrackIdStrings, ...playlistTrackIdStrings];
    let trackDocMap = new Map();
    if (combinedTrackIds.length) {
      const uniqueIds = Array.from(new Set(combinedTrackIds));
      const objectIds = uniqueIds
        .map((value) => {
          try {
            return new mongoose.Types.ObjectId(value);
          } catch {
            return null;
          }
        })
        .filter(Boolean);
      if (objectIds.length) {
        const docs = await Track.find({ _id: { $in: objectIds } }).lean();
        trackDocMap = new Map(docs.map((entry) => [toIdString(entry?._id), entry]));
      }
    }

    const albums = albumDocs
      .map((albumDoc) => {
        const trackDocsForAlbum = Array.isArray(albumDoc.trackIds)
          ? albumDoc.trackIds
              .map((ref) => trackDocMap.get(toIdString(ref?.trackId)))
              .filter(Boolean)
          : [];
        return presentAlbum(req, albumDoc, { ownerSummary, trackDocs: trackDocsForAlbum });
      })
      .filter(Boolean);

    const playlists = playlistDocs
      .map((playlistDoc) => {
        const trackDocsForPlaylist = Array.isArray(playlistDoc.trackIds)
          ? playlistDoc.trackIds
              .map((ref) => trackDocMap.get(toIdString(ref?.trackId)))
              .filter(Boolean)
          : [];
        return presentPlaylist(req, playlistDoc, { ownerSummary, trackDocs: trackDocsForPlaylist });
      })
      .filter(Boolean);

    res.json({ user: ownerSummary, tracks, albums, playlists });
  } catch (error) {
    console.error('User library fetch failed', error);
    res.status(500).json({ error: 'could not load user library' });
  }
});

/* ======================= Presence / Time grind ======================= */
app.post('/api/presence/ping', auth, async (req, res) => {
  const now = new Date();
  const prev = req.user.lastPingAt ? new Date(req.user.lastPingAt) : null;
  if (prev) {
    let delta = Math.floor((now - prev) / 1000);
    if (delta < 0) delta = 0;
    if (delta > 60) delta = 60; // cap per ping
    req.user.totalOnlineSec += delta;
  }
  req.user.lastPingAt = now;
  await req.user.save();
  res.json({ totalOnlineSec: req.user.totalOnlineSec });
});

/* ========================= Sound tag upload ========================= */
const tagDir = path.join(uploadsRoot, 'tags');
fs.mkdirSync(tagDir, { recursive: true });
const TAG_ALLOWED_MIME = new Set([
  'audio/mpeg',
  'audio/mp3',
  'audio/ogg',
  'audio/wav',
  'audio/x-wav',
  'audio/webm',
  'audio/flac',
  'audio/aac'
].map(normalizeMime));

const tagUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 2 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const mimetype = normalizeMime(file?.mimetype);
    if (mimetype) file.mimetype = mimetype;
    if (!mimetype || !TAG_ALLOWED_MIME.has(mimetype)) {
      return cb(new Error('tag must be an audio file (mp3, wav, ogg, webm, flac)'));
    }
    cb(null, true);
  }
});

function audioFileExt(file) {
  const fromName = (path.extname(file.originalname) || '').toLowerCase();
  if (fromName) return fromName;

  const mimeType = normalizeMime(file.mimetype);
  if (mimeType && AUDIO_MIME_EXT[mimeType]) {
    return AUDIO_MIME_EXT[mimeType];
  }

  const metadataMime = normalizeMime(file?.metadata?.format?.mimeType);
  if (metadataMime && AUDIO_MIME_EXT[metadataMime]) {
    return AUDIO_MIME_EXT[metadataMime];
  }

  const metadataContainer = (file?.metadata?.format?.container || '').toLowerCase();
  if (metadataContainer.includes('webm')) return '.webm';
  if (metadataContainer.includes('flac')) return '.flac';
  if (metadataContainer.includes('ogg')) return '.ogg';
  if (metadataContainer.includes('wav')) return '.wav';
  if (metadataContainer.includes('aiff')) return '.aiff';
  if (metadataContainer.includes('aac')) return '.aac';
  if (metadataContainer.includes('mp4') || metadataContainer.includes('m4a')) return '.m4a';

  if (mimeType) {
    const ext = mimeExtension(mimeType);
    if (ext) return `.${ext.toLowerCase()}`;
  }
  if (metadataMime) {
    const ext = mimeExtension(metadataMime);
    if (ext) return `.${ext.toLowerCase()}`;
  }

  return '.mp3';
}

function messageAttachmentExt(file) {
  const mimetype = normalizeMime(file.mimetype);
  if (mimetype) file.mimetype = mimetype;
  const mapped = IMAGE_MIME_EXT[mimetype] || AUDIO_MIME_EXT[mimetype];
  if (mapped) return mapped;
  const fromName = (path.extname(file.originalname) || '').toLowerCase();
  if (fromName) return fromName;
  if (mimetype && mimetype.includes('/')) {
    const subtype = mimetype.split('/').pop();
    if (subtype) return `.${subtype}`;
  }
  return '.bin';
}

function storageKey(prefix, ext) {
  const safeExt = ext && ext.startsWith('.') ? ext : (ext ? `.${ext}` : '');
  const suffix = crypto.randomBytes(8).toString('hex');
  return `${prefix}/${Date.now()}-${suffix}${safeExt || ''}`;
}

async function persistBufferToStorage(file, { prefix, extResolver }) {
  if (!file) return null;
  const mimetype = normalizeMime(file.mimetype);
  if (mimetype) {
    file.mimetype = mimetype;
  }
  const ext = extResolver(file);
  const key = storageKey(prefix, ext);
  const result = await writeBufferToUploads({
    key,
    buffer: file.buffer,
    contentType: file.mimetype || undefined
  });
  file.storageKey = result.key;
  file.storagePath = result.path || null;
  if (typeof result.size === 'number') {
    file.size = result.size;
  }
  return file;
}

const trackUploadMemory = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 12 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const mimetype = normalizeMime(file.mimetype);
    if (mimetype) file.mimetype = mimetype;
    if (file.fieldname === 'cover') {
      if (!mimetype || !mimetype.startsWith('image/')) {
        return cb(new Error('cover must be an image'));
      }
      return cb(null, true);
    }
    if (file.fieldname === 'audio') {
      if (!mimetype || !AUDIO_ALLOWED_MIME.has(mimetype)) {
        return cb(new Error('audio must be an audio file (mp3, wav, ogg, webm, flac, m4a)'));
      }
      return cb(null, true);
    }
    return cb(new Error('unsupported field'));
  }
});

function withTrackStorage(handler, { includeAudio, includeCover }) {
  return (req, res, done) => {
    handler(req, res, async (err) => {
      if (err) return done(err);
      const audioFiles = [];
      const coverFiles = [];
      if (Array.isArray(req.files?.audio)) audioFiles.push(...req.files.audio);
      if (Array.isArray(req.files?.cover)) coverFiles.push(...req.files.cover);
      if (req.file) {
        if (req.file.fieldname === 'audio') audioFiles.push(req.file);
        if (req.file.fieldname === 'cover') coverFiles.push(req.file);
      }
      const cleanupTargets = [];
      if (includeAudio) cleanupTargets.push(...audioFiles);
      if (includeCover) cleanupTargets.push(...coverFiles);

      const cleanup = async () => {
        await Promise.all(cleanupTargets.map(file => deleteUploadKey(file?.storageKey).catch(() => {})));
      };

      try {
        if (includeAudio && audioFiles[0]) {
          await persistBufferToStorage(audioFiles[0], { prefix: 'tracks', extResolver: audioFileExt });
        }
        if (includeCover && coverFiles[0]) {
          await persistBufferToStorage(coverFiles[0], { prefix: 'covers', extResolver: avatarFileExt });
        }
        return done(null);
      } catch (ex) {
        await cleanup();
        return done(ex);
      }
    });
  };
}

const trackUpload = {
  fields: (spec) => withTrackStorage(trackUploadMemory.fields(spec), { includeAudio: true, includeCover: true }),
  single: (field) => {
    const includeAudio = field === 'audio';
    const includeCover = field === 'cover';
    return withTrackStorage(trackUploadMemory.single(field), { includeAudio, includeCover });
  }
};

const avatarDir = path.join(uploadsRoot, 'avatars');
fs.mkdirSync(avatarDir, { recursive: true });

function avatarFileExt(file) {
  const fromName = (path.extname(file.originalname) || '').toLowerCase();
  if (fromName && ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.bmp'].includes(fromName)) {
    return fromName;
  }
  const mimetype = normalizeMime(file.mimetype);
  if (mimetype) file.mimetype = mimetype;
  return IMAGE_MIME_EXT[mimetype] || '.png';
}

const avatarUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 3 * 1024 * 1024 }, // 3MB avatar cap
  fileFilter: (_req, file, cb) => {
    const mimetype = normalizeMime(file.mimetype);
    if (mimetype) file.mimetype = mimetype;
    if (!mimetype || !mimetype.startsWith('image/')) {
      return cb(new Error('avatar must be an image'));
    }
    cb(null, true);
  }
});

const MESSAGE_ATTACHMENT_MAX_SIZE = 15 * 1024 * 1024; // 15MB per file
const MESSAGE_ATTACHMENT_MAX_COUNT = 3;

const messageAttachmentUploadMemory = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: MESSAGE_ATTACHMENT_MAX_SIZE,
    files: MESSAGE_ATTACHMENT_MAX_COUNT
  },
  fileFilter: (_req, file, cb) => {
    const mimetype = normalizeMime(file?.mimetype);
    if (mimetype) file.mimetype = mimetype;
    if (!mimetype || !MESSAGE_ALLOWED_MIME.has(mimetype)) {
      return cb(new Error('attachments must be images or audio files'));
    }
    cb(null, true);
  }
});

function withMessageStorage(handler) {
  return (req, res, done) => {
    handler(req, res, async (err) => {
      if (err) return done(err);
      const files = Array.isArray(req.files) ? req.files : [];
      try {
        for (const file of files) {
          await persistBufferToStorage(file, { prefix: 'messages', extResolver: messageAttachmentExt });
        }
        return done(null);
      } catch (ex) {
        await Promise.all(files.map(file => deleteUploadKey(file?.storageKey).catch(() => {})));
        return done(ex);
      }
    });
  };
}

const messageAttachmentUpload = {
  array: (field, maxCount) => withMessageStorage(messageAttachmentUploadMemory.array(field, maxCount))
};

const STUDIO_SOUND_MAX_SIZE = 5 * 1024 * 1024; // 5MB cap per uploaded sound

const studioSoundUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: STUDIO_SOUND_MAX_SIZE },
  fileFilter: (_req, file, cb) => {
    const mimetype = normalizeMime(file?.mimetype);
    if (mimetype) file.mimetype = mimetype;
    if (!mimetype || AUDIO_ALLOWED_MIME.has(mimetype)) {
      return cb(null, true);
    }
    return cb(new Error('sound must be an audio file (mp3, wav, ogg, webm, flac, m4a, aiff)'));
  }
});

function resolveUploadPath(url, folder) {
  if (!url) return null;
  const prefix = `/uploads/${folder}/`;
  try {
    const parsed = new URL(url, 'http://localhost');
    if (!parsed.pathname.startsWith(prefix)) return null;
    const file = parsed.pathname.slice(prefix.length);
    if (!file) return null;
    return path.join(uploadsRoot, folder, file);
  } catch {
    if (typeof url === 'string' && url.startsWith(prefix)) {
      const file = url.slice(prefix.length).split('?')[0];
      if (!file) return null;
      return path.join(uploadsRoot, folder, file);
    }
    return null;
  }
}

function safeUnlink(filePath) {
  if (!filePath) return;
  fs.promises.unlink(filePath).catch(() => {});
}

async function deleteStoredUpload(value, folder) {
  if (!value) return;
  if (typeof value === 'string' && /^https?:\/\//i.test(value)) {
    const local = resolveUploadPath(value, folder);
    if (local) safeUnlink(local);
    return;
  }
  const key = normalizeUploadKey(value);
  if (!key) return;
  await deleteUploadKey(key);
}

async function cleanupMessageUploads(files) {
  if (!files) return;
  await Promise.all(files.map(async (file) => {
    if (file?.storageKey) {
      await deleteUploadKey(file.storageKey);
      return;
    }
    if (file?.path) safeUnlink(file.path);
  }));
}

function messagePreview(message) {
  if (!message) return '';
  if (message.deletedAt) return '';
  if (message.body) return message.body;
  if (Array.isArray(message.attachments) && message.attachments.length > 0) {
    const count = message.attachments.length;
    return count === 1 ? '[Attachment]' : `[${count} attachments]`;
  }
  return '';
}

/* ========================= Beatloop Studio sounds ========================= */
app.get('/api/studio/sounds', async (req, res) => {
  try {
    const typeParam = typeof req.query?.type === 'string' ? req.query.type.trim().toLowerCase() : '';
    const filter = {};
    if (typeParam === 'loop' || typeParam === 'instrument') {
      filter.type = typeParam;
    }

    let docs = await StudioSound.find(filter)
      .sort({ createdAt: -1 })
      .limit(500)
      .lean();

    docs = docs || [];

    const missingIds = [];
    if (!durableStorageEnabled() && docs.length > 0) {
      const survivingDocs = [];
      for (const doc of docs) {
        const storageKey = doc?.storageKey;
        if (typeof storageKey === 'string' && storageKey.trim()) {
          const diskPath = localPathForKey(storageKey);
          try {
            await fs.promises.access(diskPath, fs.constants.R_OK);
            survivingDocs.push(doc);
          } catch {
            if (doc?._id) missingIds.push(doc._id);
          }
          continue;
        }
        survivingDocs.push(doc);
      }
      docs = survivingDocs;
    }

    if (missingIds.length > 0) {
      const missingObjectIds = missingIds
        .map((id) => asObjectId(id))
        .filter(Boolean);
      if (missingObjectIds.length > 0) {
        StudioSound.deleteMany({ _id: { $in: missingObjectIds } }).catch((error) => {
          console.warn('Failed to clean up missing studio sounds', error);
        });
      }
    }

    if (!docs || docs.length === 0) {
      return res.json({ loops: [], instruments: [] });
    }

    const ownerIds = Array.from(new Set(
      docs
        .map(doc => idToString(doc?.userId))
        .filter(Boolean)
    ));

    let ownerSummaries = new Map();
    if (ownerIds.length > 0) {
      const ownerObjectIds = ownerIds.map(id => asObjectId(id)).filter(Boolean);
      if (ownerObjectIds.length > 0) {
        const owners = await User.find({ _id: { $in: ownerObjectIds } })
          .select('name email avatarUrl avatarStorageKey tagUrl tagStorageKey tagDurationSec displayName firstName lastName profileColor createdAt')
          .lean();
        const entries = await Promise.all(
          owners.map(async (owner) => [idToString(owner._id), await userSummary(req, owner)])
        );
        ownerSummaries = new Map(entries.filter(([key]) => Boolean(key)));
      }
    }

    const present = (doc) => presentStudioSound(req, doc, ownerSummaries.get(idToString(doc?.userId)));
    const loops = filter.type === 'instrument' ? [] : docs.filter(doc => doc.type === 'loop').map(present);
    const instruments = filter.type === 'loop' ? [] : docs.filter(doc => doc.type === 'instrument').map(present);

    res.json({ loops, instruments });
  } catch (err) {
    console.error('Failed to list studio sounds', err);
    res.status(500).json({ error: 'failed to load sounds' });
  }
});

app.post('/api/studio/sounds', auth, (req, res) => {
  if (!ensureDurableUploadsEnabled(res)) {
    return;
  }

  studioSoundUpload.single('sound')(req, res, async (err) => {
    if (err) {
      const message = err.code === 'LIMIT_FILE_SIZE'
        ? 'sound must be 5MB or less'
        : (err.message || 'upload failed');
      return res.status(400).json({ error: message });
    }

    const file = req.file;
    if (!file) {
      return res.status(400).json({ error: 'sound file required' });
    }

    const typeRaw = typeof req.body?.type === 'string' ? req.body.type.trim().toLowerCase() : '';
    if (typeRaw !== 'loop' && typeRaw !== 'instrument') {
      return res.status(400).json({ error: 'type must be loop or instrument' });
    }

    const mimetype = normalizeMime(file.mimetype);
    if (mimetype) file.mimetype = mimetype;

    let metadata = null;
    try {
      metadata = await parseBuffer(file.buffer, file.mimetype || null, { duration: true });
      if (metadata) file.metadata = metadata;
    } catch (ex) {
      // If parsing fails we still continue, but log for debugging.
      console.warn('Unable to parse uploaded studio sound metadata', ex);
    }

    const prefix = typeRaw === 'loop' ? 'studio/loops' : 'studio/instruments';
    try {
      await persistBufferToStorage(file, { prefix, extResolver: audioFileExt });
    } catch (storageErr) {
      console.error('Studio sound upload storage failed', storageErr);
      return res.status(500).json({ error: 'failed to store sound' });
    }

    const durationSec = metadata?.format?.duration ? Math.round(metadata.format.duration * 1000) / 1000 : 0;
    const rawName = typeof req.body?.name === 'string' ? req.body.name : '';
    const original = typeof file.originalname === 'string' ? file.originalname : '';
    const baseName = rawName || original;
    const normalizedName = baseName
      ? baseName.replace(/\.[^.]+$/, '').replace(/[_\s]+/g, ' ').trim()
      : '';
    const name = (normalizedName || 'Untitled Sound').slice(0, 120);

    try {
      const doc = await StudioSound.create({
        userId: req.user._id,
        type: typeRaw,
        name,
        storageKey: file.storageKey,
        originalName: original,
        mimeType: file.mimetype || '',
        size: typeof file.size === 'number' ? file.size : (file.buffer?.length || 0),
        durationSec
      });
      file.buffer = null;
      const ownerSummary = await userSummary(req, req.user);
      res.status(201).json(presentStudioSound(req, doc, ownerSummary));
    } catch (createErr) {
      console.error('Studio sound save failed', createErr);
      if (file?.storageKey) {
        await deleteUploadKey(file.storageKey).catch(() => {});
      }
      res.status(500).json({ error: 'could not save sound' });
    }
  });
});

app.patch('/api/studio/sounds/:id', auth, async (req, res) => {
  const soundId = asObjectId(req.params?.id);
  if (!soundId) {
    return res.status(400).json({ error: 'invalid sound id' });
  }

  const doc = await StudioSound.findById(soundId);
  if (!doc) {
    return res.status(404).json({ error: 'sound not found' });
  }

  if (idToString(doc.userId) !== idToString(req.user._id)) {
    return res.status(403).json({ error: 'not your sound' });
  }

  const rawName = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
  if (!rawName) {
    return res.status(400).json({ error: 'name is required' });
  }

  doc.name = rawName.slice(0, 120);
  await doc.save();

  const ownerSummary = await userSummary(req, req.user);
  res.json(presentStudioSound(req, doc, ownerSummary));
});

app.delete('/api/studio/sounds/:id', auth, async (req, res) => {
  const soundId = asObjectId(req.params?.id);
  if (!soundId) {
    return res.status(400).json({ error: 'invalid sound id' });
  }

  const doc = await StudioSound.findById(soundId);
  if (!doc) {
    return res.status(404).json({ error: 'sound not found' });
  }

  if (idToString(doc.userId) !== idToString(req.user._id)) {
    return res.status(403).json({ error: 'not your sound' });
  }

  const storageKey = typeof doc.storageKey === 'string' ? doc.storageKey : '';
  await doc.deleteOne();
  if (storageKey) {
    await deleteUploadKey(storageKey).catch(() => {});
  }
  res.status(204).send();
});

/* ============================ Direct Messages ============================ */
app.get('/api/messages/conversations', auth, async (req, res) => {
  try {
    const viewerId = req.user._id;
    const viewerStr = idToString(viewerId);
    const docs = await DirectMessage.find({
      $or: [{ senderId: viewerId }, { recipientId: viewerId }]
    })
      .sort({ createdAt: -1 })
      .limit(400)
      .lean();

    if (!docs || docs.length === 0) {
      return res.json({ conversations: [] });
    }

    const conversations = new Map();
    const otherIds = new Set();

    for (const doc of docs) {
      if (!doc || !doc.conversationKey || conversations.has(doc.conversationKey)) continue;
      const senderId = idToString(doc.senderId);
      const recipientId = idToString(doc.recipientId);
      if (!senderId || !recipientId) continue;
      const otherId = senderId === viewerStr ? recipientId : senderId;
      if (!otherId) continue;
      conversations.set(doc.conversationKey, { doc, otherId });
      otherIds.add(otherId);
    }

    if (conversations.size === 0) {
      return res.json({ conversations: [] });
    }

    const otherObjectIds = Array.from(otherIds)
      .map(id => asObjectId(id))
      .filter(Boolean);

    const users = await User.find({ _id: { $in: otherObjectIds } })
      .select('name email avatarUrl avatarStorageKey displayName firstName lastName createdAt profileColor')
      .lean();

    const userMap = new Map(users.map(u => [idToString(u._id), u]));

    const response = [];
    for (const { doc, otherId } of conversations.values()) {
      const userRaw = userMap.get(otherId);
      if (!userRaw) continue;
      const summary = await userSummary(req, userRaw);
      const user = normalizeUserForConversation(summary, userRaw, req);
      if (!user?.id) continue;
      const message = presentMessage(req, doc, viewerId);
      message.preview = messagePreview(message);
      response.push({ user, lastMessage: message });
    }

    response.sort((a, b) => {
      const at = a.lastMessage?.createdAt ? new Date(a.lastMessage.createdAt).getTime() : 0;
      const bt = b.lastMessage?.createdAt ? new Date(b.lastMessage.createdAt).getTime() : 0;
      return bt - at;
    });

    res.json({ conversations: response });
  } catch (err) {
    console.error('Failed to load direct message conversations', err);
    res.status(500).json({ error: 'failed to load conversations' });
  }
});

app.get('/api/messages/with/:userId', auth, async (req, res) => {
  try {
    const otherId = asObjectId(req.params.userId);
    if (!otherId) return res.status(400).json({ error: 'invalid user id' });
    if (otherId.equals(req.user._id)) {
      return res.status(400).json({ error: 'cannot message yourself' });
    }

    const otherUser = await User.findById(otherId)
      .select('name email avatarUrl avatarStorageKey displayName firstName lastName createdAt profileColor')
      .lean();
    if (!otherUser) return res.status(404).json({ error: 'user not found' });

    const conversationKey = conversationKeyFor(req.user._id, otherId);
    const docs = await DirectMessage.find({ conversationKey })
      .sort({ createdAt: 1 })
      .lean();

    const messages = docs.map(doc => presentMessage(req, doc, req.user._id));
    const summary = await userSummary(req, otherUser);
    const user = normalizeUserForConversation(summary, otherUser, req);

    res.json({ user, messages });
  } catch (err) {
    console.error('Failed to load direct message thread', err);
    res.status(500).json({ error: 'failed to load conversation' });
  }
});

app.post('/api/messages/with/:userId', auth, (req, res) => {
  if (!ensureDurableUploadsEnabled(res)) {
    return;
  }

  messageAttachmentUpload.array('attachments', MESSAGE_ATTACHMENT_MAX_COUNT)(req, res, async (err) => {
    if (err) {
      const message = err.message || 'upload failed';
      return res.status(400).json({ error: message });
    }

    const files = Array.isArray(req.files) ? req.files : [];

    try {
      const otherId = asObjectId(req.params.userId);
      if (!otherId) {
        await cleanupMessageUploads(files);
        return res.status(400).json({ error: 'invalid user id' });
      }
      if (otherId.equals(req.user._id)) {
        await cleanupMessageUploads(files);
        return res.status(400).json({ error: 'cannot message yourself' });
      }

      const otherUser = await User.findById(otherId).select('_id');
      if (!otherUser) {
        await cleanupMessageUploads(files);
        return res.status(404).json({ error: 'user not found' });
      }

      const body = sanitizeMessageBody(req.body?.body);
      const attachments = files.map(file => ({
        fileName: file.storageKey || file.filename,
        originalName: file.originalname || '',
        mimeType: file.mimetype || '',
        size: file.size || 0,
        type: attachmentTypeFor(file.mimetype)
      }));

      if (!body && attachments.length === 0) {
        await cleanupMessageUploads(files);
        return res.status(400).json({ error: 'message cannot be empty' });
      }

      const message = await DirectMessage.create({
        conversationKey: conversationKeyFor(req.user._id, otherId),
        senderId: req.user._id,
        recipientId: otherId,
        body,
        attachments
      });

      res.status(201).json({ message: presentMessage(req, message, req.user._id) });
    } catch (ex) {
      await cleanupMessageUploads(files);
      console.error('Failed to send direct message', ex);
      res.status(500).json({ error: 'failed to send message' });
    }
  });
});

app.patch('/api/messages/:messageId', auth, async (req, res) => {
  try {
    const messageId = asObjectId(req.params.messageId);
    if (!messageId) return res.status(400).json({ error: 'invalid message id' });

    const message = await DirectMessage.findById(messageId);
    if (!message) return res.status(404).json({ error: 'message not found' });
    if (!message.senderId.equals(req.user._id)) {
      return res.status(403).json({ error: 'not allowed' });
    }
    if (message.deletedAt) {
      return res.status(400).json({ error: 'message already deleted' });
    }

    const body = sanitizeMessageBody(req.body?.body);
    const hasAttachments = Array.isArray(message.attachments) && message.attachments.length > 0;
    if (!body && !hasAttachments) {
      return res.status(400).json({ error: 'message cannot be empty' });
    }

    message.body = body;
    message.editedAt = new Date();
    await message.save();

    res.json({ message: presentMessage(req, message, req.user._id) });
  } catch (err) {
    console.error('Failed to edit direct message', err);
    res.status(500).json({ error: 'failed to edit message' });
  }
});

app.delete('/api/messages/:messageId', auth, async (req, res) => {
  try {
    const messageId = asObjectId(req.params.messageId);
    if (!messageId) return res.status(400).json({ error: 'invalid message id' });

    const message = await DirectMessage.findById(messageId);
    if (!message) return res.status(404).json({ error: 'message not found' });
    if (!message.senderId.equals(req.user._id)) {
      return res.status(403).json({ error: 'not allowed' });
    }

    if (message.deletedAt) {
      return res.json({ message: presentMessage(req, message, req.user._id) });
    }

    const attachments = Array.isArray(message.attachments) ? [...message.attachments] : [];
    message.body = '';
    message.attachments = [];
    message.deletedAt = new Date();
    message.editedAt = null;
    await message.save();

    for (const att of attachments) {
      if (att?.fileName) {
        safeUnlink(path.join(messageAttachmentDir, att.fileName));
      }
    }

    res.json({ message: presentMessage(req, message, req.user._id) });
  } catch (err) {
    console.error('Failed to delete direct message', err);
    res.status(500).json({ error: 'failed to delete message' });
  }
});

app.post('/api/users/tag', auth, (req, res) => {
  if (!ensureDurableUploadsEnabled(res)) {
    return;
  }

  tagUpload.single('tag')(req, res, async (err) => {
    if (err) {
      const message = err.message || 'upload failed';
      return res.status(400).json({ error: message });
    }
    if (!req.file) return res.status(400).json({ error: 'missing file' });
    const file = req.file;
    let duration = 0;
    try {
      const meta = await parseBuffer(file.buffer, file.mimetype || null, { duration: true });
      duration = meta?.format?.duration || 0;
    } catch (ex) {
      file.buffer = null;
      return res.status(500).json({ error: 'could not process audio tag' });
    }
    if (duration > 10.05) {
      file.buffer = null;
      return res.status(400).json({ error: 'tag must be 10 seconds or less' });
    }

    const previous = req.user.tagStorageKey || req.user.tagUrl || '';
    try {
      await persistBufferToStorage(file, { prefix: 'tags', extResolver: audioFileExt });
      file.buffer = null;
      const storageKey = file.storageKey || '';
      req.user.tagStorageKey = storageKey;
      req.user.tagUrl = storageKey ? publicUploadUrl(req, storageKey) : '';
      req.user.tagDurationSec = Math.round(duration * 1000) / 1000;
      await req.user.save();
      if (previous) {
        await deleteStoredUpload(previous, 'tags').catch(() => {});
      }
      res.json({ ok: true, tagUrl: req.user.tagUrl, duration: req.user.tagDurationSec });
    } catch (ex) {
      file.buffer = null;
      if (file?.storageKey) {
        await deleteUploadKey(file.storageKey).catch(() => {});
      }
      res.status(500).json({ error: 'could not process audio tag' });
    }
  });
});

app.post('/api/users/avatar', auth, (req, res) => {
  if (!ensureDurableUploadsEnabled(res)) {
    return;
  }

  avatarUpload.single('avatar')(req, res, async (err) => {
    if (err) {
      const message = err.message || 'upload failed';
      return res.status(400).json({ error: message });
    }
    if (!req.file) {
      return res.status(400).json({ error: 'missing file' });
    }
    const file = req.file;
    const previous = req.user.avatarStorageKey || req.user.avatarUrl || '';
    try {
      await persistBufferToStorage(file, { prefix: 'avatars', extResolver: avatarFileExt });
      file.buffer = null;
      const storageKey = file.storageKey || '';
      const url = storageKey ? publicUploadUrl(req, storageKey) : '';
      req.user.avatarStorageKey = storageKey;
      req.user.avatarUrl = url;
      await req.user.save();
      if (previous) {
        await deleteStoredUpload(previous, 'avatars').catch(() => {});
      }
      res.json({ ok: true, avatarUrl: url });
    } catch (ex) {
      file.buffer = null;
      if (file?.storageKey) {
        await deleteUploadKey(file.storageKey).catch(() => {});
      }
      res.status(500).json({ error: 'could not save avatar' });
    }
  });
});

app.post('/api/tracks', auth, (req, res) => {
  if (!ensureDurableUploadsEnabled(res)) {
    return;
  }

  trackUpload.fields([{ name: 'audio', maxCount: 1 }, { name: 'cover', maxCount: 1 }])(req, res, async (err) => {
    if (err) {
      const message = err.message || 'upload failed';
      return res.status(400).json({ error: message });
    }

    const audioFile = Array.isArray(req.files?.audio) ? req.files.audio[0] : null;
    const coverFile = Array.isArray(req.files?.cover) ? req.files.cover[0] : null;

    if (!audioFile) {
      if (coverFile?.storageKey) await deleteUploadKey(coverFile.storageKey).catch(() => {});
      return res.status(400).json({ error: 'missing audio file' });
    }

    if (audioFile.size > 10 * 1024 * 1024) {
      await deleteUploadKey(audioFile.storageKey).catch(() => {});
      if (coverFile?.storageKey) await deleteUploadKey(coverFile.storageKey).catch(() => {});
      return res.status(400).json({ error: 'track must be 10MB or less' });
    }

      if (coverFile && coverFile.size > 10 * 1024 * 1024) {
        await deleteUploadKey(audioFile.storageKey).catch(() => {});
        await deleteUploadKey(coverFile.storageKey).catch(() => {});
        return res.status(400).json({ error: 'cover art must be 10MB or less' });
      }

    try {
      let duration = null;
      try {
        const meta = await parseBuffer(audioFile.buffer, audioFile.mimetype || null, { duration: true });
        if (meta?.format?.duration) {
          duration = Math.round(meta.format.duration * 1000) / 1000;
        }
      } catch {}
      audioFile.buffer = null;

      const body = req.body || {};
      const rawTitle = typeof body.title === 'string' ? body.title.trim() : '';
      const rawCaption = typeof body.caption === 'string' ? body.caption.trim() : '';
      const bpmValue = Number.parseInt(body.bpm, 10);
      const bpm = Number.isFinite(bpmValue) ? Math.max(0, Math.min(bpmValue, 999)) : 0;

      const title = rawTitle || (audioFile.originalname ? audioFile.originalname.replace(/\.[^.]+$/, '') : 'Untitled');
      const caption = rawCaption ? rawCaption.slice(0, 500) : '';
      const audioKey = audioFile.storageKey;
      const coverKey = coverFile ? coverFile.storageKey : '';
      if (coverFile) coverFile.buffer = null;
      const audioUrl = publicUploadUrl(req, audioKey);
      const coverUrl = coverKey ? publicUploadUrl(req, coverKey) : '';
      const artist = resolveArtistFromUser(req.user) || req.user.email;

      const trackDoc = await Track.create({
        userId: req.user._id,
        title,
        artist,
        bpm,
        audioUrl: audioKey,
        coverUrl: coverKey,
        audioDurationSec: duration || 0,
        caption
      });

      const summary = await userSummary(req, req.user);
        res.json({
          id: trackDoc._id,
          title: trackDoc.title,
          artist: trackDoc.artist,
          bpm: trackDoc.bpm || 0,
          audioUrl,
          coverUrl: coverUrl || null,
          duration: trackDoc.audioDurationSec || null,
          caption: trackDoc.caption || '',
          createdAt: trackDoc.createdAt,
          bumpedAt: trackDoc.bumpedAt,
          userId: trackDoc.userId,
          user: summary,
          source: trackDoc.source || 'upload',
          sourceId: trackDoc.sourceId || '',
          sourcePermalinkUrl: trackDoc.sourcePermalinkUrl || '',
          streamUrl: trackDoc.streamUrl || audioUrl,
          streamProtocol: trackDoc.streamProtocol || ''
        });
    } catch (ex) {
      console.error('Track upload failed', ex);
      await deleteUploadKey(audioFile.storageKey).catch(() => {});
      if (coverFile?.storageKey) await deleteUploadKey(coverFile.storageKey).catch(() => {});
      res.status(500).json({ error: 'could not save track' });
    }
  });
});

app.post('/api/tracks/:id/cover', auth, (req, res) => {
  if (!ensureDurableUploadsEnabled(res)) {
    return;
  }

  trackUpload.single('cover')(req, res, async (err) => {
    if (err) {
      const message = err.message || 'upload failed';
      return res.status(400).json({ error: message });
    }

    const trackId = asObjectId(req.params?.id);
    if (!trackId) {
      if (req.file?.path) safeUnlink(req.file.path);
      return res.status(400).json({ error: 'invalid track id' });
    }

    let trackDoc = null;
    try {
      trackDoc = await Track.findById(trackId);
    } catch (ex) {
      console.error('Track lookup failed during cover update', ex);
    }

    if (!trackDoc) {
      if (req.file?.storageKey) await deleteUploadKey(req.file.storageKey).catch(() => {});
      return res.status(404).json({ error: 'track not found' });
    }

    if (!trackDoc.userId || trackDoc.userId.toString() !== req.user._id.toString()) {
      if (req.file?.storageKey) await deleteUploadKey(req.file.storageKey).catch(() => {});
      return res.status(403).json({ error: 'not your track' });
    }

    if (!req.file) {
      return res.status(400).json({ error: 'missing file' });
    }

    if (req.file.size > 10 * 1024 * 1024) {
      await deleteUploadKey(req.file.storageKey).catch(() => {});
      return res.status(400).json({ error: 'cover art must be 10MB or less' });
    }

    try {
      await deleteStoredUpload(trackDoc.coverUrl, 'covers');

      const coverKey = req.file.storageKey;
      const coverUrl = publicUploadUrl(req, coverKey);
      trackDoc.coverUrl = coverKey;
      await trackDoc.save();

      res.json({ ok: true, coverUrl });
    } catch (ex) {
      console.error('Track cover update failed', ex);
      if (req.file?.storageKey) await deleteUploadKey(req.file.storageKey).catch(() => {});
      res.status(500).json({ error: 'could not save cover' });
    }
  });
});

app.post('/api/albums', auth, async (req, res) => {
  const body = req.body || {};
  const rawTitle = typeof body.title === 'string' ? body.title.trim() : '';
  const rawCaption = typeof body.caption === 'string' ? body.caption.trim() : '';
  const title = rawTitle ? rawTitle.slice(0, 160) : '';
  const caption = rawCaption ? rawCaption.slice(0, 500) : '';

  try {
    const albumDoc = await Album.create({
      userId: req.user._id,
      title,
      caption,
      coverUrl: '',
      coverStorageKey: '',
      trackIds: []
    });
    const ownerSummary = await userSummary(req, req.user);
    res.json({ album: presentAlbum(req, albumDoc, { ownerSummary, trackDocs: [] }) });
  } catch (error) {
    console.error('Album create failed', error);
    res.status(500).json({ error: 'could not create album' });
  }
});

app.get('/api/albums', async (req, res) => {
  try {
    const limitParam = Number.parseInt(req.query?.limit, 10);
    const limit = Number.isFinite(limitParam) ? Math.min(Math.max(limitParam, 1), 25) : 5;
    const cursorRaw = req.query?.cursor;
    let cursorDate = null;
    if (cursorRaw) {
      const parsed = new Date(cursorRaw);
      if (!Number.isNaN(parsed.valueOf())) {
        cursorDate = parsed;
      }
    }

    const query = {};
    if (cursorDate) {
      query.$or = [
        { updatedAt: { $lt: cursorDate } },
        { updatedAt: { $exists: false }, createdAt: { $lt: cursorDate } }
      ];
    }

    const docs = await Album.find(query)
      .sort({ updatedAt: -1, createdAt: -1, _id: -1 })
      .limit(limit)
      .lean();

    const userIds = Array.from(new Set(
      docs.map(doc => toIdString(doc.userId)).filter(Boolean)
    ));

    const ownerMap = new Map();
    if (userIds.length) {
      const objectIds = userIds.map(id => {
        try {
          return new mongoose.Types.ObjectId(id);
        } catch {
          return null;
        }
      }).filter(Boolean);
      if (objectIds.length) {
        const owners = await User.find({ _id: { $in: objectIds } });
        const summaries = await Promise.all(
          owners.map(async owner => [owner._id.toString(), await userSummary(req, owner)])
        );
        for (const [key, value] of summaries) {
          if (key && value) ownerMap.set(key, value);
        }
      }
    }

    const trackIdStrings = [];
    for (const doc of docs) {
      if (!Array.isArray(doc.trackIds)) continue;
      for (const entry of doc.trackIds) {
        const id = toIdString(entry?.trackId);
        if (id) trackIdStrings.push(id);
      }
    }

    const uniqueTrackIds = Array.from(new Set(trackIdStrings));
    const trackMap = new Map();
    if (uniqueTrackIds.length) {
      const trackObjectIds = uniqueTrackIds.map(id => {
        try {
          return new mongoose.Types.ObjectId(id);
        } catch {
          return null;
        }
      }).filter(Boolean);
      if (trackObjectIds.length) {
        const trackDocs = await Track.find({ _id: { $in: trackObjectIds } }).lean();
        for (const track of trackDocs) {
          const key = toIdString(track?._id);
          if (key) trackMap.set(key, track);
        }
      }
    }

    const albums = docs.map(doc => {
      const ownerSummary = ownerMap.get(toIdString(doc.userId));
      const albumTrackDocs = Array.isArray(doc.trackIds)
        ? doc.trackIds
            .map(entry => trackMap.get(toIdString(entry?.trackId)))
            .filter(Boolean)
        : [];
      return presentAlbum(req, doc, { ownerSummary, trackDocs: albumTrackDocs });
    });

    const nextCursor = docs.length === limit ? docs[docs.length - 1].updatedAt || docs[docs.length - 1].createdAt : null;

    res.json({ albums, cursor: nextCursor || null });
  } catch (error) {
    console.error('Album list failed', error);
    res.status(500).json({ error: 'could not load albums' });
  }
});

app.get('/api/albums/:id', async (req, res) => {
  const albumId = asObjectId(req.params?.id);
  if (!albumId) {
    return res.status(400).json({ error: 'invalid album id' });
  }

  try {
    const albumDoc = await Album.findById(albumId).lean();
    if (!albumDoc) {
      return res.status(404).json({ error: 'album not found' });
    }

    const owner = albumDoc.userId ? await User.findById(albumDoc.userId) : null;
    const ownerSummary = owner ? await userSummary(req, owner) : null;
    const trackIds = Array.isArray(albumDoc.trackIds)
      ? albumDoc.trackIds.map(entry => asObjectId(entry?.trackId)).filter(Boolean)
      : [];
    let trackDocs = [];
    if (trackIds.length) {
      trackDocs = await Track.find({ _id: { $in: trackIds } }).lean();
    }

    res.json({ album: presentAlbum(req, albumDoc, { ownerSummary, trackDocs }) });
  } catch (error) {
    console.error('Album fetch failed', error);
    res.status(500).json({ error: 'could not load album' });
  }
});

app.post('/api/albums/:id/tracks', auth, (req, res) => {
  if (!ensureDurableUploadsEnabled(res)) {
    return;
  }

  trackUpload.single('audio')(req, res, async (err) => {
    if (err) {
      const message = err.message || 'upload failed';
      return res.status(400).json({ error: message });
    }

    const albumId = asObjectId(req.params?.id);
    if (!albumId) {
      if (req.file?.storageKey) await deleteUploadKey(req.file.storageKey).catch(() => {});
      return res.status(400).json({ error: 'invalid album id' });
    }

    let albumDoc = null;
    try {
      albumDoc = await Album.findById(albumId);
    } catch (lookupError) {
      console.error('Album lookup failed during track upload', lookupError);
    }

    if (!albumDoc) {
      if (req.file?.storageKey) await deleteUploadKey(req.file.storageKey).catch(() => {});
      return res.status(404).json({ error: 'album not found' });
    }

    if (!albumDoc.userId || albumDoc.userId.toString() !== req.user._id.toString()) {
      if (req.file?.storageKey) await deleteUploadKey(req.file.storageKey).catch(() => {});
      return res.status(403).json({ error: 'not your album' });
    }

    if (!req.file) {
      return res.status(400).json({ error: 'missing audio file' });
    }

    if (req.file.size > 10 * 1024 * 1024) {
      await deleteUploadKey(req.file.storageKey).catch(() => {});
      return res.status(400).json({ error: 'track must be 10MB or less' });
    }

    let duration = null;
    try {
      const meta = await parseBuffer(req.file.buffer, req.file.mimetype || null, { duration: true });
      if (meta?.format?.duration) {
        duration = Math.round(meta.format.duration * 1000) / 1000;
      }
    } catch {}

    req.file.buffer = null;

    const body = req.body || {};
    const rawTitle = typeof body.title === 'string' ? body.title.trim() : '';
    const titleFromFile = req.file.originalname ? req.file.originalname.replace(/\.[^.]+$/, '') : 'Untitled';
    const title = (rawTitle || titleFromFile || 'Untitled').slice(0, 160);
    const orderValue = Number.parseInt(body.order, 10);
    const nextOrder = Number.isFinite(orderValue)
      ? Math.max(0, orderValue)
      : (Array.isArray(albumDoc.trackIds) ? albumDoc.trackIds.length : 0);

    try {
      const trackDoc = await Track.create({
        userId: req.user._id,
        title,
        artist: resolveArtistFromUser(req.user) || req.user.email,
        bpm: 0,
        audioUrl: req.file.storageKey,
        coverUrl: albumDoc.coverStorageKey || '',
        audioDurationSec: duration || 0,
        caption: '',
        albumId,
        albumTrackOrder: nextOrder
      });

      albumDoc.trackIds.push({ trackId: trackDoc._id, order: nextOrder });
      await albumDoc.save();

      const ownerSummary = await userSummary(req, req.user);
      const trackIds = albumDoc.trackIds.map(entry => asObjectId(entry?.trackId)).filter(Boolean);
      const trackDocs = trackIds.length ? await Track.find({ _id: { $in: trackIds } }) : [trackDoc];
      const albumPayload = presentAlbum(req, albumDoc, {
        ownerSummary,
        trackDocs
      });
      const payload = albumPayload.tracks.find(entry => toIdString(entry?.id) === trackDoc._id.toString()) || null;

      res.json({
        album: albumPayload,
        track: payload
      });
    } catch (createError) {
      console.error('Album track upload failed', createError);
      await deleteUploadKey(req.file.storageKey).catch(() => {});
      res.status(500).json({ error: 'could not save album track' });
    }
  });
});

app.patch('/api/albums/:id/cover', auth, (req, res) => {
  if (!ensureDurableUploadsEnabled(res)) {
    return;
  }

  trackUpload.single('cover')(req, res, async (err) => {
    if (err) {
      const message = err.message || 'upload failed';
      return res.status(400).json({ error: message });
    }

    const albumId = asObjectId(req.params?.id);
    if (!albumId) {
      if (req.file?.storageKey) await deleteUploadKey(req.file.storageKey).catch(() => {});
      return res.status(400).json({ error: 'invalid album id' });
    }

    let albumDoc = null;
    try {
      albumDoc = await Album.findById(albumId);
    } catch (lookupError) {
      console.error('Album lookup failed during cover update', lookupError);
    }

    if (!albumDoc) {
      if (req.file?.storageKey) await deleteUploadKey(req.file.storageKey).catch(() => {});
      return res.status(404).json({ error: 'album not found' });
    }

    if (!albumDoc.userId || albumDoc.userId.toString() !== req.user._id.toString()) {
      if (req.file?.storageKey) await deleteUploadKey(req.file.storageKey).catch(() => {});
      return res.status(403).json({ error: 'not your album' });
    }

    if (!req.file) {
      return res.status(400).json({ error: 'missing file' });
    }

    if (req.file.size > 10 * 1024 * 1024) {
      await deleteUploadKey(req.file.storageKey).catch(() => {});
      return res.status(400).json({ error: 'cover art must be 10MB or less' });
    }

    try {
      await deleteUploadKey(albumDoc.coverStorageKey).catch(() => {});
      albumDoc.coverUrl = req.file.storageKey;
      albumDoc.coverStorageKey = req.file.storageKey;
      await albumDoc.save();

      const ownerSummary = await userSummary(req, req.user);
      res.json({ album: presentAlbum(req, albumDoc, { ownerSummary, trackDocs: [] }) });
    } catch (updateError) {
      console.error('Album cover update failed', updateError);
      if (req.file?.storageKey) await deleteUploadKey(req.file.storageKey).catch(() => {});
      res.status(500).json({ error: 'could not update album cover' });
    }
  });
});

app.patch('/api/albums/:id', auth, async (req, res) => {
  const albumId = asObjectId(req.params?.id);
  if (!albumId) {
    return res.status(400).json({ error: 'invalid album id' });
  }

  let albumDoc = null;
  try {
    albumDoc = await Album.findById(albumId);
  } catch (lookupError) {
    console.error('Album lookup failed during update', lookupError);
  }

  if (!albumDoc) {
    return res.status(404).json({ error: 'album not found' });
  }

  if (!albumDoc.userId || albumDoc.userId.toString() !== req.user._id.toString()) {
    return res.status(403).json({ error: 'not your album' });
  }

  const body = req.body || {};
  const nextTitle = typeof body.title === 'string' ? body.title.trim().slice(0, 160) : null;
  const nextCaption = typeof body.caption === 'string' ? body.caption.trim().slice(0, 500) : null;
  const trackOrder = Array.isArray(body.trackOrder) ? body.trackOrder : null;
  const trackUpdates = Array.isArray(body.tracks) ? body.tracks : [];

  if (nextTitle !== null) {
    albumDoc.title = nextTitle;
  }
  if (nextCaption !== null) {
    albumDoc.caption = nextCaption;
  }

  if (trackOrder) {
    const normalized = trackOrder
      .map(value => ({
        id: asObjectId(value?.id || value),
        order: Number.parseInt(value?.order, 10)
      }))
      .filter(entry => entry.id);

    if (normalized.length) {
      const orderMap = new Map(normalized.map(entry => [entry.id.toString(), Number.isFinite(entry.order) ? entry.order : 0]));
      albumDoc.trackIds = albumDoc.trackIds
        .map(entry => {
          const key = toIdString(entry?.trackId);
          if (!key) return null;
          if (!orderMap.has(key)) return { ...entry, trackId: entry.trackId, order: entry.order || 0 };
          return { trackId: entry.trackId, order: orderMap.get(key) };
        })
        .filter(Boolean)
        .sort((a, b) => (Number(a.order) || 0) - (Number(b.order) || 0));
    }
  }

  if (trackUpdates.length) {
    const bulk = [];
    for (const entry of trackUpdates) {
      const trackId = asObjectId(entry?.id || entry?.trackId);
      if (!trackId) continue;
      const update = {};
      if (typeof entry?.title === 'string') {
        const trimmed = entry.title.trim();
        if (trimmed) update.title = trimmed.slice(0, 160);
      }
      if (Number.isFinite(entry?.order)) {
        update.albumTrackOrder = Math.max(0, Number(entry.order));
      }
      if (Number.isFinite(entry?.duration) || Number.isFinite(entry?.durationSec)) {
        const durationValue = Number.isFinite(entry.duration) ? Number(entry.duration) : Number(entry.durationSec);
        update.audioDurationSec = Math.max(0, durationValue || 0);
      }
      if (Object.keys(update).length) {
        bulk.push({
          updateOne: {
            filter: { _id: trackId, albumId },
            update: { $set: update }
          }
        });
      }
    }
    if (bulk.length) {
      try {
        await Track.bulkWrite(bulk, { ordered: false });
      } catch (bulkError) {
        console.warn('Album track metadata update encountered errors', bulkError);
      }
    }
  }

  try {
    await albumDoc.save();
    const ownerSummary = await userSummary(req, req.user);
    const trackIds = albumDoc.trackIds.map(entry => asObjectId(entry?.trackId)).filter(Boolean);
    const trackDocs = trackIds.length ? await Track.find({ _id: { $in: trackIds } }) : [];
    res.json({ album: presentAlbum(req, albumDoc, { ownerSummary, trackDocs }) });
  } catch (updateError) {
    console.error('Album update failed', updateError);
    res.status(500).json({ error: 'could not update album' });
  }
});

app.delete('/api/albums/:id', auth, async (req, res) => {
  const albumId = asObjectId(req.params?.id);
  if (!albumId) {
    return res.status(400).json({ error: 'invalid album id' });
  }

  let albumDoc = null;
  try {
    albumDoc = await Album.findById(albumId);
  } catch (lookupError) {
    console.error('Album lookup failed during delete', lookupError);
  }

  if (!albumDoc) {
    return res.status(404).json({ error: 'album not found' });
  }

  if (!albumDoc.userId || albumDoc.userId.toString() !== req.user._id.toString()) {
    return res.status(403).json({ error: 'not your album' });
  }

  const trackIds = Array.isArray(albumDoc.trackIds)
    ? albumDoc.trackIds.map(entry => asObjectId(entry?.trackId)).filter(Boolean)
    : [];

  try {
    if (trackIds.length) {
      const tracks = await Track.find({ _id: { $in: trackIds } });
      for (const trackDoc of tracks) {
        await Track.deleteOne({ _id: trackDoc._id });
        await TrackStats.deleteOne({ trackId: trackDoc._id });
        await TrackEvent.deleteMany({ trackId: trackDoc._id });
        await TrackComment.deleteMany({ trackId: trackDoc._id });
        await deleteStoredUpload(trackDoc.audioUrl, 'tracks');
        await deleteStoredUpload(trackDoc.coverUrl, 'covers');
      }
    }

    await deleteUploadKey(albumDoc.coverStorageKey).catch(() => {});
    await Album.deleteOne({ _id: albumDoc._id });
    res.json({ ok: true });
  } catch (deleteError) {
    console.error('Album delete failed', deleteError);
    res.status(500).json({ error: 'could not delete album' });
  }
});

app.post('/api/playlists', auth, async (req, res) => {
  const rawTitle = typeof req.body?.title === 'string' ? req.body.title.trim() : '';
  const title = rawTitle ? rawTitle.slice(0, 160) : '';

  try {
    const playlistDoc = await Playlist.create({
      userId: req.user._id,
      title,
      coverUrl: '',
      coverStorageKey: '',
      trackIds: []
    });
    const ownerSummary = await userSummary(req, req.user);
    res.json({ playlist: presentPlaylist(req, playlistDoc, { ownerSummary, trackDocs: [] }) });
  } catch (error) {
    console.error('Playlist create failed', error);
    res.status(500).json({ error: 'could not create playlist' });
  }
});

app.get('/api/playlists', auth, async (req, res) => {
  try {
    const playlistDocs = await Playlist.find({ userId: req.user._id })
      .sort({ updatedAt: -1, createdAt: -1, _id: -1 })
      .lean();

    const trackIdStrings = [];
    for (const playlistDoc of playlistDocs) {
      if (!Array.isArray(playlistDoc.trackIds)) continue;
      for (const ref of playlistDoc.trackIds) {
        const id = toIdString(ref?.trackId);
        if (id) trackIdStrings.push(id);
      }
    }

    let trackMap = new Map();
    if (trackIdStrings.length) {
      const uniqueIds = Array.from(new Set(trackIdStrings));
      const objectIds = uniqueIds
        .map((value) => {
          try {
            return new mongoose.Types.ObjectId(value);
          } catch {
            return null;
          }
        })
        .filter(Boolean);
      if (objectIds.length) {
        const docs = await Track.find({ _id: { $in: objectIds } }).lean();
        trackMap = new Map(docs.map((entry) => [toIdString(entry?._id), entry]));
      }
    }

    const ownerSummary = await userSummary(req, req.user);
    const playlists = playlistDocs
      .map((playlistDoc) => {
        const trackDocs = Array.isArray(playlistDoc.trackIds)
          ? playlistDoc.trackIds
              .map((ref) => trackMap.get(toIdString(ref?.trackId)))
              .filter(Boolean)
          : [];
        return presentPlaylist(req, playlistDoc, { ownerSummary, trackDocs });
      })
      .filter(Boolean);

    res.json({ playlists });
  } catch (error) {
    console.error('Playlist list failed', error);
    res.status(500).json({ error: 'could not load playlists' });
  }
});

app.get('/api/playlists/:id', auth, async (req, res) => {
  const playlistId = asObjectId(req.params?.id);
  if (!playlistId) {
    return res.status(400).json({ error: 'invalid playlist id' });
  }

  let playlistDoc = null;
  try {
    playlistDoc = await Playlist.findById(playlistId);
  } catch (lookupError) {
    console.error('Playlist lookup failed', lookupError);
  }

  if (!playlistDoc) {
    return res.status(404).json({ error: 'playlist not found' });
  }

  if (!playlistDoc.userId || playlistDoc.userId.toString() !== req.user._id.toString()) {
    return res.status(403).json({ error: 'not your playlist' });
  }

  try {
    const trackIds = Array.isArray(playlistDoc.trackIds)
      ? playlistDoc.trackIds.map((entry) => asObjectId(entry?.trackId)).filter(Boolean)
      : [];
    const trackDocs = trackIds.length ? await Track.find({ _id: { $in: trackIds } }).lean() : [];
    const ownerSummary = await userSummary(req, req.user);
    res.json({ playlist: presentPlaylist(req, playlistDoc, { ownerSummary, trackDocs }) });
  } catch (error) {
    console.error('Playlist fetch failed', error);
    res.status(500).json({ error: 'could not load playlist' });
  }
});

app.patch('/api/playlists/:id', auth, async (req, res) => {
  const playlistId = asObjectId(req.params?.id);
  if (!playlistId) {
    return res.status(400).json({ error: 'invalid playlist id' });
  }

  let playlistDoc = null;
  try {
    playlistDoc = await Playlist.findById(playlistId);
  } catch (lookupError) {
    console.error('Playlist lookup failed during update', lookupError);
  }

  if (!playlistDoc) {
    return res.status(404).json({ error: 'playlist not found' });
  }

  if (!playlistDoc.userId || playlistDoc.userId.toString() !== req.user._id.toString()) {
    return res.status(403).json({ error: 'not your playlist' });
  }

  const body = req.body || {};
  const nextTitle = typeof body.title === 'string' ? body.title.trim().slice(0, 160) : null;
  if (nextTitle !== null) {
    playlistDoc.title = nextTitle;
  }

  const tracksInput = Array.isArray(body.trackIds)
    ? body.trackIds
    : (Array.isArray(body.tracks) ? body.tracks : null);

  let responseTrackMap = new Map();
  if (tracksInput) {
    const normalized = tracksInput
      .map((entry, index) => {
        if (!entry) return null;
        if (typeof entry === 'string') {
          return { id: entry, order: index };
        }
        if (typeof entry === 'object') {
          const idValue = entry.id || entry.trackId || entry._id || entry;
          if (!idValue) return null;
          const orderValue = Number.isFinite(entry.order) ? Number(entry.order) : index;
          return { id: idValue, order: orderValue };
        }
        return null;
      })
      .filter(Boolean);

    const uniqueTrackIds = Array.from(new Set(normalized.map((entry) => toIdString(entry.id)).filter(Boolean)));
    const objectIds = uniqueTrackIds
      .map((value) => {
        try {
          return new mongoose.Types.ObjectId(value);
        } catch {
          return null;
        }
      })
      .filter(Boolean);

    let trackDocs = [];
    if (objectIds.length) {
      trackDocs = await Track.find({ _id: { $in: objectIds }, userId: req.user._id }).lean();
    }

    const trackDocMap = new Map(trackDocs.map((doc) => [toIdString(doc?._id), doc]));
    responseTrackMap = trackDocMap;
    const nextTrackRefs = [];
    normalized.forEach((entry, index) => {
      const key = toIdString(entry.id);
      if (!key) return;
      const trackDoc = trackDocMap.get(key);
      if (!trackDoc) return;
      const orderValue = Number.isFinite(entry.order) ? entry.order : index;
      nextTrackRefs.push({ trackId: trackDoc._id, order: Math.max(0, Number(orderValue) || 0) });
    });
    playlistDoc.trackIds = nextTrackRefs;
  }

  try {
    await playlistDoc.save();
  } catch (error) {
    console.error('Playlist update failed', error);
    return res.status(500).json({ error: 'could not update playlist' });
  }

  try {
    const trackIds = Array.isArray(playlistDoc.trackIds)
      ? playlistDoc.trackIds.map((entry) => asObjectId(entry?.trackId)).filter(Boolean)
      : [];
    let trackDocs = [];
    if (trackIds.length) {
      if (responseTrackMap.size) {
        trackDocs = playlistDoc.trackIds
          .map((entry) => responseTrackMap.get(toIdString(entry?.trackId)))
          .filter(Boolean);
      }
      if (!trackDocs.length) {
        trackDocs = await Track.find({ _id: { $in: trackIds } }).lean();
      }
    }
    const ownerSummary = await userSummary(req, req.user);
    res.json({ playlist: presentPlaylist(req, playlistDoc, { ownerSummary, trackDocs }) });
  } catch (error) {
    console.error('Playlist load after update failed', error);
    res.status(500).json({ error: 'could not load playlist' });
  }
});

app.patch('/api/playlists/:id/cover', auth, (req, res) => {
  if (!ensureDurableUploadsEnabled(res)) {
    return;
  }

  trackUpload.single('cover')(req, res, async (err) => {
    if (err) {
      const message = err.message || 'upload failed';
      return res.status(400).json({ error: message });
    }

    const playlistId = asObjectId(req.params?.id);
    if (!playlistId) {
      if (req.file?.storageKey) await deleteUploadKey(req.file.storageKey).catch(() => {});
      return res.status(400).json({ error: 'invalid playlist id' });
    }

    let playlistDoc = null;
    try {
      playlistDoc = await Playlist.findById(playlistId);
    } catch (lookupError) {
      console.error('Playlist lookup failed during cover update', lookupError);
    }

    if (!playlistDoc) {
      if (req.file?.storageKey) await deleteUploadKey(req.file.storageKey).catch(() => {});
      return res.status(404).json({ error: 'playlist not found' });
    }

    if (!playlistDoc.userId || playlistDoc.userId.toString() !== req.user._id.toString()) {
      if (req.file?.storageKey) await deleteUploadKey(req.file.storageKey).catch(() => {});
      return res.status(403).json({ error: 'not your playlist' });
    }

    if (!req.file) {
      return res.status(400).json({ error: 'missing file' });
    }

    if (req.file.size > 10 * 1024 * 1024) {
      await deleteUploadKey(req.file.storageKey).catch(() => {});
      return res.status(400).json({ error: 'cover art must be 10MB or less' });
    }

    try {
      await deleteUploadKey(playlistDoc.coverStorageKey).catch(() => {});
      playlistDoc.coverUrl = req.file.storageKey;
      playlistDoc.coverStorageKey = req.file.storageKey;
      await playlistDoc.save();

      const trackIds = Array.isArray(playlistDoc.trackIds)
        ? playlistDoc.trackIds.map((entry) => asObjectId(entry?.trackId)).filter(Boolean)
        : [];
      const trackDocs = trackIds.length ? await Track.find({ _id: { $in: trackIds } }).lean() : [];
      const ownerSummary = await userSummary(req, req.user);
      res.json({ playlist: presentPlaylist(req, playlistDoc, { ownerSummary, trackDocs }) });
    } catch (updateError) {
      console.error('Playlist cover update failed', updateError);
      if (req.file?.storageKey) await deleteUploadKey(req.file.storageKey).catch(() => {});
      res.status(500).json({ error: 'could not update playlist cover' });
    }
  });
});

app.delete('/api/playlists/:id', auth, async (req, res) => {
  const playlistId = asObjectId(req.params?.id);
  if (!playlistId) {
    return res.status(400).json({ error: 'invalid playlist id' });
  }

  let playlistDoc = null;
  try {
    playlistDoc = await Playlist.findById(playlistId);
  } catch (lookupError) {
    console.error('Playlist lookup failed during delete', lookupError);
  }

  if (!playlistDoc) {
    return res.status(404).json({ error: 'playlist not found' });
  }

  if (!playlistDoc.userId || playlistDoc.userId.toString() !== req.user._id.toString()) {
    return res.status(403).json({ error: 'not your playlist' });
  }

  try {
    await deleteUploadKey(playlistDoc.coverStorageKey).catch(() => {});
    await Playlist.deleteOne({ _id: playlistDoc._id });
    res.json({ ok: true });
  } catch (error) {
    console.error('Playlist delete failed', error);
    res.status(500).json({ error: 'could not delete playlist' });
  }
});

app.patch('/api/tracks/:id', auth, async (req, res) => {
  const trackId = asObjectId(req.params?.id);
  if (!trackId) {
    return res.status(400).json({ error: 'invalid track id' });
  }

  const body = req.body || {};
  const rawTitle = typeof body.title === 'string' ? body.title.trim() : '';
  if (!rawTitle) {
    return res.status(400).json({ error: 'title is required' });
  }
  const nextTitle = rawTitle.slice(0, 140);

  let trackDoc = null;
  try {
    trackDoc = await Track.findById(trackId);
  } catch (err) {
    console.error('Track lookup failed during rename', err);
  }
  if (!trackDoc) {
    return res.status(404).json({ error: 'track not found' });
  }
  if (!trackDoc.userId || trackDoc.userId.toString() !== req.user._id.toString()) {
    return res.status(403).json({ error: 'not your track' });
  }

  trackDoc.title = nextTitle;
  try {
    await trackDoc.save();
  } catch (err) {
    console.error('Track rename failed', err);
    return res.status(500).json({ error: 'could not update track title' });
  }

  return res.json({ id: trackDoc._id, title: trackDoc.title });
});

app.delete('/api/tracks/:id', auth, async (req, res) => {
  const trackId = asObjectId(req.params?.id);
  if (!trackId) {
    return res.status(400).json({ error: 'invalid track id' });
  }

  let trackDoc = null;
  try {
    trackDoc = await Track.findById(trackId);
  } catch (ex) {
    console.error('Track lookup failed during delete', ex);
  }

  if (!trackDoc) {
    return res.status(404).json({ error: 'track not found' });
  }

  if (!trackDoc.userId || trackDoc.userId.toString() !== req.user._id.toString()) {
    return res.status(403).json({ error: 'not your track' });
  }

  const albumId = trackDoc.albumId ? trackDoc.albumId.toString() : null;

  try {
    await Track.deleteOne({ _id: trackDoc._id });
    await TrackStats.deleteOne({ trackId: trackDoc._id });
    await TrackEvent.deleteMany({ trackId: trackDoc._id });
    await TrackComment.deleteMany({ trackId: trackDoc._id });
    if (albumId) {
      await Album.updateOne(
        { _id: trackDoc.albumId },
        { $pull: { trackIds: { trackId: trackDoc._id } } }
      );
    }
  } catch (ex) {
    console.error('Track delete failed', ex);
    return res.status(500).json({ error: 'could not delete track' });
  }

  await Promise.all([
    deleteStoredUpload(trackDoc.audioUrl, 'tracks'),
    deleteStoredUpload(trackDoc.coverUrl, 'covers')
  ]);

  res.json({ ok: true });
});

app.get('/api/tracks', async (req, res) => {
  try {
    const limitParam = Number.parseInt(req.query?.limit, 10);
    const limit = Number.isFinite(limitParam) ? Math.min(Math.max(limitParam, 1), 50) : 10;
    const cursorRaw = req.query?.cursor;
    let cursorDate = null;
    if (cursorRaw) {
      const parsed = new Date(cursorRaw);
      if (!Number.isNaN(parsed.valueOf())) {
        cursorDate = parsed;
      }
    }

    const query = {};
    if (cursorDate) {
      query.$or = [
        { bumpedAt: { $lt: cursorDate } },
        { bumpedAt: { $exists: false }, createdAt: { $lt: cursorDate } }
      ];
    }

    const docs = await Track.find(query)
      .sort({ bumpedAt: -1, createdAt: -1, _id: -1 })
      .limit(limit)
      .lean();
    const trackIds = docs.map(doc => doc._id).filter(Boolean);
    const userIds = Array.from(new Set(docs.map(doc => toIdString(doc.userId)).filter(Boolean)));

    let userMap = new Map();
    if (userIds.length) {
      const objectIds = userIds.map(id => {
        try {
          return new mongoose.Types.ObjectId(id);
        } catch {
          return null;
        }
      }).filter(Boolean);
      if (objectIds.length) {
        const users = await User.find({ _id: { $in: objectIds } });
        const summaries = await Promise.all(users.map(async (u) => [toIdString(u._id), await userSummary(req, u)]));
        userMap = new Map(summaries.filter(([key]) => Boolean(key)));
      }
    }

    let statsMap = new Map();
    if (trackIds.length) {
      const statsRows = await TrackStat.find({ trackId: { $in: trackIds } }).lean();
      statsMap = new Map(statsRows.map(row => [toIdString(row.trackId) || String(row.trackId), statsSummary(row)]));
    }

    const commentsByTrack = new Map();
    if (trackIds.length) {
      const commentRows = await TrackComment.find({ trackId: { $in: trackIds } }).sort({ createdAt: 1 }).lean();
      for (const comment of commentRows) {
        const key = toIdString(comment.trackId) || String(comment.trackId);
        if (!key) continue;
        if (!commentsByTrack.has(key)) commentsByTrack.set(key, []);
        const list = commentsByTrack.get(key);
        if (list.length >= 100) continue;
        list.push(commentSummary(req, comment));
      }
    }

    const tracks = docs.map(doc => {
      const userKey = toIdString(doc.userId);
      const key = toIdString(doc._id) || String(doc._id);
      const audioUrl = doc.audioUrl ? publicUploadUrl(req, doc.audioUrl) : '';
      const coverUrl = doc.coverUrl ? publicUploadUrl(req, doc.coverUrl) : '';
      return {
        id: doc._id,
        title: doc.title || 'Untitled',
        artist: doc.artist || '',
        bpm: doc.bpm || 0,
        audioUrl,
        coverUrl: coverUrl || null,
        duration: doc.audioDurationSec || null,
        caption: doc.caption || '',
        createdAt: doc.createdAt,
        bumpedAt: doc.bumpedAt || doc.createdAt,
        userId: doc.userId,
        albumId: doc.albumId || null,
        albumTrackOrder: Number.isFinite(doc.albumTrackOrder) ? doc.albumTrackOrder : null,
        user: userKey ? userMap.get(userKey) || null : null,
        stats: statsSummary(statsMap.get(key)),
        comments: commentsByTrack.get(key) || [],
        source: doc.source || 'upload',
        sourceId: doc.sourceId || '',
        sourcePermalinkUrl: doc.sourcePermalinkUrl || '',
        streamUrl: doc.streamUrl || audioUrl,
        streamProtocol: doc.streamProtocol || ''
      };
    });

    const last = docs.length ? docs[docs.length - 1] : null;
    const cursorSource = last ? (last.bumpedAt || last.createdAt) : null;
    const nextCursor = cursorSource ? new Date(cursorSource).toISOString() : null;

    res.json({ tracks, nextCursor });
  } catch (err) {
    console.error('Failed to load tracks', err);
    res.status(500).json({ error: 'failed to load tracks' });
  }
});

async function handleTrackMetric(req, res, { field, type }) {
  const id = asObjectId(req.params.id);
  if (!id) return res.status(400).json({ error: 'invalid track id' });

  const track = await trackById(id);
  if (!track) return res.status(404).json({ error: 'track not found' });

  const count = sanitizeCount(req.body?.count) || 1;
  const timestamp = coerceDate(req.body?.timestamp);
  const metadata = {};
  if (timestamp) metadata.timestamp = timestamp;
  let skipEvent = false;

  if (type === 'play') {
    const rawListened = Number(req.body?.listenedSec ?? req.body?.playedSec ?? req.body?.progressSec);
    const listenedSec = Number.isFinite(rawListened) && rawListened > 0 ? rawListened : 0;
    const rawDuration = Number(req.body?.durationSec);
    const durationSec = Number.isFinite(rawDuration) && rawDuration > 0 ? rawDuration : 0;
    let trackDuration = Number(track.audioDurationSec);
    if (!Number.isFinite(trackDuration) || trackDuration <= 0) {
      trackDuration = durationSec;
    }
    const requiredSeconds = trackDuration >= 20 || trackDuration <= 0
      ? 20
      : Math.max(trackDuration, 0);
    metadata.requiredSeconds = requiredSeconds;
    if (durationSec) metadata.durationSec = durationSec;
    if (listenedSec) metadata.listenedSec = listenedSec;

    if (requiredSeconds > 0 && listenedSec + 0.05 < requiredSeconds) {
      return res.status(202).json({
        ok: false,
        ignored: true,
        reason: 'insufficient_listen_time',
        requiredSeconds
      });
    }

    const recentPlay = await TrackEvent.findOne({
      trackId: track._id,
      userId: req.user._id,
      type: 'play'
    }).sort({ createdAt: -1 });
    if (recentPlay) {
      const sinceMs = Date.now() - new Date(recentPlay.createdAt).getTime();
      if (sinceMs < 500) {
        return res.status(202).json({ ok: false, ignored: true, reason: 'duplicate_play' });
      }
    }
  }

  if (type === 'repost') {
    const eventMeta = { ...metadata };
    delete eventMeta.timestamp;
    if (!eventMeta.source) eventMeta.source = 'live';
    const existing = await TrackEvent.findOneAndUpdate(
      { trackId: track._id, userId: req.user._id, type: 'repost' },
      {
        $setOnInsert: {
          trackId: track._id,
          userId: req.user._id,
          type: 'repost',
          count,
          createdAt: timestamp || new Date(),
          metadata: eventMeta
        }
      },
      { upsert: true, new: false }
    );
    if (existing) {
      return res.status(409).json({ error: 'already reposted' });
    }
    skipEvent = true;
  }

  const stats = await incrementTrackStats({
    trackId: track._id,
    userId: req.user._id,
    field,
    count,
    type,
    metadata,
    skipEvent
  });

  if (type === 'repost') {
    try {
      track.bumpedAt = new Date();
      await track.save();
    } catch (err) {
      console.warn('Failed to bump track after repost', err);
    }
  }

  res.json({ ok: true, stats: statsSummary(stats) });
}

app.post('/api/tracks/:id/plays', auth, async (req, res) => {
  await handleTrackMetric(req, res, { field: 'plays', type: 'play' });
});

app.post('/api/tracks/:id/likes', auth, async (req, res) => {
  await handleTrackMetric(req, res, { field: 'likes', type: 'like' });
});

app.post('/api/tracks/:id/reposts', auth, async (req, res) => {
  await handleTrackMetric(req, res, { field: 'reposts', type: 'repost' });
});

app.post('/api/tracks/:id/stats/backfill', auth, async (req, res) => {
  const id = asObjectId(req.params.id);
  if (!id) return res.status(400).json({ error: 'invalid track id' });

  const track = await trackById(id);
  if (!track) return res.status(404).json({ error: 'track not found' });

  const increments = {
    plays: sanitizeCount(req.body?.plays),
    likes: sanitizeCount(req.body?.likes),
    reposts: sanitizeCount(req.body?.reposts)
  };

  let stats = await TrackStat.findOne({ trackId: track._id });
  const entries = [
    ['plays', 'play'],
    ['likes', 'like'],
    ['reposts', 'repost']
  ];

  for (const [field, type] of entries) {
    const inc = increments[field];
    if (inc && inc > 0) {
      stats = await incrementTrackStats({
        trackId: track._id,
        userId: req.user._id,
        field,
        count: inc,
        type,
        metadata: { source: 'backfill' }
      });
    }
  }

  if (!stats) {
    stats = await TrackStat.findOneAndUpdate(
      { trackId: track._id },
      { $setOnInsert: { trackId: track._id } },
      { new: true, upsert: true }
    );
  }

  res.json({ ok: true, stats: statsSummary(stats) });
});

app.get('/api/tracks/:id/stats', auth, async (req, res) => {
  const id = asObjectId(req.params.id);
  if (!id) return res.status(400).json({ error: 'invalid track id' });
  const stats = await TrackStat.findOne({ trackId: id });
  res.json({ stats: statsSummary(stats) });
});

app.get('/api/tracks/:id/comments', auth, async (req, res) => {
  const id = asObjectId(req.params.id);
  if (!id) return res.status(400).json({ error: 'invalid track id' });
  const comments = await TrackComment.find({ trackId: id }).sort({ createdAt: 1 }).limit(200);
  res.json({ comments: comments.map(comment => commentSummary(req, comment)) });
});

app.post('/api/tracks/:id/comments', auth, async (req, res) => {
  const id = asObjectId(req.params.id);
  if (!id) return res.status(400).json({ error: 'invalid track id' });

  const track = await trackById(id);
  if (!track) return res.status(404).json({ error: 'track not found' });

  const body = req.body || {};
  const rawText = typeof body.text === 'string' ? body.text.trim() : '';
  if (!rawText) return res.status(400).json({ error: 'comment text required' });

  const text = rawText.slice(0, 500);
  const rawTime = body.time ?? body.timeSec ?? body.timestamp ?? 0;
  let timeSec = Number(rawTime);
  if (!Number.isFinite(timeSec) || timeSec < 0) timeSec = 0;
  if (timeSec > 3600) timeSec = 3600;
  const clientId = typeof body.clientId === 'string' && body.clientId.trim()
    ? body.clientId.trim().slice(0, 120)
    : null;

  const payload = {
    trackId: track._id,
    userId: req.user._id,
    text,
    timeSec,
    clientId,
    userSnapshot: commentSnapshot(req, req.user)
  };

  let created = false;
  let commentDoc = null;
  try {
    commentDoc = await TrackComment.create(payload);
    created = true;
  } catch (err) {
    if (clientId && err?.code === 11000) {
      commentDoc = await TrackComment.findOne({ trackId: track._id, clientId });
    } else {
      console.error('Failed to create comment', err);
      return res.status(500).json({ error: 'could not save comment' });
    }
  }

  if (!commentDoc) {
    return res.status(500).json({ error: 'could not save comment' });
  }

  let stats = await TrackStat.findOne({ trackId: track._id });
  if (created) {
    stats = await incrementTrackStats({
      trackId: track._id,
      userId: req.user._id,
      field: 'comments',
      count: 1,
      type: 'comment',
      metadata: { commentId: commentDoc._id }
    });
  } else if (!stats) {
    stats = await TrackStat.findOneAndUpdate(
      { trackId: track._id },
      { $setOnInsert: { trackId: track._id } },
      { new: true, upsert: true }
    );
  }

  res.json({ ok: true, comment: commentSummary(req, commentDoc), stats: statsSummary(stats) });
});

app.get('/api/leaderboard', auth, async (req, res) => {
  try {
    const statsDocs = await TrackStat.find({}).sort({ plays: -1, likes: -1, reposts: -1, comments: -1 }).limit(200).lean();
    if (!statsDocs.length) {
      return res.json({ top: [] });
    }

    const trackIds = statsDocs.map(doc => doc.trackId).filter(Boolean);
    const tracks = await Track.find({ _id: { $in: trackIds } }).lean();
    const trackMap = new Map(tracks.map(doc => [toIdString(doc._id) || String(doc._id), doc]));

    const userIds = Array.from(new Set(tracks.map(doc => toIdString(doc.userId)).filter(Boolean)));
    let userMap = new Map();
    if (userIds.length) {
      const userObjectIds = userIds.map(id => {
        try {
          return new mongoose.Types.ObjectId(id);
        } catch {
          return null;
        }
      }).filter(Boolean);
      if (userObjectIds.length) {
        const users = await User.find({ _id: { $in: userObjectIds } });
        const summaries = await Promise.all(users.map(async u => [toIdString(u._id), await userSummary(req, u)]));
        userMap = new Map(summaries.filter(([key]) => Boolean(key)));
      }
    }

    const entries = [];
    for (const statsDoc of statsDocs) {
      const key = toIdString(statsDoc.trackId) || String(statsDoc.trackId);
      if (!key) continue;
      const trackDoc = trackMap.get(key);
      if (!trackDoc) continue;
      const stats = statsSummary(statsDoc);
      const score = computeLeaderboardScore(stats);
      const userKey = toIdString(trackDoc.userId);
      const audioUrl = trackDoc.audioUrl ? publicUploadUrl(req, trackDoc.audioUrl) : '';
      const coverUrl = trackDoc.coverUrl ? publicUploadUrl(req, trackDoc.coverUrl) : '';
      entries.push({
        score,
        stats,
          track: {
            id: trackDoc._id,
            title: trackDoc.title || 'Untitled',
            artist: trackDoc.artist || '',
            bpm: trackDoc.bpm || 0,
            audioUrl,
            coverUrl: coverUrl || null,
            duration: trackDoc.audioDurationSec || null,
            caption: trackDoc.caption || '',
            createdAt: trackDoc.createdAt,
            bumpedAt: trackDoc.bumpedAt || trackDoc.createdAt,
            userId: trackDoc.userId,
            user: userKey ? userMap.get(userKey) || null : null,
            stats
          }
        });
    }

    entries.sort((a, b) => b.score - a.score);
    res.json({ top: entries.slice(0, 20) });
  } catch (err) {
    console.error('Failed to build leaderboard', err);
    res.status(500).json({ error: 'failed to load leaderboard' });
  }
});

/* ============================ Sessions API ============================ */
app.get('/api/sessions', async (req, res) => {
  await reapStaleSessions({ emit: false });
  const sessionsRaw = await Session.find({ isActive: true }).sort({ createdAt: -1 }).lean();
  const sessions = sessionsRaw.filter(s => Array.isArray(s.participants) ? s.participants.length > 0 : false);
  // include host info + name + counts for the feed
  const hostIds = sessions.map(s => s.hostUserId).filter(Boolean);
  const hosts = await User.find({ _id: { $in: hostIds } }).select('name avatarUrl avatarStorageKey profileColor');
  const hostMap = new Map(hosts.map(h => {
    const key = toIdString(h._id) || String(h._id);
    return [key, {
      name: h.name,
      avatar: presentStoredUploadUrl(req, h.avatarUrl, h.avatarStorageKey),
      profileColor: resolveProfileColor(h.profileColor)
    }];
  }));
  const out = sessions.map(s => ({
    id: s._id,
    name: s.name || 'Untitled',
    tempo: s.tempo,
    participants: Array.isArray(s.participants) ? s.participants.length : 0,
    maxPlayers: s.maxPlayers,
    openSec: Math.floor((Date.now() - new Date(s.createdAt).getTime()) / 1000),
    host: (() => {
      const key = toIdString(s.hostUserId) || String(s.hostUserId);
      return hostMap.get(key) || null;
    })()
  }));
  res.json({ sessions: out });
});

app.post('/api/sessions', auth, async (req, res) => {
  const { tempo = 92, maxPlayers = 8, name = '' } = req.body || {};
  const hostId = toIdString(req.user._id) || String(req.user._id);
  const session = await Session.create({
    name: (name || '').trim() || undefined,
    hostUserId: req.user._id,
    tempo,
    maxPlayers,
    participants: [req.user._id],
    participantsHistory: [req.user._id],
    playerColors: { [hostId]: PLAYER_COLOR_PALETTE[0] }
  });
  res.json({ id: session._id.toString() });
});

app.post('/api/sessions/:id/join', auth, async (req, res) => {
  const s = await Session.findById(req.params.id);
  if (!s || !s.isActive) return res.status(404).json({ error: 'session not found' });
  ensureGridShape(s);
  if (!Array.isArray(s.participants)) s.participants = [];

  if (s.participants.length === 0 && s.lastEmptyAt) {
    const last = new Date(s.lastEmptyAt).getTime();
    if (!Number.isNaN(last) && Date.now() - last >= SESSION_EMPTY_TTL_MS) {
      s.isActive = false;
      await s.save();
      return res.status(410).json({ error: 'session expired' });
    }
  }

  const userKey = participantKey(req.user._id);
  const fallbackKeyRaw = String(req.user._id ?? '').trim();
  const fallbackKey = (!fallbackKeyRaw || fallbackKeyRaw === 'null' || fallbackKeyRaw === 'undefined' || fallbackKeyRaw === '[object Object]')
    ? null
    : fallbackKeyRaw;
  const beforeColor = (userKey && s.playerColors?.[userKey]) || (fallbackKey && s.playerColors?.[fallbackKey]) || null;
  const assignedColor = ensurePlayerColors(s, req.user._id);
  const already = userKey
    ? s.participants.some(p => participantKey(p) === userKey)
    : false;
  let changed = false;
  if (!beforeColor && assignedColor) changed = true;

  if (s.participants.length >= s.maxPlayers && !already) {
    return res.status(409).json({ error: 'session full' });
  }
  if (!already) {
    s.participants.push(req.user._id);
    s.lastEmptyAt = undefined;
    s.isActive = true;
    changed = true;
  }
  const historyAdded = ensureParticipantHistory(s, req.user._id);
  if (historyAdded) changed = true;
  if (changed) await s.save();
  const participants = await rosterFor(s, req);
  const history = await participantHistoryFor(s, req);
  const { rows = 8, cols = 16, map = {} } = s.grid || {};
  const plainMap = {};
  for (const [key, value] of Object.entries(map || {})) {
    if (!value) continue;
    if (typeof value === 'object') {
      plainMap[key] = {
        on: true,
        user: value.user ? toIdString(value.user) || (typeof value.user === 'string' ? value.user : null) : null,
        color: (() => {
          if (value.color) return value.color;
          const ownerKey = value.user ? (toIdString(value.user) || (typeof value.user === 'string' ? value.user : null)) : null;
          if (ownerKey && s.playerColors?.[ownerKey]) return s.playerColors[ownerKey];
          const fallbackRaw = value.user ? String(value.user ?? '').trim() : null;
          if (!fallbackRaw || fallbackRaw === 'null' || fallbackRaw === 'undefined' || fallbackRaw === '[object Object]') return null;
          return s.playerColors?.[fallbackRaw] || null;
        })()
      };
    } else {
      plainMap[key] = { on: !!value, user: null, color: null };
    }
  }
  res.json({
    ok: true,
    tempo: s.tempo,
    participants,
    maxPlayers: s.maxPlayers,
    grid: { rows, cols, map: plainMap },
    history
  });
});

app.get('/api/sessions/:id', auth, async (req, res) => {
  const s = await Session.findById(req.params.id);
  if (!s || !s.isActive) return res.status(404).json({ error: 'session not found' });
  const roster = await rosterFor(s, req);
  const history = await participantHistoryFor(s, req);
  res.json({
    id: s._id.toString(),
    name: s.name || 'Untitled',
    tempo: s.tempo,
    maxPlayers: s.maxPlayers,
    roster,
    history
  });
});

app.post('/api/sessions/:id/leave', auth, async (req, res) => {
  const s = await Session.findById(req.params.id);
  if (!s) return res.json({ ok: true });
  const targetId = participantKey(req.user._id);
  const fallback = (() => {
    const raw = String(req.user._id ?? '').trim();
    if (!raw || raw === 'null' || raw === 'undefined' || raw === '[object Object]') return null;
    return raw;
  })();
  s.participants = (s.participants || []).filter(p => {
    const key = participantKey(p);
    if (!key) return true;
    if (targetId) return key !== targetId;
    if (fallback) return key !== fallback;
    return true;
  });
  if (s.participants.length === 0) {
    s.lastEmptyAt = new Date();
  }
  await s.save();
  res.json({ ok: true });
});

app.post('/api/sessions/:id/tempo', auth, async (req, res) => {
  const s = await Session.findById(req.params.id);
  if (!s) return res.status(404).json({ error: 'session not found' });
  const hostId = toIdString(s.hostUserId) || String(s.hostUserId);
  const requester = toIdString(req.user._id) || String(req.user._id);
  if (hostId !== requester) return res.status(403).json({ error: 'only host can change tempo' });
  const { tempo } = req.body || {};
  if (!tempo || tempo < 60 || tempo > 180) return res.status(400).json({ error: 'tempo out of range' });
  s.tempo = tempo;
  await s.save();
  io.to(`session:${s._id}`).emit('tempo:update', { tempo });
  res.json({ ok: true });
});

app.post('/api/sessions/cleanup', auth, async (_req, res) => {
  const closed = await reapStaleSessions();
  res.json({ ok: true, closed });
});

/* ============================ Socket.IO ============================ */
function nextStepStartTs(bpm) {
  // 16 steps per bar = 4 steps per beat → step = beat/4
  const stepMs = (60_000 / bpm) / 4;
  const now = Date.now();
  return now + (stepMs - (now % stepMs));
}

const server = http.createServer(app);
const io = new SocketIOServer(server, {
  cors: {
    origin: corsOptions.origin,
    methods: ['GET','POST'],
    allowedHeaders: ['Authorization','Content-Type'],
    credentials: true
  }
});

io.use(async (socket, next) => {
  const { token } = socket.handshake.auth || {};
  if (!token) return next(new Error('no token'));
  try {
    const { uid } = jwt.verify(token, JWT_SECRET);
    const user = await User.findById(uid);
    if (!user) return next(new Error('bad user'));
    socket.data.user = user;
    socket.data.user.avatarUrl = presentStoredUploadUrl(socket.request, user.avatarUrl, user.avatarStorageKey);
    socket.data.user.tagUrl = presentStoredUploadUrl(socket.request, user.tagUrl, user.tagStorageKey);
    socket.data.user.profileColor = resolveProfileColor(user.profileColor);
    next();
  } catch {
    next(new Error('bad token'));
  }
});

async function broadcastRoster(sessionId, req) {
  const s = await Session.findById(sessionId);
  if (!s) return;
  const list = await rosterFor(s, req);
  io.to(`session:${sessionId}`).emit('participants', { list });
}

io.on('connection', (socket) => {
  socket.data.sessions = new Set();

  socket.on('session:join', async ({ sessionId }) => {
    const s = await Session.findById(sessionId);
    if (!s || !s.isActive) return;
    ensureGridShape(s);
    const userId = participantKey(socket.data.user._id);
    const fallbackIdRaw = String(socket.data.user._id ?? '').trim();
    const fallbackId = (!fallbackIdRaw || fallbackIdRaw === 'null' || fallbackIdRaw === 'undefined' || fallbackIdRaw === '[object Object]')
      ? null
      : fallbackIdRaw;
    const hadColor = !!(s.playerColors && ((userId && s.playerColors[userId]) || (fallbackId && s.playerColors[fallbackId])));
    const color = ensurePlayerColors(s, socket.data.user._id);
    // ensure db has this user in participants (handles socket reconnect edge)
    let changed = false;
    const already = userId
      ? s.participants.some(p => participantKey(p) === userId)
      : false;
    if (!already) {
      s.participants.push(socket.data.user._id);
      s.lastEmptyAt = undefined;
      changed = true;
    }
    if (!hadColor && color) changed = true;
    const historyAdded = ensureParticipantHistory(s, socket.data.user._id);
    if (historyAdded) changed = true;
    if (changed) await s.save();
    socket.join(`session:${sessionId}`);
    socket.data.sessions.add(sessionId);
    await broadcastRoster(sessionId, socket.request);

    // Play this user's tag once, aligned to next step
    if (socket.data.user.tagUrl) {
      const at = nextStepStartTs(s.tempo);
      io.to(`session:${sessionId}`).emit('tag:play', { url: socket.data.user.tagUrl, at });
    }
  });

  socket.on('session:leave', async ({ sessionId } = {}, ack) => {
    socket.leave(`session:${sessionId}`);
    socket.data.sessions.delete(sessionId);
    const s = await Session.findById(sessionId);
    if (!s) {
      if (typeof ack === 'function') ack({ ok: true, participants: 0 });
      return;
    }
    const target = participantKey(socket.data.user._id);
    const fallback = (() => {
      const raw = String(socket.data.user._id ?? '').trim();
      if (!raw || raw === 'null' || raw === 'undefined' || raw === '[object Object]') return null;
      return raw;
    })();
    s.participants = (s.participants || []).filter(p => {
      const key = participantKey(p);
      if (!key) return true;
      if (target) return key !== target;
      if (fallback) return key !== fallback;
      return true;
    });
    if (s.participants.length === 0) s.lastEmptyAt = new Date();
    await s.save();
    await broadcastRoster(sessionId, socket.request);
    if (typeof ack === 'function') {
      ack({ ok: true, participants: s.participants.length });
    }
  });

  // when a browser tab closes, remove from any joined sessions
  socket.on('disconnect', async () => {
    const sessionIds = Array.from(socket.data.sessions || []);
    for (const sessionId of sessionIds) {
      const s = await Session.findById(sessionId);
      if (!s) continue;
      const room = io.sockets.adapter.rooms.get(`session:${sessionId}`);
      const liveCount = room ? room.size : 0;
      if (liveCount === 0) {
        if (!s.lastEmptyAt) {
          s.lastEmptyAt = new Date();
          await s.save();
        }
      } else if (s.lastEmptyAt) {
        s.lastEmptyAt = undefined;
        await s.save();
      }
      await broadcastRoster(sessionId, socket.request);
    }
    socket.data.sessions?.clear?.();
  });

  socket.on('grid:update', async ({ sessionId, row, col, on }) => {
    const s = await Session.findById(sessionId);
    if (!s) return;
    ensureGridShape(s);
    const key = `${row}-${col}`;
    const color = ensurePlayerColors(s, socket.data.user._id);
    const ownerId = (() => {
      const primary = toIdString(socket.data.user._id);
      if (primary) return primary;
      const raw = String(socket.data.user._id ?? '').trim();
      if (!raw || raw === 'null' || raw === 'undefined' || raw === '[object Object]') return null;
      return raw;
    })();
    if (on) {
      s.grid.map[key] = { user: ownerId, color };
    } else {
      delete s.grid.map[key];
    }
    s.markModified('grid');
    await s.save();
    io.to(`session:${sessionId}`).emit('grid:update', {
      row,
      col,
      on,
      userId: ownerId,
      color
    });
  });

  // host-only guard on server (also guarded by REST)
  socket.on('tempo:set', async ({ sessionId, tempo }) => {
    const s = await Session.findById(sessionId);
    if (!s) return;
    const hostId = toIdString(s.hostUserId) || String(s.hostUserId);
    const requester = toIdString(socket.data.user._id) || String(socket.data.user._id);
    if (hostId !== requester) return;
    s.tempo = tempo;
    await s.save();
    io.to(`session:${sessionId}`).emit('tempo:update', { tempo });
  });
});

/* ============================ Reaper (3 min) ============================ */
async function reapStaleSessions({ emit = true } = {}) {
  const now = Date.now();
  const sessions = await Session.find({ isActive: true });
  if (!sessions.length) return 0;

  const participantIds = new Set();
  sessions.forEach(s => {
    const collect = (value) => {
      const key = participantKey(value);
      if (key) participantIds.add(key);
    };
    if (Array.isArray(s.participants)) {
      s.participants.forEach(collect);
    }
    if (Array.isArray(s.participantsHistory)) {
      s.participantsHistory.forEach(collect);
    }
    if (s.hostUserId) collect(s.hostUserId);
  });

  let validIds = new Set();
  if (participantIds.size) {
    const queryIds = Array.from(participantIds).map(id => new mongoose.Types.ObjectId(id));
    const rows = await User.find({ _id: { $in: queryIds } }).select('_id');
    validIds = new Set(rows.map(r => toIdString(r._id) || String(r._id)));
  }

  let closed = 0;
  for (const s of sessions) {
    ensureGridShape(s);
    if (!Array.isArray(s.participants)) s.participants = [];
    const filtered = (s.participants || []).filter(id => {
      const key = participantKey(id);
      return key ? validIds.has(key) : false;
    });
    let changed = filtered.length !== s.participants.length;
    if (changed) {
      const keep = new Set(filtered.map(id => {
        const key = participantKey(id);
        if (key) return key;
        return null;
      }).filter(Boolean));
      s.participants = filtered;
      if (s.playerColors && typeof s.playerColors === 'object') {
        let removed = false;
        for (const key of Object.keys(s.playerColors)) {
          const normalizedKey = toIdString(key) || key;
          if (!keep.has(normalizedKey)) { delete s.playerColors[key]; removed = true; }
        }
        if (removed) s.markModified('playerColors');
      }
    }

    if (Array.isArray(s.participantsHistory) && s.participantsHistory.length) {
      const seenHistory = new Set();
      const filteredHistory = s.participantsHistory.filter(id => {
        const key = participantKey(id);
        if (!key || !validIds.has(key)) return false;
        if (seenHistory.has(key)) return false;
        seenHistory.add(key);
        return true;
      });
      if (filteredHistory.length !== s.participantsHistory.length) {
        s.participantsHistory = filteredHistory;
        if (typeof s.markModified === 'function') {
          s.markModified('participantsHistory');
        }
        changed = true;
      }
    }

    const room = io.sockets.adapter.rooms.get(`session:${s._id}`) || null;
    const connected = room ? room.size : 0;
    const lifetime = now - new Date(s.createdAt).getTime();

    if (connected === 0 && s.participants.length === 0) {
      if (!s.lastEmptyAt) {
        s.lastEmptyAt = new Date(now);
        changed = true;
      }
      const lastEmpty = s.lastEmptyAt ? new Date(s.lastEmptyAt).getTime() : NaN;
      if (!Number.isNaN(lastEmpty) && (now - lastEmpty >= SESSION_EMPTY_TTL_MS || lifetime >= SESSION_MAX_LIFETIME_MS)) {
        s.isActive = false;
        changed = true;
        await s.save();
        closed += 1;
        if (emit) io.to(`session:${s._id}`).emit('session:ended', {});
        continue;
      }
    } else if (connected === 0) {
      if (!s.lastEmptyAt) {
        s.lastEmptyAt = new Date(now);
        changed = true;
      }
      const lastEmpty = s.lastEmptyAt ? new Date(s.lastEmptyAt).getTime() : NaN;
      if (!Number.isNaN(lastEmpty) && (now - lastEmpty >= SESSION_EMPTY_TTL_MS || lifetime >= SESSION_MAX_LIFETIME_MS)) {
        s.isActive = false;
        s.participants = [];
        changed = true;
        await s.save();
        closed += 1;
        if (emit) io.to(`session:${s._id}`).emit('session:ended', {});
        continue;
      }
    } else if (s.lastEmptyAt) {
      s.lastEmptyAt = undefined;
      changed = true;
    }

    if (lifetime >= SESSION_MAX_LIFETIME_MS && connected === 0) {
      s.isActive = false;
      s.participants = [];
      changed = true;
      await s.save();
      closed += 1;
      if (emit) io.to(`session:${s._id}`).emit('session:ended', {});
      continue;
    }

    if (changed) await s.save();
  }
  return closed;
}

setInterval(() => {
  reapStaleSessions().catch(() => {});
}, 30 * 1000);

/* ============================ Server start ============================ */
server.listen(PORT, '0.0.0.0', () => {
  console.log(`✅ Beatloop API listening on ${PORT}`);
});

/* Optional tiny check while debugging CORS */
app.get('/cors-check', (req, res) => {
  res.json({ ok: true, origin: req.headers.origin || null, allowed: FRONTENDS });
});
