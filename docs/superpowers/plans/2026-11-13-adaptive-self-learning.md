# 自查引导、解题效率与自适应练习 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 分三阶段建立有证据的错因诊断与自查、纳入解题效率的动态练习、可追溯的教学效果评估。

**Architecture:** 在现有 Fastify 单体中增加 tutoring、question-bank、learning-profile 模块；复用作答/核验/错题状态、ModelGateway、PostgreSQL 队列和学情快照。AI 只提候选诊断与教学内容，后端控制权限、时间累计、教学状态、题目发布和推荐。有效时间先可靠采集，第二阶段才用合格个人基线参与教学安排。

**Tech Stack:** TypeScript、Node >=22.22.0、pnpm 10.30.3、React 19、Fastify 5、PostgreSQL/Drizzle、Zod、Vitest、Playwright；使用现有依赖，不新增基础设施。

**Spec:** [2026-11-13-adaptive-self-learning-design.md](../specs/2026-11-13-adaptive-self-learning-design.md)

## Global Constraints

- 诊断讲证据，反馈保护自信；不能为了鼓励而把知识缺口伪装成粗心或习惯问题。
- 答案正误与错因判断独立；可以“已确认答错，但错因待确认”。
- 时间是熟练度和诊断的一个维度；不能单凭快慢判断能力、态度或错因。
- 正确性和独立性优先于速度；慢而正确不阻止知识掌握状态晋级，快而错误不获得能力加分。
- 允许求助、例子、直接讲解和暂停；不强迫学生在提示循环里反复猜测。
- 不因未点击、未输入而推断走神；学生可能在纸上计算。
- 学生自行发现问题必须有后续步骤修正或解释证据，不能仅凭“我懂了”认定。
- 不恢复年级、科目、教材选择，不删除旧教材表；未发布知识点和未正式准入题不可进入新推荐。
- 无数据为 null，不写 0；历史未计时的数据保持 missing，不回填推算耗时。
- 当前部署基线单实例 2 核 2GiB；复用 PG JobQueue，不引入向量库/Redis，不批量将全库注入模型。
- 功能开关默认 false；关闭新能力继续原有学习流程，计时失败不能阻断有效答案提交。
- 测试只使用独立 `_test` 数据库；真实密钥、真实学生原始材料不提交 Git。
- 迁移只增量执行；编写时最大编号 0022，实施时重新检查，更新 Drizzle journal，不覆盖旧迁移、不 reset 数据库。
- 本文只记录未来实施步骤；所有复选框未勾选，不表示代码已实现或测试已通过。本次文档工作不执行产品实现、迁移、部署或 Git 提交。

## Review Focus

- 计时中断、纸笔长时间无输入、组件重挂、多标签/多设备：不漏算已确认时间、不补算未知缺口、不重复累计；任务 3/4/5 覆盖。
- 同一错误答案可能来自不同原因，慢正确和快错误均不能单独确认错因；任务 6/11/12 覆盖。
- 讲解已经发出但展示回执丢失、自由文本绕开提示工具：不得作为独立作答；任务 7/8 覆盖。
- 私人上传题、未审核题和被撤回知识点不能经检索/推荐泄露，幂等键也不能跨学生复用；任务 9/10/12 覆盖。
- 修改题干/作答或教师推翻诊断后，画像和推荐不能继续使用失效证据，也不能重写历史决策；任务 6/11/14/15 覆盖。

---

## 0. 执行准备、任务依赖与阶段门槛

- [ ] 读取 Spec、`README.md`、`docs/architecture.md`、`DESIGN.md`、`apps/server/src/agent/{prompts,tools,tutor,context}.ts`、`modules/learning/{attempts,assessments,practice,state-rules,knowledge}.ts`、`apps/web/src/routes/Study.tsx`；其中 modules 相对 `apps/server/src`。
- [ ] 记录 `git status --short`、当前迁移编号、Node/pnpm 版本；不覆盖未提交工作。沿用适合的当前 checkout，必要隔离时使用原生 worktree 工具。
- [ ] 执行 `pnpm typecheck`、`pnpm test:unit` 记录基线；配置 `_test` PG 后执行集成基线，缺少环境如实记录，不改为生产库。
- [ ] 按任务提供的测试先验证失败原因，再实现，再验证通过；不把编译错误以外的失败掩盖为“预期红灯”。每任务完成后只精确提交其相关文件。

依赖与顺序：

```text
阶段一：1 → 2 → 3 → 4 → 5
             └────────→ 6 → 7 → 8 → 阶段一评估/白名单
阶段二：8 → 9 → 10 → 11 → 12 → 13 → 阶段二影子策略/启用
阶段三：13 → 14 → 15 → 16 → 效果评估/分阶段发布
```

按顺序实现，无需并行执行。1～8 可独立交付；9～13 不要求先有群体统计；14～16 补完善的人审与评估闭环。每阶段必须完成对应测试、人工内容复核和回滚演练才开启开关。文档中的提交命令是未来执行步骤，不授权当前文档任务提交代码。

## 1. 文件职责与共享接口

### 1.1 文件地图

| 区域 | 新增文件 | 现有集成点 |
|---|---|---|
| 契约 | `packages/contracts/src/tutoring.ts`、`learning-timing.ts`、`question-bank.ts`、`learning-profile.ts`、`learning-evaluation.ts` | `domain.ts` 的 StudentScope/EvidenceRef |
| 数据 | `packages/db/src/schema/tutoring.ts`、`learning-timing.ts`、`question-bank.ts`、`learning-profile.ts`、`learning-evaluation.ts` | `schema/{questions,assessments,conversations,knowledge}.ts`、`index.ts`、迁移 journal |
| 计时/辅导 | `apps/server/src/modules/tutoring/{timing-rules,timing-service,process-evidence,diagnosis-rules,diagnosis-service,anchors,state-rules,service,routes}.ts` | learning 作答/核验、app.ts、Agent tools/context/tutor |
| 题库/技能 | `apps/server/src/modules/question-bank/{skills,service,templates,verifier,search,generator,routes}.ts` | knowledge-base 发布/撤回、learning/practice.ts、jobs |
| 画像/推荐 | `apps/server/src/modules/learning-profile/{efficiency,service,invalidation,selection-policy,selection-service,routes}.ts` | learning/knowledge.ts、现有错题 review |
| 评估 | `apps/server/src/modules/student-insights/{learning-metrics,learning-evaluations,diagnosis-reviews}.ts` | facts/snapshot/report-generator/routes |
| 学生前端 | `apps/web/src/features/tutoring/{api,timing-client,useQuestionTiming}.ts`、`TutoringActions.tsx`、`TimingStatus.tsx`、`DiagnosisSummary.tsx` | Study、Composer、TutorPanel、QuestionCard、MistakeDetail |
| 管理前端 | `apps/web/src/routes/admin/{QuestionBank,LearningSkills}.tsx`、`features/question-bank/api.ts` | App/AppShell、students/RecordDetail/Overview/Analysis |
| 运维 | `scripts/evaluate-tutoring.ts`、`benchmark-adaptive-learning.ts`；对应 runbook、fixture 文档 | package.json、config.ts、jobs/runner.ts |

仅在所属任务首次使用时创建文件，不预建空模块。不拆分无关旧代码。新增 UI 沿用现有设计体系，不启动视觉改版。

### 1.2 跨任务类型（任务 1 定义，后续按此引用）

使用现有 `StudentScope`、`EvidenceRef`，UUID 为 string，时间为 ISO string，时间差为整数毫秒。类型与 Zod schema 同源，禁止两套枚举漂移。

```ts
type TimingQuality = "reliable" | "partial" | "unusable" | "missing";
type TimingPhase = "initial" | "self_check" | "post_hint";
type Exposure = "none" | "guided" | "solution_exposed" | "unknown";
type DiagnosisCode = "execution_slip" | "condition_omission" | "concept_gap"
  | "rule_misuse" | "strategy_gap" | "expression_gap" | "input_issue";
type DiagnosisStatus = "pending" | "needs_probe" | "confirmed" | "unsupported" | "invalidated";
type TeachingState = "awaiting_evidence" | "self_check" | "focused_check"
  | "micro_probe" | "explanation" | "independent_check" | "scheduled_review";
type PracticeGoal = "diagnostic" | "repair" | "transfer" | "review";
type DifficultyBand = "easy" | "medium" | "challenge";
type TrainingBand = "repair" | "consolidation" | "advance";

type TimingEventInput = {
  eventId: string; episodeId: string; leaseEpoch: number; seq: number;
  segmentId: string; kind: "start" | "checkpoint" | "pause" | "resume" | "finish";
  cumulativeActiveMs: number; phase: TimingPhase; expectedVersion: number;
};
type TimingSummary = {
  firstAttemptMs: number | null; selfCheckMs: number | null;
  postHintMs: number | null; totalActiveMs: number | null;
  wallMs: number | null; quality: TimingQuality; reasonCodes: string[];
};
type EpisodeDTO = {
  id: string; studentId: string; taskId: string; questionVersionId: string;
  version: number; leaseEpoch: number; lastSeq: number;
  state: "active" | "paused" | "finished"; teachingState: TeachingState;
  exposure: Exposure; leaseExpiresAt: string; serverAt: string;
  priorExposure: boolean; timing: TimingSummary;
};
type DiagnosisCandidate = {
  code: DiagnosisCode; skillId: string | null;
  status: "hypothesis" | "supported" | "confirmed" | "rejected";
  earliestError: EvidenceRef | null; supports: EvidenceRef[];
  contradicts: EvidenceRef[]; probe: string | null;
};
type DiagnosisDTO = {
  id: string; attemptId: string; version: number; status: DiagnosisStatus;
  primaryCode: DiagnosisCode | null; candidates: DiagnosisCandidate[];
  summary: string; evidence: EvidenceRef[]; ruleVersion: string;
};
type TutoringActionInput = {
  requestKey: string; expectedVersion: number;
  kind: "request_hint" | "request_probe" | "request_example" |
    "request_explanation" | "acknowledge_display" | "pause" | "resume";
  actionId?: string;
};
type TutoringActionDTO = {
  id: string; episodeId: string; stateVersion: number; state: TeachingState;
  exposure: Exposure; displayStatus: "created" | "sent" | "acknowledged" | "unknown";
  content: string; evidence: EvidenceRef[];
};
type EfficiencyObservation = {
  status: "insufficient_samples" | "ineligible" | "observed";
  baselineId: string | null; sampleCount: number; medianMs: number | null;
  timeRatio: number | null; direction: "faster" | "comparable" | "slower" | null;
  reasonCodes: string[];
};
type SelectionRequest = { requestKey: string; expectedProfileVersion: number };
type PracticeDecisionDTO = {
  id: string; status: "selected" | "insufficient_pool" | "awaiting_diagnosis";
  questionVersionId: string | null; goal: PracticeGoal; difficulty: DifficultyBand | null;
  policyVersion: string; profileVersion: number; explanation: string;
  baselineId: string | null;
};
```

补充结构由所属任务在同文件定义：`TimingState` 是 EpisodeDTO 的计时内部快照，增加 `lastReceivedAt, lastCumulativeMs, segmentId, firstSubmittedAt, reasons`；`TimingReduction={state:TimingState; acceptedMs:number; duplicate:boolean}`；`DiagnosisContext={assessmentId,attemptId,questionVersionId,processEvidence:EvidenceRef[],probeEvidence:EvidenceRef[]}`；`TeachingTransitionInput={episode:EpisodeDTO,diagnosis:DiagnosisDTO|null,action:TutoringActionInput,failedChecks:number}`；`ProfileDTO={studentId,skillId,version,stale,trainingBand,recentIndependentCorrect,recentDeterminateCount,efficiency:EfficiencyObservation,evidence:EvidenceRef[]}`。仅 DTO 进入学生 API；诊断原始候选和未筛选证据仅服务内部/管理员可读。

## 阶段一：诊断与自查

### Task 1: 定义契约、开关与不变量

**Files:** Create 上述五个 contracts 文件、`tests/unit/adaptive-contracts.test.ts`；Modify `apps/server/src/config.ts`、`tests/unit/config.test.ts`、`.env.example`。

**Interfaces:** 导出 1.2 的类型及同名 `...Schema`；为 attempts 增量字段定义可选 Zod shape，不改旧字段含义。四个开关使用 Spec 第 11 节原名，默认 false；adaptive=true/self-check=false 启动失败。新增请求拒绝用户传 studentId、总时间、已确认错因与自定义 exposure。

- [ ] 编写失败测试：`timingEventSchema` 拒绝负数、非整数、seq=0；批次 21 条拒绝；动作期望版本必须正整数；旧作答无计时仍可解析。
- [ ] 运行 `pnpm test:unit tests/unit/adaptive-contracts.test.ts tests/unit/config.test.ts`，确认新增断言因缺实现失败。
- [ ] 实现 schema，事件批次 1～20，requestKey 1～120 字，seq/epoch/version 为正整数，累计时间非负整数；诊断最多 3 个候选。
- [ ] 增加配置测试：默认全关闭、布尔解析、矛盾配置拒绝、timing=false/adaptive=true/self-check=true 合法。
- [ ] 重跑上述单测及 `pnpm typecheck`，预期通过。
- [ ] 精确提交：`feat: define adaptive tutoring contracts and feature flags`。

### Task 2: 第一阶段存储、约束与兼容迁移

**Files:** Create `packages/db/src/schema/{tutoring,learning-timing}.ts`、`tests/integration/tutoring-schema.test.ts`、增量 `<next>_tutoring_timing.sql`；Modify db index 与 migration journal。后续阶段表在各自任务再建。

**Interfaces:** 创建 Spec 第 8 节第一阶段所有表。episode 必备 student/task/questionVersion、requestKey、state/version、leaseEpoch/expiry、lastSeq、exposure、priorExposure、start/end/firstSubmittedAt。timing_events 保存事件载荷哈希、服务端接收时间、接受增量；timing_segments 保存 phase/start/end/acceptedMs 与质量原因。快照保存 TimingSummary 与有效事件边界。诊断/候选、动作/状态、outcome 全部带证据版本。

约束：episode `(student_id,request_key)` 唯一；活跃租约按学生部分唯一；`(episode_id,event_id)`、`(episode_id,seq)` 唯一；动作 `(episode_id,request_key)` 唯一；诊断 `(attempt_id,version)` 唯一；outcome `(episode_id,round_no)` 唯一。按 student/task/question/createdAt 建恢复与证据索引。

- [ ] 编写集成测试 `episode_constraints`、`diagnosis_versions_are_append_only`：跨 task/question 组合校验、同学生双活跃冲突、相同事件键唯一、时间非负；验证旧作答仍可写入。
- [ ] 运行 `pnpm test:integration tests/integration/tutoring-schema.test.ts`，预期缺表失败。
- [ ] 增量迁移/Drizzle schema；跨表 student 关系由服务校验及事务保证，不用不存在的跨表 CHECK。
- [ ] 为计时快照与 attempt 关系建立可空外键；episode 与多次 attempt 通过快照关联，不在 attempts 上要求唯一 episode。
- [ ] 运行集成测试，确认旧 migrations 可从空测试库执行且数据不丢失。
- [ ] 精确提交：`feat: persist tutoring episodes and timing evidence`。

### Task 3: 实现可确定性验证的计时归约器

**Files:** Create `apps/server/src/modules/tutoring/timing-rules.ts`、`tests/unit/learning-timing.test.ts`。

**Interfaces:** `reduceTiming(state: TimingState, event: TimingEventInput, receivedAt: Date): TimingReduction`；`summarizeTiming(segments, firstSubmittedAt: Date|null, endedAt: Date|null): TimingSummary`，segments 类型在 contracts 定义为 phase、startAt、endAt、acceptedMs、quality。方法不读 DB/系统时钟，纯输入输出。

- [ ] 写失败断言：段开始后服务累计 15,000ms、客户端累计 20,000ms，只暂认 15,000；封存仍被裁剪则 partial。接收累计 20,000/30,000ms 对应客户端累计 15,000/30,000ms，最终累计必须 30,000，不因抖动变成 25,000；负增量拒绝；间隔 60,001ms 未确认缺口接受 0 并 partial；同事件不再累计。
- [ ] 运行 `pnpm test:unit tests/unit/learning-timing.test.ts`，预期缺实现失败。
- [ ] 实现 15 秒 checkpoint/60 秒 lease 和缺口规则；phase 从服务端教学状态验证，初次提交边界冻结；暂停/等待区间贡献 0。
- [ ] 添加场景：前台 120 秒无输入但持续心跳可计时；隐藏后恢复不自动计时；firstAttemptMs 与 postHintMs 窗口交叉但 totalActiveMs 不重复；断网保留确认区间；时钟倒退 unusable；超过 2,000 事件关闭连续段。
- [ ] 重跑单测，预期全部通过，使用固定毫秒数据，不做真实等待。
- [ ] 精确提交：`feat: calculate reliable segmented learning time`。

### Task 4: 计时 API、租约并发与作答原子绑定

**Files:** Create `modules/tutoring/{timing-service,routes}.ts`、`tests/integration/learning-timing.test.ts`；Modify `modules/learning/{attempts,routes}.ts`、`apps/server/src/app.ts`。本任务 modules 均相对 `apps/server/src`。

**Interfaces:** `TimingService.start(scope,input):Promise<EpisodeDTO>`、`.get(scope,id):Promise<EpisodeDTO>`、`.append(scope,id,events:TimingEventInput[]):Promise<EpisodeDTO>`、`.attachAttempt(tx,scope,attemptId,episodeId?,finalEvent?):Promise<{timing:TimingSummary;warning:string|null}>`。路由按 Spec 第 9 节。start 使用 student 行锁串行建立/接管租约；append 对 episode FOR UPDATE。

- [ ] 写失败集成：两个并发 start 只有一个活跃 lease；显式接管使旧 epoch 409；相同事件相同载荷重试成功，不同载荷 409；乱序返回恢复快照。
- [ ] 运行 `pnpm test:integration tests/integration/learning-timing.test.ts`。
- [ ] 实现所有计时路由及作用域校验；actor 身份不由请求体推导。等待 AI 的边界由服务事件关闭，禁止客户端宣称 AI 等待就是作答。
- [ ] 扩展 AttemptService 原事务：验证可选 episode 与当前 student/task/questionVersion；处理合法 finalEvent、写 attempt 时间快照并冻结首答。无效或缺失 finalEvent 只产生 timingWarning/partial，合法答案依旧保存；跨学生 episode 作为安全错误拒绝。
- [ ] 测试作答重复请求最终事件不重复计算、原 answer/messageVersion 一致性不变、客户端无 episode=missing、错题/过期租约降级、DB 真错误整体回滚、跨学生 404；运行本文件及 `tests/integration/learning-records.test.ts`。
- [ ] 精确提交：`feat: bind timing leases and snapshots to attempts`。

### Task 5: 浏览器计时与恢复交互

**Files:** Create `apps/web/src/features/tutoring/{api,timing-client,useQuestionTiming}.ts`、`apps/web/src/features/tutoring/TimingStatus.tsx`、`tests/unit/timing-client.test.ts`、`tests/e2e/learning-timing.spec.ts`；Modify `apps/web/src/routes/Study.tsx`、`apps/web/src/components/QuestionCard.tsx`、`apps/web/src/features/tutor/Composer.tsx`、`apps/web/src/features/tutor/useTutorRun.ts`、`apps/web/src/lib/types.ts`。

**Interfaces:** `createTimingClient({api,monotonicNow,onSnapshot})` 提供 `.start(taskId,questionVersionId,requestKey)`、`.checkpoint()`、`.pause(reason)`、`.resume()`、`.prepareSubmission()`、`.dispose()`；`useQuestionTiming` 包装生命周期，不在 render 中开启 episode。注入单调时钟便于单测，只有一个发送队列。

- [ ] 写单测：每 15 秒 checkpoint；可见无输入照常累计；hidden/offline/waiting_ai 暂停；恢复需用户动作；dispose 后无定时器；重挂/SSE 重连不重复 start。
- [ ] 运行 `pnpm test:unit tests/unit/timing-client.test.ts`，预期缺实现失败。
- [ ] 实现当前题的“开始作答/暂停/继续”、计时质量文案；默认无数字倒计时。历史已展示题标 priorExposure，无法可靠判断时保守标记。
- [ ] 接入提交前末次事件和 timingWarning；网络失败保留答案、暂停网络等待；服务恢复快照仅恢复数据，不自动开始。记录上限后提示恢复新段，不让客户端无限缓存。
- [ ] e2e 使用 Playwright clock：后台切换/AI 慢回复不计时、纸笔无输入不暂停、接管冲突、提交回执丢失幂等恢复、开关关闭仍能作答、按钮键盘/读屏标签；运行 `pnpm test:e2e tests/e2e/learning-timing.spec.ts`。
- [ ] 精确提交：`feat: track active question time without input surveillance`。

### Task 6: 过程证据、候选错因与证据失效

**Files:** Create `modules/tutoring/{process-evidence,diagnosis-rules,diagnosis-service}.ts`、`tests/unit/diagnosis-rules.test.ts`、`tests/integration/tutoring-diagnosis.test.ts`；Modify `modules/learning/assessments.ts`、现有证据撤销入口及 `agent/context.ts`。

**Interfaces:** `ProcessEvidenceService.collect(scope,attemptId):Promise<EvidenceRef[]>`；`decideDiagnosis(context:DiagnosisContext,candidates:DiagnosisCandidate[]):Omit<DiagnosisDTO,"id"|"version">`（ID/版本由服务补齐）；`DiagnosisService.analyze(scope,attemptId):Promise<DiagnosisDTO>`、`.invalidate(scope,evidenceVersionId,reason):Promise<void>`。规则只使用可定位步骤/有效 probe/人工确认；时间不会成为确认依据。

- [ ] 写 `same_answer_different_causes_stays_unconfirmed`、`correct_but_slow_not_gap`、`fast_wrong_not_slip`、`unreadable_stem_blocks_attribution`、`conflicting_probe_stays_pending`、`alternative_valid_method_accepted`。
- [ ] 运行 `pnpm test:unit tests/unit/diagnosis-rules.test.ts`，预期失败后实现纯规则。
- [ ] 复用已核验 assessment、消息版本和现有图片读取；独立保存识别后的步骤引用，并冻结使用的知识点标题/总结/更新时间/哈希，不要求学生补过程才能正常提交答案；七类错因/最多 3 候选，未覆盖题型 unsupported。
- [ ] 集成测试模型非法 JSON、虚构证据 ID、缺已发布知识、超时、图片不可读均不确认；模型输出 confirmed 不能绕规则；同 assessment 重试不生成重复诊断版本，新增 probe 才追加版本。
- [ ] 接入已有 evidence_invalidations：修改题干/消息/assessment 时标记相关诊断 invalidated，不改原答案/旧诊断；跨学生证据拒绝。运行上述单测和集成文件。
- [ ] 精确提交：`feat: diagnose learning errors from versioned evidence`。

### Task 7: 锚点、提示状态机与可靠暴露记录

**Files:** Create `modules/tutoring/{anchors,state-rules,service}.ts`、`tests/unit/tutoring-state.test.ts`、`tests/integration/tutoring-actions.test.ts`；Modify `modules/tutoring/routes.ts`、`agent/{tools,prompts,context,tutor}.ts`、`modules/learning/{assessments,state-rules}.ts`、conversation 消息/提示持久化集成点。

**Interfaces:** `decideTeachingTransition(input:TeachingTransitionInput):{next:TeachingState;exposure:Exposure;reason:string}`；`TutoringService.act(scope,episodeId,input:TutoringActionInput):Promise<TutoringActionDTO>`、`.getState(scope,episodeId):Promise<EpisodeDTO>`。工具按 Spec 第 9 节，服务绑定 current run，Agent 无确认/身份写权限。

- [ ] 写状态测试：同层不重复、两次无进展转 probe/讲解、最多 2 个微题、知识缺口可直达讲解、学生主动求助可跳级、重复请求不增加失败次数。
- [ ] 运行 `pnpm test:unit tests/unit/tutoring-state.test.ts`；实现八个版本化锚点与状态纯函数。
- [ ] 实现带 expectedVersion 的动作事务；关联 hints 与 action/messageVersion，发送前保守登记 exposure，显示回执按 actionId 幂等；生成失败可重试同一动作，不重复暴露计数。
- [ ] 修改 prompts：普通练习可交最终值，诊断邀请关键步骤；自由文本也保存 exposure；无可靠分类或发送成功但回执丢失为 unknown。assessment 按 student/task/questionVersion 和提交前动作确定提示依赖，不跨任务取 hints。
- [ ] 测试 `solution_sent_ack_lost_is_not_independent`、`free_text_solution_is_exposed`、`hints_do_not_leak_between_tasks_or_students`；原题订正不等于掌握，慢独立正确仍允许晋级；运行 actions 集成、`tests/unit/state-rules.test.ts` 和 `tests/integration/mistakes.test.ts`。
- [ ] 精确提交：`feat: guide self checks with auditable hint exposure`。

### Task 8: 学生完整旅程与阶段一教学评估

**Files:** Create `features/tutoring/{TutoringActions,DiagnosisSummary}.tsx`、`tests/e2e/self-check-journey.spec.ts`、`tests/fixtures/tutoring/{development,frozen-evaluation}.json`、`tests/fixtures/tutoring/README.md`、`scripts/evaluate-tutoring.ts`、`docs/qa/adaptive-learning-phase-1.md`；Modify Study/TutorPanel/MistakeDetail、package.json。前端路径相对 `apps/web/src`。

**Interfaces:** 前端只展示 DiagnosisDTO 的学生摘要；原始候选不直接返回。`pnpm evaluate:tutoring -- --dataset <path> --output <path>` 生成脱敏 JSON：样本覆盖、confirmed 数、教师认可数、精确率、coverage、阻断项、模型/规则版本，不写“模型自评=教师认可”。

- [ ] 写 e2e：错误过程 → 锚点 → 自行修正/解释 → 独立变式；另一路追问→讲解→新题，确保原题不算独立掌握。使用可控服务与固定时间，不真实等 24 小时。
- [ ] 运行 `pnpm test:e2e tests/e2e/self-check-journey.spec.ts`，确认新流程未实现失败。
- [ ] 实现自查动作 UI、补步骤、例子/讲解、退出与继续；无模型/无过程明确待确认，开关关闭保持旧界面。
- [ ] 建 120 个经教师标注/复核样例，80 开发/40 冻结；相同最终答案不同错因必须至少两对，七类与异常均覆盖。冻结集不用于调提示；缺教师复核时仅建待复核 fixture，验收保持未通过，不编造认可率。
- [ ] 运行 e2e、`pnpm typecheck`，执行评估脚本；记录至少 30 confirmed 人工复核且认可率≥90%、阻断项为 0 的门槛；不足样本补独立集，不提高强判率。
- [ ] 更新阶段一 QA 状态和证据链接，精确提交：`feat: deliver and evaluate the self-check learning journey`。

## 阶段二：动态题库与个人练习

### Task 9: 稳定技能、题库元数据与审核 API

**Files:** Create `packages/db/src/schema/question-bank.ts`、`apps/server/src/modules/question-bank/{skills,service,search,routes}.ts`、`tests/integration/question-bank-access.test.ts`、`tests/unit/skill-prerequisites.test.ts`、增量 `<next>_question_bank.sql`；Modify contracts/question-bank、db index/journal、app.ts、knowledge-base/service.ts。

**Interfaces:** `SkillService.create(actor,input)`、`.linkContent(actor,skillId,knowledgeItemId)`、`.setPrerequisites(actor,skillId,prerequisiteIds)`；`QuestionBankService.createDraft(actor,input)`、`.publish(actor,entryId,expectedVersion)`、`.withdraw(actor,entryId,reason)`；`searchEligibleQuestions(db,scope,{skillId,goal,difficulty,answerType,excludeVersionIds,limit}):Promise<BankCandidate[]>`。`BankCandidate={entryId,questionVersionId,skillId,difficulty,complexityBand,answerType,templateFamily,matchedCauseCount,seenCount}`。

Schema 创建 skills/content links/prerequisites/question links/entries/templates/generation runs。题库 entry 的 questionVersion 唯一；primary skill 部分唯一；技能 code 唯一；visibility=owner_only 必须 owner 非空；publishedAt 与状态一致；题目内容指纹/模板参数按来源与可见性建立唯一约束，不能因去重把私人内容暴露到公共条目。

- [ ] 写失败测试：A→B 后拒绝 B→A；未发布知识点不能关联为有效内容；撤回知识点后关联技能/题目不能继续自动推荐；旧文本标签不自动视为同一 skill。
- [ ] 运行 `pnpm test:unit tests/unit/skill-prerequisites.test.ts` 和 `pnpm test:integration tests/integration/question-bank-access.test.ts`。
- [ ] 实现技能 DAG 检查、管理员审核和题库状态机；采用 SELECT/FOR UPDATE 或事务 advisory lock 防并发边同时形成环。
- [ ] 实现 published+visibility+owner+skill+prerequisites 硬筛；首次共享发布必须管理员操作；私人题共享创建脱敏新版本，保留原 owner，不对原条目改 owner。
- [ ] 覆盖学生写管理接口 403、跨学生 owner_only 404、student_id=null 但未准入不曝光、撤回题无候选、两个并发前置更新不能形成环；重跑测试及 `pnpm typecheck`。
- [ ] 精确提交：`feat: add reviewed skills and permission-aware question bank`。

### Task 10: 受控模板、准入核验与生成队列

**Files:** Create `apps/server/src/modules/question-bank/{templates,verifier,generator}.ts`、`apps/server/src/jobs/question-generation-job.ts`、`tests/unit/question-templates.test.ts`、`tests/integration/question-generation.test.ts`；Modify learning/practice.ts、jobs/runner.ts、app.ts、contracts/question-bank。

**Interfaces:** `instantiateTemplate(templateCode,version,params):{stem:string;answer:string;answerType:"number";fingerprint:string}`；`verifyBankCandidate(input):Promise<{status:"verified"|"rejected"|"pending_review";checks:Record<string,boolean>;reasons:string[]}>`；`QuestionGenerationService.enqueue(scope,{skillId,templateCode,goal,requestKey}):Promise<{runId:string;status:string}>`；job kind=`question_bank.generate`，dedupeKey=`question_bank.generate:<student-or-shared>:<requestKey>`。

- [ ] 写失败模板测试：有理数运算分母不能为 0；`a(x+b)=c` 的 a≠0，答案 `c/a-b` 用已有有理数能力核验；参数边界、负数、约分等价、相同参数指纹一致。
- [ ] 运行 `pnpm test:unit tests/unit/question-templates.test.ts`，确认缺实现失败。
- [ ] 实现两个版本化模板族及确定性求解；不用 eval/执行模型给出的代码。题干、答案、主技能、复杂度和参数一起入库；首批模板经管理员批准后才允许自动发布实例。
- [ ] 实现单重任务生成与已发布知识点引用校验，冻结实际用到的标题/总结/更新时间/哈希；LLM 新题即使模型复核一致也进入 pending_review；模板验证失败 rejected；同请求重试不创建重复题。
- [ ] 集成测试：a=0 拒绝、模型超时不发布、无资料依据 insufficient_evidence、未经批准模板不自动发布、合法批准模板可发布、纯 LLM 一致结果仍待审、相同题不能跨权限去重泄露；运行上述单测/集成及现有 practice 相关测试。
- [ ] 精确提交：`feat: generate validated practice from approved templates`。

### Task 11: 分维度画像、个人效率基线与证据重建

**Files:** Create `packages/db/src/schema/learning-profile.ts`、`apps/server/src/modules/learning-profile/{efficiency,service,invalidation,routes}.ts`、`apps/server/src/jobs/learning-profile-job.ts`、`tests/unit/learning-efficiency.test.ts`、`tests/integration/learning-profile.test.ts`、增量 `<next>_learning_profiles.sql`；Modify contracts/learning-profile、db index/journal、learning/knowledge.ts、app.ts、jobs/runner.ts。

**Interfaces:** `observeEfficiency(current,samples):EfficiencyObservation`，输入为带 student/skill/bucket/firstEncounter/exposure/verification/quality/attemptAt/family 的有效首答快照；`LearningProfileService.rebuild(scope,skillId):Promise<ProfileDTO>`、`.get(scope,skillId):Promise<ProfileDTO>`；`invalidateDerivedEvidence(tx,scope,evidenceVersionId,reason):Promise<void>` 标 stale 并幂等入队 `learning_profile.rebuild`，推荐读取 stale 时回退旧流程，不使用旧结论。

表字段：profile 保存 student/skill/version/trainingBand/bandEnteredAt/consumedPromotionEvidenceIds/stale、知识/提示证据统计；habit 保存 anchorCode/观察/独立检查/成功订正证据；baseline 保存 bucket/windowStart/windowEnd/median/sampleIds/asOf/policyVersion；效率不合并为单个“能力总分”。修正 legacy revision=null 写入需要可空迁移和测试，不强制教材绑定。

- [ ] 写单测：4 样本不足，5 个不同版本但同日/同家族仍不足；5 个样本跨 2 日/2 家族中位数计算正确；0/missing/partial/有提示/重做/未来数据不进入；0.75 与 1.5 边界为 comparable；当前样本不能进入自身基线。
- [ ] 运行 `pnpm test:unit tests/unit/learning-efficiency.test.ts`，确认新增失败。
- [ ] 实现当前作答前 30 天最多 20 样本、冻结基线 ID 与质量原因；仅同 primary skill/difficulty/answerType/complexity 桶比较，样本不足不给方向。
- [ ] 实现当前 skill、进入当前档以后新题首答窗口：5 个均可判定且至少 4 个独立正确才升一档，下一档重新积累 5 个新首答；订正与其他技能不能升档。时间单独不升级，慢独立正确不影响旧错题掌握晋级。
- [ ] 集成测试画像版本幂等、首错后订正不替换窗口、同窗口不能连升、跨技能不借用、证据撤销立即 stale、重建后移除失效样本且保留旧 baseline、无模型仍能确定性重建；运行本任务测试与原 state-rules/learning-records 测试。
- [ ] 精确提交：`feat: build evidence-based skill and efficiency profiles`。

### Task 12: 逐题选择策略、难度配额与决策回放

**Files:** Create `apps/server/src/modules/learning-profile/{selection-policy,selection-service}.ts`、`tests/unit/adaptive-selection.test.ts`、`tests/integration/adaptive-practice.test.ts`；Modify learning-profile/routes.ts、learning/{practice,tasks}.ts、agent/{tools,context,prompts}.ts、app.ts。

**Interfaces:** `choosePractice(context:{profile:ProfileDTO;recentDecisions:PracticeDecisionDTO[];candidates:BankCandidate[];dueReviews:ReviewCandidate[];openDiagnosis:boolean}):SelectionChoice`，其中 `ReviewCandidate={questionVersionId,skillId,dueAt,sourceQuestionId}`、`SelectionChoice={status,goal,difficulty,candidateId,reasonCodes}`；`SelectionService.next(scope,taskId,input:SelectionRequest):Promise<PracticeDecisionDTO>`、`.replay(scope,decisionId):Promise<PracticeDecisionDTO>`。replay 只读冻结决策，不重新查最新画像。

- [ ] 写策略测试：当前诊断/修复优先、再到期复习、再薄弱技能修复/迁移；repair=60/35/5、consolidation=30/50/20、advance=15/50/35。最近 20 个决策含本次目标位，难度按最大缺额选择，同缺额按 easy/medium/challenge 稳定顺序。
- [ ] 运行 `pnpm test:unit tests/unit/adaptive-selection.test.ts`，确认缺实现失败。
- [ ] 实现多样性和桶内排序：错因匹配数降序、未见优先、最近 5 题家族频次升序、ID；无候选按 Spec 第 7.4 节放宽，绝不放宽权限/准入/前置，最终 insufficient_pool。
- [ ] 锁 task/profile 并校验 expectedProfileVersion；实践决策+taskItem 在一个事务提交，同 requestKey 同载荷返回原结果、不同载荷 409。最多 5 个正式题，微题独立记录但每正式题≤2。调用已有变式关联核验，未通过关系不提升原错题状态。
- [ ] 测试慢正确不直接降档、快错误不升档、3 个合格同桶时间观察才影响方法优化/迁移优先级；不得取消到期复习。集成覆盖并发第 5/6 题、跨学生幂等键、私题与撤回题过滤、stale 回退、无候选、关闭开关、未来画像不改变 replay。
- [ ] 运行 `pnpm test:unit tests/unit/adaptive-selection.test.ts`、`pnpm test:integration tests/integration/adaptive-practice.test.ts`；精确提交：`feat: select personalized practice with replayable decisions`。

### Task 13: 题库管理、学生推荐解释与第二阶段验收

**Files:** Create `apps/web/src/routes/admin/{QuestionBank,LearningSkills}.tsx`、`apps/web/src/features/question-bank/api.ts`、`tests/e2e/adaptive-practice.spec.ts`、`tests/e2e/admin-question-bank.spec.ts`、`docs/qa/adaptive-learning-phase-2.md`；Modify App.tsx/AppShell.tsx、Study/QuestionCard、Profile 及现有管理知识点关联入口。

**Interfaces:** 管理员操作对接 `/api/admin/question-bank/**`、`/api/admin/learning-skills/**`；学生 next-practice 显示 goal 和简短 explanation，不泄露答案/隐藏难度内部数值/他人记录。样本不足显示“还在积累可比较的练习”，不显示 0 分或伪造标准时间。

- [ ] 写失败 e2e：管理员创建技能/前置/题目→审核发布→学生获得该题；待审题与私题不出现；撤回立即停止新推荐。
- [ ] 运行 `pnpm test:e2e tests/e2e/admin-question-bank.spec.ts tests/e2e/adaptive-practice.spec.ts`。
- [ ] 实现沿用现有组件的管理表单、发布/撤回、模板批准、来源/核验摘要；学生显示“复习到期知识/练习刚补的步骤”等可理解理由，不展示模型实现术语。
- [ ] 集成个人知识/习惯/效率分维度概览；时间质量不足不渲染趋势，默认无倒计时/排名；新开关关闭不留下失效入口。
- [ ] 影子运行同一批冻结作答，对比原有选择与新策略，管理员核对至少一个诊断、修复、迁移、复习案例；记录候选不足、错误题与权限阻断，未通过不启用 adaptive。运行上述 e2e 及 `pnpm typecheck`。
- [ ] 记录阶段二 QA 与模板审核人/版本（不提交隐私），精确提交：`feat: expose reviewed question bank and adaptive learning progress`。

## 阶段三：教学效果、人工纠错与发布

### Task 14: 人工诊断纠错、追加审计与全链路失效

**Files:** Create `packages/db/src/schema/learning-evaluation.ts`、`apps/server/src/modules/student-insights/diagnosis-reviews.ts`、`tests/integration/diagnosis-review.test.ts`、增量 `<next>_learning_evaluations.sql`；Modify db index/journal、student-insights/routes.ts、learning-profile/invalidation.ts、tutoring/diagnosis-service.ts、管理 students/RecordDetail.tsx。

**Interfaces:** `DiagnosisReviewService.submit(actor,{studentId,diagnosisId,expectedVersion,decision:"accept"|"correct"|"insufficient",correctedCode:DiagnosisCode|null,reason:string,evidence:EvidenceRef[],requestKey:string}):Promise<{reviewId:string;diagnosisVersion:number}>`；reason 必填 1～2,000 字。创建 diagnosis_reviews 与 learning_evaluations（task15 使用），review requestKey 按 actor/student 唯一。

- [ ] 写失败集成：学生不能人审；管理员跨 student 的 diagnosisId 404；相同审核重试仅一条；过期版本 409；correct 必须有 correctedCode 与有效证据。
- [ ] 运行 `pnpm test:integration tests/integration/diagnosis-review.test.ts`，确认缺实现失败。
- [ ] 实现追加审核与新诊断版本、审计操作者/时间/原因；不删除被推翻结论。accept 不自动使未经核验答案变正确，不能给证据不足强行补“已掌握”。
- [ ] 同事务 invalidation 与 profile stale/队列 outbox；保留历史 decision/snapshot，标注其证据失效。重建失败可重试，推荐不使用 stale。
- [ ] 测试“原 confirmed 习惯问题→教师纠正为知识缺口”会更新当前摘要与后续策略，旧报告保持生成时快照并提示失效，任务重复不重复统计；运行本文件和 learning-profile 集成。
- [ ] 实现 RecordDetail 只读证据与审核表单，精确提交：`feat: review diagnoses and invalidate derived learning evidence`。

### Task 15: 学情指标、效率趋势与评估报告

**Files:** Create `apps/server/src/modules/student-insights/{learning-metrics,learning-evaluations}.ts`、`tests/unit/learning-metrics.test.ts`、`tests/integration/learning-evaluation.test.ts`；Modify contracts/learning-evaluation、student-insights/{facts,snapshot,report-generator,routes}.ts、管理 students/{Overview,Analysis,AnalysisDetail}.tsx。

**Interfaces:** `computeLearningMetrics(facts:LearningEvaluationFacts):LearningMetrics`；`LearningEvaluationService.snapshot(actor,studentId,{from,to}):Promise<LearningEvaluationDTO>`。Facts 保存有效首答、assessment、诊断人审、自查轮次、到期/完成复习、timing quality、曝光和策略版本；DTO 保存 coverage、分子分母、样本数、时间窗口、基线证据、versions、生成时水位及 staleEvidenceCount。类型在 contracts 明确定义，不只返回一段模型文本。

- [ ] 写指标固定样例：自查机会 10 次含退出 2 次，成功 4 次为 4/10；到期 10 完成 6 通过 3，分别显示完成率 6/10、通过率 3/6；unknown 不计 independent；重复事件不增加样本。
- [ ] 运行 `pnpm test:unit tests/unit/learning-metrics.test.ts`，确认缺实现失败。
- [ ] 实现 Spec 第 10.1 节指标，零分母返回 null/样本不足；独立新题正确率仅在独立且核验可判定首答中计算，同时报告全部新题中独立作答覆盖率。按题桶/质量显示自身效率，混合难度不能合并为“速度提升”。
- [ ] 集成已有快照/报告证据跳转，报告模型只能解释结构化事实，不能编造提升率或因果；修正证据标过期，不偷偷重算旧报告。群体参考默认关闭；若配置开启，执行 30 学生/100 样本/每人≤5 的匿名门槛。
- [ ] 集成覆盖零样本、全部 partial、跨学生报告 404、未来证据不进入快照、同人 100 次不能绕群体门槛、撤销后新报告与旧快照并存；运行本任务单测/集成及现有 student-insight snapshot/report-output 测试。
- [ ] 更新管理员概览/分析页分层文案，精确提交：`feat: report independent learning and reliable efficiency trends`。

### Task 16: 资源验证、清理、回滚与最终验收

**Files:** Create `scripts/benchmark-adaptive-learning.ts`、`apps/server/src/jobs/timing-cleanup-job.ts`、`tests/integration/timing-cleanup.test.ts`、`tests/e2e/learning-evaluation.spec.ts`、`docs/runbooks/adaptive-learning.md`、`docs/qa/adaptive-learning-phase-3.md`；Modify jobs/runner.ts、package.json、README.md、docs/architecture.md。

**Interfaces:** job=`learning_timing.cleanup`，按 500 条一批删除已封存且已聚合、createdAt 早于 30 天的 timing_events；保留 segments/快照/冻结指标与版本。`pnpm benchmark:adaptive-learning` 仅在 `_test` 库临时 schema 中造数据、测量后清理，沿用现有 benchmark 保护方式。保留策略与学生资料删除路径对齐，不能删聚合仍依赖的未封存事件。

- [ ] 写集成测试：未聚合/未封存/未满 30 天不删；满 30 天事件可删但旧时间快照、诊断与报告不变；学生删除/授权变化遵循现有访问边界。
- [ ] 运行 `pnpm test:integration tests/integration/timing-cleanup.test.ts` 后实现幂等清理，重跑通过。
- [ ] 构造 100 学生/10,000 正式作答/100,000 计时事件/10,000 题库条目，输出候选查询与画像重建的 p50/p95、EXPLAIN、内存峰值；记录真实环境，不把本机结果当 ECS 保证。若一次请求扫描全库或重任务并发超 1，先修正再验收。
- [ ] e2e 覆盖三阶段旅程、教师纠错、计时不足不出趋势、功能开关依次关闭后继续原流程；逐项回归 Reviewer Focus 五类风险。
- [ ] 运行 `pnpm typecheck`、`pnpm lint`、`pnpm build`、`pnpm test`、`pnpm test:e2e`；真实 provider/OCR smoke 仅在已配置环境按现有脚本运行。记录命令、时间、结果和未验证限制，禁止把缺环境写成通过。
- [ ] 编写 runbook：迁移→关开关部署→内容审核→阶段一白名单→第二阶段影子→开启策略→第三阶段评估；演练关闭开关回退，保留证据不回滚删表；明确 adaptive 依赖 self-check，timing 可独立关闭。
- [ ] 将阶段一/二/三 QA、教师确认与实验条件写入验收记录；如要声明因果提升，先确认独立实验方案与样本量，未具备则只描述观察结果。
- [ ] 精确提交：`docs: verify and operate staged adaptive learning rollout`。只有测试与该阶段人工门槛均满足，才将对应阶段标为完成。

## 2. Spec 覆盖与交付检查

| Spec 要求 | 对应任务 |
|---|---|
| 产品原则/三阶段/配置与资源边界 | 1、8、13、16 |
| 候选错因、过程证据、替代正确解法、心理反馈 | 6、7、8 |
| 锚点与有限提示、允许求助、解答暴露 | 7、8 |
| 计时口径、可靠性、抖动、断网、租约、原子提交 | 2、3、4、5 |
| 个人基线、样本不足、首答与可比桶 | 11、15 |
| 技能身份、来源/权限、准入/模板与索引 | 9、10、16 |
| 动态比例、晋级新证据、逐题/微题数量 | 11、12 |
| 幂等推荐、冻结快照、解释与回放 | 12、13 |
| 证据撤销、人审、历史不改写 | 6、11、14、15 |
| 指标分母、延迟复习、覆盖率、无数据与群体门槛 | 8、15 |
| 教师评估、影子运行、资源/清理/回滚 | 8、13、16 |

实施者完成每一任务后检查共享类型与前置接口一致，任何改变教学阈值、时间口径、证据资格或权限边界的决定先同步修改 Spec 与本计划，记录原因。实现细节如组件内部拆分、SQL 查询写法可以自行决定，不能据此扩大产品范围。

当前交付仅为两份待审阅文档；后续实现以任务 0 开始，逐阶段验收，不因文档已写完而勾选任务或宣称功能上线。
