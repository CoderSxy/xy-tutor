# 知识点库替换教材输入与会话绑定 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 用管理员确认后的知识点库替换教材上传与解析，学生会话不再绑定年级、科目和教材，辅导按问题检索已发布知识点。

**Architecture:** 新增独立知识点模块（批次、解析任务、条目），不改写也不删除旧教材表。上传与抽取走现有文件存储和解析器，总结走现有 ModelGateway/JobQueue。学生新任务与会话不再写入教材版本；agent 用 `search_knowledge` 取代 `search_textbook`。

**Tech Stack:** TypeScript、React 19、React Router 7、Fastify 5、PostgreSQL、Drizzle、Zod、Vitest、Playwright；使用现有依赖，不新增基础设施。

**Spec:** [2026-11-10-knowledge-points-design.md](../specs/2026-11-10-knowledge-points-design.md)

## Global Constraints

- 真正入库并供辅导使用的是管理员确认后的标题和总结，不是原始上传分页或未确认稿。
- 一次上传可由 AI 拆成多条，须管理员确认后才变为 published；未发布条目对学生和检索不可见。
- 重新解析只生成 pending_review，不覆盖已发布正文；再次确认后就地更新该已发布条目的标题与总结，解析任务历史保留。
- 已发布知识点对所有学生开放，学生不用选择；agent 按问题自动检索，找不到依据时说明依据不足，不编造。
- 教材上传、解析和年级科目绑定一并下线；旧教材表、历史文件和旧会话数据保留，不对学生开放。
- 打开仍带旧 `revision_id` 的会话时按未绑定会话处理，不再查询或展示教材内容。
- 检索第一期只用标题和总结的关键词检索（参数化 ILIKE），每次返回少量最相关已发布条目；不做向量检索，不引入 zhparser。
- 学生资料上传保留，不替代知识点库；每日5练、巩固、错题、上传题目、自由提问入口保留，但不再按教材章节出题。
- 不把完整密钥、原始大文件或学生隐私写入仓库、日志或审计。
- 代码实现默认使用本机 Claude Code，模型走 https://api.nerosun.cn。
- 当前最大迁移编号以执行时 `packages/db/migrations` 为准（编写时为 `0019_insight_fact_indexes`）；不得 reset、覆盖或用 `git add .` 纳入无关改动。
- 本计划仅记录未来实现步骤；所有复选框初始未勾选，不表示测试已运行。

## Review Focus

- 未确认/已丢弃条目绝不能被学生检索或出现在辅导上下文；由任务 4/5/7 验证。
- 重新解析不得覆盖已发布正文，确认前学生仍看到旧内容；由任务 4 验证。
- 新任务、会话、题目、资料不再要求教材版本；旧会话打开不再查教材；由任务 6/7/10 验证。
- 教材管理、选择教材及相关 API 对学生和管理端新流程关闭，旧表仍在；由任务 8/11 验证。
- 模型未配置或解析失败不入库空条目；由任务 3 验证。

---

## 0. 执行前准备与依赖图

- [ ] 读取上述 Spec、`DESIGN.md`、`PRODUCT.md`、`apps/server/src/modules/catalog/**`、`apps/server/src/jobs/textbook-job.ts`、`apps/server/src/agent/{tools,context,prompts}.ts`、`apps/web/src/routes/StudyEntry.tsx`、`apps/web/src/routes/Home.tsx`。
- [ ] 记录 `git status --short` 基线与当前最大迁移编号；仅修改计划列出的文件及必要集成点。
- [ ] 运行 `pnpm typecheck`、`pnpm test:unit` 记录基线；集成测试只使用 withTestDb 的 `_test` 数据库。基线失败要区分现存问题与新改动。

依赖：1 → 2 → 3 → 4 → 5；1 → 6 → 7；4/5/6 → 8；4/8 → 9；6/7/8 → 10 → 11。按顺序执行即可。每个任务完成后只提交该任务文件。

## 共享接口与文件职责

下述名称是实施约定，任务 1 定义并导出类型；后续任务不得自行发明 DTO 字段名。

- `packages/contracts/src/knowledge-base.ts`：批次、解析任务、条目、检索协议及 Zod schemas。不要写入现有 `packages/db/src/schema/knowledge.ts`（那是学生掌握度，不是知识点库）。
- `packages/db/src/schema/knowledge-base.ts`：`knowledge_batches`、`knowledge_batch_files`、`knowledge_parse_runs`、`knowledge_items`。
- `packages/contracts/src/file-limits.ts`：为 `knowledge_source` 增加大小校验。
- `apps/server/src/modules/knowledge-base/service.ts`：创建批次、排队解析、列表、编辑、丢弃、确认、发起再解析、审计。
- `apps/server/src/modules/knowledge-base/parser.ts`：抽取可读文本、调用模型、校验 JSON 条目。
- `apps/server/src/modules/knowledge-base/search.ts`：仅检索 published 的标题和总结。
- `apps/server/src/modules/knowledge-base/routes.ts`：管理员 API；学生不可访问写接口。
- `apps/server/src/jobs/knowledge-parse-job.ts`：`knowledge.parse` 任务适配。
- `apps/web/src/routes/admin/Knowledge.tsx`、`KnowledgeReview.tsx`：管理端列表、上传、确认与再解析。
- `apps/web/src/features/knowledge-base/`：API hooks 与确认列表组件。

共享类型的最小字段约定：

```ts
type KnowledgeItemStatus = "pending_review" | "published" | "discarded";
type ParseRunStatus = "queued" | "processing" | "succeeded" | "failed";

type KnowledgeItemDTO = {
  id: string;
  batchId: string;
  parseRunId: string;
  title: string;
  summary: string;
  status: KnowledgeItemStatus;
  replacesItemId: string | null;
  publishedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

type KnowledgeParseRunDTO = {
  id: string;
  batchId: string;
  extraPrompt: string | null;
  model: string | null;
  status: ParseRunStatus;
  errorCode: string | null;
  itemCount: number;
  createdAt: string;
  completedAt: string | null;
};

type KnowledgeBatchDTO = {
  id: string;
  textContent: string | null;
  files: { fileId: string; name: string; contentType: string }[];
  latestRun: KnowledgeParseRunDTO | null;
  pendingCount: number;
  publishedCount: number;
  createdAt: string;
};

type KnowledgeSearchHit = {
  id: string;
  title: string;
  summary: string;
};

const createBatchInput = z.object({
  text: z.string().trim().max(50_000).optional(),
  fileIds: z.array(z.uuid()).max(10).default([]),
  extraPrompt: z.string().trim().max(4000).optional(),
}).strict().refine((v) => Boolean(v.text) || v.fileIds.length > 0, {
  message: "请提供文本或文件",
});

const editItemInput = z.object({
  title: z.string().trim().min(1).max(200),
  summary: z.string().trim().min(1).max(20_000),
}).strict();

const reparseInput = z.object({
  extraPrompt: z.string().trim().min(1).max(4000),
  replacesItemId: z.uuid().optional(),
}).strict();

const searchInput = z.object({
  keywords: z.string().trim().min(1).max(255),
  limit: z.number().int().min(1).max(8).default(5),
}).strict();
```

标题最长 200 字，总结最长 20,000 字；单次解析最多接受 30 条，超出截断并在管理端说明。`fileTooLarge` 的 purpose 增加 `"knowledge_source"`：PDF 上限与资料相同（`MAX_MATERIAL_PDF_BYTES`），其他类型 10MiB。允许 MIME：`text/plain`、`text/markdown`、`application/pdf`、`image/jpeg`、`image/png`、`image/webp`。

### Task 1: 契约、表结构和上传限制

**Files:** Create `packages/contracts/src/knowledge-base.ts`、`packages/db/src/schema/knowledge-base.ts`、`tests/unit/knowledge-base-contracts.test.ts`、`tests/integration/knowledge-base-schema.test.ts`；Create migration `packages/db/migrations/<next>_knowledge_base.sql` 并更新 journal；Modify `packages/contracts/src/file-limits.ts`、`tests/unit` 中现有 file-limits 测试（若有）、必要时 `packages/contracts` 的导出入口。

**Interfaces:** Produces 上述共享类型与 Zod schemas；迁移创建四张表：

- `knowledge_batches(id uuid pk, actor_id uuid not null references users(id), text_content text, created_at timestamptz not null default now())`
- `knowledge_batch_files(batch_id uuid not null references knowledge_batches, file_id uuid not null references files, position int not null, unique(batch_id, file_id), unique(batch_id, position))`
- `knowledge_parse_runs(id uuid pk, batch_id uuid not null references knowledge_batches, extra_prompt text, model text, status text not null, error_code text, created_at timestamptz not null default now(), completed_at timestamptz)`
- `knowledge_items(id uuid pk, batch_id uuid not null references knowledge_batches, parse_run_id uuid not null references knowledge_parse_runs, title text not null, summary text not null, status text not null, replaces_item_id uuid references knowledge_items, published_at timestamptz, created_at timestamptz not null default now(), updated_at timestamptz not null default now())`

索引：`knowledge_items(status, updated_at desc)`、`knowledge_parse_runs(batch_id, created_at desc)`。status 用 check 约束限制为约定枚举。不修改、不删除教材旧表。

- [ ] 写单测：`createBatchInput` 拒绝空提交和超长文本；`editItemInput` 拒绝空标题/空总结；`fileTooLarge('knowledge_source', 'application/pdf', MAX_MATERIAL_PDF_BYTES)` 为 true，小于上限为 false。
- [ ] 运行 `pnpm test:unit tests/unit/knowledge-base-contracts.test.ts`，确认因缺实现失败。
- [ ] 实现 contracts 与 file-limits 扩展；编写增量迁移和 Drizzle schema，确认 next 编号不冲突。
- [ ] 写 schema 集成用例：非法 status 被拒绝；同一 batch 重复 file_id 被拒绝；`replaces_item_id` 只能引用已有条目；空库可创建批次和 run。
- [ ] 运行 `pnpm test:integration tests/integration/knowledge-base-schema.test.ts` 及上述单测，预期全通过；不执行生产迁移。
- [ ] 精确提交 `feat: add knowledge base contracts and storage`。

### Task 2: 管理员上传并排队解析

**Files:** Create `apps/server/src/modules/knowledge-base/service.ts`、`routes.ts`、`tests/integration/knowledge-base-upload.test.ts`；Modify `apps/server/src/modules/uploads/contracts.ts`、`apps/server/src/modules/uploads/service.ts`、`apps/server/src/app.ts`、`packages/contracts` 中 uploads purpose 枚举（若与 uploads contracts 重复则以 uploads 为准并保持一致）。

**Interfaces:** Produces `KnowledgeBaseService.createBatch(actor, input): Promise<KnowledgeBatchDTO>`、`.getBatch(actor, batchId): Promise<KnowledgeBatchDTO>`、`.listBatches(actor, page): Promise<{items:KnowledgeBatchDTO[];total:number}>`；`registerKnowledgeBase(app, deps)`。`createBatch` 在同一事务中插入 batch、关联已 ready 且 purpose=`knowledge_source` 的文件、插入 status=`queued` 的 parse run，并入队 `kind: "knowledge.parse"`、`dedupeKey: "knowledge.parse:"+runId`。模型未配置时仍创建 run，但 status=`failed`、`errorCode='MODEL_NOT_CONFIGURED'`，不入队，不插入 items。

管理员 API（均需 session + requireAdmin）：

- `POST /api/admin/knowledge/batches`
- `GET /api/admin/knowledge/batches`
- `GET /api/admin/knowledge/batches/:id`

- [ ] 写测试：学生 403、无会话 401；无文本且无文件 422；文件 purpose 不是 `knowledge_source` 或未 ready 为 409；文件类型不在白名单 422；创建后可取到 batch 且有 queued run；模型未配置时 run 为 failed 且 items 为空。
- [ ] 运行 `pnpm test:integration tests/integration/knowledge-base-upload.test.ts`，确认失败。
- [ ] 扩展上传 purpose 与大小/MIME 校验；实现 service/routes 并接入 `buildApp`。审计 `knowledge.batch.create`，不记录文件二进制和密钥。
- [ ] 重跑该测试及既有 `tests/integration/uploads.test.ts`，预期全通过。
- [ ] 精确提交 `feat: queue admin knowledge parse batches`。

### Task 3: 解析任务抽取并生成待确认条目

**Files:** Create `apps/server/src/modules/knowledge-base/parser.ts`、`apps/server/src/jobs/knowledge-parse-job.ts`、`tests/unit/knowledge-parse.test.ts`、`tests/integration/knowledge-parse-job.test.ts`；Modify `apps/server/src/app.ts` 注册 `knowledge.parse` handler。

**Interfaces:** Produces `parseKnowledgeRun(db, gateway, uploads, runId, signal): Promise<void>`、`extractBatchText(batch, reader): Promise<string>`、`proposeKnowledgeItems(text, extraPrompt): Promise<{title:string;summary:string}[]>`。模型系统提示要求只输出 JSON `{items:[{title,summary}]}`，使用中文，依据给定材料拆分知识点，不能编造材料中不存在的内容。用 `ModelGateway.complete`，priority=`background`。成功后将 run 标 succeeded，插入 pending_review 条目；失败标 failed 并写入 errorCode，不插入空条目。若本次 run 带 `replacesItemId`（任务 4 写入 payload/关联），新条目必须带上该指针，且不得修改被替换条目的正文。

抽取：纯文本直接使用；`text/plain` 与 `text/markdown` 读文件字节为 UTF-8；PDF/图片复用 `apps/server/src/jobs/parsers/pdf-process.ts` 与现有 OCR（若未配置 OCR，扫描件失败原因为 `OCR_NOT_CONFIGURED` 或与资料解析一致的现有错误码）。抽取文本最长拼接 80,000 字，超出截断并继续解析。单次最多写入 30 条。

- [ ] 单测：合法 JSON 解析为多条；非 JSON/缺 title/空 items 判定失败；超过 30 条只保留 30。运行单测确认先失败再实现纯函数。
- [ ] 集成测试：假 gateway 返回两条则库中两条 pending_review；gateway 抛错则 run failed、items 为 0；OSS 未配置对需要读文件的批次失败且无条目；只含文本的批次不依赖 OSS。
- [ ] 运行 `pnpm test:integration tests/integration/knowledge-parse-job.test.ts`，确认失败后实现 handler 并注册。
- [ ] 模型未配置的失败路径保持任务 2 行为，不调用 gateway。重跑解析与上传测试，预期全通过。
- [ ] 精确提交 `feat: parse knowledge uploads into review items`。

### Task 4: 管理员确认、修改与再解析

**Files:** Modify `service.ts`、`routes.ts`；Create `tests/integration/knowledge-base-review.test.ts`。

**Interfaces:** Produces

- `listItems(actor, query:{status?,q?,limit,offset}): Promise<{items:KnowledgeItemDTO[];total:number}>`
- `updateItem(actor, id, editItemInput): Promise<KnowledgeItemDTO>`（pending_review 或 published 可改标题和总结；discarded 不可改）
- `discardItems(actor, ids:string[]): Promise<void>`（仅 pending_review → discarded）
- `publishItems(actor, ids:string[]): Promise<KnowledgeItemDTO[]>`（pending_review → published。若条目带 `replacesItemId` 且指向已发布条目：就地更新原条目的 title/summary/updated_at，将确认稿标为 discarded 并保留 `replaces_item_id` 指针。学生检索只看到原条目的最新内容；parse run 历史仍可从 batch 查看）
- `reparseBatch(actor, batchId, {extraPrompt}): Promise<KnowledgeParseRunDTO>`
- `reparsePublished(actor, itemId, {extraPrompt}): Promise<KnowledgeParseRunDTO>`（创建新 run，payload 含 `replacesItemId`，不改已发布正文）

API：

- `GET /api/admin/knowledge/items`
- `PATCH /api/admin/knowledge/items/:id`
- `POST /api/admin/knowledge/items/discard`
- `POST /api/admin/knowledge/items/publish`
- `POST /api/admin/knowledge/batches/:id/reparse`
- `POST /api/admin/knowledge/items/:id/reparse`

- [ ] 写测试：确认后 status=published 且 student 检索（可先直接 SQL/将在任务 5 复用 search）可见；丢弃后不可发布；改已发布总结立即反映；再解析生成新 pending 且旧 published 正文不变；确认替换后检索只命中新总结；学生调用这些 API 403。
- [ ] 运行 `pnpm test:integration tests/integration/knowledge-base-review.test.ts`，确认失败。
- [ ] 实现确认/编辑/再解析；审计 `knowledge.item.publish`、`knowledge.item.update`、`knowledge.reparse`，不写完整原文到审计 details。
- [ ] 重跑 review/upload/parse 测试，预期全通过。
- [ ] 精确提交 `feat: allow admin review and republish of knowledge`。

### Task 5: 已发布知识点检索

**Files:** Create `apps/server/src/modules/knowledge-base/search.ts`、`tests/integration/knowledge-search.test.ts`。

**Interfaces:** Produces `searchPublishedKnowledge(db, input:{keywords:string;limit:number}): Promise<KnowledgeSearchHit[]>`。SQL 使用参数化 `ILIKE '%' || escapeLike(keywords) || '%'` 同时匹配 title、summary；先按 title 命中再按 updated_at desc；`limit` 默认 5。只查 `status='published'`。不新增学生专用 HTTP 检索入口（由 agent 工具调用）；如需管理端试检索，可复用同一函数但不在本任务暴露给学生。

- [ ] 写测试：pending/discarded 不会命中；标题或总结包含关键词可命中；特殊字符 `%`/`_` 按字面匹配；limit 生效；空库返回 `[]`。
- [ ] 运行 `pnpm test:integration tests/integration/knowledge-search.test.ts`，确认失败。
- [ ] 实现 escapeLike 与查询；重跑该测试，预期全通过。
- [ ] 精确提交 `feat: search published knowledge by keywords`。

### Task 6: 会话与任务解除教材绑定

**Files:** Create migration `packages/db/migrations/<next>_unbind_revision.sql`；Modify `packages/db/src/schema/{conversations,learning,questions,materials,entries,knowledge}.ts`、`apps/server/src/modules/learning/{contracts,tasks}.ts`、`apps/server/src/modules/conversations/**` 中创建/读取会话处、`apps/server/src/modules/materials/service.ts`、题目创建路径、`tests/unit/session-start.test.ts`、`tests/integration/tutor.test.ts`、`tests/integration/selections.test.ts` 及所有因 NOT NULL 失败的学习测试。

**Interfaces:** 将下列列改为可空，保留对 `textbook_revisions` 的外键：`conversations.revision_id`、`learning_tasks.revision_id`、`questions.revision_id`、`materials.revision_id`、`learning_entries.revision_id`、`knowledge_observations.revision_id`、`student_knowledge_states.revision_id`。`learning_entries` 唯一约束改为 `(student_id, entry_key)`，迁移前若有冲突保留 `selected_at`/创建时间最新的一行。`student_knowledge_states` 唯一约束改为 `(student_id, knowledge_point)`，重复时保留 `updated_at` 最新的一行。`taskInput.revisionId` 与 `chapterId` 改为可选并忽略传入的教材/章节（或 422 拒绝仍按教材绑定的旧客户端字段——采用忽略并写 null，避免旧前端卡死）。`TaskService.create` / 会话插入不再校验教材发布状态，revision 写 null。`TaskService` 与 Message/Run 读取允许 revision 为空。

- [ ] 写/改测试：不传 revisionId 可创建任务和会话；传入旧 revisionId 也被当作未绑定（写入 null）；旧会话行仍带 revision_id 时可打开且不请求教材详情。
- [ ] 运行相关 unit/integration，确认先因 schema/服务仍要求教材而失败。
- [ ] 编写迁移与服务改动；更新 fixtures，不再强制插入教材即可开会话。
- [ ] 重跑 `pnpm test:unit tests/unit/session-start.test.ts`、`pnpm test:integration tests/integration/tutor.test.ts tests/integration/selections.test.ts tests/integration/uploads.test.ts tests/integration/learning-records.test.ts`（若文件名略有不同，以仓库现有测试为准），预期全通过。
- [ ] 精确提交 `feat: unbind learning sessions from textbooks`。

### Task 7: Agent 按问题检索知识点

**Files:** Modify `apps/server/src/agent/tools.ts`、`context.ts`、`prompts.ts`、`bootstrap.ts`、`tutor.ts`/`runs.ts` 中 bound.revisionId 用法、`tests/unit/provider.test.ts`（若涉及工具列表）、`tests/integration/tutor.test.ts`。

**Interfaces:** `createTeachingTools` 的 bound 改为 `{scope,taskId,runId,revisionId?: string | null}`。删除或停用 `search_textbook`，新增 `search_knowledge`（label：`检索已发布知识点`），参数为 `searchInput`，内部调用 `searchPublishedKnowledge`，返回 `{status:'found'|'insufficient_evidence', items:KnowledgeSearchHit[]}`。`get_material_question` 不再用 `q.revision_id=$revisionId` 过滤，改为 `q.student_id=$studentId`。`buildContext` 的 `TutorContext.revisionId` 改为可选；systemContext 用 `知识点检索说明` 替代 `教材` 对象，不再调用 `catalog.getRevision`。`tutorPrompt` 改为依据 `search_knowledge` 实际返回的条目 ID，不引用教材、年级、科目绑定；找不到依据须说明依据不足。

- [ ] 写测试：工具只返回 published；上下文不含教材字段；无命中时工具 status 为 insufficient_evidence；创建无 revision 的 run 可启动（可用现有 tutor 集成夹具改造）。
- [ ] 运行对应单测/集成，确认失败。
- [ ] 实现工具与提示词替换；扫一遍 agent 模块中的 `revisionId` 必要路径并改为可选。
- [ ] 重跑 tutor/agent 测试，预期全通过。
- [ ] 精确提交 `feat: retrieve published knowledge in tutoring agent`。

### Task 8: 下线教材与选择入口的 API

**Files:** Modify `apps/server/src/modules/catalog/routes.ts`、`apps/server/src/modules/learning/selections.ts` 及对应 routes、`tests/integration/selections.test.ts`、`tests/e2e/fixtures` 中仍调用教材 API 的帮助函数。

**Interfaces:** 对学生关闭：`GET /api/catalog/textbooks`、`GET /api/catalog/textbooks/:id`、`GET /api/catalog/textbooks/:id/pages`、选择教材的 POST/GET（现有 `/api/selections` 或实际路径以代码为准）一律对已登录学生返回 410，body 使用现有 AppError 码（如 `GONE`）和中文说明「教材选择已下线，请直接开始学习」。管理端 ` /api/admin/textbooks**` 同样 410，引导改用知识点接口。不要 drop 旧表，不要删除 CatalogService 内部方法（解析任务下线即可不再从新路由触发 `textbook.parse`）。本任务不删除历史数据。

- [ ] 写测试：学生和管理员调用上述入口得到 410；知识点 API 仍可用；直接查询旧教材表（测试库插入的历史行）仍然存在。
- [ ] 运行相应 integration，确认失败后改路由。
- [ ] 更新仍依赖教材列表的测试夹具，改为知识点或不依赖目录。
- [ ] 精确提交 `feat: retire textbook selection and admin catalog APIs`。

### Task 9: 管理端知识点界面

**Files:** Create `apps/web/src/routes/admin/Knowledge.tsx`、`KnowledgeReview.tsx`、`apps/web/src/features/knowledge-base/` 下的 api hook 与列表/确认组件；Modify `apps/web/src/App.tsx`、`apps/web/src/components/AppShell.tsx`；旧 `Textbooks.tsx`/`TextbookReview.tsx` 从路由移除，文件可保留但不再挂路由。

**Interfaces:** 路由 `/admin/knowledge` 列表与上传；`/admin/knowledge/:batchId` 确认页；已发布条目可在列表筛选 `status=published` 并编辑、再解析。导航文案由「教材管理」改为「知识点」。解析中展示 run 状态与失败原因；确认页支持改标题/总结、丢弃、补提示词再解析、批量确认。沿用现有管理端视觉与 `UploadInput`（purpose 改为 `knowledge_source`，允许文本框）。

- [ ] 用现有前端测试方式补充管理端 e2e 或组件级测试（参考 `tests/e2e/content-ui.spec.ts` / admin 教材相关用例）：上传文本后出现待确认条目、确认后出现在已发布列表。若 e2e 需要后端夹具，放到任务 11 一并跑通，本任务至少保证路由与导航替换并可用手册验收路径。
- [ ] 实现页面并替换导航；`/admin/textbooks` 重定向到 `/admin/knowledge`。
- [ ] 精确提交 `feat: add admin knowledge base UI`。

### Task 10: 学生端去掉教材选择并直接学习

**Files:** Modify `apps/web/src/App.tsx`、`apps/web/src/routes/Home.tsx`、`apps/web/src/routes/StudyEntry.tsx`、`apps/web/src/lib/auth.tsx`（或实际保存 selected textbook 的 context）、`apps/web/src/components/SessionRail.tsx`、`apps/web/src/features/tutor/**` 中 revisionId 传递；相关 unit/e2e。

**Interfaces:** 删除 `RequireTextbook` 对首页的包裹；`/` 登录后直接渲染 `Home`。`/select` 重定向到 `/`。`Home` 创建任务不再传 `revisionId`。SessionRail 拉任务列表不再带 `revisionId`。清理 auth/catalog 中的 selected textbook 状态。学生入口文案不再要求先选教材。

- [ ] 改写 `tests/e2e/selections.spec.ts` 为：登录后无需选择即可看到学习入口；访问 `/select` 回到首页。同步修改 `tests/e2e/learning-journey.spec.ts`、`tutor-ui.spec.ts` 等仍先选教材的步骤。
- [ ] 实现前端解绑；本地能打开首页并创建自由提问任务。
- [ ] 精确提交 `feat: start tutoring without textbook selection`。

### Task 11: 端到端验收与文档

**Files:** Modify `tests/e2e/**` 仍失败的用例、`README.md`、`PRODUCT.md`、`docs/architecture.md`、`docs/runbooks/**` 中教材上传/选择描述改为知识点库；必要时 `docs/qa` 增加短验收记录。不把真实密钥写入文档。

**Interfaces:** 无新公共 API。验收路径与 Spec §8 对齐。

- [ ] 补/跑关键 e2e 与 `pnpm test`、`pnpm typecheck`、`pnpm lint`。覆盖：一次上传拆多条并确认；修改总结后检索更新；再解析不覆盖直至再次确认；未发布不可检索；学生不经选择即开会话；答疑/出题走 `search_knowledge`（可用测试夹具断言工具调用或检索结果进入回复依据）；教材入口 410 或重定向；旧表仍在。
- [ ] 更新文档中的本地启动步骤：管理员改为上传知识点并确认，学生不再选教材。
- [ ] 精确提交 `docs: describe knowledge base tutoring workflow`（若本任务含测试修复，可拆成 `test:` 与 `docs:` 两次提交，但仍属本任务）。

