# XY Tutor

<!-- impeccable:product-schema 1 -->

## Platform

web

## Stack

用户已确认 React/Vite/TypeScript、Fastify、pi、PostgreSQL、OSS；静态前端、模块化单体后端。详见已批准设计。

## Users

初期为开发者本人和两三个轻度使用用户。学生进行日常学习、错题订正和试卷辅导；管理员上传并发布教材。

## Product Purpose

让学生在选择教材版本、年级、科目后，通过 pi 的提问和分层提示开始学习，并保留任务进度及每次学情判断的证据。

## Positioning

以明确业务规则和可追溯作答支撑学习状态；教材历史、学生私有资料、当前学情和辅助摘要分开管理。

## Operating Context

PC、Pad、手机浏览器；图片/PDF资料、公式和多轮对话；每日5练、知识点巩固、错题回顾、继续上次、上传资料、自由提问。学生可拍照上传，也可从文件选择资料。

## Capabilities and Constraints

2核/2GB/40GB ECS；模型调用外部网关 https://api.nerosun.cn/v1；OSS/OCR暂未配置，应预留接口和说明。邀请制，普通用户一账号先对应一学生。管理员不自动访问学生私有资料。三端布局、风格美化和一致性为验收要求。

## Evidence on Hand

已批准设计：docs/superpowers/specs/2026-11-08-xy-tutor-mvp-design.md。尚无真实教材、用户成绩、品牌图像和评价，不得虚构宣传或学习成果。名称XY Tutor为工作项目名称，未指定最终品牌资产。

## Product Principles

- 学生能清楚看到当前题目和下一步操作。
- 提示后答对与独立掌握分开记录。
- 保留原件、版本和证据；未知结果明确表达不确定。
- 同一任务跨会话可继续，布局切换不丢输入和进度。
- 美化服务阅读和操作，组件、语义色和状态统一。

## Accessibility & Inclusion

触控区域至少44×44 CSS px，正文对比度目标4.5:1，键盘可操作、可见焦点、减少动态效果偏好、公式局部滚动，移动软键盘不遮挡输入。

## Open Decisions

最终视觉方向待三方案选择；主要学习年龄段尚未单独限定，按教材年级适配，不能自行固定为幼儿或成人风格。
