import { pgTable, uuid, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { studentProfiles } from "./auth.js";
import { grades, subjects, revisions } from "./catalog.js";
export const studentSelections = pgTable(
  "student_selections",
  {
    id: uuid().primaryKey().defaultRandom(),
    studentId: uuid("student_id")
      .notNull()
      .references(() => studentProfiles.id),
    gradeId: uuid("grade_id")
      .notNull()
      .references(() => grades.id),
    subjectId: uuid("subject_id")
      .notNull()
      .references(() => subjects.id),
    revisionId: uuid("revision_id")
      .notNull()
      .references(() => revisions.id),
    selectedAt: timestamp("selected_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("student_grade_subject_selection").on(
      t.studentId,
      t.gradeId,
      t.subjectId,
    ),
  ],
);
