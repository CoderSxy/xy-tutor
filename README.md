# XY Tutor

基于 pi 的个人教学应用。设计和实施计划位于 `docs/superpowers/`；初版正在逐项实现。

## 开发

Node.js 22.22+，pnpm 10.30.3。执行 `pnpm install`，复制 `.env.example` 到未追踪的 `.env` 并填写服务配置。

- `pnpm dev:server`：后端开发服务。
- `pnpm dev:web`：静态前端开发服务。
- `pnpm test:unit`、`pnpm test:integration`：单元和专用测试数据库集成测试。
- `pnpm typecheck`、`pnpm lint`、`pnpm build`：检查和构建。
- `pnpm db:migrate`：迁移；测试只能使用专用 `TEST_DATABASE_URL`。
- `pnpm smoke:provider`、`pnpm smoke:oss`：真实上游验证，需要相应配置。

开发数据库可用 `docker compose -f infra/compose.dev.yaml up -d postgres` 启动。生产凭据、原始教材和学生资料不应提交到 Git。
