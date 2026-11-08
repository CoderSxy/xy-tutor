import {
  pgTable,
  uuid,
  text,
  integer,
  boolean,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { files } from "./files.js";
export const editions = pgTable("curriculum_editions", {
  id: uuid().primaryKey().defaultRandom(),
  name: text().notNull().unique(),
});
export const grades = pgTable("grades", {
  id: uuid().primaryKey().defaultRandom(),
  name: text().notNull().unique(),
});
export const subjects = pgTable("subjects", {
  id: uuid().primaryKey().defaultRandom(),
  name: text().notNull().unique(),
});
export const textbooks = pgTable(
  "textbooks",
  {
    id: uuid().primaryKey().defaultRandom(),
    title: text().notNull(),
    editionId: uuid("edition_id")
      .notNull()
      .references(() => editions.id),
    gradeId: uuid("grade_id")
      .notNull()
      .references(() => grades.id),
    subjectId: uuid("subject_id")
      .notNull()
      .references(() => subjects.id),
    term: text().notNull(),
    publicationYear: integer("publication_year").notNull(),
  },
  (t) => [
    uniqueIndex("textbook_identity").on(
      t.editionId,
      t.gradeId,
      t.subjectId,
      t.term,
      t.publicationYear,
    ),
  ],
);
export const revisions = pgTable(
  "textbook_revisions",
  {
    id: uuid().primaryKey().defaultRandom(),
    textbookId: uuid("textbook_id")
      .notNull()
      .references(() => textbooks.id),
    fileId: uuid("file_id")
      .notNull()
      .references(() => files.id),
    revisionNo: integer("revision_no").notNull(),
    status: text().notNull().default("draft"),
    pageCount: integer("page_count"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("textbook_revision_number").on(t.textbookId, t.revisionNo),
  ],
);
export const chapters = pgTable(
  "chapters",
  {
    id: uuid().primaryKey().defaultRandom(),
    revisionId: uuid("revision_id")
      .notNull()
      .references(() => revisions.id),
    name: text().notNull(),
    sortOrder: integer("sort_order").notNull().default(0),
  },
  (t) => [uniqueIndex("revision_chapter_name").on(t.revisionId, t.name)],
);
export const pages = pgTable(
  "textbook_pages",
  {
    id: uuid().primaryKey().defaultRandom(),
    revisionId: uuid("revision_id")
      .notNull()
      .references(() => revisions.id),
    pageIndex: integer("page_index").notNull(),
    printedPageLabel: text("printed_page_label"),
    text: text().notNull(),
    status: text().notNull(),
    excluded: boolean().notNull().default(false),
  },
  (t) => [uniqueIndex("revision_page_index").on(t.revisionId, t.pageIndex)],
);
export const chunks = pgTable(
  "textbook_chunks",
  {
    id: uuid().primaryKey().defaultRandom(),
    revisionId: uuid("revision_id")
      .notNull()
      .references(() => revisions.id),
    pageId: uuid("page_id")
      .notNull()
      .references(() => pages.id),
    chapterId: uuid("chapter_id")
      .notNull()
      .references(() => chapters.id),
    position: integer().notNull(),
    text: text().notNull(),
  },
  (t) => [uniqueIndex("page_chunk_position").on(t.pageId, t.position)],
);
