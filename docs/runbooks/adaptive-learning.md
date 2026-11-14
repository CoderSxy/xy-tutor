# 自适应学习分阶段上线运行手册

适用版本：自 `0029_adaptive_learning_indexes` 起的三阶段自适应学习能力。
三阶段定义见[自适应学习设计](../superpowers/specs/2026-11-13-adaptive-self-learning-design.md)§3。

原则：

- 只做增量迁移，不回滚删表。回退一律关闭功能开关。
- 证据、计时段、快照和历史报告在回退后保留，供复盘与恢复使用。
- 每个阶段先满足人工门槛，再进入下一阶段；未满足的阶段不得标记为完成。

## 0. 上线前检查

1. 确认部署基线为单实例 2 核 2GiB，PG 复用现有实例，不新增 Redis / 向量库。
2. 确认本次只包含增量迁移，`packages/db/migrations/meta/_journal.json` 有对应条目。
3. 确认以下开关在目标环境的初始值全为 `false`：

   | 环境变量 | 含义 | 依赖 |
   |---|---|---|
   | `TUTOR_SELF_CHECK_ENABLED` | 自查与提示流程（阶段一） | 无 |
   | `LEARNING_TIMING_ENABLED` | 计时采集与清理任务 | 无 |
   | `ADAPTIVE_PRACTICE_ENABLED` | 画像驱动的个性化练习（阶段二） | 必须同时开 `TUTOR_SELF_CHECK_ENABLED` |
   | `LEARNING_EVALUATION_ENABLED` | 独立学习与效率证据面板（阶段三） | 建议在阶段二稳定后开启 |
   | `LEARNING_GROUP_REFERENCE_ENABLED` | 群体参照（默认长期关闭） | 需满足 30 名学生 / 100 条样本门槛 |

   启动时若 `ADAPTIVE_PRACTICE_ENABLED=true` 而 `TUTOR_SELF_CHECK_ENABLED=false`，服务会以 `Invalid configuration` 拒绝启动。这是刻意设计：个性化练习依赖自查阶段产出的证据。

## 1. 迁移

```sh
pnpm db:migrate
```

- 迁移只新增索引，不重写历史数据；`timing_events` 与 `question_references` 的旧记录保持原样。
- 迁移完成后检查 journal 是否推进到 `0029_adaptive_learning_indexes`，再进入下一步。
- 若迁移失败，停止上线，不要 reset 数据库；修好后重跑同一条命令。

## 2. 关闭开关部署

应用新版本，但所有开关仍为 `false`，然后验证：

1. `/api/capabilities` 四项均为 `"disabled"`（`capabilities.timing`、`selfCheck`、`adaptivePractice`、`learningEvaluation`）。
2. 学生端 `/study/:id` 与原来的学习流程一致：没有「自查与提示」区域，没有「下一步」卡片，可以正常提交回答。
3. `/profile` 只显示原有个人设置，没有「分维度学情」。
4. 管理端 `/admin/students/:id/overview` 保留原有统计，没有「独立学习与效率证据」面板。

这一步证明关闭态不影响原有流程，是后续回退的基线。

## 3. 内容审核

1. 管理员在「知识点」页确认要进入推荐的知识点已发布，且题目的 `question_references` 与 `question_bank_entries` 均处于正式准入状态。
2. 未发布知识点、未正式准入题目不得进入新推荐；这些条目在候选查询中会被过滤，若发现漏出属于阻断问题，停在上线前修复。
3. 记录本次审核人、审核时间与通过条目数，写入验收记录。

## 4. 阶段一：诊断与自查白名单

1. 开启 `TUTOR_SELF_CHECK_ENABLED=true`，`LEARNING_TIMING_ENABLED=true`，其余保持 `false`。
2. 先在白名单学生上试点（按邀请或账号范围），确认：
   - 自查与提示可用，暂停、求助、直接讲解都能走通。
   - 计时只在学生实际作答时产生；计时失败不阻断有效答案提交。
   - 老师或学生本人可以撤销错误证据，撤销后历史报告不被静默重算。
3. 计时数据只用于熟练度与诊断，不单独据此判定快慢、能力或态度。页面不应出现「因为用时短/长所以……」的结论。
4. 观察 3–5 天，确认无阻断问题后进入阶段二。

## 5. 阶段二：策略影子运行与人工核对

1. 开启 `ADAPTIVE_PRACTICE_ENABLED=true`（`TUTOR_SELF_CHECK_ENABLED` 必须已开）。
2. 选一批学生影子运行：推荐决策落库但先不改变学生看到的题目顺序。管理员用 `learning_profile.rebuild` 任务重建画像，人工抽查：
   - 推荐理由是否用学习语言表达，是否暴露策略编码。
   - 样本不足时是否返回 `insufficient_samples`，而不是给出 0 分或快慢结论。
   - 题库准入过滤是否生效（未发布、未准入题目不出现）。
3. 核对通过后再让推荐直接生效；不通过则关闭 `ADAPTIVE_PRACTICE_ENABLED`，保留已落库决策与画像证据。
4. 每名学生最多保留 5 条群体样本；未达门槛时只与自身冻结基线比较，不做横向排名。

## 6. 阶段三：评估面板

1. 开启 `LEARNING_EVALUATION_ENABLED=true`。
2. 管理端 `/admin/students/:id/overview` 出现「独立学习与效率证据」：
   - 无数据时显示「—」，分母为 0 时显示「无样本」，不得写成 0。
   - 计时样本不足时不出现快慢结论，同题桶效率表为空态。
   - 群体参照未达门槛时显示门槛说明。
3. 报告快照生成后若有证据被撤销，面板顶部以只读提示说明「历史报告保持生成时的内容，不会静默重算」。
4. 只有测试与本阶段人工门槛同时满足，才把阶段三标记为完成。

## 7. 成效评估

- 默认只做描述性纵向评估：同一批学生在开启前后的观察结果，配合样本量与数据截止时间。
- 要声明因果提升，必须先有教师批准的独立实验方案（对照、样本量、退出规则、不确定性区间），并完成样本量核算；不具备条件时只描述观察结果，不承诺提升百分比。
- 评估口径、观察窗口和结论写入 `docs/qa/adaptive-learning-phase-3.md`。

## 8. 回退演练

回退只关开关，不删表、不回滚迁移。

1. 按相反顺序关闭：`LEARNING_EVALUATION_ENABLED` → `ADAPTIVE_PRACTICE_ENABLED` → `TUTOR_SELF_CHECK_ENABLED` / `LEARNING_TIMING_ENABLED`。每次只关一个，观察是否出现降级。
2. 每关一个都验证原流程：
   - 关 `LEARNING_EVALUATION_ENABLED`：概览页回到原有统计，学生页不受影响。
   - 关 `ADAPTIVE_PRACTICE_ENABLED`：学生看不到「下一步」与分维度画像，作答、错题、复习流程正常。
   - 关 `TUTOR_SELF_CHECK_ENABLED`：没有自查区域，学生仍可提交回答并得到原有反馈。
   - 关 `LEARNING_TIMING_ENABLED`：不再采集计时，已有快照与报告保留；清理任务可继续运行，也可单独关闭。
3. 计时能力可独立关闭，不依赖其他开关；`ADAPTIVE_PRACTICE_ENABLED` 依赖 `TUTOR_SELF_CHECK_ENABLED`，不能单独保留。
4. 回退后保留证据：`timing_segments`、`attempt_timing_snapshots`、`learning_evaluations`、诊断与复核记录全部不动。重新开启后按原逻辑继续读取。
5. 清理任务 `learning_timing.cleanup` 只删除满 30 天、已封存且已聚合的原始计时事件；它不属于回退手段，回退时不需要停掉它，除非需要保留原始事件做取证。

## 9. 计时数据保留

- 每日由调度器入队一次 `learning_timing.cleanup`，同一天重复入队会被 dedupe key 合并。
- 每批 500 条，循环直到没有候选；只删除 `created_at` 早于 30 天、episode 已 `finished`、且存在 `attempt_timing_snapshots` 的事件。
- 未封存、未聚合的事件一律保留；学生删除与授权变化走现有访问边界，清理任务不绕过权限判断。
- 快照、计时段、冻结指标与历史报告不受清理影响。

## 10. 性能与环境

- `pnpm benchmark:adaptive-learning` 只在 `_test` 库的临时 schema 造数，测量后清理。
- 本机测量结果只代表本机与数据集，不能当作 ECS（2 核 2GiB）容量保证。真实容量需在 ECS 上按同样口径复测后再决定是否扩大试点。
- 若出现单次请求扫描全库或重任务并发超过 1，先修正再验收，不带着该问题开启下一阶段。
