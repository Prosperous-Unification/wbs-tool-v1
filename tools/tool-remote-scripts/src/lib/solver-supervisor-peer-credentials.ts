import { dlopen } from 'bun:ffi';

export interface SupervisorPeerCredentials {
  readonly pid: number;
  readonly uid: number;
  readonly gid: number;
}

export type SupervisorGetsockopt = (
  fd: number,
  level: number,
  option: number,
  value: Uint8Array,
  length: Uint32Array,
) => number;

const SOL_SOCKET = 1;
const SO_PEERCRED = 17;
const UCRED_BYTES = 12;
const NATIVE_LITTLE_ENDIAN = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1;

function defect(message: string): Error {
  return new Error(`supervisor peer credentials: ${message}`);
}

function acceptedFileDescriptor(socket: unknown): number {
  if ((typeof socket !== 'object' && typeof socket !== 'function') || socket === null) {
    throw defect('accepted socket has no file descriptor');
  }
  const fd = Reflect.get(socket, 'fd') as unknown;
  if (!Number.isSafeInteger(fd) || (fd as number) < 0) {
    throw defect('accepted socket has no file descriptor');
  }
  return fd as number;
}

function linuxGetsockopt(
  fd: number,
  level: number,
  option: number,
  value: Uint8Array,
  length: Uint32Array,
): number {
  const libc = dlopen('libc.so.6', {
    getsockopt: {
      args: ['i32', 'i32', 'i32', 'ptr', 'ptr'],
      returns: 'i32',
    },
  });
  try {
    return libc.symbols.getsockopt(fd, level, option, value, length);
  } finally {
    libc.close();
  }
}

/**
 * Reads Linux's kernel-authenticated pid/uid/gid from one accepted Unix socket.
 * Bun 1.3.14 exposes the accepted fd at runtime (verified on h2puni) although
 * its Socket declaration omits the property, so Reflect.get is validated and
 * fails closed if that runtime contract changes.
 */
export function readSupervisorPeerCredentials(
  socket: unknown,
  getsockopt: SupervisorGetsockopt = linuxGetsockopt,
  littleEndian: boolean = NATIVE_LITTLE_ENDIAN,
): SupervisorPeerCredentials {
  const fd = acceptedFileDescriptor(socket);
  const value = new Uint8Array(UCRED_BYTES);
  const length = new Uint32Array([UCRED_BYTES]);
  if (getsockopt(fd, SOL_SOCKET, SO_PEERCRED, value, length) !== 0) {
    throw defect('SO_PEERCRED getsockopt failed');
  }
  if (length[0] !== UCRED_BYTES) throw defect('SO_PEERCRED returned the wrong struct size');

  const view = new DataView(value.buffer, value.byteOffset, value.byteLength);
  const pid = view.getInt32(0, littleEndian);
  const uid = view.getUint32(4, littleEndian);
  const gid = view.getUint32(8, littleEndian);
  if (!Number.isSafeInteger(pid) || pid < 1)
    throw defect('SO_PEERCRED returned an invalid peer pid');
  return { pid, uid, gid };
}
