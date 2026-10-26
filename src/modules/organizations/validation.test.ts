import { describe, expect, it } from "vitest";
import { JOBS } from "@/shared/jobs/registry";
import {
  formDataToRaw,
  isUuid,
  parseInvitation,
  parseOrganization,
} from "./validation";

describe("parseOrganization", () => {
  const valid = {
    kind: "pharmacy",
    name: "  صيدلية   النـــور  ",
    governorateId: "١",
    addressLine: " ١٢ شارع التحرير، الدقي ",
  };

  it("normalizes name and address, accepts Arabic digits", () => {
    expect(parseOrganization(valid)).toEqual({
      ok: true,
      data: {
        kind: "pharmacy",
        name: "صيدلية النور",
        governorateId: 1,
        addressLine: "١٢ شارع التحرير، الدقي",
      },
    });
  });

  it("treats an empty address as none", () => {
    const parsed = parseOrganization({ ...valid, addressLine: "   " });
    expect(parsed.ok && parsed.data.addressLine).toBeNull();
  });

  it.each([
    [{ kind: "" }, { kind: "required" }],
    [{ kind: "hospital" }, { kind: "invalidChoice" }],
    [{ name: "" }, { name: "required" }],
    [{ name: "ص" }, { name: "tooShort" }],
    [{ name: "ص".repeat(121) }, { name: "tooLong" }],
    [{ governorateId: "" }, { governorateId: "required" }],
    [{ governorateId: "0" }, { governorateId: "invalidChoice" }],
    [{ governorateId: "1; drop table" }, { governorateId: "invalidChoice" }],
    [{ addressLine: "ع".repeat(201) }, { addressLine: "tooLong" }],
  ])("refuses %j", (change, fieldErrors) => {
    expect(parseOrganization({ ...valid, ...change })).toEqual({
      ok: false,
      fieldErrors,
    });
  });

  it("strips control characters", () => {
    const parsed = parseOrganization({ ...valid, name: "صيدلية\u0000\nالنور" });
    expect(parsed.ok && parsed.data.name).toBe("صيدلية النور");
  });

  it("drops bidi overrides and zero-width characters", () => {
    const parsed = parseOrganization({
      ...valid,
      name: "\u202Eصيدلية\u200F النور\u200B\u2066",
    });
    expect(parsed.ok && parsed.data.name).toBe("صيدلية النور");
  });

  it("ignores non-string input", () => {
    expect(parseOrganization({ kind: 1, name: {}, governorateId: [] })).toEqual(
      {
        ok: false,
        fieldErrors: {
          kind: "required",
          name: "required",
          governorateId: "required",
        },
      },
    );
  });
});

describe("parseInvitation", () => {
  it("lowercases and trims the address", () => {
    expect(
      parseInvitation({
        email: "  Sara.Ahmed@Example.TEST ",
        role: "recruiter",
      }),
    ).toEqual({
      ok: true,
      data: { email: "sara.ahmed@example.test", role: "recruiter" },
    });
  });

  it.each([
    [{ email: "", role: "recruiter" }, { email: "required" }],
    [{ email: "not-an-email", role: "recruiter" }, { email: "invalidEmail" }],
    [
      { email: `${"a".repeat(250)}@x.test`, role: "recruiter" },
      { email: "invalidEmail" },
    ],
    [{ email: "a@b.test", role: "" }, { role: "required" }],
    [{ email: "a@b.test", role: "super_admin" }, { role: "invalidChoice" }],
  ])("refuses %j", (raw, fieldErrors) => {
    expect(parseInvitation(raw)).toEqual({ ok: false, fieldErrors });
  });
});

describe("helpers", () => {
  it("reads form data, skipping Next's action fields and repeats", () => {
    const form = new FormData();
    form.append("$ACTION_ID_1", "x");
    form.append("name", "أ");
    form.append("name", "ب");
    expect(formDataToRaw(form)).toEqual({ name: "أ" });
  });

  it("checks uuids", () => {
    expect(isUuid("6f1c9a52-3d4e-4b8a-9c1d-2e3f4a5b6c7d")).toBe(true);
    expect(isUuid("../etc")).toBe(false);
    expect(isUuid(undefined)).toBe(false);
  });

  it("invitation jobs carry an id only", () => {
    const id = "6f1c9a52-3d4e-4b8a-9c1d-2e3f4a5b6c7d";
    const payload = JOBS["organization.notify"].payload;
    expect(payload.safeParse({ invitationId: id }).success).toBe(true);
    expect(
      payload.safeParse({ invitationId: id, email: "a@b.test" }).success,
    ).toBe(false);
    expect(payload.safeParse({ invitationId: "x" }).success).toBe(false);
  });
});
