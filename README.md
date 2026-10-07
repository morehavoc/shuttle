# Shuttle

Record your screen and camera, get a link. A small Loom clone on Cloudflare: one Worker, an R2 bucket for video, a D1 database for metadata. No build step.

## What it does

- **Three modes:** screen + camera bubble, screen only, camera only. Mic and tab/system audio are mixed in.
- **Camera bubble** floats above every app (Document Picture-in-Picture in Chrome/Edge, video PiP in Safari), so a whole-screen recording captures it. The bubble carries the timer, pause, stop and delete. Share **Entire screen** to get the bubble in the video. If you share a single window or tab, the bubble isn't in it.
- **Instant link.** The video uploads in 5 MiB parts *while* you record. Stop copies the link and opens the share page a few seconds later.
- **Plays everywhere.** Chrome and Safari both record H.264/AAC MP4, so links play on iPhones.
- **Share page** at `/v/<id>`. It has link-preview tags (title and thumbnail in iMessage, Slack and LinkedIn), speed controls (1×–2×, remembered), download, and keyboard shortcuts (space/k, j/l, f). As the owner you can rename it in place and delete it. The view count ignores your own views.
- **Library:** thumbnails, durations, view counts, copy link and delete.
- **Failure handling:**
  - A dropped connection pauses the upload and resumes it.
  - A server refusal shows up while you're still recording.
  - **Download copy** saves the local recording whenever an upload fails.
  - A recording interrupted by a closed tab can be **recovered** from the parts that already uploaded.

Links are public by unguessable id (12 characters, about 70 bits). Everything else needs the owner password.

## Deploy

Deploys run only through GitHub Actions (`.github/workflows/deploy.yml`). The workflow creates the R2 bucket and the D1 database if they're missing, applies migrations, deploys, sets secrets and checks `/api/me`. Add three repo secrets:

| Secret | Value |
|---|---|
| `CLOUDFLARE_API_TOKEN` | Account token: Workers Scripts Edit, Workers R2 Storage Edit, D1 Edit |
| `CLOUDFLARE_ACCOUNT_ID` | Your account id |
| `OWNER_PASSWORD` | The password you sign in with |

Then push to `main`, or go to **Actions → Deploy → Run workflow**. Until the secrets exist, the workflow runs the tests and skips the deploy. `SESSION_SECRET` is generated on the first deploy. The app answers at `https://shuttle.<your-subdomain>.workers.dev`. To use a custom domain, add a `routes` entry to `wrangler.toml` (and give the token Zone Workers Routes Edit).

Free-tier fit: R2 gives 10 GB free, about 6 hours of 1080p screen recording at the default 3.5 Mbps. Egress is free.

## Develop

```sh
npm install
echo 'OWNER_PASSWORD=dev' > .dev.vars
npm run dev                      # migrations + wrangler dev on http://localhost:8787
```

Safari keeps `Secure` cookies only over HTTPS, so test Safari through `wrangler dev --local-protocol https`.

## Tests

- `npm test` runs the API contract (31 checks) against `wrangler dev` with local R2 and D1. It needs `test/out/sample.mp4`; see the workflow for the ffmpeg line.
- `node test/e2e.mjs` is the browser run: sign in, record, pause, stop, share page, play, seek, rename, thumbnail. Options are `ENGINE=chromium|webkit`, `MODE=screen-camera|screen|camera`, and `FAULT=flaky|fatal` for a dropped network or a refused upload. It needs Playwright (`PLAYWRIGHT_DIR`) and `BASE` pointing at a running dev server. WebKit gets synthetic camera and screen streams because Playwright can't grant camera permission on macOS.

## Layout

```
src/worker.js        API, auth, range-served video, thumbnails
src/share-page.js    server-rendered share page (Open Graph tags)
public/app.js        library, setup sheet, recording flow
public/recorder.js   capture, MediaRecorder, part uploader, thumbnail
public/bubble.js     floating camera bubble (PiP)
public/share.js      share-page player and owner controls
migrations/          D1 schema
```
