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

const {
  PORT = 8080,
  JWT_SECRET = 'dev_secret_change_me',
  MONGODB_URI,
  PUBLIC_BASE_URL = `http://localhost:${PORT}`
} = process.env;

if (!MONGODB_URI) {
  console.warn('⚠️  MONGODB_URI not set. Add it in .env / Render Environment.');
}

await mongoose.connect(MONGODB_URI, { dbName: 'beatloop' });

/* -------------------- Mongoose models (inline for simplicity) -------------------- */
const UserSchema = new mongoose.Schema({
  name: String,
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
  hostUserId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  tempo: { type: Number, default: 92 },
  maxPlayers: { type: Number, default: 8 },
  createdAt: { type: Date, default: Date.now },
  isActive: { type: Boolean, default: true },
  participants: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
  // minimal shared grid state (16 steps × rows). You can extend later.
  grid: {
    type: Object,
    default: {
      rows: 8,
      cols: 16,
      // map: { "row-col": 0/1 }
      map: {}
    }
  }
});

const User = mongoose.model('User', UserSchema);
const Session = mongoose.model('Session', SessionSchema);

/* ----------------------------- App + middlewares ----------------------------- */
const app = express();
const server = http.createServer(app);
const io = new SocketIOServer(server, {
  cors: { origin: '*', methods: ['GET','POST','PUT','PATCH','DELETE'] }
});

app.use(cors());
app.use(morgan('dev'));
app.use(express.json({ limit: '5mb' }));
app.use('/uploads', express.static(path.join(process.cwd(), 'uploads')));

/* --------------------------------- Helpers --------------------------------- */
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
  } catch (e) {
    return res.status(401).json({ error: 'invalid token' });
  }
}

/* --------------------------------- Auth API -------------------------------- */
app.post('/api/auth/signup', async (req, res) => {
  const { name, email, password, avatarUrl } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: 'email & password required' });
  const exists = await User.findOne({ email: email.toLowerCase() });
  if (exists) return res.status(409).json({ error: 'email already exists' });
  const passwordHash = await bcrypt.hash(password, 10);
  const user = await User.create({
    name: name || email.split('@')[0],
    email: email.toLowerCase(),
    passwordHash,
    avatarUrl: avatarUrl || ''
  });
  res.json({ token: sign(user), user: { id: user._id, name: user.name, email: user.email, avatarUrl: user.avatarUrl } });
});

app.post('/api/auth/login', async (req, res) => {
  const { email, password } = req.body || {};
  const user = await User.findOne({ email: (email||'').toLowerCase() });
  if (!user) return res.status(401).json({ error: 'invalid credentials' });
  const ok = await bcrypt.compare(password, user.passwordHash);
  if (!ok) return res.status(401).json({ error: 'invalid credentials' });
  res.json({ token: sign(user), user: { id: user._id, name: user.name, email: user.email, avatarUrl: user.avatarUrl, tagUrl: user.tagUrl } });
});

app.get('/api/auth/me', auth, async (req, res) => {
  const u = req.user;
  res.json({ user: { id: u._id, name: u.name, email: u.email, avatarUrl: u.avatarUrl, tagUrl: u.tagUrl, totalOnlineSec: u.totalOnlineSec } });
});

/* --------------------------- Presence / Time grind -------------------------- */
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

/* ----------------------------- Sound tag upload ---------------------------- */
const tagDir = path.join(process.cwd(), 'uploads', 'tags');
fs.mkdirSync(tagDir, { recursive: true });
const upload = multer({ dest: tagDir });

app.post('/api/users/tag', auth, upload.single('tag'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'missing file' });
  const full = req.file.path;
  try {
    const meta = await parseFile(full);
    const duration = meta.format.duration || 0;
    if (duration > 3.25) {
      fs.unlinkSync(full);
      return res.status(400).json({ error: 'tag must be 3 seconds or less' });
    }
    const url = `${PUBLIC_BASE_URL}/uploads/tags/${path.basename(full)}`;
    req.user.tagUrl = url;
    req.user.tagDurationSec = Math.round(duration * 1000) / 1000;
    await req.user.save();
    res.json({ ok: true, tagUrl: url, duration: req.user.tagDurationSec });
  } catch (e) {
    fs.unlinkSync(full);
    res.status(500).json({ error: 'could not parse audio' });
  }
});

/* -------------------------------- Sessions API ----------------------------- */
app.get('/api/sessions', async (_req, res) => {
  const sessions = await Session.find({ isActive: true }).sort({ createdAt: -1 }).lean();
  const out = sessions.map(s => ({
    id: s._id,
    tempo: s.tempo,
    participants: s.participants.length,
    maxPlayers: s.maxPlayers,
    openSec: Math.floor((Date.now() - s.createdAt.getTime())/1000)
  }));
  res.json({ sessions: out });
});

app.post('/api/sessions', auth, async (req, res) => {
  const { tempo = 92, maxPlayers = 8 } = req.body || {};
  const session = await Session.create({ hostUserId: req.user._id, tempo, maxPlayers, participants: [req.user._id] });
  res.json({ id: session._id.toString() });
});

app.post('/api/sessions/:id/join', auth, async (req, res) => {
  const s = await Session.findById(req.params.id);
  if (!s || !s.isActive) return res.status(404).json({ error: 'session not found' });
  if (s.participants.length >= s.maxPlayers) return res.status(409).json({ error: 'session full' });
  if (!s.participants.find(p => p.toString() === req.user._id.toString())) {
    s.participants.push(req.user._id);
    await s.save();
  }
  res.json({ ok: true, tempo: s.tempo });
});

app.post('/api/sessions/:id/leave', auth, async (req, res) => {
  const s = await Session.findById(req.params.id);
  if (!s) return res.json({ ok: true });
  s.participants = s.participants.filter(p => p.toString() !== req.user._id.toString());
  if (s.participants.length === 0) s.isActive = false;
  await s.save();
  res.json({ ok: true });
});

app.post('/api/sessions/:id/tempo', auth, async (req, res) => {
  const s = await Session.findById(req.params.id);
  if (!s) return res.status(404).json({ error: 'session not found' });
  if (s.hostUserId.toString() !== req.user._id.toString()) return res.status(403).json({ error: 'only host can change tempo' });
  const { tempo } = req.body || {};
  if (!tempo || tempo < 60 || tempo > 180) return res.status(400).json({ error: 'tempo out of range' });
  s.tempo = tempo;
  await s.save();
  io.to(`session:${s._id}`).emit('tempo:update', { tempo });
  res.json({ ok: true });
});

/* --------------------------------- Sockets --------------------------------- */
function nextStepStartTs(bpm) {
  // 16 steps per bar = 4 steps per beat → step = beat/4
  const stepMs = (60_000 / bpm) / 4;
  const now = Date.now();
  return now + (stepMs - (now % stepMs));
}

io.use(async (socket, next) => {
  const { token } = socket.handshake.auth || {};
  if (!token) return next(new Error('no token'));
  try {
    const { uid } = jwt.verify(token, JWT_SECRET);
    const user = await User.findById(uid);
    if (!user) return next(new Error('bad user'));
    socket.data.user = user;
    next();
  } catch (e) {
    next(new Error('bad token'));
  }
});

io.on('connection', (socket) => {
  socket.on('session:join', async ({ sessionId }) => {
    const s = await Session.findById(sessionId);
    if (!s || !s.isActive) return;
    socket.join(`session:${sessionId}`);
    io.to(`session:${sessionId}`).emit('user:joined', {
      user: { id: socket.data.user._id, name: socket.data.user.name, tagUrl: socket.data.user.tagUrl }
    });

    // Play this user's tag for everyone, once, aligned to the next step boundary
    if (socket.data.user.tagUrl) {
      const at = nextStepStartTs(s.tempo);
      io.to(`session:${sessionId}`).emit('tag:play', { url: socket.data.user.tagUrl, at });
    }
  });

  socket.on('session:leave', ({ sessionId }) => {
    socket.leave(`session:${sessionId}`);
    io.to(`session:${sessionId}`).emit('user:left', { userId: socket.data.user._id });
  });

  socket.on('grid:update', async ({ sessionId, row, col, on }) => {
    const s = await Session.findById(sessionId);
    if (!s) return;
    const key = `${row}-${col}`;
    if (on) s.grid.map[key] = 1; else delete s.grid.map[key];
    s.markModified('grid');
    await s.save();
    socket.to(`session:${sessionId}`).emit('grid:update', { row, col, on });
  });

  // host-only guard on server (also guarded by REST)
  socket.on('tempo:set', async ({ sessionId, tempo }) => {
    const s = await Session.findById(sessionId);
    if (!s) return;
    if (s.hostUserId.toString() !== socket.data.user._id.toString()) return;
    s.tempo = tempo;
    await s.save();
    io.to(`session:${sessionId}`).emit('tempo:update', { tempo });
  });
});

server.listen(PORT, () => {
  console.log(`✅ Beatloop API listening on ${PORT}`);
});
