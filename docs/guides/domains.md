# Domains and addresses

## With HTTPS: one domain name

Participants reach TolkTak and LiveKit through the same name. The reverse proxy sends the path `/rtc` to LiveKit and everything else to TolkTak.

| Name | Record type | Value |
|---|---|---|
| `chat.example.com` | A | `203.0.113.10` |

The name and IP above are examples. Use your own domain and the server's public address. Only add an AAAA record when IPv6 is configured; otherwise some devices may try an address that cannot be reached.

## Check DNS

```sh
dig +short chat.example.com A
```

For a record without proxying, the command returns the server's public IP. DNS changes may take time to appear. In the [Compose setup](../install/compose.md), set the same name as `TOLKTAK_DOMAIN` in `.env`; Caddy obtains the certificate once the name resolves to the server.

## DNS provider proxying

This guide assumes direct connections to the server. With a provider that offers a CDN proxy, use **DNS only** for the name. In this mode, DNS returns the server's own address; see [Cloudflare's documentation](https://developers.cloudflare.com/dns/proxy-status/).

Calls go to ports 7881/TCP and 7882/UDP of the server directly. An ordinary HTTP proxy does not forward this traffic.

## Without a certificate: one address

A [server started with `docker run`](../install/docker.md) serves plain HTTP on its own address:

- `http://192.168.1.20:8080` — TolkTak;
- `ws://192.168.1.20:7880` — LiveKit. The server gives this address to the apps itself, from the address they connected to.

Replace `192.168.1.20` with your machine's address. HTTP sends passwords, messages and files without encryption. For internet access, continue with [HTTPS certificates](certificates.md).
