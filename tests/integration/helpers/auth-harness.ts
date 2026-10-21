import { randomBytes } from "node:crypto";
import { Writable } from "node:stream";
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from "@testcontainers/postgresql";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { type Auth, createAuth } from "@/modules/identity/auth-config";
import { runMigrations } from "@/shared/db/migrate";
import type { EmailMessage } from "@/shared/email/sender";
import { createLogger } from "@/shared/logging/logger";

export const APP_URL = "http://localhost:3000";
// Generated per run so no secret-shaped literal lives in the repo.
export const SECRET = randomBytes(32).toString("base64url");

/** A browser-like cookie jar for one client. */
export class CookieJar {
  private cookies = new Map<string, string>();

  store(response: Response) {
    for (const header of response.headers.getSetCookie()) {
      const [pair] = header.split(";");
      const eq = pair?.indexOf("=") ?? -1;
      if (!pair || eq < 1) continue;
      const name = pair.slice(0, eq).trim();
      const value = pair.slice(eq + 1).trim();
      const expired = /max-age=0/i.test(header) || value === "";
      if (expired) this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
  }

  header(): string {
    return [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; ");
  }

  get size() {
    return this.cookies.size;
  }

  clone(): CookieJar {
    const copy = new CookieJar();
    copy.cookies = new Map(this.cookies);
    return copy;
  }
}

let ipCounter = 0;
/** A fresh client IP, so per-IP limits do not leak between tests. */
export function nextIp(): string {
  ipCounter += 1;
  const c = ipCounter;
  return `10.${(c >> 16) & 255}.${(c >> 8) & 255}.${c & 255}`;
}

export type Harness = Awaited<ReturnType<typeof startHarness>>;

export async function startHarness() {
  const container: StartedPostgreSqlContainer = await new PostgreSqlContainer(
    "postgres:18-alpine",
  ).start();
  const url = container.getConnectionUri();
  await runMigrations(url);
  const pool = new Pool({ connectionString: url, max: 5 });
  // A connection still closing when the container stops reports 57P01 as an
  // idle-client error; without a listener that becomes an unhandled error.
  pool.on("error", () => {});
  const db: NodePgDatabase = drizzle(pool);

  const outbox: EmailMessage[] = [];
  const logLines: string[] = [];
  const logger = createLogger(
    { level: "debug" },
    new Writable({
      write(chunk, _enc, done) {
        logLines.push(String(chunk));
        done();
      },
    }),
  );

  const auth: Auth = createAuth({
    db,
    emailSender: { send: async (message) => void outbox.push(message) },
    logger,
    secret: SECRET,
    appUrl: APP_URL,
    breachedPasswordCheck: false,
  });

  async function call(
    path: string,
    options: {
      method?: "GET" | "POST";
      body?: unknown;
      jar?: CookieJar;
      ip?: string;
      locale?: string;
    } = {},
  ) {
    const headers = new Headers({
      origin: APP_URL,
      "x-forwarded-for": options.ip ?? nextIp(),
    });
    if (options.body !== undefined)
      headers.set("content-type", "application/json");
    if (options.jar?.size) headers.set("cookie", options.jar.header());
    if (options.locale) headers.set("x-app-locale", options.locale);
    const response = await auth.handler(
      new Request(`${APP_URL}/api/auth${path}`, {
        method: options.method ?? (options.body === undefined ? "GET" : "POST"),
        headers,
        body:
          options.body === undefined ? undefined : JSON.stringify(options.body),
      }),
    );
    options.jar?.store(response);
    const text = await response.text();
    let json: unknown = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = text;
    }
    return {
      status: response.status,
      json: json as Record<string, unknown> | null,
      response,
    };
  }

  /** Last email sent to an address, with the link's token extracted. */
  function lastEmailTo(to: string) {
    const message = [...outbox].reverse().find((m) => m.to === to);
    if (!message) return null;
    const match = /https?:\/\/\S+/.exec(message.text);
    const link = match ? new URL(match[0]) : null;
    return { message, link, token: link?.searchParams.get("token") ?? null };
  }

  async function signUp(email: string, password: string) {
    return call("/sign-up/email", { body: { email, password, name: "" } });
  }

  /** Signs up and verifies an account through the real verification link. */
  async function createVerifiedUser(email: string, password: string) {
    const signUpResult = await signUp(email, password);
    if (signUpResult.status !== 200)
      throw new Error(`sign-up ${signUpResult.status}`);
    const token = lastEmailTo(email)?.token;
    if (!token) throw new Error("no verification email");
    const verify = await call(
      `/verify-email?token=${encodeURIComponent(token)}`,
    );
    if (verify.status !== 200) throw new Error(`verify ${verify.status}`);
  }

  async function signIn(
    email: string,
    password: string,
    jar = new CookieJar(),
  ) {
    const result = await call("/sign-in/email", {
      body: { email, password },
      jar,
    });
    return { ...result, jar };
  }

  async function stop() {
    await pool.end();
    await container.stop();
  }

  return {
    auth,
    db,
    pool,
    url,
    outbox,
    logLines,
    call,
    lastEmailTo,
    signUp,
    signIn,
    createVerifiedUser,
    stop,
  };
}
