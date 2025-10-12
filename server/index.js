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

/* ============================ DB ============================ */
await mongoose.connect(MONGODB_URI, { dbName: 'beatloop' });

/* -------------------- Mongoose models -------------------- */
const UserSchema = new mongoose.Schema({
  name: { type: String, index: true },       // enforced unique in app layer
  email: { type: String, unique: true, index: true },
  passwordHash: String,
  avatarUrl: String,
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

const User = mongoose.model('User', UserSchema);
const Session = mongoose.model('Session', SessionSchema);

/* ============================ APP ============================ */
const app = express();

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
const uploadsRoot = path.join(process.cwd(), 'uploads');
fs.mkdirSync(uploadsRoot, { recursive: true });
app.use('/uploads', express.static(uploadsRoot));

/* ---- Health check ---- */
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', uptime: process.uptime(), db: mongoose.connection.readyState });
});

/* ============================ HELPERS ============================ */
function sign(user) {
  return jwt.sign({ uid: user._id }, JWT_SECRET, { expiresIn: '30d' });
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
  return { id: u._id, name: u.name, email: u.email, avatar: u.avatarUrl, tagUrl: u.tagUrl, joinedAt: u.createdAt };
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

/* ============================ AUTH ============================ */
app.post('/api/auth/signup', async (req, res) => {
  const { name, email, password, avatarUrl } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: 'email & password required' });

  const exists = await User.findOne({ email: email.toLowerCase() });
  if (exists) return res.status(409).json({ error: 'email already exists' });

  let finalName = (name || email.split('@')[0]).trim();
  if (finalName) {
    const nameTaken = await User.exists({ name: finalName });
    if (nameTaken) return res.status(409).json({ error: 'username already taken' });
  }

  const passwordHash = await bcrypt.hash(password, 10);
  const user = await User.create({
    name: finalName,
    email: email.toLowerCase(),
    passwordHash,
    avatarUrl: avatarUrl || ''
  });
  res.json({ token: sign(user), user: await userSummary(user) });
});

app.post('/api/auth/login', async (req, res) => {
  const { email, password } = req.body || {};
  const user = await User.findOne({ email: (email||'').toLowerCase() });
  if (!user) return res.status(401).json({ error: 'invalid credentials' });
  const ok = await bcrypt.compare(password, user.passwordHash);
  if (!ok) return res.status(401).json({ error: 'invalid credentials' });
  res.json({ token: sign(user), user: await userSummary(user) });
});

app.get('/api/auth/me', auth, async (req, res) => {
  res.json({ user: await userSummary(req.user) });
});

/* ---- profile update: change username (unique) and/or avatarUrl ---- */
async function handleProfileUpdate(req, res) {
  const { name, avatarUrl } = req.body || {};
  if (name) {
    const taken = await User.exists({ name, _id: { $ne: req.user._id } });
    if (taken) return res.status(409).json({ error: 'username already taken' });
    req.user.name = name;
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
  try {
    const base = `${PUBLIC_BASE_URL}/uploads/${folder}/`;
    if (!url.startsWith(base)) return null;
    const file = url.slice(base.length).split('?')[0];
    if (!file) return null;
    return path.join(uploadsRoot, folder, file);
  } catch {
    return null;
  }
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

      const url = `${PUBLIC_BASE_URL}/uploads/tags/${path.basename(full)}`;
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
    if (!req.file) return res.status(400).json({ error: 'missing file' });
    try {
      const previous = resolveUploadPath(req.user.avatarUrl, 'avatars');
      if (previous) {
        fs.promises.unlink(previous).catch(() => {});
      }
      const url = `${PUBLIC_BASE_URL}/uploads/avatars/${req.file.filename}`;
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

  const userKey = toIdString(req.user._id);
  const fallbackKeyRaw = String(req.user._id ?? '').trim();
  const fallbackKey = (!fallbackKeyRaw || fallbackKeyRaw === 'null' || fallbackKeyRaw === 'undefined' || fallbackKeyRaw === '[object Object]')
    ? null
    : fallbackKeyRaw;
  const beforeColor = (userKey && s.playerColors?.[userKey]) || (fallbackKey && s.playerColors?.[fallbackKey]) || null;
  const assignedColor = ensurePlayerColors(s, req.user._id);
  const already = s.participants.find(p => {
    const normalized = toIdString(p);
    if (normalized && userKey) return normalized === userKey;
    if (fallbackKey) return String(p) === fallbackKey;
    return false;
  });
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
  if (changed) await s.save();
  const participants = await rosterFor(s);
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
    grid: { rows, cols, map: plainMap }
  });
});

app.get('/api/sessions/:id', auth, async (req, res) => {
  const s = await Session.findById(req.params.id);
  if (!s || !s.isActive) return res.status(404).json({ error: 'session not found' });
  const roster = await rosterFor(s);
  res.json({
    id: s._id.toString(),
    name: s.name || 'Untitled',
    tempo: s.tempo,
    maxPlayers: s.maxPlayers,
    roster
  });
});

app.post('/api/sessions/:id/leave', auth, async (req, res) => {
  const s = await Session.findById(req.params.id);
  if (!s) return res.json({ ok: true });
  const targetId = toIdString(req.user._id);
  const fallback = (() => {
    const raw = String(req.user._id ?? '').trim();
    if (!raw || raw === 'null' || raw === 'undefined' || raw === '[object Object]') return null;
    return raw;
  })();
  s.participants = s.participants.filter(p => {
    const normalized = toIdString(p);
    if (normalized && targetId) return normalized !== targetId;
    if (fallback) return String(p) !== fallback;
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
    const userId = toIdString(socket.data.user._id);
    const fallbackIdRaw = String(socket.data.user._id ?? '').trim();
    const fallbackId = (!fallbackIdRaw || fallbackIdRaw === 'null' || fallbackIdRaw === 'undefined' || fallbackIdRaw === '[object Object]')
      ? null
      : fallbackIdRaw;
    const hadColor = !!(s.playerColors && ((userId && s.playerColors[userId]) || (fallbackId && s.playerColors[fallbackId])));
    const color = ensurePlayerColors(s, socket.data.user._id);
    // ensure db has this user in participants (handles socket reconnect edge)
    let changed = false;
    if (!s.participants.find(p => {
      const normalized = toIdString(p);
      if (normalized && userId) return normalized === userId;
      if (fallbackId) return String(p) === fallbackId;
      return false;
    })) {
      s.participants.push(socket.data.user._id);
      s.lastEmptyAt = undefined;
      changed = true;
    }
    if (!hadColor && color) changed = true;
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
    s.participants = s.participants.filter(p => {
      const normalized = toIdString(p);
      const target = toIdString(socket.data.user._id);
      if (normalized && target) return normalized !== target;
      const fallback = String(socket.data.user._id ?? '').trim();
      if (!fallback || fallback === 'null' || fallback === 'undefined' || fallback === '[object Object]') {
        return true;
      }
      return String(p) !== fallback;
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
    if (Array.isArray(s.participants)) {
      s.participants.forEach(id => {
        const normalized = toIdString(id);
        if (normalized) participantIds.add(normalized);
      });
    }
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
    const filtered = s.participants.filter(id => {
      const normalized = toIdString(id);
      if (normalized && validIds.has(normalized)) return true;
      const fallback = String(id ?? '').trim();
      if (!fallback || fallback === 'null' || fallback === 'undefined' || fallback === '[object Object]') return false;
      return validIds.has(fallback);
    });
    let changed = filtered.length !== s.participants.length;
    if (changed) {
      const keep = new Set(filtered.map(id => {
        const normalized = toIdString(id);
        if (normalized) return normalized;
        const fallback = String(id ?? '').trim();
        if (!fallback || fallback === 'null' || fallback === 'undefined' || fallback === '[object Object]') return null;
        return fallback;
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
