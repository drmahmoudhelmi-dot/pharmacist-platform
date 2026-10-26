import { asc } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { governorate } from "./schema";

// Governorate reference data (ADR-003), in its own file so other modules
// (organizations) can read it without importing the profiles service, which
// itself calls theirs for the data export.

export type Governorate = {
  id: number;
  code: string;
  nameAr: string;
  nameEn: string;
};

export async function listGovernorates(
  db: Pick<NodePgDatabase, "select">,
): Promise<Governorate[]> {
  return db
    .select({
      id: governorate.id,
      code: governorate.code,
      nameAr: governorate.nameAr,
      nameEn: governorate.nameEn,
    })
    .from(governorate)
    .orderBy(asc(governorate.id));
}
