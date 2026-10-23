#!/bin/sh
# Writes .env and livekit.yaml with fresh secrets. Ports can be overridden in the environment.
#   ./init.sh talk.example.com lk.example.com   HTTPS through a reverse proxy
#   ./init.sh --http 203.0.113.10               plain HTTP, one address
set -eu
cd "$(dirname "$0")"
usage() { sed -n '4,5p' "$0" | sed 's/^# *//'; exit 1; }
[ -e .env ] && { echo ".env already exists; move it away to start over"; exit 1; }
case "${1:-}" in
  --http) [ $# -eq 2 ] || usage ;;
  -*|'') usage ;;
  *) [ $# -eq 2 ] || usage ;;
esac

PORTS="TOLKTAK_PORT LIVEKIT_PORT RTC_TCP_PORT RTC_UDP_START RTC_UDP_END TURN_UDP_PORT TURN_RELAY_START TURN_RELAY_END"
set_env() { sed -i "s|^$1=.*|$1=$2|" .env; }
get_env() { sed -n "s/^$1=//p" .env; }

cp .env.example .env
chmod 600 .env
for v in $PORTS; do
  eval "val=\${$v:-}"
  [ -n "$val" ] && set_env "$v" "$val"
done
for v in $PORTS; do eval "$v=$(get_env "$v")"; done

if [ "$1" = "--http" ]; then
  HOST=$2
  LK_HOST=$2
  URL="http://$HOST:$TOLKTAK_PORT"
  set_env LIVEKIT_PUBLIC_URL "ws://$HOST:$LIVEKIT_PORT"
  set_env TOLKTAK_BIND 0.0.0.0
  set_env LIVEKIT_BIND 0.0.0.0
  set_env TOLKTAK_TRUST_PROXY 0
  OPEN="TCP $TOLKTAK_PORT, $LIVEKIT_PORT,"
else
  HOST=$1
  LK_HOST=$2
  URL="https://$HOST"
  set_env LIVEKIT_PUBLIC_URL "wss://$LK_HOST"
  OPEN="TCP 443 (your reverse proxy),"
fi

rand() { head -c "$1" /dev/urandom | od -An -tx1 | tr -d ' \n'; }
KEY="tk$(rand 6)"
SECRET="$(rand 32)"
set_env LIVEKIT_API_KEY "$KEY"
set_env LIVEKIT_API_SECRET "$SECRET"
LIVEKIT_BIND=$(get_env LIVEKIT_BIND)

sed -e "s|\${LIVEKIT_DOMAIN}|$LK_HOST|" -e "s|\${LIVEKIT_BIND}|$LIVEKIT_BIND|" \
    -e "s|\${LIVEKIT_API_KEY}|$KEY|g" -e "s|\${LIVEKIT_API_SECRET}|$SECRET|" \
    -e "s|\${TOLKTAK_PORT}|$TOLKTAK_PORT|" -e "s|\${LIVEKIT_PORT}|$LIVEKIT_PORT|" -e "s|\${RTC_TCP_PORT}|$RTC_TCP_PORT|g" \
    -e "s|\${RTC_UDP_START}|$RTC_UDP_START|g" -e "s|\${RTC_UDP_END}|$RTC_UDP_END|g" -e "s|\${TURN_UDP_PORT}|$TURN_UDP_PORT|g" \
    -e "s|\${TURN_RELAY_START}|$TURN_RELAY_START|g" -e "s|\${TURN_RELAY_END}|$TURN_RELAY_END|g" livekit.yaml.template > livekit.yaml
chmod 600 livekit.yaml

echo "Wrote .env and livekit.yaml."
echo "Open in the firewall: $OPEN TCP $RTC_TCP_PORT, UDP $RTC_UDP_START-$RTC_UDP_END, UDP $TURN_UDP_PORT, UDP $TURN_RELAY_START-$TURN_RELAY_END."
echo "Start: docker compose up -d. Then open $URL and register: the first account becomes the administrator."
