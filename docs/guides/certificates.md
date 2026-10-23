# HTTPS certificates

HTTPS protects passwords, messages and files in transit between a device and the server. In the TolkTak setup, certificates are installed on the reverse proxy.

## Trusted certificate

An internet server needs a trusted certificate for each of the [two host names](domains.md). One certificate can also cover both names.

- **nginx:** obtain and renew certificates through an ACME client such as Certbot. [Let's Encrypt](https://letsencrypt.org/getting-started/) issues free certificates.
- **Caddy:** [automatic issuance and renewal](https://caddyserver.com/docs/automatic-https) for domains in its configuration.

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

HTTP mode is available for local networks:

```sh
./init.sh --http 192.168.1.20
```

Use your machine's address here. Passwords, messages and files are sent over unencrypted HTTP. Voice and video between the app and LiveKit are protected by DTLS-SRTP; TolkTak does not implement end-to-end encryption yet.

Continue with [Reverse proxy](reverse-proxy.md) for HTTPS routing.
