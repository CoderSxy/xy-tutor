# 学习会话图片作答验收记录

更新时间：2026-11-09

## 自动化验证

| 命令 | 结果 |
| --- | --- |
| `pnpm typecheck` | 通过 |
| `pnpm lint` | 通过 |
| `pnpm test:unit` | 32 passed |
| `pnpm test:integration` | 80 passed（18 files） |
| `pnpm build` | 通过 |
| `pnpm exec playwright test tests/e2e/chat-images.spec.ts tests/e2e/responsive.spec.ts --reporter=line` | 14 passed（37.2s） |
| `git diff --check` | 通过 |

覆盖行为：

- 发送前选择图片、缩略图、旋转后重新封存并只用新文件发送。
- 单条最多 3 张、纯图片消息可发送。
- 预览弹层：手机宽度无横向溢出，Escape 关闭，焦点回到触发按钮。
- 发送后与刷新后历史消息图片可回看。
- 下载链接过期时只换链一次，最终使用新链接。
- 历史图片异步加载不抢用户当前阅读位置。
- run 失败后可「重新回答」，不新增用户消息，retry 的 requestKey 与首次提交不同。

## 截图

由 `tests/e2e/responsive.spec.ts` 在 360 / 390 / 768 / 1024 / 1280 / 1440 六个宽度生成，覆盖手机、Pad、桌面：

- `docs/qa/screenshots/home-{360,390,768,1024,1280,1440}.png`
- `docs/qa/screenshots/study-{360,390,768,1024,1280,1440}.png`

## 真机相机手测

**未执行，标记为未验证。** 当前开发环境没有真机，`capture="environment"` 是否直接唤起系统相机、拍照后的方向与压缩结果，需要在真实手机上补测。建议步骤：

1. 在手机浏览器打开首页，点「拍照」，确认直接进入相机或退回文件选择。
2. 拍一张带文字的作业图，确认预览方向正确、可旋转、发送成功。
3. 在学习页刷新后确认同一张图仍能回看并打开大图。

在补测完成前，不对外声称真机拍照链路已验收。

## 未绑定图片清理

| 用例 | 结果 |
| --- | --- |
| 已绑定图片、软删除会话中的证据、24 小时内草稿保留 | 通过 |
| 超过 24 小时且未绑定的图片可清理，dry-run 不删除对象 | 通过 |
| 绑定与清理并发只有一个获胜 | 通过 |
| 删除失败标记 `cleanup_failed`，下次运行可重试成功 | 通过 |

运行方式：`pnpm cleanup:chat-images` 为 dry-run；确认输出后加 `--execute` 才删除对象。脚本只处理数据库中 `purpose='conversation_image'` 的已追踪行，不列举 bucket、不按前缀盲删，也未安装定时任务。

## 待办

- 真实 OSS + 当前网关端到端 smoke：**未执行**，需用户授权与凭据；测试须使用合成题目图片。
- 真机相机拍照链路：**未验证**，见上一节。
