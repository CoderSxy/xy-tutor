# 学习会话图片作答实现方案

日期：2026-11-09。状态：用户已确认方案方向，要求编写设计与实施计划；本文不代表已完成实现。
实施计划： [2026-11-09-chat-image-attachments.md](../plans/2026-11-09-chat-image-attachments.md)。

## 1. 目标和固定边界

学生可以在首页及学习页的 Composer 选择图片、拍照，发送前预览、旋转、移除；可只发图片，也可附文字。发送后聊天记录展示图片，刷新及重新进入会话后仍可查看。Agent 和独立判题均可使用原始图片证据。

所有图片只使用 xy-tutor 当前配置的 OSS：现有 createFileStore 与 OSS_BUCKET、OSS_REGION、OSS_ACCESS_KEY_ID、OSS_ACCESS_KEY_SECRET。不读取、不复用 tc-prime-ai 的配置、密钥、桶、接口。参考项目仅用于设计参考，不建立运行依赖。

决策：浏览器处理图片 → 当前项目私有 OSS → 数据库存附件引用 → 浏览器按授权地址预览；模型请求前由后端通过当前 FileStore.read(objectKey) 读取并转 Base64。存储地址由后端数据库查询取得，不接受浏览器提供任意 OSS URL。无需为了模型再次请求自己的签名 URL，也不要求网关访问私有桶。

## 2. 已核实的现有实现和参考

xy-tutor 已有：UploadInput 的图片选择、拍照、方向旋转和长边 2000 像素处理；上传授权、PUT 直传、complete 校验与 seal 封存；files 表与私有下载授权；FileStore.read；模型图片能力开关 LLM_SUPPORTS_IMAGES。

缺口：Composer 只有文字；RunService.submit 强制非空文字；消息版本没有附件关联；buildContext 组装纯文字；TutorPanel 只渲染 Markdown；AttemptService 和 AssessmentService 的证据流只传文字。

tc-prime-ai 参考位置（相对该参考项目根目录）：

- primeai-web/src/views/next/components/chat/HarnessMessageInput.vue：输入与素材交互。
- primeai-web/src/views/next/components/chat/MessageItem.vue：userImageParts、缩略图网格及大图预览。
- primeai-harness-agent/src/main/java/com/ly/travel/primeai/agent/attachment/HarnessImageAttachmentProtocol.java：以 primeai-attachment://ID 持久化内部引用。
- 同目录 HarnessImageMessageUtil.java：授权读取附件，在调用模型前构造 Base64 图片块；单次调用缓存。
- primeai-admin/src/main/java/com/ly/travel/primeai/agent/attachment/S3HarnessImageAttachmentStore.java：临时素材与已绑定素材分离。

复用思想而非照搬实现：本项目用 UUID 外键关联，无需自定义 URL 协议；继续使用现有 OSS 适配层。参考实现会跳过读取失败图片，本教学场景的当前作答图片不能静默跳过，必须显式失败或要求补拍。

## 3. 交互和图片策略

Composer 增加“拍照”“选择图片”入口。拍照使用 input[type=file]、accept=image/*、capture=environment；系统决定是否直接打开相机，无法拍照时保留选择图片入口。桌面支持选择、剪贴板截图及拖入图片。手机相机依赖真机验收。

附件显示在文本框上方：缩略图、顺序、处理/上传进度、成功/失败状态；点击打开大图，支持旋转、移除、失败重试。旋转发生在已上传之后时，生成新文件并上传，不能修改已封存内容。第一版最多 3 张，上传并发 2。

状态：selected → processing → uploading → ready，任意阶段可 failed 或 removed。只有文字或至少一张 ready 图片时可发送；若当前仍有处理中或失败附件，发送禁用并说明原因，不能悄悄丢掉附件发送。上传期间允许继续写字。取消文件选择不改变已有草稿。发送中冻结本次草稿，成功后清空；失败保留文字、顺序、fileId 和请求键。切换会话清理本地草稿及 Object URL，避免发错会话；第一版不承诺跨刷新恢复未发送草稿。

建议参数（工程初值，需真实手写样本验收）：原文件最多 15MiB、4000万像素；JPEG/PNG/WebP；HEIC 若浏览器不能解码，提示转换或重拍，不伪装上传成功。使用旋转后的 JPEG，长边优先 2400px，质量约 0.88，目标每张 ≤2MiB。逐步调整质量和尺寸，低于约 0.75 或长边 1800px 前停止自动压缩；仍过大时要求裁剪或分张，可允许服务端受控接收 ≤5MiB 清晰版本。总计最多 15MiB/消息。2MiB 是处理目标，不是模型限制。透明图片转 JPEG 时使用白底；处理后去除 EXIF 等无关信息。第一版旋转和大图预览必做，交互裁剪可后续加入。

## 4. 文件、消息与证据数据结构

复用 files 表，purpose 新增 conversation_image。通过可空的 conversation_id 将会话图片限定到所属会话（其他用途保持原样）；浏览器在上传授权时提交 conversationId，服务端校验 studentId 和会话访问权。保留 ready/rejected 等文件状态，另用关联判断是否已经发送。

新增 message_attachments：

| 字段 | 含义 |
| --- | --- |
| id | UUID 主键 |
| message_version_id | 非空外键，指向确切消息版本 |
| file_id | 非空外键，指向已封存的 files |
| position | 本条消息内图片顺序 |
| width / height | 经可信解码得到的图片尺寸 |
| created_at | 创建时间 |

约束：(message_version_id, position) 唯一；同一版本 file_id 不重复；每版本最多 3 张由事务校验。附件绑定文件必须 ready、conversation_image、属于当前学生及当前会话。未来文字编辑默认复制原附件关联，新图片生成新版本，旧证据不覆盖；沿用 evidence_invalidations 作废旧版本证据。

不保存 Base64 和签名 URL。files.object_key 为稳定存储定位；下载 URL 临时生成。attempts.message_version_id 已能指向原始文字与图片，无需再拷贝图片。answer 字段只保留真实学生文字，纯图片时允许空字符串；附件存在性取代“answer 必须非空”的条件。所有答案详情、错题及汇总消费方必须认识图片证据，不能把“图片作答”当成学生的答案文本来判题。

## 5. 接口契约

### 上传授权

复用 POST /api/uploads，conversation_image 请求示例：

```json
{
  "studentId": "uuid",
  "conversationId": "uuid",
  "purpose": "conversation_image",
  "name": "answer.jpg",
  "contentType": "image/jpeg",
  "size": 1234567
}
```

返回现有 fileId/url/headers/expiresAt。浏览器 PUT 到授权 URL，再 POST /api/uploads/:id/complete。complete 复用 seal，校验真实 MIME、字节数并增加解码尺寸/像素限制；只有成功后才能发送。扩展 file-limits.ts，保持教材和现有学生材料的限制不变。

### 提交消息

扩展 POST /api/conversations/:id/runs：

```json
{
  "message": "第二步这样做对吗？",
  "attachmentIds": ["file-uuid-1", "file-uuid-2"],
  "questionVersionId": "optional-uuid",
  "requestKey": "stable-key"
}
```

message 默认空串；文字 trim 后非空或附件非空，两者满足其一。opening 模式不接收附件。requestKey 相同时比较文字、题目 ID、模式及有序附件 ID；一致返回原 runId，不一致 409。服务端只接收 ID，不接收任意下载地址或 Base64。

事务内原子完成：检查会话/任务有效性与学生权限 → 幂等查询 → 检查并锁定附件 → 写 user message 和 version → 绑定附件 → 如有关联题目则写 attempt 和题目状态 → 写 agent run。失败全部回滚，不产生半条消息。图片缺失/未完成返回可重试的明确错误，跨学生/会话附件拒绝。纯图片标题使用“图片作答”或当前题目简短描述，避免空标题。

### 已接受消息的运行重试

区分两种重试：提交响应丢失时以原 requestKey 重放提交；已创建 run 后因 OSS/模型服务失败时，提供 POST /api/runs/:id/retry（携带新的稳定 requestKey）。后者校验原 run 属于当前会话、原输入仍是有效版本、任务仍允许学习且无活跃 run；新建 run 复用原 input_version_id、文字与题目引用，不再插入 user message、附件关联和 attempt。重复 retry 返回同一新 run。独立判题另按证据版本去重，不能因重跑产生重复掌握证据。界面在失败消息旁提供“重新回答”。停止/取消的运行由用户主动选择是否重试。

### 历史和预览

MessageDTO/MessageHistory 的当前及历史版本增加 attachments 数组：fileId、mimeType、name、width、height、position。列表不读取图片二进制、不携带 Base64。图片可见时，前端通过现有 GET /api/files/:id/download 获取临时链接，扩展返回 expiresAt（示例 5 分钟）；临近过期或加载失败时重新鉴权换链，一次失败不无限刷新。图片本身可能被浏览器缓存，服务端签名不作永久地址使用。学习会话软删除仍沿用既有数据保留语义，不因此物理删除图片。

## 6. 首页与学习页发送链路

学习页已有 conversationId，选择后即可上传并预览。

首页还没有会话，首次选择图片时按需创建 free_question 任务取得 conversationId，并缓存该任务供后续发送复用。没有附件时继续沿用现有文字流程。此任务只有成功提交首条消息后才开始 Agent 运行。清空附件/离开首页后可能留下空任务，第一版允许保留并显示“未开始”；如不接受该表现，可在实现时采用显式草稿状态和清理流程，不能直接删除一个可能已接受消息但客户端丢失响应的任务。

扩展 sessionStart.ts：首次图片上传与首条消息共用同一任务；请求指纹包含学生、教材、文字、题目、有序 fileId。消息提交超时后重试复用 task/conversation/requestKey。首次“创建任务”响应本身丢失的问题单独用可选 creationKey 和学生维度唯一约束解决，确保图片选择期间重复操作也只创建一次；不把已有的首条消息幂等误当成创建任务幂等。

学习页 useTutorRun.submit 接收文字和附件；Composer onSubmit 变为结构化草稿。busy 期间禁止发送新 run，但可准备草稿；停止按钮只取消模型运行，不删除已提交图片消息。

## 7. 模型侧处理

第一步先对当前网关、实际模型 ID、当前 pi-ai SDK 做图片 smoke 测试，验证它真的读取图片中的内容。LLM_SUPPORTS_IMAGES=true 是声明，不代替实测。模型不支持时 capabilities 禁用图片发送并解释原因，不能静默去掉图片继续判题。

新增 ConversationAttachmentService，统一提供授权元数据、绑定、读取和模型块转换。buildContext 查询消息版本附件，将 user.content 从字符串升级为 TextContent/ImageContent 数组；按当前 SDK 类型传 mimeType 和 Base64 data，经 openai-completions 适配器产生 image_url data URL。Base64 仅存在于当前调用内存和模型请求，不写库、不进日志、不作为文字计入提示词。

后端根据 fileId → files.object_key → 当前 FileStore.read() 取二进制；保留 OSS SDK 读取超时、单图尺寸和单次总字节上限。一次 run 内缓存相同 fileId 的读取结果，工具多轮不重复下载；结束释放缓存。

预算必须升级：沿用现有文字预算，但为图片预留模型相关的 token 估计和请求字节空间。最新消息、当前题目对应作答图片优先且不可静默裁掉；历史按消息整体裁剪，文字和图片不拆散。建议初始最多 6 张历史/当前图片，当前提交最多 3 张；若当前题目证据超过预算，明确提示分段处理，不能凭缺失证据确认掌握。完整图片始终留在 OSS，预算裁剪只影响某次模型请求。

当前图片读取失败：run 明确失败，保留用户消息并可重试，不能当空白答案。图片中的内容当学生提供的作答证据，不作为系统或工具指令。

官方说明：deepseek-flash 支持 Base64/URL/file_id 图片输入，Chat Completions 的图片出现在 user 消息。实际兼容网关能力必须验证。来源：https://api-docs.deepseek.com/guides/vision/

## 8. 独立判题、错题和学习记录

这是必做链路，不推迟到 UI 完成之后再考虑。

- RunService 的图片作答 attempt 关联原消息版本；AttemptService.submit/get 同步支持附件。
- 教学工具读取 attempt 时返回证据 ID 和附件描述，不能在工具结果里泄漏 Base64 或临时 URL。
- AssessmentService.submitCandidate 的独立核验请求使用同一附件读取服务，送入题干、已验证参考答案、真实文字和原图，不能只使用主 Agent 的转述。
- 仅当没有图片时使用现有文字数值/选项快速核验；有图时不能因为学生只写“答案是 3”而跳过图中过程要求。先做多模态独立核验，再沿用证据充分性与 criteriaSatisfied 规则。
- 模糊、遮挡、漏步骤、图源读取失败、图片预算不足时 correctness=uncertain / verification=pending，不据此确认掌握，不把技术读取失败记为错题。
- 若需要结构化转写，单独存识别结果与来源附件 ID、模型及版本，不覆盖原始答案，不默认将识别文字视为学生已确认内容；不增加强制 OCR 调用。
- 错题详情、学习记录与摘要输入沿消息版本查询附件证据；摘要只保留受支持的结论和证据引用，不保存 Base64；重放核验仍能重新读取对应图片。

## 9. 前端模块和变更文件

| 文件/模块（相对 xy-tutor 根目录） | 变更 |
| --- | --- |
| apps/web/src/features/tutor/Composer.tsx | 图片入口、结构化草稿、发送条件 |
| 新增 apps/web/src/features/tutor/useImageAttachments.ts | 处理/上传/重试/取消及 Object URL 生命周期 |
| 新增 apps/web/src/components/ImageAttachmentPreview.tsx | 草稿和消息通用缩略图/大图弹层 |
| apps/web/src/features/uploads/UploadInput.tsx 与新增 imagePrepare.ts | 提取共用处理逻辑，保留教材材料原流程 |
| apps/web/src/features/tutor/TutorPanel.tsx | 用户图片渲染、图像加载后滚动跟随 |
| apps/web/src/features/tutor/useTutorRun.ts | attachmentIds、幂等指纹、重试 |
| apps/web/src/routes/Home.tsx、apps/web/src/routes/Study.tsx、apps/web/src/lib/sessionStart.ts | 首页草稿会话及图片作答连接 |
| apps/server/src/modules/uploads/contracts.ts、service.ts | 会话用途、权限及像素校验 |
| 新增 apps/server/src/modules/conversations/attachments.ts | 附件访问/绑定/读取统一服务 |
| apps/server/src/modules/conversations/runs.ts、messages.ts、contracts.ts | 原子提交、版本及历史附件 |
| apps/server/src/agent/context.ts、tutor.ts、provider.ts | 多模态上下文、预算和依赖注入 |
| apps/server/src/modules/learning/attempts.ts、assessments.ts、verifier.ts | 图片证据与独立核验 |
| packages/db/src/schema、迁移、文件限制和共享 DTO | 附件表、会话文件归属、creationKey |

以上为相对根目录说明，实施时按仓库实际目录补齐 import。数据库迁移按实施时最新序号生成，不预设会覆盖现有 0013。原文字消息默认 attachments=[]，保持现有数据可读。

## 10. 失败、资源和权限处理

- 预览只显示授权范围内文件；所有读取、绑定和下载校验学生与会话，不因知道 fileId 就允许查看。
- 只有当前项目后端掌握 OSS 凭证；前端获得短时上传授权，复用现有 OSS CORS 设置并检查 PUT/GET。
- 发送绑定 seal 后对象，避免上传 URL 尚有效期间文件内容被替换。
- 记录和展示当前文件真实 MIME/尺寸；服务端不能相信前端压缩结果。
- 草稿移除只解除本地引用，不能物理删除已发送证据。未绑定附件建议 24 小时后清理；上传原对象和 rejected/孤儿封存对象同样纳入清理。现有 FileStore 无 delete 方法，清理需要扩展接口与 OSS 实现并提供 dry-run、测试和时间阈值。已绑定图片永不进入该清理任务。
- OSS 未配置时正常文字聊天可用，图片入口显示不可用原因。
- 用户图像的 Base64、签名链接和 OSS 密钥不写应用日志；日志仅保留 fileId/runId、耗时、大小和错误分类。

## 11. 实施顺序和验收

1. 网关能力与真机小样验证：文字+图、纯图、两张图、工具调用后仍能看图；确定当前模型输入类型兼容。
2. 数据层与文件层：迁移、purpose、会话访问控制、真实 MIME/像素限制、附件版本关系；先用集成测试验证越权和原子性。
3. 消息和模型链路：run 提交/幂等、历史、图片装配与预算；使用测试 FileStore 和可检查输入块的模型桩，断言模型接到的图片字节来自已封存对象。
4. 教学证据链：图片 attempt、独立判题、uncertain/pending、错题和摘要消费方；验证主 Agent 与独立核验收到同一消息版本的图片。
5. Composer 和会话 UI：选择/拍照/预览/旋转/上传/重试/消息展示；首页首次任务复用；手机与桌面布局。
6. 完整验收：typecheck、lint、unit、integration、build、相关 Playwright；授权后执行一次真实 OSS + 当前网关端到端 smoke，测试图使用合成题目，不使用真实学生隐私图。

关键自动化用例：纯文字兼容；纯图片可发送；3 张边界及第4张拦截；上传失败保留草稿；相同 requestKey 无重复消息/attempt；改变附件顺序或内容返回409；跨学生/会话引用拒绝；签名过期换链；刷新恢复图片；当前图片丢失不继续判题；图片证据不足不确认掌握；编辑消息使旧证据失效；未绑定垃圾清理不删已发送图片。

第一版不包含：PDF会话附件、自定义实时相机、强制OCR、重型扫描矫正、模型生成图片。布局在现有 Composer 和 TutorPanel 上增量扩展，不另做视觉改版。

## 12. 实施时采用的明确默认值

以下为本方案的工程决策，实施计划据此执行；真实样本验证若要求调整，先同步本文和计划。

- 2MiB = 2 × 1024² 字节；上传成品硬上限 5MiB/张、15MiB/消息；单条最多3张；处理前原文件硬上限15MiB、4000万像素。
- 初始长边2400px，JPEG质量0.88；压缩依次尝试0.82、0.75，仍超过2MiB时按0.85倍缩小尺寸，长边不自动降到1800px以下；成品≤5MiB可上传并提示“为保留清晰度，使用较大图片”，超过5MiB要求裁剪/分张。透明底填白。默认不保留另一份原图。
- 上传并发2；后端读取图片并发2、单图15秒、一次模型输入图片总字节最多30MiB，最多6张。Base64约增加1/3体积；总请求还须受实际网关限制。单run缓存不得跨用户或跨run复用，run结束释放。
- 图片预算估计可配置，默认每张预留1536 token（工程保守值，不声称是供应商计费值），总预算还包含文字、输出和协议空间；最新消息不能被文字预算裁掉。当前题目的必要证据超预算则显式报错，历史消息按完整版本裁剪。
- 首页首选图片按需创建free_question任务，未发送前允许作为“未开始”空会话保留，不自动删除；不引入新task status。通过无用户消息的派生条件展示“未开始”，避免混同已有active状态。所有新建任务请求的可选creationKey按(student_id, creation_key)唯一；重复键且教材/任务类型/章节不同返回409。
- 已准备草稿在同页模型运行期间保留；切换会话清空草稿。上传取消不能撤回已发往OSS的请求结果，过期孤儿交给清理。当前题目可能在生成后变化，点击发送时固化questionVersionId；服务端校验它仍适用于该任务。
- 短时下载链接5分钟；失败时重新签名最多1次，继续失败显示重试按钮。所有下载仍先鉴权。原有软删除会话遵循原保留策略，本功能不物理删除已绑定证据。
- 重试只允许failed/interrupted运行；cancelled由用户主动发起同一重试操作；queued/running返回409，succeeded不重试。retry使用独立requestKey，新run沿用原mode、conversation_id、input_version_id、input_text、question_version_id、当前发起actor，并记录retry_of_run_id；幂等校验原run及输入版本。已经编辑失效的输入版本拒绝重试，避免重跑旧证据。
- 不支持图片时允许继续纯文字；含图片的提交与历史必要图片的模型调用均显式拒绝，不能静默去图。最新图片读取失败不调用模型；技术读取失败不记录incorrect。
- 每次独立判题使用同一附件装配入口；有图片时禁用仅基于answer文字的exact捷径，独立图片核验可确认number/choice/worked/open答案，证据不足保持pending。核验失败不能回退成“默认答对”。
- 第一版不做草稿跨刷新恢复、自定义摄像头、强制OCR、PDF会话附件或视觉改版；保留现有文字行为及教材/学生材料上传限制。

## 13. 方案比较与取舍

| 方案 | 取舍 | 决策 |
| --- | --- | --- |
| 浏览器把Base64直接交给聊天API | 实现表面简单，但持久化、失败恢复、证据重放复杂 | 不采用 |
| 当前项目OSS保存，后端按引用读图并发Base64 | 复用现有存储与SDK，证据稳定、网关无需主动抓取链接 | 用户已选择的方向 |
| OSS保存，模型直接读取临时URL | 请求较小，但依赖网关抓取能力和链接有效期 | 后续经兼容性验证再考虑 |

方案复核已补充“提交响应丢失”和“已保存消息执行失败”的不同恢复契约；实施顺序按计划执行。本文不授权迁移生产数据库、清理生产对象或实际收费联调。
