# Firewall and ports

Open these ports for incoming traffic. The numbers are defaults; `init.sh` prints the ones it configured.

| Port | Protocol | Needed for |
|---|---|---|
| 443 | TCP | HTTPS on the reverse proxy (HTTPS layout). Port 80 too, if your certificate client uses HTTP-01. |
| 8080 and 7880 | TCP | TolkTak and LiveKit directly (layout without a certificate) |
| 7881 | TCP | Media over TCP, for clients whose network blocks UDP |
| 50000–60000 | UDP | Media. This is the main path for voice and video. |
| 3478 | UDP | TURN, for clients behind strict NAT |
| 30000–40000 | UDP | TURN relay |

Example with `ufw`:

```sh
sudo ufw allow 443/tcp
sudo ufw allow 7881/tcp
sudo ufw allow 50000:60000/udp
sudo ufw allow 3478/udp
sudo ufw allow 30000:40000/udp
```

Also open the same ports in your hosting provider's firewall or security group, if it has one; that one is easy to forget.

## Changing the ports

Pass different numbers to `init.sh` in the environment, for example on a shared server:

```sh
TOLKTAK_PORT=18480 LIVEKIT_PORT=17880 RTC_UDP_START=55000 RTC_UDP_END=55499 \
TURN_RELAY_START=55500 TURN_RELAY_END=55999 ./init.sh talk.example.com lk.example.com
```

`init.sh` writes them to both `.env` and `livekit.yaml`. To change them later, move `.env` and `livekit.yaml` aside and run `init.sh` again; it generates a new LiveKit key, so restart the whole stack afterwards.

A UDP range of about 500 ports serves a few hundred simultaneous streams. Smaller ranges work for small groups.

## Behind NAT

If the server has a private address behind a router, forward every port above to it, and make sure LiveKit learns the public address: `use_external_ip: true` in `livekit.yaml` (the default) discovers it through STUN. On hosts with Docker networks or a VPN, also uncomment `rtc.interfaces` in `livekit.yaml` so LiveKit offers only the public interface.
