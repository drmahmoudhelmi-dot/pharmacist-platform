// Every table drizzle-kit should manage, re-exported from the owning module
// (see src/modules/README.md). Modules never import each other's tables.
export {
  account,
  accountSuspension,
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
export { upload } from "@/modules/uploads/schema";
export {
  documentAccessLog,
  verificationDecision,
  verificationDocument,
  verificationSubmission,
} from "@/modules/verification/schema";
export {
  organization,
  organizationAudit,
  organizationInvitation,
  organizationMember,
} from "@/modules/organizations/schema";
export {
  applicationEvent,
  job,
  jobApplication,
  jobEvent,
  jobModerationDecision,
  jobReport,
} from "@/modules/jobs/schema";
export { adminAudit } from "@/modules/admin/schema";
