import net from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { CLAMD_MAX_BYTES, ClamdError, ping, scanBuffer } from "./clamd";

// A fake clamd that parses the INSTREAM framing exactly as clamd does and
// answers with a scripted reply, so the client's protocol handling is tested
// without the real daemon (integration tests use the real one).

type Received = { command: string; chunks: number[]; data: Buffer };
type Script = (received: Received, socket: net.Socket) => void;

const servers: net.Server[] = [];

async function fakeClamd(script: Script) {
  const server = net.createServer((socket) => {
    let buffer = Buffer.alloc(0);
    let command: string | null = null;
    const chunks: number[] = [];
    const parts: Buffer[] = [];
    socket.on("data", (data) => {
      buffer = Buffer.concat([buffer, data]);
      if (command === null) {
        const end = buffer.indexOf(0);
        if (end === -1) return;
        command = buffer.subarray(0, end).toString();
        buffer = buffer.subarray(end + 1);
        if (command !== "zINSTREAM") {
          script({ command, chunks, data: Buffer.alloc(0) }, socket);
          return;
        }
      }
      while (buffer.length >= 4) {
        const length = buffer.readUInt32BE(0);
        if (length === 0) {
          script({ command, chunks, data: Buffer.concat(parts) }, socket);
          return;
        }
        if (buffer.length < 4 + length) return;
        chunks.push(length);
        parts.push(buffer.subarray(4, 4 + length));
        buffer = buffer.subarray(4 + length);
      }
    });
    socket.on("error", () => {});
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as net.AddressInfo;
  return { host: "127.0.0.1", port };
}

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map((s) => new Promise((resolve) => s.close(resolve))),
  );
});

const reply =
  (text: string): Script =>
  (_r, socket) =>
    socket.end(`${text}\0`);

describe("clamd client: INSTREAM", () => {
  it("frames the data in length-prefixed chunks ending with a zero chunk", async () => {
    let got: Received | null = null;
    const config = await fakeClamd((received, socket) => {
      got = received;
      socket.end("stream: OK\0");
    });
    const data = new Uint8Array(150_000).map((_, i) => i % 251);
    expect(await scanBuffer(config, data)).toEqual({ infected: false });
    const received = got as unknown as Received;
    expect(received.command).toBe("zINSTREAM");
    expect(received.chunks).toEqual([65_536, 65_536, 150_000 - 131_072]);
    expect(Buffer.compare(received.data, Buffer.from(data))).toBe(0);
  });

  it("reports a found signature", async () => {
    const config = await fakeClamd(reply("stream: Eicar-Test-Signature FOUND"));
    expect(await scanBuffer(config, Uint8Array.of(1, 2, 3))).toEqual({
      infected: true,
      signature: "Eicar-Test-Signature",
    });
  });

  it("throws ClamdError when clamd answers with an error", async () => {
    const config = await fakeClamd(
      reply("INSTREAM size limit exceeded. ERROR"),
    );
    await expect(scanBuffer(config, Uint8Array.of(1))).rejects.toBeInstanceOf(
      ClamdError,
    );
  });

  it("throws on an unexpected reply rather than treating it as clean", async () => {
    const config = await fakeClamd(reply("stream: something odd"));
    await expect(scanBuffer(config, Uint8Array.of(1))).rejects.toThrow(
      /clamd error/,
    );
  });

  it("throws when clamd closes without replying", async () => {
    const config = await fakeClamd((_r, socket) => socket.end());
    await expect(scanBuffer(config, Uint8Array.of(1))).rejects.toThrow(
      /without reply/,
    );
  });

  it("times out when clamd never answers", async () => {
    const config = await fakeClamd(() => {});
    await expect(
      scanBuffer({ ...config, timeoutMs: 200 }, Uint8Array.of(1)),
    ).rejects.toThrow(/timed out/);
  });

  it("throws when clamd is unreachable", async () => {
    const config = await fakeClamd(() => {});
    const closed = servers.pop();
    await new Promise((resolve) => closed?.close(resolve));
    await expect(scanBuffer(config, Uint8Array.of(1))).rejects.toThrow(
      /connection failed/,
    );
  });

  it("refuses input over the scan size limit without connecting", async () => {
    let connected = false;
    const config = await fakeClamd(() => {
      connected = true;
    });
    await expect(
      scanBuffer(config, new Uint8Array(CLAMD_MAX_BYTES + 1)),
    ).rejects.toThrow(/size limit/);
    expect(connected).toBe(false);
  });

  it("rejects an over-long reply", async () => {
    const config = await fakeClamd(reply("x".repeat(10_000)));
    await expect(scanBuffer(config, Uint8Array.of(1))).rejects.toThrow(
      /too long/,
    );
  });
});

describe("clamd client: PING", () => {
  it("is true on PONG", async () => {
    const config = await fakeClamd((received, socket) => {
      expect(received.command).toBe("zPING");
      socket.end("PONG\0");
    });
    expect(await ping(config)).toBe(true);
  });

  it("is false on anything else or no server", async () => {
    expect(await ping(await fakeClamd(reply("NOPE")))).toBe(false);
    expect(await ping({ host: "127.0.0.1", port: 1, timeoutMs: 500 })).toBe(
      false,
    );
  });
});
