#!/bin/sh
# Sets up TolkTak with Docker Compose in the current directory: downloads compose.yaml,
# asks a few questions and writes .env. See docs/install/compose.md.
set -eu
umask 077

RELEASE=https://github.com/D4eNst/tolktak/releases/latest/download

# Questions run in subshells, so die stops the whole script through the TERM trap.
die() { printf '\nError: %s\n' "$*" >&2; kill -TERM $$; exit 1; }
say() { printf '%s\n' "$@" >&2; }
trap 'stty echo 2>/dev/null || true; rm -f .env.new .env.tmp compose.yaml.tmp example.env.tmp' EXIT
trap 'exit 1' INT TERM

ask() {
  while :; do
    printf '%s [%s]: ' "$1" "$2" >&2
    read -r answer || [ -n "$answer" ] || die "No answer: run this script in a terminal."
    case $answer in
      *"'"*) say "Single quotes are not supported." ;;
      *) printf '%s' "${answer:-$2}"; return ;;
    esac
  done
}

yes() {
  case $(ask "$1 (y/n)" "$2") in [yY]*) return 0 ;; *) return 1 ;; esac
}

ask_secret() {
  while :; do
    printf '%s: ' "$1" >&2
    stty -echo 2>/dev/null || true
    read -r answer || [ -n "$answer" ] || die "No answer: run this script in a terminal."
    stty echo 2>/dev/null || true
    printf '\n' >&2
    case $answer in
      *"'"*) say "Single quotes are not supported." ;;
      *) printf '%s' "$answer"; return ;;
    esac
  done
}

# Prints the number of the chosen option; the first one is the default.
choose() {
  question=$1
  shift
  while :; do
    say "" "$question"
    i=1
    for option; do
      say "  $i) $option"
      i=$((i + 1))
    done
    n=$(ask "Choose" 1)
    case $n in
      *[!0-9]* | '') ;;
      *) [ "$n" -ge 1 ] && [ "$n" -lt "$i" ] && { printf '%s' "$n"; return; } ;;
    esac
    say "Enter a number from 1 to $((i - 1))."
  done
}

# Sets KEY in .env.new, replacing a "KEY=" or "# KEY=" line, or appends it. Single quotes keep
# Compose from expanding $ in the value.
set_env() {
  V=$2
  case $V in *[!A-Za-z0-9._:/@+,=-]*) V="'$V'" ;; esac
  K=$1 V=$V awk '
    !done && ($0 ~ "^" ENVIRON["K"] "=" || $0 ~ "^# " ENVIRON["K"] "=") { print ENVIRON["K"] "=" ENVIRON["V"]; done = 1; next }
    { print }
    END { if (!done) print ENVIRON["K"] "=" ENVIRON["V"] }
  ' .env.new > .env.tmp
  cat .env.tmp > .env.new && rm .env.tmp
}

secret() { openssl rand -hex 32; }

command -v docker >/dev/null 2>&1 || die "Docker is not installed. Install Docker Engine (https://docs.docker.com/engine/install/) and run this script again."
docker compose version >/dev/null 2>&1 || die "The Docker Compose plugin is not installed. Install it (https://docs.docker.com/compose/install/linux/) and run this script again."
compose=$(docker compose version --short | sed 's/^v//')
echo "$compose" | awk -F'[.-]' '{ exit !($1 > 2 || ($1 == 2 && ($2 > 23 || ($2 == 23 && $3 >= 1)))) }' ||
  die "Docker Compose $compose is too old: TolkTak needs 2.23.1 or later. Update the Compose plugin and run this script again."
docker info >/dev/null 2>&1 || die "Cannot reach the Docker daemon. Start Docker, or run this script as a user who may use Docker (for example with sudo)."
command -v openssl >/dev/null 2>&1 || die "openssl is not installed. Install it (for example: sudo apt install openssl) and run this script again."
[ -e .env ] && die "$(pwd)/.env already exists. Edit it directly, or move it away to start over."

for f in compose.yaml example.env; do
  [ -f "$f" ] || { curl -fsSL -o "$f.tmp" "$RELEASE/$f" && mv "$f.tmp" "$f"; } || die "Could not download $RELEASE/$f"
done
cp example.env .env.new

say "TolkTak setup. Press Enter to accept the value in brackets."
profiles=livekit
todo=

case $(choose "How will people reach the server?" \
  "Domain name, HTTPS certificate obtained automatically (Caddy)" \
  "Domain name, behind a reverse proxy I already run" \
  "IP address over plain HTTP, no certificate (local network or testing)") in
  1)
    domain=$(ask "Domain name, for example chat.example.com" "")
    while [ -z "$domain" ]; do domain=$(ask "Domain name" ""); done
    set_env TOLKTAK_DOMAIN "$domain"
    profiles=$profiles,caddy
    url=https://$domain
    ports="80/tcp, 443/tcp, 443/udp, 7881/tcp, 7882/udp"
    ;;
  2)
    domain=$(ask "Domain name, for example chat.example.com" "")
    while [ -z "$domain" ]; do domain=$(ask "Domain name" ""); done
    set_env TOLKTAK_DOMAIN "$domain"
    url=https://$domain
    ports="7881/tcp and 7882/udp, plus your proxy's 443/tcp"
    proxy="In your proxy, send $url to 127.0.0.1:8080 and its /rtc path to 127.0.0.1:7880: https://github.com/D4eNst/tolktak/blob/main/docs/guides/reverse-proxy.md"
    ;;
  3)
    guess=$(ip -4 route get 1.1.1.1 2>/dev/null | awk '{ for (i = 1; i < NF; i++) if ($i == "src") print $(i + 1) }')
    ip=$(ask "Address participants use to reach this server" "$guess")
    while [ -z "$ip" ]; do ip=$(ask "Address" ""); done
    # Caddy is not started, but compose.yaml requires a value.
    set_env TOLKTAK_DOMAIN "$ip"
    set_env TOLKTAK_BIND 0.0.0.0
    set_env LIVEKIT_BIND 0.0.0.0
    set_env TOLKTAK_TRUST_PROXY 0
    set_env LIVEKIT_USE_EXTERNAL_IP false
    set_env LIVEKIT_NODE_IP "$ip"
    url=http://$ip:8080
    ports="8080/tcp, 7880/tcp, 7881/tcp, 7882/udp"
    ;;
esac

case $(choose "Database:" "PostgreSQL in this setup" "My own PostgreSQL server" "SQLite file, no database server") in
  1)
    profiles=$profiles,postgres
    ;;
  2)
    db=$(ask "Database URL, postgres://user:password@host:5432/dbname (empty to fill in .env later)" "")
    if [ -n "$db" ]; then set_env TOLKTAK_DATABASE_URL "$db"; else todo="$todo TOLKTAK_DATABASE_URL"; fi
    ;;
  3)
    set_env TOLKTAK_DATABASE_URL sqlite:///data/tolktak.db
    ;;
esac

case $(choose "Uploaded files:" "S3 storage in this setup (Garage)" "My own S3 bucket (AWS S3, Cloudflare R2, Backblaze B2 and others)" "Server disk") in
  1)
    profiles=$profiles,garage
    ;;
  2)
    if yes "Enter the bucket details now? Otherwise fill them in .env later" y; then
      set_env TOLKTAK_S3_BUCKET "$(ask "Bucket" tolktak)"
      set_env TOLKTAK_S3_ENDPOINT "$(ask "Endpoint URL, empty for AWS S3" "")"
      set_env TOLKTAK_S3_REGION "$(ask "Region" us-east-1)"
      set_env TOLKTAK_S3_ACCESS_KEY "$(ask "Access key ID" "")"
      set_env TOLKTAK_S3_SECRET_KEY "$(ask_secret "Secret access key")"
    else
      todo="$todo TOLKTAK_S3_BUCKET TOLKTAK_S3_ENDPOINT TOLKTAK_S3_REGION TOLKTAK_S3_ACCESS_KEY TOLKTAK_S3_SECRET_KEY"
    fi
    ;;
  3)
    set_env TOLKTAK_S3_BUCKET ""
    ;;
esac

set_env TOLKTAK_SERVER_NAME "$(ask "Server name shown in the app" TolkTak)"

set_env COMPOSE_PROFILES "$profiles"
set_env POSTGRES_PASSWORD "$(secret)"
set_env LIVEKIT_API_SECRET "$(secret)"
set_env GARAGE_RPC_SECRET "$(secret)"
set_env GARAGE_ACCESS_KEY "GK$(openssl rand -hex 12)"
set_env GARAGE_SECRET_KEY "$(secret)"
mv .env.new .env

say "" "Wrote compose.yaml and .env in $(pwd). Other settings are described in .env."
say "Open these ports in the firewall and at your hosting provider: $ports."
[ -n "${domain:-}" ] && say "The DNS record of $domain must point to this server."
[ -n "${proxy:-}" ] && say "$proxy"
if [ -n "$todo" ]; then
  say "" "Before starting, set these in .env:$todo" "Then run: docker compose up -d"
  exit 0
fi
if yes "Start TolkTak now?" y; then
  docker compose up -d
  say "" "Open $url and register: the first account becomes the administrator."
else
  say "Start it later with: docker compose up -d"
fi
