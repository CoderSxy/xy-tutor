# 移动端混合练习上线运行手册

适用版本：自 `0030_mobile_mixed_practice` 起的题组、结构化题型与错题来源能力。
设计见 [mobile mixed practice](../superpowers/specs/2026-11-15-mobile-mixed-practice-design.md)。

原则：

- 只做增量迁移，不回滚删表，不改写原始题干或作答证据。
- `PRACTICE_SETS_ENABLED` 与 `MOBILE_STUDY_ENABLED` 默认 `false`。关闭新建开关后，已创建题组仍可读取、提交、重试和完成。
- 日志与计数只记录 ID、错误码和汇总，不写学生全文或带签名的附件地址。

## 0. 开关

| 环境变量 | capabilities | 默认 | 关闭后 |
|---|---|---|---|
| `PRACTICE_SETS_ENABLED` | `practiceSets` | false | 不再创建新题组；既有题组 API 仍可用 |
| `MOBILE_STUDY_ENABLED` | `mobileStudy` | false | 不强制新学习壳；既有题组作答不受阻 |

`/api/capabilities` 两项分别为 `"enabled"` / `"disabled"`。后端必须按开关校验，不能只靠隐藏按钮。

## 1. 迁移

```sh
pnpm db:migrate
```

- 确认 journal 最新条目为 `0030_mobile_mixed_practice`；若再追加迁移只允许新编号。
- 失败时停止上线，不要 `reset` 数据库。

## 2. 作业

| kind | 作用 | 失败处理 |
|---|---|---|
| `learning.practice-set` | 按蓝图填五个正式槽 | 投影 `generation=failed`，允许按槽重试，已绑定题不变 |
| `learning.assess` | 正式核验 | 单项 `grading=failed`，可按 submission item 重试 |
| `learning.mistake-sync` | 判错后写入学习错题 | `mistakeSync=failed` 可重试；未同步则 `canContinue=false` |

租约耗尽不得保持永久处理中。提交、核验、错题同步、掌握状态是不同事实。

## 3. 历史错题补齐

```sh
pnpm backfill:mistakes --dry-run
# 核对预览后再在另行授权的环境执行
pnpm backfill:mistakes
```

先 dry-run。不要对生产库或 ECS 直接 apply。脚本按评估事件补来源，不重写原始证据。

## 4. 关闭态部署与回滚

1. 两个开关保持 `false` 发布，确认 `/api/capabilities` 均为 `"disabled"`，旧每日五练入口仍可用。
2. 回滚只关闭新建与新布局：停止创建新题组、可关闭移动学习壳；继续消费 `learning.assess` / `learning.mistake-sync`。
3. 不删表、不丢已提交答案、不撤回已同步错题。

## 5. 启用顺序

1. 内容范围已确认、题目可发布。
2. 错题补齐 dry-run 结论已审阅。
3. 打开 `PRACTICE_SETS_ENABLED` 小范围试用混合五题。
4. 打开 `MOBILE_STUDY_ENABLED` 观察手机学习壳。
5. 扩大范围前确认：默认配额 2 单选 + 2 填空 + 1 解答，学生可见 JSON 不含 `answerSpec` / `rubric` / `referenceAnswer`。

## 6. 故障计数

可观测：`queued` / `running` / `failed`、有效判错未同步数量、题型缺口、语言拒绝次数、组题耗时。按 set/item/job ID 聚合，不记录作答正文。

## 7. 2026-11-16 回归修复后的操作

- 新题组先在学习页确认已发布知识点；不再把任意已发布内容当作学生已确认的学习范围。API 可在创建或重试生成时传 `skillIds`，可选范围由 `/api/practice-skills` 返回。
- 组题优先使用范围内的已发布题库；生成兜底只使用明确关联该技能且已批准的模板。缺少合格题源时显示题源不足，不替换成无关运算题。继续练习保留范围并排除近期重复题干。
- 解答题文字与图片由独立核验处理；模型/图片证据不足时保持待核验，不按关键词猜测正误。需配置可用核验模型；图片仍遵守现有能力和存储配置。
- 学习页会持续刷新排队、批改和错题同步状态；失败或待核验时使用“重试批改 / 错题同步”。刷新页面后仍可重试，已核验且同步失败的题只重试同步。
- 逐题提交后切换整组作答，交卷会沿用既有作答及评估，不要求重复提交已完成题，也不重置其批改状态。
