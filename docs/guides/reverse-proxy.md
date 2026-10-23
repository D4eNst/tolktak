# Reverse proxy

In the HTTPS setup, the proxy accepts requests on port 443 and forwards them to local services. It holds the certificates; TolkTak and LiveKit listen on `127.0.0.1`.

| Host name | Local address |
|---|---|
| `talk.example.com` | `http://127.0.0.1:8080` |
| `lk.example.com` | `http://127.0.0.1:7880` |

This example uses the default ports. If the ports change in the project configuration, update the proxy addresses too. Media streams reach LiveKit through [separate ports](firewall.md).

## nginx

[Download the example configuration](https://tolktak.d4enst.ru/docs/nginx.conf.example)

The same file is in the repository at `deploy/nginx.conf.example`. It configures both host names, WebSocket forwarding and the upload limit.

1. Add the example to the nginx configuration, for example `/etc/nginx/conf.d/tolktak.conf`.
2. Replace the domains, local ports and [certificate](certificates.md) paths.
3. Check and apply the configuration:

```sh
sudo nginx -t && sudo systemctl reload nginx
```

The `systemctl` command applies to a system using systemd. The example uses [`http2 on`](https://nginx.org/en/docs/http/ngx_http_v2_module.html#http2) from nginx 1.25.1 and later; this line can be removed on earlier versions.

## Main parameters

| Parameter | Purpose |
|---|---|
| `Upgrade`, `Connection` | WebSocket forwarding for chat events and call connections. |
| `client_max_body_size` | Request body limit. The example sets `60m` for a TolkTak file limit of 50 MB. |
| `proxy_read_timeout` | Time to wait for service data: 120 seconds for TolkTak and 3600 for LiveKit in the example. |
| `X-Forwarded-For` | Participant address for request rate limiting. |

When changing `TOLKTAK_MAX_UPLOAD_MB`, keep the nginx limit higher to allow for request overhead. Requests over the limit return HTTP 413. See [nginx's documentation](https://nginx.org/en/docs/http/websocket.html) for WebSocket forwarding.

Use `TOLKTAK_TRUST_PROXY=1` when TolkTak can only be reached through a trusted proxy.

## Check the setup

```sh
curl https://talk.example.com/healthz
```

Use your own domain. An `ok` response confirms that TolkTak is reachable through HTTPS. Test a call and screen sharing separately with two accounts, preferably on different networks.

Other proxies need the same service addresses, WebSocket support and an appropriate upload limit. For connection problems, see [Troubleshooting](../operations/troubleshooting.md).
