# 自适应自学阶段二验收记录

日期：2026-11-13
设计：`docs/superpowers/specs/2026-11-13-adaptive-self-learning-design.md`
计划：`docs/superpowers/plans/2026-11-13-adaptive-self-learning.md`

阶段二（Task 9–13）交付的是「经审核的题库 + 分维度画像 + 可回放的逐题选择」：已审核知识点与
技能、待审到发布的题库流转、模板生成与核验、分维度画像与个人效率基线、逐题选择策略，
以及管理端题库/技能页面和学生端推荐理由。功能开关 `adaptivePractice` 仍默认关闭。

## 一、结论

**工程侧检查全部通过，但阶段二尚未满足启用条件。** 两项目前没有完成：

1. 模板没有任何审核记录（`question_templates.approved_by` 为空），因此模板自动发布路径仍不可用，
   题库只能走人工「提交审核 → 发布」。
2. 影子运行的选择结果还没有管理员逐条核对。计划要求管理员至少确认一个诊断、修复、迁移、复习
   案例；这一步必须由人完成，工程侧不代填。

在上述两条完成前，`adaptivePractice` 保持关闭；关闭时学习流程与阶段一之前完全一致，不留下
失效入口。

## 二、已执行的检查

| 命令 | 结果 | 说明 |
|---|---|---|
| `pnpm -s typecheck` | exit 0 | 2026-11-13 执行 |
| `pnpm -s lint` | exit 0 | 2026-11-13 执行 |
| `pnpm -s test:unit` | 24 个文件 / 166 个测试通过 | 2026-11-13 执行 |
| `pnpm test:e2e tests/e2e/admin-question-bank.spec.ts tests/e2e/adaptive-practice.spec.ts` | 7 passed | 2026-11-13 执行，见下表 |
| `pnpm -s vitest run --config vitest.integration.config.ts tests/integration/adaptive-practice.test.ts` | 11 passed | 2026-11-13 执行 |

E2E 与集成测试使用独立测试库 `xy_tutor_test`，在终端面板内带
`TEST_DATABASE_URL='postgres://xy_tutor:local-development-only@127.0.0.1:55432/xy_tutor_test'`
执行。

| 文件 | 覆盖 | 状态 |
|---|---|---|
| `tests/e2e/admin-question-bank.spec.ts` | 创建技能与前置、关联知识点、新题待审→发布→撤回、模板批准 | 3 passed |
| `tests/e2e/adaptive-practice.spec.ts` | 学生推荐理由与安排下一题、分维度概览、样本不足空态、开关关闭无失效入口 | 4 passed |
| `tests/integration/adaptive-practice.test.ts` | 幂等与并发上限、跨学生幂等键、私题与撤回题过滤、stale 回退、无候选、到期复习、慢而正确、画像版本不匹配、开关关闭 | 11 passed |
| `tests/integration/question-bank-access.test.ts` | 权限、待审题不可见、版本冲突 | 通过 |
| `tests/integration/question-generation.test.ts` | 模板校验失败拒绝、未经批准不自动发布 | 通过 |
| `tests/unit/adaptive-selection.test.ts` | 目标优先级、难度配额、放宽与 `insufficient_pool` | 通过 |
| `tests/unit/learning-efficiency.test.ts` | 样本门槛与效率方向 | 通过 |
| `tests/unit/question-templates.test.ts` | 参数边界、等价约分、指纹稳定 | 通过 |

## 三、影子运行

同一批冻结画像（`adaptive-selection-v1`）下运行 `choosePractice`，输入与输出都固定，可重放。
原有流程没有规则化选择：练习要么由教师指定，要么由模型提议后独立核验，因此不能与新策略逐题
对比“谁更对”；这张表记录的是新策略在同一冻结证据上会做什么，供管理员逐条核对。

| 场景 | 原有流程 | 新策略 | 原因码 |
|---|---|---|---|
| 存在未结诊断 | 教师指定 / 模型提议 | `selected` / `diagnostic` / `medium` | `open_diagnosis,relaxed_difficulty` |
| 错题到期 | 教师指定 / 模型提议 | `selected` / `review` / 无难度 | `review_due` |
| 薄弱技能 | 教师指定 / 模型提议 | `selected` / `repair` / `medium` | `band_repair,relaxed_difficulty` |
| 稳定技能 | 教师指定 / 模型提议 | `selected` / `transfer` / `challenge` | `stable_skill,relaxed_difficulty` |
| 候选池为空 | 无题可出 | `insufficient_pool` / `repair` / 无难度 | `band_repair,no_candidates` |

`relaxed_difficulty` 在四个“已选择”场景里都出现，是因为冻结题库里没有与画像档位配额完全匹配的
难度，策略按设计先放宽难度、不放宽目标。这是阶段一之后新增的规则，管理员核对时应特别确认
放宽后的题目是否仍然可用。

## 四、阻断与过滤记录

- **候选不足**：候选池为空时返回 `insufficient_pool`，不写决策、不消耗每日 5 题配额；学生端显示
  「还在积累可比较的练习」，不显示 0 分或伪造的标准时间。
- **错误题**：撤回后 `published_at` 置空，条目立即从候选池消失，已发出的题目保留历史记录；
  E2E 覆盖「发布 → 撤回 → 立即停止新推荐」，集成测试覆盖撤回题过滤。
- **权限阻断**：他人私有题（`visibility = owner_only` 且非本人）和未发布题从不进入候选池；
  集成测试用两个学生验证了同一请求键不会串到对方题目。
- **未审核题**：`pending_review` 条目只出现在管理端列表，学生端推荐与题库查询都不可见。

## 五、模板审核人与版本

| 模板族 | 版本 | 审核状态 | 审核人 |
|---|---|---|---|
| `rational_arithmetic` | 1 | `pending_review` | 无记录 |
| `linear_equation` | 1 | `pending_review` | 无记录 |

没有经批准（`approved_by` / `approved_at` 有值）的模板，因此模型新题与模板实例都不会自动发布，
所有题库变更都要经过「提交审核 → 管理员发布」。管理员批准时由接口写入操作者与时间，审核人
姓名不进入本记录。

## 六、解除阻断所需动作

1. 管理员在 `/admin/question-bank` 页面核对影子运行表中的四个案例（诊断、复习、修复、迁移），
   记录是否认可新策略给出的目标与放宽后的难度；不认可时先改策略，不改冻结数据。
2. 管理员在 `question_templates` 上批准至少一个模板族，使模板自动发布路径可被验证；批准后把
   审核人与时间写进部署记录，不写进本文件。
3. 两项完成后重新执行第二节的 E2E 与集成测试，再把 `adaptivePractice` 打开；打开前后各跑一次
   同一批冻结作答，确认 `replay` 结果不变。

## 七、已知局限

- 影子运行用的是确定性画像与确定性候选池，没有真实学生作答；效率维度的 `slower` 判断只在三份
  合格同桶样本之后出现，冻结样例里不构成趋势。
- 学生端只显示目标与一句话理由，不显示难度数值、答案、他人记录或策略版本号；若需要在客服场景
  展示更多证据，需要单独的只读审计接口，当前未提供。
- 题库管理目前只有单题录入，没有批量导入；批量导入不在阶段二范围内。
