# 管理员学生学情中心设计（第一期、第二期合并）

- 日期：2026-11-10
- 状态：方案已确认，详细设计与实施计划待评审；本文不代表功能已经实现。
- 范围：学生总览、学生档案、学习记录、错题、作业/试卷、日活跃度、可追溯 AI 分析，一次交付。
- 用户确认：采用独立管理员菜单，第一期与第二期一起规划。
- 设计默认：管理员可查看全体学生；只提供查看、附件预览、生成/重试 AI 报告，不代学生修改学习数据。此项由方案默认延续，实施前可在评审中调整。

## 1. 目标与边界

管理员能够回答：哪些学生在学习、学了什么、哪里有困难、错题是否持续订正、作业和试卷有哪些记录、接下来如何帮助该学生。每个指标有统一口径，每个 AI 主要结论能回到原始证据。

本次不做教师布置作业、截止日期、催交、正式阅卷评分、班级/组织管理、学生排名、自动干预、批量 AI 报告、导出以及估算学习时长。作业和试卷指当前系统已上传的资料；不等同于完整作业流程或标准化考试。

验收底线：学生不能打开管理员页面或读取管理员接口；管理员查看不产生学生学习行为；缺失数据不显示为零分；后台报告失败不阻断基础查询。

## 2. 现状与方案选择

### 2.1 已核对的实现

| 能力 | 当前文件 | 本次关系 |
|---|---|---|
| 登录和角色 | `apps/server/src/modules/auth/{routes,policy,service}.ts` | 复用会话与 requireAdmin |
| 学生档案和授权 | `packages/db/src/schema/auth.ts` | student_profiles 与 student_access；管理员目前也须显式授权才能访问普通学生接口 |
| 学习任务 | `packages/db/src/schema/learning.ts` | task kind、状态、题目、软删除 |
| 作答/对话/提示 | `packages/db/src/schema/conversations.ts` | 复用原始记录与版本 |
| 核验和证据失效 | assessments、evidence_invalidations | 统计仅用有效证据及对应核验 |
| 错题生命周期 | `packages/db/src/schema/mistakes.ts` | 当前状态及状态事件 |
| 资料及来源 | `packages/db/src/schema/materials.ts` | type 包含 homework/exam/mistake/other；题目来源可关联 extraction/page |
| 知识点和任务小结 | `packages/db/src/schema/knowledge.ts` | 复用有效事实；不把单任务小结直接当学生级报告 |
| 后台执行 | `apps/server/src/jobs/{queue,runner}.ts` | 现有租约 30 秒、每 10 秒续约、最多 3 次尝试、失败 10 秒后再试 |
| 页面/导航 | `apps/web/src/App.tsx`、`components/AppShell.tsx` | 新增统一管理员路由守卫及导航 |
| 下载 | `apps/server/src/modules/uploads/service.ts` | 当前 authorize 同时用于读和上传完成，禁止直接增加管理员全局放行 |

当前工作区已有大量未提交的其他功能改动。执行计划须保留它们，不重置、不覆盖，不假定迁移编号与本设计编写时一致。

### 2.2 备选与决定

1. 账号管理附带详情：改动较少，但学情与账号操作耦合，趋势、证据和报告难组织。
2. 独立学生学情模块（采用）：复用原始事实，建立管理员专用只读 API；统一学情档案与报告，便于增量建设。
3. 独立数仓/分析平台：适合跨组织大规模报表，目前引入成本不匹配。

部署仍使用现有 React/Fastify/PostgreSQL/Drizzle、ModelGateway、JobQueue；不新增基础设施与运行依赖。

## 3. 权限与数据边界

### 3.1 访问规则

- 所有 `/api/admin/student-insights/**` 请求先 requireSession，再 requireAdmin，随后解析筛选条件及执行查询。
- 无会话 401；学生 403；合法管理员查询不存在或与路径学生不匹配的资源 404；参数无效 422。
- 路径中的 studentId 是唯一学生范围；query/body 禁止额外 studentId 覆盖。
- 服务公开入口也验证管理员身份，防止绕过路由直接调用服务。后台任务仅消费数据库中已授权创建的 reportId，不接受任意用户输入的学生范围。
- 不改变 requireStudentAccess，不新增 student_access 记录，不将管理员伪装成学生或 owner。
- 所有题目、作答、核验、消息、资料和文件查询先锚定 studentId，再做 JOIN；不得仅按资源 UUID 取数据。
- 分页、统计与报告均排除软删除任务；已失效的证据不参与表现指标。历史报告保留生成时快照，但失效证据重新打开时返回不可用，不复活旧记录。

### 3.2 附件只读授权

新增管理员专用文件下载入口。文件须归属路径学生，且由该学生的可见资料或可见消息附件引用，status=ready。返回现有 FileStore 300 秒签名 URL，响应不暴露 object_key。孤立文件、其他学生文件和已隐藏记录的附件均 404。

不要放宽 UploadService.authorize；不能因此获得 complete、上传、修改或删除权限。复用签名逻辑可提取纯签名帮助方法，权限仍在管理员服务内。

### 3.3 审计

复用 audit_events。记录学生详情打开、文件签名、报告创建、手动重试；记录 actorId、studentId、资源 ID、筛选范围、requestId，不记录完整答案、对话文本或签名 URL。轮询、列表翻页不重复记录详情访问；详情接口每次实际打开记录一次。仅记录审计不计入学习活跃。

## 4. 页面和交互

### 4.1 路由

- `/admin/students`：学生总览。
- `/admin/students/:studentId/overview`：默认档案页；裸详情地址重定向到 overview。
- 同层 `records`、`mistakes`、`materials`、`activity`、`analysis` 六个页签。
- 记录详情：`records/:taskId`；错题：`mistakes/:mistakeId`；资料：`materials/:materialId`；报告：`analysis/:reportId`。均保留管理员外壳和学生范围，不跳到可写的学生辅导界面。
- 总览筛选和详情筛选写入 URL；返回列表保留筛选、页码；切换学生必须清空上一学生的数据与轮询。
- AppShell 仅管理员显示“学生学情”；RequireAdmin 覆盖 `/admin/*`，现有教材/账号页兼容原有内部角色检查。

### 4.2 全体总览

顶部：已建档学生数、区间学习活跃人数、区间作答次数、区间新增错题数。账号未激活且未建档的不计入学生数；未学习的已建档学生必须出现。

列表：姓名、关联学生账号（可能多个，仅展示 role=student 的账号）、最近学习时间、区间活跃天数、作答题数/次数、首次正确率及样本量、当前待订正/待复习数、区间任务完成率、关注原因、查看与分析按钮。

筛选：姓名/账号搜索（最多 80 字）、教材 revisionId、7/30 天或自定义日期、关注类型。默认近 30 天；支持按最近学习时间、活跃天数、首次正确率排序，空值最后，studentId 为稳定次序。分页默认 20，最大 50；total 与列表采用同一过滤条件。

关注规则 v1：已建档满 7 天且最近 7 个自然日无有效学习行为；当前待订正数 >=10。展示触发数字，不生成综合分或学生排名。教材筛选只改变学习数据范围，不隐藏无该教材学习记录的学生。

### 4.3 学生详情

顶部：姓名、关联学生账号、注册/建档时间、统一筛选、数据截止时间和“AI 分析”。

| 页签 | 内容 |
|---|---|
| 概览 | 核心指标、每日作答/正确率趋势、任务进度、当前错题状态、知识点证据样本 |
| 学习记录 | 任务列表及状态、创建/更新时间；只读详情含任务题目、用户回答、提示、核验、对话及图片 |
| 错题 | 教材/章节/知识点/状态过滤；原始错误、订正、复习、巩固事件及对应有效证据 |
| 作业与试卷 | type 默认 homework+exam，可切全部资料；展示原件、解析状态、识别题目、已关联作答；重复题目关联去重 |
| 活跃 | 逐日日历、学习行为量、活跃天数、当前连续学习天数、最长连续天数；访问活跃单列 |
| AI 分析 | 生成入口、历史报告、状态、范围、截止时间、结论证据、手动重试 |

资料没有标准化分值时，展示可核验的题目表现与覆盖率，不生成整卷成绩。不存在直接 material-task 外键，使用 question_sources → question_versions → task_items/attempts 关联，显示为“关联学习记录”，不声称一一对应。

空值文案：无数据“暂无学习记录”；分母为零“暂无可核验样本”；历史访问“此日期尚未采集访问数据”；样本少“样本有限，仅供观察”。错误支持原位置重试；详情不存在显示 404；学生角色显示无权限且不发学情请求。

遵守现有 DESIGN.md、现有组件和字体/颜色；移动端列表改卡片、页签可横滚，图表有数字替代和键盘可用入口。初版用原生 SVG/现有组件做趋势和日历，不引入图表依赖。本次文档不锁定新视觉风格或提供高保真原型。

## 5. 统计规范 v1（metricVersion=student-insights-v1）

### 5.1 时间和数据一致性

- 所有页面日期统一按 Asia/Shanghai 解释，显示该时区；暂不按学生 profile.timezone 混合展示。
- API from/to 为 YYYY-MM-DD，均含当日；后端转换为 [from 当日零点, to 次日零点) UTC 边界。
- 范围 1–366 天；to 不超过上海今日，from<=to；默认上海今日及之前 29 天。无效日期、UUID、枚举或 sort 返回 422。
- 统计响应包含 from/to/timezone/dataAsOf/metricVersion/coverage。多查询使用同一个只读 REPEATABLE READ 事务，避免一张卡片与同响应列表统计读取不同状态。
- 趋势补齐无行为日期为 0；分母为零的比率为 null；比率传 0–1，页面按百分比展示。
- 列表当前错题存量与区间新增量明确分列；“当前”表示本次 dataAsOf 的有效状态，非历史期末快照。

### 5.2 指标定义

| 指标 | 精确定义 |
|---|---|
| 作答次数 | 区间内有效 attempts 行数，排除软删除任务及 evidence_invalidations 指向该题目版本/消息版本的证据 |
| 作答题数 | 上述记录按 question_id 去重；同时保留次数，避免把重做当新题 |
| 首次正确率 | 按 studentId+question_id 选全历史首次有效 attempt（created_at,id 升序），再判断该首次发生于区间且符合教材；该 attempt 的最新有效 assessment 中 verified 且 correct/incorrect 构成分母，correct 为分子；pending/unknown 单列 |
| 作答趋势 | 每日有效作答次数、去重题数、首次正确率及分子/分母 |
| 提示依赖 | 使用已有 hintDependency 和 hints 事实展示分类及样本；不自行折算能力分 |
| 区间任务完成率 | 区间创建且未删除任务中，dataAsOf 时 status=completed 的任务数/任务总数；完成可以发生在区间外，标签注明“本期创建任务当前完成率” |
| 新增错题 | 区间创建的 student_mistakes，按题去重，不把重复状态事件计新增 |
| 当前错题存量 | student_mistakes 当前真实状态分别计数，未知状态不得强行映射已掌握 |
| 知识点表现 | 有效 knowledge_observations/assessments 聚合，展示作答与核验样本、提示依赖；knowledgeStates 只作为当前摘要且不能直接混进历史趋势 |
| 最近学习 | 有效学习事件最大 occurredAt；不是 task.updatedAt 或管理员访问时间 |
| 学习活跃天数 | 区间内至少有一次有效学习事件的上海自然日去重数 |
| 每日学习活跃人数 | 每日有有效学习事件的 studentId 去重数 |
| 当前连续天数 | 以今日有活动则从今日起，否则从昨日起倒数连续活动日；今日/昨日均无则 0 |
| 最长连续天数 | 所选区间内连续学习日期最长长度，不向区间外延伸 |
| 访问活跃 | 上线采集日起，学生在应用前台打开/恢复页面时的访问事件；登录成功但未进入页面不计学习 |

同一 assessment 最新版本按 created_at DESC,id DESC，必须排除失效评估证据。删改/核验变化后的历史指标按当前有效证据重算，不声称是不可变的历史成绩。

### 5.3 学习行为范围与回填

有效学习事件 v1：`answer_submitted`、`learning_message_sent`、`material_submitted`。订正和复习作答沿用 answer_submitted，通过 task kind 展示分类，不重复计数。资料只有成功创建 materials 记录才算，不以预签名或文件上传中计数。消息仅 role=user 且由 student 角色本人新建时采集，编辑/重新生成不增加事件；assistant/system、后台和管理员操作不采集。学生角色对其他学生的操作也不得计入：必须验证其 owner 身份。

事件只供活跃/行为量；正确率仍读有效作答核验原表。行为活跃历史允许保留曾发生的提交事实，页面题目表现会随证据失效改变。已软删除任务的事件不参与学情视图；物理删除来源后事件仍保留审计性事实，但不参与指标。

历史回填：attempts、user messages、materials 的 createdAt 可回填，统一 source 键保证与上线事件去重。旧数据没有可靠操作者身份，sourceOrigin=historical_inferred，覆盖说明标为“历史有效学习记录推算，可能包含代操作”；不得称其为精确学生行为。历史访问数据不可回填。首次部署采集前，在新增的 `student_insight_collection_state` 单例表持久化 learning_started_at、visits_started_at；服务启动必须先完成初始化，所有实例读取同一切换时间。历史回填只扫描 occurredAt < learning_started_at 的来源，即使管理员要求更晚的 to 也须截断；切换时间后的记录只靠实时事务采集，防止管理员代操作被回填重新计入。上线时间不是回填脚本启动时间，不能随重启修改。回填运行期间 coverage=partial，完成后记录起止范围及版本；不将未回填区间误报为无活跃。

## 6. 数据结构与查询

新增 `packages/db/src/schema/student-insights.ts`，沿用现有直接导入 schema 的方式；当前 client 未聚合 schema，不为本功能额外重构出口；迁移取执行时下一个编号，不覆盖当前 0014–0017 或其他工作内容。

### 6.1 student_learning_events

字段：id uuid PK、student_id FK、actor_id nullable FK、event_type text CHECK、source_type text CHECK、source_id uuid、task_id nullable FK、revision_id nullable FK、occurred_at timestamptz、source_origin text（live/historical_inferred）、created_at。

唯一键 `(student_id,event_type,source_type,source_id)`；索引 `(student_id,occurred_at DESC)`、`(occurred_at,student_id)`、`(student_id,revision_id,occurred_at)`。无答案/对话正文。业务事务中写入，重复业务请求 ON CONFLICT DO NOTHING。消息与作答可各产生一个不同类型事件；活跃日/人数去重，不把事件数量称为作答量。

访问事件不写此表，避免高频事件污染学习行为。

### 6.2 student_daily_visits

`student_id, local_date, timezone` 联合主键；first_seen_at、last_seen_at。POST 学生访问接口从会话解析本人学生，只允许 student owner，body 不接受 studentId/occurredAt。服务端时钟归日，UPSERT；同日多标签去重。前端最多每 5 分钟一次，只在 visibilityState=visible 的挂载或恢复时发送；失败静默，不阻断学习。管理员不发送；该数据仅表达访问，不表达时长。

### 6.3 student_insight_reports

字段：id、student_id、requested_by、from_date、to_date、timezone、revision_id nullable、metric_version、prompt_version、snapshot_hash、snapshot jsonb、evidence_catalog jsonb、content jsonb nullable、status（queued/running/completed/failed）、job_id nullable FK、generation int、model nullable、error_code nullable、created_at、started_at、completed_at。

snapshot 是创建报告事务内冻结的结构化事实；evidence_catalog 为有限的服务端可引用证据目录，含 kind/id/versionId/所属学生、必要短摘要。不存全量对话。索引 `(student_id,created_at DESC,id)`；相同有效 scope+snapshot_hash+metric/promptVersion 唯一（revisionId null 必须规范化或采用 NULLS NOT DISTINCT，不能让空值绕过唯一约束）。

报告生成成功时，报告正文/status=completed 和 jobs.status=completed 必须在同一个持有 jobs 行锁且通过 token/generation 校验的事务中提交。runner 之后的 queue.finish 可幂等 no-op；重领只读取未完成 jobs，因此已保存成功不会被后续耗尽处理降级。失败重排及最终失败也在队列事务中同步对应 generation 的报告状态。报告状态由 jobs 为执行真源映射；读取 running 但 job 已终态时修复投影。重试 generation+1，新 dedupeKey，保留同一快照；数据变化则创建新报告。不覆盖其他报告历史。

### 6.4 汇总取舍

本次不新增每日学习汇总表：先用已索引事件按日聚合，减少删改/核验失效后汇总失真的风险。每日访问单独去重。若真实数据压测显示查询超标，再增可重建的投影，不改变 API/口径。这是对早期方案中“每日汇总表”的实现细化。

列表先独立聚合作答/错题/任务/事件，再按 studentId JOIN，避免一对多笛卡尔积导致重复计数。分页列表与总览不逐学生查询，禁止 N+1。账号只取 student_access 中与 student 用户的关联，不能因 viewer 管理员关联重复学生行。

## 7. API 契约

统一前缀 `/api/admin/student-insights`，所有 GET 只读；所有 JSON 使用 Zod 共享契约 `packages/contracts/src/student-insights.ts`。

公共 `InsightFilter={from,to,revisionId?}`；`PageQuery={limit=20,offset=0}`（limit 1–50，offset 非负整数）；列表返回 `{items,total,meta}`；meta 含 §5.1 字段。新增错误沿用 AppError 包装；503 表示模型/文件服务未配置，429 表示生成频率超过限额。

| 方法/相对地址 | 输入/输出 |
|---|---|
| GET `/students` | 公共过滤、q、sort、attention；返回学生列表、summary、meta |
| GET `/students/:studentId/overview` | 核心统计、趋势、知识点摘要、资料覆盖率 |
| GET `/students/:studentId/tasks` | 公共过滤、status/kind、分页；按创建时间筛选任务 |
| GET `/students/:studentId/tasks/:taskId` | 只读任务和题目；作答/对话分别分页，禁止全量消息塞入列表 |
| GET `/students/:studentId/tasks/:taskId/attempts` | 分页作答含题目、最新核验和提示 |
| GET `/students/:studentId/conversations/:conversationId/messages` | 分页当前版本消息和附件元数据；非当前失效版本不泄露 |
| GET `/students/:studentId/mistakes` | 公共过滤、chapterId/knowledgePoint/status、分页；日期筛新增，状态是当前状态 |
| GET `/students/:studentId/mistakes/:mistakeId` | 错题及最近事件；事件使用单独 events 子地址分页 |
| GET `/students/:studentId/materials` | 公共过滤、types/status、分页；日期筛资料创建时间 |
| GET `/students/:studentId/materials/:materialId` | 原件元数据、当前解析版本；题目/关联学习记录在 questions 子地址分页 |
| GET `/students/:studentId/activity` | 公共过滤；补齐每日学习事件/学习活跃/访问活跃、连续天数、覆盖说明 |
| GET `/students/:studentId/files/:fileId/download` | 验证文件归属和引用后签名，300 秒；按需请求，不在列表预签所有图片 |
| POST `/students/:studentId/reports` | body=公共过滤；返回 `{reportId,status,reused}`，新建 202、复用 200 |
| GET `/students/:studentId/reports` | 报告历史分页；不返回 snapshot 全文 |
| GET `/students/:studentId/reports/:reportId` | 状态、模型、范围、截止时间、结构化正文和有效证据元数据 |
| POST `/students/:studentId/reports/:reportId/retry` | 仅 failed 可重试；其他状态 409；模型不可用 503 |
| GET `/students/:studentId/reports/:reportId/evidence/:evidenceKey` | 服务端目录查引用并重新验证所属/删除/失效；返回内部管理员详情地址和最小证据详情 |

另有 `POST /api/learning/visit`，只记录当前 student owner 的访问，不纳入管理员路由。事件、资料正文、报告内容不接受未声明字段，所有筛选拒绝不支持的 sort/type。

## 8. AI 报告

### 8.1 事实采集与提示输入

请求时在一致性事务读取与页面同口径的事实，冻结后创建报告与 job（kind=`student.insight`，payload 仅 reportId/generation），原子提交。snapshot_hash 对规范化业务事实与证据目录计算 SHA-256，不包含请求时钟/生成时间/随机 ID，避免没有新数据也总缓存失效；事实包括核验、删除及失效后的有效状态，因此这些变化会产生新 hash。

模型只读冻结数据，不获得 SQL、工具调用、签名 URL、登录账号等信息。学生文本标为不可信证据；即便出现“忽略规则”也不能改变输出协议、学生范围或工具权限。

输入上限：最多 100 条证据（优先反复错题/订正变化/区间首尾代表样本，按稳定 ID 去重），每条摘要最多 500 字，总文本预算 30,000 字符。snapshot 保留完整汇总数和 actual/selected 样本数；超出时标注抽样，不能称模型看过全部记录。无足够核验样本时不推断掌握。

### 8.2 输出协议

`ReportContent={summary, strengths:Finding[], difficulties:Finding[], habits:Finding[], recommendations:Recommendation[], limitations:string[]}`。

`Finding={text,evidenceKeys:string[]}`；`Recommendation={text,basisEvidenceKeys:string[],priority:'high'|'medium'|'low'}`。每个主要观察必须至少一个合法 evidenceKey；无法引用的观察改为 limitations。概况的量化数字由页面从 snapshot 展示，不允许模型提供新的计数或分数。服务端 Zod 严格校验和引用白名单校验；跨学生、伪造或未知引用视为输出无效，不展示部分成功文本。

系统提示明确：不能诊断性格、心理或智力；不能把一次正确断言掌握整个知识点；不能把相关性当因果；区分观察与建议；明确样本少/抽样/历史推算。展示“AI 辅助分析，结合具体记录判断”。

### 8.3 并发、超时与恢复

- 创建及重试限制：每个管理员每 60 秒最多 3 次新生成/重试；缓存复用不计额度。以数据库事务内 actor advisory lock + 审计时间窗计数，支持多实例。
- create 命中任何同快照报告均直接返回已有状态，包括 failed，不自动重试、不扣新生成额度；失败详情提示使用 retry。retry 才增加 generation 并计入额度。
- 同快照并发请求依唯一约束只生成一个报告和一个 job；单个学生同时最多一个 queued/running 报告（事务内 student advisory lock）。若范围不同且已有活动任务，409 并返回已有 reportId。
- 生成超时 120 秒，结合 runner AbortSignal；同一 generation 自动最多尝试 3 次，沿用现有 10 秒重试间隔。重试期间前台状态 queued，显示尝试次数；第三次失败显示 failed。
- 调用模型前校验 report generation 与 job 租约；写结果时事务锁住对应 jobs 行，验证 status=running、leaseToken、leaseExpiresAt 和 generation，再保存结果。租约丢失的旧 worker 不得写入正文。
- 扩展 queue 最终租约耗尽修复逻辑，以及正常 fail 的最终状态联动；不能让报告永久 running。页面轮询不能是唯一修复机制。
- 手动 retry 保留 snapshot，generation+1 并 enqueue 新 job；想分析最新数据须发起新的生成请求。
- 未配置 gateway 返回 503 并禁用按钮、解释原因；无任何有效学习事实时 422，保留基础页且提示先积累记录。
- 前端每 3 秒轮询，离页/切换学生停止；2 分钟后降为 15 秒，直到终态或离页。刷新可恢复；不要求 SSE。

## 9. 性能、运维与数据生命周期

- API 范围最多 366 天、分页最多 50；证据与 AI 输入有硬上限。总览默认 30 天。
- 对历史大表优先补 `(student_id,created_at,id)`、tasks 的有效记录过滤索引和 assessment 的 attempt 最新版本索引；已有等价索引不重复增加。
- 性能验收在隔离测试库构造 1,000 学生/100,000 作答；记录固定环境、EXPLAIN ANALYZE、20 次预热后 100 次请求。目标本地同机基础列表/概览 p95<1秒（不含签名/模型耗时），超标先优化 SQL，不静默降低样本或截断统计。
- 回填脚本支持 --dry-run、--from、--to、--batch-size（默认 500，最大 5000）、断点与重跑；使用 source 唯一键幂等。批次事务，错误停止并保留已完成批次；记录覆盖状态。不得读取/输出 .env 凭据或正文。
- coverage 元数据独立持久化为 `student_insight_backfills`（id、version、from/to、last_source_cursor jsonb、status、updated_at）；并发只允许同版本一个执行者，session advisory lock。
- 新增表不设置自动清理学生数据；文件生命周期保持现状。报告证据打开时动态重新授权/检查，附件签名过期重新获取。
- 记录报告耗时、重试数、失败码及慢查询；日志不输出内容、签名 URL 和密钥。
- 发布：迁移 → 部署服务/前端 → 幂等回填 → 检查 coverage 和指标 → 管理员验收。无历史回填时可用但显示部分覆盖。迁移失败不开放入口。
- 回退应用保留新增表和事实数据，不执行自动 DROP；学习事件可停止写入，原有学习流程继续。

## 10. 验收矩阵

| 编号 | 必须通过 |
|---|---|
| A1 | 未登录 401；student 对每类管理员 API 403；直接 URL 无权限；学生不发管理员请求 |
| A2 | 管理员无 student_access 也可读全体学生；普通学习接口原授权仍保持；跨路径学生资源 404 |
| A3 | 管理员只读详情无 skip/submit/delete/confirm 等写操作；读取与 AI 不增加学生学习事件 |
| A4 | 软删除/失效/待核验/重复题/重复核验/多账号关联不使统计膨胀；比率为 null 时不画 0% |
| A5 | 上海午夜、闰日、跨年、空区间及连续天数口径正确；historical_inferred/partial 覆盖明确 |
| A6 | 作业/试卷原件可预览；其他学生及孤立附件被拒绝；无分值不展示总分；关联题目不重复 |
| A7 | 有效事件随业务事务提交、业务回滚无事件；幂等请求/回填不重复；管理员操作排除 |
| A8 | 报告重复点击复用；并发唯一；刷新恢复；自动/手动重试、最终租约耗尽、取消和旧 worker fencing 正确 |
| A9 | 报告与页面同口径；数字由后端；伪造/跨学生/失效引用拒绝；大样本标注抽样；无模型/无数据有明确状态 |
| A10 | 360/768/1280 宽度可用、键盘可操作、加载/空白/失败/404 状态完整；性能目标与查询计划有证据 |

## 11. 设计审阅结论

已完成一次独立 builder check，并在正文与计划中处理三项问题：回填以持久化采集切换时间为硬截止；报告正文与 job 成功原子提交；同快照失败报告仅复用，显式 retry 才重新生成。这些为工程一致性决定，不扩大产品范围。详细设计尚待用户审阅，尚未实现产品代码。

## 12. 实施映射与待执行评审

实施计划见 `../plans/2026-11-10-admin-student-insights.md`。基础查询与 AI 是同一版本验收，但按契约、权限、查询、采集、报告、UI 的依赖顺序落地，不要求两次发布。

工程师可自行决定：局部组件拆分、SQL CTE 命名、图表像素细节、迁移的下一个可用编号。不得自行改变：管理员全体只读范围、指标口径、历史覆盖标识、AI 引用校验与租约防旧写。
