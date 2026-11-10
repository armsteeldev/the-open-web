import type { WebSocket } from 'ws';

export const MAX_REALTIME_MESSAGE_BYTES = 1024;

export interface RealtimePayload {
  readonly [key: string]: unknown;
}

export interface SpacePublisher {
  publish(type: string, payload: RealtimePayload): boolean;
}

/** One connection subscribes to one registered space for its lifetime. */
export class SpaceChannels {
  private readonly memberships = new Map<WebSocket, string>();
  private readonly registeredSpaces: ReadonlySet<string>;

  constructor(spaces: Iterable<string>) {
    this.registeredSpaces = new Set(spaces);
  }

  get size(): number {
    return this.memberships.size;
  }

  add(socket: WebSocket, space: string): boolean {
    if (!this.registeredSpaces.has(space) || this.memberships.has(socket)) return false;
    this.memberships.set(socket, space);
    return true;
  }

  delete(socket: WebSocket): void {
    this.memberships.delete(socket);
  }

  sockets(): IterableIterator<WebSocket> {
    return this.memberships.keys();
  }

  forSpace(space: string): SpacePublisher {
    if (!this.registeredSpaces.has(space)) throw new Error(`Realtime space is not registered: ${space}`);
    return { publish: (type, payload) => this.publish(space, type, payload) };
  }

  publish(space: string, type: string, payload: RealtimePayload): boolean {
    if (!this.registeredSpaces.has(space) || !/^[a-z][a-z0-9-]{0,63}$/.test(type)) return false;
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return false;
    if (Object.hasOwn(payload, 'v') || Object.hasOwn(payload, 'space') || Object.hasOwn(payload, 'type')) return false;

    let message: string;
    try {
      message = JSON.stringify({ v: 1, space, type, ...payload });
    } catch {
      return false;
    }
    if (Buffer.byteLength(message) > MAX_REALTIME_MESSAGE_BYTES) return false;

    for (const [socket, channel] of this.memberships) {
      if (channel !== space) continue;
      if (socket.readyState !== 1) {
        this.delete(socket);
        continue;
      }
      if (socket.bufferedAmount >= 65_536) {
        socket.terminate();
        this.delete(socket);
        continue;
      }
      try {
        socket.send(message, error => {
          if (error) {
            socket.terminate();
            this.delete(socket);
          }
        });
      } catch {
        socket.terminate();
        this.delete(socket);
      }
    }
    return true;
  }
}
