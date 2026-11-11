# 知识点库验收记录（2026-11-11）

本轮验收覆盖知识点库替代教材选择的完整链路。运行环境：本地 PostgreSQL 测试库（随机 schema）、Playwright 本地 web server。未使用真实学生数据或生产密钥。

## 自动检查

| 命令 | 结果 |
|---|---|
| `pnpm test` | 34 个集成/单元测试文件，186 个用例全部通过 |
| `pnpm typecheck` | 通过 |
| `pnpm lint` | 通过 |
| `pnpm test:e2e`（admin-knowledge / admin-student-analysis / admin-student-insights / admin-student-records / content-ui） | 36 个用例全部通过 |

## 覆盖点与对应用例

- 一次上传拆多条并统一确认：`tests/e2e/admin-knowledge.spec.ts`「one upload splits into several knowledge items confirmed together」。
- 修改总结后检索更新：`tests/integration/knowledge-search.test.ts`「reflects edits to a published summary in later searches」。
- 再解析不覆盖已发布内容，需再次确认：`tests/e2e/admin-knowledge.spec.ts`「filters published items, edits them and requests a reparse」及 `tests/integration/knowledge-base-review.test.ts`「reparses a published item into a replacement run without editing it」。
- 未发布知识点不可检索：`tests/integration/knowledge-search.test.ts`。
- 学生不经教材选择即开会话：`tests/integration/tutor.test.ts`「runs a tutoring turn without a textbook binding」与 `tests/integration/learning-unbound.test.ts`。
- 答疑与出题走 `search_knowledge`：`tests/integration/tutor.test.ts`「retrieves only published knowledge and reports insufficient evidence」。
- 教材入口重定向、旧接口 410 且旧表保留：`tests/integration/selections.test.ts` 与 `tests/e2e/admin-knowledge.spec.ts` 首例。

## 人工确认

- 管理员 `/admin/knowledge` 可上传、编辑、批量确认发布；学生端无年级/科目/教材选择步骤。
- 旧教材表仍在库中，未做删除或迁移。

## 备注

- 学情记录相关回归中修复了两处行为：待核验 assessment 不再出现在记录详情、重复打开同一任务/资料的审计在 60 秒内去重。
