// Every table drizzle-kit should manage, re-exported from the owning module
// (see src/modules/README.md). Modules never import each other's tables.
export {
  account,
  rateLimit,
  session,
  twoFactor,
  user,
  userRole,
  verification,
} from "@/modules/identity/schema";
export {
  experience,
  governorate,
  professionalDetails,
  profile,
} from "@/modules/profiles/schema";
