import 'dotenv/config';
import express from 'express';
import http from 'http';
import { Server as SocketIOServer } from 'socket.io';
import mongoose from 'mongoose';
import cors from 'cors';
import morgan from 'morgan';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import multer from 'multer';
import { parseFile } from 'music-metadata';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';

/* ============================ ENV ============================ */
const {
  PORT = 10000,                              // Render uses this
  JWT_SECRET = 'dev_secret_change_me',
  MONGODB_URI,
  PUBLIC_BASE_URL = `http://localhost:${PORT}`,
  FRONTEND_ORIGINS = 'https://beatloop-eotg.onrender.com,https://www.beatloop.co,https://beatloop.co,http://localhost:8080'
} = process.env;

if (!MONGODB_URI) {
  console.warn('⚠️  MONGODB_URI not set. Add it in .env / Render Environment.');
}

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
const IMAGE_MIME_EXT = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/jpg': '.jpg',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'image/svg+xml': '.svg',
  'image/bmp': '.bmp'
};
const AUDIO_MIME_EXT = {
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
};
const AUDIO_ALLOWED_MIME = new Set(Object.keys(AUDIO_MIME_EXT));
/* ============================ DB ============================ */
await mongoose.connect(MONGODB_URI, { dbName: 'beatloop' });

/* -------------------- Mongoose models -------------------- */
const UserSchema = new mongoose.Schema({
  name: { type: String, index: true },       // enforced unique in app layer
  email: { type: String, unique: true, index: true },
  passwordHash: String,
  avatarUrl: String,
  firstName: { type: String, default: '' },
  lastName: { type: String, default: '' },
  displayName: { type: String, default: '' },
  tagUrl: String,            // 3-sec sound tag URL
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
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
});

TrackSchema.pre('save', function(next) {
  this.updatedAt = new Date();
  next();
});

const User = mongoose.model('User', UserSchema);
const Session = mongoose.model('Session', SessionSchema);
const Track = mongoose.model('Track', TrackSchema);

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
const uploadsRoot = path.join(projectRoot, 'uploads');
fs.mkdirSync(uploadsRoot, { recursive: true });
const trackAudioDir = path.join(uploadsRoot, 'tracks');
const trackCoverDir = path.join(uploadsRoot, 'covers');
fs.mkdirSync(trackAudioDir, { recursive: true });
fs.mkdirSync(trackCoverDir, { recursive: true });
app.use('/uploads', express.static(uploadsRoot));

const LOCALHOST_RE = /^https?:\/\/(?:localhost|127(?:\.\d+){3})(?::\d+)?$/i;
const MARKETING_HOSTS = new Set(['beatloop.co', 'www.beatloop.co']);

const RAW_PUBLIC_BASE = (PUBLIC_BASE_URL || '').trim();
let ENV_PUBLIC_BASE = '';
let ENV_PUBLIC_HOST = '';
let ENV_PUBLIC_IS_LOCAL = false;
let ENV_PUBLIC_IS_MARKETING = false;

if (RAW_PUBLIC_BASE) {
  if (/^https?:\/\//i.test(RAW_PUBLIC_BASE)) {
    try {
      const parsed = new URL(RAW_PUBLIC_BASE);
      const path = parsed.pathname && parsed.pathname !== '/' ? parsed.pathname : '';
      ENV_PUBLIC_BASE = `${parsed.protocol}//${parsed.host}${path}`.replace(/\/+$/, '');
      ENV_PUBLIC_HOST = (parsed.hostname || '').toLowerCase();
    } catch {
      ENV_PUBLIC_BASE = RAW_PUBLIC_BASE.replace(/\/+$/, '');
    }
  }

  if (ENV_PUBLIC_BASE) {
    ENV_PUBLIC_IS_LOCAL = LOCALHOST_RE.test(ENV_PUBLIC_BASE);
    ENV_PUBLIC_IS_MARKETING = MARKETING_HOSTS.has(ENV_PUBLIC_HOST);
  }
}

function requestBaseFromHeaders(req) {
  const headerValue = value => (typeof value === 'string' ? value.split(',')[0].trim() : '');
  const forwardedHost = headerValue(req.headers['x-forwarded-host']);
  const forwardedProto = headerValue(req.headers['x-forwarded-proto']);
  const origin = headerValue(req.headers.origin);
  const hostHeader = forwardedHost || headerValue(req.headers.host) || (typeof req.get === 'function' ? headerValue(req.get('host')) : '');
  const protocol = forwardedProto || (origin ? origin.split('://')[0] : '') || req.protocol || 'http';

  if (hostHeader) {
    return `${protocol}://${hostHeader}`.replace(/\/+$/, '');
  }
  if (origin) {
    return origin.replace(/\/+$/, '');
  }
  return null;
}

function effectivePublicBase(req) {
  const requestBase = requestBaseFromHeaders(req);
  const requestIsLocal = requestBase ? LOCALHOST_RE.test(requestBase) : false;

  if (ENV_PUBLIC_BASE && !ENV_PUBLIC_IS_LOCAL) {
    if (!ENV_PUBLIC_IS_MARKETING || !requestBase || requestIsLocal) {
      return ENV_PUBLIC_BASE;
    }
  }

  if (requestBase) return requestBase;
  if (ENV_PUBLIC_BASE) return ENV_PUBLIC_BASE;
  return `http://localhost:${PORT}`;
}

function publicUploadUrl(req, folder, filename) {
  const base = effectivePublicBase(req);
  return `${base}/uploads/${folder}/${filename}`;
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

async function userSummary(u) {
  if (!u) return null;
  return {
    id: u._id,
    name: u.name,
    email: u.email,
    avatar: u.avatarUrl,
    tagUrl: u.tagUrl,
    tagDurationSec: u.tagDurationSec,
    joinedAt: u.createdAt,
    firstName: u.firstName,
    lastName: u.lastName,
    displayName: u.displayName
  };
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

async function rosterFor(sessionDoc) {
  const ids = (sessionDoc.participants || []).map(id => new mongoose.Types.ObjectId(id));
  if (!ids.length) return [];
  const users = await User.find({ _id: { $in: ids } }).select('name email avatarUrl tagUrl createdAt');
  return users.map(u => ({
    id: u._id,
    name: u.name,
    email: u.email,
    avatar: u.avatarUrl,
    tagUrl: u.tagUrl,
    joinedAt: u.createdAt,
    color: (() => {
      const idStr = toIdString(u._id);
      if (idStr && sessionDoc.playerColors?.[idStr]) return sessionDoc.playerColors[idStr];
      const fallback = String(u._id ?? '').trim();
      if (!fallback || fallback === 'null' || fallback === 'undefined' || fallback === '[object Object]') return null;
      return sessionDoc.playerColors?.[fallback] || null;
    })()
  }));
}

async function participantHistoryFor(sessionDoc) {
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
  const users = await User.find({ _id: { $in: objectIds } }).select('name email avatarUrl tagUrl createdAt');
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
      avatar: user.avatarUrl,
      tagUrl: user.tagUrl,
      joinedAt: user.createdAt
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
  res.json({ token: sign(user), user: await userSummary(user) });
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
  res.json({ token: sign(user), user: await userSummary(user) });
});

app.get('/api/auth/me', auth, async (req, res) => {
  res.json({ user: await userSummary(req.user) });
});

/* ---- profile update: change username (unique) and/or avatarUrl ---- */
async function handleProfileUpdate(req, res) {
  const { name, avatarUrl, firstName, lastName, displayName } = req.body || {};
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
  if (avatarUrl !== undefined) req.user.avatarUrl = avatarUrl;
  await req.user.save();
  res.json({ user: await userSummary(req.user) });
}

app.patch('/api/users/profile', auth, handleProfileUpdate);
app.put('/api/users/profile', auth, handleProfileUpdate);

app.get('/api/users/me', auth, async (req, res) => {
  res.json({ user: await userSummary(req.user) });
});

app.get('/api/users/directory', async (req, res) => {
  try {
    const limitParam = Number.parseInt(req.query?.limit, 10);
    const limit = Number.isFinite(limitParam) ? Math.min(Math.max(limitParam, 1), 500) : 120;
    const users = await User.find()
      .sort({ createdAt: -1 })
      .limit(limit)
      .select('name email avatarUrl tagUrl totalOnlineSec createdAt');

    const directory = users.map(u => ({
      id: u._id,
      name: u.name,
      email: u.email,
      avatar: u.avatarUrl,
      tagUrl: u.tagUrl,
      tagDurationSec: u.tagDurationSec,
      joinedAt: u.createdAt,
      totalOnlineSec: typeof u.totalOnlineSec === 'number' ? u.totalOnlineSec : 0,
      displayName: u.displayName,
      firstName: u.firstName,
      lastName: u.lastName
    }));

    res.json({ users: directory });
  } catch (err) {
    console.error('Failed to load user directory', err);
    res.status(500).json({ error: 'failed to load user directory' });
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
]);

const tagStorage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, tagDir),
  filename: (_req, file, cb) => {
    const base = crypto.randomBytes(8).toString('hex');
    const ext = (path.extname(file.originalname) || '').toLowerCase() || '.ogg';
    cb(null, `${Date.now()}-${base}${ext}`);
  }
});

const tagUpload = multer({
  storage: tagStorage,
  limits: { fileSize: 2 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (!file?.mimetype || !TAG_ALLOWED_MIME.has(file.mimetype)) {
      return cb(new Error('tag must be an audio file (mp3, wav, ogg, webm, flac)'));
    }
    cb(null, true);
  }
});

function audioFileExt(file) {
  const fromName = (path.extname(file.originalname) || '').toLowerCase();
  if (fromName) return fromName;
  return AUDIO_MIME_EXT[file.mimetype] || '.mp3';
}

const trackStorage = multer.diskStorage({
  destination: (_req, file, cb) => {
    if (file.fieldname === 'cover') return cb(null, trackCoverDir);
    cb(null, trackAudioDir);
  },
  filename: (_req, file, cb) => {
    const ext = file.fieldname === 'cover' ? avatarFileExt(file) : audioFileExt(file);
    const name = `${Date.now()}-${crypto.randomBytes(8).toString('hex')}${ext}`;
    cb(null, name);
  }
});

const trackUpload = multer({
  storage: trackStorage,
  limits: { fileSize: 12 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (file.fieldname === 'cover') {
      if (!file.mimetype || !file.mimetype.startsWith('image/')) {
        return cb(new Error('cover must be an image'));
      }
      return cb(null, true);
    }
    if (file.fieldname === 'audio') {
      if (!file.mimetype || !AUDIO_ALLOWED_MIME.has(file.mimetype)) {
        return cb(new Error('audio must be an audio file (mp3, wav, ogg, webm, flac, m4a)'));
      }
      return cb(null, true);
    }
    return cb(new Error('unsupported field'));
  }
});

const avatarDir = path.join(uploadsRoot, 'avatars');
fs.mkdirSync(avatarDir, { recursive: true });

function avatarFileExt(file) {
  const fromName = (path.extname(file.originalname) || '').toLowerCase();
  if (fromName && ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.bmp'].includes(fromName)) {
    return fromName;
  }
  return IMAGE_MIME_EXT[file.mimetype] || '.png';
}

const avatarStorage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, avatarDir),
  filename: (_req, file, cb) => {
    const ext = avatarFileExt(file);
    const name = `${Date.now()}-${crypto.randomBytes(6).toString('hex')}${ext}`;
    cb(null, name);
  }
});

const avatarUpload = multer({
  storage: avatarStorage,
  limits: { fileSize: 3 * 1024 * 1024 }, // 3MB avatar cap
  fileFilter: (_req, file, cb) => {
    if (!file.mimetype || !file.mimetype.startsWith('image/')) {
      return cb(new Error('avatar must be an image'));
    }
    cb(null, true);
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

app.post('/api/users/tag', auth, (req, res) => {
  tagUpload.single('tag')(req, res, async (err) => {
    if (err) {
      const message = err.message || 'upload failed';
      return res.status(400).json({ error: message });
    }
    if (!req.file) return res.status(400).json({ error: 'missing file' });
    const full = req.file.path;
    try {
      const meta = await parseFile(full);
      const duration = meta.format.duration || 0;
      if (duration > 3.05) {
        await fs.promises.unlink(full).catch(() => {});
        return res.status(400).json({ error: 'tag must be 3 seconds or less' });
      }

      const previous = resolveUploadPath(req.user.tagUrl, 'tags');
      if (previous) fs.promises.unlink(previous).catch(() => {});

      const url = publicUploadUrl(req, 'tags', path.basename(full));
      req.user.tagUrl = url;
      req.user.tagDurationSec = Math.round(duration * 1000) / 1000;
      await req.user.save();
      res.json({ ok: true, tagUrl: url, duration: req.user.tagDurationSec });
    } catch (ex) {
      await fs.promises.unlink(full).catch(() => {});
      res.status(500).json({ error: 'could not process audio tag' });
    }
  });
});

app.post('/api/users/avatar', auth, (req, res) => {
  avatarUpload.single('avatar')(req, res, async (err) => {
    if (err) {
      const message = err.message || 'upload failed';
      return res.status(400).json({ error: message });
    }
    if (!req.file) {
      return res.status(400).json({ error: 'missing file' });
    }
    try {
      const previous = resolveUploadPath(req.user.avatarUrl, 'avatars');
      if (previous) {
        fs.promises.unlink(previous).catch(() => {});
      }
      const url = publicUploadUrl(req, 'avatars', req.file.filename);
      req.user.avatarUrl = url;
      await req.user.save();
      res.json({ ok: true, avatarUrl: url });
    } catch (ex) {
      if (req.file?.path) {
        fs.promises.unlink(req.file.path).catch(() => {});
      }
      res.status(500).json({ error: 'could not save avatar' });
    }
  });
});

app.post('/api/tracks', auth, (req, res) => {
  trackUpload.fields([{ name: 'audio', maxCount: 1 }, { name: 'cover', maxCount: 1 }])(req, res, async (err) => {
    if (err) {
      const message = err.message || 'upload failed';
      return res.status(400).json({ error: message });
    }

    const audioFile = Array.isArray(req.files?.audio) ? req.files.audio[0] : null;
    const coverFile = Array.isArray(req.files?.cover) ? req.files.cover[0] : null;

    if (!audioFile) {
      if (coverFile?.path) safeUnlink(coverFile.path);
      return res.status(400).json({ error: 'missing audio file' });
    }

    if (audioFile.size > 10 * 1024 * 1024) {
      safeUnlink(audioFile.path);
      if (coverFile?.path) safeUnlink(coverFile.path);
      return res.status(400).json({ error: 'track must be 10MB or less' });
    }

      if (coverFile && coverFile.size > 10 * 1024 * 1024) {
        safeUnlink(audioFile.path);
        safeUnlink(coverFile.path);
        return res.status(400).json({ error: 'cover art must be 10MB or less' });
      }

    try {
      let duration = null;
      try {
        const meta = await parseFile(audioFile.path);
        if (meta?.format?.duration) {
          duration = Math.round(meta.format.duration * 1000) / 1000;
        }
      } catch {}

      const body = req.body || {};
      const rawTitle = typeof body.title === 'string' ? body.title.trim() : '';
      const rawCaption = typeof body.caption === 'string' ? body.caption.trim() : '';
      const bpmValue = Number.parseInt(body.bpm, 10);
      const bpm = Number.isFinite(bpmValue) ? Math.max(0, Math.min(bpmValue, 999)) : 0;

      const title = rawTitle || (audioFile.originalname ? audioFile.originalname.replace(/\.[^.]+$/, '') : 'Untitled');
      const caption = rawCaption ? rawCaption.slice(0, 500) : '';
      const audioUrl = publicUploadUrl(req, 'tracks', path.basename(audioFile.path));
      const coverUrl = coverFile ? publicUploadUrl(req, 'covers', coverFile.filename) : '';
      const artist = (() => {
        const display = typeof req.user.displayName === 'string' ? req.user.displayName.trim() : '';
        if (display) return display;
        const first = typeof req.user.firstName === 'string' ? req.user.firstName.trim() : '';
        const last = typeof req.user.lastName === 'string' ? req.user.lastName.trim() : '';
        const combined = [first, last].filter(Boolean).join(' ').trim();
        if (combined) return combined;
        if (typeof req.user.name === 'string' && req.user.name.trim()) return req.user.name.trim();
        return req.user.email;
      })();

      const trackDoc = await Track.create({
        userId: req.user._id,
        title,
        artist,
        bpm,
        audioUrl,
        coverUrl,
        audioDurationSec: duration || 0,
        caption
      });

      const summary = await userSummary(req.user);
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
          userId: trackDoc.userId,
          user: summary
        });
    } catch (ex) {
      console.error('Track upload failed', ex);
      safeUnlink(audioFile.path);
      if (coverFile?.path) safeUnlink(coverFile.path);
      res.status(500).json({ error: 'could not save track' });
    }
  });
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
      query.createdAt = { $lt: cursorDate };
    }

    const docs = await Track.find(query).sort({ createdAt: -1 }).limit(limit).lean();
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
        const summaries = await Promise.all(users.map(async (u) => [toIdString(u._id), await userSummary(u)]));
        userMap = new Map(summaries.filter(([key]) => Boolean(key)));
      }
    }

    const tracks = docs.map(doc => {
      const userKey = toIdString(doc.userId);
      const coverUrl = doc.coverUrl || '';
        return {
          id: doc._id,
          title: doc.title || 'Untitled',
          artist: doc.artist || '',
          bpm: doc.bpm || 0,
          audioUrl: doc.audioUrl,
          coverUrl: coverUrl || null,
          duration: doc.audioDurationSec || null,
          caption: doc.caption || '',
          createdAt: doc.createdAt,
          userId: doc.userId,
          user: userKey ? userMap.get(userKey) || null : null
        };
    });

    const last = docs.length ? docs[docs.length - 1] : null;
    const nextCursor = last ? new Date(last.createdAt).toISOString() : null;

    res.json({ tracks, nextCursor });
  } catch (err) {
    console.error('Failed to load tracks', err);
    res.status(500).json({ error: 'failed to load tracks' });
  }
});

/* ============================ Sessions API ============================ */
app.get('/api/sessions', async (_req, res) => {
  await reapStaleSessions({ emit: false });
  const sessionsRaw = await Session.find({ isActive: true }).sort({ createdAt: -1 }).lean();
  const sessions = sessionsRaw.filter(s => Array.isArray(s.participants) ? s.participants.length > 0 : false);
  // include host info + name + counts for the feed
  const hostIds = sessions.map(s => s.hostUserId).filter(Boolean);
  const hosts = await User.find({ _id: { $in: hostIds } }).select('name avatarUrl');
  const hostMap = new Map(hosts.map(h => {
    const key = toIdString(h._id) || String(h._id);
    return [key, { name: h.name, avatar: h.avatarUrl }];
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
  const participants = await rosterFor(s);
  const history = await participantHistoryFor(s);
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
  const roster = await rosterFor(s);
  const history = await participantHistoryFor(s);
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
    next();
  } catch {
    next(new Error('bad token'));
  }
});

async function broadcastRoster(sessionId) {
  const s = await Session.findById(sessionId);
  if (!s) return;
  const list = await rosterFor(s);
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
    await broadcastRoster(sessionId);

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
    await broadcastRoster(sessionId);
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
      await broadcastRoster(sessionId);
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
