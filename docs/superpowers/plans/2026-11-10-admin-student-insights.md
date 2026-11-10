# 管理员学生学情中心 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 一次交付管理员全体学生只读学情中心及可追溯 AI 分析，覆盖原第一期和第二期。

**Architecture:** 新增管理员专用只读查询模块，保持普通学生授权规则；页面与 AI 共用后端事实口径。有效学习事件和每日访问分开采集，报告冻结结构化快照后通过现有 JobQueue/ModelGateway 执行，引用由服务端校验。

**Tech Stack:** TypeScript、React 19、React Router 7、Fastify 5、PostgreSQL、Drizzle、Zod、Vitest、Playwright；使用现有依赖。

**Spec:** [2026-11-10-admin-student-insights-design.md](../specs/2026-11-10-admin-student-insights-design.md)

## Global Constraints

- 管理员可查看全体学生；只提供查看、附件预览、生成/重试 AI 报告，不代学生修改学习数据。
- 不改变 requireStudentAccess，不新增 student_access 记录，不将管理员伪装成学生或 owner。
- 所有页面日期统一按 Asia/Shanghai 解释，显示该时区；暂不按学生 profile.timezone 混合展示。
- 范围 1–366 天；to 不超过上海今日，from<=to；默认上海今日及之前 29 天。
- 比率传 0–1，分母为零返回 null；metricVersion=student-insights-v1。
- 不新增基础设施与运行依赖；不实现学习时长、正式阅卷、排名、导出或自动干预。
- 当前工作区已有其他未提交工作：不得 reset、覆盖或用 git add . 纳入无关改动。
- 本计划仅记录未来实现步骤；所有复选框初始未勾选，不表示测试已运行。

## Review Focus

- 多账号、一对多关联及无学习学生：不得重复计数或漏掉无数据学生；由任务 3/4 的 fixtures 固定。
- 上海午夜、历史回填与实时写入竞争：归日、coverage、唯一键一致；由任务 1/6/7 验证。
- 管理员无 student_access、资源 UUID 属于其他学生：允许前者只读，拒绝后者；由任务 2/5/8 验证。
- 最后一次租约过期、失去租约的旧 worker、手动重试代际：报告可终结且旧结果不覆盖；由任务 9 验证。
- 报告生成后题目删除/证据失效、资料仅部分识别：可保留快照但不得重新打开无效证据或伪造整卷得分；由任务 5/8/10/12 验证。

---

## 0. 执行前准备与依赖图

- [ ] 读取上述 Spec、根目录 DESIGN.md、现有 auth/learning/materials/uploads/jobs 测试；检查适用 AGENTS.md。
- [ ] 按 using-git-worktrees 技能检查是否需要隔离；优先合适的现有 checkout。当前文件依赖未提交的图片附件功能，若创建 worktree，必须先明确如何携带已授权依赖，不能假定干净 HEAD 等于当前实现。
- [ ] 记录 `git status --short` 基线与当前最大迁移编号；仅修改计划列出的文件及必要集成点。
- [ ] 运行 `pnpm typecheck`、`pnpm test:unit` 记录基线；集成测试只使用 withTestDb 的 `_test` 数据库。基线失败要区分现存问题与新改动。

依赖：1 → 2 → 3 → 4/5；1/2 → 6 → 7；3/4/5/7 → 8 → 9；2/4/5/7 → 10 → 11；8/9/11 → 12 → 13。按顺序执行即可，不要求并行。每个任务完成后只提交该任务具体文件；涉及原有脏文件用交互式分块暂存并检查 diff，不能把其他工作的改动一并提交。

## 共享接口与文件职责

下述名称是实施约定，任务 1 定义并导出类型；后续任务不再自行发明 DTO。

- `packages/contracts/src/student-insights.ts`：过滤、分页、DTO、报告协议及 Zod schemas。
- `packages/db/src/schema/student-insights.ts`：事件、访问、回填、报告及采集切换状态五张表；当前项目 `client.ts` 未聚合 schema，无须为本功能重构数据库 client 或添加无用出口。
- `apps/server/src/modules/student-insights/policy.ts`：管理员范围、资源归属、审计。
- `metrics.ts`：日期边界、比率、连续天数等纯函数。
- `facts.ts`：统一有效事实 SQL；供统计和报告共用。
- `queries.ts`：学生列表、概览、趋势。
- `records.ts`：任务/消息/错题/资料只读详情及关联。
- `files.ts`：管理员学生附件签名。
- `activity.ts`：业务事件写入、访问 UPSERT、活跃查询。
- `snapshot.ts`：快照、证据抽样、规范化 hash。
- `reports.ts`：创建、去重、配额、历史、重试、状态修复和证据定位。
- `report-generator.ts`：提示词、模型调用、输出校验、租约校验后写入。
- `routes.ts`：只读 API/报告 API，服务鉴权后做参数解析。
- `apps/server/src/jobs/student-insight-job.ts`：job payload 校验及 generator 适配。
- `scripts/backfill-student-insights.ts`：幂等分批回填及进度记录。
- `apps/web/src/routes/admin/students/`：列表、布局、六个页签及只读详情。
- `apps/web/src/features/student-insights/`：API hooks、筛选、趋势、状态/证据组件。

共享类型的最小字段约定：

```ts
type InsightFilter = { from: string; to: string; revisionId?: string };
type PageQuery = { limit: number; offset: number };
type AdminInsightScope = { actor: Actor; studentId: string };
type InsightMeta = {
  from: string; to: string; timezone: 'Asia/Shanghai'; dataAsOf: string;
  metricVersion: 'student-insights-v1';
  coverage: { learning: 'partial'|'complete'; historicalInferred: boolean;
    visitsStartedAt: string | null; backfillVersion: string | null };
};
type InsightPage<T> = { items: T[]; total: number; meta: InsightMeta };
type Rate = { numerator: number; denominator: number; value: number | null };
type InsightEvidence = { key: string; kind: 'attempt'|'assessment'|'message_version'|'material'|'mistake_event';
  id: string; versionId?: string; summary: string };
type Finding = { text: string; evidenceKeys: string[] };
type Recommendation = { text: string; basisEvidenceKeys: string[]; priority: 'high'|'medium'|'low' };
type ReportContent = { summary: string; strengths: Finding[]; difficulties: Finding[];
  habits: Finding[]; recommendations: Recommendation[]; limitations: string[] };
type InsightSnapshot = { filter: InsightFilter; meta: InsightMeta;
  overview: StudentOverviewDTO; evidence: InsightEvidence[];
  sample: { actual: number; selected: number; truncated: boolean } };
type ReportDTO = { id: string; studentId: string; status: 'queued'|'running'|'completed'|'failed';
  filter: InsightFilter; dataAsOf: string; generation: number; attempts: number;
  content: ReportContent | null; model: string | null; errorCode: string | null;
  evidence: InsightEvidence[]; createdAt: string; completedAt: string | null };
```

StudentOverviewDTO 至少含 counts（作答次数/题数、新增错题、当前五类错题、任务总数/已完成数）、firstAttemptAccuracy:Rate、taskCompletion:Rate、daily、knowledge；StudentRowDTO 包含 studentId/displayName/studentLogins/lastLearningAt/activeDays/上述核心指标/attentionReasons。详情 DTO 保留原记录 ID、版本 ID、归属和时间，不返回 object_key。报告正文数组最多各 10 条，text 最多 1500 字符，limitations 最多 10 条；正文总长最多 15,000 字符，未知字段拒绝。

### Task 1: 共享契约、日期算法与数据库约束

**Files:** Create `packages/contracts/src/student-insights.ts`、`packages/db/src/schema/student-insights.ts`、`apps/server/src/modules/student-insights/metrics.ts`、`tests/unit/student-insight-metrics.test.ts`、`tests/integration/student-insight-schema.test.ts`；Create migration `packages/db/migrations/<next>_student_insights.sql`；Modify migration journal（沿用现有项目迁移格式）。

**Interfaces:** Produces 共享类型与 schemas；`resolveInsightRange(filter:InsightFilter, now:Date):{start:Date;endExclusive:Date}`、`rate(n:number,d:number):Rate`、`streaks(dates:string[],today:string):{current:number;longest:number}`。数据库表精确遵循 Spec §6/§9。

- [ ] 写失败单测 `uses_shanghai_midnight`：2026-11-10 单日边界为 2026-11-09T16:00Z 至 2026-11-10T16:00Z；`rejects_invalid_ranges` 包含 367 天/未来/2026-02-30；`zero_denominator_is_null`；`streak_can_anchor_yesterday`；闰日/跨年连续正确。
- [ ] 运行 `pnpm test:unit tests/unit/student-insight-metrics.test.ts`，确认因缺实现失败。
- [ ] 定义共享 schema 与 DTO；实现 metrics，默认日期由上海时钟推导，不用宿主本地 Date 日期隐式转换。
- [ ] 写 schema 集成用例：重复事件只一行；null revisionId 同 scope/hash 不能建两份报告；非法状态和学生 FK 被拒绝；同日 visit 多次 UPSERT 一行；单例 collection_state 初始化幂等，服务重启不重置 learning_started_at/visits_started_at。
- [ ] 编写增量迁移/Drizzle schema，确认 next 编号不冲突，并运行 `pnpm test:integration tests/integration/student-insight-schema.test.ts` 和上述单测，预期全通过；不执行生产迁移。
- [ ] 精确暂存本任务文件并提交 `feat: define student insight contracts and storage`。

### Task 2: 管理员只读范围与路由边界

**Files:** Create `policy.ts`、`routes.ts`（均位于上述模块）、`tests/integration/admin-student-insight-auth.test.ts`、`tests/helpers/student-insights.ts`；Modify `apps/server/src/app.ts`。

**Interfaces:** Produces `requireAdminInsightScope(db:Database,actor:Actor,studentId:string):Promise<AdminInsightScope>`、`auditInsight(tx:PoolClient,scope:AdminInsightScope,action:string,details:Record<string,unknown>):Promise<void>`；`registerStudentInsights(app:FastifyInstance,deps:StudentInsightDependencies):void`。StudentInsightDependencies 仅包含本模块服务，不接受任意学生 service scope 注入。

- [ ] 写 fixtures 创建无 access 的管理员、两个学生、多账号学生和空档案；测试所有已注册端点无会话 401、学生 403（包括无效参数时先鉴权）、管理员可读、不存在学生 404。
- [ ] 运行 `pnpm test:integration tests/integration/admin-student-insight-auth.test.ts`，确认新增权限断言失败。
- [ ] 实现统一管理员入口与服务双重鉴权、白名单参数和审计；接入 buildApp。尚未实现的资源端点随所属任务加入同一权限参数化测试，不发布假成功接口。
- [ ] 断言普通 `/api/tasks?studentId=另一学生` 仍被拒绝；管理员无 access 不能调用普通修改入口；数据库未新增 student_access。
- [ ] 重跑该测试及 `tests/integration/auth.test.ts`，预期全通过。
- [ ] 精确提交 `feat: isolate admin student insight access`。

### Task 3: 可复用的有效事实查询

**Files:** Create `facts.ts`、`tests/integration/student-insight-facts.test.ts`；Modify `tests/helpers/student-insights.ts`；必要时追加迁移索引。

**Interfaces:** Produces `readInsightFacts(tx:PoolClient,studentId:string,filter:InsightFilter):Promise<InsightFacts>`。InsightFacts 在 facts.ts 导出，包含有效作答及最新核验、任务、当前错题、知识点观测、资料及来源，不含聚合后的 JOIN 乘积。由调用者打开 REPEATABLE READ 事务。

- [ ] 写 `first_attempt_is_lifetime_first`（区间外首次不被区间内重做替代）、`latest_assessment_only`、`excludes_deleted_and_invalidated`、`does_not_multiply_sources`、`separates_revision`、`pending_not_in_denominator`。
- [ ] 运行 `pnpm test:integration tests/integration/student-insight-facts.test.ts`，确认失败。
- [ ] 实现按 student_id 锚定的参数化 SQL、稳定排序、首次有效作答/最新有效核验；读取 knowledge observations 时同样排除对应失效证据，不把当前 states 写成历史事实。
- [ ] 加入尝试被原始题版本/消息版本失效、assessment 被失效、任务软删除但其他有效任务仍存在、同题多版本的 fixture；断言分子/分母/数量准确。
- [ ] 重跑 facts 测试与既有 learning-memory/learning-records 测试，预期全通过。
- [ ] 精确提交 `feat: centralize valid student insight facts`。

### Task 4: 学生列表、概览和趋势

**Files:** Create `queries.ts`、`tests/integration/admin-student-insight-queries.test.ts`；Modify `routes.ts`、`app.ts`。

**Interfaces:** Produces `InsightQueryService.list(actor:Actor,input:InsightListQuery):Promise<InsightListDTO>`、`.overview(scope:AdminInsightScope,filter:InsightFilter):Promise<StudentOverviewResponse>`；InsightListDTO={items:StudentRowDTO[],total,summary,meta}；StudentOverviewResponse={overview:StudentOverviewDTO,meta}。

- [ ] 写列表包含空学生、多个学生账号只一行、教材过滤仍保留无数据学生、null 正确率、关注阈值恰好 7 天/10 题、分页稳定/total 同过滤、SQL 注入式 q 当普通文本处理的断言。
- [ ] 运行 `pnpm test:integration tests/integration/admin-student-insight-queries.test.ts`，确认失败。
- [ ] 用 Task 3 口径实现独立聚合再 JOIN；列表严禁逐学生调用 readInsightFacts 导致 N+1；同一事务内读 summary/items/total；所有日期点补齐。
- [ ] 注册 students/overview API；DTO 标出当前存量与区间发生量，真实状态使用 pending_correction/correcting/corrected_pending_practice/consolidated_pending_review/mastered。
- [ ] 重跑该测试和 Task 2 权限测试；检查每个查询均参数化，预期全通过。
- [ ] 精确提交 `feat: add admin student overview queries`。

### Task 5: 只读记录、错题、作业试卷与附件

**Files:** Create `records.ts`、`files.ts`、`tests/integration/admin-student-insight-records.test.ts`；Modify `routes.ts`、`app.ts`；必要时从 uploads/service.ts 提取纯签名帮助方法，但不改 authorize 规则。

**Interfaces:** Produces `InsightRecordService` 的 `listTasks/getTask/listAttempts/listMessages/listMistakes/getMistake/listMistakeEvents/listMaterials/getMaterial/listMaterialQuestions`，参数统一 `(scope,filter或资源id,page?)`，返回共享 DTO；`InsightFileService.download(scope:AdminInsightScope,fileId:string):Promise<{url:string;contentType:string;expiresAt:string}>`。

- [ ] 写跨学生 task/mistake/material/conversation/file 全部 404；无 access 管理员可读原件；孤立文件/非 ready/已隐藏引用拒绝；签名 TTL=300；响应没有 object_key。
- [ ] 运行 `pnpm test:integration tests/integration/admin-student-insight-records.test.ts`，确认失败。
- [ ] 实现 Spec §7 明细与分页子路由；资料用 question_sources 关联题目和学习记录，题目/任务去重，覆盖率显示已识别/有作答/有核验数，绝不返回虚构整卷分数。
- [ ] 审计记录文件签名和真实详情打开，轮询与子分页无重复详情审计；测试只读查询前后 tasks/attempts/messages/mistake 状态不变。
- [ ] 重跑记录/权限测试及既有 uploads/materials/conversation-images 测试，预期全通过。
- [ ] 精确提交 `feat: expose read-only student learning evidence`。

### Task 6: 事务性学习事件及访问采集

**Files:** Create `activity.ts`、`tests/integration/student-insight-activity.test.ts`；Modify learning/attempts.ts、conversations/messages.ts、materials/service.ts、模块 routes.ts、app.ts、web/lib/auth.tsx（若实际文件名不同以现有 auth 模块为准）、Create `apps/web/src/features/student-insights/useStudentVisit.ts`。

**Interfaces:** Produces `recordLearningEvent(tx:PoolClient,input:LearningEventInput):Promise<void>`、`recordStudentVisit(db:Database,actor:Actor,now:Date):Promise<void>`、`InsightActivityService.get(scope,filter):Promise<ActivityDTO>`。LearningEventInput={studentId,actorId,eventType,sourceType,sourceId,taskId?,revisionId?,occurredAt,sourceOrigin}。

- [ ] 写同事务回滚无事件、请求幂等一次事件、owner 学生提交有事件、管理员提交无事件、assistant/system/编辑无新增事件、资料创建成功才有事件；访问同日多页只一行、上海午夜分两日、body 伪造学生/时间被拒绝。
- [ ] 运行 `pnpm test:integration tests/integration/student-insight-activity.test.ts`，确认失败。
- [ ] 在真正业务 INSERT 成功的事务中记录事件，不在 API 外层事后补写；覆盖实际所有写入入口（包括 RunService 中可能绕过 MessageService 的用户消息创建路径，执行时用 rg 盘点并将改动列入本任务）。事件 owner 校验使用现有授权关系，但不把角色 viewer 当本人。
- [ ] 注册 visit 和 activity；服务注册前幂等初始化持久化 collection_state，全实例使用同一采集切换点；前台可见时采访问、5分钟节流，后台不采；生成覆盖说明、每日活跃及连续日统计。
- [ ] 断言活跃按学生/日期去重，消息+作答不重复增加活跃天数；重跑 activity 及 attempts/messages/materials 对应既有测试。
- [ ] 精确提交 `feat: collect student learning activity transactionally`。

### Task 7: 历史回填与覆盖率

**Files:** Create `scripts/backfill-student-insights.ts`、`tests/integration/student-insight-backfill.test.ts`；Modify `activity.ts`、`package.json`。

**Interfaces:** Produces `backfillStudentInsights(db:Database,options:BackfillOptions):Promise<BackfillResult>`，从模块独立导出可测试的 backfill.ts 实现（Create）；脚本只解析参数和调用。BackfillOptions={from,to,batchSize,dryRun,resume:boolean}；Result={scanned,inserted,coverageStatus}；新增脚本 `backfill:student-insights`。

- [ ] 写 dry-run 不改表、重复运行事件数不变、实时事件与历史事件唯一键相同、批次失败保持 partial 且断点恢复、没有历史访问记录、两个进程只有一个执行、切换前管理员旧代操作标 historical_inferred、切换后管理员代操作绝不回填的测试。
- [ ] 运行 `pnpm test:integration tests/integration/student-insight-backfill.test.ts`，确认失败。
- [ ] 用 collection_state.learning_started_at 硬截断回填范围，用户 --to 不能绕过；按 source 类型分别维护 `(created_at,id)` keyset cursor，每批 500（最大5000），批次事务同时写进度；完成三类来源才 complete；只有 live 冲突不降级为 historical，历史来源更新不覆盖 live。
- [ ] 聚合 coverage 按请求区间与已完成回填覆盖范围求交并结合采集上线时间，禁止一个历史批次完成就声明所有日期完整；只对覆盖成功的范围标 complete。
- [ ] 重跑回填和 activity 测试；使用测试库运行 `pnpm backfill:student-insights -- --dry-run --from 2026-11-01 --to 2026-11-10`（执行前确认脚本参数分隔规则），预期只打印计数/覆盖，无正文与凭据。
- [ ] 精确提交 `feat: backfill learning activity with explicit coverage`。

### Task 8: 报告快照、去重、额度、历史和引用定位

**Files:** Create `snapshot.ts`、`reports.ts`、`tests/unit/student-insight-snapshot.test.ts`、`tests/integration/student-insight-reports.test.ts`；Modify routes.ts、app.ts、共享 contracts。

**Interfaces:** Produces `buildInsightSnapshot(tx:PoolClient,scope,filter):Promise<InsightSnapshot>`、`hashInsightSnapshot(snapshot):string`、`InsightReportService.create(scope,filter):Promise<{reportId:string;status:ReportDTO['status'];reused:boolean}>`、`.list/.get/.retry/.resolveEvidence`；retry 返回同报告 ID 与新 generation；resolveEvidence 返回 `{href,detail}`。

- [ ] 单测 hash 忽略 dataAsOf 时钟但事实变化改变 hash；抽样最多100条/每条500字/总30000字符且稳定；limits 和 actual/selected 正确；运行单测确认失败，再实现纯抽样/hash。
- [ ] 集成测试同时10次相同请求只一份 report/job；空 revisionId 同样唯一；create 命中failed返回旧report且不启动新job、不计配额；每60秒第四次新生成429、复用不占额度；无事实422/无gateway503；单学生不同范围同时生成409。
- [ ] 运行 `pnpm test:integration tests/integration/student-insight-reports.test.ts`，确认失败。
- [ ] 实现创建快照/report/job 同事务；锁顺序统一 actor 配额锁→student 锁→report/job 行锁，避免反向死锁；jobs dedupeKey=`student.insight:<reportId>:<generation>`。
- [ ] 实现历史分页、失败重试、跨学生报告404、目录证据定位及打开时再校验删除/失效；签名 URL 不进入快照。测试修改核验/软删后新 hash、新 report，旧报告失效引用404。
- [ ] 重跑本任务两类测试、facts 和权限测试，预期全通过。
- [ ] 精确提交 `feat: persist reproducible student insight reports`。

### Task 9: AI 生成与队列恢复

**Files:** Create `report-generator.ts`、`apps/server/src/jobs/student-insight-job.ts`、`tests/unit/student-insight-report-output.test.ts`、`tests/integration/student-insight-report-jobs.test.ts`；Modify jobs/queue.ts、jobs/runner.ts、app.ts（仅必要集成）、reports.ts。

**Interfaces:** Produces `studentInsightHandler(generator:InsightReportGenerator):JobHandler`、`InsightReportGenerator.generate(job:Job,signal:AbortSignal):Promise<void>`、`validateReportContent(input:unknown,evidence:InsightEvidence[]):ReportContent`。使用 gateway.complete({priority:'background',context:{systemPrompt,messages}},signal)，model 标识取 gateway.runtime.model.id，不能假定 ModelResult 自带 model。

- [ ] 单测合法引用通过、伪造/跨学生引用和无引用观察失败、未知字段/超长输出失败、提示注入文本仅作为资料；先运行确认失败，再实现协议验证与提示模板。
- [ ] 集成测试模拟合法响应、非法JSON、超时、3次自动重试后failed、手动重试generation递增、旧worker租约失效后写入被拒、第三次lease过期自动修复、重启后继续执行。
- [ ] 运行 `pnpm test:integration tests/integration/student-insight-report-jobs.test.ts`，确认失败。
- [ ] 实现120秒 AbortSignal 合并、模型仅冻结快照、结果严格验证；最终保存事务锁 jobs 行并核验token/到期/generation。成功正文/status与jobs completed在同一租约校验事务提交，runner后续finish可no-op；失败重排/最终失败与对应generation报告投影同事务更新，不能只在handler catch设置failed。增加成功提交后runner finish之前宕机测试，断言重启不重复调用模型且completed不降级。
- [ ] 扩展 queue 对 student.insight 最终耗尽修复；检查人工 retry 后旧 generation 的终态处理不会改新 generation。保留现有 textbook/material/summary 行为。
- [ ] 运行上述测试、输出单测及 `pnpm test:integration tests/integration/jobs.test.ts`；预期全通过，无真实 LLM 调用。
- [ ] 精确提交 `feat: generate evidence-backed student reports safely`。

### Task 10: 管理员导航、学生总览与档案外壳

**Files:** Create `apps/web/src/components/RequireAdmin.tsx`、`routes/admin/students/{Students,StudentLayout,Overview}.tsx`、`features/student-insights/{api,filters}.ts`、`features/student-insights/{InsightFilters,InsightTrend,InsightStatus}.tsx`、`tests/e2e/admin-student-insights.spec.ts`；Modify App.tsx、AppShell.tsx、styles/global.css、e2e/fixtures/ui-api.ts（如该测试使用 mock）。

**Interfaces:** Produces `RequireAdmin` Outlet 守卫、`useInsightFilter():{filter,setFilter}`、`useStudentOverview(studentId,filter)`、`useStudents(query)`；hooks 使用现有 api/useRemote 模式并在 key 变动时清空旧值/取消过期请求。

- [ ] 写 E2E：学生无菜单且手动URL无权限、不发送管理员API；管理员列表含空学生、筛选写URL、返回列表保留条件；null比率显示暂无样本；加载/失败重试/404。
- [ ] 运行 `pnpm test:e2e tests/e2e/admin-student-insights.spec.ts`，确认新场景失败。
- [ ] 实现导航和统一 `/admin/*` 守卫，不改变教材/账号实际地址；档案六页签和共享筛选、列表/概览/趋势；管理员详情不依赖当前 auth.studentId 或 RequireTextbook。
- [ ] 对查询清理/竞态增加切换A学生到B后迟到A响应不覆盖B断言；SVG趋势有文本数值，卡片标出统计口径与样本量。
- [ ] 重跑新增E2E和现有 responsive/design-system 中受影响场景；360/768/1280宽度无横向页面溢出。
- [ ] 精确提交 `feat: add admin student insight navigation and overview`。

### Task 11: 学习记录、错题、资料和活跃页签

**Files:** Create `routes/admin/students/{Records,RecordDetail,Mistakes,MistakeDetail,Materials,MaterialDetail,Activity}.tsx`、`features/student-insights/{EvidenceLink,ActivityCalendar,ReadOnlyConversation}.tsx`、`tests/e2e/admin-student-records.spec.ts`；Modify App.tsx、api.ts、必要样式。

**Interfaces:** Consumes Task 5/6 API；Produces `EvidenceLink({studentId,evidenceKey,reportId})`（报告证据经resolve API后导航）、独立只读详情及分页。ReadOnlyConversation 无发送/编辑/重新生成按钮。

- [ ] 写 E2E：查看任务回答/提示/核验、错题事件分页、作业试卷原件和关联题去重、无分值无总分、访问与学习分开展示、历史推算/partial说明可见。
- [ ] 运行 `pnpm test:e2e tests/e2e/admin-student-records.spec.ts`，确认失败。
- [ ] 实现六个记录/资料详情路由、按需附件签名和过期重取、只读对话复用安全的Markdown/图片组件，不挂载TutorPanel以免触发写请求。
- [ ] 添加附件404/签名失败局部重试、切换学生不残留旧图片/记录、键盘日历文本替代和移动端筛选可用断言。
- [ ] 重跑该E2E；网络断言管理员操作未调用POST attempts/bootstrap/material confirm 等学生写接口。
- [ ] 精确提交 `feat: show read-only student records and activity`。

### Task 12: AI 报告交互与全链路证据

**Files:** Create `routes/admin/students/{Analysis,AnalysisDetail}.tsx`、`features/student-insights/{useInsightReport,ReportContent}.tsx`、`tests/e2e/admin-student-analysis.spec.ts`；Modify api.ts、App.tsx、tests/e2e/real-server.ts（增加学情模拟模型响应与两学生fixture）。

**Interfaces:** Produces `useInsightReport(studentId,reportId)`，返回 report/loading/error/refetch；create/retry 后导航同一学生 analysis/:reportId。轮询3秒，2分钟后15秒，离页清理。

- [ ] 写 E2E：生成→queued/running→completed→证据→只读记录；重复点击返回同一report；刷新继续；报告历史切换；模型缺失/无数据/失败重试；切换学生停止旧poll。
- [ ] 运行 `pnpm test:e2e tests/e2e/admin-student-analysis.spec.ts`，确认失败。
- [ ] 实现按钮状态、数据范围/截止时间/模型/覆盖说明/AI辅助文案、快照数字和结构化观察建议；证据打开先resolve，不直接信任模型地址。
- [ ] 增加报告生成后证据失效/原任务删除的场景，历史正文仍展示生成时间快照，证据链接显示已不可用；抽样标签与null统计不误导。
- [ ] 用真实测试服务器faux gateway跑新增E2E与权限测试，不能只mock轮询成功而遗漏队列流程。
- [ ] 精确提交 `feat: add student AI analysis and evidence navigation`。

### Task 13: 发布演练、性能和验收交接

**Files:** Create `scripts/benchmark-student-insights.ts`、`docs/qa/admin-student-insights-acceptance.md`；按实测必要修改 queries/facts/index migration；Modify README.md（菜单和回填使用说明）。

**Interfaces:** 性能脚本只允许 `_test` 数据库，构造1000学生/100000作答，可重跑/清理，仅输出计数、耗时和查询计划；不操作生产学生数据。

- [ ] 为性能脚本写输入拒绝测试（生产库/非_test URL拒绝），然后实现测试库造数和20次预热/100次测量；保存机器/版本/EXPLAIN ANALYZE与p95结果。
- [ ] 执行完整 `pnpm typecheck`、`pnpm lint`、`pnpm test:unit`、`pnpm test:integration`、`pnpm build`；期望exit 0。若有基线失败逐项记录，不以“与本功能无关”代替证据。
- [ ] 执行 `pnpm test:e2e`；按Spec A1–A10逐项在验收文档链接测试名称和360/768/1280截图。
- [ ] 在隔离测试库从空库迁移并从含已有数据的迁移基线升级，执行回填dry-run/正式/重复/中断恢复；确认coverage最终正确，回退旧应用不依赖新表且原学习流程可用。
- [ ] 运行性能脚本；列表/概览p95<1秒为目标。若未达到，附具体瓶颈并先优化SQL/索引、重跑受影响测试，不发布虚假达标结果。
- [ ] 按 requesting-code-review 做整体评审，重点看权限、事件事务、N+1、lease fencing和引用校验；修复后执行针对性回归。
- [ ] 按 verification-before-completion 核对本次变更和测试证据；精确提交验收文档与相关优化 `docs: verify admin student insight release`。部署不在本计划授权内，交付可评审代码及发布步骤。

## 需求覆盖与自查

| Spec | 实施任务 |
|---|---|
| 权限、审计、文件只读 | 2、5、10 |
| 页面结构、空态、响应式 | 10、11、12 |
| 统一指标、时间、一致性 | 1、3、4、6 |
| 事件、访问、历史覆盖 | 6、7 |
| 存储、索引、迁移 | 1、3、13 |
| API/分页/筛选 | 2、4、5、6、8 |
| 快照、AI协议、证据 | 8、9、12 |
| 去重/配额/崩溃恢复 | 8、9 |
| 性能、发布、回退 | 7、13 |

计划自查要求：类型与属性在任务1锁定，后续变更先改共享契约再改消费者；每条 Review Focus 均有任务中的具体测试；每个任务须经历失败测试→实现→通过测试，不用只验证成功路径替代失败/越权/竞争测试。此文档是实施指导，不预填执行结果。已根据独立设计审阅同步补充：回填切换点、report/job原子完成、failed快照显式重试；计划已进行需求覆盖与接口一致性自查。

## 执行方式

建议当前会话内按序实施（superpowers:executing-plans），理由是事件写入与现有脏工作区共享多个核心文件，报告与队列接口依赖紧密；每任务局部验证，完成后整体独立审查。若用户选择子代理方式，再按 subagent-driven-development 执行，不并行修改共享集成文件。

当前交付仅为设计与计划；后续收到实施指令后再写产品代码。
