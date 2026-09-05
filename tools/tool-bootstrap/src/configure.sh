#!/bin/sh
# One-time host configuration for the wbs-tool stack (Compose model).
#
# Everything here needs root and runs once per host. After this, all deploy
# operations run unprivileged as $WBS_USER via the docker group.
#
# The reverse proxy and the registry both run as containers (see
# deploy/compose/base.yml), and images are built off-host by Dagger and
# published by digest — so there is no host Caddy. There IS bun on the host:
# tool-deploy's swap.js (the blue/green executor tool-deploy invokes over SSH
# for every deploy — see tools/tool-deploy/src/deploy.ts) is a `bun build
# --target=bun` bundle, not a container, and runs directly under the host's
# bun. This script installs and pins it for exactly that reason.
#
# Usage:
#   sudo WBS_USER=puni1 REGISTRY_USER=wbs REGISTRY_PASS=<pw> sh configure.sh
#
# Optional:
#   REGISTRY_HOST         hostname the host docker daemon logs in to and
#                         pulls its own images from. Defaults to the public
#                         hostname Caddy terminates TLS for. This is also the
#                         address published image refs are built from, so it
#                         must match what the build client pushes to.
#   REGISTRY_INSECURE=1   add REGISTRY_HOST to the docker daemon's
#                         insecure-registries list. Only for a host where
#                         REGISTRY_HOST has no TLS in front of it yet.
#                         Leaving it unset (the default) actively REMOVES the
#                         entry, so a host bootstrapped before TLS existed is
#                         cleaned up by re-running this script.
#
# Idempotent: safe to re-run.
set -eu

WBS_USER="${WBS_USER:-puni1}"
WBS_ROOT="${WBS_ROOT:-/home/puni1/wbs}"
REGISTRY_HOST="${REGISTRY_HOST:-registry.infra.bulletpoints.club}"
REGISTRY_USER="${REGISTRY_USER:-wbs}"
REGISTRY_INSECURE="${REGISTRY_INSECURE:-0}"
# Same override pattern as REGISTRY_HOST: defaults to the eventual public
# hostname, override with e.g. ":80" on a host where DNS for it doesn't
# exist yet (a bare ":80" Caddyfile address matches any Host header, with no
# automatic HTTPS / ACME attempt — see tools/tool-remote-scripts/src/swap.ts,
# which the real per-deploy render-route step reads this same variable from).
SITE_ADDRESS="${SITE_ADDRESS:-wbs.bulletpoints.club}"
# Pinned to match the version this repo builds and tests against (see
# apps/*/Dockerfile's `oven/bun:1.3.14-alpine` and package.json's
# `bun-types` devDependency) — not the version already on h2puni
# (1.2.20, installed by tool-bootstrap's bootstrap.sh before this line
# existed). `bun build --target=bun` output is ordinary bundled JS, not a
# `--compile` binary, so it isn't hard-pinned to the compiler version that
# produced it; 1.2.20 was verified live to run the current swap.js bundle
# without error. Pinning host bun to 1.3.14 here removes that cross-version
# question going forward instead of relying on a single verified data point.
BUN_VERSION="${BUN_VERSION:-1.3.14}"

log() { printf '[configure] %s\n' "$*"; }
die() { printf '[configure] %s\n' "$*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || die "must run as root"
id "$WBS_USER" >/dev/null 2>&1 || die "user '$WBS_USER' does not exist"
[ -n "${REGISTRY_PASS:-}" ] || die "REGISTRY_PASS must be set"

log "installing docker + htpasswd"
apt-get update -y
apt-get install -y --no-install-recommends \
  ca-certificates curl git docker.io docker-compose-v2 apache2-utils python3 unzip
usermod -aG docker "$WBS_USER"

# bun.sh's installer needs `unzip` (added above). Reinstalls only when the
# version actually differs, same convergence shape as the
# insecure-registries block below — re-running this script with an
# unchanged BUN_VERSION is a no-op, and bumping BUN_VERSION upgrades in
# place.
log "installing bun $BUN_VERSION (pinned) for swap.js, the deploy executor"
current_bun_version="$(bun --version 2>/dev/null || true)"
if [ "$current_bun_version" = "$BUN_VERSION" ]; then
  log "bun $BUN_VERSION already installed — skipping"
else
  curl -fsSL https://bun.sh/install | BUN_INSTALL=/usr/local bash -s -- "bun-v${BUN_VERSION}"
fi

log "disabling any pre-existing host Caddy (a containerised Caddy owns 80/443 now)"
if systemctl list-unit-files caddy.service >/dev/null 2>&1; then
  systemctl disable --now caddy || true
fi
rm -f /etc/sudoers.d/wbs-caddy-reload

log "creating $WBS_ROOT"
# `bin` (installed executor bundles — see tool-remote-scripts/src/install.ts)
# and `compose` (swap.js's rendered per-colour compose overrides — see
# lib/docker.ts's tierComposeFile) were both missing from this list before
# the cross-review fix: bootstrap.sh's own create_tree() makes `bin` (and now
# `compose` too), but this script is also documented to be run standalone
# ("copied to the host alone" — see the module docstring), so it must not
# depend on bootstrap.sh having run first for either directory to exist.
for d in "$WBS_ROOT" "$WBS_ROOT/data" "$WBS_ROOT/logs" "$WBS_ROOT/caddy" "$WBS_ROOT/state" \
         "$WBS_ROOT/compose" "$WBS_ROOT/bin"; do
  mkdir -p "$d"
done
[ -f "$WBS_ROOT/.env" ] || touch "$WBS_ROOT/.env"
chown -R "$WBS_USER:$WBS_USER" "$WBS_ROOT"
chmod 0750 "$WBS_ROOT"
chmod 0600 "$WBS_ROOT/.env"

# caddy:2-alpine hard-errors (and crash-loops) with no /etc/caddy/Caddyfile
# at all, so a fresh host needs one before the first real deploy ever runs.
#
# The imports it needs are asserted on every re-run, never left for something
# else to install later (see deploy/compose/Caddyfile.bootstrap for the full
# history: this used to be a placeholder written only-if-absent, with the real
# `import site.caddy` version left for "the deploy pipeline", except nothing
# ever did — `caddy reload` kept exiting 0 forever while silently still
# serving the placeholder, until Task 12's rehearsal caught it live). Keep in
# sync with deploy/compose/Caddyfile.bootstrap and
# deploy/compose/log-redact.caddy — duplicated inline here, rather than read
# from those files, because this script is copied to the host alone (see the
# module docstring's `scp ... sh configure.sh` usage), with no guarantee the
# rest of the repo is present alongside it.
log "writing $WBS_ROOT/caddy/log-redact.caddy (the one access-log definition)"
# Written UNCONDITIONALLY, like the Caddyfile below and for the same reason:
# its content is fixed, nothing else on the host mutates it, and every site
# file's `import access-log` hard-fails Caddy's config load without it.
#
# It exists because every vhost on this host writes to ONE access log, Caddy
# logs `request.uri` with the query string verbatim, and that log is durable
# and feeds a generated HTML report. Before the filter, it held 13 OIDC
# `code`/`state` values and 10,901 `token=` values — 16 distinct HS256 JWTs
# with a 12-hour lifetime, i.e. replayable session credentials sitting in
# cleartext (queue TASK-159). A per-vhost log block let any one vhost opt out
# of the filter silently, which is exactly what the next blue/green swap did
# (TASK-160). Keep in sync with deploy/compose/log-redact.caddy — duplicated
# inline for the same reason Caddyfile.bootstrap's content is: this script is
# copied to the host alone.
redact_tmp="$WBS_ROOT/caddy/log-redact.caddy.tmp.$$"
cat > "$redact_tmp" <<'CADDYFILE'
(access-log) {
	log {
		output file /var/log/caddy/access.log
		format filter {
			wrap json
			fields {
				request>uri query {
					replace code REDACTED
					replace state REDACTED
					replace token REDACTED
					replace access_token REDACTED
					replace id_token REDACTED
					replace refresh_token REDACTED
					replace session REDACTED
					replace password REDACTED
					replace secret REDACTED
					replace api_key REDACTED
					replace apikey REDACTED
					replace signature REDACTED
					replace sig REDACTED
				}
			}
		}
	}
}
CADDYFILE
# Renamed into place rather than written in place: this snippet is imported by
# every logged vhost, so a truncated copy (interrupt, ENOSPC, EIO) is not a
# degraded file, it is a config Caddy refuses — and the next container restart
# then takes every vhost with it.
chown "$WBS_USER:$WBS_USER" "$redact_tmp"
chmod 0644 "$redact_tmp"
mv "$redact_tmp" "$WBS_ROOT/caddy/log-redact.caddy"

log "writing $WBS_ROOT/caddy/Caddyfile (imports log-redact.caddy, then site.caddy)"
# The two imports this pipeline owns are asserted every re-run; any OTHER
# import line already in the file is PRESERVED. It used to be a wholesale
# overwrite with a single `import site.caddy`, which was true when this stack
# owned the host alone and false the moment the registry, monitoring, dev and
# studio vhosts were added by hand beside it — a re-run would have taken five
# live sites down. `log-redact.caddy` is written first because Caddy resolves
# imports in file order and every site file's `import access-log` needs the
# snippet already defined.
caddyfile="$WBS_ROOT/caddy/Caddyfile"
caddy_tmp="$caddyfile.tmp.$$"
{
  printf 'import log-redact.caddy\n'
  printf 'import site.caddy\n'
  if [ -e "$caddyfile" ]; then
    [ -r "$caddyfile" ] || die "$caddyfile exists but is not readable — refusing to rewrite it, which would drop the vhost imports it holds"
    grep_rc=0
    # Captured in one grep, filtered in another: piped straight together, `$?`
    # would be the SECOND grep's status and a read error in the first (exit 2)
    # would arrive as "no other imports" — dropping every hand-added vhost.
    caddy_imports=$(grep -E '^[[:space:]]*import[[:space:]]' "$caddyfile") || grep_rc=$?
    # 1 means "nothing imported yet", a real state on a fresh host; 2 is a read error.
    [ "$grep_rc" -le 1 ] || die "could not read $caddyfile (grep exit $grep_rc) — refusing to rewrite it"
    if [ -n "$caddy_imports" ]; then
      # The owned-import pattern tolerates a trailing comment, because
      # `import site.caddy # rendered per-deploy` is a valid line that means the
      # same thing — and preserving it beside the canonical one just emitted
      # imports the file twice, which Caddy rejects as an ambiguous site
      # definition, crash-looping every vhost on the next restart. A CRLF file
      # is already covered: `[[:space:]]` includes CR, and `.` matches it.
      filter_rc=0
      caddy_others=$(printf '%s\n' "$caddy_imports" \
        | grep -vE '^[[:space:]]*import[[:space:]]+(log-redact\.caddy|site\.caddy)[[:space:]]*(#.*)?$') \
        || filter_rc=$?
      # 1 means every import was one of ours, a normal state. Anything else is a
      # real failure, and `|| true` here would install a partial file over five
      # live vhost imports.
      [ "$filter_rc" -le 1 ] || die "could not filter the imports in $caddyfile (grep exit $filter_rc) — refusing to rewrite it"
      [ -z "$caddy_others" ] || printf '%s\n' "$caddy_others"
    fi
  fi
} > "$caddy_tmp"
mv "$caddy_tmp" "$caddyfile"
chown "$WBS_USER:$WBS_USER" "$caddyfile"

# Caddy would then hard-error on `import site.caddy` if site.caddy itself
# didn't exist — so seed one, but ONLY if absent: unlike Caddyfile, this
# file's real content is deploy state (which colour each tier currently
# routes to), rewritten by every real swap's render-route step, and must
# never be clobbered by a later re-run of this script. The seed says every
# tier is honestly "not yet deployed" — the exact same shape a real
# render-route would produce for a tier with no observed colour (see
# tools/tool-remote-scripts/src/lib/site.ts's `routeBlock`) — rather than
# guessing a colour, so the first real deploy of any tier reads back a
# clean, un-corrupted `null` for every tier it hasn't touched yet.
if [ ! -f "$WBS_ROOT/caddy/site.caddy" ]; then
  log "seeding $WBS_ROOT/caddy/site.caddy (nothing deployed yet, for any tier)"
  cat > "$WBS_ROOT/caddy/site.caddy" <<CADDYFILE
$SITE_ADDRESS {
	encode gzip

	handle /ws* {
		respond "gw-01 not yet deployed" 503
	}

	handle /api/* {
		respond "be-01 not yet deployed" 503
	}

	handle {
		respond "fe-01 not yet deployed" 503
	}

	import access-log
}

registry.infra.bulletpoints.club {
	reverse_proxy registry:5000 {
		header_up X-Forwarded-Proto {scheme}
		header_up X-Forwarded-For {remote_host}
	}
	request_body {
		max_size 2GB
	}
}
CADDYFILE
  chown "$WBS_USER:$WBS_USER" "$WBS_ROOT/caddy/site.caddy"
fi

log "writing registry htpasswd"
# bcrypt (-B) is the only format registry:2 accepts.
htpasswd -Bbn "$REGISTRY_USER" "$REGISTRY_PASS" > "$WBS_ROOT/registry.htpasswd"
chown "$WBS_USER:$WBS_USER" "$WBS_ROOT/registry.htpasswd"
chmod 0640 "$WBS_ROOT/registry.htpasswd"

log "recording REGISTRY_PASS in $WBS_ROOT/.env so later deploys can re-authenticate"
# Preserve every other line already in .env (app secrets live here too);
# only the REGISTRY_PASS line itself is replaced.
env_tmp="$WBS_ROOT/.env.tmp.$$"
# `grep ... 2>/dev/null || true` used to cover three cases with one behaviour.
# On a first run the absent .env is the intended case and an empty tmp is
# right. But an .env that EXISTS and cannot be read produced an empty tmp too,
# and the mv below then replaced a file holding every other app secret with one
# line. Silently, on a re-run, as root.
#
# -e and -r separate "nothing to preserve" from "cannot tell what to preserve".
if [ ! -e "$WBS_ROOT/.env" ]; then
  : > "$env_tmp"
elif [ ! -r "$WBS_ROOT/.env" ]; then
  die "$WBS_ROOT/.env exists but is not readable — refusing to rewrite it, which would drop every other secret it holds"
else
  grep_rc=0
  grep -v '^REGISTRY_PASS=' "$WBS_ROOT/.env" > "$env_tmp" || grep_rc=$?
  # grep exits 1 when no line matched — a file holding only REGISTRY_PASS, which
  # is a real and acceptable state — and 2 on an actual read error.
  [ "$grep_rc" -le 1 ] || die "could not read $WBS_ROOT/.env (grep exit $grep_rc) — refusing to rewrite it"
fi
printf 'REGISTRY_PASS=%s\n' "$REGISTRY_PASS" >> "$env_tmp"
mv "$env_tmp" "$WBS_ROOT/.env"
chown "$WBS_USER:$WBS_USER" "$WBS_ROOT/.env"
chmod 0600 "$WBS_ROOT/.env"

log "writing per-tier app-config env files"
# lib/docker.ts's `tierEnvFiles` puts each tier's app-config file
# (/home/puni1/wbs/<app>.env) FIRST in that tier's `env_file:` list, secrets file
# last, deliberately — see that function's doc comment. These app-config
# files hold no secrets (checked by swap.ts's assertTierEnvAllowed against a
# strict per-tier allowlist before every swap — cross-review item 3(c)), so,
# like the Caddyfile above, they are written UNCONDITIONALLY every re-run:
# unlike site.caddy, nothing else ever mutates them, so there is no live
# deploy state here to protect from being clobbered. Ports match
# lib/docker.ts's PORT map and BE_ALIAS constant; kept in sync by hand for
# the same reason Caddyfile.bootstrap's content is inlined above rather than
# read from that file — this script travels to the host alone.
log "  $WBS_ROOT/be-01.env"
cat > "$WBS_ROOT/be-01.env" <<'ENVFILE'
PORT=3100
LOG_LEVEL=info
GW_URL=http://gw-01.internal:3200
DB_PATH=/data/wbs.db
SOLVER_BUDGET_MS=60000
ENVFILE
log "  $WBS_ROOT/gw-01.env"
cat > "$WBS_ROOT/gw-01.env" <<'ENVFILE'
PORT=3200
LOG_LEVEL=info
BE_URL=http://be-01.internal:3100
ENVFILE
log "  $WBS_ROOT/fe-01.env (comment-only — fe-01 is a static caddy:2-alpine server, no env vars)"
cat > "$WBS_ROOT/fe-01.env" <<'ENVFILE'
# fe-01 runtime is caddy:2-alpine serving pre-built static assets
# (apps/fe-01/Dockerfile) — no server-side config.ts / env vars required.
# This file exists only because tier.compose.tmpl's env_file directive
# requires the path to exist; docker compose errors on a missing env_file.
ENVFILE
chown "$WBS_USER:$WBS_USER" "$WBS_ROOT/be-01.env" "$WBS_ROOT/gw-01.env" "$WBS_ROOT/fe-01.env"

log "enabling systemd lingering for $WBS_USER"
loginctl enable-linger "$WBS_USER"

# Converges /etc/docker/daemon.json's insecure-registries on REGISTRY_INSECURE
# in BOTH directions. Adding was always here; removing is what makes it
# converge, and it matters: an entry left behind from a pre-TLS bootstrap
# silently keeps a plaintext-HTTP fallback alive for a registry that now has a
# real certificate, which is exactly the kind of leftover nobody goes looking
# for. A host that once ran with REGISTRY_INSECURE=1 is cleaned up by
# re-running this script without it.
log "converging insecure-registries for $REGISTRY_HOST (REGISTRY_INSECURE=$REGISTRY_INSECURE)"
mkdir -p /etc/docker
daemon_json=/etc/docker/daemon.json
[ -f "$daemon_json" ] || printf '{}\n' > "$daemon_json"
daemon_json_changed=$(python3 - "$daemon_json" "$REGISTRY_HOST" "$REGISTRY_INSECURE" <<'PY'
import json, sys
path, host, want = sys.argv[1], sys.argv[2], sys.argv[3] == "1"
with open(path) as f:
    text = f.read().strip()
cfg = json.loads(text) if text else {}
regs = set(cfg.get("insecure-registries", []))
have = host in regs
if have == want:
    print("unchanged")
else:
    if want:
        regs.add(host)
    else:
        regs.discard(host)
    if regs:
        cfg["insecure-registries"] = sorted(regs)
    else:
        cfg.pop("insecure-registries", None)
    with open(path, "w") as f:
        json.dump(cfg, f, indent=2)
        f.write("\n")
    print("added" if want else "removed")
PY
)
# How the change is applied depends on its DIRECTION, which is not what the
# docs imply. `insecure-registries` is in dockerd's documented
# SIGHUP-reloadable set, but measured on h2puni (docker 29.1.3) a reload
# applies ADDITIONS and silently ignores REMOVALS: a probe entry written to
# daemon.json appeared in `docker info` after `systemctl reload docker`, and
# then survived a second reload after being deleted from the file again. Only
# a restart cleared it.
#
# So: reload when adding (cheap, and it works), restart when removing (the
# only thing that works). Restarting bounces every container on the box —
# caddy, the registry, dagger-engine and every app colour — which is a real
# cost, but leaving a plaintext-HTTP allowance live in a daemon whose config
# file no longer grants it is worse, and silently reporting success while
# doing nothing is worse still.
case "$daemon_json_changed" in
  added)
    log "$REGISTRY_HOST added to insecure-registries — reloading dockerd"
    systemctl reload docker
    ;;
  removed)
    log "$REGISTRY_HOST removed from insecure-registries — RESTARTING dockerd"
    log "  (a reload does not apply removals; every container on this host will bounce)"
    systemctl restart docker
    ;;
  *)
    log "insecure-registries already correct — dockerd left alone"
    ;;
esac

## ---------------------------------------------------------------------------
## Cross-review item 2: bring up the base stack BEFORE logging in to the
## registry it hosts.
##
## Fixing a real circular dependency: this script used to run `docker login`
## against $REGISTRY_HOST as its very last step, but nothing anywhere had
## ever started the registry container — the site only ever worked because a
## human had already brought the base stack up by hand during earlier
## rehearsals, so a login attempt on this line always found a registry
## already running behind Caddy. On a genuinely fresh host with nothing
## running yet, that same line would just fail: no such host to log in to.
##
## `$WBS_ROOT/base.yml` is not written by this script — see
## deploy/compose/base.yml's own comment on why it is copied verbatim
## (tool-bootstrap's push.ts scp's it here) rather than inlined the way
## Caddyfile/site.caddy are: this file is real Compose YAML, not a few lines
## of shell heredoc, and duplicating it inline would just be a second copy to
## keep in sync.
[ -f "$WBS_ROOT/base.yml" ] || die \
  "$WBS_ROOT/base.yml is missing — copy deploy/compose/base.yml there first (tool-bootstrap:push does this before running this script)"

log "bringing up the base compose stack (caddy + registry) — idempotent, a no-op if already up"
su - "$WBS_USER" -c "cd $WBS_ROOT && docker compose -f base.yml up -d"

log "waiting for $REGISTRY_HOST to accept a login (the step above is what makes this possible at all)"
# Retried rather than a single attempt: the container was (or may have just
# been) started on the line above, and — on a truly fresh host — Caddy may
# still be requesting its first Let's Encrypt certificate for
# $REGISTRY_HOST before it can proxy anything through to the registry.
# 60 attempts * 5s = 5 minutes; ample for a normal start, generous enough to
# outlast a slow first ACME issuance.
login_attempts=0
login_log="$WBS_ROOT/.configure-login.$$.log"
until su - "$WBS_USER" -c "echo '$REGISTRY_PASS' | docker login '$REGISTRY_HOST' -u '$REGISTRY_USER' --password-stdin" >"$login_log" 2>&1; do
  login_attempts=$((login_attempts + 1))
  if [ "$login_attempts" -ge 60 ]; then
    cat "$login_log" >&2
    rm -f "$login_log"
    die "docker login to $REGISTRY_HOST did not succeed after $login_attempts attempts (~5 min) — is the registry container healthy? (docker compose -f $WBS_ROOT/base.yml ps)"
  fi
  sleep 5
done
rm -f "$login_log"
log "docker login ok ($login_attempts retries)"

log "done. '$WBS_USER' can now deploy without root."
