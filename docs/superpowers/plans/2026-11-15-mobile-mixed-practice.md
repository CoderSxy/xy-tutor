# 移动端学习体验、混合题型与会话错题闭环 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 交付三端适配、题型多样、支持逐题与整组作答的每日五题，并确保中文教学内容和会话错题可靠入库。

**Architecture:** 在现有任务/会话/题库上增加题组协调器，统一五个正式槽位、结构化答案、异步判题和继续练习。复用 PostgreSQL JobQueue，评估与错题同步事件同事务提交；前端共享题组状态，按设备调整布局。语言规范是所有学生可见生成内容的公共边界。

**Tech Stack:** TypeScript、Node >=22.22.0、pnpm 10.30.3、React 19、Fastify 5、PostgreSQL/Drizzle、Zod、Vitest、Playwright；沿用现有依赖。

**Spec:** [2026-11-15-mobile-mixed-practice-design.md](../specs/2026-11-15-mobile-mixed-practice-design.md)

## Global Constraints

- 使用现有 React/Vite/TypeScript、Fastify、PostgreSQL/Drizzle、ModelGateway、JobQueue，不新增 Redis、向量库或独立推荐服务。
- 保留现有浅色背景、白色卡片和深绿色主操作，沿用根目录 DESIGN.md 的视觉基础；借鉴 nero-agent 的移动端结构与交互。
- 手机断点小于 768px，Pad 为 768～1199px，PC 为至少 1200px；是否双栏还取决于实际可用宽度。
- 触控目标至少 44×44 CSS px，正文默认 16px；支持可见焦点、键盘操作、中文输入法与 reduced-motion。
- 学生可见叙述使用简体中文；公式、变量、单位符号和必要英文专名保留原文。
- 提交、核验、错题同步、掌握状态是不同事实；不把模型聊天判断当成正式评估，不把提示后答对记作独立完成。
- 无法可靠判题时显示待核验，不自动记错；未知历史题型和来源不伪造分类。
- 新数据表及迁移采用增量兼容；不覆盖旧迁移、不 reset 数据库、不改写原始题干/作答证据。
- 所有 API 按 StudentScope 校验；共享题可见性不等于其他学生的答案、错题或附件可见。
- 测试只使用独立 `_test` 数据库；不提交真实学生资料、真实密钥和带签名的附件地址。
- 默认 `mixed-v1` 配额为 2 single_choice、2 fill_blank、1 worked；每组五槽、position 0～4；每槽最多两次候选，整组最多十次候选。
- `practiceSetsEnabled`、`mobileStudyEnabled` 初始 false；关闭题组开关仍须允许既有题组读写和完成。
- 本文是未来实施计划，复选框不表示已实现。本次只写文档，不执行产品实现、迁移、部署或 Git 提交。

## Review Focus

- 学生 A 访问共享题不应泄露 B 的作答/附件；公开题卡不含 answerSpec/rubric/referenceAnswer。任务 2、6、9、13 有对应测试。
- 网络超时、双击、两个标签页和 worker 租约耗尽不能重复作答或永远处理中；任务 3、8、9、10 覆盖故障注入与并发。
- 相同字母可属于英文叙述、专名或跨 chunk 公式；不误伤 sin/cos/x/y，也不先泄露英文再修复。任务 5 覆盖。
- batch 同屏五题、提前求助、计时切题和输入意图切换不能误记独立性、并行计时或咨询为作答。任务 9、11、12 覆盖。
- 历史未知题型、来源不明、晚到错误事件、错误被改判以及回滚开关不能破坏历史事实。任务 1、2、4、10、14 覆盖。

---

## 0. 执行准备与阶段依赖

- [ ] 阅读 Spec、`PRODUCT.md`、`DESIGN.md`、上述前置设计及当前服务实现，不把旧计划中的“待实现”当成当前状态。
- [ ] 检查当前 AGENTS.md、`git status --short`、Node/pnpm、当前分支、迁移编号。复用合适 checkout；需要隔离时使用原生 worktree 工具，不覆盖用户未提交工作。
- [ ] 执行 `pnpm typecheck`、`pnpm test:unit`，记录实际基线；测试数据库沿用 `tests/helpers/database.ts` 的 `_test` 保护。缺环境时记录未执行，不换生产库。
- [ ] 阅读只读参考仓库的移动端设计、MobileInbox、MobileComposerDock 和 mobile.css；不修改参考仓库，不引入它的业务依赖。
- [ ] 先写行为测试并确认因目标行为缺失失败，再实现，再运行定向测试；所有任务完成后按任务 14 做整体检查。

推荐顺序（默认同一会话依次执行，无需并行代理）：

```text
1 契约/迁移
  → 2 错题权限/来源 → 3 可靠判题与同步 → 4 历史补齐
  → 5 中文边界 → 6 结构化题型 → 7 组题策略 → 8 题组协调器
  → 9 正式提交/草稿/计时 → 10 继续练习/偏好/路由
  → 11 两种作答 UI → 12 手机/Pad/PC 布局 → 13 错题页面
  → 14 全链路验收/运行手册
```

阶段 A 为 1～5 的基础可靠性；阶段 B 为 6～10 的题组后端；阶段 C 为 11～14 的三端产品闭环。阶段 A 中与题组相关的表可暂不启用；旧学习入口保持可用。

任务中的提交步骤只对未来已获授权的实现流程生效；不得因本计划存在而在当前文档任务执行 commit。若当时没有提交授权，保留可审阅 diff 并记录提交建议。

## 1. 文件地图与公共接口

### 1.1 文件职责

| 区域 | 新增 | 修改 |
|---|---|---|
| 契约 | `packages/contracts/src/{question-presentation,practice-sets,mistakes}.ts` | `question-bank.ts`、`agent.ts`（如事件契约位于此处） |
| 存储 | `packages/db/src/schema/practice-sets.ts`；增量 SQL | `schema/{questions,mistakes,conversations}.ts`、迁移 journal |
| 题型/语言 | `apps/server/src/modules/question-bank/{presentation,student-language}.ts` | `generator.ts`、`templates.ts`、`verifier.ts`、`search.ts`、`learning/practice.ts` |
| 题组 | `apps/server/src/modules/learning/{practice-blueprint,practice-sets,practice-set-routes,answer-submission,practice-drafts,practice-preferences}.ts` | `tasks.ts`、`contracts.ts`、`attempts.ts`、`assessments.ts`、`routes.ts` |
| 错题 | `apps/server/src/modules/learning/mistake-backfill.ts` | `mistakes.ts`、`mistake-routes.ts`、`corrections.ts`、`materials/service.ts` |
| 作业 | `apps/server/src/jobs/{assessment-job,mistake-sync-job,practice-set-job}.ts` | `queue.ts`、`app.ts`、`config.ts` |
| Agent | 无独立新代理 | `agent/{prompts,tools,context,tutor}.ts`、`conversations/runs.ts`、`messages.ts` |
| 学习 UI | `apps/web/src/features/practice/{api,usePracticeSet,useAnswerDrafts,PracticeModeSwitch,PracticeNavigator,PracticeQuestionCard,PracticeResults,PracticeNextActions}.tsx/.ts` | `routes/{Home,Study}.tsx`、`features/tutor/{Composer,TutorPanel,useTutorRun}.tsx/.ts`、`QuestionCard.tsx` |
| 移动布局 | `apps/web/src/features/practice/{MobileStudyShell,PracticeComposerDock}.tsx`、`useStudyViewport.ts`、`practice.css` | `AppShell.tsx`、`SessionRail.tsx`、`styles/global.css`、根 `DESIGN.md` |
| 错题 UI | 契约/分页调用复用现有能力 | `routes/{Mistakes,MistakeDetail}.tsx`、相关管理员只读视图、`lib/types.ts` |
| 运维/测试 | `scripts/backfill-mistakes.ts`、`docs/runbooks/mobile-mixed-practice.md`、对应测试 | `package.json`、`tests/e2e/fixtures/ui-api.ts` |

表中省略前缀的服务文件均位于对应同一模块目录；`.tsx/.ts` 表示组件用 tsx、hook/API 用 ts，不创建带此字面后缀的文件。不预建无消费者的空模块，不拆分无关代码。

### 1.2 公共签名

公共 DTO 的字段以 Spec 第 5、9 节为准，任务 1 创建全部 Zod schema。后续任务不能自行重命名。

```ts
type SubmitPracticeInput = {
  requestKey: string; expectedVersion: number;
  entries: { itemId: string; answer: AnswerPayload }[];
  skippedItemIds: string[]; finalize: boolean;
};
type SubmissionDTO = {
  id: string; setId: string;
  state: "grading" | "needs_review" | "completed";
  items: PracticeItemProgress[];
};
type DraftDTO = { itemId: string; answer: AnswerPayload; version: number; updatedAt: string };
type PreferencesDTO = {
  version: number; mode: PracticeMode | null;
  strategy: PracticeStrategy; examProfileId: string | null;
};
type ContinueResult = { taskId: string; setId: string; conversationId: string };
type MistakePage = {
  items: MistakeDTO[]; total: number; page: number; pageSize: number;
  originCounts: { all: number; uploaded: number; learning: number; unknown: number };
};
```

`MistakeDTO` 保留旧字段，增添 Spec 的来源、lifecycle 和最初题目版本引用。新增请求内 timing 沿用现有 episodeId/timingFinalEvent 类型，逐题分别携带，不自行发明计时格式；由任务 1 将其放入 entries 的可选字段。

## Task 1: 建立契约与兼容迁移

**Files:** 新增三个 contracts 文件、`packages/db/src/schema/practice-sets.ts`；修改 question-bank 契约、questions/mistakes/conversations schema；创建下一编号迁移并更新 journal。测试 `tests/unit/practice-set-contracts.test.ts`、`tests/integration/practice-set-schema.test.ts`。

**Interfaces:** 产出 Spec 中全部枚举/DTO/schema，以及本计划公共类型。origin/lifecycle、规范 answer_payload、唯一继续请求映射供后续任务使用。

- [ ] **Step 1: 编写契约和迁移测试。** 断言如下，并覆盖历史记录默认值及表约束：

  ```ts
  expect(practiceModeSchema.safeParse("step").success).toBe(true);
  expect(questionTypeSchema.safeParse("number").success).toBe(false);
  expect(answerPayloadSchema.safeParse({ kind: "choice", optionIds: [] }).success).toBe(false);
  // schema integration: duplicate(setId, position) rejected; position=5 rejected;
  // legacy question has question_type=legacy, language_status=unchecked;
  // existing mistakes retain original attempt; origin=unknown, lifecycle=active.
  ```

- [ ] **Step 2: 运行红灯。** `pnpm exec vitest run --config vitest.unit.config.ts tests/unit/practice-set-contracts.test.ts`；预期目标契约尚不存在或断言失败。
- [ ] **Step 3: 实现 schema 与迁移。** 使用 Spec 第 5 节表结构；set 包含 scope_snapshot，补充 `student_mistakes.lifecycle`、`attempts.answer_payload`，新增 `practice_set_continuations(previous_set_id UNIQUE,request_key,payload_hash,new_set_id)` 和 `question_localizations(question_version_id,policy_version,payload,status, UNIQUE(...))`。submission_items 保存 grading_state/mistake_sync_state/latest_assessment_id；slot.position CHECK 0～4。draft、preference、set 均有 version。真实迁移编号运行前重查，不能固定覆盖 0030。所有新增表有 student 或可经 set/task 追溯的授权链。
- [ ] **Step 4: 验证。** 运行上述 unit 和 `pnpm exec vitest run --config vitest.integration.config.ts tests/integration/practice-set-schema.test.ts`，预期通过；`pnpm typecheck` 无新增错误。
- [ ] **Step 5: 记录/提交本任务。** 只包含契约、schema、迁移与对应测试，建议提交 `feat: define practice set contracts and compatible storage`。

## Task 2: 修复错题访问、来源与改判状态

**Files:** 修改 `modules/learning/{mistakes,corrections,mistake-routes}.ts`、`modules/materials/service.ts`；测试 `tests/integration/mistakes.test.ts`，新增 `mistake-provenance.test.ts`、`mistake-shared-question.test.ts`。

**Interfaces:** 保留 `MistakeService.add(scope,input): Promise<MistakeDTO>`；新增 `listPage(scope,filter): Promise<MistakePage>`；`applyAssessment(scope,assessmentId)` 保留调用形状并保证最新有效评估优先。来源只在服务端推导，客户端不能宣称他人的来源。

- [ ] **Step 1: 编写回归用例。** 合法学生在自己的 task 上答错共享题能够入库；没有合法 task/attempt 时拒绝；另一个学生的私题、attempt、图片均拒绝。断言：

  ```ts
  expect(saved.originCategory).toBe("learning");
  expect(saved.originalAttemptId).toBe(attempt.id);
  expect(afterDuplicate.id).toBe(saved.id);
  expect(afterCorrection.lifecycle).toBe("revoked");
  // uploaded material stays uploaded after a later review with image evidence.
  ```

- [ ] **Step 2: 运行红灯。** `pnpm exec vitest run --config vitest.integration.config.ts tests/integration/mistake-shared-question.test.ts tests/integration/mistake-provenance.test.ts`；预期现有共享题限制或来源/改判断言失败。
- [ ] **Step 3: 实现授权与投影。** 个人题按所有者；共享题按合法任务与作答关联并复用题库访问规则。首次来源与题目版本固化，后续事件追加。改判且无其他有效错误时 lifecycle=revoked；新有效错误可重新激活；不伪造 mastered。变式仍沿用原错题关系和晋级规则。分页按服务端 origin/status/archive 组合过滤，pageSize 1～50；originCounts 服从状态/归档条件但不受所选 origin 限制。旧无 page 参数请求保留数组响应。
- [ ] **Step 4: 验证。** 运行新测试及 `tests/integration/mistakes.test.ts`、`tests/unit/state-rules.test.ts`，预期全部通过，原独立变式/24 小时晋级门槛不变。
- [ ] **Step 5: 记录/提交。** 建议 `fix: admit authorized shared questions into scoped mistakes`。

## Task 3: 正式判题与错题同步成为可靠事件链

**Files:** 新增 `jobs/{assessment-job,mistake-sync-job}.ts`；修改 `learning/{assessments,attempts}.ts`、`conversations/runs.ts`、`app.ts`、`jobs/queue.ts`、`agent/tools.ts`。新增 `tests/integration/assessment-mistake-sync.test.ts`，扩展 `assessment-learning-flow.test.ts`、`jobs.test.ts`。

**Interfaces:** `AssessmentService.assessAttempt(scope,attemptId,signal): Promise<AssessmentDTO>` 自动产生候选并核验；`submitCandidate` 仍用于旧工具兼容，但统一进入 `persistAssessmentAndEnqueueSync(...)` 事务。`assessmentHandler(service): JobHandler` 消费 learning.assess；`mistakeSyncHandler(service): JobHandler` 消费 learning.mistake-sync。所有正式作答入口在保存 attempt 的事务中 enqueue learning.assess，dedupeKey 为 attempt ID。

- [ ] **Step 1: 故障测试。** 模型自然语言说“错了”不产生错题；正式提交不依赖 Agent 主动调用 submit_assessment 仍完成评估。注入“评估落库后进程中断”、同步暂时失败、旧错误事件晚到、第三次租约过期：

  ```ts
  expect(assessmentCount).toBe(1);
  expect(syncJobCount).toBe(1);
  expect(mistakeCountAfterRetry).toBe(1);
  expect(staleIncorrectEventRevivedMistake).toBe(false);
  expect(progressAfterLeaseExhaustion.mistakeSync).toBe("failed");
  ```

- [ ] **Step 2: 运行红灯。** `pnpm exec vitest run --config vitest.integration.config.ts tests/integration/assessment-mistake-sync.test.ts`，预期事务/自动判题链断言失败。
- [ ] **Step 3: 实现事件链。** 模型计算在事务外，评估与同步 job 在短事务内落库；按 attempt 锁/请求去重，同一最终评估复用。将诊断/画像后置，不能先失败而漏发错题事件。app.ts 不再有另一条非事务“先评估再直接同步”写库路径。同步重读最新有效评估、幂等追加事件并更新投影。queue.fail、最终租约耗尽 SQL、取消和手动重试均更新 failed/pending 状态；重试既有 attempt，不重复创建。记录安全错误码，不记录学生全文。
- [ ] **Step 4: 验证。** 运行新测试及 `assessment-learning-flow.test.ts`、`jobs.test.ts`、`runs.test.ts`、`assessments.test.ts`，预期通过；旧工具和 HTTP 提交均仅有一条可靠路径。
- [ ] **Step 5: 记录/提交。** 建议 `fix: persist assessment and mistake synchronization reliably`。

## Task 4: 历史错题补齐工具

**Files:** 新增 `modules/learning/mistake-backfill.ts`、`scripts/backfill-mistakes.ts`、`tests/integration/mistake-backfill.test.ts`；修改 `package.json` 增加 `backfill:mistakes`。

**Interfaces:** `backfillMistakes(scopeFilter,{apply,cursor,batchSize}): Promise<{scanned,eligible,inserted,skipped,nextCursor}>`；CLI 默认 dry-run，`--apply` 才写，支持 `--student-id`、`--cursor`、`--batch-size`（1～500，默认 100）。

- [ ] **Step 1: 写测试。** 最新有效 verified incorrect 缺记录才 eligible；pending/失效证据/只有聊天文本排除；资料来源 uploaded、练习来源 learning、歧义 unknown。断言 `dryRun.inserted===0` 且数据库未变，连续 apply 两次主体与事件数量不增长；游标分页不漏记录。
- [ ] **Step 2: 红灯。** `pnpm exec vitest run --config vitest.integration.config.ts tests/integration/mistake-backfill.test.ts`。
- [ ] **Step 3: 实现。** 复用任务 2 服务与授权/来源推导，不写第二套判题算法。按稳定 `(created_at,id)` 游标分批，不一次扫描/加载全部图片；报告只含计数、ID 和原因码。补齐来源不回填耗时、不重写原始答案。
- [ ] **Step 4: 绿灯。** 运行上述集成测试；`pnpm backfill:mistakes --help` 显示 dry-run 默认及 apply 参数，不连接真实数据验证效果。
- [ ] **Step 5: 记录/提交。** 建议 `feat: add resumable dry-run mistake backfill`。

## Task 5: 学生可见内容的中文边界

**Files:** 新增 `modules/question-bank/student-language.ts`；修改 `agent/{prompts,tutor}.ts`、`learning/{practice,assessments}.ts`、`question-bank/generator.ts`、`tutoring/service.ts`、`jobs/summary-job.ts`；新增 unit `student-language.test.ts`、integration `student-language-output.test.ts`。

**Interfaces:** `inspectStudentText(text): {status:"accepted"|"repair_required",reasonCodes:string[]}`；`ensureStudentContent({fields,immutableMath,policyVersion},gateway,signal): Promise<LanguageCheckedContent>`；`StudentTextGate.push(delta)`/`finish()` 返回已检查可发布块，`cancel()` 丢弃缓冲。policyVersion=`zh-student-v1`。LanguageCheckedContent 保留 checked fields、status、policyVersion，不暴露内部提示。

- [ ] **Step 1: 写语料/流测试。** 覆盖“求 y=sin x 的周期”、cos、x/y、单位、必要专名、纯英文题干、中文夹完整英文句、英文选项解释、中文答案和英文解析。跨 chunk 包含未闭合 LaTeX、换行、无句号长块与取消；断言不在检查前发出原英文，不损坏公式，取消不发布剩余缓冲，最终保存文本等于已发布正文。
- [ ] **Step 2: 红灯。** `pnpm exec vitest run --config vitest.unit.config.ts tests/unit/student-language.test.ts`。
- [ ] **Step 3: 实现。** 公式/代码片段结构化保护，规则预检结合一次受控模型修复，不用任意英文字母禁令或单纯汉字比例。修复只允许描述变化；数学条件变动交回候选重新核验。主流式事件在 runs.events.append 前经过 gate；状态提示可先发。单个未闭合块缓冲超过 4096 字符时进入整块检查/重试，不无限增长或直通。失败发固定中文恢复提示。历史题按版本生成中文展示缓存，旧聊天不改写；接入提示暴露登记。
- [ ] **Step 4: 验证。** 运行新 unit/integration 和 `tests/integration/tutor.test.ts`、`question-generation.test.ts`、`tutoring-actions.test.ts`，使用 fake gateway，不以真实网关偶发输出作为唯一回归依据。
- [ ] **Step 5: 记录/提交。** 建议 `feat: enforce Chinese student content before publication`。

## Task 6: 结构化题型、答案规范与核验

**Files:** 新增 `question-bank/presentation.ts`；修改该目录 `templates.ts`、`verifier.ts`、`generator.ts`、`search.ts`、`learning/{practice,verifier,tasks}.ts`；扩展 `tests/unit/{question-templates,verifier}.test.ts`，新增 `question-presentation.test.ts`、integration `structured-questions.test.ts`。

**Interfaces:** `validateQuestionPresentation(candidate): ValidatedQuestion`；`serializeAnswer(question,answer): string`；`verifyStructuredAnswer(questionVersionId,answer,evidence,signal): Promise<VerificationResult>`。已发布候选的 `questionType/presentation/answerSpec` 来自任务 1；公开 DTO 经 `toPublicQuestion(version)` 明确挑字段。

- [ ] **Step 1: 写测试。** 单选唯一解、选项 ID 稳定；多选顺序无关/重复 ID 拒绝/漏选判错；多空空位对应与分数等价；表达式不能执行 JS；解答题不同合理解法不因参考文字不同而拒绝。断言公开 JSON 不包含 referenceAnswer、answerSpec、rubric。候选选项缺失/多解/中文修复改条件时拒绝发布。
- [ ] **Step 2: 红灯。** `pnpm exec vitest run --config vitest.unit.config.ts tests/unit/question-presentation.test.ts tests/unit/verifier.test.ts`。
- [ ] **Step 3: 实现。** 扩展现有确定性模板成单选/填空/要求步骤的解答表达，数学解保持一致；干扰项不得重复或与正确项等价。worked 参考核验依据条件和评分要点，不再只比全文。LLM 候选带结构化 schema 并通过任务 5 语言门槛。choice 保留 legacy A-D 兼容，新增选项使用稳定 ID；旧题未可靠识别保持 legacy。bank search 的题型参数真实进入 SQL/筛选，不只在 schema 中声明。
- [ ] **Step 4: 验证。** 定向 unit、新 integration，加 `question-generation.test.ts`、`question-bank-access.test.ts`、`assessments.test.ts`；预期合法题可发布，坏候选被拒绝且无答案泄露。
- [ ] **Step 5: 记录/提交。** 建议 `feat: support structured choices blanks and worked answers`。

## Task 7: 五题蓝图、考试配额和可回放选择

**Files:** 新增 `learning/practice-blueprint.ts`、`question-bank/exam-profiles.ts`、`tests/unit/practice-blueprint.test.ts`；修改 `learning-profile/{selection-policy,selection-service}.ts`、`question-bank/search.ts`。

**Interfaces:** `buildBlueprint({strategy,examProfile,seed}): PracticeBlueprint`；`allocateExamQuota(weights,total=5): TypeQuota`；`selectSlotCandidate({slot,scopeSnapshot,profile,candidates,recent,seed}): SlotSelection`。复用原推荐排序与原因码，抽取无写入的选题计算供协调器调用，不复用“顺便追加 task_items”的副作用。

- [ ] **Step 1: 写确定性测试。**

  ```ts
  expect(countTypes(buildBlueprint({ strategy: "mixed", seed: "fixed" })))
    .toEqual({ single_choice: 2, fill_blank: 2, worked: 1 });
  expect(sum(allocateExamQuota({ single_choice: 1, fill_blank: 1, worked: 1 }, 5))).toBe(5);
  // equal remainders: fixed type order; repeated seed+snapshot gives same decisions;
  // ineligible scope, withdrawn knowledge, private candidates and recent exact repeats excluded.
  ```

- [ ] **Step 2: 红灯。** `pnpm exec vitest run --config vitest.unit.config.ts tests/unit/practice-blueprint.test.ts`。
- [ ] **Step 3: 实现。** 默认 mixed-v1，考试最大余数法和固定并列顺序按 Spec。profile 版本固化，权重负值/全零拒绝。生产不预置伪造官方考试配置；测试可用明确标记的 fixture。范围、发布和难度优先于配额，缺题型返回理由而不是静默替换；保持原 repair/review/transfer 规则。记录种子和候选快照供回放。
- [ ] **Step 4: 绿灯。** 运行上述测试、`tests/unit/adaptive-selection.test.ts`、`tests/integration/adaptive-practice.test.ts`，证明新蓝图不改变旧任务推荐行为。
- [ ] **Step 5: 记录/提交。** 建议 `feat: plan mixed practice with replayable type quotas`。

## Task 8: 题组协调器与后台补题

**Files:** 新增 `learning/practice-sets.ts`、`jobs/practice-set-job.ts`；修改 `learning/{tasks,practice}.ts`、`learning-profile/selection-service.ts`、`agent/{prompts,tools,context}.ts`、`app.ts`、`jobs/queue.ts`；新增 `tests/integration/practice-set-generation.test.ts`。

**Interfaces:** `PracticeSetService.create(scope,taskId,input): Promise<PracticeSetDTO>`、`get(scope,setId)`、`getByTask(scope,taskId)`、`retryGeneration(scope,setId,input)`、`fillSlot(scope,setId,position,signal)`；`practiceSetHandler(service): JobHandler` 消费 `learning.practice-set`。create 固化范围/蓝图并入队，模型调用在事务外，槽位绑定在事务内。

- [ ] **Step 1: 写故障/并发测试。** 两次 create 返回同组；并发填同槽只绑定一次；每组仅五个正式槽；第六次旧工具追加失败；diagnostic 微题不占槽。一个槽位核验失败时其余题 ID 不变；两次候选后停止该槽；全组最多十次；租约最终失败投影为 failed。范围未知返回 awaiting_scope，不编造内容。
- [ ] **Step 2: 红灯。** `pnpm exec vitest run --config vitest.integration.config.ts tests/integration/practice-set-generation.test.ts`。
- [ ] **Step 3: 实现。** 单个 job 顺序准备五槽，复用已发布题、任务 6 生成核验和任务 7 选择。外部调用后再次检查槽位版本/租约再落库；旧 worker 不得覆盖新结果。旧 propose_practice/next_practice 在有 set 时走协调器；所有 add/attach/skip/transition 路径同步校验 set，不能绕过配额和完成规则。对旧每日任务显式转换时匹配已有 items、保留 ID、只补空槽；legacy 不伪装为满足新配额。
- [ ] **Step 4: 绿灯。** 跑新测试、`task-continuation.test.ts`、`adaptive-practice.test.ts`、`question-generation.test.ts`、`jobs.test.ts`。题库撤回后未提交槽位重新校验，说明不足；已作答历史证据保留。
- [ ] **Step 5: 记录/提交。** 建议 `feat: coordinate five-slot practice generation and retries`。

## Task 9: 统一提交、草稿和进度聚合

**Files:** 新增 `learning/{answer-submission,practice-drafts}.ts`；修改 `attempts.ts`、`assessments.ts`、`tasks.ts`、`conversations/runs.ts`、`tutoring/timing-service.ts`；新增 integration `practice-set-submission.test.ts`、`practice-answer-drafts.test.ts`，unit `practice-progress.test.ts`。

**Interfaces:** `AnswerSubmissionService.submit(scope,setId,input:SubmitPracticeInput): Promise<SubmissionDTO>`、`retry(scope,submissionId,input)`、`get(scope,submissionId)`；`PracticeDraftService.put(scope,setId,itemId,{expectedVersion,answer}): Promise<DraftDTO>`、`list(scope,setId)`；`computePracticeProgress(snapshot): {submission,counts,canContinue}` 为纯函数。

- [ ] **Step 1: 写测试。** 逐题与整组均创建合法 attempt/message/payload；同键同内容复用、异内容 409；任意 item/option/blank/附件越权使整批回滚；一个判题失败只重试该题；草稿版本冲突不覆盖新内容；hint 与“问老师”不创建 attempt。

  ```ts
  expect(progressWithUnverified.submission).toBe("needs_review");
  expect(progressWithQueued.canContinue).toBe(false);
  expect(progressWithUnsyncedMistake.canContinue).toBe(false);
  expect(progressWithFourVerifiedAndOneSkipped.counts.skipped).toBe(1);
  expect(progressWithFourVerifiedAndOneSkipped.canContinue).toBe(true);
  ```

- [ ] **Step 2: 红灯。** `pnpm exec vitest run --config vitest.unit.config.ts tests/unit/practice-progress.test.ts` 和定向 submission integration；预期旧 answered 逻辑不符合完成断言。
- [ ] **Step 3: 实现。** 短事务保存 batch submission/items、原始 message、attempt、附件及计时快照、判题 job；同一 finalize 中已处理项引用旧结果不重复写 attempt。step finalize=false，最后一题仍由聚合判断完成；batch finalize=true 验证空题显式跳过。answered 保留兼容但完成只由新聚合判定。错题全部同步后完成 task 并 enqueue summary。计时只关联实际 episode；整组无逐题计时证据则 missing，不把一份总时间复制五份。正式答案修改追加订正 attempt，不覆盖首次答案。
- [ ] **Step 4: 验证。** 新测试及 `assessment-mistake-sync.test.ts`、`learning-timing.test.ts`、`conversation-images.test.ts`、`runs.test.ts`、`assessment-learning-flow.test.ts`，预期通过。
- [ ] **Step 5: 记录/提交。** 建议 `feat: submit practice answers with reliable per-item progress`。

## Task 10: 偏好、继续练习和完整 API

**Files:** 新增 `learning/{practice-preferences,practice-set-routes}.ts`；修改 `practice-sets.ts`、`tasks.ts`、`app.ts`、`config.ts`、`agent/context.ts`、`conversations/runs.ts`；新增 integration `practice-set-routes.test.ts`、`practice-set-continuation.test.ts`、`practice-preferences.test.ts`。

**Interfaces:** `PracticeSetService.continue(scope,setId,{requestKey,expectedVersion}): Promise<ContinueResult>`、`changeMode(scope,setId,{expectedVersion,mode})`、`results(scope,setId)`；`PracticePreferencesService.get(scope): Promise<PreferencesDTO>`、`patch(scope,input)`；`registerPracticeSets(app,deps)` 注册 Spec 第 9 节所有题组 API。

- [ ] **Step 1: 写接口与并发测试。** 完成前 continue 拒绝；同时两个 requestKey 的双击也只有一个直接后继；成功重试携带旧 expectedVersion 仍返回原后继，同键异内容 409；重试继承范围/模式/策略且排除上组；失效考试配置明确报错/要求选择替代。mode 切换不换题和删除 draft。关闭新建开关，既有 set 仍能 submit/retry/complete。完成后问老师只写咨询消息，不激活任务或新增正式题。batch 未交卷 results 不暴露答案。
- [ ] **Step 2: 红灯。** `pnpm exec vitest run --config vitest.integration.config.ts tests/integration/practice-set-routes.test.ts tests/integration/practice-set-continuation.test.ts tests/integration/practice-preferences.test.ts`。
- [ ] **Step 3: 实现。** continue 锁原 set、唯一 predecessor 映射、同事务创建新 task/conversation/set，返回定位信息。偏好 mode=null 表示未显式选，前端才按设备推荐；旋转不写偏好。分页/DTO/错误码依 Spec；requestKey 不跨 scope 共用。新 capability 返回开关，后端检查不能只隐藏按钮。完成任务咨询使用显式 intent=question，禁止夹带 questionVersionId/answer 的正式提交字段。
- [ ] **Step 4: 绿灯。** 上述测试和 `tests/integration/task-continuation.test.ts`、`learning-unbound.test.ts`、`auth.test.ts`、`tests/unit/config.test.ts`，预期通过。
- [ ] **Step 5: 记录/提交。** 建议 `feat: expose practice APIs and idempotent next sets`。

## Task 11: 逐题与整组作答 UI

**Files:** 新增文件地图中的 practice API/hooks/组件；修改 `routes/Study.tsx`、`QuestionCard.tsx`、`features/tutor/{Composer,useTutorRun}.tsx/.ts`、`lib/types.ts`、`lib/auth.tsx`；新增 `tests/e2e/practice-modes.spec.ts`、unit `practice-draft-cache.test.ts`，修改 UI API fixture。

**Interfaces:** `usePracticeSet(taskId)` 提供 set/selectedItemId/selectItem/changeMode/submit/retry/continue；`useAnswerDrafts({studentId,setId})` 提供 per-item draft/update/flush/conflict；`PracticeQuestionCard({item,answer,onChange,onSubmit})` 只接受公开题目；Composer 增加 `intent:"answer"|"question"` 与可见目标，不在组件内判正误。

- [ ] **Step 1: 写用户流程测试。** 手机首次 step、宽屏首次 batch；显式偏好优先。2 单选 2 填空 1 解答能分别输入；切题、切模式、刷新后答案恢复；两个标签页冲突提示；点选不即交。咨询保留答案草稿且不改进度；batch 空题确认、部分批改失败、跳过计数、提示后独立性可见；不出现提前可用“再来五题”。缓存退出登录清理且不含签名 URL。
- [ ] **Step 2: 红灯。** `pnpm exec playwright test tests/e2e/practice-modes.spec.ts`；测试环境使用既有受保护的 real-server 与固定模型 stub，不调用真实付费模型。
- [ ] **Step 3: 实现。** selectedItemId 替代“第一个 pending 即当前题”的唯一假设；mode 仅控制视图。编辑立即写 scoped sessionStorage，800ms 防抖服务端；版本冲突显示恢复选项，不静默覆盖。results 来自接口；已提交显示 queued/running/pending/failed 等真实状态。完成保留咨询 composer 和三个快捷胶囊；continue 导航使用后端返回的 taskId。切题暂停现有 episode，展示 priorExposure；不对同屏每题同时计时。
- [ ] **Step 4: 绿灯。** 定向新 E2E/unit，加现有 `tutor-ui.spec.ts`、`learning-journey.spec.ts`、`task-continuation.spec.ts`、`learning-timing.spec.ts`、`chat-images.spec.ts`；预期通过。
- [ ] **Step 5: 记录/提交。** 建议 `feat: offer step and batch practice with persistent drafts`。

## Task 12: 手机学习壳与三端适配

**Files:** 新增 `MobileStudyShell.tsx`、`PracticeComposerDock.tsx`、`useStudyViewport.ts`、`practice.css`；修改 `AppShell.tsx`、`SessionRail.tsx`、`routes/{Home,Study}.tsx`、`Composer.tsx`、相关 global.css 和 `DESIGN.md`；新增 `tests/e2e/mobile-practice.spec.ts`，扩展 `responsive.spec.ts`。

**Interfaces:** `MobileStudyShell({header,progress,children,dock})` 管单一顶栏/滚动区；`PracticeComposerDock({actions,target,children})` 用 ResizeObserver 报告 dock 实际高度；`useStudyViewport()` 返回可用视口/键盘增强信息，不决定业务模式或重置状态。

- [ ] **Step 1: 写布局行为测试。** viewport 320×740、390×844、430×932、768×1024、1024×768、1440×900；断言 document scrollWidth 不超过 clientWidth、触控目标至少 44px、正文可读。题组页不叠加全局底部导航；首页四入口和真实最近任务可点击；软键盘模拟 resize、附件变高、长公式、上翻后流更新均不遮挡发送或抢滚动。
- [ ] **Step 2: 红灯。** `pnpm exec playwright test tests/e2e/mobile-practice.spec.ts tests/e2e/responsive.spec.ts`。
- [ ] **Step 3: 实现。** 沿用已批准颜色/字体，参考 nero-agent 的卡片节奏和 dock。dvh、安全区、visualViewport 增强及 ResizeObserver 互相只算一次 inset。单列/双栏按 Spec 最小宽度回退。更多操作与图片入口用现有 Radix Dialog 做底部弹层，焦点返回触发按钮，Esc/遮罩关闭。问老师/回答本题状态切换保留各自草稿。触控 Enter 换行，桌面 Enter 发送，composition 不提交；禁用动画尊重 reduced-motion。
- [ ] **Step 4: 验证并目视检查。** 运行新 E2E 与 `design-system.spec.ts`、`content-ui.spec.ts`、`session-switch-progress.spec.ts`；批量截取上述尺寸检查留白、题干、公式、输入和错误状态。真实 iOS Safari/Android Chrome 检查键盘、拍照、旋转，记录设备/浏览器/结果；没有设备时标未执行。
- [ ] **Step 5: 记录/提交。** 建议 `feat: adapt study navigation and composer across devices`。

## Task 13: 错题来源页签与可追溯详情

**Files:** 修改 `routes/{Mistakes,MistakeDetail}.tsx`、`routes/admin/students/{Mistakes,MistakeDetail}.tsx`、`features/student-insights` 中相关 DTO 消费、`lib/types.ts`；新增 `tests/e2e/mistake-origins.spec.ts`，扩展 integration `admin-student-insight-records.test.ts`。

**Interfaces:** 客户端使用任务 2 的 MistakePage；来源 query=`uploaded|learning|unknown` 或不传。来源/状态/归档/分页放 URL，刷新保留；详情使用服务端已授权的证据链接。

- [ ] **Step 1: 写测试。** 超过 100 条混合来源时分页筛选仍能找到正确记录；unknown 仅在全部展示并有标记；来源计数与服务器一致。照片练习属于学习错题，上传资料属于上传错题。点击“已加入学习错题”打开对应详情；未 synced 显示等待/失败，不能先显示成功。撤销记录保留历史，默认待订正列表排除。
- [ ] **Step 2: 红灯。** `pnpm exec playwright test tests/e2e/mistake-origins.spec.ts`。
- [ ] **Step 3: 实现。** 全部/上传错题/学习错题页签与组合筛选；来源变更回到第一页；列表与详情保留 loading/empty/error/retry。详情展示原题版本、原始作答、任务/会话/消息定位、错因待确认与复习状态。管理员沿用现有访问控制，不扩大权限；旧数组接口消费者保持兼容直到迁移完成。
- [ ] **Step 4: 绿灯。** 跑新 E2E、`admin-student-records.spec.ts`、`tests/integration/admin-student-insight-records.test.ts` 及 task 2 的权限测试，预期通过。
- [ ] **Step 5: 记录/提交。** 建议 `feat: separate uploaded and learning mistake views`。

## Task 14: 全链路验收、运行手册与发布准备

**Files:** 新增 `docs/runbooks/mobile-mixed-practice.md`、`tests/e2e/mixed-practice-journey.spec.ts`；修订本设计/计划中的实际实现记录及 `README.md` 的相关入口说明。只修正验收发现的本范围问题，不顺手重构其他模块。

**Interfaces:** 不新增业务接口；验证前面任务形成同一套闭环。运行手册记录开关、job 种类、dry-run/apply、重试、故障计数和回滚步骤。

- [ ] **Step 1: 写端到端旅程。** 创建五题→切换 batch/step→咨询与正式提交→其中一题判错→模拟同步暂时失败→恢复入学习错题→跳过一题并完成→再来五题→验证新任务/唯一后继/继承配置/上一组不变。另覆盖开关关闭后完成既有组、旧每日任务不被重抽、改判后错误事件晚到不复活错题、历史无计时保持 missing。
- [ ] **Step 2: 首次运行旅程定位集成缺口。** `pnpm exec playwright test tests/e2e/mixed-practice-journey.spec.ts`；若已通过，记录通过，不为满足红灯机械制造失败。
- [ ] **Step 3: 修正集成缺口并写手册。** 明确两开关默认 false；列出 learning.assess/learning.mistake-sync/learning.practice-set 的失败处理。补齐脚本先 dry-run，经核对再在另行授权的真实环境 apply。回滚只停止新建与新布局，继续消费既有任务；不删表、不丢已提交答案。日志/计数不含学生全文或签名 URL。
- [ ] **Step 4: 完整验证。** 依次运行以下命令，保存退出码与摘要，全部通过才宣称代码完成：

  ```bash
  pnpm typecheck
  pnpm lint
  pnpm test:unit
  pnpm test:integration
  pnpm build
  pnpm test:e2e
  ```

  集成/E2E 环境缺少时列为未执行，不能用 mock unit 冒充完整通过。核对 Spec 第 11 节每行有自动或人工结果，真实移动设备结果单独记录。检查 `git diff --check` 和实际 diff，确认参考仓库、密钥、私人附件没有变化。

- [ ] **Step 5: 交付可审阅结果。** 记录修改摘要、命令结果、未完成的真实设备/环境检查和剩余风险；建议提交 `test: verify mobile mixed practice and document recovery`。用户本轮只要求文档，实施、真实数据补齐、发布均不在本次执行范围。

## 2. 需求到任务的覆盖表

| 已确认需求 | 设计章节 | 实施任务 | 核心证据 |
|---|---|---|---|
| 参考 nero-agent 优化手机 | 2.2、3 | 11、12 | mobile-practice、responsive、真实移动浏览器检查 |
| 随机/按考试结构混合题型 | 4 | 1、6、7、8 | 配额、回放、缺题型、核验失败及生成重试测试 |
| 再来五题 composer 胶囊 | 6.4、6.5 | 9、10、11、14 | 完成条件、唯一后继并发、整条学习旅程 |
| 五题一起出或逐题出 | 3、5、6 | 8、9、10、11、12 | 模式切换、独立草稿、统一交卷、三端布局 |
| 中文题目/提示/答案 | 7 | 5、6 | 混合语料、流式缓冲、修复数学一致性、历史缓存 |
| 会话错题自动入库 | 8.1、8.2 | 2、3、9、14 | 共享题授权、自动评估、事务故障、重试/租约耗尽 |
| 上传错题/学习错题分类 | 8.3、8.4 | 1、2、4、13 | 来源判定、历史 dry-run/apply、分页与详情 |
| 保留提示依赖/计时/历史兼容 | 6.3、8、10 | 1、2、8、9、10、11、14 | 独立性、单活动 episode、改判/回退与历史任务测试 |

## 3. 实施前自检记录

- 设计与计划使用同一 mode/strategy/questionType、状态枚举、五槽位置与配额。
- 正式提交、Agent 工具、批量交卷均归一到判题/错题事件链，不能各实现一套写库逻辑。
- task_items.answered 不等于判定完成；pending、failed、未同步错题均阻止新题组完成。
- 公共 presentation 与私有 answerSpec 分开；batch 的结果可见性和语言缓存不成为答案泄露路径。
- 题型不足、考试配置缺失和历史来源不明都有显式行为，不依赖实现者临时猜测。
- 本计划已给出测试归属和验证命令；所有任务保持未勾选，等待后续实际实施。
