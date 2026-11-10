# 管理端学情洞察验收记录

日期：2026-11-10
设计：`docs/superpowers/specs/2026-11-10-admin-student-insights-design.md`
计划：`docs/superpowers/plans/2026-11-10-admin-student-insights.md`

本记录按 Spec 第 10 节 A1–A10 给出证据入口。静态检查、单元测试与构建已在开发沙箱内执行；集成测试、E2E、截图、迁移/回填演练与性能基准需要真实 PostgreSQL 与浏览器端口，统一留待 YG 在沙箱外执行。未执行的项不标记为达标。

## 一、已在沙箱内执行

| 命令 | 结果 | 说明 |
|---|---|---|
| `pnpm exec tsc --noEmit` | exit 0 | 全仓类型检查通过 |
| `pnpm run lint` | exit 0 | ESLint 无告警 |
| `pnpm run test:unit` | 13 个文件 / 54 个测试通过 | 覆盖契约、指标、时区、报告输出校验、基准脚本拒绝路径 |
| `pnpm run build` | 成功 | 仅有 Vite chunk 体积提示，无类型错误 |

沙箱内未执行：`pnpm test:integration`、`pnpm test:e2e`、截图生成、空库迁移与升级演练、回填演练、`pnpm benchmark:student-insights`。Bash 沙箱禁止本地端口绑定（`127.0.0.1:55432` 报 EPERM），因此以上命令需在沙箱外运行。

## 二、待 YG 执行的验收命令

```sh
pnpm test:integration
```

```sh
pnpm test:e2e
```

```sh
pnpm benchmark:student-insights --out=docs/qa/admin-student-insights-benchmark.json
```

迁移与回填演练（使用独立 `_test` 库，禁止指向生产）：

1. 在空库执行 `pnpm db:migrate`，确认 `0018_student_insights.sql` 可完整应用。
2. 在含既有学习数据的迁移基线执行 `pnpm db:migrate`，确认升级不报错、原表数据不变。
3. `pnpm backfill:student-insights --from 2026-01-01 --to 2026-11-10 --dry-run`，确认只读。
4. 正式执行、重复执行、中途中断后重跑，确认 coverage 最终正确且无重复事件。
5. 回退到不使用新表的旧应用，确认原有学习流程仍可用且新增表数据保留。

## 三、A1–A10 证据对照

### A1 权限：未登录 401，学生 403，直接 URL 无权限，学生不发管理员请求

- `tests/integration/admin-student-insight-auth.test.ts`
  - “keeps every admin insight endpoint behind session and admin checks”
  - “rejects student actors, malformed ids and unknown students”
- `tests/e2e/admin-student-insights.spec.ts`
  - “学生角色没有学生学情入口，直接访问也不请求管理员接口”
- `tests/e2e/admin-student-analysis.spec.ts`
  - “学生角色看不到 AI 分析，也不请求管理端接口”

### A2 范围：管理员无需 student_access；普通接口授权不变；跨学生 404

- `tests/integration/admin-student-insight-auth.test.ts`
  - “grants admins read scope without student access rows”
  - “rejects admins and students from ordinary student endpoints”
- `tests/integration/admin-student-insight-records.test.ts`
  - “任务列表与详情只暴露本学生有效数据，只在打开详情时审计”（跨学生 404）
  - “消息只返回当前未失效版本与 ready 附件”
  - “错题列表支持过滤，事件分页且只在详情审计”
- `tests/integration/student-insight-reports.test.ts`
  - “serves history, report detail and evidence links over the admin API”（跨学生报错）
- `tests/integration/admin-student-insight-queries.test.ts`
  - “reads an empty student profile through the admin scope”（空学生可见）

### A3 只读：无写操作，读取与 AI 不产生学习事件

- `tests/integration/admin-student-insight-records.test.ts`
  - “所有只读查询前后学习数据保持不变”
- `tests/e2e/admin-student-records.spec.ts`
  - “浏览记录、错题、资料和活跃页面时不发送任何学生写请求”

### A4 统计口径：软删除、失效、待核验、重复、多账号不膨胀；null 不画 0%

- `tests/integration/student-insight-facts.test.ts`
  - “keeps the lifetime first attempt instead of an in-range redo”
  - “reads only the latest assessment for each attempt”
  - “excludes soft-deleted tasks and invalidated evidence”
  - “does not multiply facts by question sources”
  - “separates revisions in every fact collection”
  - “surfaces pending verifications without folding them into facts”
- `tests/integration/admin-student-insight-queries.test.ts`
  - “lists every student with zero-safe rates and filled summary”
  - “merges multiple accounts of the same student into one row”
- `tests/unit/student-insight-metrics.test.ts`
  - “zero_denominator_is_null”

### A5 时间口径：上海午夜、闰日、跨年、空区间、连续天数、覆盖标识

- `tests/unit/student-insight-metrics.test.ts`
  - “uses_shanghai_midnight”
  - “defaults_to_the_last_thirty_shanghai_days”
  - “leap_day_and_cross_year_ranges_are_calendar_exact”
  - “streak_can_anchor_yesterday”
  - “streaks_span_leap_day_and_year_boundary”
  - “rejects_invalid_ranges”
- `tests/integration/student-insight-backfill.test.ts`
  - “backfills historical activity with an honest coverage range”
- `tests/integration/student-insight-activity.test.ts`
  - “aggregates daily activity with visits coverage and streaks”
  - “counts a chat message plus an answer on one day as a single active day”

### A6 材料：原件可预览，跨学生/孤立附件拒绝，无分值不展示总分，题目不重复

- `tests/integration/admin-student-insight-records.test.ts`
  - “资料题目去重计数，文件签名 300 秒且不含 object_key”
- `tests/e2e/admin-student-records.spec.ts`
  - “作业试卷可按类型筛选，关联题按题目去重并获取原件链接”
  - “任务详情展示作答、提示与核验，且不出现分值或总分”
  - “附件失败在局部重试，不阻塞其余对话内容”

### A7 事件：随事务提交、回滚无事件、幂等、管理员排除、访问记录

- `tests/integration/student-insight-activity.test.ts`
  - “rolls learning events back with the business transaction”
  - “records one event per idempotent message and answer request”
  - “skips events from admins and viewers instead of treating them as the student”
  - “does not create events for assistant, system, edits or regenerations”
  - “records a material event only when the material is created”
  - “records one visit per student and Shanghai calendar day”
  - “refuses visit payloads that forge the student or the time”
- `tests/integration/student-insight-schema.test.ts`
  - “deduplicates learning events by source key”
  - “rejects invalid event status and missing student”
  - “upserts one visit row per student/day/timezone”
  - “keeps the collection split point stable across restarts”
  - “keeps null revision reports unique per snapshot”
- `tests/integration/student-insight-backfill.test.ts`
  - “never downgrades live events and stays idempotent on re-runs”
  - “keeps a failed batch partial and resumes from the last commit”
  - “lets only one process hold the backfill lock”
  - “keeps dry runs read-only”

### A8 报告：复用、并发唯一、刷新恢复、重试、租约耗尽、取消与 fencing

- `tests/integration/student-insight-reports.test.ts`
  - “creates one report and one job for concurrent identical requests”
  - “treats an empty revision filter as the same snapshot key”
  - “reuses a failed snapshot without enqueueing or spending quota”
  - “allows three generations per minute and rejects the fourth”
  - “rejects reports for students without learning evidence”
  - “refuses to start reports without a configured model”
  - “returns 409 with the active report for a concurrent different range”
- `tests/integration/student-insight-report-jobs.test.ts`
  - “保存合法响应并把报告与任务一起标记完成”
  - “非法 JSON 记为 INVALID_OUTPUT 并保留可重试状态”
  - “超时中止模型调用并记为 TIMEOUT”
  - “三次自动重试后报告与任务标记失败”
  - “人工重试提升 generation 且旧 generation 不改写新报告”
  - “租约被抢占后旧 worker 不会调用模型或写入结果”
  - “最终租约过期由队列原子修复报告为失败”
  - “提交完成后重启不会重复调用模型也不降级完成状态”
- `tests/e2e/admin-student-analysis.spec.ts`
  - “重复点击生成复用同一份进行中的报告”
  - “直接打开报告页时继续轮询直到完成”
  - “失败报告可重试并继续轮询到完成”
  - “切换到其他学生后停止轮询旧报告”

### A9 报告契约：同口径、后端数字、引用校验、抽样标注、明确空态

- `tests/unit/student-insight-report-output.test.ts`
  - “接受引用现有证据的合法报告”
  - “拒绝引用未知或跨学生的证据 key”
  - “拒绝没有任何证据引用的观察和建议”
  - “拒绝未知字段和超长输出”
  - “把学生文本当作证据而非指令，且不把不可信内容写入 systemPrompt”
- `tests/integration/student-insight-reports.test.ts`
  - “drops invalidated evidence and yields a new snapshot”
  - “drops soft-deleted task evidence and yields a new snapshot”
  - “keeps taskless attempts and chats out of the navigable evidence catalog”
- `tests/e2e/admin-student-analysis.spec.ts`
  - “生成报告后轮询到完成，并可打开证据查看只读记录”
  - “报告历史可切换到另一份报告”
  - “未配置模型时禁用生成并说明原因”
  - “无数据、范围冲突与过于频繁时显示服务端原因”
  - “内容引用已失效的证据时标记不可用且不提供跳转”
- `tests/e2e/admin-student-analysis-real.spec.ts`
  - “real API: 生成报告、轮询完成并打开证据，跨学生不可读取”

### A10 响应式与性能：360/768/1280、键盘、加载/空白/失败/404、p95 与查询计划

- `tests/e2e/admin-student-insights.spec.ts`
  - “管理员列表包含空学生，筛选写入 URL，返回时保留条件”
  - “概览显示趋势数值和图表文本替代”
  - “空学生详情显示暂无记录与无可核验样本”
  - “列表加载、失败原位置重试和详情 404”
  - “从 A 快速切换到 B 时迟到的 A 响应不会覆盖 B”
  - “学情列表和概览在 360px 无横向溢出”
  - “学情列表和概览在 768px 无横向溢出”
  - “学情列表和概览在 1280px 无横向溢出”
- `tests/e2e/admin-student-records.spec.ts`
  - “移动端筛选可用且页面无横向溢出”
  - “错题筛选与事件分页保留条件并请求下一页”
  - “活跃页把访问与学习分开，并显示覆盖说明与日历文本替代”
- 截图（由上述 E2E 用例写出，当前尚未生成，执行 `pnpm test:e2e` 后产出）：
  - `docs/qa/screenshots/admin-students-360.png`
  - `docs/qa/screenshots/admin-students-768.png`
  - `docs/qa/screenshots/admin-students-1280.png`
  - `docs/qa/screenshots/admin-student-overview-360.png`
  - `docs/qa/screenshots/admin-student-overview-768.png`
  - `docs/qa/screenshots/admin-student-overview-1280.png`
- 性能：`scripts/benchmark-student-insights.ts` 在 `_test` 库的临时 schema 造 1000 学生 / 100000 作答，20 次预热、100 次测量，输出 p50/p95/max、机器与 PostgreSQL 版本，以及 attempts/events 聚合的 `EXPLAIN (ANALYZE, BUFFERS)`。目标 p95 < 1000ms；结果待 YG 运行后填入，不预填数值。

## 四、本次修复

- `packages/db/migrations/0018_student_insights.sql`：两处外键此前指向不存在的 `"revisions"` 表，改为实际表名 `"textbook_revisions"`，否则空库迁移无法完成。
- `tests/helpers/database.ts`：抽出 `resolveTestDatabaseUrl`，供基准脚本与测试共用，统一拒绝生产环境、应用库、非 `_test` 库与畸形 URL。
- `apps/server/src/modules/student-insights/snapshot.ts`：作答与对话证据改为只收录带 `task_id` 且任务未软删除的记录。此前无任务的自由练习作答与自由提问会进入证据目录，但读取时因无法生成跳转链接被过滤，报告会误报“证据不可用”。回归测试为 `tests/integration/student-insight-reports.test.ts` 的 “keeps taskless attempts and chats out of the navigable evidence catalog”。

## 五、发布步骤与回退

1. 执行迁移 `pnpm db:migrate`；失败则不开放入口。
2. 部署服务与前端。
3. 幂等执行历史回填，检查 coverage 与列表/概览指标。
4. 管理员按 A1–A10 抽查页面与报告。
5. 回退应用时保留新增表与事实数据，不执行自动 DROP；事件写入可停止，原有学习流程继续可用。

部署不在本计划授权范围内；本记录只交付可评审的代码与上述步骤。
