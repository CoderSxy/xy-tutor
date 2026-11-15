# 移动端学习体验、混合题型与会话错题闭环设计

- 日期：2026-11-15
- 状态：用户已确认总体方案；本文细化工程约定，供实施审阅，不代表功能已实现。
- 配套计划：[实施计划](../plans/2026-11-15-mobile-mixed-practice.md)。
- 前置设计：[MVP](2026-11-08-xy-tutor-mvp-design.md)、[图片作答](2026-11-09-chat-image-attachments-design.md)、[自适应学习](2026-11-13-adaptive-self-learning-design.md)。
- 范围：移动端学习交互、每日五题混合组题、逐题/整组作答、学生可见中文内容、上传/学习错题分类与可靠入库。
- 本次文档任务不修改产品代码、不运行迁移、不部署、不执行 Git 提交。本文新增阈值和接口是工程决策，不是已测得的教学结论。

## 1. 目标与边界

### 1.1 成功定义

学生在手机上能清楚看到正在做哪道题、答案是否提交、是否批改以及下一步能做什么；在 Pad 和 PC 上可以一次查看五题、独立保存每题答案并统一交卷。题目描述、提示、解析和反馈使用简体中文。正式作答经有效核验判错后，能够可靠进入该学生的错题库，并保留原始证据与来源。

核心闭环：

`确定学习范围 → 创建五题蓝图 → 选题/生成并核验 → 逐题或整组作答 → 正式判题 → 错题同步 → 本组小结 → 再来五题/订正`

### 1.2 全局约束

- 使用现有 React/Vite/TypeScript、Fastify、PostgreSQL/Drizzle、ModelGateway、JobQueue，不新增 Redis、向量库或独立推荐服务。
- 保留现有浅色背景、白色卡片和深绿色主操作，沿用根目录 DESIGN.md 的视觉基础；借鉴 nero-agent 的移动端结构与交互。
- 手机断点小于 768px，Pad 为 768～1199px，PC 为至少 1200px；是否双栏还取决于实际可用宽度。
- 触控目标至少 44×44 CSS px，正文默认 16px；支持可见焦点、键盘操作、中文输入法与 reduced-motion。
- 学生可见叙述使用简体中文；公式、变量、单位符号和必要英文专名保留原文。
- 提交、核验、错题同步、掌握状态是不同事实；不把模型聊天判断当成正式评估，不把提示后答对记作独立完成。
- 无法可靠判题时显示待核验，不自动记错；未知历史题型和来源不伪造分类。
- 新数据表及迁移采用增量兼容；不覆盖旧迁移、不 reset 数据库、不改写原始题干/作答证据。
- 所有 API 按 StudentScope 校验；共享题可见性不等于其他学生的答案、错题或附件可见。
- 测试只使用独立 `_test` 数据库；不提交真实学生资料、真实密钥和带签名的附件地址。

### 1.3 非目标

本轮不建设手写识别画板，不承诺覆盖全学科所有题型，不恢复教材/年级强制绑定，不把每日五题包装成正式考试，不实现完整考试配置管理后台，不默认限时，不以速度判断掌握，不重做管理后台整体风格。

## 2. 当前证据与方案选择

### 2.1 已核对的实现

| 位置 | 已存在能力/约束 | 本轮处理 |
|---|---|---|
| `apps/server/src/agent/prompts.ts` | 明确要求每日五练逐题、优先 number、不批量出题 | 改为遵循后端组题与模式，不能绕过题组自己出正式题 |
| `modules/learning/practice.ts` | 单道候选核验、两次尝试、变式关联 | 接入结构化题型与语言检查，保留核验门槛 |
| `modules/question-bank/templates.ts` | 有理数和一次方程模板均为 number | 保留确定性解题能力，扩展题型变换与验证 |
| `modules/learning-profile/selection-service.ts` | 画像推荐、候选去重、单题落 task_items | 抽取可复用候选选择，题组协调器控制五个正式槽位 |
| `modules/conversations/runs.ts`、`learning/attempts.ts` | 提交即将 task_items.status 写为 answered | 保留旧字段兼容，新增提交/批改投影，完成不再只数 answered |
| `app.ts` 的 assess 包装 | 正式评估后已调用 mistakes.applyAssessment | 不能简单再加一次调用；改为可靠事件与同步状态 |
| `modules/learning/mistakes.ts` | verified incorrect 自动入库、去重、状态重建 | 修复共享题合法访问；补事件重试、来源和改判处理 |
| `MistakeService.add` | 要求 questions.student_id 等于当前学生 | 共享题 student_id 为空时可能失败；以合法 task/attempt 关联补充授权 |
| `apps/web/src/routes/Study.tsx` | 只选第一个 pending 项作为当前题，已有输入框和图片流程 | 引入 selectedItemId、题组视图、问老师/回答本题意图 |
| `apps/web/src/routes/Mistakes.tsx` | 状态筛选、归档、详情入口 | 增加来源页签，筛选与计数由服务端统一完成 |

表中 `modules/` 均相对 `apps/server/src/`。这些是静态代码证据；具体错题遗漏仍需用集成场景复现，不能把所有遗漏归因于共享题。

### 2.2 参考来源

只读参考 `/Users/nerosun/裂缝中的阳光/sxy/日常/code/nerosun-harness/nero-agent`：

- `docs/superpowers/specs/2026-10-16-mobile-web-adaptation-design.md`。
- `web/src/agent/mobile/MobileInbox.tsx`、`MobileComposerDock.tsx`、`useMobileLayout.ts`、`mobile.css`。

借鉴独立首页、快捷卡片、最近会话、上下分区和胶囊输入框。参考代码是交互依据，不作为运行时依赖；不修改参考仓库，不复制其模型、调度等无关功能。

### 2.3 方案比较

1. 只调提示词和 CSS：改动少，但不能保证题型配额、题号归属、交卷去重与错题可靠同步。
2. **采用：现有会话上增加结构化题组与作答流程。** 保留自由辅导，由后端控制选题、提交、判题和错题事实；三端共享状态、适配布局。
3. 另建完整考试系统：适合严格计时和复杂试卷，但超出日常学习目标，重复已有任务/会话/评估能力。

用户已确认第 2 项的总体方案。以下细节是为落地而确定的默认值，实施中不得自行替换为不同产品行为。

## 3. 三端交互

### 3.1 手机首页

优先顺序为：未完成任务的“继续上次学习”卡片；每日五题/错题复习/拍照问老师/知识点巩固四个入口；最近学习；底部自由提问输入框。没有进行中任务时不展示虚构进度。最近列表复用现有任务数据，不创建另一套会话来源。

全局底部导航保留学习、错题、资料、记录、我的。进入 `/study/:id` 后隐藏全局底部导航，顶部返回恢复入口页面；不额外叠加第二条学习页顶栏。

### 3.2 手机学习页

```text
返回  每日五题                       更多
逐题练习 ▾    第 2/5 题    已提交 1 · 待批改 0
──────────────────────────────────────
当前题卡（题型、题干、选项或空位）
该题作答记录 / 老师反馈
历史内容（独立滚动，可上翻）
──────────────────────────────────────
给个提示 / 补充步骤 / 完成后的再来五题
回答第 2 题 ▾           可切换“问老师”
[ +  写下答案或步骤……               ↑ ]
```

- 当前题默认展开；长讨论时可主动收起为摘要，点击恢复。换题时展开新题。
- 更多操作含暂停保存、切换模式、结束本组。结束本组遵循第 6 节，不绕过判题或未答确认。
- 回答本题和问老师有可见的意图标记；问老师不创建 attempt，不推进正式进度。
- 输入框单行呈胶囊，多行自然增高，正文最多约 5 行后输入框内部滚动；附件另占上下文条。
- 加号打开拍照/相册/文件来源底部弹层，复用已配置的上传能力；未启用时显示真实恢复说明。
- 根容器使用 dvh 和安全区；键盘适配以 visualViewport 为增强，避免同时计算两遍键盘高度。消息区底部留白跟随实际 dock 高度。
- 用户在底部时跟随新内容；上翻后显示“有新回复”，不强拉回底部。
- 长公式/表格局部滚动；不使用全局 overflow-x:hidden 掩盖布局溢出。

### 3.3 Pad 与 PC

| 设备 | 首次推荐 | 布局 | 输入 |
|---|---|---|---|
| 手机 | 逐题 | 单列，整组模式配可展开答题导航 | 点选、分空输入、步骤或拍照 |
| Pad 竖屏/分屏窄窗 | 整组 | 单列题卡，轻量题号条 | 触控与键盘均可 |
| Pad 横屏且可用宽度足够 | 整组 | 题目区与作答/辅导区双栏 | 键盘、纸笔拍照 |
| PC | 整组 | 左侧题目/题号导航，右侧答题和辅导 | 点选、键盘、粘贴或拖入图片 |

双栏要求两侧分别至少 320px、400px，空间不够则退回单列。不根据 UA 锁定布局；旋转、分屏和浏览器缩放不触发重新组题。首次推荐只在没有个人偏好时使用，用户选择后保存到服务端。

桌面普通文字 Enter 发送、Shift+Enter 换行；触控输入 Enter 换行，点击发送。中文输入法确认候选字不触发提交。题卡内按钮支持键盘操作，不拦截浏览器通用快捷键。

## 4. 题型与组题

### 4.1 题型契约

新增 `questionType: single_choice | multiple_choice | fill_blank | worked | legacy`。legacy 仅兼容历史未知题型，不参与新的混合题型配额。

新增公开 `presentation` 与私有 `answerSpec`，禁止把整份参考答案放入学生 DTO：

| 题型 | 学生可见 presentation | 服务端 answerSpec |
|---|---|---|
| 单选 | 稳定 optionId、中文选项，2～6 项 | 唯一正确 optionId，choice |
| 多选 | 稳定 optionId、多选提示，2～6 项 | 非空正确 optionId 集合，按集合精确匹配；首版无部分得分 |
| 填空 | 1～6 个稳定 blankId，按空输入 | 每空校验类型 number/expression/text、答案及等价规则 |
| 解答 | 解题要求、可提交步骤与图片 | requiresWorking、评分要点、参考答案与核验策略 |

旧 answerType 保留兼容，不能拿它替代 questionType。表达式不通过任意 JavaScript eval 求值；没有可靠符号等价能力时走受控模型核验，证据不足返回待核验。解答题参考答案不能用两段文字完全相等作为唯一核验标准，必须校验关键条件与评分要点；失败不发布。

选择题选项以稳定 ID 提交；显示 A/B/C 标签不影响原始 ID。多空题逐空归属。图片答案由独立核验读取附件，OCR 不可读时邀请补证据。

### 4.2 智能混合

默认五题蓝图为 `2 single_choice + 2 fill_blank + 1 worked`，策略版本 `mixed-v1`。多选首版支持，但仅在匹配的考试配置或明确题型设置中出现，不改变上述默认组合。

组题优先级：

1. 已确认学习范围、发布状态、权限、前置知识与题目质量。
2. 既有自适应规则给出的目标与难度；没有画像时使用真实已确认范围，不编造薄弱点。
3. 本组题型配额与至少三种题型的默认目标。
4. 最近练习去重与模板分散，同组相同题目不重复，连续相同题型尽量不超过两题。

学习范围未知返回 `awaiting_scope`，先在会话确认范围。受限知识点不适合三类题时返回有原因的 `insufficient_pool`，提供调整范围或采用明确展示的替代组合；须经学生选择后产生新蓝图，不能静默换题型。

优先选已发布且当前可用的核验题；不足时使用已有生成管道，补齐缺失槽位。每槽候选最多两次，整组最多十次候选尝试；按现有低并发队列运行，不同时发起五路模型调用。失败只重试空缺槽位，已核验槽位保持稳定。

### 4.3 考试结构

配置包含 `profileId/version/title/scopeDescription/sourceNote/weights/supportedTypes`。第一版使用版本化配置文件；没有真实对应考试的配置时不提供该选项，不编造官方比例。配置属于工程维护，不建设专用后台。

五题配额使用最大余数法：权重归一化后乘 5、先取整，再按余数从大到小补足；同余数使用固定题型顺序 `single_choice,multiple_choice,fill_blank,worked`。只对配置支持的题型分配；考试模式不再额外强制三种，以免破坏所选比例。

五题必然存在取整误差，UI 展示本组真实组成和配置名称/版本。多组累计偏差优化留待后续，本轮不声称五题等同完整试卷。

### 4.4 统一题组协调器

新 `PracticeSetService` 是每日五题唯一创建和补题入口；Agent 的 propose_practice、next_practice 在题组任务中必须调用协调器或读取已分配槽位，不能继续直接追加 task_items。诊断微题不占正式五题槽位，记录在原有教学动作/诊断流程，不混入本组交卷统计。

一 task 对应一 practice_set，五个正式槽位 position 为 0～4。逐题和整组使用同一蓝图，逐题可以提前准备后续题目，但不能提前向客户端发送参考答案。生成状态和作答模式互相独立。

## 5. 数据模型与共享 DTO

### 5.1 增量存储

| 位置 | 字段/表 | 约束 |
|---|---|---|
| question_versions | question_type、presentation、answer_spec、language_status、language_policy_version | 历史默认 legacy/unchecked；私有 answer_spec 不进入学生列表 |
| practice_sets | task_id、mode、strategy、exam_profile_id/version、policy_version、seed、scope_snapshot、blueprint、generation_status、submission_status、previous_set_id、version | task_id 唯一；范围与蓝图快照不可被历史配置更新重写 |
| practice_set_slots | set_id、position、question_type、task_item_id、state、reason_code | (set_id,position) 唯一；task_item_id 唯一且可空；固定五槽 |
| practice_answer_drafts | student_id、task_item_id、payload、version、updated_at | (student_id,task_item_id) 唯一；乐观锁；附件只保存 fileId |
| practice_submissions | set_id、request_key、payload_hash、state、created_at | (set_id,request_key) 唯一；相同键不同内容报冲突 |
| practice_submission_items | submission_id、task_item_id、attempt_id、state、reason_code | (submission_id,task_item_id) 唯一；每题独立重试 |
| student_practice_preferences | student_id、mode、strategy、exam_profile_id、version | student_id 唯一；宽度变化不覆盖显式偏好 |
| student_mistakes | origin_category、origin_detail、origin_task_id、origin_conversation_id、origin_message_version_id、origin_question_version_id、provenance | category 为 uploaded/learning/unknown；保留首次证据 |

origin_category 是错题首次收录来源，origin_detail 取 material_import/daily_practice/knowledge_consolidation/free_question/mistake_review/unknown。后续来源出现在错题事件中，不覆盖首次来源。同题即使同时存在上传和练习经历，主体仍按现有 (student_id,question_id) 去重。

scope_snapshot 保存已确认知识点 ID/内容版本、范围说明及确认依据引用，不复制整份聊天或教材；它用于组题回放和下一组范围继承。旧任务转换时无法可靠确定范围，则先进入 awaiting_scope。

题目查询使用明确字段投影，不能 SELECT * 后直接返回 answer_spec。对外问题、学生作答、参考答案三者分开序列化。已交卷后解析通过鉴权结果接口读取；提前求助通过现有暴露跟踪记录。

### 5.2 核心类型

契约统一放在 `packages/contracts/src/practice-sets.ts`、`question-presentation.ts`、`mistakes.ts`，由 Zod schema 推导，不在前后端重复定义枚举。

```ts
type PracticeMode = "step" | "batch";
type PracticeStrategy = "mixed" | "exam";
type QuestionType = "single_choice" | "multiple_choice" | "fill_blank" | "worked" | "legacy";
type AnswerPayload =
  | { kind: "choice"; optionIds: string[] }
  | { kind: "blanks"; values: { blankId: string; value: string }[] }
  | { kind: "worked"; text: string; attachmentIds: string[] };
type PracticeItemProgress = {
  itemId: string;
  submission: "unanswered" | "submitted" | "skipped";
  grading: "none" | "queued" | "running" | "verified" | "pending" | "failed";
  correctness: "correct" | "incorrect" | "uncertain" | null;
  mistakeSync: "not_required" | "queued" | "synced" | "failed";
};
type PracticeSetDTO = {
  id: string; taskId: string; version: number;
  mode: PracticeMode; strategy: PracticeStrategy;
  generation: "awaiting_scope" | "preparing" | "ready" | "insufficient_pool" | "failed";
  submission: "open" | "grading" | "needs_review" | "completed";
  counts: { total: 5; submitted: number; skipped: number; verified: number; pending: number };
  canContinue: boolean;
  items: PracticeItemDTO[];
};
```

`PracticeItemDTO` 为 slotId、position、questionType、nullable itemId/questionVersionId、公开 stem/presentation、progress、nullable reasonCode 的组合。未生成槽位不伪造题目内容。参考答案、rubric、私有证据和其他学生答案不属于该类型。

## 6. 作答、状态与完成判定

### 6.1 两种模式

逐题：默认展示最早未处理题，也允许通过题号返回；选择题和填空题在题卡提交，解答题使用 composer。提交后显示批改状态，允许查看反馈后继续。

整组：展示全部已核验题卡、独立答案草稿和题号导航；默认交卷后反馈。提交本组时有空题则弹窗明确列出未答题号，学生选择继续作答或确认跳过后交卷。有 pending grading/failed 的题不显示整组已完成。

切换模式仅改变展示与 mode，不重新抽题、不清空草稿、不撤销提交、不隐藏已有解析。batch 切 step 可以查看已提交结果；step 切 batch 时已曝光题继续标提示参与。

### 6.2 提交与草稿

- 草稿使用结构化 AnswerPayload；选项/空位必须属于题目版本，图片必须属于学生且可绑定当前任务。
- 每次编辑立即保存到按 studentId/taskId/itemId 隔离的 sessionStorage 恢复缓冲，800ms 防抖保存服务端；不存图片二进制或签名 URL。退出登录清理缓冲，提交成功清理对应草稿。
- 恢复时以服务端 version 为基准，冲突明确提示，不能用旧标签页覆盖新答案。sessionStorage 只用于同标签页断线/刷新恢复，不承诺未同步内容跨设备可见。
- 切换题号时保留原题草稿与附件；切换“问老师”另存咨询文本，不能把答案草稿发成咨询或相反。
- 每次正式提交生成稳定 requestKey；断线重试复用，同键同内容返回原结果，同键异内容 409。
- 批量提交先在一个短事务内验证并保存所有正式作答、附件绑定、计时边界及判题任务；模型调用不放在数据库事务中。一个结构/授权错误使整次请求回滚；入队后的单题模型失败不回滚其他已提交题。
- 兼容现有 attempt.answer 原始文本与 message_version：结构化答案另存规范 payload，学生可见文本由确定性 serializer 生成；文字/图片证据不可用参考答案替换。

### 6.3 计时

只对当前选中且学生主动开始的题目启用现有 episode。整组五题同时可见不代表五个计时器同时运行。切题暂停旧题、按现有 lease 规则开始/恢复新题；等待批改不算作答时间。整组先浏览再开始计时的题标 priorExposure。不回填历史用时，不从草稿更新时间推算真实解题时间。

### 6.4 完成规则

保留 task_items.status 兼容已有记录，但新 UI 使用 PracticeItemProgress，不能只依赖 answered。

- verified correct/incorrect 是判定落定；pending 是待核验，failed 是可重试失败，均阻止自动完成。
- 允许显式跳过；跳过不算答对，不触发错题入库。
- 五槽均已生成；每题已跳过或存在当前有效 verified 评估；所有应入库错误已 synced 后，题组完成，task 状态同步 completed。
- 有待核验显示 needs_review；学生可暂停离开，不能伪装为已完成。失败有明确重试入口。
- 原题订正不回写第一次提交正确性，小结区分首答与订正。
- 使用已有 summary job 生成文字总结；小结等待不阻塞 canContinue，结构化计数立即可见。

完成后保留轻量咨询 composer，默认“问老师”；在其上方展示“再来五题”“复习本组错题”“查看学习小结”。完成任务的咨询不重新激活正式五题任务，不创建第六道作答。

### 6.5 再来五题

`continue` 创建关联的新 task/set/conversation，继承范围、mode、strategy 和有效考试配置；排除上一组题目，并按现有最近决策窗口减少重复模板。新组有独立 ID，previous_set_id 指向上一组。新建成功后直接导航到新任务，不要求学生回首页。

锁定旧 set 并持久化继续请求的 requestKey/payloadHash/newSetId。重复请求返回同一新组；不同键的并发双击在同一个完成组上也只创建一个直接后继。该约束只限制同一组的直接后继，用户仍可通过首页主动新开其他练习。

幂等查询在 expectedVersion 校验前执行：相同键同内容的成功重试即使携带旧版本也返回原结果；相同键异内容仍报 409。不同键遇到已存在直接后继时返回该后继，不再创建。不得先因完成操作导致版本增加而把成功重试错误地拒绝。

按钮仅由 canContinue 控制，不能根据聊天中出现“做完了”显示成功。新组创建失败保留旧组和草稿，展示中文重试信息。

## 7. 中文内容策略

### 7.1 统一入口

新增 `student-language.ts`，暴露 policyVersion、统一系统规则、公开内容检查与修复接口。接入主 tutor、单题生成、重生成、模板题型转换、参考解析、自查提示及小结的学生可见字段；内部 JSON key、模型 ID、工具参数不翻译。

允许区域包括 LaTeX 公式、数学变量/函数、单位符号、代码片段和必要专名；描述性英文句子必须改为简体中文。不能用“出现任意拉丁字母”或“中文占比高”作为唯一通过条件。题目如果考查英语材料，原始引用材料作为明确标注的内容保留，中文指令和解释仍遵循规则；本轮不扩展英语学科生成。

### 7.2 生成与修复

对 stem、选项描述、解题要求、提示、解析、反馈分别检查，公式节点保护后再判断叙述语言。检测明显违规时调用一次修复；修复返回结构化内容，选项 ID、blankId、数学条件和答案不变。若发生数学条件或答案变化，视为新候选，完整重新核验，不能直接覆盖已发布题。

语言修复失败不展示违规候选：生成阶段换候选，超过槽位尝试上限返回缺题状态；反馈阶段展示固定中文恢复说明与重试入口。记录策略版本、错误码和数量，不在日志写整份私人答案。

流式正文先在服务端缓冲完整句段/结构块，保护未闭合公式，再检查后发 text_delta。单个未闭合缓冲块超过 4096 字符时进入整块检查/重试，不能无限增长或未经检查直接发布。可立即发“正在整理反馈”等状态事件，不发原始未检查 token。最终持久化正文与已发布片段一致；取消丢弃未发布缓冲。参考答案或完整解析不因语言检查分支绕过暴露登记。

### 7.3 历史内容

历史原文保留；用 `(questionVersionId, policyVersion)` 唯一的中文展示缓存保存经核验的译文，首次请求可异步整理并显示中文处理中状态。仅改变展示、公式/答案不变的缓存不重写证据；题意发生改变必须走新版本与原有失效机制。旧聊天消息不后台改写；中文规则对新输出生效。

## 8. 错题闭环与分类

### 8.1 权限与事实来源

个人题继续校验所有者；共享题必须存在当前学生合法任务项/作答，并满足现有题库可见性规则。任意 questionVersionId 不能让用户导入他人私有题。错题详情中的 attempt、message、attachment 均再次按学生校验。

会话中的自由咨询不记错。没有正式题目记录时，先把明确题干确认成该任务题目版本，学生正式提交后才评估。已提供正确参考的题干应沿用版本，不在每次聊天中创建重复题目。

### 8.2 可靠同步

所有正式作答入口共用 `AnswerSubmissionService` 入队 `learning.assess`。判题 worker 读取原始作答及参考，产生有效评估；评估写入和 `learning.mistake-sync` 入队在同一事务中提交。诊断、画像等后置处理失败不能使已写评估缺失同步事件。

错题 worker 读取最新有效评估并调用统一错题服务，按 assessmentId 幂等；每次重试重新检查最新评估和 invalidation，旧错误事件晚到不能重新打开已被改判的错题。成功后更新 mistakeSync，客户端只有读到 synced 才显示“已加入学习错题”。

当前 app.ts 的同步调用改为统一协调，不保留两套各自写库入口。对老 Agent 的 submit_assessment 工具也经过相同事务入口，已存在最终评估时返回现状，避免重复模型判题。

现有队列最多三次自动尝试，保留失败投影与手动重试入口；新任务种类必须同时接入 runner 注册、queue.fail 及 lease 耗尽路径。死信不能长期显示为“处理中”。

### 8.3 来源与页面

来源按收录路径决定，不按附件类型：资料/试卷导入收录为 uploaded；每日五题、巩固、自由会话正式练习及复习产生的新错题为 learning。拍照提交练习答案仍为 learning。同一原题复习只追加证据，不改变首次来源；已关联变式依现有规则更新原错题，不能无条件创建第二个主体。

错题页提供全部/上传错题/学习错题；历史 unknown 包含在全部，并显示“来源待确认”。状态、归档与来源筛选组合使用。服务端分页并返回筛选总数和来源计数，不能只在现有 LIMIT 100 结果中本地筛选。

详情展示题干、原始答案/图片、首次判错、来源任务/会话/消息、历次订正、错因（可待确认）和复习时间。保留原有 pending_correction/correcting/consolidated/mastered 规则，独立变式和延迟复习晋级门槛不降低。

### 8.4 改判与历史补齐

改判由最新有效评估重建状态；原错误证据失效后，若无其他有效错误，错题标记已撤销并从默认待订正列表移出，历史仍可查看。新增 lifecycle `active | revoked` 与掌握 status 分开，避免把错误改判冒充“已掌握”。后续新有效错误可重新激活。

补齐脚本支持 dry-run、studentId、游标与批次，默认只预览；实际写入需显式 apply。仅处理存在合法题目版本、合法学生作答和最新有效 verified incorrect 的记录。来源由 material/task 证据推断，不确定保留 unknown。同键重复运行不重复主体和事件，不从自然语言“你做错了”反推评估，不回填耗时。

## 9. API 约定

沿用现有 student-scoped 路由前缀，下面路径表示其内部相对路径。所有突变需要 requestKey 或 expectedVersion，学生 ID 来自授权 scope。

| 方法与路径 | 输入 | 输出/行为 |
|---|---|---|
| `POST /api/tasks/:id/practice-set` | requestKey、mode、strategy、可选 examProfileId | 202/200 PracticeSetDTO；范围未知返回 awaiting_scope |
| `GET /api/tasks/:id/practice-set` | 无 | PracticeSetDTO；不含私有答案 |
| `PATCH /api/practice-sets/:id` | expectedVersion、mode | 更新视图模式；不重新抽题 |
| `POST /api/practice-sets/:id/retry-generation` | requestKey、expectedVersion | 仅重新安排空缺槽位 |
| `PUT /api/practice-sets/:id/drafts/:itemId` | expectedVersion、answer | 服务端草稿 version；冲突 409 |
| `GET /api/practice-sets/:id/drafts` | 无 | 当前学生草稿 |
| `POST /api/practice-sets/:id/submit` | requestKey、expectedVersion、entries、skippedItemIds、finalize | 202 SubmissionDTO；逐题 finalize=false，交卷 true |
| `POST /api/practice-submissions/:id/retry` | requestKey、itemIds | 重试失败/待核验项；不重建其他 attempt |
| `GET /api/practice-submissions/:id` | 无 | SubmissionDTO 与各题进度 |
| `GET /api/practice-sets/:id/results` | 无 | 已允许查看的正式结果/解析；batch 未交卷不泄露 |
| `POST /api/practice-sets/:id/continue` | requestKey、expectedVersion | 已完成组的唯一直接后继 taskId/setId/conversationId |
| `GET/PATCH /api/practice-preferences` | PATCH 含 expectedVersion 与偏好 | PreferencesDTO |
| `GET /api/practice-exam-profiles` | 无 | 当前可用配置的公开摘要 |
| `GET /api/mistakes` | origin、status、includeArchived、page、pageSize | 新客户端请求分页格式；旧无分页调用保留数组兼容 |

`SubmissionDTO` 固定含 id/setId/state/items，items 使用 PracticeItemProgress。finalize=true 时 entries 与 skippedItemIds 必须覆盖尚未处理槽位且不能交叉；已提交题引用既有结果，不能重复创建 attempt。修改正式答案作为新的订正请求，保留前次证据。

标准错误：400/422 为结构或状态验证，404 隐藏越权资源，409 为版本/幂等内容冲突，503 为暂不可用。模型未配置、队列失败、题源不足均返回中文可恢复信息。

## 10. 兼容、发布与回滚

- 新迁移编号在实施时检查；编写本文时最新为 0029。历史题保持 legacy，旧每日任务不自动追加/重抽，主动转换时保留现有 task_items 并只填空缺槽位。
- 历史已完成任务不因没有新字段被重新判为未完成；新完成规则只作用于已建立 practice_set 的任务。
- 移动布局不改变 URL；现有学习记录、管理端只读回放、资料与错题复习继续可用。
- 新能力分为 `practiceSetsEnabled`、`mobileStudyEnabled` 两个开关，初始 false。中文规则与错题可靠性修复属于基础行为，可独立发布。
- 关闭题组开关只阻止新建题组；已创建题组仍允许读取、提交、重试和完成，不能丢失进行中的学习。
- 发布顺序：增量 schema/后端兼容 → 错题补齐预览 → 中文与错题修复 → 题组小范围启用 → 三端 UI → 扩大范围。
- 回滚用关闭新建与布局开关完成；保留表、证据和继续消费既有判题/错题任务，不删除新增数据。
- 观测 queued/running/failed、有效判错未同步数量、题型缺口、语言拒绝/修复次数、组题耗时；仅记录 ID、错误码与汇总，不记录敏感正文。

## 11. 验收矩阵

| 场景 | 必须结果 |
|---|---|
| 320/390/430px 手机与键盘开合 | 输入、题卡和发送可用，整页无横向溢出，dock 不遮挡最后一条消息 |
| Pad 横竖屏、分屏、PC 缩放 | 布局自适应，草稿/题号/提示状态不重置 |
| 智能混合题源充分 | 恰好五槽、2 单选 2 填空 1 解答，无同组重复题 |
| 题源不足/模型中断/任务租约耗尽 | 明确缺口/失败，能补缺；已有题稳定，无永久处理中 |
| 考试权重非整数/配置失效 | 总数恰好 5，规则可回放；失效配置不静默冒充有效 |
| 双击提交、超时重试、两个标签页 | 同请求同作答，异内容冲突，无重复 attempt/错题/后继组 |
| 已提交但批改未完成 | 不显示完成，不提前出现可用再来五题 |
| 整组跳过/部分失败/提示参与 | 明确展示统计，失败只重试相关题，独立性证据正确 |
| 原始流含英文、跨 chunk 公式与取消 | 未检查英文不泄露；sin/cos/x/y 与公式不损坏 |
| 共享题判错、照片作答、自由咨询 | 合法共享题能入学习错题；照片不改变来源；咨询不记作答 |
| 学生 A 猜测学生 B 的 ID/附件/草稿 | 全部拒绝；公开题 DTO 无参考答案泄露 |
| 旧错误事件晚到、改判、脚本重跑 | 最新有效结论优先，撤销可追踪，不重复主体和事件 |
| 数据库迁移与开关回退 | 历史任务可读，既有题组可完成，旧记录/管理只读视图正常 |

真实 iOS Safari、Android Chrome 至少各检查一次软键盘和拍照流程；桌面浏览器模拟只作为补充，不能宣称覆盖真实键盘行为。每项验收在配套计划中有对应任务，缺少环境的检查如实列为未执行。

## 12. 实施记录（2026-11-15）

代码已按配套计划落地到 `feat/mobile-mixed-practice` 的后续工作分支：契约与迁移 `0030_mobile_mixed_practice`、错题权限/同步/补齐、中文边界、结构化题型、mixed-v1 蓝图、题组协调器、提交与进度、偏好与 API、逐题/整组 UI、三端学习壳、错题来源页签与运行手册。`practiceSetsEnabled` 与 `mobileStudyEnabled` 仍默认 false。独立 `_test` PostgreSQL 上已跑通 typecheck、lint、unit、integration、build 与 Playwright e2e；真实 iOS Safari / Android Chrome 真机检查未执行。
