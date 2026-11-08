# ECS 部署

目标机器：Ubuntu24.04，2核2GiB，40GB；预计初期3–4人轻度使用。以下是部署产物与操作步骤，本次未登录ECS或上线。Docker daemon未运行，镜像构建、Caddy证书签发和PG17容器验收待执行。

## 配置与构建

1. 准备域名A记录指向ECS，安全组只开放80/443和受限来源SSH；PG不映射宿主端口。安装Docker Engine/Compose。
2. 在开发/CI机器检出已验证提交，按ECS CPU架构构建：

```sh
docker build --target server -f infra/Dockerfile -t xy-tutor-server:local .
docker build --target web -f infra/Dockerfile -t xy-tutor-web:local .
docker build --target ops -f infra/Dockerfile -t xy-tutor-ops:local .
docker save xy-tutor-server:local xy-tutor-web:local xy-tutor-ops:local -o xy-tutor-images.tar
```

将镜像通过可信通道传到ECS后`docker load -i xy-tutor-images.tar`。不在2GiB机器执行依赖安装或前端构建。镜像上下文排除.env、Git、用户文件和测试输出；镜像内无生产凭据。

3. 复制`.env.example`为未追踪`.env`，`chmod 600 .env`。填写`APP_DOMAIN`、随机`POSTGRES_PASSWORD`、32位以上随机`SESSION_SECRET`和`DATABASE_URL=postgres://xy_tutor:<URL编码密码>@postgres:5432/xy_tutor`。APP_ORIGIN由Compose覆盖为HTTPS域名。模型地址已预留`https://api.nerosun.cn/v1`，还需真实模型ID/API Key；OSS/OCR见external-services.md。BACKUP_*使用独立私有备份权限。
4. 所有Compose命令从项目根目录执行：

```sh
docker compose --env-file .env -f infra/compose.prod.yaml config --quiet
docker compose --env-file .env -f infra/compose.prod.yaml up -d postgres
docker compose --env-file .env -f infra/compose.prod.yaml run --rm server node dist/server/packages/db/src/migrate.js
```

迁移失败立即停止发布。首次管理员使用容器内已编译CLI；用终端安全输入并导出ADMIN_LOGIN/ADMIN_PASSWORD，然后执行（不把密码放命令行）：

```sh
docker compose --env-file .env -f infra/compose.prod.yaml run --rm -e ADMIN_LOGIN -e ADMIN_PASSWORD server node dist/admin/scripts/create-admin.js
unset ADMIN_PASSWORD
docker compose --env-file .env -f infra/compose.prod.yaml up -d
```

5. 检查`https://你的域名/api/health/live`和`/api/health/ready`均200。管理员登录、邀请学生、上传一本真实教材并人工核对后发布。完成真实模型、OSS、OCR冒烟；不要用测试适配器上线。

## 预算与上线门槛

Node整个容器640MiB（含PDF子进程）、PG512MiB、Caddy128MiB；定时备份ops临时容器另限256MiB；余量留给系统/网络/页缓存。Node旧生代256MiB，PDF子进程旧生代上限256MiB；两者不是独立容器预算，原生图片内存也计入640MiB。后台单任务、解析逐页、模型总请求并发2。PDF最多100页；图片限制由应用校验。

需要在同等Linux限额下实际运行两路流式会话加一个解析队列，观测容器总内存、OOM、PG连接、磁盘和延迟。640MiB尚未实测成立；失败时先降低批次、延后解析，再调整内存或升级服务器。40GB磁盘建议长期保持20%以上空闲，原件放OSS。

## 更新与回滚

先验证备份和恢复，记录旧镜像标签/提交，再执行兼容迁移、切换新镜像、检查ready及一条完整学习链路。失败时切回旧镜像；数据库只做向后兼容迁移，不自动down。破坏性迁移需另行安排备份、停机和恢复演练。禁止`docker compose down -v`，它会删除业务卷。
