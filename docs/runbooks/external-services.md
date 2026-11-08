# 外部服务配置

当前用户计划使用 `https://api.nerosun.cn/v1` 模型网关，OSS bucket已确定为`nerosun-storage`（杭州），OCR控制台已确认统一识别服务开通；用户已在本地填写RAM密钥，真实OSS/OCR冒烟已通过。未配置的服务返回明确“尚未配置”状态，不能使用虚假上传或识别结果替代。

## 本地配置

复制 `.env.example` 到 `.env`，后者已被 Git 忽略。脚本通过 Node 的 env-file 机制加载它。不要在聊天、Git、截图、URL或日志中暴露 Key。

模型配置 `LLM_BASE_URL`、`LLM_MODEL`、`LLM_API_KEY`；图像能力通过 `LLM_SUPPORTS_IMAGES=true` 明确开启，需先实测。`LLM_CONTEXT_WINDOW` 和 `LLM_MAX_OUTPUT` 根据实际模型设定。供应商需要支持 Chat Completions 流和工具调用。`pnpm smoke:provider` 只在真实访问成功后报告对应能力；缺 Key 时返回非零状态。

## 阿里云 OSS

1. 在 ECS 对应地域创建私有 bucket；关闭公共读写，不把题图设为公共文件。
2. 为应用创建限该 bucket 的最小权限 RAM 身份。填写 `OSS_REGION`（如 oss-cn-hangzhou）、`OSS_BUCKET`、`OSS_ACCESS_KEY_ID`、`OSS_ACCESS_KEY_SECRET`。不使用阿里云主账号 Key。
3. bucket CORS 仅允许实际 Web 域名（开发时单独允许本地前端来源），支持 PUT/GET/HEAD、Content-Type 请求头和需要的响应头。不要将任意来源和凭据访问组合开放。
4. 学生端获取短期 PUT 签名后直接上传；上传完成调用 API 校验类型、实际大小和文件头。图片≤10MB；教材PDF<50MB、最多500页，学生试卷PDF≤30MB、最多100页。
5. 下载签名有效期300秒；撤销访问后立即停止签发新链接，已有链接最多300秒过期。
6. 使用 `pnpm smoke:oss` 验证上传、校验、下载；生产上线前再验证备份策略。不会因配置项非空就宣称真实连接可用。

## 阿里云 OCR 统一识别

2026-11-08通过用户已打开的Chrome控制台只读确认“OCR统一识别已开通”，当时页面显示本月赠送200次、剩余200次。该数值有延迟且会变化，不能作为实时配额保证。未查看RAM密钥、未修改云配置。

已实现官方SDK的`RecognizeAllText`（API版本2021-07-07），固定杭州HTTPS端点`ocr-api.cn-hangzhou.aliyuncs.com`，默认`Type=Advanced`。按图片二进制上传，扫描PDF由已有解析器逐页渲染后识别，不要求公开OSS原件。

```dotenv
OSS_REGION=oss-cn-hangzhou
OSS_BUCKET=nerosun-storage
OSS_ACCESS_KEY_ID=在本地填写
OSS_ACCESS_KEY_SECRET=在本地填写
OCR_PROVIDER=aliyun
# 两项都留空时复用OSS的RAM密钥；同一个RAM身份须已获OCR权限。
# 如果使用另一个OCR身份，必须成对填写，不能只填一项。
OCR_ACCESS_KEY_ID=
OCR_ACCESS_KEY_SECRET=
```

调用该接口需要`ocr:RecognizeAllText`权限。本轮不修改用户已有RAM策略。凭据只在服务端使用。SDK单次调用关闭自动重试，连接超时5秒、读取超时20秒；后台队列仍有最多3次尝试，失败重试也可能消耗调用额度。取消后丢弃识别结果并停止继续处理页面；已发送的云请求不能保证撤回或免计费。

填写本地未追踪.env后，执行`pnpm smoke:ocr`只识别一张自动生成的无个人信息测试图；`pnpm smoke:oss`会在smoke/目录上传一个合成测试文件，随后校验私有读取。每页OCR可能计一次调用，建议先单页验证再批量导入教材。官方说明按量付费可能在免费额度用尽后继续计费。

自有样本可设置`OCR_SMOKE_FILE=/绝对路径/样本.png`，可选`OCR_SMOKE_EXPECT=预期片段`；运行后只报告成功与字符数，不打印识别原文。通用高精OCR不等于已验证公式结构、题目切分或批改，仍须在应用中人工确认。

官方参考：[RecognizeAllText接口与RAM授权](https://help.aliyun.com/zh/ocr/developer-reference/api-ocr-api-2021-07-07-recognizealltext)、[官方TypeScript SDK](https://github.com/aliyun/alibabacloud-typescript-sdk/tree/master/ocr-api-20210707)。

## 其他 OCR 接口

预留 `OCR_PROVIDER`、`OCR_BASE_URL`、`OCR_API_KEY`。应用将定义统一按页识别适配器；具体服务协议需根据选定供应商映射。未配置时文本PDF仍可提取，扫描页标“需要OCR配置”，学生可补充题干并确认。图片识题也可使用已验证图像能力的模型；没有图像能力时不假装识图成功。

真实密钥未填并完成冒烟前，测试仅能证明接口、权限和失败处理；无法证明公网连通性、OCR质量、模型出题质量或实际费用。

## 2026-11-08 真实验证结果

- OSS合成文件上传、封存复制、签名下载均成功；测试对象保留于smoke/与sealed/，未自动删除。
- 阿里云统一OCR成功识别一张无个人信息的合成图片。没有打印密钥或识别原文。
- 只读查询Bucket CORS返回NoSuchCORSConfiguration，随后已设置精确来源的跨域规则并经Chrome实测。用户确认后已应用`infra/oss-cors.dev.json`，仅允许localhost:5173；生产域名确定后另行增加精确来源，不能照搬任意来源。
- Chrome独立探针已实测跨域上传/封存/读取；真实试卷/公式识别质量和生产部署仍未验收。

重复Chrome连接探针可运行`node --env-file=.env --import tsx scripts/smoke-oss-browser.ts`，它要求localhost:5173空闲；打开提示的测试页后自动完成合成文件上传/封存/读取并关闭服务。它不会停止已有开发服务。不要把此临时页作为正式应用运行。
