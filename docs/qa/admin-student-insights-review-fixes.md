# 学情中心 Review 修复记录

日期：2026-11-10。范围：本次 Review 的五个问题，不部署、不运行生产回填。

## 修复

1. 事件采集的 owner 检查改为合法 SELECT，保留学生角色与 owner 限制；唯一键冲突幂等处理，不使重复采集回滚业务事务。
2. 活跃页学习事件查询使用 revisionId，保持访问天数独立于教材。
3. 回填精确扫描至 learning_started_at，不丢弃切换当天的半天记录，也不扫描切换后的代操作。回填版本升为 v2，避免旧版 completed 断点导致缺口永远不重扫。
4. 创建与重试共用活动报告检查；已有另一份 queued/running 报告时返回 409 和其 reportId。
5. 报告创建/重试在事务开始前按 actor → student 获取 session advisory locks，再进入 REPEATABLE READ；既让等待者看到前一个请求提交的报告，也让概览与证据使用同一数据库快照。退出时反序解锁；解锁异常销毁连接，避免会话锁泄漏到连接池。

回归测试：`tests/integration/student-insight-review-regressions.test.ts`。四项新增测试均在修改前失败、修改后通过；阻断学习提交的 SQL 错误由既有 activity 测试先复现后通过。

测试设置修正：学情 POST 请求的 fixture 补正确 Origin，避免被 CSRF 检查提前拒绝；非法 JSON 测试断言 ReportOutputError 类型，仍保留 report/job 的 INVALID_OUTPUT 持久化错误码断言，没有放宽应用鉴权或错误处理。

## 验证

- 最终针对性集成回归：5 个文件 / 37 个测试全部通过。
- `pnpm test:e2e tests/e2e/admin-student-analysis-real.spec.ts`：1 个真实 API 浏览器测试通过，覆盖生成、轮询、证据打开与跨学生隔离。
- 独立静态复查未发现本次修改引入的明确缺陷。
- `pnpm test`：单元 54/54 通过；集成 145/148 通过。
- `pnpm typecheck`、`pnpm lint`、`pnpm build` 均 exit 0。构建有既有 chunk 大小提示；pg 有单连接并发 query 弃用提示。
- 全量集成未通过的三项（相关生产代码和断言未改）：
  - `admin-student-insight-auth.test.ts` / `rejects student actors, malformed ids and unknown students`：直接 service 调用抛 ZodError，断言期待 AppError VALIDATION/422。
  - `admin-student-insight-records.test.ts` / `任务列表与详情只暴露本学生有效数据，只在打开详情时审计`：任务详情分页重复写审计，期待 1，实际 3。
  - `admin-student-insight-records.test.ts` / `资料题目去重计数，文件签名 300 秒且不含 object_key`：重复详情请求写两次审计，期待 1，实际 2。

## 发布注意

本次没有新增数据库迁移。部署修复后，应针对原先执行 v1 的日期范围重新运行回填脚本；v2 会重新扫描并利用事件唯一键去重，从而补齐旧版遗漏的切换当天记录。此操作未在生产执行。旧版覆盖率记录保留，新版进度独立。
