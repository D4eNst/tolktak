# Troubleshooting

Start with the logs: `docker logs --tail 100 tolktak` for a [`docker run`](../install/docker.md) server, `docker compose logs --tail 100 tolktak livekit` in the [Compose setup](../install/compose.md).

## The server does not start

The log names the problem: a missing `LIVEKIT_API_KEY` or `LIVEKIT_API_SECRET`, a secret shorter than 32 characters, an S3 bucket without keys or an unknown `TOLKTAK_REGISTRATION` value. In the Compose setup, `docker compose up` itself names a missing secret in `.env`. "address already in use" means another service has the port; pick another as described in [Firewall and ports](../guides/firewall.md#changing-the-ports).

`livekit-server exited` means the embedded LiveKit stopped, and the server stopped with it. The lines before it say why, most often a port that is already taken.

## The app cannot connect to the server

- Open the server address in a browser on the same device. If the page does not load, the problem is DNS, the firewall or the reverse proxy, not the app.
- Certificate errors: the app accepts only certificates the system trusts. A self-signed certificate must be installed as trusted on that device; see [HTTPS certificates](../guides/certificates.md).
- Without a certificate, type the address with the scheme and port: `http://203.0.113.10:8080`. Without a scheme, the app assumes `https://` for public addresses.

## Chat works, voice does not

This is almost always the media path. `https://<server>/api/v1/server` shows `livekit_url`, the address the apps use for LiveKit.

- **Connection to LiveKit fails right away.** `livekit_url` must be reachable from the user's device. Behind HTTPS it is `wss://<domain>`, and the reverse proxy must send `/rtc` to LiveKit. If it shows `ws://...:7880` behind a proxy, set `TOLKTAK_TRUST_PROXY=1` and make the proxy send `X-Forwarded-Proto`. Without a certificate, port 7880/TCP must be open.
- **Joins, but nobody hears anybody, or it drops after about 15 seconds.** Port 7882/UDP is blocked, or LiveKit gives the apps an address they cannot reach. Open the port in both the server's firewall and your provider's firewall; see [Firewall and ports](../guides/firewall.md). On a local network, set `NODE_IP` to the server's local address; in the Compose setup, set `LIVEKIT_USE_EXTERNAL_IP=false` and `LIVEKIT_NODE_IP` instead.
- **The domain is proxied by a CDN.** Media cannot go through it. Turn the proxy off for that name; see [Domains and addresses](../guides/domains.md).
- **Works for some users only.** Users on strict networks need port 7881/TCP. On hosts with several interfaces, limit `rtc.interfaces` in LiveKit's configuration; see [Configuration](configuration.md#livekit).
- **The room list shows people who already left.** The LiveKit webhook does not reach the server. Check `webhook.urls` in LiveKit's configuration; the server also corrects the list every 20 seconds.

## Uploads fail

"File is too large" with HTTP 413 comes either from the server (`TOLKTAK_MAX_UPLOAD_MB`) or from the reverse proxy (`client_max_body_size` in nginx). The proxy's limit must be higher than the server's.

With S3 storage, an upload that fails with a server error usually means the bucket is unreachable or the key cannot write to it; the server's log has the S3 error. See [S3 storage](../guides/s3.md).

## The app keeps reconnecting

The WebSocket is being closed by something between the app and the server. Check that the proxy passes WebSocket upgrades and that its read timeout is above 70 seconds; see [Reverse proxy](../guides/reverse-proxy.md).

## Reporting a bug

Open an [issue](https://github.com/D4eNst/tolktak/issues) with the server version (`/api/v1/server` shows it), the app version and system, and the relevant log lines. Remove addresses and names you do not want to publish. Security problems go through [SECURITY.md](../../SECURITY.md) instead.
