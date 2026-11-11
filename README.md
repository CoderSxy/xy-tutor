# XY Tutor

基于 pi 的教学应用初版：React/Vite/TypeScript、Fastify、PostgreSQL、私有OSS与外部LLM。学生登录后直接通过每日5练、知识点巩固、错题回顾、上传题目或自由提问进入辅导，不再选择年级、科目或教材。管理员上传知识点资料、逐条确认发布并邀请账号；学生资料需明确授权才能供他人访问。

已发布知识点对所有学生开放，agent 在答疑和出题时按问题检索标题与总结；找不到依据时明确说明，不编造内容。未确认或已丢弃的条目对学生和检索均不可见。

错题原始答案、每次作答、消息版本、工具引用与学情状态分别保存。原题订正不会直接算掌握；独立变式及至少24小时后的新变式提供后续证据。

## 本地启动

Node22.22+、pnpm10.30.3，准备独立PostgreSQL库。`pnpm install --frozen-lockfile`，复制`.env.example`为未追踪`.env`并填写DATABASE_URL。可用`docker compose -f infra/compose.dev.yaml up -d postgres`创建开发数据库；已有本机PG时无需Docker。集成测试另建以`_test`结尾的测试库。

```sh
pnpm db:migrate
# 安全设置ADMIN_LOGIN/ADMIN_PASSWORD环境变量，再执行：
pnpm admin:create
pnpm dev:server
# 另一个终端：
pnpm dev:web
```

前端http://localhost:5173，API3001。首次管理员登录后先邀请学生，再在「知识点」中粘贴文本或上传资料，解析后检查、修改并确认发布。学生登录后直接开始学习，无需选择教材。未配置模型/OSS时显示明确未启用状态；实际辅导/上传需接入服务。LLM_BASE_URL已预留https://api.nerosun.cn/v1，模型ID和Key在本地填写。

## 知识点库

管理员侧边栏的「知识点」进入`/admin/knowledge`。一次上传可由模型拆成多条待确认知识点：管理员可改标题和总结、删除条目、补提示词整批再解析，然后逐条或批量确认发布。已发布列表支持状态筛选与搜索，修改总结保存后学生检索立即看到新内容；带补充提示词再解析只生成待确认稿，原已发布内容保持到再次确认。

未发布条目对学生接口不可见。旧的教材管理页会重定向到知识点页，`/api/admin/textbooks/**`与`/api/catalog/textbooks/**`返回410；旧教材表和历史数据保留但不再对学生开放。

## 管理端学情洞察

管理员侧边栏的「学情洞察」进入`/admin/students`：默认按最近学习时间排序，可按日期范围、学生关键字、活跃度和待订正数量筛选，分页查看学生的作答、正确率、任务完成、错题与材料覆盖；点开学生后可查看只读的学情概览、记录、活动，以及「AI 分析」下的学情报告。报告基于生成时的数据快照，正文引用的证据可跳回只读记录；未配置模型时生成入口禁用并说明原因。所有接口都在`/api/admin/student-insights/**`下，仅管理员可访问，跨学生读取报告返回404。

历史学习事件需先回填才能出现在统计中；未回填时页面按覆盖状态提示。回填命令使用应用库连接，先dry-run确认上限，再正式执行：

```sh
pnpm backfill:student-insights --from 2026-01-01 --to 2026-11-10 --dry-run
pnpm backfill:student-insights --from 2026-01-01 --to 2026-11-10
```

重复执行会跳过已完成的批次；中断后直接重跑即可恢复（`--no-resume`可强制从头处理），`--batch-size`控制每批事件数。结果以单行JSON输出。

## 验证与说明

- `pnpm test`：单元与真实PG集成；`pnpm test:e2e`：Chrome浏览器，独立3002/5175测试端口。
- `pnpm typecheck && pnpm lint && pnpm build`：静态检查和构建。
- `pnpm benchmark:student-insights`：在`_test`库的临时schema中造1000学生/100000作答，输出耗时、p95与EXPLAIN ANALYZE后自动清理；拒绝非`_test`库和生产环境。
- `pnpm smoke:provider`、`pnpm smoke:oss`、`pnpm smoke:ocr`：真实服务冒烟，需配置。
- `node --import tsx tests/ops/backup-restore.ts`：独立临时数据库实际备份恢复演练。
- [技术栈与架构图](docs/architecture.md)
- [验收记录](docs/qa/mvp-acceptance.md)、[外部服务配置](docs/runbooks/external-services.md)、[ECS部署](docs/runbooks/deployment.md)、[备份恢复](docs/runbooks/backup-restore.md)、[运维](docs/runbooks/operations.md)。

统一UI采用已确认的A方向，适配PC、Pad和移动视口。真实供应商/扫描样本/真机、PG17容器限额和ECS上线仍需对应环境验收。生产凭据、原始知识点资料和学生资料不提交Git。
