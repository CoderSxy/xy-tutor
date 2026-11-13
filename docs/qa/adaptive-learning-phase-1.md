# 自适应自学阶段一验收记录

日期：2026-11-13
设计：`docs/superpowers/specs/2026-11-13-adaptive-self-learning-design.md`
计划：`docs/superpowers/plans/2026-11-13-adaptive-self-learning.md`

阶段一（Task 1–8）交付的是「可审计的自查与错因诊断」：契约与开关、分段计时、尝试与租约绑定、
教学状态机与动作幂等、带证据版本的错因诊断、自查引导与提示暴露审计、错题详情诊断摘要，
以及离线错因评估。功能开关全部默认关闭，关闭时原有学习流程不变。

## 一、结论

**阶段一尚未通过验收。** 阻断原因只有一个：120 条以上标注样例（当前 125 条）全部处于
`pending_review`，没有任何教师复核记录，因此教师认可率不可计算，也没有 30 条经复核的
`confirmed` 结论。规则实现本身与夹具期望的一致率是 100%，但那不是教师认可率，不能互相替代。

离线评估脚本按设计以退出码 `1` 结束。这是「验收未通过」的正确信号，不是脚本故障。

## 二、已执行的检查

| 命令 | 结果 | 说明 |
|---|---|---|
| `pnpm -s typecheck` | exit 0 | 全仓类型检查通过（2026-11-13 执行） |
| `pnpm -s lint` | exit 0 | ESLint 无告警（2026-11-13 执行） |
| `pnpm -s test:unit` | 20 个文件 / 123 个测试通过 | 2026-11-13 执行 |
| `pnpm evaluate:tutoring --dataset=tests/fixtures/tutoring/development.json,tests/fixtures/tutoring/frozen-evaluation.json --output=$TMPDIR/tutoring-report.json` | exit 1，阻断项 2 条 | 见第三节 |

集成测试与 E2E 需要真实 PostgreSQL 与浏览器端口，在终端面板（`c2`）内带着
`TEST_DATABASE_URL='postgres://xy_tutor:local-development-only@127.0.0.1:55432/xy_tutor_test'`
执行，禁止指向其他数据库。

| 文件 | 覆盖 | 状态 |
|---|---|---|
| `tests/unit/adaptive-contracts.test.ts` | 契约与开关默认值 | 通过 |
| `tests/unit/config.test.ts` | 开关组合校验（adaptive 依赖 self-check） | 通过 |
| `tests/unit/learning-timing.test.ts` | 分段计时规则 | 通过 |
| `tests/unit/tutoring-state.test.ts` | 教学状态机与动作规则 | 通过 |
| `tests/unit/diagnosis-rules.test.ts` | 错因判定顺序与保守序 | 通过 |
| `tests/unit/timing-client.test.ts` | 前端计时客户端（空闲、可见性、租约） | 通过 |
| `tests/integration/tutoring-schema.test.ts` | 迁移与表结构约束 | 通过 |
| `tests/integration/learning-timing.test.ts` | 租约与快照绑定尝试 | 通过 |
| `tests/integration/tutoring-diagnosis.test.ts` | 证据版本、失效、诊断接口 | 通过 |
| `tests/integration/tutoring-actions.test.ts` | 动作幂等、版本冲突 409、暴露审计 | 通过 |
| `tests/e2e/self-check-journey.spec.ts` | 自查旅程、讲解标记、开关关闭、错题诊断摘要 | 4 passed |
| `tests/e2e/learning-timing.spec.ts` | 计时不被输入监控、失败不阻断提交 | 通过 |

E2E 与集成测试的最近一次执行在 2026-11-13、对应提交 `c31f380`。此后只改动了
`scripts/evaluate-tutoring.ts`、`tests/fixtures/tutoring/*` 与本记录，未触及应用代码，
因此没有重跑；下一次改动应用代码时必须重跑。

## 三、离线错因评估

```
样本 125（开发 80 / 冻结 45），confirmed 82，教师复核 0，阻断项 2
- 冻结集没有任何教师复核记录，认可率不可计算
- 冻结集经教师复核的 confirmed 只有 0 条，门槛是 30 条
```

| 指标 | 开发集 | 冻结集 |
|---|---|---|
| 样例数 | 80 | 45 |
| `confirmed` | 47 | 35 |
| `needs_probe` | 11 | 2 |
| `pending` | 16 | 6 |
| `unsupported` | 6 | 2 |
| 教师复核 | 0 | 0 |
| 认可率 | `null` | `null` |

其他覆盖检查：

- 七类错因全部覆盖，且每条都有 `confirmed` 输出；`input_issue` 恒为不归因。
- 十个异常场景全部覆盖：过程可定位、只有最终答案、题干未确认、题型暂不归因、判题待核验、
  判题结果正确、缺已发布知识依据、证据冲突、模型输出无效、输入问题。
- 「相同最终答案、不同错因」三对：`5/8+1/8→6/16`、`1/2÷1/4→1/8`（均在开发集），
  `1/4+1/4→1/8`（冻结集内部一对）。
- 规则输出与夹具期望一致率 `1.0`（`outcomes.fixtureAgreement`）。夹具由工程侧标注，
  与规则同源，一致率高只能说明实现符合标注，不能说明归因正确。

报告 `$TMPDIR/tutoring-report.json` 不含题干、作答原文与学生信息，可归档到 `docs/qa/`。
夹具说明与复核流程见 `tests/fixtures/tutoring/README.md`。

## 四、解除阻断所需动作

验收门槛（判定代码在 `scripts/evaluate-tutoring.ts`）：冻结集至少 30 条 `confirmed` 结论经教师
复核，教师认可率不低于 90%，阻断项为 0。开发集复核不计入门槛。

1. 教师逐条复核 `tests/fixtures/tutoring/frozen-evaluation.json`，认可时把 `review.status`
   改为 `approved` 并填 `review.primaryCode`、`review.reviewer`、`review.reviewedAt`；
   不认可时改为 `rejected`。工程侧不得代填。
2. 复核开发集只用于修规则，不能顶替冻结集门槛。冻结集一旦被用于调参就必须重建。
3. 重新执行：

   ```bash
   pnpm evaluate:tutoring --dataset=tests/fixtures/tutoring/development.json,tests/fixtures/tutoring/frozen-evaluation.json --output=$TMPDIR/tutoring-report.json
   ```

   预期：`review.acceptanceRate` 不再是 `null`，阻断项为 0，退出码 0。

## 五、已知局限

- `versions.model` 记录为 `unavailable`：当前没有任何模型参与，规则是确定性的；将来引入模型
  归因时必须重新记录模型版本并重建冻结集对比。
- 冻结集 45 条中 `confirmed` 容量为 35 条，刚过 30 条门槛。复核驳回一条 `confirmed` 时
  还有余量，但驳回过多会同时触发「复核 confirmed 不足」和认可率两项阻断。
- 语料规模按计划从 120 条扩到 125 条（冻结集 40 → 45），用于让冻结集自身覆盖四个「不该归因」
  场景并保留一对同答案样例；增加发生在任何测量之前，没有用冻结集调参。
- 本阶段没有接入真实模型推理，评估只测确定性规则；模型候选生成的质量不在本记录范围内。
