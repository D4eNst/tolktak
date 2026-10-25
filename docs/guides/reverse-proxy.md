# Reverse proxy

In the HTTPS setup, the proxy accepts requests on port 443 and forwards them to local services. It holds the certificates; TolkTak and LiveKit listen on `127.0.0.1`. The [Compose setup](../install/compose.md) includes Caddy configured this way; this page is for your own proxy.

| Path on `chat.example.com` | Local address |
|---|---|
| `/rtc` and everything under it | `http://127.0.0.1:7880` (LiveKit) |
| everything else | `http://127.0.0.1:8080` (TolkTak) |

These are the default ports. Calls themselves reach LiveKit through [separate ports](firewall.md), not through the proxy. Do not forward LiveKit's other paths, such as `/twirp`: that is its server API.

The server must know it is behind a proxy: set `TOLKTAK_TRUST_PROXY=1`. Then it gives the apps `wss://chat.example.com` as LiveKit's address, and rate limits use the participant's address from `X-Forwarded-For`. In the Compose setup it is already set.

## nginx

[Download the example configuration](https://tolktak.d4enst.ru/docs/nginx.conf.example)

The same file is in the repository at `deploy/nginx.conf.example`. It configures both paths, WebSocket forwarding and the body limits, and closes the webhook.

1. Add the example to the nginx configuration, for example `/etc/nginx/conf.d/tolktak.conf`.
2. Replace the domain, local ports and [certificate](certificates.md) paths.
3. Check and apply the configuration:

```sh
sudo nginx -t && sudo systemctl reload nginx
```

The `systemctl` command applies to a system using systemd. The example uses [`http2 on`](https://nginx.org/en/docs/http/ngx_http_v2_module.html#http2) from nginx 1.25.1 and later; this line can be removed on earlier versions.

## Main parameters

| Parameter | Purpose |
|---|---|
| `Upgrade`, `Connection` | WebSocket forwarding for chat events and call connections. |
| `client_max_body_size` | Request body limit: `60m` for uploads to `/api/v1/files` with a TolkTak file limit of 50 MB, `1m` for everything else. |
| `proxy_read_timeout` | Time to wait for service data: 120 seconds for TolkTak and 3600 for LiveKit in the example. |
| `X-Forwarded-For` | The participant's address, for rate limits. TolkTak reads the last address in the header, so the proxy must set it or append to it. The example sets it to the address nginx sees. |
| `X-Forwarded-Proto` | `https`, so the server gives the apps a `wss://` address for LiveKit. |
| `Strict-Transport-Security` | Tells browsers to open the domain over HTTPS only. |
| `/api/v1/livekit/webhook` | Closed from outside: LiveKit calls it on the local address. Remove this block when LiveKit runs elsewhere, such as LiveKit Cloud. |

When changing `TOLKTAK_MAX_UPLOAD_MB`, keep the nginx limit higher to allow for request overhead. Requests over the limit return HTTP 413. See [nginx's documentation](https://nginx.org/en/docs/http/websocket.html) for WebSocket forwarding.

## Caddy

```
chat.example.com {
    header Strict-Transport-Security max-age=31536000
    reverse_proxy /rtc* 127.0.0.1:7880
    reverse_proxy 127.0.0.1:8080
}
```

Caddy obtains the certificate itself and passes WebSocket and `X-Forwarded-*` headers without further settings.

## Check the setup

```sh
curl https://chat.example.com/healthz
curl https://chat.example.com/api/v1/server
```

Use your own domain. `ok` from the first command confirms that TolkTak is reachable through HTTPS. In the second, `livekit_url` must be `wss://chat.example.com`; `ws://...:7880` means the server does not see the proxy's headers. Test a call and screen sharing separately with two accounts, preferably on different networks.

Other proxies need the same routes, WebSocket support and an appropriate upload limit. For connection problems, see [Troubleshooting](../operations/troubleshooting.md).
