WITH ranked AS (
  SELECT le.id, row_number() OVER (
    PARTITION BY le.student_id, le.entry_key
    ORDER BY c.created_at DESC, le.id DESC
  ) AS rn
  FROM learning_entries le JOIN conversations c ON c.id=le.conversation_id
)
DELETE FROM learning_entries WHERE id IN (SELECT id FROM ranked WHERE rn > 1);
--> statement-breakpoint
WITH ranked AS (
  SELECT id, row_number() OVER (
    PARTITION BY student_id, knowledge_point
    ORDER BY updated_at DESC, id DESC
  ) AS rn
  FROM student_knowledge_states
)
DELETE FROM student_knowledge_states WHERE id IN (SELECT id FROM ranked WHERE rn > 1);
--> statement-breakpoint
ALTER TABLE conversations ALTER COLUMN revision_id DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE learning_tasks ALTER COLUMN revision_id DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE questions ALTER COLUMN revision_id DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE materials ALTER COLUMN revision_id DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE learning_entries ALTER COLUMN revision_id DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE knowledge_observations ALTER COLUMN revision_id DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE student_knowledge_states ALTER COLUMN revision_id DROP NOT NULL;
--> statement-breakpoint
DROP INDEX "student_learning_entry";
--> statement-breakpoint
DROP INDEX "student_revision_knowledge";
--> statement-breakpoint
CREATE UNIQUE INDEX "student_learning_entry" ON learning_entries USING btree (student_id, entry_key);
--> statement-breakpoint
CREATE UNIQUE INDEX "student_revision_knowledge" ON student_knowledge_states USING btree (student_id, knowledge_point);
