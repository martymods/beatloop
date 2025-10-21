import Head from 'next/head';
import Link from 'next/link';
import { useEffect, useMemo, useRef, useState } from 'react';

type FeedItem = {
  title: string;
  url: string;
  excerpt?: string;
  image?: string;
  publishedAt?: string | null;
};

type StoryAuthor = {
  id: string;
  name: string;
  avatarUrl?: string;
};

type StoryComment = {
  id: string;
  storyId: string;
  body: string;
  imageUrl?: string;
  createdAt?: string | null;
  author?: StoryAuthor | null;
};

type MediaStory = {
  id: string;
  url: string;
  title: string;
  excerpt: string;
  summary: string;
  summaryModel?: string;
  summaryError?: string;
  imageUrl?: string;
  watermarkedImageUrl?: string;
  likeCount: number;
  dislikeCount: number;
  commentCount: number;
  liked?: boolean;
  disliked?: boolean;
  shareSlug?: string;
  shareUrl?: string;
  source?: string;
  publishedAt?: string | null;
  createdAt?: string | null;
  updatedAt?: string | null;
};

type CommentState = {
  items: StoryComment[];
  loading: boolean;
  error?: string | null;
};

type CommentDraft = {
  body: string;
  file?: File | null;
  previewUrl?: string | null;
};

const API_BASE = (process.env.NEXT_PUBLIC_API_BASE_URL || '').replace(/\/$/, '');
const WATERMARK_ASSET = '/img/350x350_LOGO.png';

function apiPath(path: string): string {
  if (API_BASE) return `${API_BASE}${path}`;
  return path;
}

function readStoredToken(): string {
  if (typeof window === 'undefined') return '';
  try {
    return (
      window.localStorage.getItem('beatloop_token') ||
      window.localStorage.getItem('jwt') ||
      ''
    );
  } catch {
    return '';
  }
}

function formatDate(value?: string | null): string {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit'
  });
}

async function blobFromArrayBuffer(buffer: ArrayBuffer, mimeType: string): Promise<Blob> {
  return new Blob([buffer], { type: mimeType });
}

async function fileFromBlob(blob: Blob, fileName: string): Promise<File> {
  return new File([blob], fileName, { type: blob.type });
}

async function loadImageElement(source: Blob | File): Promise<HTMLImageElement> {
  return await new Promise<HTMLImageElement>((resolve, reject) => {
    const url = URL.createObjectURL(source);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = (event) => {
      URL.revokeObjectURL(url);
      reject(event instanceof ErrorEvent ? event.error : new Error('image_load_failed'));
    };
    img.src = url;
  });
}

async function compressImageFile(input: File, maxWidth = 1280): Promise<File> {
  const image = await loadImageElement(input);
  const originalWidth = image.naturalWidth || image.width;
  const originalHeight = image.naturalHeight || image.height;
  const scale = originalWidth > maxWidth ? maxWidth / originalWidth : 1;
  const width = Math.max(1, Math.round(originalWidth * scale));
  const height = Math.max(1, Math.round(originalHeight * scale));
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('missing_canvas');
  ctx.drawImage(image, 0, 0, width, height);
  const blobResult: Blob | null = await new Promise((resolve) =>
    canvas.toBlob(resolve, 'image/webp', 0.82)
  );
  if (!blobResult) throw new Error('compress_failed');
  return fileFromBlob(blobResult, `${input.name.replace(/\.[^.]+$/, '') || 'comment'}.webp`);
}

async function createWatermarkedBlob(
  baseBuffer: ArrayBuffer,
  watermark: HTMLImageElement,
  options: { padding?: number; targetRatio?: number } = {}
): Promise<Blob> {
  const padding = options.padding ?? 24;
  const targetRatio = options.targetRatio ?? 0.18;
  const baseBlob = await blobFromArrayBuffer(baseBuffer, 'image/jpeg');
  const baseImage = await loadImageElement(baseBlob);
  const originalWidth = baseImage.naturalWidth || baseImage.width;
  const originalHeight = baseImage.naturalHeight || baseImage.height;
  const canvas = document.createElement('canvas');
  canvas.width = originalWidth;
  canvas.height = originalHeight;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('canvas_context_missing');
  ctx.drawImage(baseImage, 0, 0, canvas.width, canvas.height);
  const logoWidth = Math.round(canvas.width * targetRatio);
  const logoHeight = Math.round((logoWidth / watermark.width) * watermark.height);
  ctx.drawImage(watermark, padding, canvas.height - logoHeight - padding, logoWidth, logoHeight);
  const blobResult: Blob | null = await new Promise((resolve) =>
    canvas.toBlob(resolve, 'image/webp', 0.88)
  );
  if (!blobResult) throw new Error('watermark_failed');
  return blobResult;
}

async function loadWatermarkImage(): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = WATERMARK_ASSET;
  });
}

interface ApiFetchOptions extends RequestInit {
  expect?: 'json' | 'arrayBuffer' | 'blob';
}

type StoriesMap = Record<string, MediaStory>;

type DraftMap = Record<string, CommentDraft>;

type CommentMap = Record<string, CommentState>;

export default function MediaPage(): JSX.Element {
  const [feed, setFeed] = useState<FeedItem[]>([]);
  const [loadingFeed, setLoadingFeed] = useState(true);
  const [storiesById, setStoriesById] = useState<StoriesMap>({});
  const [storiesByUrl, setStoriesByUrl] = useState<StoriesMap>({});
  const [loadingStories, setLoadingStories] = useState(true);
  const [token, setToken] = useState('');
  const tokenRef = useRef('');
  const [pendingSummary, setPendingSummary] = useState<string | null>(null);
  const [pendingReaction, setPendingReaction] = useState<string | null>(null);
  const [pendingComment, setPendingComment] = useState<string | null>(null);
  const [banner, setBanner] = useState<{ message: string; tone: 'info' | 'error' } | null>(null);
  const [commentDrafts, setCommentDrafts] = useState<DraftMap>({});
  const [commentState, setCommentState] = useState<CommentMap>({});
  const [activeStoryId, setActiveStoryId] = useState<string | null>(null);
  const [highlightSlug, setHighlightSlug] = useState<string | null>(null);
  const draftsRef = useRef<DraftMap>({});
  const watermarkRef = useRef<HTMLImageElement | null>(null);

  useEffect(() => {
    tokenRef.current = token;
  }, [token]);

  useEffect(() => {
    draftsRef.current = commentDrafts;
  }, [commentDrafts]);

  useEffect(() => {
    if (!banner || banner.tone !== 'info') return;
    const timeout = window.setTimeout(() => setBanner(null), 4000);
    return () => window.clearTimeout(timeout);
  }, [banner]);

  useEffect(() => {
    const stored = readStoredToken();
    if (stored) setToken(stored);
  }, []);

  useEffect(() => {
    return () => {
      Object.values(draftsRef.current).forEach((draft) => {
        if (draft.previewUrl) {
          URL.revokeObjectURL(draft.previewUrl);
        }
      });
    };
  }, []);

  useEffect(() => {
    if (typeof window !== 'undefined') {
      const params = new URLSearchParams(window.location.search);
      const slug = params.get('story');
      if (slug) {
        setHighlightSlug(slug);
      }
    }
  }, []);

  useEffect(() => {
    loadFeed().catch((error) => {
      console.error(error);
      setBanner({ message: error.message, tone: 'error' });
    });
  }, []);

  useEffect(() => {
    loadStories().catch((error) => {
      console.error(error);
      setBanner({ message: error.message, tone: 'error' });
    });
  }, [token]);

  useEffect(() => {
    if (!highlightSlug) return;
    const match = Object.values(storiesById).find(
      (story) => story.shareSlug === highlightSlug || story.id === highlightSlug
    );
    if (match) {
      setActiveStoryId(match.id);
      setTimeout(() => {
        if (typeof document === 'undefined') return;
        const el = document.getElementById(`story-${match.id}`);
        if (el) {
          el.scrollIntoView({ behavior: 'smooth', block: 'center' });
          el.classList.add('highlight-pulse');
          setTimeout(() => el.classList.remove('highlight-pulse'), 2000);
        }
      }, 300);
      setHighlightSlug(null);
    }
  }, [highlightSlug, storiesById]);

  async function apiFetch<T = any>(path: string, options: ApiFetchOptions = {}): Promise<T> {
    const { expect = 'json', headers, body, ...rest } = options;
    const mergedHeaders = new Headers(headers || {});
    const authToken = tokenRef.current;
    if (authToken && !mergedHeaders.has('Authorization')) {
      mergedHeaders.set('Authorization', `Bearer ${authToken}`);
    }
    let requestBody = body;
    if (body && !(body instanceof FormData) && typeof body !== 'string') {
      if (!mergedHeaders.has('Content-Type')) {
        mergedHeaders.set('Content-Type', 'application/json');
      }
      requestBody = JSON.stringify(body);
    }
    const response = await fetch(apiPath(path), {
      ...rest,
      headers: mergedHeaders,
      body: requestBody as BodyInit | undefined
    });
    if (!response.ok) {
      let message = `Request failed (${response.status})`;
      try {
        const data = await response.json();
        message = data?.error || message;
      } catch {
        try {
          const text = await response.text();
          if (text) message = text;
        } catch {
          // ignore
        }
      }
      throw new Error(message);
    }
    if (expect === 'arrayBuffer') {
      return (await response.arrayBuffer()) as unknown as T;
    }
    if (expect === 'blob') {
      return (await response.blob()) as unknown as T;
    }
    if (response.status === 204) {
      return undefined as unknown as T;
    }
    return (await response.json()) as T;
  }

  async function loadFeed() {
    setLoadingFeed(true);
    try {
      const data = await apiFetch<{ items?: FeedItem[] }>('/api/media/hiphop');
      setFeed(Array.isArray(data.items) ? data.items : []);
    } finally {
      setLoadingFeed(false);
    }
  }

  async function loadStories() {
    setLoadingStories(true);
    try {
      const data = await apiFetch<{ stories?: MediaStory[] }>('/api/media/stories');
      if (Array.isArray(data.stories)) {
        const byId: StoriesMap = {};
        const byUrl: StoriesMap = {};
        for (const story of data.stories) {
          if (story.id) byId[story.id] = story;
          if (story.url) byUrl[story.url] = story;
        }
        setStoriesById(byId);
        setStoriesByUrl(byUrl);
      } else {
        setStoriesById({});
        setStoriesByUrl({});
      }
    } finally {
      setLoadingStories(false);
    }
  }

  function storeStory(story: MediaStory) {
    setStoriesById((prev) => ({ ...prev, [story.id]: story }));
    setStoriesByUrl((prev) => ({ ...prev, [story.url]: story }));
  }

  async function handleSummarize(item: FeedItem) {
    if (!item.url) return;
    setBanner(null);
    try {
      setPendingSummary(item.url);
      const payload = await apiFetch<{ story: MediaStory; summaryError?: string }>(
        '/api/media/summarize',
        {
          method: 'POST',
          body: {
            url: item.url,
            title: item.title,
            excerpt: item.excerpt,
            image: item.image,
            publishedAt: item.publishedAt
          }
        }
      );
      const story = payload.story;
      storeStory(story);
      if (item.image) {
        try {
          let watermarkImage = watermarkRef.current;
          if (!watermarkImage) {
            watermarkImage = await loadWatermarkImage();
            watermarkRef.current = watermarkImage;
          }
          const buffer = await apiFetch<ArrayBuffer>('/api/media/proxy-image', {
            method: 'POST',
            body: { url: item.image },
            expect: 'arrayBuffer'
          });
          const blob = await createWatermarkedBlob(buffer, watermarkImage);
          const file = await fileFromBlob(blob, `${story.shareSlug || story.id}.webp`);
          const formData = new FormData();
          formData.append('image', file);
          if (item.image) formData.append('sourceUrl', item.image);
          const updated = await apiFetch<{ story: MediaStory }>(
            `/api/media/stories/${story.id}/image`,
            {
              method: 'POST',
              body: formData
            }
          );
          storeStory(updated.story);
        } catch (error) {
          console.warn('Watermark upload failed', error);
        }
      }
      setActiveStoryId(story.id);
    } catch (error: any) {
      console.error(error);
      showBannerMessage(setBanner, error.message || 'Unable to summarize story.');
    } finally {
      setPendingSummary(null);
    }
  }

  async function handleReaction(story: MediaStory, type: 'like' | 'dislike') {
    setBanner(null);
    try {
      setPendingReaction(story.id);
      const endpoint = `/api/media/stories/${story.id}/${type}`;
      const data = await apiFetch<{ story: MediaStory }>(endpoint, { method: 'POST' });
      storeStory(data.story);
    } catch (error: any) {
      console.error(error);
      showBannerMessage(setBanner, error.message || 'Unable to update reaction.');
    } finally {
      setPendingReaction(null);
    }
  }

  async function ensureCommentsLoaded(story: MediaStory) {
    const existing = commentState[story.id];
    if (existing && !existing.loading) return;
    setCommentState((prev) => ({
      ...prev,
      [story.id]: { items: existing?.items || [], loading: true, error: null }
    }));
    try {
      const data = await apiFetch<{ comments?: StoryComment[] }>(
        `/api/media/stories/${story.id}/comments`
      );
      setCommentState((prev) => ({
        ...prev,
        [story.id]: {
          items: Array.isArray(data.comments) ? data.comments : [],
          loading: false,
          error: null
        }
      }));
    } catch (error: any) {
      setCommentState((prev) => ({
        ...prev,
        [story.id]: {
          items: existing?.items || [],
          loading: false,
          error: error.message || 'Unable to load comments.'
        }
      }));
    }
  }

function updateDraft(storyId: string, updater: (draft: CommentDraft) => CommentDraft) {
  setCommentDrafts((prev) => {
    const current = prev[storyId] || { body: '', file: null, previewUrl: null };
    const updated = updater({ ...current });
    if (current.previewUrl && current.previewUrl !== updated.previewUrl) {
      URL.revokeObjectURL(current.previewUrl);
    }
    return { ...prev, [storyId]: updated };
  });
}

function showBannerMessage(
  setter: (value: { message: string; tone: 'info' | 'error' } | null) => void,
  message: string,
  tone: 'info' | 'error' = 'error'
) {
  setter({ message, tone });
}

  async function submitComment(story: MediaStory) {
    const draft = commentDrafts[story.id] || { body: '', file: null };
    if (!draft.body.trim() && !draft.file) {
      showBannerMessage(setBanner, 'Add a note or attach an image before posting.');
      return;
    }
    setPendingComment(story.id);
    setBanner(null);
    try {
      const formData = new FormData();
      formData.append('body', draft.body.trim());
      if (draft.file) {
        const compressed = await compressImageFile(draft.file);
        formData.append('image', compressed);
      }
      const data = await apiFetch<{ comment: StoryComment }>(
        `/api/media/stories/${story.id}/comments`,
        {
          method: 'POST',
          body: formData
        }
      );
      setCommentState((prev) => {
        const current = prev[story.id] || { items: [], loading: false, error: null };
        return {
          ...prev,
          [story.id]: {
            items: [data.comment, ...current.items],
            loading: false,
            error: null
          }
        };
      });
      storeStory({ ...story, commentCount: story.commentCount + 1 });
      updateDraft(story.id, () => ({ body: '', file: null, previewUrl: null }));
    } catch (error: any) {
      console.error(error);
      showBannerMessage(setBanner, error.message || 'Unable to post comment.');
    } finally {
      setPendingComment(null);
    }
  }

  function handleFileChange(storyId: string, fileList: FileList | null) {
    if (!fileList || !fileList.length) {
      updateDraft(storyId, (draft) => ({ ...draft, file: null, previewUrl: null }));
      return;
    }
    const file = fileList[0];
    const previewUrl = URL.createObjectURL(file);
    updateDraft(storyId, (draft) => ({ ...draft, file, previewUrl }));
  }

  async function handleShare(story: MediaStory) {
    const shareText = `Beatloop Media — ${story.title}`;
    const shareUrl = story.shareUrl || `${window.location.origin}/media?story=${story.shareSlug || story.id}`;
    if (navigator.share) {
      try {
        await navigator.share({
          title: shareText,
          text: `${shareText}\n${story.summary || story.excerpt || ''}`,
          url: shareUrl
        });
        return;
      } catch (error) {
        console.warn('Share failed', error);
      }
    }
    try {
      await navigator.clipboard.writeText(shareUrl);
      showBannerMessage(setBanner, 'Link copied to clipboard.', 'info');
    } catch {
      showBannerMessage(setBanner, 'Share link: ' + shareUrl, 'info');
    }
  }

  const renderedCards = useMemo(() => {
    if (loadingFeed) {
      return (
        <div className="loading-copy">Loading TMZ Hip-Hop feed…</div>
      );
    }
    if (!feed.length) {
      return (
        <div className="loading-copy">No fresh TMZ Hip-Hop headlines right now. Check back soon.</div>
      );
    }
    return feed.map((item) => {
      const story = item.url ? storiesByUrl[item.url] : undefined;
      const isActive = story && story.id === activeStoryId;
      const isPending = pendingSummary === item.url;
      return (
        <div className="card-animation-layer" key={item.url}>
          <article
            className={`card${isActive ? ' card-active' : ''}`}
            id={story ? `story-${story.id}` : undefined}
          >
            {item.image && (
              <img className="card-img" src={story?.watermarkedImageUrl || item.image} alt={item.title} loading="lazy" />
            )}
            <h2>{item.title}</h2>
            <div className="card-meta">
              <span className="card-source">TMZ Hip-Hop</span>
              {item.publishedAt && <span>{formatDate(item.publishedAt)}</span>}
            </div>
            <p className="card-excerpt">{item.excerpt || 'No excerpt provided.'}</p>
            <div className="actions">
              <a className="btn" href={item.url} target="_blank" rel="noopener noreferrer">
                Read on TMZ
              </a>
              <button
                className="btn"
                disabled={isPending}
                onClick={() => handleSummarize(item)}
              >
                {story ? 'Refresh AI Summary' : isPending ? 'Summarizing…' : 'Create AI Summary'}
              </button>
            </div>
            {story && (
              <div className="story-panel">
                <div className="our-summary">
                  <strong>Our take:</strong>
                  {story.summary ? (
                    <p>{story.summary}</p>
                  ) : story.summaryError ? (
                    <p className="muted">Unable to generate summary ({story.summaryError}).</p>
                  ) : (
                    <p className="muted">Summary pending. Generate above to refresh.</p>
                  )}
                  <div className="share-banner">
                    <div>
                      <span className="badge">Share Beatloop Media</span>
                      <p className="muted">Let the culture know — spread the word about our new media hub.</p>
                    </div>
                    <div className="share-actions">
                      <button className="btn" onClick={() => handleShare(story)}>Share Story</button>
                      {story.shareUrl && (
                        <a className="share-link" href={story.shareUrl} target="_blank" rel="noopener noreferrer">
                          {story.shareUrl.replace(/^https?:\/\//, '')}
                        </a>
                      )}
                    </div>
                  </div>
                </div>
                <div className="engage-bar">
                  <button
                    className={`icon-btn${story.liked ? ' active' : ''}`}
                    disabled={pendingReaction === story.id}
                    onClick={() => handleReaction(story, 'like')}
                  >
                    👍 {story.likeCount}
                  </button>
                  <button
                    className={`icon-btn${story.disliked ? ' active' : ''}`}
                    disabled={pendingReaction === story.id}
                    onClick={() => handleReaction(story, 'dislike')}
                  >
                    👎 {story.dislikeCount}
                  </button>
                  <button
                    className="icon-btn"
                    onClick={() => {
                      setActiveStoryId((prev) => (prev === story.id ? null : story.id));
                      ensureCommentsLoaded(story);
                    }}
                  >
                    💬 {story.commentCount}
                  </button>
                </div>
                {isActive && (
                  <div className="comments">
                    <h3>Community Thread</h3>
                    <p className="muted">
                      Drop your context, corrections, or media. Images are compressed in-browser before hitting our storage.
                    </p>
                    <textarea
                      placeholder="Share your perspective…"
                      value={commentDrafts[story.id]?.body || ''}
                      onChange={(event) =>
                        updateDraft(story.id, (draft) => ({
                          ...draft,
                          body: event.target.value
                        }))
                      }
                    />
                    <div className="comment-actions">
                      <label className="file-btn">
                        <input
                          type="file"
                          accept="image/*"
                          onChange={(event) => handleFileChange(story.id, event.target.files)}
                        />
                        📷 Attach image
                      </label>
                      <button
                        className="btn"
                        disabled={pendingComment === story.id}
                        onClick={() => submitComment(story)}
                      >
                        {pendingComment === story.id ? 'Posting…' : 'Post comment'}
                      </button>
                    </div>
                    {commentDrafts[story.id]?.previewUrl && (
                      <div className="comment-preview">
                        <img src={commentDrafts[story.id]?.previewUrl || ''} alt="Preview" />
                      </div>
                    )}
                    <CommentList
                      state={commentState[story.id]}
                    />
                  </div>
                )}
              </div>
            )}
          </article>
        </div>
      );
    });
  }, [
    feed,
    pendingSummary,
    storiesByUrl,
    activeStoryId,
    pendingReaction,
    commentState,
    commentDrafts,
    pendingComment,
    loadingFeed
  ]);

  return (
    <>
      <Head>
        <title>Beatloop Media — Hip-Hop Stories</title>
        <meta name="description" content="Beatloop Media curates TMZ Hip-Hop headlines with fresh AI summaries and community commentary." />
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link
          href="https://fonts.googleapis.com/css2?family=Space+Mono:wght@400;700&family=Work+Sans:wght@400;600;700&display=swap"
          rel="stylesheet"
        />
        <link rel="stylesheet" href="https://unpkg.com/open-props" />
        <link rel="stylesheet" href="https://unpkg.com/open-props/normalize.min.css" />
      </Head>
      <div className="media-shell">
        <header className="media-header">
          <div>
            <span className="badge">Beatloop Media</span>
            <h1>Hip-Hop News, Reimagined.</h1>
            <p className="muted">
              We remix TMZ Hip-Hop headlines with OpenAI summaries, watermark our visuals, and invite the community to react in real time.
            </p>
          </div>
          <Link className="back-link" href="/">
            ← Back to Studio
          </Link>
        </header>
        {banner && (
          <div className={`banner ${banner.tone === 'info' ? 'banner-info' : 'banner-error'}`}>
            {banner.message}
          </div>
        )}
        {loadingStories && (
          <div className="loading-copy">Syncing our Beatloop Media archive…</div>
        )}
        <main className="media-main">{renderedCards}</main>
      </div>
      <style jsx global>{`
        :root {
          --ink: #0f1220;
          --muted: #6e7280;
          --brand: #7c5cff;
          --edge: #e9ecf5;
          --media-bg: #fdfdfb;
        }
        body {
          margin: 0;
          background: var(--media-bg);
          color: var(--ink);
          font-family: 'Work Sans', system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
        }
        .media-shell {
          padding: var(--size-5);
          max-width: 1280px;
          margin: 0 auto;
        }
        .media-header {
          display: flex;
          justify-content: space-between;
          align-items: flex-start;
          gap: var(--size-5);
          padding-block: var(--size-5);
        }
        .media-header h1 {
          font-family: 'Space Mono', monospace;
          font-size: clamp(2.5rem, 4vw, 3.5rem);
          margin: 0;
        }
        .badge {
          display: inline-flex;
          align-items: center;
          gap: 0.35rem;
          padding: 0.35rem 0.9rem;
          border-radius: 999px;
          border: 2px solid #fadc00;
          background: #fff9c4;
          font-weight: 700;
          text-transform: uppercase;
          font-size: 0.75rem;
          letter-spacing: 0.1em;
        }
        .muted {
          color: var(--muted);
        }
        .back-link {
          color: var(--ink);
          text-decoration: none;
          font-weight: 600;
        }
        .media-main {
          --cols: 1;
          display: grid;
          grid-template-columns: repeat(var(--cols), minmax(0, var(--size-content-1)));
          gap: var(--size-5);
          padding-block: 3rem 5rem;
        }
        @media (width >= 720px) {
          .media-main { --cols: 2; }
        }
        @media (width >= 1200px) {
          .media-main { --cols: 3; }
        }
        .card-animation-layer {
          display: grid;
          gap: var(--size-3);
          animation: slide-in linear both;
          animation-timeline: view();
          animation-range: cover 0% contain 20%;
        }
        @keyframes slide-in {
          from {
            transform: translateY(32px) scale(0.94);
            opacity: 0;
          }
          to {
            transform: translateY(0) scale(1);
            opacity: 1;
          }
        }
        .card {
          border: 2px solid var(--ink);
          border-radius: var(--radius-4);
          background: #fff;
          box-shadow: var(--shadow-4);
          padding: var(--size-4);
          display: flex;
          flex-direction: column;
          gap: var(--size-3);
        }
        .card-active {
          outline: 3px solid var(--brand);
          outline-offset: 4px;
        }
        .card h2 {
          font-family: 'Space Mono', monospace;
          margin: 0;
          font-size: 1.5rem;
        }
        .card-meta {
          display: flex;
          flex-wrap: wrap;
          gap: 0.6rem;
          font-size: 0.85rem;
          color: var(--muted);
        }
        .card-source {
          font-weight: 700;
        }
        .card-excerpt {
          margin: 0;
          color: var(--muted);
          min-height: 3.5rem;
        }
        .card-img {
          width: 100%;
          height: auto;
          border-radius: var(--radius-3);
          border: 1px solid var(--edge);
        }
        .actions {
          display: flex;
          flex-wrap: wrap;
          gap: 0.75rem;
        }
        .btn {
          display: inline-flex;
          align-items: center;
          justify-content: center;
          padding: 0.65rem 1.2rem;
          border: 2px solid var(--ink);
          border-radius: 999px;
          font-weight: 700;
          background: #fff;
          cursor: pointer;
        }
        .btn:disabled {
          opacity: 0.6;
          cursor: not-allowed;
        }
        .story-panel {
          border-top: 1px solid var(--edge);
          padding-top: var(--size-3);
          display: flex;
          flex-direction: column;
          gap: var(--size-3);
        }
        .our-summary p {
          margin-top: 0.5rem;
          line-height: 1.5;
        }
        .share-banner {
          margin-top: var(--size-3);
          padding: var(--size-3);
          border: 2px dashed #fadc00;
          border-radius: var(--radius-3);
          background: #fffbe6;
          display: flex;
          flex-direction: column;
          gap: 1rem;
        }
        .share-actions {
          display: flex;
          flex-wrap: wrap;
          gap: 0.75rem;
          align-items: center;
        }
        .share-link {
          color: var(--brand);
          font-weight: 600;
        }
        .engage-bar {
          display: flex;
          gap: 0.75rem;
          align-items: center;
        }
        .icon-btn {
          border: 2px solid var(--ink);
          border-radius: 999px;
          padding: 0.4rem 0.9rem;
          background: #fff;
          cursor: pointer;
          font-weight: 600;
        }
        .icon-btn.active {
          background: var(--ink);
          color: #fff;
        }
        .comments {
          border-top: 1px solid var(--edge);
          padding-top: var(--size-3);
          display: flex;
          flex-direction: column;
          gap: var(--size-3);
        }
        textarea {
          min-height: 120px;
          padding: 0.75rem;
          border-radius: var(--radius-3);
          border: 2px solid var(--edge);
          font-family: 'Work Sans', sans-serif;
        }
        .comment-actions {
          display: flex;
          gap: 0.75rem;
          align-items: center;
          flex-wrap: wrap;
        }
        .file-btn {
          border: 2px dashed var(--edge);
          border-radius: var(--radius-3);
          padding: 0.5rem 0.9rem;
          cursor: pointer;
          display: inline-flex;
          align-items: center;
          gap: 0.5rem;
        }
        .file-btn input {
          display: none;
        }
        .comment-preview img {
          width: 100%;
          border-radius: var(--radius-3);
          border: 1px solid var(--edge);
        }
        .comment-list {
          display: flex;
          flex-direction: column;
          gap: var(--size-3);
        }
        .comment-item {
          border: 1px solid var(--edge);
          border-radius: var(--radius-3);
          padding: var(--size-2);
          background: #f8f9ff;
        }
        .comment-item header {
          display: flex;
          gap: 0.75rem;
          align-items: center;
          margin-bottom: 0.5rem;
        }
        .comment-item img.avatar {
          width: 36px;
          height: 36px;
          border-radius: 50%;
          object-fit: cover;
          border: 1px solid var(--edge);
        }
        .comment-item .timestamp {
          font-size: 0.75rem;
          color: var(--muted);
        }
        .comment-item .comment-image {
          margin-top: 0.75rem;
          border-radius: var(--radius-3);
          border: 1px solid var(--edge);
          width: 100%;
          height: auto;
        }
        .loading-copy {
          text-align: center;
          color: var(--muted);
          font-style: italic;
          padding: var(--size-5) 0;
        }
        .banner {
          margin-bottom: var(--size-3);
          padding: var(--size-3);
          border-radius: var(--radius-3);
          font-weight: 600;
        }
        .banner-error {
          background: #ffe5e5;
          color: #7f1d1d;
          border: 1px solid #fecaca;
        }
        .banner-info {
          background: #ecfdf5;
          color: #047857;
          border: 1px solid #bbf7d0;
        }
        .highlight-pulse {
          animation: highlightFlash 1.2s ease-in-out 1;
        }
        @keyframes highlightFlash {
          0% { box-shadow: 0 0 0 0 rgba(124, 92, 255, 0.45); }
          100% { box-shadow: 0 0 0 12px rgba(124, 92, 255, 0); }
        }
      `}</style>
    </>
  );
}

type CommentListProps = {
  state?: CommentState;
};

function CommentList({ state }: CommentListProps): JSX.Element {
  if (!state) {
    return <div className="loading-copy">Loading comments…</div>;
  }
  if (state.loading) {
    return <div className="loading-copy">Loading comments…</div>;
  }
  if (state.error) {
    return <div className="loading-copy">{state.error}</div>;
  }
  if (!state.items.length) {
    return <div className="loading-copy">Be the first to comment on this Beatloop drop.</div>;
  }
  return (
    <div className="comment-list">
      {state.items.map((comment) => (
        <article className="comment-item" key={comment.id}>
          <header>
            {comment.author?.avatarUrl ? (
              <img className="avatar" src={comment.author.avatarUrl} alt={comment.author.name} />
            ) : (
              <div className="avatar" style={{ width: 36, height: 36, borderRadius: '50%', background: '#dbeafe' }} />
            )}
            <div>
              <div>{comment.author?.name || 'Beatloop User'}</div>
              {comment.createdAt && <div className="timestamp">{formatDate(comment.createdAt)}</div>}
            </div>
          </header>
          <p>{comment.body || '—'}</p>
          {comment.imageUrl && (
            <img className="comment-image" src={comment.imageUrl} alt="Comment attachment" loading="lazy" />
          )}
        </article>
      ))}
    </div>
  );
}
