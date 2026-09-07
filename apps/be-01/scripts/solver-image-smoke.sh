#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "$script_dir/../../.." && pwd)"
image="wbs-be-01:solver-smoke"
request="$repo_root/libs/contracts/solver/fixtures/request/valid-quantised-baseline.json"
registry_name="wbs-solver-smoke-registry-$$"
caller_name="wbs-solver-smoke-caller-$$"
attempt_token="$(cat /proc/sys/kernel/random/uuid)"
socket_directory="$(mktemp -d "/run/user/$(id -u)/wbs-solver-smoke.XXXXXX")"
socket_path="$socket_directory/supervisor.sock"
supervisor_pid=''

cleanup() {
  if [ -n "$supervisor_pid" ]; then
    kill "$supervisor_pid" 2>/dev/null || true
    wait "$supervisor_pid" 2>/dev/null || true
  fi
  docker stop "$registry_name" >/dev/null 2>&1 || true
  docker container inspect "wbs-solver-$attempt_token" >/dev/null 2>&1 &&
    docker rm --force "wbs-solver-$attempt_token" >/dev/null
  rmdir "$socket_directory" 2>/dev/null || true
}
trap cleanup EXIT

docker build --file "$repo_root/apps/be-01/Dockerfile" --tag "$image" "$repo_root"

docker run --rm --interactive --entrypoint wbs-solver "$image" <"$request" >/dev/null

docker run --detach --rm --publish 127.0.0.1::5000 --name "$registry_name" registry:2 >/dev/null
registry_port="$(
  docker inspect --format '{{(index (index .NetworkSettings.Ports "5000/tcp") 0).HostPort}}' \
    "$registry_name"
)"
registry="127.0.0.1:$registry_port"
for _attempt in 1 2 3 4 5 6 7 8 9 10; do
  curl --fail --silent --show-error --max-time 2 "http://$registry/v2/" >/dev/null && break
  sleep 1
done
curl --fail --silent --show-error --max-time 2 "http://$registry/v2/" >/dev/null
registry_tag="$registry/wbs-be-01:solver-smoke"
docker tag "$image" "$registry_tag"
docker push "$registry_tag" >/dev/null
mapfile -t matching_digests < <(
  docker inspect --format '{{range .RepoDigests}}{{println .}}{{end}}' "$registry_tag" |
    grep --fixed-strings "$registry/wbs-be-01@"
)
if [ "${#matching_digests[@]}" -ne 1 ]; then
  echo "[solver-image-smoke] local registry did not produce one matching digest" >&2
  exit 1
fi
solver_image="${matching_digests[0]}"
case "$solver_image" in
  *@sha256:????????????????????????????????????????????????????????????????) ;;
  *)
    echo "[solver-image-smoke] local registry did not produce a digest-pinned image" >&2
    exit 1
    ;;
esac

bun "$script_dir/solver-supervisor-image-host.ts" "$solver_image" "$socket_path" "$caller_name" &
supervisor_pid=$!
for _attempt in 1 2 3 4 5 6 7 8 9 10; do
  [ -S "$socket_path" ] && break
  kill -0 "$supervisor_pid"
  sleep 1
done
[ -S "$socket_path" ]

# Proof: removing only the launcher's project.scripts entry leaves the direct
# wbs-solver check green and makes this authenticated real-container bind fail.
docker run --rm --name "$caller_name" \
  --volume "$socket_directory:/run/wbs-solver:ro" \
  --entrypoint bun "$solver_image" \
  /app/apps/be-01/scripts/solver-supervisor-image-client.ts \
  /run/wbs-solver/supervisor.sock \
  /app/libs/contracts/solver/fixtures/request/valid-quantised-baseline.json \
  "$attempt_token"

# CI runs the portable launcher half above. The canonical h2puni gate sets this
# flag because its puni1 user session owns the persistent systemd timer used by
# the real supervisor-restart proof.
if [ "${WBS_RUN_SOLVER_ORPHAN_PROC:-0}" = '1' ]; then
  orphan_registry_tag="$registry/wbs-be-01:solver-orphan"
  docker build \
    --file "$repo_root/apps/be-01/scripts/solver-orphan-fixture.Dockerfile" \
    --build-arg "SOLVER_BASE_IMAGE=$solver_image" \
    --tag "$orphan_registry_tag" \
    "$repo_root"
  docker push "$orphan_registry_tag" >/dev/null
  mapfile -t orphan_digests < <(
    docker inspect --format '{{range .RepoDigests}}{{println .}}{{end}}' "$orphan_registry_tag" |
      grep --fixed-strings "$registry/wbs-be-01@"
  )
  if [ "${#orphan_digests[@]}" -ne 1 ]; then
    echo '[solver-image-smoke] orphan fixture did not produce one matching digest' >&2
    exit 1
  fi
  WBS_SOLVER_ORPHAN_IMAGE="${orphan_digests[0]}" \
    bun test \
      apps/be-01/src/service/optimization-orphan.proc.db.test.ts \
      tools/tool-remote-scripts/src/lib/solver-supervisor-lifecycle.proc.test.ts
fi
