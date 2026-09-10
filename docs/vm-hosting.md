# Audio worker hosting

## Initial hosting shortlist

The original sub-$5 shortlist was checked September 9, 2026 after Render returned `YOUTUBE_REQUEST_BLOCKED`. The deployed worker now runs on RamNode Premium; see its configuration below. Spotify supplies metadata and still depends on YouTube audio, so changing Spotify credentials does not resolve a YouTube host restriction.

| Candidate | Monthly price before tax/extras | Memory | Why consider it |
| --- | --- | --- | --- |
| [RamNode Lite 1GB with IPv4](https://ramnode.com/products/cloud-vps) | $2 VM + $2 IPv4 = **$4** | 1GB | Preferred test: more memory, OpenStack API and cloud-init |
| [Vultr regular cloud](https://api.vultr.com/v2/plans?type=vc2&per_page=500) | $3.50 | 512MB | API automation; current small plan lists EWR availability |
| [DigitalOcean Basic](https://www.digitalocean.com/pricing/droplets) | $4 | 512MiB | Straightforward API and hourly testing, but less memory |

RamNode includes 15GB NVMe and 500GB transfer with that Lite plan. Its [billing FAQ](https://ramnode.com/support/documentation/cloud-vps/billing-faq) describes card auto-pay and prepaid credit; prepaid has a $10 initial minimum. Checkout must confirm any initial charge, applicable tax, plan availability, and the IPv4 total. Do not enable backups, extra volumes, or other paid add-ons without accounting for the strict monthly budget. Monitor transfer usage.

Public YouTube audio and Spotify matching have passed probes on the assigned RamNode LAX IP. Datacenter addresses can still be blocked by YouTube later. Validate playback from the actual host before any future migration; a short probe does not establish uninterrupted access or listener audio quality.

## Account access

Create the account at [RamNode signup](https://cloudorder.ramnode.com/), then obtain access to its Cloud Control Panel. Billing/client-area credentials and Cloud Control Panel credentials are different. The [documented API setup](https://ramnode.com/support/documentation/cloud-vps/api-access) uses an Identity API v3 OpenStack RC file downloaded from the username menu. Prefer project-scoped application credentials if available; otherwise use the documented password authentication. Read the real endpoint, project, and region from the downloaded file rather than copying examples.

Keep cloud credentials in an ignored local file, never chat, Git, container images, or cloud-init user-data. Provisioning can then be automated through OpenStack and SSH. One VM is sufficient; the bot's worker makes an outbound connection to the portal, so it does not require a public web server or additional domain.

## Prepare and test the VM

Use Ubuntu 24.04 with at least 1GB RAM, an injected SSH public key, and [deploy/worker-cloud-init.yaml](../deploy/worker-cloud-init.yaml). It installs Docker/Compose, allocates 2GB swap, and prepares private directories. It does not start the bot. Apply a cloud firewall permitting SSH from the deployment machine, outbound HTTP/HTTPS, DNS and Discord UDP, and stateful return traffic. No inbound audio-worker port is needed.

After cloud-init finishes, copy or check out the reviewed repository commit on the VM. Build and probe **before transferring bot credentials or changing Render**:

```sh
sudo docker build -t bap-bot-worker:local .
sudo docker run --rm bap-bot-worker:local node scripts/probe-audio.mjs 'https://www.youtube.com/watch?v=VIDEO_ID'
```

Supply a real, ordinary public video. The probe uses the same media implementation, reads a small audio sample, and discards it. Image building checks FFmpeg, Opus, and Discord encryption dependencies. Neither substitutes for listening in Discord. Test several representative tracks and the reported failing song, then check memory/CPU under search, playlist import, and playback together. If YouTube refuses access, do not activate the worker.

## Activate after audio access passes

1. Preserve any existing queue and Spotify refresh-token rotation state **before replacing** the combined Render instance. `DATA_DIR/queues.json` and `.spotify-auth.json` hold that state. Free Render has no durable disk or SSH, so do not assume files can be recovered after redeploying. Reauthorize Spotify if necessary; do not silently discard requested songs.
2. Generate one random ASCII `WORKER_SECRET` of 32–256 characters, without spaces. Set Render `BOT_ROLE=portal` and that secret. Keep its Discord application ID, OAuth client secret, `SESSION_SECRET`, and existing HTTPS `PUBLIC_URL`. The portal does not need the Discord bot token or Spotify credentials in this role.
3. Deploy Render and wait until the old combined process has terminated. Do not run two copies of this Discord bot during migration.
4. Transfer a root-readable `/etc/bap-bot/worker.env` over SSH (mode 0600). Include `DISCORD_TOKEN`, `DISCORD_CLIENT_ID`, `WORKER_SECRET`, `WORKER_URL=https://discord-bap-bot.onrender.com`, and `PUBLIC_URL=https://discord-bap-bot.onrender.com`. Copy Spotify credentials/refresh token and any server/DJ restrictions. Never copy the local `PUBLIC_URL=http://localhost:3000` into production. The worker needs neither the OAuth client secret nor the portal session secret.
5. Restore preserved state into `/var/lib/bap-bot/data` with UID/GID 1000 and private permissions. Start the prepared service:

```sh
sudo docker compose -f deploy/worker.compose.yaml up -d --no-build
```

The Compose service sets the worker role, restarts after failure/reboot, limits memory and logs, and preserves data outside the container. Its filesystem is otherwise read-only and it publishes no ports. The configuration targets a 1GB VM; do not apply its memory limits unchanged to a 512MB host.

Verify portal health reports `botReady: true`. Sign in, join voice, and test YouTube audio, Spotify matching, search selection, playlist import, shuffle, and reconnect after a portal restart. Discord playback must continue while the portal is disconnected. Unconfirmed actions are not retried automatically: refresh the queue before retrying. A successful migration requires that actual voice test; it has not happened yet.

For updates, build a reviewed commit, recreate the worker with Compose, and check logs/health. Keep one previous image for rollback and back up the small data directory. The portal reconnects automatically; a worker restart preserves the queue but requires `/join` to resume voice.

## Persistent website sign-in

Authenticated sign-ins last up to 30 days in the same browser. The worker stores encrypted records and logout revocations in `/var/lib/bap-bot/data/.portal-sessions.json`. Keep this file with the other data backups and keep Render's `SESSION_SECRET` unchanged. The worker does not receive that secret or plaintext login records.

Deploy workers with session-storage support before updating the portal. A portal restart, sleep, or worker restart preserves sign-ins; temporary worker disconnections return a retryable storage error. Static pages and health checks remain available. Users need to sign in once after upgrading from the former in-memory store, or after clearing cookies or rotating `SESSION_SECRET`.


## Performance history

Open the portal's **PLAYBACK HOST** panel as a server manager or DJ to inspect the audio VM. The panel is served through the authenticated worker connection; it requires no additional inbound VM port. Keep `.host-metrics.json` with data backups to retain the last 24 hours of performance history across worker recreation. It contains aggregate counters and fixed error codes, with no song titles or user IDs.

The current LAX host is **2 GB Premium: two shared vCPUs and an 80 GB disk**, upgraded with the owner's approval at a quoted **$14/month including the existing IPv4 address**. The worker's Compose limit remains 768 MiB RAM and 1,536 MiB including swap. Observe actual listening, searches, and preloading through the playback-host panel. Host CPU steal measures time denied by the hypervisor; container throttling measures quota pressure. The panel separates source/packet preparation, background preload failures, and natural-end-to-player-ready transitions. These timings do not measure audible gaps at listeners.

Set `MAX_QUEUE_SIZE=2000` and `MAX_TRACK_DURATION_SEC=3600` in the private worker environment. The current track counts toward queue capacity; playlist imports remain capped separately at 50 entries by default. A worker restart preserves songs and sign-ins but requires `/join` to resume voice.
