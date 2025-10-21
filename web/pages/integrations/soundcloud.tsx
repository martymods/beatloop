import { useCallback, useEffect, useMemo, useState, type CSSProperties } from 'react';
import Head from 'next/head';
import { useRouter } from 'next/router';
import useSWR from 'swr';

interface SoundCloudSessionResponse {
  available: boolean;
  connected: boolean;
  account: {
    username: string;
    permalinkUrl: string;
    avatar: string;
    scope: string[];
    expiresAt?: string;
    lastSyncAt?: string;
    soundcloudUserId?: number | null;
  } | null;
}

interface SoundCloudTrackCatalogItem {
  id: number;
  title: string;
  permalinkUrl: string;
  artworkUrl?: string;
  bpm?: number | null;
  duration?: number | null;
  description?: string;
  createdAt?: string | null;
  importedTrackId?: string | null;
}

interface SoundCloudPlaylistCatalogItem {
  id: number;
  title: string;
  type?: string;
  trackCount?: number;
  permalinkUrl: string;
  artworkUrl?: string;
  description?: string;
  importedAlbumId?: string | null;
}

interface SoundCloudCatalogResponse {
  account: SoundCloudSessionResponse['account'];
  tracks: SoundCloudTrackCatalogItem[];
  playlists: SoundCloudPlaylistCatalogItem[];
}

type FetcherKey = [string, string];

const fetcher = async ([path, token]: FetcherKey) => {
  const response = await fetch(path, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${token}`
    }
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(text || response.statusText || 'Request failed');
  }
  return response.json();
};

const cardStyle: CSSProperties = {
  background: 'rgba(15,23,42,0.65)',
  borderRadius: '1rem',
  padding: '1.25rem',
  border: '1px solid rgba(148,163,184,0.2)',
  boxShadow: '0 15px 45px rgba(15,23,42,0.35)'
};

const badgeStyle: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  borderRadius: '9999px',
  fontSize: '0.75rem',
  fontWeight: 600,
  padding: '0.25rem 0.75rem',
  background: 'rgba(148,163,184,0.2)',
  color: '#e2e8f0'
};

function formatDuration(seconds?: number | null) {
  if (!seconds || Number.isNaN(seconds)) return '—';
  const rounded = Math.floor(seconds);
  const mins = Math.floor(rounded / 60);
  const secs = rounded % 60;
  return `${mins}:${secs.toString().padStart(2, '0')}`;
}

function formatDate(value?: string | null) {
  if (!value) return '—';
  try {
    return new Intl.DateTimeFormat(undefined, {
      year: 'numeric',
      month: 'short',
      day: 'numeric'
    }).format(new Date(value));
  } catch {
    return '—';
  }
}

export default function SoundCloudIntegrationPage() {
  const router = useRouter();
  const [token, setToken] = useState<string | null>(null);
  const [selectedTracks, setSelectedTracks] = useState<Set<number>>(new Set());
  const [selectedPlaylists, setSelectedPlaylists] = useState<Set<number>>(new Set());
  const [message, setMessage] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const stored = window.localStorage.getItem('beatloop_token');
    if (stored) {
      setToken(stored);
    }
  }, []);

  useEffect(() => {
    if (!router.isReady) return;
    const { connected, error } = router.query;
    if (connected) {
      setMessage('SoundCloud account connected. You can import your catalog now.');
    }
    if (error) {
      setErrorMessage('SoundCloud authorization failed. Please try again.');
    }
    if (connected || error) {
      const nextQuery = { ...router.query };
      delete nextQuery.connected;
      delete nextQuery.error;
      router.replace({ pathname: router.pathname, query: nextQuery }, undefined, { shallow: true });
    }
  }, [router]);

  const sessionKey = token ? ['/api/integrations/soundcloud/session', token] : null;
  const {
    data: session,
    mutate: refreshSession,
    isValidating: sessionLoading
  } = useSWR<SoundCloudSessionResponse>(sessionKey, fetcher, { revalidateOnFocus: false });

  const catalogKey = token && session?.connected
    ? ['/api/integrations/soundcloud/catalog', token]
    : null;
  const {
    data: catalog,
    mutate: refreshCatalog,
    isValidating: catalogLoading
  } = useSWR<SoundCloudCatalogResponse>(catalogKey, fetcher, { revalidateOnFocus: false });

  const importedTrackCount = useMemo(() => {
    if (!catalog?.tracks) return 0;
    return catalog.tracks.filter((track) => Boolean(track.importedTrackId)).length;
  }, [catalog]);

  const importedAlbumCount = useMemo(() => {
    if (!catalog?.playlists) return 0;
    return catalog.playlists.filter((pl) => Boolean(pl.importedAlbumId)).length;
  }, [catalog]);

  const toggleTrack = useCallback((trackId: number, disabled?: boolean) => {
    if (disabled) return;
    setSelectedTracks((prev) => {
      const next = new Set(prev);
      if (next.has(trackId)) {
        next.delete(trackId);
      } else {
        next.add(trackId);
      }
      return next;
    });
  }, []);

  const togglePlaylist = useCallback((playlistId: number, disabled?: boolean) => {
    if (disabled) return;
    setSelectedPlaylists((prev) => {
      const next = new Set(prev);
      if (next.has(playlistId)) {
        next.delete(playlistId);
      } else {
        next.add(playlistId);
      }
      return next;
    });
  }, []);

  const handleConnect = useCallback(async () => {
    if (!token) {
      setErrorMessage('Sign in to Beatloop to obtain an API token before connecting SoundCloud.');
      return;
    }
    try {
      setConnecting(true);
      setErrorMessage(null);
      setMessage(null);
      const redirectUrl = typeof window !== 'undefined'
        ? `${window.location.origin}/integrations/soundcloud`
        : '/integrations/soundcloud';
      const response = await fetch(`/api/integrations/soundcloud/authorize?redirect=${encodeURIComponent(redirectUrl)}`, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${token}`
        }
      });
      if (!response.ok) {
        const text = await response.text();
        throw new Error(text || 'Unable to begin SoundCloud authorization');
      }
      const data = await response.json();
      if (data?.url) {
        window.location.href = data.url;
      } else {
        throw new Error('SoundCloud authorization URL missing');
      }
    } catch (err) {
      console.error(err);
      setErrorMessage(err instanceof Error ? err.message : 'Failed to start SoundCloud authorization');
    } finally {
      setConnecting(false);
    }
  }, [token]);

  const handleDisconnect = useCallback(async () => {
    if (!token) return;
    try {
      setDisconnecting(true);
      setErrorMessage(null);
      setMessage(null);
      await fetch('/api/integrations/soundcloud/disconnect', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`
        }
      });
      setSelectedTracks(new Set());
      setSelectedPlaylists(new Set());
      await Promise.all([refreshSession(), refreshCatalog()]);
      setMessage('SoundCloud account disconnected.');
    } catch (err) {
      console.error(err);
      setErrorMessage('Failed to disconnect SoundCloud account.');
    } finally {
      setDisconnecting(false);
    }
  }, [token, refreshCatalog, refreshSession]);

  const handleImport = useCallback(async () => {
    if (!token) {
      setErrorMessage('Sign in to Beatloop to import tracks.');
      return;
    }
    if (!selectedTracks.size && !selectedPlaylists.size) {
      setErrorMessage('Select at least one track or playlist to import.');
      return;
    }
    try {
      setImporting(true);
      setErrorMessage(null);
      setMessage(null);
      const payload = {
        trackIds: Array.from(selectedTracks),
        playlistIds: Array.from(selectedPlaylists)
      };
      const response = await fetch('/api/integrations/soundcloud/import', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`
        },
        body: JSON.stringify(payload)
      });
      if (!response.ok) {
        const text = await response.text();
        throw new Error(text || 'Import failed');
      }
      await refreshCatalog();
      await refreshSession();
      setSelectedTracks(new Set());
      setSelectedPlaylists(new Set());
      setMessage('Import complete. Your SoundCloud catalog is available in Beatloop.');
    } catch (err) {
      console.error(err);
      setErrorMessage(err instanceof Error ? err.message : 'SoundCloud import failed.');
    } finally {
      setImporting(false);
    }
  }, [token, selectedTracks, selectedPlaylists, refreshCatalog, refreshSession]);

  const handleClearSelection = useCallback(() => {
    setSelectedTracks(new Set());
    setSelectedPlaylists(new Set());
  }, []);

  const sessionStatus = sessionLoading ? 'Loading SoundCloud status…' : session?.connected ? 'Connected' : 'Not connected';

  return (
    <main>
      <Head>
        <title>Beatloop · SoundCloud Import</title>
      </Head>
      <div style={{ maxWidth: 1080, margin: '0 auto', display: 'flex', flexDirection: 'column', gap: '1.75rem' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '1rem' }}>
          <div>
            <h1 style={{ fontSize: '2.75rem', margin: 0, fontWeight: 700 }}>SoundCloud Import</h1>
            <p style={{ marginTop: '0.5rem', color: 'rgba(226,232,240,0.75)', maxWidth: 640 }}>
              Connect your SoundCloud account to import playlists, albums, tracks, metadata and cover art. Beatloop
              stores metadata in R2 and streams audio directly from SoundCloud—no re-uploads required.
            </p>
          </div>
          <span style={badgeStyle}>{sessionStatus}</span>
        </div>

        {!token && (
          <div style={{ ...cardStyle, borderColor: 'rgba(248,113,113,0.35)' }}>
            <h2 style={{ marginTop: 0 }}>Sign in required</h2>
            <p style={{ color: 'rgba(248,250,252,0.8)' }}>
              Store your Beatloop API token in <code>localStorage</code> under <strong>beatloop_token</strong> after signing
              in to Beatloop to manage integrations from this dashboard.
            </p>
          </div>
        )}

        {message && (
          <div style={{ ...cardStyle, borderColor: 'rgba(34,197,94,0.45)' }}>
            <strong style={{ display: 'block', marginBottom: '0.5rem' }}>Success</strong>
            <span>{message}</span>
          </div>
        )}

        {errorMessage && (
          <div style={{ ...cardStyle, borderColor: 'rgba(248,113,113,0.45)' }}>
            <strong style={{ display: 'block', marginBottom: '0.5rem' }}>Error</strong>
            <span>{errorMessage}</span>
          </div>
        )}

        {session?.available === false && (
          <div style={{ ...cardStyle, borderColor: 'rgba(248,113,113,0.35)' }}>
            <h2 style={{ marginTop: 0 }}>SoundCloud integration is disabled</h2>
            <p style={{ color: 'rgba(248,250,252,0.8)' }}>
              Configure <code>SOUNDCLOUD_CLIENT_ID</code>, <code>SOUNDCLOUD_CLIENT_SECRET</code> and
              <code> SOUNDCLOUD_REDIRECT_URI</code> in the Beatloop API environment to enable this feature.
            </p>
          </div>
        )}

        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '1rem' }}>
          <button
            type="button"
            onClick={handleConnect}
            disabled={!token || session?.connected || connecting || session?.available === false}
            style={{
              padding: '0.95rem 1.75rem',
              borderRadius: '9999px',
              border: 'none',
              fontWeight: 600,
              background: session?.connected
                ? 'rgba(148,163,184,0.2)'
                : 'linear-gradient(135deg, #7c3aed, #22d3ee)',
              color: session?.connected ? '#cbd5f5' : '#0f172a',
              opacity: session?.connected ? 0.7 : 1,
              cursor: !token || session?.connected ? 'not-allowed' : 'pointer'
            }}
          >
            {connecting ? 'Redirecting…' : session?.connected ? 'Connected' : 'Connect SoundCloud'}
          </button>
          {session?.connected && (
            <button
              type="button"
              onClick={handleDisconnect}
              disabled={disconnecting}
              style={{
                padding: '0.95rem 1.5rem',
                borderRadius: '9999px',
                border: '1px solid rgba(148,163,184,0.3)',
                background: 'transparent',
                color: '#e2e8f0'
              }}
            >
              {disconnecting ? 'Disconnecting…' : 'Disconnect'}
            </button>
          )}
          <button
            type="button"
            onClick={handleClearSelection}
            disabled={!selectedTracks.size && !selectedPlaylists.size}
            style={{
              padding: '0.95rem 1.5rem',
              borderRadius: '9999px',
              border: '1px solid rgba(148,163,184,0.3)',
              background: 'transparent',
              color: '#e2e8f0',
              opacity: (!selectedTracks.size && !selectedPlaylists.size) ? 0.5 : 1
            }}
          >
            Clear selection
          </button>
        </div>

        {session?.connected && (
          <section style={{ display: 'grid', gap: '1.5rem' }}>
            <div style={{ display: 'grid', gap: '1rem', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))' }}>
              <div style={cardStyle}>
                <h2 style={{ marginTop: 0 }}>Account</h2>
                {catalog?.account ? (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
                      {catalog.account.avatar && (
                        <img
                          src={catalog.account.avatar}
                          alt="SoundCloud avatar"
                          style={{ width: 56, height: 56, borderRadius: '50%', objectFit: 'cover' }}
                        />
                      )}
                      <div>
                        <div style={{ fontWeight: 600, fontSize: '1.05rem' }}>{catalog.account.username || 'SoundCloud User'}</div>
                        {catalog.account.permalinkUrl && (
                          <a
                            href={catalog.account.permalinkUrl}
                            target="_blank"
                            rel="noreferrer"
                            style={{ color: 'rgba(125,211,252,0.9)', fontSize: '0.85rem' }}
                          >
                            View profile
                          </a>
                        )}
                      </div>
                    </div>
                    <div style={{ color: 'rgba(226,232,240,0.75)', fontSize: '0.9rem' }}>
                      <div>Imported tracks: {importedTrackCount}</div>
                      <div>Imported albums: {importedAlbumCount}</div>
                      <div>
                        Last sync:{' '}
                        {catalog.account.lastSyncAt ? formatDate(catalog.account.lastSyncAt) : '—'}
                      </div>
                    </div>
                  </div>
                ) : (
                  <p style={{ color: 'rgba(226,232,240,0.75)' }}>Fetching account metadata…</p>
                )}
              </div>

              <div style={cardStyle}>
                <h2 style={{ marginTop: 0 }}>Import</h2>
                <p style={{ color: 'rgba(226,232,240,0.75)', marginBottom: '1rem' }}>
                  Selected tracks: {selectedTracks.size} &nbsp;|&nbsp; Selected playlists: {selectedPlaylists.size}
                </p>
                <button
                  type="button"
                  onClick={handleImport}
                  disabled={importing || (!selectedTracks.size && !selectedPlaylists.size)}
                  style={{
                    padding: '0.9rem 1.5rem',
                    borderRadius: '9999px',
                    border: 'none',
                    background: 'linear-gradient(135deg, #34d399, #22d3ee)',
                    color: '#0f172a',
                    fontWeight: 600,
                    opacity: importing ? 0.65 : 1
                  }}
                >
                  {importing ? 'Importing…' : 'Import to Beatloop'}
                </button>
              </div>
            </div>

            <div style={{ display: 'grid', gap: '1.5rem', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))' }}>
              <div style={{ ...cardStyle, minHeight: 320 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <h2 style={{ marginTop: 0 }}>Tracks</h2>
                  {catalogLoading && <span style={{ fontSize: '0.85rem', color: 'rgba(148,163,184,0.8)' }}>Refreshing…</span>}
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem', maxHeight: 460, overflowY: 'auto', paddingRight: '0.5rem' }}>
                  {catalog?.tracks?.length ? (
                    catalog.tracks.map((track) => {
                      const imported = Boolean(track.importedTrackId);
                      const checked = selectedTracks.has(track.id);
                      return (
                        <article
                          key={track.id}
                          style={{
                            display: 'flex',
                            gap: '0.75rem',
                            alignItems: 'center',
                            padding: '0.75rem',
                            borderRadius: '0.75rem',
                            background: checked ? 'rgba(79,70,229,0.25)' : 'rgba(15,23,42,0.4)',
                            border: '1px solid rgba(148,163,184,0.15)'
                          }}
                        >
                          <input
                            type="checkbox"
                            checked={checked}
                            disabled={imported}
                            onChange={() => toggleTrack(track.id, imported)}
                          />
                          {track.artworkUrl && (
                            <img
                              src={track.artworkUrl}
                              alt="Track artwork"
                              style={{ width: 56, height: 56, borderRadius: '0.75rem', objectFit: 'cover' }}
                            />
                          )}
                          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: '0.35rem' }}>
                            <div style={{ fontWeight: 600 }}>{track.title || 'Untitled Track'}</div>
                            <div style={{ fontSize: '0.85rem', color: 'rgba(148,163,184,0.85)' }}>
                              {formatDuration(track.duration)} · BPM {track.bpm ?? '—'} · Added {formatDate(track.createdAt)}
                            </div>
                            {track.permalinkUrl && (
                              <a
                                href={track.permalinkUrl}
                                target="_blank"
                                rel="noreferrer"
                                style={{ color: 'rgba(125,211,252,0.9)', fontSize: '0.85rem' }}
                              >
                                Open on SoundCloud
                              </a>
                            )}
                          </div>
                          {imported && <span style={badgeStyle}>Imported</span>}
                        </article>
                      );
                    })
                  ) : (
                    <p style={{ color: 'rgba(226,232,240,0.7)' }}>
                      {catalogLoading ? 'Loading your tracks…' : 'No SoundCloud tracks found.'}
                    </p>
                  )}
                </div>
              </div>

              <div style={{ ...cardStyle, minHeight: 320 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <h2 style={{ marginTop: 0 }}>Playlists & Albums</h2>
                  {catalogLoading && <span style={{ fontSize: '0.85rem', color: 'rgba(148,163,184,0.8)' }}>Refreshing…</span>}
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem', maxHeight: 460, overflowY: 'auto', paddingRight: '0.5rem' }}>
                  {catalog?.playlists?.length ? (
                    catalog.playlists.map((playlist) => {
                      const imported = Boolean(playlist.importedAlbumId);
                      const checked = selectedPlaylists.has(playlist.id);
                      return (
                        <article
                          key={playlist.id}
                          style={{
                            display: 'flex',
                            gap: '0.75rem',
                            padding: '0.75rem',
                            alignItems: 'center',
                            borderRadius: '0.75rem',
                            background: checked ? 'rgba(22,163,74,0.25)' : 'rgba(15,23,42,0.4)',
                            border: '1px solid rgba(148,163,184,0.15)'
                          }}
                        >
                          <input
                            type="checkbox"
                            checked={checked}
                            disabled={imported}
                            onChange={() => togglePlaylist(playlist.id, imported)}
                          />
                          {playlist.artworkUrl && (
                            <img
                              src={playlist.artworkUrl}
                              alt="Playlist artwork"
                              style={{ width: 56, height: 56, borderRadius: '0.75rem', objectFit: 'cover' }}
                            />
                          )}
                          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: '0.35rem' }}>
                            <div style={{ fontWeight: 600 }}>{playlist.title || 'Untitled Playlist'}</div>
                            <div style={{ fontSize: '0.85rem', color: 'rgba(148,163,184,0.85)' }}>
                              {playlist.trackCount ?? 0} tracks · {playlist.type || 'playlist'}
                            </div>
                            {playlist.permalinkUrl && (
                              <a
                                href={playlist.permalinkUrl}
                                target="_blank"
                                rel="noreferrer"
                                style={{ color: 'rgba(125,211,252,0.9)', fontSize: '0.85rem' }}
                              >
                                Open on SoundCloud
                              </a>
                            )}
                          </div>
                          {imported && <span style={badgeStyle}>Imported</span>}
                        </article>
                      );
                    })
                  ) : (
                    <p style={{ color: 'rgba(226,232,240,0.7)' }}>
                      {catalogLoading ? 'Loading your playlists…' : 'No SoundCloud playlists found.'}
                    </p>
                  )}
                </div>
              </div>
            </div>
          </section>
        )}
      </div>
    </main>
  );
}
