# Domains and addresses

## With HTTPS: two host names

In the standard setup, TolkTak and LiveKit run on the same machine with separate host names. The reverse proxy routes requests to the appropriate service.

| Name | Record type | Value |
|---|---|---|
| `talk.example.com` | A | `203.0.113.10` |
| `lk.example.com` | A | `203.0.113.10` |

The names and IP above are examples. Use your own domains and the server's public address. Only add an AAAA record when IPv6 is configured; otherwise some devices may try an address that cannot be reached.

## Check DNS

```sh
dig +short talk.example.com A
dig +short lk.example.com A
```

For records without proxying, both commands should return the server's public IP. DNS changes may take time to appear.

Pass the same names to the setup script: TolkTak first, then LiveKit.

```sh
./init.sh talk.example.com lk.example.com
```

## DNS provider proxying

This guide assumes direct connections to the server. With a provider that offers a CDN proxy, use **DNS only** for both names. In this mode, DNS returns the server's own address; see [Cloudflare's documentation](https://developers.cloudflare.com/dns/proxy-status/).

LiveKit media ports and TURN must be reachable directly. An ordinary HTTP proxy does not forward UDP traffic.

## Without a certificate: one address

A local network setup can use one address with separate ports:

- `http://192.168.1.20:8080` — TolkTak;
- `ws://192.168.1.20:7880` — LiveKit.

Generate the configuration for this example with:

```sh
./init.sh --http 192.168.1.20
```

Replace `192.168.1.20` with your machine's address. HTTP sends passwords, messages and files without encryption. For internet access, continue with [HTTPS certificates](certificates.md), then the [reverse proxy](reverse-proxy.md).
