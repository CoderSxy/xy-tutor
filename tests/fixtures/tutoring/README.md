# 错因诊断评估夹具

阶段一（自适应自学）验收用的标注样例。两个文件：`development.json`（80 条，调试规则用）和
`frozen-evaluation.json`（45 条，只用于验收测量）。合计 125 条。

## 当前状态

**所有样例的 `review.status` 都是 `pending_review`。** 工程侧按错因类型与异常场景整理了题干、
学生作答和期望结论，但没有人逐条做过教师复核。因此：

- 现在跑评估脚本，`review.acceptanceRate` 一定是 `null`；
- 阻断项里一定会出现「没有任何教师复核记录，认可率不可计算」；
- 脚本以退出码 `1` 结束，这是**验收未通过**的正确信号，不是脚本坏了。

不允许把「规则与夹具期望一致率」（`outcomes.fixtureAgreement`）当成认可率。前者衡量规则实现
是否符合标注，后者衡量教师是否认可规则给出的结论，两者不能互相替代。

## 冻结集纪律

`frozen-evaluation.json` 不得用于调整提示词、归因规则或候选排序。一旦拿它调过参，这批样例就
失去测量意义，必须重建一个新的冻结集。日常调试只看 `development.json`。

规则变更、提示词变更或模型版本变更之后，冻结集的对比要同时记录 `versions.rules` 与
`versions.model`。

## 字段说明

样例按「学生只交了这份东西」来构造，字段刻意做得比真实数据紧凑，评估时由脚本展开成
`DiagnosisContext` 与候选列表。

| 字段 | 含义 |
| --- | --- |
| `id` | 样例标识，评估输出里用它对应回样例 |
| `split` | `development` / `frozen`，决定这条样例的使用边界 |
| `scenario` | 场景标签，用于检查异常路径覆盖情况 |
| `stem` / `answer` / `process` | 题目、学生最终答案、学生写在纸上的过程 |
| `steps` | 可定位的过程步骤数；`0` 表示只有最终答案 |
| `probe` | 是否有追问（微题）回复 |
| `stemConfirmed` | 题干识别是否已确认，默认 `true`；`false` 时不应归因 |
| `knowledge` | `available` / `missing`：是否有已发布知识依据可引用 |
| `questionType` | `supported` / `unsupported`：该题型是否支持自动归因 |
| `assessment` | 判题结果与核验状态：`incorrect_verified` / `correct_verified` / `pending` / `uncertain` / `none` |
| `manual` | 教师手工给定的错因；给定时优先于自动推断 |
| `candidates[].code` | 七类错因之一 |
| `candidates[].locates` | 候选是否指向某个具体过程步骤 |
| `candidates[].usesProbe` | 候选是否依赖追问回复支持 |
| `candidates[].contradicts` | 追问回复是否与候选冲突 |
| `candidates[].status` | 模型自称的候选状态；规则层不会采信，用于覆盖「模型自称已确认」 |
| `expected` | 期望规则输出：`{ status, primaryCode }` |
| `review` | 教师复核记录：`pending_review` / `approved` / `rejected`，`approved` 时必须带 `primaryCode`、`reviewer`、`reviewedAt` |

## 覆盖要求

- 七类错因各不少于 6 条：`execution_slip`、`condition_omission`、`concept_gap`、
  `rule_misuse`、`strategy_gap`、`expression_gap`、`input_issue`。
- 十个异常场景各至少一条：过程可定位、只有最终答案、题干未确认、题型暂不归因、判题待核验、
  判题结果正确、缺已发布知识依据、证据冲突、模型输出无效、输入问题。
- 至少两对「相同最终答案、不同错因」的样例：
  - `5/8 + 1/8` 答成 `6/16`：一处是分母相加（`rule_misuse`），一处是算对了却抄错（`execution_slip`）；
  - `1/2 ÷ 1/4` 答成 `1/8`：一处是除法规则用错（`rule_misuse`），一处是算对了却抄错（`execution_slip`）；
  - `1/4+1/4` 答成 `1/8` 也构成一对，且两条都在冻结集里：约分规则用错（`rule_misuse`）
    与算对了却抄错（`execution_slip`）。
- 冻结集内部同样要覆盖四个「不该归因」的场景（题型暂不归因、判题待核验、判题结果正确、
  模型输出无效），否则验收只能证明规则会给结论，不能证明它会克制。

## 教师复核流程

1. 打开 `development.json` 或 `frozen-evaluation.json`。
2. 对每条样例判断规则结论是否成立（`confirmed` 的错因是否就是真实错因；`needs_probe` /
   `pending` / `unsupported` 是否应该继续追问或不归因）。
3. 认可时把 `review.status` 改为 `approved`，填 `review.primaryCode`（教师认为的真实错因）、
   `reviewer`、`reviewedAt`；不认可时改为 `rejected` 并写明原因。
4. 复核只能由教师做，工程侧不得代填。

门槛：至少 30 条 `confirmed` 结论经教师复核，教师认可率不低于 90%，阻断项为 0。

## 运行

```bash
pnpm evaluate:tutoring --dataset=tests/fixtures/tutoring/development.json,tests/fixtures/tutoring/frozen-evaluation.json --output=$TMPDIR/tutoring-report.json
```

覆盖要求（七类错因、十个异常场景、两对同答案样例）按整套语料检查，所以两份数据集要一起传入；
只传 `frozen-evaluation.json` 会把覆盖缺口误报成阻断项。验收门槛（复核 confirmed 条数、认可率）
只统计冻结集，开发集复核不参与计算。

报告里不含题干、作答原文与学生信息，可以安全归档到 `docs/qa/` 引用的位置。
