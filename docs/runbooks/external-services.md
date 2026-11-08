# 外部服务配置

当前用户计划使用 `https://api.nerosun.cn/v1` 模型网关，尚无 OSS/OCR。未配置的服务返回明确“尚未配置”状态，不能使用虚假上传或识别结果替代。

## 本地配置

复制 `.env.example` 到 `.env`，后者已被 Git 忽略。脚本通过 Node 的 env-file 机制加载它。不要在聊天、Git、截图、URL或日志中暴露 Key。

模型配置 `LLM_BASE_URL`、`LLM_MODEL`、`LLM_API_KEY`；图像能力通过 `LLM_SUPPORTS_IMAGES=true` 明确开启，需先实测。`LLM_CONTEXT_WINDOW` 和 `LLM_MAX_OUTPUT` 根据实际模型设定。供应商需要支持 Chat Completions 流和工具调用。`pnpm smoke:provider` 只在真实访问成功后报告对应能力；缺 Key 时返回非零状态。

## 阿里云 OSS

1. 在 ECS 对应地域创建私有 bucket；关闭公共读写，不把题图设为公共文件。
2. 为应用创建限该 bucket 的最小权限 RAM 身份。填写 `OSS_REGION`（如 oss-cn-hangzhou）、`OSS_BUCKET`、`OSS_ACCESS_KEY_ID`、`OSS_ACCESS_KEY_SECRET`。不使用阿里云主账号 Key。
3. bucket CORS 仅允许实际 Web 域名（开发时单独允许本地前端来源），支持 PUT/GET/HEAD、Content-Type 请求头和需要的响应头。不要将任意来源和凭据访问组合开放。
4. 学生端获取短期 PUT 签名后直接上传；上传完成调用 API 校验类型、实际大小和文件头。图片≤10MB，PDF≤30MB/100页。
5. 下载签名有效期300秒；撤销访问后立即停止签发新链接，已有链接最多300秒过期。
6. 使用 `pnpm smoke:oss` 验证上传、校验、下载；生产上线前再验证备份策略。不会因配置项非空就宣称真实连接可用。

## OCR

预留 `OCR_PROVIDER`、`OCR_BASE_URL`、`OCR_API_KEY`。应用将定义统一按页识别适配器；具体服务协议需根据选定供应商映射。未配置时文本PDF仍可提取，扫描页标“需要OCR配置”，学生可补充题干并确认。图片识题也可使用已验证图像能力的模型；没有图像能力时不假装识图成功。

真实服务未配置前，测试仅能证明接口、权限和失败处理；无法证明公网连通性、OCR质量、模型出题质量或实际费用。
