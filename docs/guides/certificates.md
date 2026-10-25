# HTTPS certificates

HTTPS protects passwords, messages and files in transit between a device and the server. Certificates are installed on the reverse proxy in front of TolkTak.

## Caddy in the Compose setup

The [Compose setup](../install/compose.md) includes Caddy, which obtains a free certificate from [Let's Encrypt](https://letsencrypt.org/) for `TOLKTAK_DOMAIN` and renews it [automatically](https://caddyserver.com/docs/automatic-https). It needs:

- the domain's DNS record pointing to the server;
- ports 80/TCP and 443/TCP reachable from the internet.

The certificates are kept in the `caddy-data` volume. If issuance fails, `docker compose logs caddy` shows why; the usual causes are a DNS record that does not point to the server yet and a closed port 80.

## Your own reverse proxy

An internet server needs a trusted certificate for its [domain name](domains.md).

- **nginx:** obtain and renew certificates through an ACME client such as Certbot. [Let's Encrypt](https://letsencrypt.org/getting-started/) issues free certificates.
- **Caddy** that you run yourself: certificates are automatic for domains in its configuration.

When configuring an ACME client, domain validation methods include:

| Method | Requirements |
|---|---|
| HTTP-01 | The domain points to the server; port 80/TCP is reachable from the internet. |
| DNS-01 | A TXT record in DNS. Works with port 80 closed and supports wildcard certificates. |

See [Let's Encrypt's documentation](https://letsencrypt.org/docs/challenge-types/) for details. Renewal should be automatic; nginx needs to reload its configuration after a certificate is replaced.

## Self-signed certificate

A closed network can use a certificate from a private certificate authority. This requires trust to be configured separately on every participant's device.

The certificate must list the server name or IP in the Subject Alternative Name field. The app does not disable certificate checks: an untrusted chain, a name mismatch or an expired certificate prevents connection.

## No certificate

A [server started with `docker run`](../install/docker.md) works over plain HTTP, which is fine for a local network. Passwords, messages and files are then sent unencrypted. Voice and video between the app and LiveKit are always protected by DTLS-SRTP; TolkTak does not implement end-to-end encryption yet.

Continue with [Reverse proxy](reverse-proxy.md) for HTTPS routing.
