const MAX_CGROUP_BYTES = 64 * 1024;
const SYSTEMD_DOCKER_SCOPE = /(?:^|\/)docker-([0-9a-f]{64})\.scope(?:\/|$)/;
const CGROUPFS_DOCKER_PATH = /(?:^|\/)docker\/([0-9a-f]{64})(?:\/|$)/;

function defect(message: string): Error {
  return new Error(`supervisor peer cgroup: ${message}`);
}

/** Resolves only a full Docker id carried by the kernel's peer PID cgroup. */
export function dockerContainerIdFromPeerCgroup(raw: string): string {
  const bytes = new TextEncoder().encode(raw).byteLength;
  if (bytes > MAX_CGROUP_BYTES) {
    throw defect(`input bytes ${String(bytes)} exceed ${String(MAX_CGROUP_BYTES)}`);
  }

  const ids = new Set<string>();
  for (const line of raw.split('\n')) {
    if (line === '') continue;
    const fields = /^\d+:[^:]*:(\/.*)$/.exec(line);
    if (fields === null) throw defect('malformed proc cgroup line');
    const path = fields[1];
    const systemd = SYSTEMD_DOCKER_SCOPE.exec(path)?.[1];
    const cgroupfs = CGROUPFS_DOCKER_PATH.exec(path)?.[1];
    if (systemd !== undefined) ids.add(systemd);
    if (cgroupfs !== undefined) ids.add(cgroupfs);
  }
  if (ids.size !== 1) {
    throw defect(
      ids.size === 0
        ? 'no full Docker container id found'
        : 'conflicting Docker container ids found',
    );
  }
  for (const id of ids) return id;
  throw defect('no full Docker container id found');
}
