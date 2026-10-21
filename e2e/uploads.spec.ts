import { expect, test } from "@playwright/test";
import sharp from "sharp";
import { signIn, signUpAndVerify, uniqueEmail } from "./helpers";

// The upload API through the real Next.js server (ADR-004, 4a): session
// cookie, request body streaming, size and type checks, owner-only status.
// The worker is not part of the E2E run, so uploads stay `processing` here;
// scanning, re-encoding and signed URLs are covered against real clamd and
// MinIO by tests/integration/uploads.test.ts. The upload UI is exercised by
// verification.spec.ts.

// Own sign-up budget, as in profiles.spec.ts.
function clientIp() {
  return `203.0.113.${1 + Math.floor(Math.random() * 254)}`;
}

test.describe.configure({ mode: "serial" });
test.use({ extraHTTPHeaders: { "x-forwarded-for": clientIp() } });

test("upload a photo, read its status; refuse others, oversize and non-images", async ({
  page,
  browser,
  baseURL,
}) => {
  const origin = new URL(baseURL ?? "http://localhost:3000").origin;
  const jpeg = await sharp({
    create: { width: 64, height: 48, channels: 3, background: "#1b4332" },
  })
    .jpeg()
    .withExif({ IFD3: { GPSLatitudeRef: "N", GPSLatitude: "30/1 2/1 4/1" } })
    .toBuffer();
  const post = (
    request: typeof page.request,
    buffer: Buffer,
    name = "id-card.jpg",
    headers: Record<string, string> = { origin },
  ) =>
    request.post("/api/uploads", {
      headers,
      multipart: {
        purpose: "verification_document",
        file: { name, mimeType: "image/jpeg", buffer },
      },
    });

  // Not signed in.
  expect((await post(page.request, jpeg)).status()).toBe(401);

  const owner = uniqueEmail("upload-owner");
  await signUpAndVerify(page, owner);
  await signIn(page, owner);
  await expect(page).toHaveURL(/\/account$/);

  // Accepted: 202 with id and status only.
  const created = await post(page.request, jpeg);
  expect(created.status()).toBe(202);
  const body = (await created.json()) as { id: string; status: string };
  expect(Object.keys(body).sort()).toEqual(["id", "status"]);
  expect(body.status).toBe("processing");
  expect(created.headers()["cache-control"]).toBe("no-store");

  const status = await page.request.get(`/api/uploads/${body.id}`);
  expect(status.status()).toBe(200);
  expect(await status.json()).toEqual({
    id: body.id,
    status: "processing",
    rejectReason: null,
  });

  // Refused: cross-site origin, HTML named .jpg, over 8 MiB.
  expect(
    (
      await post(page.request, jpeg, "a.jpg", { origin: "http://evil.test" })
    ).status(),
  ).toBe(403);
  const html = await post(
    page.request,
    Buffer.from("<!doctype html><script>alert(1)</script>"),
    "photo.jpg",
  );
  expect(html.status()).toBe(415);
  expect(await html.json()).toEqual({ error: "unsupported_type" });
  const big = Buffer.alloc(8 * 1024 * 1024 + 1);
  big.set([0xff, 0xd8, 0xff, 0xe0]);
  const tooLarge = await post(page.request, big);
  expect(tooLarge.status()).toBe(413);

  // Another member cannot see it; neither can an anonymous client.
  const other = await browser.newContext({
    baseURL,
    extraHTTPHeaders: { "x-forwarded-for": clientIp() },
  });
  const otherPage = await other.newPage();
  const intruder = uniqueEmail("upload-other");
  await signUpAndVerify(otherPage, intruder);
  await signIn(otherPage, intruder);
  await expect(otherPage).toHaveURL(/\/account$/);
  expect(
    (await otherPage.request.get(`/api/uploads/${body.id}`)).status(),
  ).toBe(404);
  await other.close();
  const anonymous = await browser.newContext({ baseURL });
  expect(
    (await anonymous.request.get(`/api/uploads/${body.id}`)).status(),
  ).toBe(401);
  await anonymous.close();
});
