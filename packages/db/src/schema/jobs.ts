import {
  pgTable,
  uuid,
  text,
  jsonb,
  integer,
  timestamp,
} from "drizzle-orm/pg-core";
export const jobs = pgTable("jobs", {
  id: uuid().primaryKey().defaultRandom(),
  kind: text().notNull(),
  dedupeKey: text("dedupe_key").notNull().unique(),
  payload: jsonb().notNull(),
  status: text().notNull().default("queued"),
  attempts: integer().notNull().default(0),
  availableAt: timestamp("available_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  leaseToken: uuid("lease_token"),
  leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
  result: jsonb(),
  errorCode: text("error_code"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});
