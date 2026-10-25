# Firewall and ports

Open these ports for incoming traffic.

| Port | Protocol | Needed for |
|---|---|---|
| 80 and 443 | TCP | HTTPS: Caddy in the [Compose setup](../install/compose.md), or your own reverse proxy. Port 80 is used for certificate issuance. |
| 443 | UDP | HTTP/3 in the Compose setup. Optional. |
| 8080 and 7880 | TCP | TolkTak and LiveKit directly, without HTTPS: a [`docker run`](../install/docker.md) server, or the installer's plain HTTP option |
| 7881 | TCP | Calls over TCP, for participants whose network blocks UDP |
| 7882 | UDP | Calls. This is the main path for voice, video and screen sharing. |

Example with `ufw` for the Compose setup:

```sh
sudo ufw allow 80/tcp
sudo ufw allow 443
sudo ufw allow 7881/tcp
sudo ufw allow 7882/udp
```

For `docker run` without HTTPS:

```sh
sudo ufw allow 8080/tcp
sudo ufw allow 7880:7881/tcp
sudo ufw allow 7882/udp
```

Also open the same ports in your hosting provider's firewall or security group, if it has one; that one is easy to forget.

Docker publishes container ports in its own firewall rules, before `ufw`. In the Compose setup, ports 80, 443, 7881 and 7882 are therefore reachable even if `ufw` does not allow them; the provider's firewall still applies.

## Changing the ports

- **TolkTak's HTTP port** with `docker run`: `-e TOLKTAK_LISTEN=:18480`. In the Compose setup it listens only on `127.0.0.1`; `TOLKTAK_PORT` in `.env` changes the port, which matters with your own reverse proxy.
- **LiveKit's ports** are fixed in the `docker run` image. In the Compose setup, `.env` changes them: `LIVEKIT_PORT` for the local signalling port, `LIVEKIT_TCP_PORT` and `LIVEKIT_UDP_PORT` for the call ports.

All calls share one UDP port; the number of participants does not change the ports to open.

## Behind NAT

If the server has a private address behind a router, forward every port above to it. LiveKit discovers the public address through STUN. If participants connect through the local network instead, give LiveKit the local address: `-e NODE_IP=192.168.1.20` with `docker run`; in the Compose setup, `LIVEKIT_USE_EXTERNAL_IP=false` and `LIVEKIT_NODE_IP=192.168.1.20` in `.env`.
