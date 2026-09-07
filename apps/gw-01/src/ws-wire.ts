import type { ElysiaAdapter } from 'elysia';
import { BunAdapter } from 'elysia/adapter/bun';
import { websocket } from 'elysia/ws';

/** Keeps the original wire frame opaque to Elysia's automatic partial JSON parser. */
class WireFrame {
  constructor(readonly raw: Parameters<typeof websocket.message>[1]) {}
}

/**
 * Preserves wire text until {@link decodeWireFrame}. Elysia 1.4's automatic parser
 * runs before route parse hooks and leaves whitespace-prefixed JSON as strings.
 * Wrapping at Bun's message callback preserves the distinction between that text
 * and a JSON string whose contents happen to look like a command.
 */
export const gatewayAdapter: ElysiaAdapter = {
  ...BunAdapter,
  listen(app) {
    const listen = BunAdapter.listen(app);
    return (options, callback) => {
      const settings = typeof options === 'object' ? options : { port: options };
      listen(
        {
          ...settings,
          websocket: {
            ...settings.websocket,
            message(socket, raw) {
              // Elysia's public dispatcher forwards nonstrings unchanged at runtime;
              // its wire-only parameter type cannot express this private envelope.
              // The socket too: Bun 1.4's `ServerWebSocket<T>` no longer lets the
              // listener's `<unknown>` stand in for the dispatcher's `<any>`.
              return websocket.message(
                socket as Parameters<typeof websocket.message>[0],
                new WireFrame(raw) as unknown as Parameters<typeof websocket.message>[1],
              );
            },
          },
        },
        callback,
      );
    };
  },
};

/**
 * Decodes exactly one JSON text at the transport boundary; malformed JSON and
 * binary frames become an invalid payload for the controller's schema to refuse.
 * A missing envelope is a broken adapter composition and throws.
 */
export function decodeWireFrame(frame: unknown): unknown {
  // Proof: omitting the Bun wrapper fails the real-socket space-prefixed case
  // with 'WebSocket wire envelope missing' through Elysia's parser (40.86ms).
  if (!(frame instanceof WireFrame)) throw new Error('WebSocket wire envelope missing');
  if (typeof frame.raw !== 'string') return null;
  try {
    // Proof: parsing the decoded string again makes the real-socket malformed and
    // all three whitespace cases receive two pongs instead of invalid_payload + pong.
    return JSON.parse(frame.raw) as unknown;
  } catch (error) {
    if (error instanceof SyntaxError) return null;
    throw error;
  }
}
