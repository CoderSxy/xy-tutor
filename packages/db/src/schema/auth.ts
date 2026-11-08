import {
  pgTable,
  uuid,
  text,
  timestamp,
  jsonb,
  primaryKey,
} from "drizzle-orm/pg-core";
const time = (name: string) =>
  timestamp(name, { withTimezone: true }).notNull().defaultNow();
export const users = pgTable("users", {
  id: uuid().primaryKey().defaultRandom(),
  login: text().notNull().unique(),
  passwordHash: text("password_hash").notNull(),
  role: text().notNull(),
  createdAt: time("created_at"),
});
export const sessions = pgTable("auth_sessions", {
  id: uuid().primaryKey().defaultRandom(),
  userId: uuid("user_id")
    .notNull()
    .references(() => users.id),
  tokenHash: text("token_hash").notNull().unique(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
});
export const invitations = pgTable("invitations", {
  id: uuid().primaryKey().defaultRandom(),
  login: text().notNull(),
  role: text().notNull(),
  tokenHash: text("token_hash").notNull().unique(),
  kind: text().notNull(),
  userId: uuid("user_id").references(() => users.id),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  consumedAt: timestamp("consumed_at", { withTimezone: true }),
  createdAt: time("created_at"),
});
export const studentProfiles = pgTable("student_profiles", {
  id: uuid().primaryKey().defaultRandom(),
  displayName: text("display_name").notNull(),
  timezone: text().notNull().default("Asia/Shanghai"),
  preferences: jsonb().notNull().default({}),
  createdAt: time("created_at"),
});
export const studentAccess = pgTable(
  "student_access",
  {
    studentId: uuid("student_id")
      .notNull()
      .references(() => studentProfiles.id),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    permission: text().notNull(),
  },
  (t) => [primaryKey({ columns: [t.studentId, t.userId] })],
);
export const auditEvents = pgTable("audit_events", {
  id: uuid().primaryKey().defaultRandom(),
  actorId: uuid("actor_id").references(() => users.id),
  studentId: uuid("student_id").references(() => studentProfiles.id),
  action: text().notNull(),
  details: jsonb().notNull().default({}),
  createdAt: time("created_at"),
});
