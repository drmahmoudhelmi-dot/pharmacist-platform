import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { createEmailVerificationToken } from "better-auth/api";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { actorFromSession, can } from "@/modules/identity/policy";
import { changeRole, listRoles } from "@/modules/identity/roles-service";
import {
  session,
  user,
  userRole,
  verification,
} from "@/modules/identity/schema";
import {
  CookieJar,
  type Harness,
  nextIp,
  SECRET,
  startHarness,
} from "./helpers/auth-harness";
import { totpFromUri } from "./helpers/totp";

const exec = promisify(execFile);
const PASSWORD = "correct horse battery staple";
let h: Harness;
let emailCounter = 0;
const allEmails: string[] = [];

function newEmail(label: string): string {
  emailCounter += 1;
  const email = `${label}-${emailCounter}@example.test`;
  allEmails.push(email);
  return email;
}

async function sessionOf(jar: CookieJar) {
  const result = await h.call("/get-session", { jar });
  return result.json as null | {
    user: {
      id: string;
      emailVerified: boolean;
      twoFactorEnabled?: boolean | null;
    };
    session: { token: string; mfaVerifiedAt?: string | null };
  };
}

async function actorOf(jar: CookieJar) {
  const current = await sessionOf(jar);
  if (!current) return null;
  return actorFromSession(current, await listRoles(h.db, current.user.id));
}

beforeAll(async () => {
  h = await startHarness();
});

afterAll(async () => {
  await h?.stop();
});

describe("sign-up, verification and sign-in", () => {
  it("rejects sign-in until the email is verified, then allows it", async () => {
    const email = newEmail("flow");
    const signUp = await h.signUp(email, PASSWORD);
    expect(signUp.status).toBe(200);
    expect(signUp.json?.token).toBeNull();
    expect(signUp.response.headers.getSetCookie()).toHaveLength(0);

    const before = await h.signIn(email, PASSWORD);
    expect(before.status).toBe(403);
    expect(before.json?.code).toBe("EMAIL_NOT_VERIFIED");
    expect(before.jar.size).toBe(0);

    const mail = h.lastEmailTo(email);
    expect(mail?.link?.pathname).toBe("/verify-email");
    const verify = await h.call(`/verify-email?token=${mail?.token}`);
    expect(verify.status).toBe(200);

    const after = await h.signIn(email, PASSWORD);
    expect(after.status).toBe(200);
    const current = await sessionOf(after.jar);
    expect(current?.user.emailVerified).toBe(true);
  });

  it("sends the email in the page's language", async () => {
    const email = newEmail("english");
    await h.call("/sign-up/email", {
      body: { email, password: PASSWORD, name: "" },
      locale: "en",
    });
    const mail = h.lastEmailTo(email);
    expect(mail?.message.language).toBe("en");
    expect(mail?.link?.pathname).toBe("/en/verify-email");
  });

  it("enforces the 10-character minimum on the server", async () => {
    const result = await h.signUp(newEmail("short"), "123456789");
    expect(result.status).toBe(400);
    expect(result.json?.code).toBe("PASSWORD_TOO_SHORT");
  });

  it("ignores roles and verification flags in the sign-up body", async () => {
    const email = newEmail("escalate");
    const result = await h.call("/sign-up/email", {
      body: {
        email,
        password: PASSWORD,
        name: "Mallory",
        image: "https://evil.example/x.png",
        role: "super_admin",
        roles: ["super_admin"],
        twoFactorEnabled: true,
      },
    });
    expect(result.status).toBe(200);
    const [row] = await h.db.select().from(user).where(eq(user.email, email));
    expect(row?.emailVerified).toBe(false);
    expect(row?.twoFactorEnabled).toBe(false);
    expect(row?.name).toBe("");
    expect(row?.image).toBeNull();
    const roles = await h.db
      .select()
      .from(userRole)
      .where(eq(userRole.userId, row!.id));
    expect(roles).toHaveLength(0);

    const verifiedFlag = await h.call("/sign-up/email", {
      body: {
        email: newEmail("escalate"),
        password: PASSWORD,
        name: "",
        emailVerified: true,
      },
    });
    // Either rejected outright or created unverified; never verified.
    if (verifiedFlag.status === 200) {
      const created = verifiedFlag.json?.user as { email: string };
      const [r] = await h.db
        .select()
        .from(user)
        .where(eq(user.email, created.email));
      expect(r?.emailVerified).toBe(false);
    } else {
      expect(verifiedFlag.status).toBe(400);
    }
  });

  it("answers a duplicate sign-up exactly like a new one", async () => {
    const email = newEmail("dup");
    const first = await h.signUp(email, PASSWORD);
    const second = await h.signUp(email, "another long password");
    expect(second.status).toBe(first.status);
    const shape = (value: unknown): unknown =>
      value && typeof value === "object"
        ? Object.fromEntries(
            Object.entries(value)
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([k, v]) => [k, shape(v)]),
          )
        : value === null
          ? null
          : typeof value;
    expect(shape(second.json)).toEqual(shape(first.json));
    const firstUser = first.json?.user as Record<string, unknown>;
    const secondUser = second.json?.user as Record<string, unknown>;
    expect(secondUser.email).toBe(firstUser.email);
    expect(secondUser.emailVerified).toBe(false);
    expect(second.response.headers.getSetCookie()).toHaveLength(0);
    // The real owner is told by email instead.
    expect(h.lastEmailTo(email)?.message.subject).toContain("محاولة تسجيل");
    // Only one account exists.
    const rows = await h.db.select().from(user).where(eq(user.email, email));
    expect(rows).toHaveLength(1);
  });

  it("answers password-reset requests the same for unknown emails", async () => {
    const email = newEmail("known");
    await h.createVerifiedUser(email, PASSWORD);
    const known = await h.call("/request-password-reset", { body: { email } });
    const unknown = await h.call("/request-password-reset", {
      body: { email: newEmail("unknown") },
    });
    expect(known.status).toBe(200);
    expect(unknown.status).toBe(200);
    expect(unknown.json).toEqual(known.json);
  });
});

describe("password reset", () => {
  it("revokes every session and the token works only once", async () => {
    const email = newEmail("reset");
    await h.createVerifiedUser(email, PASSWORD);
    const phone = await h.signIn(email, PASSWORD);
    const laptop = await h.signIn(email, PASSWORD);
    expect(await sessionOf(phone.jar)).not.toBeNull();
    expect(await sessionOf(laptop.jar)).not.toBeNull();

    await h.call("/request-password-reset", { body: { email } });
    const mail = h.lastEmailTo(email);
    expect(mail?.link?.pathname).toBe("/reset-password");
    const token = mail!.token!;

    const newPassword = "a brand new passphrase";
    const reset = await h.call("/reset-password", {
      body: { token, newPassword },
    });
    expect(reset.status).toBe(200);

    expect(await sessionOf(phone.jar)).toBeNull();
    expect(await sessionOf(laptop.jar)).toBeNull();

    const reuse = await h.call("/reset-password", {
      body: { token, newPassword: "yet another passphrase" },
    });
    expect(reuse.status).toBe(400);
    expect(reuse.json?.code).toBe("INVALID_TOKEN");

    expect((await h.signIn(email, PASSWORD)).status).toBe(401);
    expect((await h.signIn(email, newPassword)).status).toBe(200);
  });

  it("rejects garbage and expired reset tokens", async () => {
    const garbage = await h.call("/reset-password", {
      body: { token: "not-a-real-token", newPassword: "whatever long enough" },
    });
    expect(garbage.status).toBe(400);
    expect(garbage.json?.code).toBe("INVALID_TOKEN");

    const email = newEmail("expired-reset");
    await h.createVerifiedUser(email, PASSWORD);
    const [row] = await h.db.select().from(user).where(eq(user.email, email));
    await h.db.insert(verification).values({
      identifier: "reset-password:expired-token-value",
      value: row!.id,
      expiresAt: new Date(Date.now() - 60_000),
    });
    const expired = await h.call("/reset-password", {
      body: {
        token: "expired-token-value",
        newPassword: "whatever long enough",
      },
    });
    expect(expired.status).toBe(400);
    expect(expired.json?.code).toBe("INVALID_TOKEN");
  });
});

describe("email verification tokens", () => {
  it("rejects garbage, forged and expired tokens", async () => {
    const email = newEmail("verify-bad");
    await h.signUp(email, PASSWORD);

    const garbage = await h.call("/verify-email?token=garbage");
    expect(garbage.status).toBe(401);
    expect(garbage.json?.code).toBe("INVALID_TOKEN");

    const forged = await createEmailVerificationToken(
      "some-other-secret-0123456789abcdef",
      email,
    );
    const forgedResult = await h.call(`/verify-email?token=${forged}`);
    expect(forgedResult.status).toBe(401);

    const expired = await createEmailVerificationToken(
      SECRET,
      email,
      undefined,
      -60,
    );
    const expiredResult = await h.call(`/verify-email?token=${expired}`);
    expect(expiredResult.status).toBe(401);
    expect(expiredResult.json?.code).toBe("TOKEN_EXPIRED");

    const [row] = await h.db.select().from(user).where(eq(user.email, email));
    expect(row?.emailVerified).toBe(false);
  });
});

describe("rate limits", () => {
  it("limits sign-in to 5 per 15 minutes per IP", async () => {
    const ip = nextIp();
    const statuses: number[] = [];
    for (let i = 0; i < 6; i++) {
      const r = await h.call("/sign-in/email", {
        body: { email: newEmail("ip"), password: PASSWORD },
        ip,
      });
      statuses.push(r.status);
    }
    expect(statuses.slice(0, 5).every((s) => s === 401)).toBe(true);
    expect(statuses[5]).toBe(429);
  });

  it("limits sign-in to 10 per 15 minutes per email across IPs", async () => {
    const email = newEmail("target");
    await h.createVerifiedUser(email, PASSWORD);
    const statuses: number[] = [];
    for (let i = 0; i < 11; i++) {
      const r = await h.call("/sign-in/email", {
        body: {
          email: i % 2 ? email.toUpperCase() : email,
          password: "wrong password!!",
        },
        ip: nextIp(),
      });
      statuses.push(r.status);
    }
    expect(statuses.slice(0, 10).every((s) => s === 401)).toBe(true);
    expect(statuses[10]).toBe(429);
    // Even the right password is refused while the email is limited.
    const right = await h.call("/sign-in/email", {
      body: { email, password: PASSWORD },
      ip: nextIp(),
    });
    expect(right.status).toBe(429);
  });

  it("limits password-reset requests per email, registered or not", async () => {
    for (const email of [
      newEmail("reset-limit"),
      newEmail("reset-limit-unknown"),
    ]) {
      const statuses: number[] = [];
      for (let i = 0; i < 4; i++) {
        const r = await h.call("/request-password-reset", {
          body: { email },
          ip: nextIp(),
        });
        statuses.push(r.status);
      }
      expect(statuses).toEqual([200, 200, 200, 429]);
    }
  });

  it("limits sign-up to 3 per hour per IP", async () => {
    const ip = nextIp();
    const statuses: number[] = [];
    for (let i = 0; i < 4; i++) {
      const r = await h.call("/sign-up/email", {
        body: { email: newEmail("signup-ip"), password: PASSWORD, name: "" },
        ip,
      });
      statuses.push(r.status);
    }
    expect(statuses).toEqual([200, 200, 200, 429]);
  });

  it("stores only keyed hashes of emails as limiter keys", async () => {
    const rows = await h.pool.query<{ key: string }>(
      "select key from rate_limit",
    );
    expect(rows.rows.some((r) => r.key.startsWith("email|"))).toBe(true);
    for (const { key } of rows.rows) {
      expect(key).not.toContain("@");
    }
  });
});

describe("user_role constraints", () => {
  it("enforces the role CHECK and the user/role UNIQUE in the database", async () => {
    const email = newEmail("roles-db");
    await h.createVerifiedUser(email, PASSWORD);
    const [row] = await h.db.select().from(user).where(eq(user.email, email));
    const id = row!.id;

    await expect(
      h.pool.query(
        "insert into user_role (user_id, role) values ($1, 'god_mode')",
        [id],
      ),
    ).rejects.toMatchObject({
      code: "23514",
      constraint: "user_role_role_check",
    });

    await h.pool.query(
      "insert into user_role (user_id, role) values ($1, 'support')",
      [id],
    );
    await expect(
      h.pool.query(
        "insert into user_role (user_id, role) values ($1, 'support')",
        [id],
      ),
    ).rejects.toMatchObject({
      code: "23505",
      constraint: "user_role_user_id_role_key",
    });
  });

  it("cascades on user delete and nulls granted_by", async () => {
    const granter = newEmail("granter");
    const grantee = newEmail("grantee");
    await h.createVerifiedUser(granter, PASSWORD);
    await h.createVerifiedUser(grantee, PASSWORD);
    const [g] = await h.db.select().from(user).where(eq(user.email, granter));
    const [t] = await h.db.select().from(user).where(eq(user.email, grantee));
    await h.db
      .insert(userRole)
      .values({ userId: t!.id, role: "moderator", grantedBy: g!.id });
    await h.db.delete(user).where(eq(user.id, g!.id));
    const [kept] = await h.db
      .select()
      .from(userRole)
      .where(eq(userRole.userId, t!.id));
    expect(kept?.grantedBy).toBeNull();
    await h.db.delete(user).where(eq(user.id, t!.id));
    const gone = await h.db
      .select()
      .from(userRole)
      .where(eq(userRole.userId, t!.id));
    expect(gone).toHaveLength(0);
  });
});

describe("role changes", () => {
  it("validates input and revokes sessions on every change", async () => {
    const email = newEmail("grant");
    expect(
      await changeRole(h.db, { email, role: "support", change: "grant" }),
    ).toEqual({
      status: "user_not_found",
    });
    await h.signUp(email, PASSWORD);
    expect(
      await changeRole(h.db, { email, role: "support", change: "grant" }),
    ).toEqual({
      status: "email_not_verified",
    });
    expect(
      await changeRole(h.db, { email, role: "admin", change: "grant" }),
    ).toEqual({
      status: "invalid_role",
    });

    await h.call(`/verify-email?token=${h.lastEmailTo(email)?.token}`);
    const signedIn = await h.signIn(email, PASSWORD);
    expect(await sessionOf(signedIn.jar)).not.toBeNull();

    const granted = await changeRole(h.db, {
      email: email.toUpperCase(),
      role: "support",
      change: "grant",
    });
    expect(granted).toMatchObject({ status: "granted", sessionsRevoked: 1 });
    expect(await sessionOf(signedIn.jar)).toBeNull();
    expect(
      await changeRole(h.db, { email, role: "support", change: "grant" }),
    ).toMatchObject({
      status: "unchanged",
    });
    expect(
      await changeRole(h.db, { email, role: "support", change: "revoke" }),
    ).toMatchObject({
      status: "revoked",
    });
  });

  it("the CLI rejects an unknown role and an unverified user", async () => {
    const root = path.resolve(import.meta.dirname, "../..");
    const tsx = path.join(root, "node_modules/.bin/tsx");
    const cli = path.join(root, "src/modules/identity/cli/role-admin.ts");
    const env = { ...process.env, DATABASE_URL: h.url, LOG_LEVEL: "info" };
    const email = newEmail("cli");
    await h.signUp(email, PASSWORD);

    const run = (args: string[]) =>
      exec(tsx, [cli, ...args], { env, cwd: root }).then(
        (r) => ({ code: 0, ...r }),
        (e: { code: number; stdout: string; stderr: string }) => e,
      );

    const badRole = await run(["grant", email, "root"]);
    expect(badRole.code).toBe(1);
    expect(badRole.stderr).toContain("Unknown role");

    const unverified = await run(["grant", email, "support"]);
    expect(unverified.code).toBe(1);
    expect(unverified.stderr).toContain("not verified");

    const usage = await run(["grant", email]);
    expect(usage.code).toBe(2);

    // Logs carry ids only.
    expect(badRole.stdout + unverified.stdout).not.toContain(email);
    const [row] = await h.db.select().from(user).where(eq(user.email, email));
    expect(await listRoles(h.db, row!.id)).toEqual([]);
  }, 60_000);
});

describe("staff policy and TOTP", () => {
  it("denies staff access without TOTP and allows it after a TOTP sign-in", async () => {
    const email = newEmail("staff");
    await h.createVerifiedUser(email, PASSWORD);
    await changeRole(h.db, {
      email,
      role: "verification_reviewer",
      change: "grant",
    });

    // Role but no TOTP: denied.
    const plain = await h.signIn(email, PASSWORD);
    const noMfa = await actorOf(plain.jar);
    expect(noMfa?.roles).toEqual(["verification_reviewer"]);
    expect(can(noMfa, "staff.access")).toBe(false);
    expect(can(noMfa, "verification.review")).toBe(false);

    // A second device signed in before TOTP was turned on.
    const otherDevice = await h.signIn(email, PASSWORD);

    // Enrol TOTP in the first session.
    const wrongPassword = await h.call("/two-factor/enable", {
      body: { password: "not my password" },
      jar: plain.jar,
    });
    expect(wrongPassword.json?.code).toBe("INVALID_PASSWORD");
    const enable = await h.call("/two-factor/enable", {
      body: { password: PASSWORD },
      jar: plain.jar,
    });
    expect(enable.status).toBe(200);
    const uri = enable.json?.totpURI as string;
    expect(uri).toMatch(/^otpauth:\/\/totp\//);
    expect(enable.json?.backupCodes).toHaveLength(10);

    // Enrolment is not complete until a code is confirmed.
    const pending = await actorOf(plain.jar);
    expect(can(pending, "staff.access")).toBe(false);

    const wrongCode = await h.call("/two-factor/verify-totp", {
      body: { code: "000000" },
      jar: plain.jar,
    });
    expect(wrongCode.status).toBe(401);
    const confirm = await h.call("/two-factor/verify-totp", {
      body: { code: totpFromUri(uri) },
      jar: plain.jar,
    });
    expect(confirm.status).toBe(200);
    const enrolled = await actorOf(plain.jar);
    expect(enrolled?.mfaSatisfied).toBe(true);
    expect(can(enrolled, "staff.access")).toBe(true);
    expect(can(enrolled, "verification.review")).toBe(true);
    expect(can(enrolled, "roles.manage")).toBe(false);

    // The older session never passed TOTP.
    const stale = await actorOf(otherDevice.jar);
    expect(stale).not.toBeNull();
    expect(can(stale, "staff.access")).toBe(false);

    // A fresh sign-in needs the second step; the password alone gives no session.
    const fresh = await h.signIn(email, PASSWORD);
    expect(fresh.status).toBe(200);
    expect(fresh.json?.twoFactorRedirect).toBe(true);
    expect(await sessionOf(fresh.jar)).toBeNull();
    const second = await h.call("/two-factor/verify-totp", {
      body: { code: totpFromUri(uri) },
      jar: fresh.jar,
    });
    expect(second.status).toBe(200);
    expect(can(await actorOf(fresh.jar), "staff.access")).toBe(true);

    // A backup code also satisfies the second step, once.
    const backup = (enable.json?.backupCodes as string[])[0]!;
    const viaBackup = await h.signIn(email, PASSWORD);
    const used = await h.call("/two-factor/verify-backup-code", {
      body: { code: backup },
      jar: viaBackup.jar,
    });
    expect(used.status).toBe(200);
    expect(can(await actorOf(viaBackup.jar), "staff.access")).toBe(true);
    const again = await h.signIn(email, PASSWORD);
    const reused = await h.call("/two-factor/verify-backup-code", {
      body: { code: backup },
      jar: again.jar,
    });
    expect(reused.status).toBe(401);

    // Turning TOTP off removes staff access even in an MFA session.
    const disable = await h.call("/two-factor/disable", {
      body: { password: PASSWORD },
      jar: fresh.jar,
    });
    expect(disable.status).toBe(200);
    expect(can(await actorOf(fresh.jar), "staff.access")).toBe(false);
  });

  it("does not count a regular user with TOTP as staff", async () => {
    const email = newEmail("regular-totp");
    await h.createVerifiedUser(email, PASSWORD);
    const { jar } = await h.signIn(email, PASSWORD);
    const enable = await h.call("/two-factor/enable", {
      body: { password: PASSWORD },
      jar,
    });
    await h.call("/two-factor/verify-totp", {
      body: { code: totpFromUri(enable.json?.totpURI as string) },
      jar,
    });
    const actor = await actorOf(jar);
    expect(actor?.mfaSatisfied).toBe(true);
    expect(can(actor, "staff.access")).toBe(false);
  });
});

describe("sessions across users", () => {
  it("a user can neither list nor revoke another user's sessions", async () => {
    const alice = newEmail("alice");
    const bob = newEmail("bob");
    await h.createVerifiedUser(alice, PASSWORD);
    await h.createVerifiedUser(bob, PASSWORD);
    const a = await h.signIn(alice, PASSWORD);
    const b = await h.signIn(bob, PASSWORD);
    const bobToken = (await sessionOf(b.jar))!.session.token;
    const aliceId = (await sessionOf(a.jar))!.user.id;

    const list = await h.call("/list-sessions", { jar: a.jar });
    expect(list.status).toBe(200);
    const sessions = list.json as unknown as {
      userId: string;
      token: string;
    }[];
    expect(sessions.length).toBeGreaterThan(0);
    expect(sessions.every((s) => s.userId === aliceId)).toBe(true);
    expect(sessions.some((s) => s.token === bobToken)).toBe(false);

    await h.call("/revoke-session", { body: { token: bobToken }, jar: a.jar });
    expect(await sessionOf(b.jar)).not.toBeNull();

    // Alice's "sign out everywhere" does not touch Bob.
    await h.call("/revoke-sessions", { body: {}, jar: a.jar });
    expect(await sessionOf(a.jar)).toBeNull();
    expect(await sessionOf(b.jar)).not.toBeNull();
  });

  it("rejects session endpoints without a session", async () => {
    expect((await h.call("/list-sessions")).status).toBe(401);
    expect((await h.call("/revoke-sessions", { body: {} })).status).toBe(401);
    expect(
      (await h.call("/two-factor/enable", { body: { password: PASSWORD } }))
        .status,
    ).toBe(401);
  });

  it("sign-out deletes the session server-side", async () => {
    const email = newEmail("signout");
    await h.createVerifiedUser(email, PASSWORD);
    const { jar } = await h.signIn(email, PASSWORD);
    const token = (await sessionOf(jar))!.session.token;
    // A copy of the cookie (e.g. stolen) stops working after sign-out.
    const stolen = jar.clone();
    await h.call("/sign-out", { body: {}, jar });
    const rows = await h.db
      .select()
      .from(session)
      .where(eq(session.token, token));
    expect(rows).toHaveLength(0);
    expect(await sessionOf(stolen)).toBeNull();
  });
});

describe("hardening", () => {
  it("disabled endpoints answer 404", async () => {
    for (const p of [
      "/update-user",
      "/change-email",
      "/delete-user",
      "/sign-in/social",
    ]) {
      const r = await h.call(p, { body: {} });
      expect(r.status, p).toBe(404);
    }
  });

  it("rejects cross-origin state-changing requests carrying a cookie", async () => {
    const email = newEmail("csrf");
    await h.createVerifiedUser(email, PASSWORD);
    const { jar } = await h.signIn(email, PASSWORD);
    const response = await h.auth.handler(
      new Request("http://localhost:3000/api/auth/revoke-sessions", {
        method: "POST",
        headers: {
          origin: "https://evil.example",
          cookie: jar.header(),
          "content-type": "application/json",
          "x-forwarded-for": nextIp(),
        },
        body: "{}",
      }),
    );
    expect(response.status).toBe(403);
    expect(await sessionOf(jar)).not.toBeNull();
  });

  it("never logs an email address or a token", () => {
    const log = h.logLines.join("");
    expect(log.length).toBeGreaterThan(0);
    for (const email of allEmails) expect(log).not.toContain(email);
    for (const message of h.outbox) {
      const token = /token=([\w.-]+)/.exec(message.text)?.[1];
      if (token) expect(log).not.toContain(token);
    }
  });
});
