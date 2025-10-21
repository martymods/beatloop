import Link from 'next/link';

export default function Home() {
  return (
    <main>
      <div style={{ maxWidth: 720, margin: '0 auto', display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>
        <header>
          <h1 style={{ fontSize: '2.5rem', fontWeight: 700, marginBottom: '0.5rem' }}>Beatloop Studio</h1>
          <p style={{ color: 'rgba(226,232,240,0.8)' }}>
            Connect your SoundCloud catalog to bring albums, tracks and artwork directly into Beatloop.
          </p>
        </header>
        <div
          style={{
            background: 'rgba(15,23,42,0.65)',
            borderRadius: '1.25rem',
            padding: '2rem',
            boxShadow: '0 25px 80px rgba(15,23,42,0.35)',
            border: '1px solid rgba(148,163,184,0.2)'
          }}
        >
          <h2 style={{ fontSize: '1.5rem', marginBottom: '0.75rem' }}>SoundCloud Integration</h2>
          <p style={{ marginBottom: '1.5rem', color: 'rgba(226,232,240,0.75)' }}>
            Import your playlists, albums, tracks and cover art. We store the metadata and stream audio directly from
            SoundCloud so your listeners get instant playback without re-uploading files.
          </p>
          <Link
            href="/integrations/soundcloud"
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: '0.5rem',
              padding: '0.85rem 1.5rem',
              borderRadius: '9999px',
              background: 'linear-gradient(135deg, #7c3aed, #22d3ee)',
              color: '#0f172a',
              fontWeight: 600,
              textDecoration: 'none'
            }}
          >
            Manage SoundCloud Imports
          </Link>
        </div>
      </div>
    </main>
  );
}
