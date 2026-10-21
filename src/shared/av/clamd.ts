import net from "node:net";

// Minimal clamd client (ADR-004, 4a): the INSTREAM and PING commands over TCP,
// as documented in clamd(8). The available npm clients are unmaintained or
// wrap the clamscan binary; this protocol needs a few dozen lines.
//
// INSTREAM: send "zINSTREAM\0", then chunks of <4-byte big-endian length><bytes>,
// then a zero-length chunk. clamd answers one NUL-terminated line:
//   "stream: OK", "stream: <signature> FOUND", or "<message> ERROR".

export type ClamdConfig = {
  host: string;
  port: number;
  /** Whole-command deadline, connect included. */
  timeoutMs?: number;
};

export type ScanResult =
  { infected: false } | { infected: true; signature: string };

/** clamd unreachable, timed out, or answered with an error. Retry later. */
export class ClamdError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ClamdError";
  }
}

const DEFAULT_TIMEOUT_MS = 30_000;
const CHUNK_SIZE = 64 * 1024;
/** Below clamd's default StreamMaxLength (25 MB); uploads are at most 8 MB. */
export const CLAMD_MAX_BYTES = 20 * 1024 * 1024;
/** Replies are one short line; anything longer is not clamd. */
const MAX_REPLY_BYTES = 4096;

function run(
  config: ClamdConfig,
  send: (socket: net.Socket) => void,
): Promise<string> {
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let received = 0;
    let settled = false;
    const socket = net.connect({ host: config.host, port: config.port });

    const finish = (error: Error | null, reply?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      if (error) reject(error);
      else resolve(reply ?? "");
    };
    const timer = setTimeout(
      () => finish(new ClamdError("clamd timed out")),
      timeoutMs,
    );

    const replyIfComplete = (force: boolean) => {
      const all = Buffer.concat(chunks);
      const end = all.indexOf(0);
      if (end !== -1)
        finish(null, all.subarray(0, end).toString("utf8").trim());
      else if (force) finish(null, all.toString("utf8").trim());
    };

    socket.on("connect", () => send(socket));
    socket.on("data", (chunk: Buffer) => {
      received += chunk.length;
      if (received > MAX_REPLY_BYTES) {
        finish(new ClamdError("clamd reply too long"));
        return;
      }
      chunks.push(chunk);
      replyIfComplete(false);
    });
    socket.on("end", () => {
      if (received === 0) finish(new ClamdError("clamd closed without reply"));
      else replyIfComplete(true);
    });
    // clamd may close early (e.g. size limit) and still have sent its reply.
    socket.on("error", (error) => {
      if (received > 0) replyIfComplete(true);
      else finish(new ClamdError(`clamd connection failed: ${error.message}`));
    });
  });
}

/** Scans bytes with clamd. Throws ClamdError when no verdict was obtained. */
export async function scanBuffer(
  config: ClamdConfig,
  data: Uint8Array,
): Promise<ScanResult> {
  if (data.byteLength > CLAMD_MAX_BYTES)
    throw new ClamdError("input exceeds the scan size limit");

  const reply = await run(config, (socket) => {
    socket.write("zINSTREAM\0");
    for (let offset = 0; offset < data.byteLength; offset += CHUNK_SIZE) {
      const chunk = data.subarray(offset, offset + CHUNK_SIZE);
      const length = Buffer.alloc(4);
      length.writeUInt32BE(chunk.byteLength);
      socket.write(length);
      socket.write(chunk);
    }
    socket.write(Buffer.alloc(4));
  });

  if (reply === "stream: OK") return { infected: false };
  const found = /^stream: (.+) FOUND$/.exec(reply);
  if (found?.[1]) return { infected: true, signature: found[1] };
  // "... ERROR" or anything unexpected: no verdict, so the caller retries.
  throw new ClamdError(`clamd error: ${reply.slice(0, 200)}`);
}

/** True when clamd answers PONG. */
export async function ping(config: ClamdConfig): Promise<boolean> {
  try {
    return (await run(config, (s) => s.write("zPING\0"))) === "PONG";
  } catch {
    return false;
  }
}
