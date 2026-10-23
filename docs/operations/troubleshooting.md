# Troubleshooting

Start with the logs: `docker compose logs --tail 100 tolktak livekit`.

## The server does not start

The log names the problem: a missing `LIVEKIT_API_KEY` or `LIVEKIT_API_SECRET`, a secret shorter than 32 characters, a missing `LIVEKIT_PUBLIC_URL` or an unknown `TOLKTAK_REGISTRATION` value. "address already in use" means another service has the port; pick another as described in [Firewall and ports](../guides/firewall.md#changing-the-ports).

## The app cannot connect to the server

- Open the server address in a browser on the same device. If the page does not load, the problem is DNS, the firewall or the reverse proxy, not the app.
- Certificate errors: the app accepts only certificates the system trusts. A self-signed certificate must be installed as trusted on that device; see [HTTPS certificates](../guides/certificates.md).
- Without a certificate, type the address with the scheme and port: `http://203.0.113.10:8080`. Without a scheme, the app assumes `https://` for public addresses.

## Chat works, voice does not

This is almost always the media path.

- **Connection to LiveKit fails right away.** Check `LIVEKIT_PUBLIC_URL`: it must be reachable from the user's device, with `wss://` behind HTTPS and `ws://` without a certificate. Open `https://lk.example.com` in a browser; LiveKit answers "OK".
- **Joins, but nobody hears anybody, or it drops after about 15 seconds.** UDP ports are blocked. Open them in both the server's firewall and your provider's firewall; see [Firewall and ports](../guides/firewall.md).
- **The LiveKit name is proxied by a CDN.** Media cannot go through it. Turn the proxy off for that name; see [Domains and addresses](../guides/domains.md).
- **Works for some users only.** Users on strict networks need port 7881/TCP or TURN (3478/UDP and the relay range). On hosts with several interfaces, set `rtc.interfaces` in `livekit.yaml`.
- **The room list shows people who already left.** The LiveKit webhook does not reach the server. Check `webhook.urls` in `livekit.yaml`; the server also corrects the list every 20 seconds.

## Uploads fail

"File is too large" with HTTP 413 comes either from the server (`TOLKTAK_MAX_UPLOAD_MB`) or from the reverse proxy (`client_max_body_size` in nginx). The proxy's limit must be higher than the server's.

## The app keeps reconnecting

The WebSocket is being closed by something between the app and the server. Check that the proxy passes WebSocket upgrades and that its read timeout is above 70 seconds; see [Reverse proxy](../guides/reverse-proxy.md).

## Reporting a bug

Open an [issue](https://github.com/D4eNst/tolktak/issues) with the server version (`/api/v1/server` shows it), the app version and system, and the relevant log lines. Remove addresses and names you do not want to publish. Security problems go through [SECURITY.md](../../SECURITY.md) instead.
