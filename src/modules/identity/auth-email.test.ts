import { Writable } from "node:stream";
import { describe, expect, it } from "vitest";
import type { EmailMessage } from "@/shared/email/sender";
import { createLogger } from "@/shared/logging/logger";
import { dispatchAuthEmail } from "./auth-email";

const TOKEN = "tok_SuperSecret123";
const EMAIL = "person@example.test";

function capture() {
  const lines: string[] = [];
  const stream = new Writable({
    write(chunk, _enc, done) {
      lines.push(String(chunk));
      done();
    },
  });
  return { lines, logger: createLogger({ level: "debug" }, stream) };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 10));

describe("dispatchAuthEmail", () => {
  it("builds a locale-aware link and logs only the user id and kind", async () => {
    const sent: EmailMessage[] = [];
    const { lines, logger } = capture();
    dispatchAuthEmail(
      {
        emailSender: { send: async (m) => void sent.push(m) },
        logger,
        appUrl: "http://app.test",
      },
      "passwordReset",
      { id: "user-1", email: EMAIL },
      "/reset-password",
      { token: TOKEN },
      new Request("http://app.test", { headers: { "x-app-locale": "en" } }),
    );
    await flush();
    expect(sent).toHaveLength(1);
    expect(sent[0]?.text).toContain(
      `http://app.test/en/reset-password?token=${TOKEN}`,
    );
    const log = lines.join("");
    expect(log).toContain("user-1");
    expect(log).not.toContain(TOKEN);
    expect(log).not.toContain(EMAIL);
  });

  it("uses the unprefixed Arabic path when no locale is sent", async () => {
    const sent: EmailMessage[] = [];
    const { logger } = capture();
    dispatchAuthEmail(
      {
        emailSender: { send: async (m) => void sent.push(m) },
        logger,
        appUrl: "http://app.test",
      },
      "verification",
      { id: "user-1", email: EMAIL },
      "/verify-email",
      { token: TOKEN },
      undefined,
    );
    await flush();
    expect(sent[0]?.text).toContain(
      `http://app.test/verify-email?token=${TOKEN}`,
    );
    expect(sent[0]?.language).toBe("ar");
  });

  it("logs a failed send without the token, link or address", async () => {
    const { lines, logger } = capture();
    const failing = {
      send: async (m: EmailMessage) => {
        throw new Error(`SMTP rejected ${m.to} ${m.text}`);
      },
    };
    dispatchAuthEmail(
      { emailSender: failing, logger, appUrl: "http://app.test" },
      "verification",
      { id: "user-2", email: EMAIL },
      "/verify-email",
      { token: TOKEN },
      undefined,
    );
    await flush();
    const log = lines.join("");
    expect(log).toContain("auth.email.failed");
    expect(log).toContain("user-2");
    expect(log).not.toContain(TOKEN);
    expect(log).not.toContain(EMAIL);
    expect(log).not.toContain("SMTP rejected");
  });

  it("does not throw into the caller when the sender throws synchronously", () => {
    const { logger } = capture();
    expect(() =>
      dispatchAuthEmail(
        {
          emailSender: {
            send: () => {
              throw new Error("boom");
            },
          },
          logger,
          appUrl: "http://app.test",
        },
        "accountExists",
        { id: "u", email: EMAIL },
        "/sign-in",
        {},
        undefined,
      ),
    ).not.toThrow();
  });
});
