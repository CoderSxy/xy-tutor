# XY Tutor MVP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 构建可在现有 ECS 上运行、基于 pi 的三端教学应用，完成教材发布、主动教学、私有资料上传、错题证据与跨会话恢复的初版闭环。

**Architecture:** React 静态前端由 Caddy 提供；一个 Node.js/Fastify 进程承载业务、pi 和轻量后台调度，PostgreSQL 保存业务事实和任务。OSS 保存原件，外部供应商提供模型与 OCR；重 PDF 解析使用受限子进程。

**Tech Stack:** TypeScript、React/Vite、Tailwind/shadcn/ui、Fastify、pi-agent-core/pi-ai、Drizzle/node-postgres、PostgreSQL、阿里云 OSS、Vitest、Playwright、Docker Compose/Caddy。

**Spec:** `docs/superpowers/specs/2026-11-08-xy-tutor-mvp-design.md`（用户于 2026-11-08 确认）。

## Global Constraints

- 当前 ECS：Ubuntu 24.04、2 vCPU、2GiB RAM、40GB 磁盘；公网带宽、实例族和当前剩余资源尚未确认。
- LLM 通过供应商 API 调用，不在 ECS 部署本地模型。
- 使用 pi 构建教学 Agent；PostgreSQL 为业务主数据库；阿里云 OSS 保存原始文件。
- PC、Pad、手机均可使用；UI 需要美化、统一风格。
- 错题历史、当前状态、Agent 辅助记忆分别保存并相互关联。初版不接腾讯 L0–L3 Memory。
- 全局交互 Agent 并发2；每会话1；后台任务并发1。交互优先，模型总调用并发2，后台解析不得抢占全部模型配额。
- PG 连接池 max=5；保守设置 shared_buffers/work_mem，避免每连接内存叠加。
- Node old-space 初始384MiB，容器内存约640MiB；PG 约512MiB；解析子进程额外预算≤256MiB、最多1个。这是初始限额，不是实测占用，Node 原生内存与 buffer 也计入监控。
- 邀请制、一账号先对应一个学生；管理员不自动拥有学生私有资料访问权。
- 所有私有访问在服务端校验；模型不能选择访问主体、执行 shell、任意 SQL 或任意 URL 抓取。
- 消息/题目/作答保留版本；不保存模型内部思维链；不确定判题不更新学习状态。
- 生成题目和作答核验按设计 8.3 执行；pi 只能提交候选评估，业务层决定 verified。
- 初始断点：<768px 手机，768–1199px 紧凑布局，≥1200px 桌面。按实际容器宽度适配，Pad 分屏可进入手机布局；不做设备 UA 判断。
- 主要触控目标≥44×44 CSS px；正文对比度目标≥4.5:1；尊重 reduced-motion。
- 文本/扫描 PDF、图片全部走真实处理接口；夹具通过不等于真实供应商或真机验收通过。
- 执行前读取适用 AGENTS.md；当前项目只有设计文档、尚无 Git。使用当前目录，不因命名另建 worktree；如需隔离按原生 worktree 工具和 skill 执行。

## Review Focus

1. 两个浏览器/设备同时操作同一任务：一个 run 有效，冲突明确，刷新不能多出题；Task 9、10、19 加测试。
2. 教材停用/升级发生在学生学习中：旧引用仍可读取，新入口不再提供停用修订；Task 7、8 加测试。
3. 学生更正曾被误识别的答案/题干：追加版本，失效证据不能继续支撑“已掌握”；Task 12、14、15 加测试。
4. 扫描页超大、文件伪装、解析进程崩溃：受限失败并可重试，不拖死聊天、不产生重复题目；Task 5、6、12、20 加测试。
5. 弱网、移动键盘和长公式共同出现：输入可用、部分回复可恢复、页面不被撑宽；Task 10、17、19 加测试及真机记录。

---

## 执行顺序、命令和类型约定

本项目的模块共享学生权限、题目版本和证据事务，采用一份顺序主计划，任务按独立可审阅产物拆分；不将共享 schema 当成互不依赖的并行项目。顺序为 1→2→3→4→…→20。Task 16 的视觉选择可以在早期讨论，但落地组件在该任务执行。每项通过自己的检查后提交一次，不在失败状态推进。

Task 1 建立根脚本：`pnpm typecheck`、`pnpm lint`、`pnpm build`、`pnpm test:unit`、`pnpm test:integration`、`pnpm test:e2e`、`pnpm db:migrate`、`pnpm smoke:provider`、`pnpm smoke:oss`。测试分别使用 `vitest.unit.config.ts`、`vitest.integration.config.ts`、`playwright.config.ts`。文中 `pnpm exec vitest run --config <config> <file>` 从仓库根执行。集成测试使用专用 TEST_DATABASE_URL；拒绝与生产 DATABASE_URL 相同的库，按测试创建隔离 schema 并迁移。没有配置时明确失败/标为未验证，不假装通过。

`packages/contracts/src/domain.ts` 定义：UUID=string（运行时 UUID 校验）、Instant=ISO8601 string、Actor={userId,role:'admin'|'student'}、StudentScope={actor,studentId}、EvidenceRef={kind,id,versionId?}。服务入参为已校验 DTO，返回 Promise；只有纯规则函数例外。数据库行不得直接返回给前端。测试时钟由 `Clock.now(): Date` 注入，生产只使用系统时钟。

通用错误：UNAUTHENTICATED/401、FORBIDDEN/403、NOT_FOUND/404（隐藏未授权私有对象是否存在）、CONFLICT/409、VALIDATION/422、RATE_LIMITED/429、UPSTREAM_UNAVAILABLE/503。后台状态失败有可展示错误码，不把堆栈展示给用户。

## 文件地图

| 路径 | 职责 | 所属任务 |
|---|---|---|
| `package.json`, `pnpm-workspace.yaml`, `tsconfig.base.json`, `.env.example`, `.gitignore` | 工作区、脚本、环境规范 | 1 |
| `apps/server/src/app.ts`, `config.ts`, `infra/{db,clock,logging}.ts` | 可注入应用与基础设施 | 1–2 |
| `packages/contracts/src/{domain,api,agent}.ts` | 共享 DTO、事件与错误契约 | 1、9–11 |
| `packages/db/src/schema/*.ts`, `packages/db/migrations/` | 按业务域增量迁移 | 各拥有任务 |
| `apps/server/src/modules/auth/` | 身份、授权、邀请、访问授权 | 3 |
| `apps/server/src/agent/` | 模型适配、上下文、pi 工具和执行 | 4、11、13 |
| `apps/server/src/modules/{uploads,catalog,materials}/` | 文件、教材、私有资料 | 5–8、12 |
| `apps/server/src/jobs/` | 持久任务、解析与摘要 | 6、7、12、15 |
| `apps/server/src/modules/{learning,conversations}/` | 任务、会话、作答、状态与事件 | 9–15 |
| `apps/web/src/{routes,features,components,styles}/` | 三端界面和设计规范落地 | 16–18 |
| `tests/{unit,integration,e2e,fixtures}/` | 分层测试与合成资料夹具 | 各任务 |
| `infra/`, `scripts/`, `docs/runbooks/` | 部署、冒烟、资源验证和恢复说明 | 1、4、5、20 |

新增或修改已有文件时保留前序接口；迁移目录文件由 Drizzle 生成实际编号，不手工捏造将来的 hash 文件名。每项 Files 以该任务拥有的路径为提交范围，避免 `git add .` 纳入凭据或无关产物。

### Task 1: 可运行工作区和 API 健康检查

**Files:** Create `package.json`, `pnpm-workspace.yaml`, `tsconfig.base.json`, `.gitignore`, `.env.example`, `vitest.unit.config.ts`, `vitest.integration.config.ts`, `playwright.config.ts`, `apps/server/package.json`, `apps/server/src/{app,config}.ts`, `packages/contracts/src/{domain,api}.ts`, `tests/unit/config.test.ts`, `tests/integration/health.test.ts`, `README.md`。

**Interfaces:** `loadConfig(env: Record<string,string|undefined>): AppConfig`；`buildApp(deps: AppDependencies): FastifyInstance`；`GET /api/health/live → {status:'ok'}`。后续通过注册模块扩展 `buildApp`，不能 import 即监听端口。

- [ ] 初始化 Git（如仍不存在），设置 pnpm workspace、受支持 Node LTS、精确直接依赖版本和锁文件；建立上述脚本及 lint/typecheck。新增最小 web Vite package 满足构建，不先实现 UI。
- [ ] 写配置与健康测试：`expect(() => loadConfig({NODE_ENV:'production'})).toThrow()`；`expect((await app.inject('/api/health/live')).statusCode).toBe(200)`；测试不得输出密钥。
- [ ] 运行 `pnpm exec vitest run --config vitest.unit.config.ts tests/unit/config.test.ts`，确认缺少配置实现导致预期失败，再实现校验、JSON 错误和可注入应用。
- [ ] 运行上述单测及 `pnpm exec vitest run --config vitest.integration.config.ts tests/integration/health.test.ts`、`pnpm typecheck`、`pnpm build`；全部成功。将脚本命令和 env 说明写 README。
- [ ] `git add` 仅本任务 Files、生成锁文件和已批准设计/计划，`git commit -m "chore: initialize typed workspace and health endpoint"`。

### Task 2: PG 连接、迁移和隔离测试环境

**Files:** Create `packages/db/package.json`, `packages/db/src/{client,index}.ts`, `packages/db/drizzle.config.ts`, `apps/server/src/infra/{db,clock,logging}.ts`, `tests/helpers/database.ts`, `tests/integration/database.test.ts`, `infra/compose.dev.yaml`；Modify `apps/server/src/app.ts`, `.env.example`。

**Interfaces:** `createDb(url: string): {db: Db;close(): Promise<void>}`（pool max=5）；`withTestDb(run: (db: Db)=>Promise<void>): Promise<void>`；`Clock.now(): Date`；`GET /api/health/ready` 依赖 PG。

- [ ] 写集成测试 `test_database_isolation`、`test_ready_fails_when_pg_unavailable`；断言隔离 schema 无其他测试行、PG断开时 readiness=503、pool max=5。
- [ ] 启动 `docker compose -f infra/compose.dev.yaml up -d postgres`；运行 database 测试，确认接口未实现失败。
- [ ] 实现连接生命周期、迁移入口、测试库 URL 防误用、日志敏感字段 redaction 和 Clock；设计 schema 按后续任务逐步加入。
- [ ] 运行 `pnpm db:migrate` 及 database 测试，确认空库迁移、重复迁移和清理均成功；连接池能关闭，无悬挂进程。
- [ ] 提交本任务文件与迁移框架：`git commit -m "feat: add PostgreSQL infrastructure and isolated tests"`。

### Task 3: 邀请登录、学生档案与显式访问授权

**Files:** Create `packages/db/src/schema/auth.ts`, `apps/server/src/modules/auth/{service,policy,routes,passwords}.ts`, `scripts/create-admin.ts`, `tests/integration/auth.test.ts`；Modify `packages/contracts/src/api.ts`, `apps/server/src/app.ts`；Generate migration。

**Interfaces:** `requireStudentAccess(actor: Actor, studentId: UUID): Promise<StudentScope>`；`requireAdmin(actor: Actor): void`；`AuthService.invite(actor,input): Promise<{activationToken:string}>`、`activate(input)`、`login(input)`、`grantAccess(ownerScope,input)`、`revokeAccess(ownerScope,input)`、`issuePasswordReset(admin,input)`。输入 DTO 写在本模块 `contracts.ts` 并导出。会话 Cookie 由 routes 设置。

- [ ] 写 `invite_token_is_single_use`、`expired_token_rejected`、`admin_has_no_implicit_student_access`、`grant_revoke_is_audited`、`foreign_origin_write_rejected`、`login_rate_limited`；断言 401/403/404、授权撤销即时生效、PG 只存 token hash。
- [ ] 运行 auth 集成测试确认预期失败。
- [ ] 实现 users/session/invitations/student_profiles/student_access/audit schema、scrypt、邀请和重置凭据单次消费、同源 Cookie/CSRF。初始管理员通过 CLI 创建，普通账号激活时事务创建一份学生档案；提供资料 GET/PATCH 和授权管理 API。
- [ ] 运行 auth 集成测试与 typecheck；测试 `reset_invalidates_existing_sessions`、学生能修改进度/偏好、不能提升角色；CLI 不打印密码。
- [ ] 提交精确变更与迁移：`git commit -m "feat: add invited accounts and scoped student access"`。

### Task 4: pi 模型适配、调用限额与真实冒烟入口

**Files:** Create `apps/server/src/agent/{provider,model-budget,capabilities}.ts`, `packages/contracts/src/agent.ts`, `scripts/smoke-provider.ts`, `tests/unit/provider.test.ts`, `tests/fixtures/provider-events.ts`；Modify `.env.example`, `package.json`。

**Interfaces:** `ModelGateway.stream(request: ModelRequest, signal: AbortSignal): AsyncIterable<ModelEvent>`；`ModelGateway.complete(request,signal): Promise<ModelResult>`；`ModelBudget.withPermit<T>(priority:'interactive'|'background',run:()=>Promise<T>): Promise<T>`；`probeCapabilities(): Promise<CapabilityReport>`。ModelRequest/ModelEvent/ModelResult 在 contracts/agent 定义，覆盖 text、tool_call、usage、finish，不暴露 reasoning。

- [ ] 写 `provider_maps_text_and_tools`、`reasoning_is_not_persistable`、`cancel_aborts_upstream`、`global_model_limit_is_two`；`expect(maxObservedCalls).toBeLessThanOrEqual(2)`。
- [ ] 运行 provider 单测确认失败。
- [ ] 核验可安装的 pi 配套版本并锁定，封装 custom provider 配置、超时/输出限制/取消与调用优先级。供应商报错返回可恢复错误，不返回假成功。
- [ ] 单测和 typecheck 通过；执行 `pnpm smoke:provider` 验证真实流、工具调用、图像能力、取消。没有凭据时明确列为外部依赖，保留失败报告，不能写“真实接入通过”。
- [ ] 提交 `git commit -m "feat: integrate pi model gateway and bounded calls"`。

### Task 5: OSS 授权直传与私有文件生命周期

**Files:** Create `packages/db/src/schema/files.ts`, `apps/server/src/infra/oss.ts`, `apps/server/src/modules/uploads/{contracts,service,routes}.ts`, `scripts/smoke-oss.ts`, `tests/integration/uploads.test.ts`；Generate migration。

**Interfaces:** `FileStore.signUpload(input): Promise<UploadGrant>`、`head(key): Promise<ObjectMetadata>`、`signDownload(key,ttlSeconds): Promise<string>`；`UploadService.create(actor,input)`、`complete(actor,fileId)`、`getDownload(actor,fileId)`。UploadGrant 含 server-generated key、uploadId、expiresAt、所需字段；下载 TTL=300秒（实施默认值）。

- [ ] 写 `student_cannot_sign_other_students_key`、`admin_cannot_download_private_file_without_grant`、`fake_mime_rejected`、`oversize_rejected`、`complete_callback_is_idempotent`。
- [ ] 运行 uploads 测试确认失败。
- [ ] 实现 files ownership/purpose、短期直传、完成后 HEAD+文件头校验；图≤10MB、PDF≤30MB，未知格式拒绝。签名对象不可由客户端任意指定；撤销授权后不能签发新下载地址，旧链接最多300秒失效。OSS CORS 配置写入运行说明。
- [ ] 运行集成测试；真实 `pnpm smoke:oss` 上传/验证/授权下载/清理合成文件，不打印签名 URL。失败对象标为 rejected，定期清理孤立上传。
- [ ] 提交 `git commit -m "feat: add private OSS upload and download authorization"`。

### Task 6: 持久任务、受限 PDF 解析与 OCR 适配

**Files:** Create `packages/db/src/schema/jobs.ts`, `apps/server/src/jobs/{queue,runner,limits}.ts`, `apps/server/src/jobs/parsers/{pdf-process,pdf-child,ocr}.ts`, `tests/integration/jobs.test.ts`, `tests/unit/parsers.test.ts`, `tests/fixtures/documents/`；Generate migration。

**Interfaces:** `JobQueue.enqueue(tx,input:{kind,dedupeKey,payload}): Promise<UUID>`、`claim(workerId,now)`、`heartbeat(jobId,leaseToken)`、`finish(jobId,leaseToken,result)`、`fail(jobId,leaseToken,error)`；`parseDocument(input:{fileId,signal}): AsyncIterable<ParsedPage>`；`OcrProvider.recognize(input,signal): Promise<RecognizedPage>`。schema 定义 ParsedPage={pdfPageIndex,printedPageLabel?,text,regions,status}。

- [ ] 写 `expired_lease_is_reclaimed`、`only_current_lease_can_finish`、`dedupe_key_prevents_duplicate_job`、`background_concurrency_is_one`、`pdf_over_100_pages_rejected`、`parser_crash_does_not_block_api`。
- [ ] 运行 jobs 集成与 parsers 单测，确认预期失败。
- [ ] 用 PG `FOR UPDATE SKIP LOCKED`、lease token/心跳实现领取，退避最多3次；选择维护中的 PDF 库在子进程按页提取/渲染，限制256MiB、1进程、每页处理超时，扫描页接外部 OCR。校验解压后图像尺寸，失败页可追溯；磁盘/内存不足延后处理。
- [ ] 运行测试；用合成文本页、扫描页和损坏 PDF 验证文本/页索引/失败状态；模拟租约过期时旧进程不能再提交结果。
- [ ] 提交 `git commit -m "feat: add leased jobs and bounded document processing"`。

### Task 7: 教材修订、解析检查与发布

**Files:** Create `packages/db/src/schema/catalog.ts`, `apps/server/src/modules/catalog/{contracts,service,routes}.ts`, `apps/server/src/jobs/textbook-job.ts`, `tests/integration/catalog.test.ts`；Modify `jobs/runner.ts`；Generate migration。

**Interfaces:** `CatalogService.createDraft(actor,input)`、`startProcessing(actor,revisionId)`、`reviewPage(actor,input)`、`publish(actor,revisionId)`、`disable(actor,revisionId)`、`listPublished(filters)`；`ParsedPage` 消费 Task6 接口。所有方法返回 catalog/contracts 定义的 DTO。

- [ ] 写 `only_admin_can_publish`、`failed_pages_block_publish_until_explicitly_excluded`、`published_revision_is_immutable`、`disabled_revision_hidden_from_new_selection`、`old_revision_sources_still_readable`。
- [ ] 运行 catalog 集成测试确认失败。
- [ ] 建立版本/年级/科目/教材/修订/章节/chunk 表；按页落库并支持校正、排除失败页；发布检查片段可用，修改已发布内容创建新修订。物理页与印刷页独立字段；操作审计。
- [ ] 运行测试；重复 job 执行不会重复章节/片段；种子仅提供目录字典，教材样本通过正常上传发布流程进入。
- [ ] 提交 `git commit -m "feat: publish versioned textbooks with reviewed sources"`。

### Task 8: 强限定教材检索与可校验引用

**Files:** Create `apps/server/src/modules/catalog/{search,citations}.ts`, `tests/integration/textbook-search.test.ts`。

**Interfaces:** `searchTextbook(scope:{student:StudentScope,revisionId:UUID},query:{chapterId?,keywords:string,limit:number}): Promise<CitedChunk[]>`；`validateCitations(scope,ids:UUID[]): Promise<CitedChunk[]>`；CitedChunk={id,revisionId,chapterId,pdfPageIndex,printedPageLabel,text}。

- [ ] 写同关键词跨版次夹具：`expect(results.every(x=>x.revisionId===boundRevision)).toBe(true)`；非法/伪造引用拒绝；停用修订在已有任务里仍可读。
- [ ] 运行 textbook-search 测试确认失败。
- [ ] 实现归一化中文关键词、章节标签优先、教材修订必选过滤、受限排序；不加向量库。引用接口验证调用者持有该修订的有效任务或管理员权限。
- [ ] 运行测试，验证无匹配返回空并附“依据不足”状态，不能退到其他版本。
- [ ] 提交 `git commit -m "feat: scope textbook retrieval and validate citations"`。

### Task 9: 学习任务、会话版本和作答事实

**Files:** Create `packages/db/src/schema/{learning,conversations}.ts`, `apps/server/src/modules/learning/{contracts,tasks,attempts,routes}.ts`, `apps/server/src/modules/conversations/{contracts,messages,routes}.ts`, `tests/integration/learning-records.test.ts`；Modify `packages/contracts/src/api.ts`；Generate migration。

**Interfaces:** `TaskService.create(scope,input): Promise<TaskDTO>`、`resume(scope,taskId)`、`transition(scope,input)`；`AttemptService.submit(scope,input:{requestKey,taskId,questionVersionId,answer,messageVersionId}): Promise<AttemptDTO>`；`MessageService.append(scope,input)`、`edit(scope,input)`、`regenerate(scope,input)`。此时 question_versions 基础 schema 一并定义于 `packages/db/src/schema/questions.ts`，供 Task12 扩展来源。

- [ ] 写 `task_binds_immutable_revision`、`resume_keeps_progress`、`duplicate_attempt_key_returns_same_attempt`、`edit_retains_old_version`、`regenerate_creates_message`、`concurrent_task_write_conflicts`。
- [ ] 运行 learning-records 测试确认失败。
- [ ] 定义6个入口（继续上次为恢复动作）、四个任务状态、task_items、题目版本、消息/版本、attempt、hint；客户端编辑使用 expectedVersion 防冲突。作答先记录事实，判分异步后续应用，不为等待模型持有事务。
- [ ] 运行测试，验证绑定他人题目/消息版本被拒绝；资料修改不会重写旧 attempt；学生可跳过题，5练按最终作答或跳过计进度。
- [ ] 提交 `git commit -m "feat: persist learning tasks and versioned conversation evidence"`。

### Task 10: Agent run、持久 SSE、取消与恢复

**Files:** Create `apps/server/src/modules/conversations/{runs,events,sse}.ts`, `packages/db/src/schema/runs.ts`, `tests/integration/runs.test.ts`；Modify `modules/conversations/routes.ts`, `packages/contracts/src/agent.ts`；Generate migration。

**Interfaces:** `RunService.submit(scope,input:{conversationId,requestKey,message}): Promise<{runId:UUID}>`、`cancel(scope,runId)`、`recoverExpired(now)`；`EventStore.append(runId,event)`、`readAfter(scope,runId,afterId)`；`RunExecutor.execute(runId,signal): Promise<void>` 由 Task11 注入。

- [ ] 写 `replayed_submission_returns_existing_run`、`same_conversation_has_one_active_run`、`reconnect_after_event_has_no_duplicates`、`stop_marks_partial_reply`、`restart_interrupts_run_without_replaying_tools`。
- [ ] 运行 runs 集成测试确认失败。
- [ ] 定义 queued/running/succeeded/failed/interrupted/cancelled、会话租约、单调 event ID；delta 每100ms或4KiB批量保存（先到为准）、完成保存快照；GET events 支持 Last-Event-ID/after 和心跳，断开订阅不取消执行。写请求与事件 GET 分离。
- [ ] 跑测试，验证2客户端订阅同 run 不多触发模型；批量末尾丢失时从消息快照恢复；reasoning 永不写入 run_events。
- [ ] 提交 `git commit -m "feat: add durable agent runs and resumable SSE"`。

### Task 11: pi 教学工具、开场与学习循环

**Files:** Create `apps/server/src/agent/{tutor,context,tools,prompts,bootstrap}.ts`, `tests/integration/tutor.test.ts`, `tests/unit/context.test.ts`；Modify conversations/runs 和 learning/routes 注册位置。

**Interfaces:** `TutorExecutor implements RunExecutor`；`buildContext(scope,taskId,budgetTokens): Promise<TutorContext>`；`createTeachingTools(bound:{scope,taskId,revisionId,runId}): AgentTool[]`（AgentTool 从固定 pi 版本导入）；`BootstrapService.open(scope,{revisionId,entryKey}): Promise<{conversationId,runId?,actions}>`。

- [ ] 写 `bootstrap_refresh_generates_once`、`cold_start_asks_learning_range`、`tool_cannot_override_student_scope`、`context_preserves_current_question_and_hint_history`、`tool_rounds_stop_at_eight`、`fallback_actions_available_when_provider_fails`。
- [ ] 运行 tutor/context 测试，确认未实现失败。
- [ ] 接入 pi 运行循环，注入 Task4 gateway 和 Task8 retrieval，schema 校验7个工具；候选练习和评估暂调用可注入的 Task13 服务端接口。入口返回固定6按钮与可选推荐，不自动批量出题。工具调用与结果成对裁剪，当前任务/题目/提示优先保留；进度未知先询问。
- [ ] 测试通过；对真实模型运行一次开场→检索→提问→提示，确认公开回答、工具记录、引用与计量入 PG。工具内部错误转换可展示状态，不暴露堆栈。
- [ ] 提交 `git commit -m "feat: build scoped pi tutoring and guided learning entry"`。

### Task 12: 私有试卷识别确认、拆题与原图关联

**Files:** Create `packages/db/src/schema/materials.ts`, `apps/server/src/modules/materials/{contracts,service,routes}.ts`, `apps/server/src/jobs/material-job.ts`, `tests/integration/materials.test.ts`；Modify `schema/questions.ts`, `jobs/runner.ts`；Generate migration。

**Interfaces:** `MaterialService.create(scope,input:{fileId,type,revisionId})`、`getExtraction(scope,materialId)`、`confirm(scope,input:{materialId,extractionVersion,questions:ConfirmedQuestion[]})`；ConfirmedQuestion 含题干、可见答案、多个来源区域、合并拆分映射；返回 questionVersionIds。

- [ ] 写 `teacher_annotation_is_not_student_answer`、`cross_page_question_preserves_sources`、`partial_confirmation_is_allowed`、`corrected_extraction_creates_new_version`、`paper_upload_does_not_create_mistakes`、`duplicate_job_does_not_duplicate_questions`。
- [ ] 运行 materials 集成测试确认失败。
- [ ] 复用 Task5–6，存原始抽取、模型/提示词版本、按页规范化坐标与候选题；确认时事务生成私有题目版本，可导入明确学生作答。允许局部确认/补图/修改；资料查看必须有 student_access。
- [ ] 测试通过；用合成两页卷验证识别→拆合→确认→选题创建 task；更正原题后旧任务/作答仍能回看原版本。
- [ ] 提交 `git commit -m "feat: confirm private paper questions with source regions"`。

### Task 13: 练习验证、学生判题和 AssessmentVerifier

**Files:** Create `packages/db/src/schema/assessments.ts`, `apps/server/src/modules/learning/{practice,assessments,verifier}.ts`, `tests/unit/verifier.test.ts`, `tests/integration/assessments.test.ts`；Modify `agent/tools.ts`；Generate migration。

**Interfaces:** `PracticeService.propose(scope,input): Promise<{status:'verified'|'pending';questionVersionId?:UUID}>`；`AssessmentService.submitCandidate(bound,input): Promise<AssessmentDTO>`；`AssessmentVerifier.verify(input:VerificationInput): Promise<VerificationResult>`；DTO 明确 correctness、verification、referenceIds、verifierVersion，verification 字段不接受 Agent 写入。

- [ ] 写 `guided_correct_is_still_guided`、`matching_final_value_cannot_verify_required_working`、`independent_disagreement_stays_pending`、`unconfirmed_question_cannot_verify`、`unsupported_open_answer_stays_pending`、`generated_problem_retries_only_once`。
- [ ] 运行 verifier/assessments 测试确认失败。
- [ ] 实现受限数值/分数/选项比较；其他封闭题按设计执行独立上下文复核，参考答案/引用需有效，结果一致才 verified。未知答案/无依据不自动核验。候选题生成+独立复核不一致重试1次；保存每次依据和验证版本。
- [ ] 测试通过；Task11 工具真实接入 verifier。验证核验等待不阻塞作答保存；提示依赖来自服务端 hint 记录，模型无法重置。
- [ ] 提交 `git commit -m "feat: verify practice and assessment evidence before state updates"`。

### Task 14: 错题本、状态机与证据更正

**Files:** Create `packages/db/src/schema/mistakes.ts`, `apps/server/src/modules/learning/{mistakes,state-rules,corrections}.ts`, `tests/unit/state-rules.test.ts`, `tests/integration/mistakes.test.ts`；Modify learning/routes；Generate migration。

**Interfaces:** `decideTransition(input:TransitionInput,now:Date): TransitionDecision`（纯函数）；`MistakeService.applyAssessment(scope,assessmentId): Promise<MistakeDTO>`、`add(scope,input)`、`list(scope,filter)`；`CorrectionService.invalidate(scope,input:{evidenceId,reason}): Promise<void>`。TransitionInput 定义原状态、核验结果、提示依赖、题目关系、最后巩固时间；Decision 返回状态/原因/dueAt/ruleVersion 或 unchanged。

- [ ] 测试代码断言：`expect(guidedOriginal.to).toBe('corrected_pending_practice')`；`expect(reviewBefore24Hours.changed).toBe(false)`；`expect(reviewAt24Hours.to).toBe('mastered')`；`expect(uncertain.changed).toBe(false)`。追加 `invalidated_evidence_removes_mastery_projection`、`reapplying_assessment_does_not_duplicate_event`。
- [ ] 运行 state-rules 与 mistakes 测试确认失败。
- [ ] 实现5状态、规则v1、≥24小时、新变式/独立证据、再次判错回退、归档重练。对正确ness 不确定或未核验一律 unchanged；行锁+版本防重复，当前投影和事件原子更新。
- [ ] 测试通过；消息/作答/题目证据被更正时追加失效事件并重算，不改写历史；已掌握错题不会把整个知识点自动设为 mastered。
- [ ] 提交 `git commit -m "feat: track evidence-based mistake states and corrections"`。

### Task 15: 摘要、学情观察、到期复习和跨会话恢复

**Files:** Create `packages/db/src/schema/knowledge.ts`, `apps/server/src/modules/learning/{summaries,knowledge,review}.ts`, `apps/server/src/jobs/summary-job.ts`, `tests/integration/learning-memory.test.ts`；Modify `agent/context.ts`, `jobs/runner.ts`；Generate migration。

**Interfaces:** `SummaryService.enqueueOnCompletion(tx,taskId)`、`generate(job)`；`KnowledgeService.get(scope,revisionId): Promise<KnowledgeDTO>`；`ReviewService.listDue(scope,now): Promise<MistakeDTO[]>`。SummaryDTO 必须关联 evidence refs 和 model/prompt version。

- [ ] 写 `completed_task_and_summary_job_commit_together`、`summary_failure_keeps_learning_history`、`next_session_reads_only_relevant_records`、`invalidated_evidence_is_excluded_from_current_summary`、`due_list_uses_student_timezone`。
- [ ] 运行 learning-memory 测试确认失败。
- [ ] 同事务写完成状态和摘要任务；后台生成结构化小结+可点击证据、置信与时间，不持久化内部推理。学情先呈现证据统计/观察；摘要失败回退结构化记录。复习仅应用内列表，无离线主动调用。
- [ ] 测试通过；一天边界/24小时门槛用 Clock 验证；恢复未完成任务保持教材修订/题目顺序/进度，不重复计算已完成练习。
- [ ] 提交 `git commit -m "feat: summarize learning with evidence and resume relevant context"`。

### Task 16: 选定 UI 方向并建立统一响应式组件

**Files:** Create `PRODUCT.md`, `DESIGN.md`, `apps/web/src/styles/{tokens,global}.css`, `apps/web/src/components/{AppShell,StatusPanel,QuestionCard,SourceLink,NextActions}.tsx`, `apps/web/src/components/ui/` 中实际使用的 shadcn 组件；Modify web 入口；Create `docs/ui/visual-decisions.md`, `tests/e2e/design-system.spec.ts`。

**Interfaces:** `AppShell({mode:'student'|'admin',children})`、`StatusPanel({state,onRetry?})`、`QuestionCard({question,onViewSource})`、`SourceLink({source})`、`NextActions({actions,onSelect})`；props 由组件导出，不使用数据库对象。

- [ ] 加载已有 Impeccable 技能，按已批准设计提供3个简洁视觉方向（同一学习首页+辅导片段，标注为方案稿），集中获取用户选择；未选之前不把任一方向当已批准风格。不额外安装陌生技能。
- [ ] 固定所选方向的颜色/字体/间距/圆角/层级/token、断点、触控、焦点和全部组件状态于 DESIGN.md；完善 PRODUCT.md。此为设计交付，不给颜色值镜像编写单测。
- [ ] 实现共享组件、Responsive Shell、表单状态和引用卡；Markdown 禁止原始 HTML，公式采用 KaTeX；不添加无关装饰动画。
- [ ] 运行 `pnpm build`、`pnpm exec playwright test tests/e2e/design-system.spec.ts`，覆盖键盘导航、对比度/触控、长内容；在360/768/1440px截图查看并修正，记录截图路径和结论。其他全尺寸在Task19验证。
- [ ] 提交 `git commit -m "feat: establish approved responsive UI system"`。

### Task 17: 学生学习页面、任务入口和流式辅导交互

**Files:** Create `apps/web/src/lib/{api,events}.ts`, `apps/web/src/routes/{Login,Activate,Profile,StudyEntry,Study,TaskHistory}.tsx`, `apps/web/src/features/tutor/{TutorPanel,Composer,QuestionPane,useTutorRun}.tsx`, `tests/e2e/tutor-ui.spec.ts`；Modify web router。

**Interfaces:** `api<T>(path,options): Promise<T>`（凭据、CSRF、错误契约）；`useTutorRun({conversationId,runId}): {messages,status,submit,cancel}`；教材选项来自Task7、bootstrap来自Task11、事件来自Task10。

- [ ] 写用户行为测试 `select_version_grade_subject_before_study`、`provider_failure_keeps_actions`、`stream_scroll_pauses_when_reading_history`、`reconnect_does_not_resubmit`；断言刷新后服务端 run 数仍为1。
- [ ] 运行 tutor-ui E2E 确认缺失页面/行为导致失败。
- [ ] 实现认证/个人资料、联动选教材、学习首页和6入口、逐题5练、知识点选择、自由提问、继续任务；题目与聊天按断点切换。输入草稿不因布局变化丢失，停止按钮调用 cancel，上翻展示新回复提示。
- [ ] 测试通过；检查长公式局部滚动、发送状态、学生跳过/结束任务、刷新历史。未核验评估明确展示，不伪造成功勾。
- [ ] 提交 `git commit -m "feat: add responsive student learning and streaming tutor"`。

### Task 18: 教材后台、学生资料和错题本页面

**Files:** Create `apps/web/src/routes/admin/{Textbooks,TextbookReview,Accounts}.tsx`, `apps/web/src/routes/{Materials,MaterialReview,Mistakes,MistakeDetail}.tsx`, `apps/web/src/features/uploads/{UploadInput,DocumentViewer,QuestionEditor}.tsx`, `tests/e2e/content-ui.spec.ts`；Modify router。

**Interfaces:** 上传组件消费 Task5 UploadGrant；确认页调用Task12 confirm；管理页消费Task3 invite/reset和Task7 catalog DTO；错题详情消费Task14历史和Task15证据。

- [ ] 写 `publish_textbook_and_select_it`、`confirm_some_paper_questions_without_marking_all_wrong`、`view_original_region_from_mistake`、`admin_private_file_access_denied_without_grant`、`student_can_grant_and_revoke_access`。
- [ ] 运行 content-ui E2E 确认缺失流程失败。
- [ ] 实现教材上传/进度/页预览/修正/发布停用、邀请重置与学生授权界面；学生拍照/相册/文件/拖拽、压缩旋转预览、识别进度、拆合题确认、选题学习；错题过滤、归档、复练和证据详情。考试原图支持放大和题目列表切换。
- [ ] 测试通过；验证手机管理员可分步上传/发布，PC/Pad 并排审阅；部分失败有重试入口，上传内容校验错误能解释并保留其他已完成项。
- [ ] 提交 `git commit -m "feat: add textbook management and private learning materials UI"`。

### Task 19: 完整闭环、三端视觉与异常回归

**Files:** Create `tests/e2e/{learning-journey,responsive,recovery}.spec.ts`, `tests/fixtures/learning-seed.ts`, `docs/qa/mvp-acceptance.md`；Modify 已实现模块中验证发现的问题，避免无关重构。

**Interfaces:** 只消费已定义公共 API；夹具可创建合成教材/题图/两账号，不绕过被测权限、发布或证据规则。受控时钟仅测试注入，不开放生产“跳过时间”接口。

- [ ] 添加闭环测试：管理员上传发布 → 学生选教材 → 开场 → 5练 → 上传确认错题 → 提示订正 → 独立变式 → 延迟复习 → 历史追溯 → 重登继续；检查每次状态事件均有有效证据。
- [ ] 添加中断/重启/双设备冲突、停用修订、识别纠正撤销掌握、OCR/OSS/模型失败、恶意 Markdown/资料指令测试；先确认新测试针对真实遗漏失败，再作最小修正。
- [ ] 执行 `pnpm test:unit`、`pnpm test:integration`、`pnpm test:e2e`、`pnpm typecheck`、`pnpm lint`、`pnpm build`，记录实际结果；真实provider/OCR/OSS单独报告，不以mock替代。
- [ ] 在360/390/768/1024/1280/1440px逐页面截图检查统一视觉、无整页横溢、焦点/触控/长公式；真实 iOS Safari、Android Chrome、桌面浏览器检查软键盘/相机/弱网和Pad旋转。缺设备明确未验证，不能伪造真机通过。
- [ ] 提交 `git commit -m "test: validate tutoring journey and cross-device recovery"`。

### Task 20: ECS 部署产物、资源验证与备份恢复

**Files:** Create `infra/{Dockerfile,compose.prod.yaml,Caddyfile}`, `scripts/{backup-db,restore-db,resource-smoke}.sh`, `docs/runbooks/{deployment,backup-restore,operations}.md`；Modify `.env.example`, `README.md`。

**Interfaces:** 容器暴露 Node 内网 API 和健康检查，Caddy 统一同源路由；PG 不发布公网端口。备份脚本只读取受控 env，不输出密钥；恢复要求指定目标非生产库并二次校验库名，不能覆盖现库。

- [ ] 创建多阶段构建产物和Compose（Caddy+Node+PG），设置设计中的内存/并发、日志轮转、SSE不缓冲、超时、私有网络、持久卷与健康检查；构建在本地/CI进行。解析子进程属于Node容器总内存预算，压测确认640MiB是否足够；不足先减批次/延后解析或调预算，不盲目叠加子进程配额。
- [ ] 写部署校验：`docker compose -f infra/compose.prod.yaml config --quiet` 成功；干净PG迁移后ready=200；未配置必须项时启动明确失败。镜像不包含.env/key/用户文件。
- [ ] 实现每日逻辑备份到OSS、7个每日版本保留与失败告警；执行一次备份→新库恢复→比对关键记录和引用→启动恢复实例。记录实际RPO/RTO，目标≤24小时/≤4小时未实测前不声称达标。
- [ ] 在本地等效限额环境先测2个同时流式聊天+1个解析队列，记录RSS/PG内存、事件循环延迟、磁盘、上游并发；验证<20%磁盘告警、<10%暂停解析、重启恢复。获得部署访问及配置后才在ECS执行同样检查，不把制作部署文件视作已上线。
- [ ] 完成上线/迁移/备份/回滚说明，回滚以向后兼容迁移为主；破坏性迁移必须先备份并维护停机，禁止直接down migration损坏业务事实。提交 `git commit -m "ops: package bounded ECS deployment and verified recovery"`。

## 外部依赖与执行记录

以下不阻塞接口和夹具开发，但未完成时相关真实验收不能打勾：

| 输入 | 需要的阶段 | 缺少时行为 |
|---|---|---|
| 模型 endpoint/model/key及实际工具/图片能力 | Task4、11、13 | 合约测试可做，真实冒烟标未验证 |
| OSS地域/bucket/授权/CORS | Task5及后续上传 | 测试适配器可做，真实上传标未验证 |
| OCR供应商和key | Task6、12 | 文本PDF可做，扫描真实链路标未验证 |
| 一本真实教材、照片/试卷样本 | Task7、12、19 | 合成资料可验证协议，真实质量未验收 |
| UI三方向选择 | Task16 | 后端可先推进，最终视觉实现等待选择 |
| 域名、ECS访问和现有资源信息 | Task20 | 生成部署产物、本地验证，不声称上线 |
| 真机访问 | Task19 | 自动化模拟报告与真机结果分开 |

不要在聊天或版本库提交凭据；通过本地未追踪.env或部署机秘密配置提供。执行中新增必要配置需记录在运行手册，而不是静默变更已确认产品范围。

## 计划自检

- [x] 范围覆盖：设计1–4由Task1–4及全局约束落实；5–7由Task3/5–8/12落实；8由Task9–11/13/17落实；9–10由Task9/13–14落实；11由Task8/11/15落实；12由Task6/10落实；13由Task16–19落实；14–15由Task3–6/19–20落实；16由各任务测试与Task19–20落实。
- [x] 接口扫描：共享Actor/StudentScope/DTO定义位置明确，Task11候选写入接口由Task13完成；运行时不得留假实现冒充真实判题。
- [x] 依赖扫描：题目版本基础表在Task9建立，Task12扩展来源；Task10定义RunExecutor并由Task11注入；后台任务先于解析/摘要建立。
- [x] Review Focus五项分别有拥有任务与验证，全部列出。
- [x] 计划只指定文件/接口/行为/验证，没有写产品代码；不要求为纯样式值写实现镜像测试。
- [x] 文档命令为实施时要建立/执行的命令，本次未安装依赖、运行产品测试或部署。

## 执行方式交接

建议 Native：在当前会话按顺序实现，按任务验证并提交，最后独立评审。模块间接口依赖较多，当前是低用户量项目，集中实施可减少上下文与接口对接成本。

也可选 Subagent-driven：每项由新代理实现并由独立代理评审，验证更细但上下文消耗更高。

按照 writing-plans 工作流，计划交付后先由用户审阅并选择执行方式；然后分别加载 executing-plans 或 subagent-driven-development，不把设计确认自动视作执行方式选择。
