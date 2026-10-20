# Health Agent Lab

[English](README.md) | 简体中文

一个用于技术分享的健康场景 Agent 示例工程：展示 Hono API、React H5、SSE 流式交互、原生工具调用、结构化输出、会话持久化、可选向量记忆及功能开关。

**这是代码与架构演示，不是面向患者运营的医疗产品。请使用虚构账号和合成数据。** 项目不附带真实用户数据、知识库语料、商业素材、云端凭据或托管服务。

代码采用 [Apache-2.0](LICENSE)。技术演示定位不额外限制许可证允许的商业使用。第三方依赖继续适用其各自许可证，详见 [第三方说明](THIRD_PARTY_NOTICES.md)。

## 工程范围

- `packages/shared`：共享类型、功能矩阵、客户端协议、工具 UI manifest。
- `packages/backend`：Hono API、Agent loop、工具、会话与档案、可选外部集成。
- `packages/frontend`：React H5、SSE、工具卡片与授权流程演示。
- `scripts`：独立测试和发布前检查。

此发行版不包含原生 App 壳、推送 SDK 二进制、企业发布流水线、运营报表或历史数据库升级链。数据库迁移是基于当前 schema 生成的**全新空库基线**，不能用于升级其他系统的现有数据库。H5 中保留的 Native bridge 协议只用于能力探测与兼容性示例。

## 本地运行

已验证 Node.js 26、pnpm 11.21.0、Docker Desktop。默认端口与常见的 3000/5432/5173 错开。

```bash
pnpm install --frozen-lockfile
cp .env.example .env
# 编辑 .env，填写自己的 LLM_API_KEY，并生成独立 JWT_SECRET：
openssl rand -hex 32

docker compose up -d postgres
pnpm --filter @health-agent/shared build
pnpm db:migrate
pnpm dev
```

- H5：<http://localhost:5174>
- API：<http://localhost:13010/health>
- PostgreSQL：`127.0.0.1:15433`，数据库 `health_agent_lab`。
- 本地登录可使用虚构标识 `13800000000`，先获取验证码，再输入 `123`。固定码仅用于本地/开发演示，不能作为公网认证配置。
- 停止前后端：在启动终端按 Ctrl+C。停止本项目数据库：`docker compose stop postgres`。停止容器不会删除数据卷。

如果端口被占用，修改 `.env` 中的前后端端口，以及 Compose 的数据库端口和 `DATABASE_URL`。启动过程不会清理其他项目的进程。

没有模型 Key 时可以构建、测试、查看界面，但不能获得真实模型回答；不会使用维护者的凭据或共享服务兜底。

## 可选集成与数据流

| 功能 | 配置/行为 |
| --- | --- |
| 模型对话 | 使用自行配置的 OpenAI 兼容 API；问题及上下文将发送至该服务 |
| 用户记忆 | pgvector + embedding；演示配置默认关闭自动提取和召回 |
| 医学文献检索 | 可选 `MEDICAL_RAG_QUERY_URL`；未配置不请求；当前默认 Agent 工具列表不开放此工具 |
| 医生/患教内容 | 需自行配置服务地址与令牌；无默认服务 |
| 图片/OCR | 需要自行配置 OSS 和模型能力；不附带任何真实图片 |
| 语音/推送/观测 | 可选，需自己的服务凭据；Push 和 Langfuse 默认关闭 |
| App 下载及营销入口 | 默认关闭，不提供安装包或品牌推广素材 |

公网产品化不是本工程的默认运行模式。运营者需要根据实际行为重新制定身份、数据保存期限、第三方接收方和授权规则；本仓库的演示说明不能直接替代正式运营协议。详见 [数据处理边界](docs/DATA_HANDLING.md)。

## 验证

```bash
pnpm build
pnpm test
pnpm check:publication
```

测试运行器使用合成环境变量，数据库和模型测试地址指向不可用的本地端口，不读取开发者的 `.env` 或调用真实模型。新增迁移后，在独立空库上运行 `pnpm db:migrate`，命令会逐表逐列检查 schema。

## 发布与贡献

参考 [贡献说明](CONTRIBUTING.md)、[安全反馈](SECURITY.md)、[发布检查清单](docs/RELEASE_CHECKLIST.md)。源码历史从本发行版首次提交开始；不要把私有工作区、凭据或真实对话带入提交、Issue 或构建附件。
