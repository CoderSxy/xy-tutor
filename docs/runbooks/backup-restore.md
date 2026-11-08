# 备份与恢复

业务事实在PG，原件在私有OSS。仅备份PG不能恢复被删除的原件；对原件bucket启用版本控制和适当保留策略，备份bucket独立授权。当前没有配置真实bucket，OSS备份及告警回调尚未验收。

## 每日备份

生产通过ops镜像内PG17客户端执行，直接访问私有网络的postgres，无需开放数据库宿主端口。本地脚本需安装与PG主版本相同的`pg_dump/pg_restore`客户端。脚本从运行目录未追踪的.env读取配置，生成custom-format备份、SHA256，并上传到`BACKUP_OSS_PREFIX/YYYY-MM-DD.dump`；同一天重试替换当日版本，保留最近7个每日对象。只删除严格符合该前缀和日期命名的备份，不触碰原始教材/照片。配置OSS服务端加密与私有ACL；限制凭据仅备份前缀读写/列举/删除。

```sh
docker compose --env-file .env -f infra/compose.prod.yaml run --rm ops
```

将其加入部署机cron，例如每日北京时间03:10：`10 3 * * * cd /opt/xy-tutor && docker compose --env-file .env -f infra/compose.prod.yaml run --rm ops >> /var/log/xy-backup.log 2>&1`。项目不自动修改系统cron。确保cron PATH含docker，构建ops镜像，确认主机时区。配置BACKUP_ALERT_URL为接收固定JSON事件的HTTPS端点；非零退出仍须由主机监控告警。每天监控最后成功备份时间，超过26小时告警。

## 恢复到新库

从私有OSS下载目标dump，并从对象元数据sha256取得校验值；使用可信控制台或SDK，勿把签名URL写进日志。设置RESTORE_DUMP_PATH、RESTORE_EXPECTED_SHA256、RESTORE_DATABASE_URL和RESTORE_CONFIRM_DATABASE。目标库名必须是`xy_tutor_restore_`开头并且尚不存在；确认值须等于完整库名。脚本拒绝覆盖现库，也拒绝与DATABASE_URL相同目标。

```sh
# 先安全导出四个RESTORE_*变量，容器路径例如/backups/chosen.dump
# 宿主备份目录必须只包含需要恢复的文件；以下只读挂载。
docker compose --env-file .env -f infra/compose.prod.yaml run --rm \
  -v /secure/backups:/backups:ro \
  -e RESTORE_DATABASE_URL -e RESTORE_CONFIRM_DATABASE \
  -e RESTORE_DUMP_PATH -e RESTORE_EXPECTED_SHA256 \
  ops scripts/restore-db.mjs
```

校验users、学生档案、题目/作答、消息版本、状态事件计数和外键引用；用恢复库启动隔离应用，检查ready200、学生登录、历史会话、错题来源和OSS原件。通过后才能安排流量切换。失败的部分目标保留以便检查，不自动删除。

## 已执行演练

`node --import tsx tests/ops/backup-restore.ts`在本机PG14生成独立小型合成业务库，经过真实pg_dump、创建新库、pg_restore，检查关键记录与消息→会话→任务引用、恢复实例ready200，并验证第二次恢复拒绝覆盖现库；耗时约2.7秒。测试最后仅删除自己生成的临时库。此结果不包括OSS网络/真实数据量/ECS性能。

ops备份运行时另占最多256MiB；建议避开高峰，低磁盘时先扩容。临时dump写入backup_work卷并在完成后清理；容器崩溃遗留的临时目录应经确认后清理。

RPO≤24小时、RTO≤4小时是运维目标，生产尚未实测。首次上线前与之后每月演练一次，记录备份年龄、下载时间、恢复时间、核对时间和实际数据量。
