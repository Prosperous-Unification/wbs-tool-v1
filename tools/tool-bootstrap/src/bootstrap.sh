#!/bin/sh
# Bootstrap a fresh Hetzner host (Debian 12 / Ubuntu 24.04) for the wbs-tool stack.
# Idempotent: safe to re-run.
set -eu

log() { printf '[bootstrap] %s\n' "$*"; }

require_root() {
  if [ "$(id -u)" -ne 0 ]; then
    log "must run as root (or via sudo)"; exit 1
  fi
}

install_packages() {
  log "apt update + base packages"
  apt-get update -y
  apt-get install -y --no-install-recommends \
    curl ca-certificates gnupg unzip sudo
}

install_docker() {
  if command -v docker >/dev/null 2>&1; then
    log "docker already installed — skipping"
    return
  fi
  log "installing docker engine + compose plugin"
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/debian/gpg -o /etc/apt/keyrings/docker.asc
  chmod a+r /etc/apt/keyrings/docker.asc
  # shellcheck disable=SC1091  # /etc/os-release exists on the target host, not in this repo
  echo \
    "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] \
    https://download.docker.com/linux/debian $(. /etc/os-release && echo "$VERSION_CODENAME") stable" \
    > /etc/apt/sources.list.d/docker.list
  apt-get update -y
  apt-get install -y docker-ce docker-ce-cli containerd.io docker-compose-plugin
}

install_bun() {
  if command -v bun >/dev/null 2>&1; then
    log "bun already installed — skipping"
    return
  fi
  log "installing bun (pinned)"
  # Keep in sync with configure.sh's BUN_VERSION: that script re-pins to the
  # same version unconditionally (converging even if this one is skipped
  # because bun was already present), but the two defaults drifting apart is
  # exactly the kind of leftover-vs-current confusion this project has hit
  # before — see configure.sh's own comment on why the pin matters.
  BUN_VERSION="${BUN_VERSION:-1.3.14}"
  curl -fsSL "https://bun.sh/install" | BUN_INSTALL=/usr/local bash -s -- "bun-v${BUN_VERSION}"
}

create_tree() {
  log "creating /srv/wbs/* tree"
  # `compose` holds swap.js's rendered per-colour compose overrides
  # (lib/docker.ts's tierComposeFile: /srv/wbs/compose/<app>-<color>.yml) —
  # writeAtomic() does not mkdir -p, so the first-ever swap on a fresh host
  # would fail here if this directory did not already exist (item 2 of the
  # cross-review fix: this was missing from both this script and
  # configure.sh, and the server only ever worked because it was created by
  # hand during earlier rehearsals).
  for d in /srv/wbs/bin /srv/wbs/compose /srv/wbs/releases /srv/wbs/state /srv/wbs/state/fragments \
           /srv/wbs/data /srv/wbs/logs /srv/wbs/caddy; do
    mkdir -p "$d"
  done
  chmod 0750 /srv/wbs
  touch /srv/wbs/.env
  chmod 0600 /srv/wbs/.env
}

main() {
  require_root
  install_packages
  install_docker
  install_bun
  create_tree
  log "bootstrap complete"
}

main "$@"
