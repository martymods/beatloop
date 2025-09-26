const fs = require('fs');
const path = require('path');

const MUSIC_ROOT = path.resolve(__dirname, '..', 'audio', 'music');
const OUTPUT = path.resolve(MUSIC_ROOT, 'midi-index.json');

/**
 * Walk the audio/music directory tree and collect .mid/.midi files.
 * Returns an array of objects with path metadata for front-end search.
 */
function collectMidiFiles(root) {
  const results = [];
  function walk(dir) {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(abs);
        continue;
      }
      if (!entry.isFile()) continue;
      if (!/\.mid(i)?$/i.test(entry.name)) continue;
      const relativeFromMusic = path.relative(root, abs).split(path.sep).join('/');
      const decodedName = (() => {
        try { return decodeURIComponent(entry.name); }
        catch { return entry.name; }
      })();
      const displayName = decodedName.replace(/\.[^/.]+$/, '').replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim();
      const folders = path.dirname(relativeFromMusic)
        .split('/')
        .filter(Boolean)
        .map(part => {
          try { return decodeURIComponent(part); }
          catch { return part; }
        });
      results.push({
        path: `/audio/music/${relativeFromMusic}`,
        name: displayName || entry.name,
        file: entry.name,
        folders,
      });
    }
  }
  walk(root);
  return results.sort((a, b) => a.name.localeCompare(b.name));
}

function main() {
  if (!fs.existsSync(MUSIC_ROOT)) {
    throw new Error(`Expected audio/music directory at ${MUSIC_ROOT}`);
  }
  const files = collectMidiFiles(MUSIC_ROOT);
  fs.writeFileSync(OUTPUT, JSON.stringify({ generatedAt: new Date().toISOString(), files }, null, 2));
  console.log(`Wrote ${files.length} MIDI entries to ${path.relative(process.cwd(), OUTPUT)}`);
}

if (require.main === module) {
  main();
}
