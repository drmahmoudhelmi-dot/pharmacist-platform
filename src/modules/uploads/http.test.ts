import { describe, expect, it } from "vitest";
import ar from "../../../messages/ar.json";
import en from "../../../messages/en.json";
import { REJECT_REASONS, UPLOAD_STATUSES } from "./constants";
import { isSameOrigin, type UploadErrorCode } from "./http";

const APP = "http://localhost:3000";
const req = (headers: Record<string, string>) =>
  new Request(`${APP}/api/uploads`, { method: "POST", headers });

describe("isSameOrigin", () => {
  it("accepts the app's own origin", () => {
    expect(isSameOrigin(req({ origin: APP }), APP)).toBe(true);
    expect(isSameOrigin(req({ origin: APP }), `${APP}/`)).toBe(true);
  });

  it("refuses other origins, including look-alikes and subdomains", () => {
    for (const origin of [
      "http://evil.test",
      "http://localhost:3001",
      "https://localhost:3000",
      "http://localhost:3000.evil.test",
      "http://sub.localhost:3000",
      "null",
    ])
      expect(isSameOrigin(req({ origin }), APP)).toBe(false);
  });

  it("falls back to Fetch Metadata when no Origin is sent", () => {
    expect(isSameOrigin(req({ "sec-fetch-site": "same-origin" }), APP)).toBe(
      true,
    );
    expect(isSameOrigin(req({ "sec-fetch-site": "same-site" }), APP)).toBe(
      false,
    );
    expect(isSameOrigin(req({ "sec-fetch-site": "cross-site" }), APP)).toBe(
      false,
    );
    expect(isSameOrigin(req({}), APP)).toBe(false);
  });
});

describe("localized upload messages", () => {
  // Every code the API can return, plus the routes' "unavailable".
  const CODES = [
    "unauthenticated",
    "forbidden",
    "invalid_request",
    "too_large",
    "unsupported_type",
    "rate_limited",
    "too_many_pending",
    "not_found",
  ] as const satisfies readonly UploadErrorCode[];

  it.each([
    ["ar", ar],
    ["en", en],
  ] as const)(
    "%s has a message for every error code and status",
    (_l, messages) => {
      for (const code of [...CODES, "unavailable"])
        expect(
          messages.UploadErrors[code as keyof typeof messages.UploadErrors],
        ).toBeTruthy();
      for (const status of UPLOAD_STATUSES.filter((s) => s !== "rejected"))
        expect(
          messages.UploadStatus[status as "processing" | "clean"],
        ).toBeTruthy();
      for (const reason of REJECT_REASONS)
        expect(messages.UploadStatus.rejected[reason]).toBeTruthy();
    },
  );
});
