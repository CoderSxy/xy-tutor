# 阿里云 OCR 接入补充计划

承接已批准初版计划Task6/外部服务配置，不改变上传确认或学情规则。用户授权查看已打开的控制台，已确认OCR统一识别服务；OSS为nerosun-storage / oss-cn-hangzhou。密钥留在本地.env，不从浏览器读取。

实现约定：官方OCR SDK，RecognizeAllText(2021-07-07)，杭州HTTPS端点，默认Type=Advanced，图像二进制逐页发送；统一返回{text}。显式配置优先，缺少配置保持未启用，失败不静默换供应商。错误信息不包含凭据、签名或学生原文。取消和超时有边界，不自动重试收费调用。

1. 编写配置选择、官方请求/响应映射、取消、错误和输入限额用例，先观察失败；接入官方SDK并验证通过。
2. 填入已确认的非敏感OSS参数，增加OCR专用RAM凭据占位与单页冒烟命令；保护已有.env值，凭据不入库。
3. 运行单元/集成、类型、静态检查和构建；真实请求仅在用户配置密钥及样本后执行，不把适配测试报告为云服务连通成功。

参考：https://help.aliyun.com/zh/ocr/developer-reference/api-ocr-api-2021-07-07-recognizealltext
