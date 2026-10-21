import { describe, expect, it } from "vitest";
import { JOBS } from "@/shared/jobs/registry";
import {
  APPROVE_REASONS,
  NOTIFICATION_KINDS,
  REASON_CODES,
  REJECT_REASONS,
  reasonFits,
} from "./constants";
import { parseDecision, parseSubmission } from "./validation";

const NOW = new Date("2026-10-21T09:00:00Z");
const U1 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const U2 = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const U3 = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

const pharmacist = {
  credentialType: "pharmacist",
  nationalId: "٢٩٠٠٣١٥٠١١٢٣٤٥",
  syndicateNumber: "١٢٣٤٥",
  cardExpiresOn: "",
  consent: "on",
  national_id_front: U1,
  national_id_back: U2,
  syndicate_card: U3,
};

describe("parseSubmission", () => {
  it("accepts a pharmacist with Arabic digits and normalizes them", () => {
    expect(parseSubmission(pharmacist, NOW)).toEqual({
      ok: true,
      data: {
        credentialType: "pharmacist",
        nationalId: {
          value: "29003150112345",
          birthDate: "1990-03-15",
          governorateCode: "01",
        },
        syndicateNumber: "12345",
        university: null,
        cardExpiresOn: null,
        documents: {
          national_id_front: U1,
          national_id_back: U2,
          syndicate_card: U3,
        },
      },
    });
  });

  it("accepts a student with a university and ignores a syndicate number", () => {
    const result = parseSubmission(
      {
        ...pharmacist,
        credentialType: "student",
        university: "  جامعة   القاهرة ",
        student_card: U3,
        cardExpiresOn: "2027-06-30",
      },
      NOW,
    );
    expect(result).toMatchObject({
      ok: true,
      data: {
        credentialType: "student",
        syndicateNumber: null,
        university: "جامعة القاهرة",
        cardExpiresOn: "2027-06-30",
        documents: { student_card: U3 },
      },
    });
  });

  it("reports each problem with a stable code", () => {
    const result = parseSubmission(
      {
        credentialType: "pharmacist",
        nationalId: "19003150112345",
        syndicateNumber: "12a",
        cardExpiresOn: "2026-10-20",
        national_id_front: "not-a-uuid",
      },
      NOW,
    );
    expect(result).toEqual({
      ok: false,
      fieldErrors: {
        nationalId: "invalidCentury",
        syndicateNumber: "invalidNumber",
        cardExpiresOn: "inPast",
        consent: "consentRequired",
        national_id_front: "required",
        national_id_back: "required",
        syndicate_card: "required",
      },
    });
  });

  it("checks the credential type, claims and card expiry", () => {
    expect(
      parseSubmission({ ...pharmacist, credentialType: "" }, NOW),
    ).toMatchObject({
      ok: false,
      fieldErrors: { credentialType: "required" },
    });
    expect(
      parseSubmission({ ...pharmacist, credentialType: "doctor" }, NOW),
    ).toMatchObject({
      ok: false,
      fieldErrors: { credentialType: "invalidChoice" },
    });
    expect(
      parseSubmission({ ...pharmacist, syndicateNumber: "1".repeat(13) }, NOW),
    ).toMatchObject({ ok: false, fieldErrors: { syndicateNumber: "tooLong" } });
    expect(
      parseSubmission({ ...pharmacist, syndicateNumber: " " }, NOW),
    ).toMatchObject({
      ok: false,
      fieldErrors: { syndicateNumber: "required" },
    });
    expect(
      parseSubmission(
        {
          ...pharmacist,
          credentialType: "student",
          university: "ا",
          student_card: U3,
        },
        NOW,
      ),
    ).toMatchObject({ ok: false, fieldErrors: { university: "tooShort" } });
    expect(
      parseSubmission({ ...pharmacist, cardExpiresOn: "2026-02-30" }, NOW),
    ).toMatchObject({
      ok: false,
      fieldErrors: { cardExpiresOn: "invalidDate" },
    });
    expect(
      parseSubmission({ ...pharmacist, cardExpiresOn: "2037-01-01" }, NOW),
    ).toMatchObject({
      ok: false,
      fieldErrors: { cardExpiresOn: "tooFarAhead" },
    });
    // Today (in Cairo) is still valid; Arabic digits work in dates too.
    expect(
      parseSubmission({ ...pharmacist, cardExpiresOn: "٢٠٢٦-١٠-٢١" }, NOW),
    ).toMatchObject({ ok: true, data: { cardExpiresOn: "2026-10-21" } });
  });
});

describe("parseDecision and reason codes", () => {
  it("pairs each decision with its own reason list", () => {
    expect(new Set(REASON_CODES).size).toBe(REASON_CODES.length);
    for (const r of APPROVE_REASONS) {
      expect(reasonFits("verified", r)).toBe(true);
      expect(reasonFits("rejected", r)).toBe(false);
    }
    for (const r of REJECT_REASONS) {
      expect(reasonFits("rejected", r)).toBe(true);
      expect(reasonFits("verified", r)).toBe(false);
    }
  });

  it("accepts a valid decision and trims the note", () => {
    expect(
      parseDecision({
        decision: "rejected",
        reasonCode: "document_unreadable",
        note: "  الصورة   غير واضحة \r\n",
      }),
    ).toEqual({
      ok: true,
      data: {
        decision: "rejected",
        reasonCode: "document_unreadable",
        note: "الصورة   غير واضحة",
      },
    });
    expect(
      parseDecision({ decision: "verified", reasonCode: "documents_match" }),
    ).toEqual({
      ok: true,
      data: { decision: "verified", reasonCode: "documents_match", note: null },
    });
  });

  it("refuses unknown decisions, mismatched reasons and long notes", () => {
    expect(parseDecision({})).toEqual({
      ok: false,
      fieldErrors: { decision: "required", reasonCode: "required" },
    });
    expect(
      parseDecision({ decision: "approved", reasonCode: "documents_match" }),
    ).toMatchObject({ ok: false, fieldErrors: { decision: "invalidChoice" } });
    expect(
      parseDecision({ decision: "verified", reasonCode: "card_expired" }),
    ).toMatchObject({
      ok: false,
      fieldErrors: { reasonCode: "invalidChoice" },
    });
    expect(
      parseDecision({
        decision: "rejected",
        reasonCode: "other",
        note: "x".repeat(501),
      }),
    ).toMatchObject({ ok: false, fieldErrors: { note: "tooLong" } });
  });
});

describe("job registry", () => {
  it("knows the same notice kinds as the module", () => {
    for (const kind of NOTIFICATION_KINDS)
      expect(
        JOBS["verification.notify"].payload.safeParse({
          submissionId: U1,
          kind,
        }).success,
      ).toBe(true);
    expect(
      JOBS["verification.notify"].payload.safeParse({
        submissionId: U1,
        kind: "expired",
      }).success,
    ).toBe(false);
    // Ids only: no extra fields (e.g. an email address) get through.
    expect(
      JOBS["verification.notify"].payload.safeParse({
        submissionId: U1,
        kind: "received",
        email: "a@example.test",
      }).success,
    ).toBe(false);
  });
});
