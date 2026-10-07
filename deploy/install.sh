#!/bin/sh
# Slipway installer for Linux and macOS.
#
# Installs the Slipway control plane (the API with the web UI, the bundled node
# agent, the Caddy edge proxy and PostgreSQL) with Docker Compose into one
# directory, generates its secrets and starts it:
#
#   curl -fsSL https://raw.githubusercontent.com/JensPenneman/slipway/main/deploy/install.sh | sh -s -- --email you@example.com
#
# Running it again is safe and upgrades the installation: the settings and
# secrets in the existing .env are kept (only values passed as options change),
# compose.yaml and the Caddyfile are refreshed and the images are pulled again.
#
# Strict POSIX sh, no bashisms: check changes with `sh -n` and `shellcheck -s sh`.

set -eu

PROXY_NETWORK=slipway-proxy
PROXY_SUBNET=10.210.0.0/24
# Dynamic addresses come from the upper half only, so that no container can take
# Caddy's fixed address 10.210.0.2 while Caddy is down.
PROXY_IP_RANGE=10.210.0.128/25
DB_VOLUME=slipway_db-data
RAW_BASE_URL=https://raw.githubusercontent.com/JensPenneman/slipway

if [ -t 1 ] && [ -z "${NO_COLOR:-}" ] && [ "${TERM:-}" != dumb ]; then
  c_bold=$(printf '\033[1m')
  c_red=$(printf '\033[31m')
  c_green=$(printf '\033[32m')
  c_yellow=$(printf '\033[33m')
  c_reset=$(printf '\033[0m')
else
  c_bold='' c_red='' c_green='' c_yellow='' c_reset=''
fi

step() { printf '%s==>%s %s\n' "$c_bold" "$c_reset" "$*"; }
warn() { printf '%swarning:%s %s\n' "$c_yellow" "$c_reset" "$*" >&2; }
die() {
  printf '%serror:%s %s\n' "$c_red" "$c_reset" "$*" >&2
  exit 1
}
have() { command -v "$1" >/dev/null 2>&1; }

usage() {
  cat <<'USAGE'
Install or upgrade Slipway with Docker Compose.

Usage: install.sh [options]
       curl -fsSL https://raw.githubusercontent.com/JensPenneman/slipway/main/deploy/install.sh | sh -s -- [options]

Options:
  --dir <path>       Installation directory (default: /opt/slipway when run as
                     root on Linux, otherwise $HOME/slipway)
  --email <address>  Contact e-mail for Let's Encrypt certificates. Required on
                     the first install; asked for when a terminal is available.
  --port <n>         Host port of the web UI and API (default: 3000)
  --version <tag>    Slipway image tag, for example v0.1.0 (default: latest)
  -h, --help         Show this help

Environment: SLIPWAY_DIR, SLIPWAY_ACME_EMAIL, SLIPWAY_PORT and SLIPWAY_VERSION
stand in for the options above. SLIPWAY_REF selects the Git ref compose.yaml and
the Caddyfile are downloaded from (default: main).

Running the installer again keeps the existing .env with its secrets; only the
values passed as options (or through the variables above) change.
USAGE
}

parse_args() {
  opt_dir=${SLIPWAY_DIR:-}
  opt_email=${SLIPWAY_ACME_EMAIL:-}
  opt_port=${SLIPWAY_PORT:-}
  opt_version=${SLIPWAY_VERSION:-}
  while [ "$#" -gt 0 ]; do
    case $1 in
      --dir | --email | --port | --version)
        [ "$#" -ge 2 ] || die "Option $1 needs a value (see --help)."
        set_opt "$1" "$2"
        shift 2
        ;;
      --dir=* | --email=* | --port=* | --version=*)
        set_opt "${1%%=*}" "${1#*=}"
        shift
        ;;
      -h | --help)
        usage
        exit 0
        ;;
      *) die "Unknown option: $1 (see --help)." ;;
    esac
  done
}

set_opt() {
  case $1 in
    --dir) opt_dir=$2 ;;
    --email) opt_email=$2 ;;
    --port) opt_port=$2 ;;
    --version) opt_version=$2 ;;
  esac
}

check_docker() {
  have docker || die "Docker is not installed. Install Docker Engine (https://docs.docker.com/engine/install/) or Docker Desktop, then run the installer again."
  docker compose version >/dev/null 2>&1 ||
    die "The Docker Compose plugin is missing ('docker compose version' failed). Install it (https://docs.docker.com/compose/install/), then run the installer again."
  docker info >/dev/null 2>&1 ||
    die "Cannot reach the Docker daemon. Start Docker and make sure this user may use it (run the installer with sudo, or add the user to the docker group)."
}

resolve_dir() {
  dir=$opt_dir
  if [ -z "$dir" ]; then
    if [ "$(id -u)" -eq 0 ] && [ "$(uname -s)" = Linux ]; then
      dir=/opt/slipway
    else
      [ -n "${HOME:-}" ] || die "HOME is not set; pass --dir <path>."
      dir=$HOME/slipway
    fi
  fi
  case $dir in
    /*) ;;
    *) dir=$PWD/$dir ;;
  esac
  env_file=$dir/.env
  if [ -e "$env_file" ] && [ ! -r "$env_file" ]; then
    die "Cannot read $env_file. Run the installer as the user that installed Slipway (or with sudo)."
  fi
}

# Prints the value of KEY in the existing .env: the last occurrence, without
# surrounding quotes.
env_get() {
  [ -f "$env_file" ] || return 0
  sed -n "s/^$1=//p" "$env_file" | tail -n 1 | tr -d '\r' | sed "s/^\([\"']\)\(.*\)\1\$/\2/"
}

env_has() {
  [ -f "$env_file" ] && grep -q "^$1=" "$env_file"
}

# Sets KEY to VALUE in .env. A missing key is appended; an existing line is only
# rewritten when its value differs. Every other line stays as it is.
env_set() {
  if env_has "$1"; then
    if [ "$(env_get "$1")" != "$2" ]; then
      KEY=$1 VALUE=$2 awk '
        BEGIN { prefix = ENVIRON["KEY"] "=" }
        index($0, prefix) == 1 { print prefix ENVIRON["VALUE"]; next }
        { print }
      ' "$env_file" >"$env_file.tmp"
      mv -f "$env_file.tmp" "$env_file"
    fi
  else
    if [ -s "$env_file" ] && [ -n "$(tail -c 1 "$env_file")" ]; then
      printf '\n' >>"$env_file"
    fi
    printf '%s=%s\n' "$1" "$2" >>"$env_file"
  fi
}

valid_email() {
  case $1 in
    *[!A-Za-z0-9._%+@-]* | *@*@* | @* | *@ | *@.* | *. | *..*) return 1 ;;
    *@*.*) return 0 ;;
    *) return 1 ;;
  esac
}

resolve_settings() {
  email=${opt_email:-$(env_get SLIPWAY_ACME_EMAIL)}
  if [ -z "$email" ] && (: </dev/tty) 2>/dev/null; then
    printf "Contact e-mail for Let's Encrypt certificates: " >/dev/tty
    read -r email </dev/tty || email=''
  fi
  [ -n "$email" ] || die "An e-mail address for Let's Encrypt is required: pass --email <address> or set SLIPWAY_ACME_EMAIL."
  valid_email "$email" || die "'$email' does not look like an e-mail address."

  port=${opt_port:-$(env_get SLIPWAY_PORT)}
  port=${port:-3000}
  case $port in
    '' | *[!0-9]* | ??????*) die "Invalid port '$port': use a number from 1 to 65535." ;;
  esac
  port=${port#"${port%%[!0]*}"}
  if [ -z "$port" ] || [ "$port" -gt 65535 ]; then
    die "Invalid port: use a number from 1 to 65535."
  fi
  case $port in
    80 | 443) die "Port $port belongs to the Caddy edge proxy; choose another --port." ;;
  esac

  version=${opt_version:-$(env_get SLIPWAY_VERSION)}
  version=${version:-latest}
  version=${version#v}
  case $version in
    [!A-Za-z0-9_]* | *[!A-Za-z0-9._-]*) die "Invalid version '$version': use an image tag such as 0.1.0 or latest." ;;
  esac

  public_url=$(env_get SLIPWAY_PUBLIC_URL)
  log_level=$(env_get LOG_LEVEL)
  log_level=${log_level:-info}
}

# Keeps existing secrets and generates the missing ones from /dev/urandom.
resolve_secrets() {
  secret_key=$(env_get SLIPWAY_SECRET_KEY)
  db_password=$(env_get POSTGRES_PASSWORD)
  join_token=$(env_get SLIPWAY_LOCAL_JOIN_TOKEN)
  setup_token=$(env_get SLIPWAY_SETUP_TOKEN)

  if { [ -z "$secret_key" ] || [ -z "$db_password" ]; } && docker volume inspect "$DB_VOLUME" >/dev/null 2>&1; then
    die "The Docker volume $DB_VOLUME holds an existing Slipway database, but $env_file does not have its secrets. Restore .env from your backup into $dir, or point --dir at the existing installation. To start over and delete all Slipway data instead, remove the old containers and run: docker volume rm $DB_VOLUME"
  fi

  fresh_install=no
  if [ -z "$secret_key" ]; then
    fresh_install=yes
    secret_key=$(head -c 32 /dev/urandom | base64 | tr -d '\n')
    [ "${#secret_key}" -eq 44 ] || die "Could not generate SLIPWAY_SECRET_KEY (needs /dev/urandom, head and base64)."
  fi
  if [ -z "$db_password" ]; then
    db_password=$(head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n')
    [ "${#db_password}" -eq 64 ] || die "Could not generate POSTGRES_PASSWORD (needs /dev/urandom, head and od)."
  fi
  if [ -z "$join_token" ]; then
    join_token=slpn_$(LC_ALL=C tr -dc 'A-Za-z0-9' </dev/urandom 2>/dev/null | head -c 43)
    [ "${#join_token}" -eq 48 ] || die "Could not generate SLIPWAY_LOCAL_JOIN_TOKEN (needs /dev/urandom, tr and head)."
  fi
  # Required by the first-run setup, so that only the operator can create the owner.
  if [ -z "$setup_token" ]; then
    setup_token=slps_$(LC_ALL=C tr -dc 'A-Za-z0-9' </dev/urandom 2>/dev/null | head -c 43)
    [ "${#setup_token}" -eq 48 ] || die "Could not generate SLIPWAY_SETUP_TOKEN (needs /dev/urandom, tr and head)."
  fi
}

ensure_network() {
  if docker network inspect "$PROXY_NETWORK" >/dev/null 2>&1; then
    subnets=$(docker network inspect --format '{{range .IPAM.Config}}{{.Subnet}} {{end}}' "$PROXY_NETWORK")
    subnets=${subnets% }
    case " $subnets " in
      *" $PROXY_SUBNET "*) ;;
      *) warn "The Docker network $PROXY_NETWORK already exists with subnet ${subnets:-(none)}, not $PROXY_SUBNET. Caddy's fixed address 10.210.0.2 and SLIPWAY_TRUSTED_PROXIES assume $PROXY_SUBNET: recreate the network or adapt compose.yaml." ;;
    esac
  else
    step "Creating Docker network $PROXY_NETWORK ($PROXY_SUBNET)"
    docker network create --driver bridge --subnet "$PROXY_SUBNET" --ip-range "$PROXY_IP_RANGE" "$PROXY_NETWORK" >/dev/null ||
      die "Could not create the Docker network $PROXY_NETWORK. If $PROXY_SUBNET overlaps another network on this host, free that range first."
  fi
}

download() {
  if have curl; then
    curl -fsSL --proto '=https' --tlsv1.2 --retry 3 -o "$2" "$1"
  else
    wget -q -O "$2" "$1"
  fi
}

# Copies compose.yaml and the Caddyfile from next to this script when it runs
# from a checkout, and downloads them otherwise (curl ... | sh).
install_files() {
  mkdir -p "$dir" || die "Cannot create $dir."
  src_dir=''
  if [ -f "$0" ] && [ -f "$(dirname "$0")/compose.yaml" ] && [ -f "$(dirname "$0")/Caddyfile" ]; then
    src_dir=$(CDPATH='' cd "$(dirname "$0")" && pwd -P)
  fi
  if [ -n "$src_dir" ]; then
    if [ "$src_dir" != "$(CDPATH='' cd "$dir" && pwd -P)" ]; then
      step "Copying compose.yaml and Caddyfile from $src_dir"
      for name in compose.yaml Caddyfile; do
        cp "$src_dir/$name" "$dir/$name" || die "Cannot copy $name to $dir."
      done
    fi
  else
    ref=${SLIPWAY_REF:-main}
    case $ref in
      '' | -* | *[!A-Za-z0-9._/-]*) die "Invalid SLIPWAY_REF '$ref'." ;;
    esac
    have curl || have wget || die "Downloading the Slipway files needs curl or wget. Install one of them, then run the installer again."
    step "Downloading compose.yaml and Caddyfile ($ref)"
    for name in compose.yaml Caddyfile; do
      url=$RAW_BASE_URL/$ref/deploy/$name
      if ! download "$url" "$dir/$name.download"; then
        rm -f "$dir/$name.download"
        die "Could not download $url."
      fi
      mv -f "$dir/$name.download" "$dir/$name"
    done
  fi
  # Caddy reads its Caddyfile as root without DAC_OVERRIDE, so it must be
  # world-readable whoever owns it.
  chmod 644 "$dir/compose.yaml" "$dir/Caddyfile"
}

write_env() {
  umask 077
  if [ -f "$env_file" ]; then
    step "Updating $env_file (existing values are kept)"
    env_set SLIPWAY_VERSION "$version"
    env_set SLIPWAY_PORT "$port"
    env_set SLIPWAY_PUBLIC_URL "$public_url"
    env_set SLIPWAY_ACME_EMAIL "$email"
    env_set SLIPWAY_SECRET_KEY "$secret_key"
    env_set SLIPWAY_LOCAL_JOIN_TOKEN "$join_token"
    env_set SLIPWAY_SETUP_TOKEN "$setup_token"
    env_set POSTGRES_PASSWORD "$db_password"
    env_set LOG_LEVEL "$log_level"
  else
    step "Writing $env_file"
    cat >"$env_file" <<ENV
# Slipway configuration, written by install.sh. Every key is described in
# deploy/.env.example in the Slipway repository.
#
# Back up this file. Losing SLIPWAY_SECRET_KEY makes all stored secrets
# unrecoverable, and the database only accepts the POSTGRES_PASSWORD it was
# created with.
SLIPWAY_VERSION=$version
SLIPWAY_PORT=$port
SLIPWAY_PUBLIC_URL=$public_url
SLIPWAY_ACME_EMAIL=$email
SLIPWAY_SECRET_KEY=$secret_key
SLIPWAY_LOCAL_JOIN_TOKEN=$join_token
SLIPWAY_SETUP_TOKEN=$setup_token
POSTGRES_PASSWORD=$db_password
LOG_LEVEL=$log_level
ENV
  fi
  chmod 600 "$env_file"
}

compose() {
  if [ -f "$dir/compose.override.yaml" ]; then
    docker compose --project-directory "$dir" -f "$dir/compose.yaml" -f "$dir/compose.override.yaml" "$@"
  else
    docker compose --project-directory "$dir" -f "$dir/compose.yaml" "$@"
  fi
}

start_stack() {
  # Compose prefers variables from the environment over .env: let .env decide.
  unset SLIPWAY_VERSION SLIPWAY_PORT SLIPWAY_PUBLIC_URL SLIPWAY_ACME_EMAIL \
    SLIPWAY_SECRET_KEY SLIPWAY_LOCAL_JOIN_TOKEN SLIPWAY_SETUP_TOKEN POSTGRES_PASSWORD LOG_LEVEL
  step "Pulling images (SLIPWAY_VERSION=$version)"
  compose pull || die "Pulling the images failed. Check the network connection and that the tag '$version' exists."
  step "Starting Slipway"
  if ! compose up -d --wait --wait-timeout 300 --remove-orphans; then
    compose ps >&2 || true
    die "Slipway did not start cleanly. Inspect the logs with: cd \"$dir\" && docker compose logs"
  fi
}

# Best effort: the address of the interface that holds the default route.
detect_host() {
  addr=''
  if have ip; then
    addr=$(ip -4 route get 1.1.1.1 2>/dev/null | sed -n 's/.* src \([0-9.]*\).*/\1/p' | head -n 1)
  fi
  if [ -z "$addr" ] && have ipconfig && have route; then
    iface=$(route -n get default 2>/dev/null | awk '/interface:/ { print $2; exit }')
    if [ -n "$iface" ]; then
      addr=$(ipconfig getifaddr "$iface" 2>/dev/null || true)
    fi
  fi
  if [ -z "$addr" ] && have hostname; then
    addr=$(hostname -I 2>/dev/null | awk '{ print $1 }')
  fi
  printf '%s\n' "${addr:-localhost}"
}

print_summary() {
  url="http://$(detect_host):$port/"
  printf '\n%sSlipway is running.%s\n\n' "$c_green$c_bold" "$c_reset"
  printf '  Web UI: %s%s%s\n\n' "$c_bold" "$url" "$c_reset"
  if [ "$fresh_install" = yes ]; then
    cat <<NEXT
Next steps:
  1. Create the owner account now with this one-time link (it carries the
     setup token, SLIPWAY_SETUP_TOKEN in $env_file):
     ${url}setup#token=$setup_token
  2. Forward TCP ports 80 and 443 (and UDP 443 for HTTP/3) from your router to
     this machine, then add your domain in the web UI.
  3. Back up $env_file. Losing SLIPWAY_SECRET_KEY makes the stored secrets
     unrecoverable.

NEXT
  fi
  cat <<MANAGE
Manage the installation from $dir:
  docker compose ps                                     status
  docker compose logs -f slipway                        API logs
  docker compose pull && docker compose up -d --wait    upgrade
MANAGE
}

main() {
  parse_args "$@"
  check_docker
  resolve_dir
  resolve_settings
  resolve_secrets
  ensure_network
  install_files
  write_env
  start_stack
  print_summary
}

main "$@"
