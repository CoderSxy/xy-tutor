# 实施决策记录

以下按实际发生顺序保存，包含选择依据和验证边界。

1. Ruling: 在当前新目录使用 feat/mvp 分支，不另建 worktree — 已批准计划明确复用当前目录，无旧代码需隔离 — 若需并行工作以后再创建 worktree。

2. Ruling: 用户明确要求不使用子代理，最终做单人独立复查 — 用户指令优先于技能默认最终代理评审 — 缺少第二位作者的独立视角。

3. Ruling: Docker daemon 当前未运行，使用 /private/tmp 内独立 PostgreSQL 测试实例，不启动/修改已有系统服务 — 保持本地可验证 — 容器部署仍需另行验证。

4. Ruling: npm 官方源 TLS/ECONNRESET 反复失败，单次安装使用 registry.npmmirror.com — 公开镜像连接已验证 — 锁定依赖及 integrity，后续真实集成继续核验。

5. Task 2 Ruling: 当前本机仅有PG14，用临时PG14实例执行SQL集成测试；生产Compose目标PG17需额外容器验证 — 不启动用户Docker — 风险为生产版本差异。

6. Ruling: 发现环境分支变为main（已有提交保留），立即新建feat/mvp-implementation继续，不重写历史 — 避免继续在main实现 — 用户如需要可后续调整分支组织。

7. Task 3 Ruling: Drizzle生成FK显式引用public，测试schema隔离与之冲突；仅测试迁移回放把public限定符替换成随机test schema，生产SQL不改 — 避免测试串库 — 生产迁移仍需独立验证。

8. Task 4 Ruling: 用户暂未提供model/key，真实网关验证保留未验证；协议及pi运行时测试已完成，继续开发 — 符合计划外部配置处理 — 接入质量在真实冒烟前不能承诺。

9. Task 4 Ruling: 脚本采用node --import tsx而非tsx CLI，避免无关IPC监听且自动加载未追踪.env — 开发配置更直接 — 需要Node22已满足。

10. Task 6 Ruling: parseDocument消费授权加载的bytes/contentType而非按fileId访问文件，调用者负责授权 — 保持纯解析边界 — 后续job必须先校验文件归属。

11. Task 7 Ruling: 修正执行记录：前一验证链失败后shell后续行仍运行，产生零提交完成记录；已撤销该记录，任务7待重新全绿并实际提交。以后使用set -e防止继续执行。

12. Task 7 Ruling: 并发runner测试夹具默认available_at有微秒精度，立即tick使用毫秒时间偶发尚未到期；夹具显式设为已到期再断言并发，与生产下一tick处理语义一致。

13. Task 11 Ruling: buildContext以conversationId定位可为空的taskId，兼容未选任务的主动开场；上下文测试放真实PG集成而非空壳单测 — 入口需要先建会话再选择任务 — 若更改会话模型需同步工具绑定。

14. Task 11 Ruling: 核验/错题工具先提供可注入接口，未接Task13/14时明确isError而非假成功；后续必须接真实服务。真实模型/key仍缺，pi循环通过faux上游协议验证，不代表网关或教学质量验收。

15. Task 12 Ruling: 原始试卷导入答案允许attempt.task_id/message_version_id为空，改由attempt_evidence关联已确认的extraction版本 — 不伪造学生对话/学习任务 — 后续核验须兼容导入作答的证据路径。

16. Task 12 Ruling: 未配置模型拆题/OCR时提供原页文本或空候选供人工确认，明确保留needs_ocr状态；不把页文本宣称为已自动正确拆题。

17. Task 13 Ruling: 为教学循环提供可靠作答ID，提交run可显式带questionVersionId，同事务保存用户消息和attempt；普通求助不自动算作作答 — 防模型先执行后才补证据的竞态 — 前端必须区分回答与求助。

18. Task 13 Ruling: 参考答案单独追加question_references，上传题经两次独立解题一致后才成为核验参考，不改写题干历史 — 支持无现成答案的错题 — 同模型复核仍非数学证明，真实质量待验收。

19. Ruling: 本机磁盘可用不足10%，生产资源保护正确暂停解析；浏览器测试注入健康资源回调，独立测试仍验证真实保护 — 不清理用户文件也不关闭生产限额 — 本机不代表ECS容量。

20. Ruling: Task19等待浏览器回归期间准备Task20部署文件，最终分任务提交 — 两者文件独立 — 部署产物仍需单独验证，不提前宣称完成。

21. Ruling: Docker daemon未运行且用户未提供ECS访问，不启动系统服务；完成Compose静态校验和本地真实PG备份恢复，容器镜像/PG17/等效内存压测标待验证 — 避免把部署产物冒充已上线 — 上线前必须补齐。

22. Final: Ruling: 保留当前实现分支，不合并、不推送、不部署 — 本轮授权为本地初版实现 — 合并和上线需后续明确安排。

待完善的小项：个人资料保存后侧栏名称刷新；移动导航的键盘焦点管理。均不改变证据和权限规则。
