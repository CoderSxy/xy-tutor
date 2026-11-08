# XY Tutor

基于 pi 的教学应用初版：React/Vite/TypeScript、Fastify、PostgreSQL、私有OSS与外部LLM。学生先选择教材版本/年级/科目，通过每日5练、知识点巩固、错题回顾、上传题目或自由提问进入辅导。管理员上传检查发布教材、邀请账号；学生资料需明确授权才能供他人访问。

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

前端http://localhost:5173，API3001。首次管理员登录后邀请学生并发布教材。未配置模型/OSS时显示明确未启用状态；实际辅导/上传需接入服务。LLM_BASE_URL已预留https://api.nerosun.cn/v1，模型ID和Key在本地填写。

## 验证与说明

- `pnpm test`：单元与真实PG集成；`pnpm test:e2e`：Chrome浏览器，独立3002/5175测试端口。
- `pnpm typecheck && pnpm lint && pnpm build`：静态检查和构建。
- `pnpm smoke:provider`、`pnpm smoke:oss`：真实服务冒烟，需配置。
- `node --import tsx tests/ops/backup-restore.ts`：独立临时数据库实际备份恢复演练。
- [技术栈与架构图](docs/architecture.md)
- [验收记录](docs/qa/mvp-acceptance.md)、[外部服务配置](docs/runbooks/external-services.md)、[ECS部署](docs/runbooks/deployment.md)、[备份恢复](docs/runbooks/backup-restore.md)、[运维](docs/runbooks/operations.md)。

统一UI采用已确认的A方向，适配PC、Pad和移动视口。真实供应商/扫描样本/真机、PG17容器限额和ECS上线仍需对应环境验收。生产凭据、原始教材和学生资料不提交Git。
