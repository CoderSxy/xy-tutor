# 自适应自学阶段三验收记录

日期：2026-11-14
设计：`docs/superpowers/specs/2026-11-13-adaptive-self-learning-design.md`
计划：`docs/superpowers/plans/2026-11-13-adaptive-self-learning.md`
运行手册：`docs/runbooks/adaptive-learning.md`

阶段三（Task 14–16）交付的是「可复核的学情结论与可运营的上线路径」：独立学习与效率指标、
教师复核错因并失效派生证据、分维度画像与推荐理由的评估面板、计时清理任务、基准测量与
分阶段上线手册。四个功能开关仍然默认关闭。

## 一、结论

**工程侧检查通过，但阶段一、二、三的人工门槛一个都没有满足，因此三个阶段都不标记为完成，
也不声明任何因果提升。** 具体阻断项：

1. **阶段一**：冻结集 45 条仍无教师复核（复核 0 条、经复核的 `confirmed` 0 条，门槛 30 条），
   教师认可率仍不可计算。离线评估脚本继续以退出码 `1` 结束。
2. **阶段二**：模板没有任何批准记录（`question_templates.approved_by` 为空），影子运行的
   选择结果也没有管理员逐条核对。
3. **阶段三**：没有独立的成效实验方案与样本量核算，评估面板只在测试数据与冻结样例上验证过，
   没有真实学生队列的观察窗口。

在所有门槛满足前，`ADAPTIVE_PRACTICE_ENABLED` 与 `LEARNING_EVALUATION_ENABLED` 保持关闭；
关闭时学习流程与阶段一之前一致，不留下失效入口。

## 二、已执行的检查

全部命令在 2026-11-14 执行。单测、类型检查、lint 与构建在本机 Bash 内运行；集成测试与 E2E
在终端面板内带独立测试库执行，`TEST_DATABASE_URL` 指向 `xy_tutor_test`，不指向开发库。

| 命令 | 结果 | 说明 |
|---|---|---|
| `pnpm typecheck` | exit 0 | 全仓类型检查 |
| `pnpm lint` | exit 0 | ESLint 无告警 |
| `pnpm build` | exit 0 | 前端与服务端构建产物生成 |
| `pnpm test` | 单元 25 文件 / 185 用例通过；集成 45 文件 / 281 用例通过 | 真实 PG，`_test` 库 |
| `pnpm test:e2e` | 82 passed / 2 failed | 两条失败均为既有问题，见下 |

### E2E 结果与两条失败的定性

`tests/e2e/learning-evaluation.spec.ts` 5 个用例全部通过：

| 用例 | 覆盖 | 状态 |
|---|---|---|
| 三阶段旅程 | 自查入口、下一题理由、分维度画像与效率文案 | passed |
| 计时样本不足 | 分母 0 显示「无样本」、无数据「—」、不出现 0% | passed |
| 教师纠错 | 更正错因后正误结论不变、诊断版本推进、复核理由落库 | passed |
| 开关依次关闭 | 无自查与下一步入口，仍可提交回答并进入原个人设置 | passed |
| 评估开关关闭 | 概览保留原统计，不显示评测面板 | passed |

全量运行中两条失败与本分支无关，未修复也未写成通过：

- `tests/e2e/content-ui.spec.ts:110`：用例等待按钮名 `查看原图 · 第2页`，页面实际渲染
  `查看原图 · 第 2 页`（带空格）。`MistakeDetail.tsx` 与该 spec 自 `c5eee8d` 起未改动，
  是既有选择器文案不一致，单 worker 运行同样失败。
- `tests/e2e/learning-journey.spec.ts:19`：只在全量顺序运行、集成测试先污染同一个 `_test` 库时
  失败（页面停在第 5 题、会话数被上一次运行残留）；该 spec 单独运行通过。

在修掉选择器文案与测试库隔离之前，这两条不能作为发布阻断项，也不能记为通过。

## 三、基准测量

`pnpm benchmark:adaptive-learning` 只在 `_test` 库的临时 schema 造数，测完清理。数据集：
100 学生、10,000 正式作答、100,000 计时事件、10,000 题库条目、200 条诊断；seed 4.0s，
预热 3 次、测量 20 次。结果存档在 `docs/qa/adaptive-learning-benchmark.json`。

| 场景 | p50 | p95 | max | 说明 |
|---|---|---|---|---|
| 候选查询（返回 10 条） | 24.11ms | 28.75ms | 30.55ms | 目标 p95 < 1000ms，通过 |
| 画像重建 | 8.77ms | 17.35ms | 41.08ms | 同上 |
| 清理候选（500 条） | — | — | — | 单次 1.021ms，走 `timing_event_created_at` 索引 |
| 内存峰值 | heap 22.53MB / RSS 164.13MB | | | |

执行计划观察：

- 候选查询对 `question_bank_entries` 做 10,000 行顺序扫描（204 buffers、2.0ms），再与
  1,000 行技能子集的位图结果做哈希连接，整体约 44.8ms，排序为 27kB 的 top-N heapsort。
  planner 在「扫 10,000 行取已发布题」与「1,000 次主键查找」之间选了前者，是规模决定的
  代价选择，不是缺索引；本记录如实写明扫描范围与数据规模上限，不为消除提示额外加索引。
  真实数据量超过一个数量级时必须重测再决定。
- 画像重建对 `question_versions` 有一次顺序扫描（0.6ms），来源是版本过滤条件；同样属于小表代价。
- 清理候选走 `timing_event_created_at` 范围扫描 + `attempt_timing_snapshot_episode` 的
  index-only 查找 + 封存状态判断；删除按 `id = ANY($1::uuid[])` 走位图，不使用全表删除。

**本机结果只代表本机（Apple M2 / 8 核 / 16GiB）与这份数据集，不能作为 ECS（2 核 2GiB）
容量保证。** 上线前必须在 ECS 上按同一脚本复测。

## 四、Reviewer Focus 五类风险逐项回归

计划第 365 行要求逐项回归五类风险，仓库内没有单独的清单文件，这里按产品约束列全：

| # | 风险 | 回归位置 | 结果 |
|---|---|---|---|
| 1 | 把知识缺口伪装成粗心或习惯问题 | `tests/unit/diagnosis-rules.test.ts`、`tests/integration/tutoring-diagnosis.test.ts`、`tests/e2e/learning-evaluation.spec.ts`（教师纠错） | 错因结论必须带证据；教师可把习惯类更正为知识缺口，面板摘要随之更新，旧报告保持生成时快照 |
| 2 | 单凭快慢判断能力、态度或错因 | `tests/unit/learning-efficiency.test.ts`、`tests/e2e/learning-evaluation.spec.ts`（计时不足） | 计时只作诊断与熟练度证据；样本不足返回 `insufficient_samples`，同题桶不足时效率表为空态，页面无「快/慢」结论 |
| 3 | 从未点击、未输入推断走神 | `tests/unit/learning-timing.test.ts`、`tests/e2e/learning-timing.spec.ts` | 无事件即 `missing`，不折算 0；计时失败不阻断有效答案提交 |
| 4 | 正误结论与错因判断相互独立 | `tests/e2e/learning-evaluation.spec.ts`（教师纠错） | 「错误 · 已核验」与「错因未确认」可并存；复核只改错因，不重写已核验的正误 |
| 5 | 关闭开关后原流程不可用、缺数据写成 0 | `tests/e2e/learning-evaluation.spec.ts`（开关依次关闭、评估关闭）、`tests/e2e/adaptive-practice.spec.ts` | 四个开关全关时无自查区与下一步卡，作答与个人设置正常；无数据显示「—」，分母 0 显示「无样本」 |

## 五、分阶段状态与人工门槛

| 阶段 | 开关 | 工程侧 | 人工门槛 | 状态 |
|---|---|---|---|---|
| 一：自查与诊断 | `TUTOR_SELF_CHECK_ENABLED`、`LEARNING_TIMING_ENABLED` | 通过 | 冻结集教师复核 0/30，认可率不可计算 | 未完成 |
| 二：个性化练习 | `ADAPTIVE_PRACTICE_ENABLED`（依赖自查） | 通过 | 模板批准 0 个；影子运行未经管理员逐条核对 | 未完成 |
| 三：学情评估 | `LEARNING_EVALUATION_ENABLED` | 通过 | 无独立实验方案与样本量；无真实队列观察窗口 | 未完成 |

解除阻断需要：

1. 教师按 `docs/qa/adaptive-learning-phase-1.md` 第四节复核冻结集，达到 30 条经复核的
   `confirmed` 且认可率不低于 90%。
2. 管理员按阶段二记录第六节核对影子运行案例，并批准至少一个模板族。
3. 阶段一、二稳定后先在白名单学生观察 3–5 天，再评估是否进入阶段三；阶段三的观察窗口、
   口径与样本量写进本记录更新版。

## 六、教师确认与实验条件

- 教师确认：目前为 0 条。诊断、模板与「是否把某条错因改判」都需要教师本人确认，工程侧不代填。
- 实验条件：没有教师批准的独立实验方案，也没有对照、样本量核算、退出规则与不确定性区间。
  因此本记录**只描述观察结果与工程指标，不声明任何因果提升**，也不给出提升百分比。
- 若后续要声明因果提升，需要先确定：对照方式（同期对照或前后对照）、样本量测算、观察窗口、
  数据截止水位、退出与无效样本规则，并在开启前冻结方案。未具备条件前，继续按描述性纵向
  评估口径记录。

## 七、未验证的限制

- 真实 provider / OCR smoke 未执行：本机没有配置对应环境，`pnpm smoke:provider`、
  `pnpm smoke:oss`、`pnpm smoke:ocr` 均未运行，不能视为通过。
- ECS 容量未验证：见第三节，本机基准不构成线上保证。
- `content-ui.spec.ts` 选择器文案问题未修，属于既有缺陷；`learning-journey.spec.ts` 全量运行
  时的库污染问题未修，属于测试隔离缺陷。
- 阶段一、二的人工核对没有真实教师参与，本记录不包含教师签署。
- 浏览器验证仅覆盖 Playwright 的 Chromium（`channel: chrome`），未做 Safari / 移动端真机验证。

## 八、已知局限

- 评估面板只展示结构化事实，模型只解释不计算；报告中的结论不能替代教师判断。
- 群体参照默认关闭，未达 30 名学生 / 100 条样本时只与自身冻结基线比较，不做横向排名。
- 清理任务只删除满 30 天、已封存且已聚合的原始计时事件；回退不需要停掉它，只有需要保留
  原始事件取证时才临时停用。
- 功能开关关闭只影响新能力入口，已产生的证据、快照与历史报告不会自动删除。
