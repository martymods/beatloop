# beatloop

Beatloop delivers a no-cost music creation toolkit with a 16-step sampler, AI-powered helpers and a community feed.

## Embedding Beatloop Studio

You can embed the full "Beatloop Studio — 16-Step Sampler" experience inside an `<iframe>` on your own site. Use the `embed=studio` query string when linking to the creator network page:

```html
<iframe
  src="https://your-domain.com/network.html?embed=studio"
  width="100%"
  height="820"
  style="border:0;" allow="autoplay"
  title="Beatloop Studio — 16-Step Sampler">
</iframe>
```

The sampler loads immediately in embed mode with the close button, site navigation and feed removed, while preserving all sound kits, loops, AI tooling, piano roll and export functions.

### Tips

- Adjust the `height` attribute if you need more (or less) vertical space.
- The embed supports query fragments such as `#studio-embed`, `studio=1`, or `studio=embed` for backward compatibility.
- Autoplay still requires a user gesture in most browsers; the "Play" button remains accessible within the embed.

## Local development

Serve the static files with any HTTP server, for example:

```bash
npx serve .
```

Then open `http://localhost:3000/network.html?embed=studio` to preview the iframe-ready experience locally.

## Production deployment

Beatloop requires an S3-compatible bucket for avatar, track and message uploads when running in production (including Render).
Configure the following environment variables so the server can initialize durable storage:

- `S3_BUCKET` – name of the bucket that will hold uploaded assets.
- `S3_REGION` – AWS/compatible region where the bucket lives.
- `S3_PUBLIC_BASE_URL` – the HTTPS base URL (or CDN) that serves the bucket contents.
- `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY` (or `S3_ACCESS_KEY_ID` / `S3_SECRET_ACCESS_KEY`) – credentials with write access to the bucket.
- Optional: `AWS_SESSION_TOKEN` for temporary credentials.
- Optional: `S3_ENDPOINT` and `S3_FORCE_PATH_STYLE` for non-AWS providers.

Without these variables, the API will terminate on startup in production and upload routes will respond with `503` errors.
