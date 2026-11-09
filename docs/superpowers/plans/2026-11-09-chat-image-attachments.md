# 学习会话图片作答 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 学生在Composer拍照或选图、预览上传并发送，聊天历史展示图片，教学Agent和独立判题读取同一份OSS图片证据。

**Architecture:** 复用xy-tutor当前私有OSS上传、seal和读取；文件按会话授权，附件关联不可变消息版本。模型调用前把引用转换为图片块，Base64仅存在内存；消息提交与执行重试分别幂等。

**Tech Stack:** TypeScript、React 19、Fastify、Zod、PostgreSQL、Drizzle、ali-oss、pi-agent-core/pi-ai、Vitest、Playwright；复用现有canvas能力，不新增另一套上传服务。

**Date:** 2026-11-09（Asia/Shanghai）

**Spec:** [2026-11-09-chat-image-attachments-design.md](../specs/2026-11-09-chat-image-attachments-design.md)。执行者必须先读设计，特别是第12节明确默认值。

## Global Constraints

- 所有存储只使用当前项目createFileStore和OSS_*配置；tc-prime-ai只读参考，无运行依赖，不复制其桶或凭据。
- 单条最多3张，上传并发2；处理前15MiB/张、4000万像素；目标2MiB，成品最多5MiB/张、15MiB/消息。
- 初始长边2400px、质量0.88；依次0.82、0.75，再按0.85倍缩小且长边不自动低于1800px；不保存第二份原图。
- 模型最多6张/请求、原二进制总计30MiB；读取并发2、单图15秒；默认每张预算1536 token且可配置。
- 下载链接5分钟；自动换链最多1次。未绑定对象24小时后才可纳入清理，已绑定版本证据永不按草稿清理。
- 历史文字兼容、既有教材/学生材料限制不变；不做强制OCR、PDF会话附件、草稿跨刷新恢复或视觉改版。
- 此文件只安排实施；不在编写计划阶段修改产品、提交已有工作区改动或执行生产迁移/对象清理。后续提交只暂存相应任务的增量，不能git add整个工作区。

## Review Focus

1. 上传成功但complete响应丢失：重试complete必须复用封存结果，不能生成不可追踪的多个对象（Task 2）。
2. 发送时题目已经改变：提交使用点击时固化的questionVersionId，校验归属，不能把图片记到另一道题（Task 3、7）。
3. 旋转完成或上传返回时用户已切换会话：丢弃过期结果，不能把旧会话图片加入新草稿（Task 7）。
4. 文字看似正确但图片过程错误：不能走纯文字exact捷径，必须独立核验图片（Task 6）。
5. 临时链接过期和图片异步加载：有限换链、失败可重试，保持用户查看历史时的滚动位置（Task 8）。

## 文件职责与公共契约

所有路径相对仓库根目录；新增迁移使用执行时下一序号，禁止覆盖当前0013。

- `packages/contracts/src/conversation-images.ts`（新增）：共享限制、`ImageAttachmentDTO`、`ImageSubmission`；现有`file-limits.ts`复用常量。
- `ImageSubmission = { message: string; attachmentIds: string[]; questionVersionId?: string }`，attachments最多3项、顺序有意义；空文字合法但两者不能同时为空。
- `ImageAttachmentDTO = { fileId: string; name: string; mimeType: string; width: number; height: number; position: number }`。
- `apps/server/src/modules/conversations/attachments.ts`（新增）：`ConversationAttachmentService`，依赖db/auth/当前FileStore；授权、绑定、元数据与读图入口，不包含UI逻辑。
- `validateAndBind(tx, scope, conversationId, versionId, fileIds): Promise<ImageAttachmentDTO[]>`；只在调用方事务内绑定ready且同学生同会话文件。
- `listForVersions(scope, conversationId, versionIds): Promise<Map<string, ImageAttachmentDTO[]>>`，批量查询避免逐条历史N+1。
- `materialize(scope, conversationId, versionIds, signal): Promise<Map<string, ImageContent[]>>`；`ImageContent`直接导入当前pi-ai的类型，使用其真实字段，禁止自创模型协议；一次调用内缓存、顺序固定、读取上限按设计。
- `apps/web/src/features/uploads/imagePrepare.ts`（新增）：`prepareChatImage(file: File, rotation: number, signal?: AbortSignal): Promise<{ blob: Blob; mimeType: string; width: number; height: number }>`。
- `apps/web/src/features/tutor/useImageAttachments.ts`（新增）：附件状态机；接收`{studentId, conversationId}`，返回items/addFiles/rotate/remove/retry/reset/readyFileIds/canSend；具体状态类型在该文件定义并导出。
- `apps/web/src/components/ImageAttachmentPreview.tsx`（新增）：通用缩略图与大图弹层，支持本地Object URL及服务端fileId授权展示。
- 其余修改路径和职责见设计第9节；下列任务明确新增测试和依赖。

---

### Task 1: 图片能力基线与共享契约

**Files:**
Create: `packages/contracts/src/conversation-images.ts`, `scripts/smoke-chat-image.ts`
Modify: `apps/server/src/agent/capabilities.ts`, `packages/contracts/src/agent.ts`, `package.json`
Test: `tests/unit/conversation-images.test.ts`, `tests/unit/provider.test.ts`

**Interfaces:**
Consumes: 当前createGateway、configuredCapabilities和pi-ai ImageContent类型。
Produces: 上述共享DTO/常量与`pnpm smoke:chat-image`，能力缺失时明确disabled，不把enabled-unverified显示为已验证。

- [ ] **Step 1 — 写回归测试：** 先写`accepts_image_only_and_rejects_empty_or_four_images`：纯图成功；空文字+空附件失败；4张失败；重复fileId失败；再测模型能力关闭时含图片输入被拒绝。
- [ ] **Step 2 — 确认失败：** 运行 `pnpm exec vitest run --config vitest.unit.config.ts tests/unit/conversation-images.test.ts tests/unit/provider.test.ts`；确认失败来自本任务缺失行为，而不是测试环境或拼写错误。若本机端口受沙箱限制，按当前工具权限流程运行隔离测试库，不能跳过验证。
- [ ] **Step 3 — 最小实现：** 定义DTO和限制，核对SDK真实图片块；smoke使用带随机可读数字的合成图片，校验模型读出数字、两图顺序及工具轮次后仍能识别。命令默认只检查配置，必须显式--live才发送真实请求；不得输出图片Base64或凭据。
- [ ] **Step 4 — 验证：** 上述Vitest通过；smoke默认模式可运行。真实网关未运行时记录“未验证”，不能声称图片链路可用。
- [ ] **Step 5 — 检查任务增量：** 查看本任务diff和`git diff --check`；记录测试结果。若后续执行获得提交授权，仅暂存本任务相关增量并提交；不得夹带用户已有更改。

### Task 2: 会话文件归属、上传与消息附件模型

**Files:**
Modify: `packages/db/src/schema/files.ts`, `packages/db/src/schema/conversations.ts`, `apps/server/src/modules/uploads/contracts.ts`, `apps/server/src/modules/uploads/service.ts`, `packages/contracts/src/file-limits.ts`
Create: 下一序号Drizzle迁移、`apps/server/src/modules/conversations/attachments.ts`
Test: `tests/integration/conversation-images.test.ts`, `tests/integration/uploads.test.ts`

**Interfaces:**
Consumes: Task 1 DTO/限制，现有FileStore seal/head/read。
Produces: files.conversation_id、图片可信尺寸；message_attachments唯一约束；validateAndBind/listForVersions；conversation_image上传和带expiresAt的下载返回。

- [ ] **Step 1 — 写回归测试：** 先写`rejects_cross_student_or_conversation_attachment`、`complete_is_idempotent_after_lost_response`和`binds_only_ready_sealed_files`：未ready拒绝、越权拒绝、重复complete只保留同一封存key、历史文字附件为空；再测5MiB与4000万像素边界和伪造MIME。
- [ ] **Step 2 — 确认失败：** 运行 `pnpm exec vitest run --config vitest.integration.config.ts tests/integration/conversation-images.test.ts tests/integration/uploads.test.ts`；确认失败来自本任务缺失行为，而不是测试环境或拼写错误。若本机端口受沙箱限制，按当前工具权限流程运行隔离测试库，不能跳过验证。
- [ ] **Step 3 — 最小实现：** 增加会话归属与附件版本表，上传权限在create/complete/download均校验；complete可信解码尺寸，封存成品后再允许绑定，绑定时检查3张/15MiB上限。获取下载链接使用当前store.signDownload(key,300)，返回expiresAt。用测试schema应用所有迁移，不改生产。
- [ ] **Step 4 — 验证：** 目标集成测试通过，旧教材/学生材料限制用例保持通过，files中稳定key与临时URL不混存。
- [ ] **Step 5 — 检查任务增量：** 查看本任务diff和`git diff --check`；记录测试结果。若后续执行获得提交授权，仅暂存本任务相关增量并提交；不得夹带用户已有更改。

### Task 3: 原子图片消息、历史版本和任务创建幂等

**Files:**
Modify: `apps/server/src/modules/conversations/runs.ts`, `messages.ts`, `contracts.ts`, `apps/server/src/modules/learning/tasks.ts`, `contracts.ts`, `packages/db/src/schema/learning.ts`
Create: creation_key及附件约束所需下一序号迁移
Test: `tests/integration/runs.test.ts`, `tests/integration/conversation-images.test.ts`, `tests/integration/learning-records.test.ts`

**Interfaces:**
Consumes: validateAndBind/listForVersions。
Produces: submit支持ImageSubmission；历史当前及versions均含attachments；create任务支持creationKey；attempt引用图片所在消息版本。

- [ ] **Step 1 — 写回归测试：** 先写`image_only_submission_is_atomic_and_idempotent`：重复请求仅1条用户消息/attempt/run；相同key换图或交换图片顺序返回409；绑定失败不留下消息。再测`creation_key_reuses_task_after_response_loss`、已删除任务拒绝和题目归属不符拒绝。
- [ ] **Step 2 — 确认失败：** 运行 `pnpm exec vitest run --config vitest.integration.config.ts tests/integration/runs.test.ts tests/integration/conversation-images.test.ts tests/integration/learning-records.test.ts`；确认失败来自本任务缺失行为，而不是测试环境或拼写错误。若本机端口受沙箱限制，按当前工具权限流程运行隔离测试库，不能跳过验证。
- [ ] **Step 3 — 最小实现：** 扩展run输入schema及幂等比对（文字/附件顺序/题目/mode），同事务写消息版本、附件、attempt和run；纯图允许空answer但必须有附件，标题用“图片作答”。creationKey按(student_id,creation_key)唯一并处理并发冲突，相同键不同创建参数409。history批量查附件；编辑文字时复制附件关联并保持既有证据失效规则。
- [ ] **Step 4 — 验证：** 目标测试通过；额外检查旧文字run/编辑/题目作答用例全部兼容。
- [ ] **Step 5 — 检查任务增量：** 查看本任务diff和`git diff --check`；记录测试结果。若后续执行获得提交授权，仅暂存本任务相关增量并提交；不得夹带用户已有更改。

### Task 4: 已保存消息的执行重试

**Files:**
Modify: `apps/server/src/modules/conversations/runs.ts`, `apps/server/src/modules/conversations/sse.ts`, `packages/db/src/schema/runs.ts`
Create: retry_of_run_id迁移
Test: `tests/integration/runs.test.ts`

**Interfaces:**
Consumes: Task 3稳定的input_version_id与附件版本。
Produces: `RunService.retry(scope, runId, {requestKey}): Promise<{runId:string}>`及`POST /api/runs/:id/retry`。

- [ ] **Step 1 — 写回归测试：** 先写`retry_reuses_input_without_duplicate_message_or_attempt`：failed原run产生新run，输入版本/题目一致、retry_of_run_id指向原run，重复key返回同一新run，message/attempt数量不增；再测running/succeeded/已编辑输入/跨学生均拒绝。
- [ ] **Step 2 — 确认失败：** 运行 `pnpm exec vitest run --config vitest.integration.config.ts tests/integration/runs.test.ts`；确认失败来自本任务缺失行为，而不是测试环境或拼写错误。若本机端口受沙箱限制，按当前工具权限流程运行隔离测试库，不能跳过验证。
- [ ] **Step 3 — 最小实现：** 锁定会话，按设计状态规则校验并原子创建新run；记录当前发起actor、原mode及输入引用。只重跑执行，不再走用户消息插入分支。cancelled仅由主动retry操作进入，已失效旧版本拒绝。
- [ ] **Step 4 — 验证：** 目标用例与原取消/并发run测试通过。
- [ ] **Step 5 — 检查任务增量：** 查看本任务diff和`git diff --check`；记录测试结果。若后续执行获得提交授权，仅暂存本任务相关增量并提交；不得夹带用户已有更改。

### Task 5: 多模态上下文、预算和OSS图片装配

**Files:**
Modify: `apps/server/src/modules/conversations/attachments.ts`, `apps/server/src/agent/context.ts`, `tutor.ts`, `provider.ts`, `apps/server/src/app.ts`
Test: `tests/integration/tutor.test.ts`, `tests/unit/conversation-images.test.ts`

**Interfaces:**
Consumes: materialize和Task 3历史附件。
Produces: buildContext返回SDK真实文字/图片内容块；TutorExecutor获得当前FileStore依赖；图片输入预算与读取错误可观测。

- [ ] **Step 1 — 写回归测试：** 先写`model_receives_sealed_image_bytes_in_user_content`：用测试store封存字节断言模型桩接到一致图片；工具多轮同图仅读取一次。再测最新图片读取失败时模型调用为0、6张/30MiB预算、历史整条裁剪、纯图最新消息不被文字预算漏掉。
- [ ] **Step 2 — 确认失败：** 运行 `pnpm exec vitest run --config vitest.integration.config.ts tests/integration/tutor.test.ts`；确认失败来自本任务缺失行为，而不是测试环境或拼写错误。若本机端口受沙箱限制，按当前工具权限流程运行隔离测试库，不能跳过验证。
- [ ] **Step 3 — 最小实现：** 实现materialize并在上下文边界装配图片，不把Base64算作普通文字。读取并发2、单图15秒、run内缓存；model能力关闭、必要证据超预算、当前图片读取失败均显式错误。历史按完整消息版本裁剪，释放缓存并向下传播取消信号。
- [ ] **Step 4 — 验证：** 模型桩多模态用例、原文字辅导用例通过；日志不含Base64或签名链接。
- [ ] **Step 5 — 检查任务增量：** 查看本任务diff和`git diff --check`；记录测试结果。若后续执行获得提交授权，仅暂存本任务相关增量并提交；不得夹带用户已有更改。

### Task 6: 图片作答的独立判题与下游证据

**Files:**
Modify: `apps/server/src/modules/learning/attempts.ts`, `assessments.ts`, `verifier.ts`, `mistakes.ts`, `apps/server/src/agent/tools.ts`, `apps/server/src/jobs/summary-job.ts`, `apps/web/src/routes/Mistakes.tsx`, `apps/web/src/routes/MistakeDetail.tsx`
Test: `tests/integration/assessments.test.ts`, `mistakes.test.ts`, `learning-memory.test.ts`, `tests/unit/verifier.test.ts`

**Interfaces:**
Consumes: Task 5 materialize与原始消息版本；已验证参考答案。
Produces: attempt详情含attachments，独立核验使用原图；图片证据的verified/pending结论及错题/摘要引用。

- [ ] **Step 1 — 写回归测试：** 先写`image_work_is_checked_even_when_text_answer_matches`：answer文字正确但图中过程错误，不能走exact确认；`unreadable_image_remains_pending`断言不确认掌握、不把OSS技术错误记录为incorrect。再测主Agent与独立核验同一版本图片、编辑后旧证据失效及重试不重复投影。
- [ ] **Step 2 — 确认失败：** 运行 `pnpm exec vitest run --config vitest.integration.config.ts tests/integration/assessments.test.ts tests/integration/mistakes.test.ts tests/integration/learning-memory.test.ts`；确认失败来自本任务缺失行为，而不是测试环境或拼写错误。若本机端口受沙箱限制，按当前工具权限流程运行隔离测试库，不能跳过验证。
- [ ] **Step 3 — 最小实现：** answer保留真实学生文字；独立请求直接装配附件；number/choice/worked/open有图片时均走独立证据规则，补充verifier输入的hasImageEvidence并禁用文字exact捷径。工具/错题详情返回附件元数据，摘要保留证据ID和结论，不复制Base64或以模型转述覆盖原答案。
- [ ] **Step 4 — 验证：** 目标测试与verifier单测通过，图片不足时正确保持uncertain/pending。
- [ ] **Step 5 — 检查任务增量：** 查看本任务diff和`git diff --check`；记录测试结果。若后续执行获得提交授权，仅暂存本任务相关增量并提交；不得夹带用户已有更改。

### Task 7: 图片草稿处理、上传状态机和首页复用

**Files:**
Create: `apps/web/src/features/uploads/imagePrepare.ts`, `apps/web/src/features/tutor/useImageAttachments.ts`
Modify: `apps/web/src/features/uploads/UploadInput.tsx`, `apps/web/src/features/tutor/Composer.tsx`, `useTutorRun.ts`, `apps/web/src/routes/Home.tsx`, `Study.tsx`, `apps/web/src/lib/sessionStart.ts`
Test: `tests/unit/session-start.test.ts`, `tests/e2e/chat-images.spec.ts`

**Interfaces:**
Consumes: Task 1 DTO与Task 2/3上传/发送API。
Produces: prepareChatImage及useImageAttachments；Composer.onSubmit接收ImageSubmission，useTutorRun.submit接收同一结构；sessionStarter复用creationKey和草稿会话。

- [ ] **Step 1 — 写回归测试：** 先写浏览器`preserves_draft_on_upload_failure`、`drops_late_upload_after_conversation_switch`、`rotated_file_is_uploaded_as_new_sealed_asset`，以及首次上传/提交响应丢失仍只创建1个任务的单测。断言第4张拒绝、空文字+ready图可发、存在failed/uploading图禁发。
- [ ] **Step 2 — 确认失败：** 运行 `pnpm exec vitest run --config vitest.unit.config.ts tests/unit/session-start.test.ts；pnpm exec playwright test tests/e2e/chat-images.spec.ts`；确认失败来自本任务缺失行为，而不是测试环境或拼写错误。若本机端口受沙箱限制，按当前工具权限流程运行隔离测试库，不能跳过验证。
- [ ] **Step 3 — 最小实现：** 按设计压缩算法实现prepareChatImage，透明底填白、尺寸/解码错误明确反馈。hook用generation和AbortController丢弃过期异步结果，及时释放Object URL。首页首次选图先以creationKey创建并缓存free_question任务；未发送空任务派生显示“未开始”。发送指纹包含有序fileId，busy运行中可准备草稿但不可发新run。
- [ ] **Step 4 — 验证：** 目标测试通过；现有材料上传交互不回归，跨会话无草稿/图片串入。
- [ ] **Step 5 — 检查任务增量：** 查看本任务diff和`git diff --check`；记录测试结果。若后续执行获得提交授权，仅暂存本任务相关增量并提交；不得夹带用户已有更改。

### Task 8: 发送前后图片预览和失败重跑入口

**Files:**
Create: `apps/web/src/components/ImageAttachmentPreview.tsx`
Modify: `apps/web/src/features/tutor/Composer.tsx`, `TutorPanel.tsx`, `useTutorRun.ts`, `apps/web/src/lib/types.ts`, `apps/web/src/styles/global.css`, `tests/e2e/fixtures/ui-api.ts`
Test: `tests/e2e/chat-images.spec.ts`, `tests/e2e/responsive.spec.ts`

**Interfaces:**
Consumes: Task 7草稿、Task 3历史、Task 4retry和下载expiresAt。
Produces: 单/多图预览弹层、历史图显示、受限换链及失败消息“重新回答”操作。

- [ ] **Step 1 — 写回归测试：** 先写`preview_before_send_and_after_reload`、`refreshes_expired_image_link_once`、`image_load_keeps_history_scroll_position`、`retry_failed_run_does_not_duplicate_user_message`。弹层断言Escape关闭、焦点回到触发按钮，手机宽度无横向溢出。
- [ ] **Step 2 — 确认失败：** 运行 `pnpm exec playwright test tests/e2e/chat-images.spec.ts tests/e2e/responsive.spec.ts`；确认失败来自本任务缺失行为，而不是测试环境或拼写错误。若本机端口受沙箱限制，按当前工具权限流程运行隔离测试库，不能跳过验证。
- [ ] **Step 3 — 最小实现：** 本地Object URL和服务端fileId走同一预览组件；按设计有限重新签名，失败给手动重试。图片load触发跟随但尊重用户历史阅读位置。run失败显示重新回答，取消只停止运行不移除图片。更新旧夹具和已变更的首页/Composer文案选择器，避免旧测试仍依赖不存在的按钮。
- [ ] **Step 4 — 验证：** 相关Playwright通过，桌面/Pad/手机截图及真机相机手测记录保存在验收说明。
- [ ] **Step 5 — 检查任务增量：** 查看本任务diff和`git diff --check`；记录测试结果。若后续执行获得提交授权，仅暂存本任务相关增量并提交；不得夹带用户已有更改。

### Task 9: 未绑定文件清理与最终验收

**Files:**
Modify: `apps/server/src/infra/oss.ts`, `tests/helpers/files.ts`, `package.json`
Create: `scripts/cleanup-chat-images.ts`, `tests/integration/chat-image-cleanup.test.ts`
Modify: 设计文档中的实施状态与验收记录

**Interfaces:**
Consumes: files与message_attachments稳定引用、当前FileStore。
Produces: FileStore.delete(key):Promise<void>和`pnpm cleanup:chat-images -- --dry-run`，默认dry-run；显式--execute才删除允许清理对象。

- [ ] **Step 1 — 写回归测试：** 先写`cleanup_never_deletes_bound_or_recent_files`：已绑定旧版本/软删除会话文件保留，23小时草稿保留，超过24小时未绑定可清理；绑定与清理并发只能一方获胜，删除失败可重试且不丢数据库追踪。
- [ ] **Step 2 — 确认失败：** 运行 `pnpm exec vitest run --config vitest.integration.config.ts tests/integration/chat-image-cleanup.test.ts`；确认失败来自本任务缺失行为，而不是测试环境或拼写错误。若本机端口受沙箱限制，按当前工具权限流程运行隔离测试库，不能跳过验证。
- [ ] **Step 3 — 最小实现：** 扩展当前OSS adapter和测试store的delete；清理用数据库状态/锁先阻止新绑定再删对象，失败保留重试标记；记录上传源key和失败封存key以便清理，禁止list整个bucket后按前缀盲删。仅处理本功能tracked对象，命令不自动安装定时任务。
- [ ] **Step 4 — 验证：** 运行pnpm typecheck、pnpm lint、pnpm test:unit、pnpm test:integration、pnpm build、相关Playwright及git diff --check；真实云联调经用户授权后用合成图执行，未执行明确标注。完成手机拍照、纯图片讲解、独立判题、刷新回看整链验收。
- [ ] **Step 5 — 检查任务增量：** 查看本任务diff和`git diff --check`；记录测试结果。若后续执行获得提交授权，仅暂存本任务相关增量并提交；不得夹带用户已有更改。

## 依赖和执行边界

按Task 1→2→3→4→5→6→7→8→9执行；不可先上线只显示图片却未给模型/独立判题传图的半成品。run接口当前注册于`apps/server/src/modules/conversations/sse.ts`，直接扩展既有注册，不新建重复路由；各路径在每任务开始前确认工作区最新状态。

如现有能力已完成，不重复改写：先补对应回归测试确认行为，再只实施缺口。当前工作区包含用户的大量未提交修改，实施前记录状态，禁止reset/clean或整文件覆盖恢复。

## 计划自检

- 设计§1–3、§6、§12的Composer/首页/限制对应Task 1、7、8。
- 设计§4–5的存储、版本、权限、事务、提交与执行重试对应Task 2–4。
- 设计§7的模型能力、OSS读图、预算、缓存对应Task 1、5。
- 设计§8的独立核验及错题/摘要证据对应Task 6。
- 设计§9–11、§13的文件职责、清理、兼容、全链验收对应Task 2、8、9。
- Review Focus五项分别具有明确回归用例；能力验证与真实收费调用分离，未跑云联调不得报告成功。

## 当前交付状态

本文为可执行计划，所有任务未开始；本次只编写design和plan。用户后续要求实施后再选择执行方式，当前不启动实现、不部署、不提交工作区。
