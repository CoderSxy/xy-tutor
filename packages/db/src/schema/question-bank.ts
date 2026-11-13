import {
  pgTable,
  uuid,
  text,
  integer,
  boolean,
  timestamp,
  uniqueIndex,
  index,
  check,
  primaryKey,
  jsonb,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { users, studentProfiles } from "./auth.js";
import { knowledgeItems } from "./knowledge-base.js";
import { questionVersions } from "./questions.js";

export const skills = pgTable(
  "skills",
  {
    id: uuid().primaryKey().defaultRandom(),
    code: text().notNull(),
    name: text().notNull(),
    status: text().notNull().default("active"),
    createdBy: uuid("created_by")
      .notNull()
      .references(() => users.id),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("skills_code_unique").on(t.code),
    check("skills_status_check", sql`${t.status} IN ('active','withdrawn')`),
  ],
);

export const skillContentLinks = pgTable(
  "skill_content_links",
  {
    skillId: uuid("skill_id")
      .notNull()
      .references(() => skills.id),
    knowledgeItemId: uuid("knowledge_item_id")
      .notNull()
      .references(() => knowledgeItems.id),
    createdBy: uuid("created_by")
      .notNull()
      .references(() => users.id),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    primaryKey({
      name: "skill_content_links_pk",
      columns: [t.skillId, t.knowledgeItemId],
    }),
    index("skill_content_links_item").on(t.knowledgeItemId),
  ],
);

export const skillPrerequisites = pgTable(
  "skill_prerequisites",
  {
    skillId: uuid("skill_id")
      .notNull()
      .references(() => skills.id),
    prerequisiteId: uuid("prerequisite_id")
      .notNull()
      .references(() => skills.id),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    primaryKey({
      name: "skill_prerequisites_pk",
      columns: [t.skillId, t.prerequisiteId],
    }),
    index("skill_prerequisites_prerequisite").on(t.prerequisiteId),
    check(
      "skill_prerequisites_not_self",
      sql`${t.skillId} <> ${t.prerequisiteId}`,
    ),
  ],
);

export const questionBankEntries = pgTable(
  "question_bank_entries",
  {
    id: uuid().primaryKey().defaultRandom(),
    questionVersionId: uuid("question_version_id")
      .notNull()
      .references(() => questionVersions.id),
    difficultyBand: text("difficulty_band").notNull(),
    complexityBand: integer("complexity_band").notNull(),
    visibility: text().notNull(),
    ownerId: uuid("owner_id").references(() => studentProfiles.id),
    sourceType: text("source_type").notNull(),
    sourceRef: text("source_ref"),
    templateFamily: text("template_family"),
    contentFingerprint: text("content_fingerprint").notNull(),
    status: text().notNull().default("draft"),
    version: integer().notNull().default(1),
    publishedAt: timestamp("published_at", { withTimezone: true }),
    withdrawnReason: text("withdrawn_reason"),
    createdBy: uuid("created_by")
      .notNull()
      .references(() => users.id),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("question_bank_entry_version_unique").on(t.questionVersionId),
    uniqueIndex("question_bank_entry_shared_fingerprint")
      .on(t.contentFingerprint)
      .where(sql`${t.visibility} = 'shared'`),
    uniqueIndex("question_bank_entry_owner_fingerprint")
      .on(t.ownerId, t.contentFingerprint)
      .where(sql`${t.visibility} = 'owner_only'`),
    index("question_bank_entry_difficulty").on(t.difficultyBand),
    check(
      "question_bank_entry_visibility_check",
      sql`${t.visibility} IN ('shared','owner_only')`,
    ),
    check(
      "question_bank_entry_owner_required",
      sql`${t.visibility} <> 'owner_only' OR ${t.ownerId} IS NOT NULL`,
    ),
    check(
      "question_bank_entry_status_check",
      sql`${t.status} IN ('draft','checking','pending_review','published','rejected','withdrawn')`,
    ),
    check(
      "question_bank_entry_published_consistency",
      sql`(${t.status} = 'published') = (${t.publishedAt} IS NOT NULL)`,
    ),
    check(
      "question_bank_entry_complexity_check",
      sql`${t.complexityBand} BETWEEN 1 AND 3 AND ${t.version} > 0`,
    ),
  ],
);

export const questionSkillLinks = pgTable(
  "question_skill_links",
  {
    entryId: uuid("entry_id")
      .notNull()
      .references(() => questionBankEntries.id),
    skillId: uuid("skill_id")
      .notNull()
      .references(() => skills.id),
    isPrimary: boolean("is_primary").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    primaryKey({
      name: "question_skill_links_pk",
      columns: [t.entryId, t.skillId],
    }),
    uniqueIndex("question_skill_links_primary")
      .on(t.entryId)
      .where(sql`${t.isPrimary}`),
    index("question_skill_links_skill").on(t.skillId, t.entryId),
  ],
);

export const questionTemplates = pgTable(
  "question_templates",
  {
    id: uuid().primaryKey().defaultRandom(),
    family: text().notNull(),
    skillId: uuid("skill_id").references(() => skills.id),
    difficultyBand: text("difficulty_band").notNull(),
    params: jsonb().notNull().default({}),
    version: integer().notNull().default(1),
    status: text().notNull().default("pending_review"),
    approvedBy: uuid("approved_by").references(() => users.id),
    approvedAt: timestamp("approved_at", { withTimezone: true }),
    createdBy: uuid("created_by")
      .notNull()
      .references(() => users.id),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("question_templates_family_unique").on(t.family),
    check(
      "question_templates_difficulty_check",
      sql`${t.difficultyBand} IN ('easy','medium','challenge')`,
    ),
    check(
      "question_templates_status_check",
      sql`${t.status} IN ('pending_review','approved','rejected')`,
    ),
    check(
      "question_templates_approval_consistency",
      sql`(${t.status} = 'approved') = (${t.approvedAt} IS NOT NULL AND ${t.approvedBy} IS NOT NULL)`,
    ),
    check("question_templates_version_check", sql`${t.version} > 0`),
  ],
);

export const questionGenerationRuns = pgTable(
  "question_generation_runs",
  {
    id: uuid().primaryKey().defaultRandom(),
    skillId: uuid("skill_id")
      .notNull()
      .references(() => skills.id),
    templateId: uuid("template_id").references(() => questionTemplates.id),
    status: text().notNull().default("queued"),
    requestedBy: uuid("requested_by")
      .notNull()
      .references(() => users.id),
    studentId: uuid("student_id").references(() => studentProfiles.id),
    visibility: text().notNull().default("owner_only"),
    requestKey: text("request_key").notNull(),
    dedupeKey: text("dedupe_key").notNull(),
    params: jsonb().notNull().default({}),
    resultEntryId: uuid("result_entry_id").references(
      () => questionBankEntries.id,
    ),
    knowledgeEvidence: jsonb("knowledge_evidence"),
    errorCode: text("error_code"),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("question_generation_runs_dedupe_unique").on(t.dedupeKey),
    index("question_generation_runs_student_skill").on(
      t.studentId,
      t.skillId,
      t.createdAt,
    ),
    check(
      "question_generation_runs_status_check",
      sql`${t.status} IN ('queued','running','succeeded','failed')`,
    ),
    check(
      "question_generation_runs_visibility_check",
      sql`${t.visibility} IN ('shared','owner_only')`,
    ),
    check(
      "question_generation_runs_owner_required",
      sql`${t.visibility} <> 'owner_only' OR ${t.studentId} IS NOT NULL`,
    ),
  ],
);
