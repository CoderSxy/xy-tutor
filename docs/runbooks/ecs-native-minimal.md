# ECS 极简发布（已在实际服务器部署验证）

2026-11-10：XY Tutor 已部署到 https://agent.nerosun.cn 。流程参考 NeroAgent：本地生成 Linux 发布包，上传，ECS 解压后使用 systemd 启动。**不包含备份步骤，ECS 不执行 pnpm install、应用构建或 docker build，不需要应用镜像仓库。**

## 当前实际配置

| 项目 | 已部署值 |
|---|---|
| ECS | 杭州，101.37.135.116，Ubuntu 24.04.5，x86_64 |
| Node | `/usr/local/bin/node`，v22.22.0（不是 `/usr/bin/node`） |
| 应用 | `xy-tutor.service`，用户/组 `xy-tutor`，监听 `127.0.0.1:3002` |
| 发布根目录 | `/opt/xy-tutor/releases` |
| 当前版本 | `/opt/xy-tutor/current` → `/opt/xy-tutor/releases/20261110T065329Z` |
| 生产配置 | `/opt/xy-tutor/.env`，root:xy-tutor，0640 |
| PostgreSQL | 独立容器 `xy-tutor-postgres`，使用服务器已有 `postgres:16` 镜像 |
| 数据库 | `xy_tutor`；宿主地址 `127.0.0.1:55433`，容器内5432 |
| 数据卷 | `xy-tutor-pg-data`，不使用 NeroAgent 的卷或业务库 |
| PG初始化配置 | `/opt/xy-tutor/postgres.env`，root:root，0600 |
| HTTPS站点 | `/etc/nginx/sites-available/nero-agent`（保留原站点文件名及TLS证书配置） |
| 静态目录 | `/opt/xy-tutor/current/web`；`/api/`反代到3002，关闭proxy buffering支持SSE |
| 内存限制 | Node MemoryHigh=512MiB、MemoryMax=768MiB、MemorySwapMax=1G；PG容器320MiB |

首次上线前agent域名是占位页，NeroAgent及其PG容器已停止。本次只将该占位站点接入XY Tutor，未改旧业务库或启动旧NeroAgent。其他Nginx站点保持原配置。

## 以后每次更新：只做这三步

### 1. 本地打包

先启动本地Docker，在项目根目录执行：

```sh
sh scripts/build-release.sh
```

产物：

```text
dist/xy-tutor-linux-amd64.tar.gz
dist/xy-tutor-linux-amd64.tar.gz.sha256
```

构建阶段使用 `CI=true`，解决 pnpm prune 非TTY中止；Linux生产依赖随包交付。Mac打包关闭xattrs和AppleDouble，避免Ubuntu解压大量 `LIBARCHIVE.xattr.com.apple.provenance` 警告。以前的包出现此警告不代表业务文件损坏，本次旧包已成功解压并启动。

本地Docker仍需要能取得/缓存Node与Caddy基础镜像。`--target release --output type=local`导出普通文件，不推送仓库；不会构建ops镜像。打包失败不能上传dist中遗留旧包，必须以脚本成功及本次SHA输出为准。

### 2. 上传

```sh
scp dist/xy-tutor-linux-amd64.tar.gz dist/xy-tutor-linux-amd64.tar.gz.sha256 root@101.37.135.116:/tmp/
```

如果没有自己的SSH密钥，可继续使用已登录的阿里云Workbench上传这两个文件到 `/tmp`。本次部署的限时SSH密钥在验收后移除，不是以后可复用的登录凭据。

### 3. ECS更新启动

以下整段在ECS的root终端执行。`set -euo pipefail`只作用于这个子shell，任一步失败即停止，不会在迁移失败后继续切换：

```bash
bash <<'SH'
set -euo pipefail
cd /tmp
sha256sum -c xy-tutor-linux-amd64.tar.gz.sha256
# 同时核对校验值与本地本次构建输出一致。

docker exec xy-tutor-postgres pg_isready -U xy_tutor -d xy_tutor
RELEASE=$(date -u +%Y%m%dT%H%M%SZ)
RELEASE_DIR=/opt/xy-tutor/releases/$RELEASE
test ! -e "$RELEASE_DIR"
install -d -m 0755 "$RELEASE_DIR"
tar --warning=no-unknown-keyword --no-same-owner --no-same-permissions \
  -xzf /tmp/xy-tutor-linux-amd64.tar.gz -C "$RELEASE_DIR"
chmod -R a+rX "$RELEASE_DIR"
test -s "$RELEASE_DIR/backend/dist/server/apps/server/src/main.js"
test -s "$RELEASE_DIR/backend/dist/server/packages/db/migrations/meta/_journal.json"
test -s "$RELEASE_DIR/web/index.html"

systemctl stop xy-tutor.service
runuser -u xy-tutor -- /usr/local/bin/node --env-file=/opt/xy-tutor/.env \
  "$RELEASE_DIR/backend/dist/server/packages/db/src/migrate.js"

test ! -e /opt/xy-tutor/current.next
test ! -L /opt/xy-tutor/current.next
ln -s "$RELEASE_DIR" /opt/xy-tutor/current.next
mv -Tf /opt/xy-tutor/current.next /opt/xy-tutor/current
systemctl start xy-tutor.service

READY=0
for i in $(seq 1 30); do
  if curl -fsS http://127.0.0.1:3002/api/health/ready >/dev/null 2>&1; then
    READY=1
    break
  fi
  sleep 1
done
test "$READY" = 1
# 普通更新不修改Nginx配置，不需要重新安装服务单元或重载Nginx。
curl -fsS https://agent.nerosun.cn/api/health/ready
systemctl show xy-tutor.service -p ActiveState -p NRestarts -p MemoryCurrent
printf '\nPublished: %s\n' "$RELEASE_DIR"
SH
```

成功后刷新浏览器，验证登录和本次功能。单实例更新有短暂停机，进行中的回答可能需要重新发送。若失败，先看日志，不继续盲目切换：

```sh
journalctl -u xy-tutor --since '5 minutes ago' --no-pager -n 50
docker logs --tail 30 xy-tutor-postgres
```

不要用 `docker compose down -v` 或清理业务卷来解决发布问题。

## 数据库和env：本次如何同步，以后如何维护

### 首次同步（本次已完成，不是每次发布动作）

1. 从本地 `.env` 指定的 `127.0.0.1:55432/xy_tutor` 导出数据库（PG14.13，约13MB）。使用custom格式、no-owner、no-acl，不导出账号角色定义。
2. 在ECS建立独立PG16容器与新卷，端口只绑定127.0.0.1:55433。使用独立随机数据库密码，限制320MiB、0.5CPU、日志10MB×3。
3. 将导出文件经SSH传至root私有暂存目录，使用 `pg_restore --exit-on-error --single-transaction --no-owner --no-acl` 导入空库；随后执行候选版本迁移CLI。
4. 关键行数核对：2个用户、1个学生、0次作答、0份资料；20条数据库迁移记录。原账号密码哈希随数据迁移，未重置用户密码。
5. 以本地配置为源同步模型、OSS/OCR、图片能力等设置；生产环境单独设置以下差异，移除测试库/本地镜像等部署无关变量。

```dotenv
NODE_ENV=production
HOST=127.0.0.1
PORT=3002
APP_ORIGIN=https://agent.nerosun.cn
DATABASE_URL=postgres://xy_tutor:<独立数据库密码>@127.0.0.1:55433/xy_tutor
RESOURCE_DISK_PATH=/opt/xy-tutor
```

数据库密码不在本文中记录。`/opt/xy-tutor/postgres.env`保存容器首次初始化配置；数据库已初始化后修改这个文件不会自动修改数据库角色密码。

**以后普通更新只运行迁移，不再导入本地数据库。** 线上开始学习后，线上数据库是业务数据源，不能再次用开发库覆盖。现有生产.env默认保持原状；只有模型/OSS/OCR等参数变化时编辑对应项，再 `systemctl restart xy-tutor`，不要直接覆盖DATABASE_URL和生产域名。

密钥只保存在服务器受限env文件；不写进发布包、Git或聊天。首次传输暂存中的env、数据库导出及本次限时SSH公钥已在验收后清除；已实测该密钥的新SSH连接被拒绝，本地临时私钥及导出也已清除。

## 服务、域名与OSS配置

systemd实际单元在 `/etc/systemd/system/xy-tutor.service`，仓库模板 `infra/native/xy-tutor.service` 已同步修正Node路径与本次内存限额。普通发布无需覆盖单元；确需更改时才安装并daemon-reload。

### 2026-11-10 解析事故：内存限额调整（需在服务器执行一次）

当天 15:25 上传的 500 页扫描件让 `pdf-child` 逐页渲染，主进程和子进程一起越过 MemoryHigh。`MemorySwapMax=0` 意味着 cgroup 只能做内存回收，两个进程进入不可中断睡眠（`wchan=mem_cgroup_handle_over_high`），事件循环停摆，`/api` 全部挂起，前端停在“正在读取学习账号”。

代码侧已修：整份文档 10 分钟硬超时、扫描页上限 60 页、单页 30 秒停滞判定、子进程改 JPEG 编码并等待 stdout drain、永久失败错误直接置 `failed` 不再重试、前端 API 30 秒超时。

单元侧给解析峰值留换页空间，需要改已安装的单元一次：

```sh
sed -i -e 's/^MemoryHigh=384M$/MemoryHigh=512M/' \
       -e 's/^MemoryMax=512M$/MemoryMax=768M/' \
       -e 's/^MemorySwapMax=0$/MemorySwapMax=1G/' \
       /etc/systemd/system/xy-tutor.service
systemctl daemon-reload
systemctl restart xy-tutor.service
systemctl show xy-tutor.service -p MemoryHigh -p MemoryMax -p MemorySwapMax
```

宿主机有 3G swap，PG 容器另有 320MiB 限额，这个额度不会挤占数据库。改完后旧单元文件里不应再出现 `MemorySwapMax=0`。

Nginx沿用现有证书 `/etc/letsencrypt/live/nerosun.cn/`，保留HTTP→HTTPS重定向。生产配置已由占位页改为SPA回退及/api/反代。只有修改站点配置时才运行：

```sh
nginx -t && systemctl reload nginx
```

重载后马上访问偶尔仍由旧worker返回占位页404，本次等待后再次检查已200；不能仅凭这一瞬间请求判断应用启动失败。

OSS bucket `nerosun-storage` 原先只允许 `http://localhost:5173`；本次在保留原规则基础上加入精确来源 `https://agent.nerosun.cn`，允许PUT/GET/HEAD和Content-Type，暴露ETag，不使用通配来源。生产来源PUT预检已验证。

## 本次验收与边界

- 本地和公网 `/api/health/ready` 均200，Nginx配置检查通过；浏览器显示XY Tutor登录页。
- 使用临时会话验证线上admin/student角色、学生学情列表/概览及权限隔离；验收会话随后删除，没有更改用户密码。未使用浏览器自动填充的旧NeroAgent账号密码尝试登录。
- 模型网关实际请求通过；OSS临时对象写入/读取通过且已删除；生产来源上传CORS预检通过。
- 配置接口显示模型、OSS和OCR均已配置，图片能力enabled-unverified。**本次未执行真实试卷OCR、图片理解、完整学生学习流程或真实数据学情报告生成**；当前无作答/资料，不能将基础验收称为这些功能已通过。
- 服务初启RSS约90MB，未观察到重启；该数据不代表并发与大型扫描资料的容量测试。
- 已启用应用随主机启动；PG容器restart=unless-stopped。旧NeroAgent和其数据库继续保持原停止状态。

首次发布包SHA-256：`9cd3263ad9483c659047b775a7833d4db0aa48486fb6e003e0f342a1a46859fd`。这是本次服务器上用户上传包的值；以后必须使用各次新包的校验值。
