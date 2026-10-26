import { z } from "zod";
import { CAREER_STAGES, SPECIALTIES } from "@/modules/profiles/constants";

// The profile fields an applicant shares with an employer, copied at apply
// time (ADR-007). Built by the profiles service from public profile fields
// only; validated again here before it is stored and when it is read, so a
// malformed row never reaches a page. No email, no national ID, no private
// professional details (the phone is a separate, opt-in column).

const text = (max: number) => z.string().max(max);

export const applicationSnapshotSchema = z.strictObject({
  displayName: text(80).min(1),
  headline: text(120).nullable(),
  bio: text(1000).nullable(),
  careerStage: z.enum(CAREER_STAGES),
  yearsExperience: z.number().int().min(0).max(60),
  governorate: z
    .strictObject({
      code: text(10),
      nameAr: text(60),
      nameEn: text(60),
    })
    .nullable(),
  specialties: z.array(z.enum(SPECIALTIES)).max(SPECIALTIES.length),
  experience: z
    .array(
      z.strictObject({
        title: text(120),
        employerName: text(120),
        startMonth: z.string().regex(/^\d{4}-\d{2}-01$/),
        endMonth: z
          .string()
          .regex(/^\d{4}-\d{2}-01$/)
          .nullable(),
      }),
    )
    .max(30),
});

export type ApplicationSnapshot = z.infer<typeof applicationSnapshotSchema>;
