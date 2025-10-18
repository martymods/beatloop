import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import mongoose from 'mongoose';
import { lookup as mimeLookup } from 'mime-types';
import {
  durableStorageEnabled,
  ensureKeyFromLocalFile,
  getUploadsRoot
} from '../storage/uploads.js';

const { MONGODB_URI } = process.env;

if (!durableStorageEnabled()) {
  console.log('Durable storage is not configured. Nothing to backfill.');
  process.exit(0);
}

if (!MONGODB_URI) {
  console.error('MONGODB_URI must be set to run the backfill.');
  process.exit(1);
}

const uploadsRoot = getUploadsRoot();
const DURABLE_PREFIXES = new Set(['tracks', 'covers', 'messages']);

const TrackSchema = new mongoose.Schema({
  audioUrl: String,
  coverUrl: String
}, { collection: 'tracks' });
const DirectMessageSchema = new mongoose.Schema({
  attachments: [{
    fileName: String,
    originalName: String,
    mimeType: String,
    size: Number
  }]
}, { collection: 'directmessages' });

const Track = mongoose.model('Track', TrackSchema);
const DirectMessage = mongoose.model('DirectMessage', DirectMessageSchema);

function localPathFor(value, folder) {
  if (!value || typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;

  if (/^https?:\/\//i.test(trimmed)) {
    try {
      const url = new URL(trimmed);
      const prefix = folder ? `/uploads/${folder}/` : '/uploads/';
      if (url.pathname.startsWith(prefix)) {
        const relative = url.pathname.slice('/uploads/'.length);
        return path.join(uploadsRoot, relative);
      }
    } catch {
      // fall through
    }
  }

  if (trimmed.startsWith('/uploads/')) {
    return path.join(uploadsRoot, trimmed.slice('/uploads/'.length));
  }

  if (trimmed.startsWith('uploads/')) {
    return path.join(uploadsRoot, trimmed.slice('uploads/'.length));
  }

  if (folder && trimmed.startsWith(`${folder}/`)) {
    return path.join(uploadsRoot, trimmed);
  }

  if (folder) {
    return path.join(uploadsRoot, folder, trimmed);
  }

  return path.join(uploadsRoot, trimmed);
}

function determineMigration(value, folder) {
  if (!value || typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const prefix = trimmed.split('/')[0];
  if (DURABLE_PREFIXES.has(prefix)) {
    return null; // already a durable key
  }
  const filePath = localPathFor(trimmed, folder);
  if (!filePath) return null;
  const fileName = path.basename(filePath);
  if (!fileName) return null;
  const key = `${folder}/${fileName}`;
  return { key, filePath };
}

async function fileExists(filePath) {
  try {
    await fs.promises.access(filePath, fs.constants.R_OK);
    const stat = await fs.promises.stat(filePath);
    return stat.isFile();
  } catch {
    return false;
  }
}

async function migrateTrack(track) {
  const updates = {};
  const audioMigration = determineMigration(track.audioUrl, 'tracks');
  const coverMigration = determineMigration(track.coverUrl, 'covers');

  if (audioMigration && await fileExists(audioMigration.filePath)) {
    await ensureKeyFromLocalFile({
      key: audioMigration.key,
      filePath: audioMigration.filePath,
      contentType: mimeLookup(audioMigration.filePath) || undefined
    });
    updates.audioUrl = audioMigration.key;
    console.log(`Uploaded audio for track ${track._id} -> ${updates.audioUrl}`);
  }

  if (coverMigration && await fileExists(coverMigration.filePath)) {
    await ensureKeyFromLocalFile({
      key: coverMigration.key,
      filePath: coverMigration.filePath,
      contentType: mimeLookup(coverMigration.filePath) || undefined
    });
    updates.coverUrl = coverMigration.key;
    console.log(`Uploaded cover for track ${track._id} -> ${updates.coverUrl}`);
  }

  if (Object.keys(updates).length > 0) {
    await Track.updateOne({ _id: track._id }, { $set: updates });
  }
}

async function migrateMessages() {
  const cursor = DirectMessage.find({ 'attachments.0': { $exists: true } }).cursor();
  for await (const message of cursor) {
    let changed = false;
    for (const attachment of message.attachments || []) {
      const migration = determineMigration(attachment.fileName, 'messages');
      if (!migration) continue;
      if (!(await fileExists(migration.filePath))) continue;
      await ensureKeyFromLocalFile({
        key: migration.key,
        filePath: migration.filePath,
        contentType: attachment.mimeType || mimeLookup(migration.filePath) || undefined
      });
      attachment.fileName = migration.key;
      changed = true;
      console.log(`Uploaded message attachment for message ${message._id} -> ${migration.key}`);
    }
    if (changed) {
      message.markModified('attachments');
      await message.save();
    }
  }
}

async function main() {
  await mongoose.connect(MONGODB_URI, { dbName: 'beatloop' });

  const tracks = await Track.find({});
  for (const track of tracks) {
    await migrateTrack(track);
  }

  await migrateMessages();

  await mongoose.disconnect();
  console.log('Backfill complete.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
