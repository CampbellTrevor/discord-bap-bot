# Turntable

A Discord music bot and web song request portal. Run them together, or keep the portal on Render and run an audio worker on a VM. Requests from the website and `/play` share a persistent queue for each Discord server.

[Open the portal](https://discord-bap-bot.onrender.com) · [Render service](https://dashboard.render.com/web/srv-dagu1tpt0dsc73fqe4ug). This service was created directly through the CLI; its settings are managed in Render's Dashboard. Its Discord OAuth redirect is `https://discord-bap-bot.onrender.com/auth/discord/callback`.

The current service uses a public-repository connection. Push changes to GitHub, then deploy the latest commit from Render's Dashboard or CLI. For automatic deployments, connect the repository through Render's GitHub integration or configure a service-specific deploy hook. See [Render deployment options](https://render.com/docs/deploys).

**Playback hosting:** YouTube currently rejects audio requests from our Render instance. A paid Render plan does not establish that playback will work. See [VM options, testing, and worker deployment](docs/vm-hosting.md). The portal now runs on Render and the audio worker runs on the RamNode LAX VM. Public YouTube audio and Spotify matching passed host probes; listening in Discord is the final playback check.

## What works

- Discord sign-in lasts up to 30 days with persistent storage; only members of a server can see or change its queue.
- Switch between **Cassette** (orange hardware, with light and dark modes) and **Winamp** (silver player and green display). The browser remembers both your theme and Cassette mode; switching never changes playback or signs you out.
- Request a **YouTube video or playlist**, **Spotify track or accessible playlist**, or **song title** from the website or `/play`.
- Website song searches show up to five results in YouTube and Spotify tabs. Choose **Add** on a result to queue that recording; searching alone never queues a song. Direct track and playlist links still import immediately. Spotify selections use YouTube for audio.
- Discord voice playback, now playing, live queue updates, pause/resume, skip, shuffle, move a waiting song to the top, stop, and remove your own requests.
- Server managers and the optional DJ role can control playback remotely. Other members control playback from the bot's voice channel.
- Pending songs and the interrupted song survive restarts with a persistent disk. `/join` reconnects and resumes the saved queue, restarting the interrupted song from the beginning.
- The bot disconnects after five minutes with nothing playing or queued.

**Spotify provides track information; the bot searches YouTube for playback.** Search favors studio recordings and filters identifiable live performances. Spotify matching checks title, artist, duration, and recording labels; if no suitable studio recording is found, it asks for a specific YouTube link. Explicit links and explicitly selected live versions are honored. Unlabeled performances can still slip through. Use the exact YouTube link when the recording matters. Albums, livestreams, private YouTube videos, and shortened Spotify redirect links are unsupported.

## Playlists and shuffle

Paste a YouTube playlist URL such as `https://www.youtube.com/playlist?list=PLAYLIST_ID`, or use it with `/play query:`. A video URL containing both `v=` and `list=` still requests that **one video**; use the playlist URL to import the list.

The default import inspects the first **50 playlist entries**, preserving their order. Invalid, unavailable, live, and overlong entries are skipped and reported. Entries whose duration YouTube omits are checked before playback. Notices explain import limits and skipped entries. `MAX_PLAYLIST_TRACKS` can be configured from 1 to 100; the queue must have room for the complete accepted batch or the request adds nothing. Spotify playlist access is described below.

Use **Shuffle** in either theme or `/shuffle` in Discord to randomize waiting songs. The current song keeps playing; shuffle requires at least two waiting songs and the same permissions as skip/pause. The up-arrow next to a waiting song moves it to the top with those same permissions.

## Try the portal locally

Install Node.js **22.12 or newer in the 22.x series**, then:

```sh
npm ci
npm run demo
```

Open **http://localhost:3000**. Demo mode includes clearly labeled sample tracks and working queue controls. It does not access Discord or play audio. It binds to localhost and is prohibited on Render and in production.

## Connect your Discord bot

1. Create an application in the [Discord Developer Portal](https://discord.com/developers/applications).
2. In **Bot**, create/reset its token. Put it in `DISCORD_TOKEN`. Do not paste secrets into chat or commit them.
3. In **OAuth2**, copy the application ID and client secret to `DISCORD_CLIENT_ID` and `DISCORD_CLIENT_SECRET`.
4. Add this exact OAuth redirect URL for local use: `http://localhost:3000/auth/discord/callback`. For Render, add `https://YOUR-SERVICE.onrender.com/auth/discord/callback`.
5. Install the bot into your Discord server with the scopes **bot** and **applications.commands**, and permissions **View Channels**, **Send Messages**, **Embed Links**, **Connect**, and **Speak**. The portal's invite link supplies these permissions. Administrator permission and privileged gateway intents are not needed.
6. Copy `.env.example` to `.env` and fill in the credentials. Optionally set `DISCORD_GUILD_ID` to restrict the bot to one server and register commands immediately there. Otherwise it registers global commands, which can take time to appear.
7. Install **FFmpeg** and **yt-dlp with its default dependencies** on your PATH. For Python: `python -m pip install "yt-dlp[default]"`. Node 22 runs yt-dlp's JavaScript support. Set `YT_DLP_PATH` if the executable is elsewhere.
8. Run `npm run doctor` to verify executables and voice dependencies without printing secrets. Then run `npm start`.

Join a regular voice channel, use `/play query: song name`, or open the portal, sign in, select your server/channel, and submit a request. Once connected, server members can request from the portal without being in voice. Moving a bot with an active queue requires a manager or DJ. Stage channels are not supported.

## Enable Spotify tracks and playlists

Create an app in the [Spotify Developer Dashboard](https://developer.spotify.com/dashboard) and add `SPOTIFY_CLIENT_ID` and `SPOTIFY_CLIENT_SECRET`. This uses client credentials for catalog metadata; listeners sign into Discord only.

Spotify currently requires a Premium subscription for the owner of a Development Mode app. API access and quotas vary by app/account; the portal reports provider failures. See [Spotify's development mode changes](https://developer.spotify.com/documentation/web-api/tutorials/february-2026-migration-guide) and [July 2026 quota update](https://developer.spotify.com/blog/2026-07-23-web-api-quota-updates). YouTube requests work without Spotify credentials or a YouTube API key.

Spotify's current [playlist-items endpoint](https://developer.spotify.com/documentation/web-api/reference/get-playlists-items) restricts contents to playlists owned by or shared for collaboration with the authorizing account. Public visibility alone does not guarantee API access. The bot attempts permitted public access with app credentials, and supports account authorization when needed:

1. In the Spotify app, register `http://127.0.0.1:8888/spotify/callback` as a redirect URI.
2. With both Spotify app credentials in local `.env`, run `npm run spotify:authorize`.
3. Open the printed authorization URL and approve playlist access. The helper uses one-time state and PKCE, then saves `SPOTIFY_REFRESH_TOKEN` into `.env` without printing it.
4. Add that refresh token to the Render service's environment alongside the same Spotify app credentials, then redeploy.

The authorization is shared by this bot: server members with a playlist link can request playlists accessible to that account, including private playlists it owns or collaborates on. Users still sign into the portal with Discord. Spotify API refusals are reported; the bot does not scrape around access restrictions. Rotated refresh tokens are saved in `DATA_DIR/.spotify-auth.json` and need persistent storage across deployments. Re-run authorization if Spotify revokes or expires access.

## Deploy on Render

1. Push this project to [CampbellTrevor/discord-bap-bot](https://github.com/CampbellTrevor/discord-bap-bot).
2. In Render, select **New → Blueprint** and connect that repository. Render reads `render.yaml`.
3. Review the **paid Starter web service and 1 GB disk** before creating it. This repository does not create or charge for a service itself.
4. Enter `DISCORD_TOKEN`, `DISCORD_CLIENT_ID`, and `DISCORD_CLIENT_SECRET` when prompted. Render generates `SESSION_SECRET` automatically.
5. Add optional Spotify credentials, `SPOTIFY_REFRESH_TOKEN`, and `DISCORD_GUILD_ID` / `DJ_ROLE_ID` under the service's Environment settings.
6. Add the actual Render URL plus `/auth/discord/callback` to your Discord application's OAuth2 redirects. `PUBLIC_URL` defaults to Render's own external URL; set it explicitly when using a custom domain.
7. Deploy. Check `/healthz` for `botReady: true`, sign in, and test `/play` in a real voice channel.

The Docker image includes Node, FFmpeg, yt-dlp/EJS, Opus, and Discord voice encryption support. Redeploy with a cleared build cache when you need a fresh yt-dlp release. The npm dependencies are pinned by `package-lock.json`.

Use **one instance**: queues persist in `/var/data/queues.json`, and encrypted web sessions persist in `/var/data/.portal-sessions.json`. Keep `SESSION_SECRET` stable so existing sign-ins remain readable. A worker restart disconnects voice while preserving requests for the next `/join`. A disk also means deployments briefly interrupt service. Scaling horizontally would require shared storage and an assigned voice worker per guild.

For a free Render portal with playback and storage on a separate VM, follow [Audio worker hosting](docs/vm-hosting.md). The portal stores encrypted session records on the worker's persistent disk through its authenticated connection. The session encryption key stays on Render; restarting either process preserves sign-ins, and logging out revokes the session. If the worker is temporarily unavailable, sign-in requests return a retryable error without clearing the browser cookie.

[Render free services sleep after 15 minutes without inbound traffic and do not offer persistent disks](https://render.com/docs/free), so the blueprint uses a paid service. Discord voice needs outbound UDP. Hosting networks and YouTube can reject media requests; live playback must be checked from the actual Render host. This app reports failures and advances the queue, and does not bypass provider sign-in requirements or restrictions.

If billing or Discord credentials are not ready, `render.preview.yaml` defines a free **locked setup page** with `SETUP_MODE=true`. Choose that file in Render's **Blueprint Path** field when creating a preview through a Blueprint. Both themes are available, while Discord sign-in and song requests stay disabled. This is not the local demo and contains no fake live queue.

To activate an existing preview, add all three Discord credentials, explicitly set `SETUP_MODE=false`, configure the exact Discord OAuth redirect, and redeploy. For durable playback, upgrade to Starter, attach the 1 GB disk at `/var/data`, and set `DATA_DIR=/var/data`. If a Blueprint manages the service, update its active YAML file with those settings or disconnect it before editing them in the Dashboard; a later Blueprint sync otherwise restores the preview configuration. Keep one Blueprint responsible for the service. A service created directly through the CLI or Dashboard has no Blueprint to update. A free service can run temporarily after setup, but it can sleep and loses queues/rotated tokens on restart.

## Commands

| Command | Action |
| --- | --- |
| `/play query:` | Queue a YouTube/Spotify track or playlist link, or search by name |
| `/queue` | Show current song and next ten requests |
| `/join` | Join your voice channel and continue saved requests |
| `/pause`, `/resume` | Pause or resume the current song |
| `/skip` | Skip the current song |
| `/shuffle` | Randomize the waiting queue while the current song continues |
| `/stop` | Stop and clear the queue, staying in voice briefly |
| `/leave` | Disconnect and preserve requests for later |
| `/portal` | Link to this server's web request portal |

## Configuration and verification

`.env.example` lists all options. Defaults: 2,000 total songs per server (including the current track), first 50 playlist entries per import, 60 minutes per track, five-minute idle disconnect. Request endpoints have rate limits; media extraction has bounded concurrency/timeouts. OAuth uses one-time state, server sessions, CSRF protection, and live Discord membership/permission checks.

```sh
npm run check
npm test
npm run doctor
```

The automated suite tests actual HTTP authentication/CSRF flows, provider parsing and errors with offline doubles, queue ordering, pause/skip cancellation, authorization, and disk restoration. It does not substitute for a real Discord voice and Render playback test. No account credentials are included.

Layout: `src/app.mjs` (HTTP/OAuth), `src/discord.mjs` (Discord/policies), `src/music.mjs` (queues), `src/media.mjs` (providers), `public/` (portal), `render.yaml` and `Dockerfile` (hosting).


## Preloading and playback host performance

The worker prepares the next two waiting songs during the final two minutes of the current track. Each prepared source has its playable resource and a buffer of up to 150 Opus packets (about three seconds at Discord's packet cadence); at least 25 packets are prepared before it is marked ready. Compatible Opus sources avoid FFmpeg conversion, and other formats are converted ahead of the transition. Playback reuses that resource without adding end padding. Silence in the recording and Discord transport timing can still produce an audible gap.

At most two speculative sources are held across all servers, with five-minute expiry. Playback has priority; queue changes discard stale sources, and a missing or failed preload falls back to a normal source open. Resuming after an expired preload allows a fresh preparation attempt. Validated Spotify-to-YouTube matches are cached for ten minutes, up to 200 entries, so canceled preparation does not repeat the same search. Audio URLs are extracted afresh. Matching recognizes translated titles and release credits while retaining artist, duration, and studio-version checks.

Server managers and DJs can expand **PLAYBACK HOST** below the queue in either theme. The worker samples every five seconds and retains 24 hours of minute aggregates in `DATA_DIR/.host-metrics.json`, saving at most once a minute. The panel refreshes every 15 seconds while open and shows five-minute history with peaks, CPU busy/steal/I/O wait, host RAM/swap, worker memory limits, CPU throttling, OOM counters, and disk space. It separately records foreground preparation, background preload successes/failures/cancellations/expiry, and natural-end-to-player-ready transition times. Timing includes failed queued songs before the next song starts; explicit skips are excluded. These measurements describe the bot's pipeline, not the audible gap at listeners. Existing history is preserved, with older source-only measurements identified. Recent samples from the final unsaved minute may be lost on restart.

Compare slow starts against CPU peaks, low available RAM, swap, throttling, or OOM events. Slow sources without corresponding resource pressure point toward provider/network delays, but these readings alone do not prove a cause. Container measurements include the bot, extractor, and FFmpeg children. No performance data contains request titles or user identities.
