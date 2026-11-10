# agent.nerosun.cn 可重复部署流程

日期：2026-11-10。状态：部署建议及命令模板，未登录 ECS、未构建/上传镜像、未更改线上服务。

## 选择与适用条件

建议：本地或 Linux CI 构建镜像 → 阿里云私有镜像仓库 → ECS 拉取 → Docker Compose。ECS 不安装项目依赖、不编译前端、不构建镜像。备选为预构建 Linux 发布包 + systemd，但需额外维护 Node 版本、原生依赖和服务配置；不建议上传 macOS node_modules。

项目已有记录：Ubuntu 24.04 / 2 vCPU / 2GiB / 40GB，尚待现场确认。用户补充公网带宽“3MBps”，单位待以控制台核实。若为3 Mbps，出网理论约0.375 MB/s；若为3 MB/s，则约24 Mbps。公网带宽、云盘 IOPS/吞吐是不同资源，不能由带宽推出磁盘性能；ECS公网入网和出网限制也不能视为相同。

部署前收集：实例规格/架构、云盘类型及容量、IOPS和吞吐上限、剩余内存/空间、80/443现有监听、镜像仓库地域及可用访问端点。云盘实际能力还受实例侧上限限制。

可在ECS执行的只读检查（iostat如未安装先省略，不为检查擅自安装）：

```sh
uname -m
free -h
df -hT
df -i
lsblk -o NAME,SIZE,TYPE,FSTYPE,MOUNTPOINTS
ss -lntp
vmstat 1 5
iostat -xz 1 5
docker stats --no-stream
```

IOPS/吞吐额度从阿里云控制台获取，以上命令不能完整识别云盘产品限额。已有服务占80/443时复用现有入口反代，不直接启动本项目绑定相同端口的web服务；对应compose端口/入口配置须先适配。

## 初始资源预算

沿用现有 compose.prod.yaml：server 640MiB（含tmpfs/PDF原生内存）、postgres 512MiB、web 128MiB；ops备份按需256MiB。常驻预算合计1280MiB，备份时1536MiB，剩余留给OS、Docker及其他服务。这是限额预算，未在目标ECS验证容量。

PG数据保持独立持久卷；原件与长期备份在私有OSS；日志10MB×3轮转；不提高现有后台解析并发；保留当前版本和上一可回滚版本，其他镜像仅按明确归属清理。40GB建议至少20%可用；拉取前还须核对新旧镜像解压后的实际峰值空间。不要自动清理卷。

## 首次准备（一次）

1. 确认 agent.nerosun.cn DNS 指向目标ECS；HTTPS入口使用现有Caddy，或在无现有入口时使用项目web/Caddy；对大陆地域核对域名接入所需手续。安全组只开放80/443及受限SSH，不开放PG端口。
2. 安装Docker Engine及支持 --wait 的Compose v2；配置可访问的镜像仓库（优先同地域、确实可用的私网端点）。ECS仅授予拉取权限，构建端使用推送权限。
3. 固定目录 `/opt/xy-tutor`，复制 `infra/compose.prod.yaml`；运行入口配置随web镜像分发。
4. 建立服务器专用 `.env`，权限600，填写 `APP_DOMAIN=agent.nerosun.cn`、随机会话密钥、PG密码、容器内数据库连接串、模型、OSS/OCR及备份配置。不要上传本地开发.env。数据库host使用postgres，不是localhost；密码需URL编码。
5. 后续每次发布只改变版本清单，不覆盖生产.env，不重新初始化数据库。

## 构建端：测试、构建、推送

选择已提交、已验收版本。当前完整集成测试尚有3项失败，见 `docs/qa/admin-student-insights-review-fixes.md`；首次正式上线前须处理或明确评估，不把构建成功等同于发布通过。

下列为命令模板；先将REGISTRY替换为实际仓库地址/namespace，VERSION替换为固定提交版本。amd64仅适用于ECS的uname -m=x86_64；aarch64改linux/arm64。Mac本地使用buildx构建Linux镜像，不能直接复制macOS依赖。

```sh
pnpm typecheck
pnpm lint
pnpm test
pnpm build
pnpm test:e2e

REGISTRY='<实际镜像仓库地址/namespace>'
VERSION='<已验收提交的唯一版本号>'

docker buildx build --platform linux/amd64 --target server -f infra/Dockerfile -t "$REGISTRY/xy-tutor-server:$VERSION" --push .
docker buildx build --platform linux/amd64 --target web -f infra/Dockerfile -t "$REGISTRY/xy-tutor-web:$VERSION" --push .
docker buildx build --platform linux/amd64 --target ops -f infra/Dockerfile -t "$REGISTRY/xy-tutor-ops:$VERSION" --push .
```

镜像构建尚未实测，先完成一次CI/本地Docker验收。正式运行时推荐版本清单使用仓库返回的digest固定镜像，不反复覆盖latest。

创建 `releases/<VERSION>.env`：

```dotenv
SERVER_IMAGE=<实际地址>/xy-tutor-server:<VERSION>
WEB_IMAGE=<实际地址>/xy-tutor-web:<VERSION>
OPS_IMAGE=<实际地址>/xy-tutor-ops:<VERSION>
```

把该清单及必要的compose配置同步至ECS；普通发布不传源码、node_modules或整份docker save tar。基础镜像首次拉取后复用，已有镜像层可复用；镜像层变化决定实际传输量，不能保证每次只传业务代码。

## ECS：首次启动

从 `/opt/xy-tutor` 执行。以下dc函数后续更新也复用；RELEASE_ENV选择已上传的实际清单。

```sh
cd /opt/xy-tutor
RELEASE_ENV='releases/<VERSION>.env'
dc() {
  docker compose --parallel 1 --env-file .env --env-file "$RELEASE_ENV" -f infra/compose.prod.yaml "$@"
}

dc config --quiet
dc pull postgres server web ops
dc up -d --wait postgres
dc run --rm --no-deps server node dist/server/packages/db/src/migrate.js
```

迁移失败停止，不继续启动应用。首次管理员沿用原 deployment.md 的安全输入流程：通过终端输入并导出ADMIN_LOGIN/ADMIN_PASSWORD，再执行已编译CLI，不将密码写进命令行、清单或Git。

```sh
dc run --rm --no-deps -e ADMIN_LOGIN -e ADMIN_PASSWORD server node dist/admin/scripts/create-admin.js
unset ADMIN_PASSWORD
dc up -d --no-deps --wait server
dc up -d --no-deps --wait web
curl --fail --silent --show-error https://agent.nerosun.cn/api/health/ready
```

必须验证管理员登录、普通学生权限、流式聊天、OSS原件上传/读取、真实OCR和一次AI分析。健康检查只证明基础可用，不能替代业务验收。首次签证书需要DNS正确、入口端口可达，服务端必须能访问模型/OSS/OCR。

## ECS：以后每次更新

沿用上面的dc函数，将RELEASE_ENV指向新版本清单。顺序：

1. 记录当前成功版本清单；磁盘/内存检查，启用维护提示并安排短维护窗口。
2. `dc config --quiet`，然后 `dc pull server web ops`，先拉完再停止旧应用。--parallel 1串行拉取服务，减少竞争；不能当作硬IOPS限速。
3. 旧实例仍运行时在低峰执行并验证备份：`dc run --rm --no-deps ops`。须事先配置并验证备份OSS；预算不足时在维护停写后备份。
4. `dc stop server`，释放Node内存并停止写入/后台任务；不停止/重建PG，不执行down。
5. `dc run --rm --no-deps server node dist/server/packages/db/src/migrate.js`。失败即停止发布并检查迁移，不盲目继续。
6. `dc up -d --no-deps --wait server`，再 `dc up -d --no-deps --wait web`；撤维护前确认ready/live和完整学习链路。
7. 标记新成功版本；以后按明确镜像ID移除超出保留策略的旧镜像，不能使用带卷清理的命令。

此单实例方案会短暂中断请求和正在生成的回答，客户端需重连/重试；不能承诺零停机。2GB上不默认同时运行蓝绿两套应用和迁移进程。

## 回滚

切回上一成功版本的RELEASE_ENV，再用dc重建server/web（仍先等待server健康），PG卷保持原状。只有新迁移向旧应用兼容时，镜像回滚才成立；不兼容迁移需执行事先设计的恢复方案。禁止 `docker compose down -v` 和无差别 volume prune。备份恢复是独立操作，不用作普通应用回滚的第一步。

## 当前落地前需补齐

- 现有Dockerfile需实际验证镜像构建、启动、迁移和管理员CLI；不能直接称生产已验证。
- Dockerfile编译了管理员脚本，但尚未打包学情回填CLI。需要把backfill及其依赖编译进server镜像后才能在容器执行v2回填；当前生产镜像不应依赖dev用tsx现场执行源码。
- 确认云盘与实例IO限额、剩余资源、80/443现有入口，之后才能设置实际IO限速。低峰串行拉镜像、备份、迁移避免叠加；不要为减IO关闭PG的fsync或安全写入。
- 以后可封装为构建端release脚本与服务器deploy/rollback脚本，包含版本选择、磁盘预检、备份、迁移、健康检查和清单记录；本文没有声称这些一键脚本已实现。

## 参考

- ECS存储IO上限：https://www.alibabacloud.com/help/en/ecs/user-guide/storage-i-or-o-performance
- ECS入网/出网区别：https://www.alibabacloud.com/help/en/ecs/user-guide/network-bandwidth/
- Docker持久卷：https://docs.docker.com/engine/storage/volumes/
- Compose拉取：https://docs.docker.com/reference/cli/docker/compose/pull/
