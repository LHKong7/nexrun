# NexRun

[英文版](README.md) · [架构文档](docs/architecture.zh-CN.md) · [Sprint 1](docs/sprints/sprint1.zh-CN.md)

NexRun 是一个本地运行、单一所有者的聊天应用，采用 React/shadcn UI、Node.js API、PostgreSQL 持久化和 Agent 流式回复。Sprint 1 提供私聊、确定性模拟 Adapter 和纯文本 Pi Adapter。群聊、Agent Teams、仓库执行以及更广泛的执行基础设施仍属于后续工作。

## 环境要求

- Node.js **22.19.0 或更新版本**，并安装 npm。
- Docker、Docker Compose v2，以及正在运行的 Docker 守护进程，用于开发数据库。
- 当前 Pi 宿主生命周期实现使用 `/bin/ps` 和进程信号，因此需要 macOS 或 Linux。
- 默认本地浏览器测试需要已安装的 Google Chrome；CI 可使用与 Playwright 版本匹配的 Chromium。

以下命令均在仓库根目录运行。仓库的 `.npmrc` 将新增依赖固定为精确版本，并禁用软件包生命周期脚本，因此 `npm ci` 安装时会忽略脚本。额外的安装脚本或二进制下载需要单独进行依赖审查。

## 本地配置

对于全新检出的仓库：

```sh
npm ci
cp .env.example .env
```

如果已经配置过 `.env`，请保留现有文件，不要覆盖。默认 `AGENT_MODE=mock` 不需要模型凭据。

启动 PostgreSQL：

```sh
docker compose up -d db
docker compose ps
```

等待 `db` 处于健康状态，再应用迁移并启动两个应用：

```sh
npm run db:migrate
npm run dev
```

打开 [http://127.0.0.1:5173](http://127.0.0.1:5173)。API 监听 `http://127.0.0.1:3001`，开发数据库仅绑定到 `127.0.0.1:55439`。Web 服务将 `/api` 和 `/healthz` 代理到 API，使浏览器命令与 SSE 保持同源。请确保端口 5173 和 3001 可用；修改 API 端口时，也需要更新 Web 代理。

数据库使用名为 `nexrun-postgres` 的存储卷。`npm run db:down` 会停止 Compose 服务，但不会删除该卷。按照提供的配置，Pi 状态另行存放在 `.data/pi`；需要保留 Pi 对话时，应将其与数据库一起保留。

## 使用聊天

创建聊天、发送消息，即可看到助手回复随文本到达逐步增长。UI 支持英语和简体中文、Markdown/代码复制、对话重命名/归档、移动端导航，以及导航期间保留草稿。已归档聊天会离开默认列表；正在执行的聊天必须先完成或停止，才能归档。

界面控件统一使用官方 shadcn Base UI 组件，包括侧栏、语言 Select、重命名 Dialog、归档 AlertDialog、卡片、状态标签、头像、通知、工具提示、加载状态和滚动区域。语言选择支持键盘操作并保存偏好；弹窗会管理焦点范围，并在关闭后恢复焦点。Markdown 表格和任务列表复选框也使用同一套组件。

在模拟模式下，普通消息会收到简短确定性回复，不会回显提问或对话记录。可使用 `/code`、`/markdown` 验证固定格式，使用 `/slow` 检查停止和重连，使用 `/error` 验证保留部分文本的失败，使用 `/remember <value>` 再发送 `/context` 验证有界相关上下文。`npm run demo:seed` 会向本机回环地址的模拟数据库添加七个可重复导入的双语和历史演示对话，并保留已有对话及修改。完整场景与覆盖范围见[测试与模拟数据指南](docs/testing.zh-CN.md)。这些测试命令不是 Pi 命令。

消息、Run 和带序号的事件持久化到 PostgreSQL。离开聊天、刷新或浏览器断线都不会取消由服务端持有的 Run。SSE 重放会重建规范回复，而非重复追加文本。每个对话只能有一个活跃 Run；配置中的服务总上限为跨对话并发两个 Run，超出容量的工作会被明确拒绝。

停止操作会请求取消，并保持待确认状态，直到观察到终止，或受监督宿主被强制停止。部分文本和实际观察到的最终状态仍然可见。API 重启时，会先核对并处理先前的 Pi 宿主，再将尚未解决的已接受工作标为中断；不会自动重新向模型提交。

## 纯文本 Pi

在 `.env` 中私下设置以下值：

```dotenv
AGENT_MODE=pi
PI_PROVIDER=openai
PI_MODEL=gpt-5-mini
NEXRUN_OPENAI_API_KEY=replace-with-your-authorized-key
```

`NEXRUN_OPENAI_API_KEY` 优先于 `OPENAI_API_KEY`；后者仍可作为服务端环境的回退值。请使用已获授权且可用的 OpenAI API 凭据。环境变量存在，并不代表身份验证、额度或模型访问一定有效。不要将密钥放入聊天消息、源文件、客户端环境变量、截图或日志。Git 会忽略 `.env`。

修改配置后重启 API。在 `mock` 和 `pi` 之间切换后，请创建新聊天；已有 Agent 会话的聊天不能切换运行时，也不能将模拟历史转换为原生 Pi 上下文。

Pi 每次生成都在专用的受监督子进程中运行，每个对话具有独立持久化的原生会话。所有工具、扩展、hook、技能、提示模板、仓库指令和资源发现均被禁用。以斜杠开头的输入仍按文本处理。宿主仅接收所选模型凭据和受控环境配置，不读取个人 Pi 身份验证或设置。原生会话文件和清单保留在服务端，并限制访问权限。

此进程边界不是用于执行不可信代码的沙盒。Sprint 1 不执行仓库、shell 命令、浏览器操作或用户扩展。未来接入可执行工具之前，需要另行建立沙盒边界。

`.env.example` 中的配置包括：

| 变量 | 提供的值或含义 |
| --- | --- |
| `DATABASE_URL` | `postgres://nexrun:nexrun@127.0.0.1:55439/nexrun` |
| `API_HOST` / `API_PORT` | `127.0.0.1` / `3001` |
| `AGENT_MODE` | `mock`；使用 `pi` 启用已配置的真实 Adapter |
| `PI_PROVIDER` / `PI_MODEL` | `openai` / `gpt-5-mini`；模型在服务端选择 |
| `PI_STATE_DIR` | `../../.data/pi`，相对于 API 工作区目录解析 |
| `NEXRUN_OPENAI_API_KEY` | 优先使用的项目专用服务端凭据；请私下提供 |
| `OPENAI_API_KEY` | 服务端回退凭据 |
| `GENERATION_TIMEOUT_MS` | `60000` |
| `MAX_CONCURRENT_RUNS` | `2` |
| `ALLOWED_ORIGINS` | 明确列出的本地 Web 源，使用端口 5173 |
| `ALLOWED_HOSTS` | `127.0.0.1,localhost` |

## 检查与集成验证

数据库运行时，执行：

```sh
npm run typecheck
npm run lint
npm run licenses:check
npm test
```

`npm run check` 会组合执行上述检查。API 集成测试会创建和删除隔离的 PostgreSQL 模式；`TEST_DATABASE_URL` 可覆盖测试默认的本地连接。Pi 生命周期测试使用确定性测试场景，仅检查带标记的测试子进程；禁止进程检查的受限环境会拒绝继续执行。

运行浏览器场景前，先停止手动启动的开发服务：Playwright 会自行启动 API 和 Web 服务、强制使用模拟模式，并占用端口 3001 和 5173。已安装 Google Chrome 的本地机器可运行：

```sh
npm run test:e2e
```

在 CI 中，或使用 Playwright 配套 Chromium 而非已安装 Chrome 时：

```sh
npx playwright install chromium
CI=1 npm run test:e2e
```

Linux CI 运行环境可能需要执行 `npx playwright install --with-deps chromium` 来安装浏览器系统依赖。浏览器和系统下载是需要单独审查的产物，不能仅依赖 npm 软件包许可证覆盖。失败追踪和截图写入 `test-results/`，HTML 报告位于 `playwright-report/`。

真实 Pi 验证是一项显式使用模型的检查：

```sh
npm run test:pi
```

该脚本加载 `.env`，需要有效的已配置密钥，并验证两个轮次的上下文延续、与另一对话的隔离、原生持久化、取消，以及经脱敏的配置失败。它会发出真实 OpenAI 请求，可能产生用量费用。缺失或不可用的凭据会使此验证受阻或失败；模拟测试和仅有模拟的演示，不能证明真实 Pi 集成已通过。

## 构建与本地构建预览

构建 API 和 Web 产物：

```sh
npm run build
```

配置好 PostgreSQL 并停止开发服务后，在两个独立终端中分别运行：

```sh
npm run start --workspace @nexrun/api
```

```sh
npm run preview --workspace @nexrun/web -- --port 5173 --strictPort
```

编译后的 API 位于 `apps/api/dist`，Web 打包产物位于 `apps/web/dist`。API 命令加载根目录的 `.env`；Web 预览使用相同的本地 API 代理和端口 5173，以匹配提供的源访问策略。这些命令用于在本地检查构建结果，不提供生产部署或经身份验证的预览网关。

## 访问与交付边界

本次迭代使用一个固定、由服务端确定的开发所有者。尚无用户账号、组织隔离、OIDC、计费或公开多租户服务保证。Host/Origin 检查用于支持本地边界，不是登录系统。

共享的私有预览必须为整个应用添加经身份验证的访问控制和 TLS，包括每条 API 与 SSE 路由。为该部署明确配置允许的主机和源。不要将当前应用作为无身份验证的公开服务暴露。Temporal、Valkey、S3、沙盒资源池、Firecracker、群聊和 Agent Teams 不属于本次实现范围。

## 依赖与许可证审查

项目采用 [Apache-2.0](LICENSE)。第三方准入遵循[仓库政策](AGENTS.md#commercial-use-and-third-party-dependency-admission)，包括支持商业使用的精确版本证据和相关义务。生成的记录包括：

| 产物 | 位置 |
| --- | --- |
| 锁定的 npm 发布版本和完整性信息 | `package-lock.json` |
| 依赖清单与许可证证据哈希 | `docs/dependencies/inventory.json` |
| 补充的精确发布版本上游证据 | `docs/dependencies/upstream-licenses/` |
| 复制的 shadcn 源码归属和修改记录 | `docs/dependencies/shadcn-sources.json` |
| 保留的 shadcn 许可证 | `vendor/shadcn/LICENSE` |
| CycloneDX SBOM | `docs/dependencies/sbom.cdx.json` |
| 第三方许可证和声明文本 | `THIRD_PARTY_NOTICES.txt` |

新增或升级时，检查实际选定的发布产物、上游源码、LICENSE/NOTICE 文件、打包代码和分发义务。范围应包含直接、传递、开发、可选/原生依赖、复制的源码、资产及额外下载。固定变更版本并更新证据后，再重新生成记录：

```sh
npm run licenses:review
npm run licenses:check
```

`licenses:review` 可以获取本地未安装的平台对应的锁定产物，并重新生成依赖清单、声明和 SBOM。审查生成的变更与所选许可证分支；不要将生成过程视为自动批准。将已审查的锁文件和证据一起提交。`licenses:check` 会拒绝锁文件/证据不一致、未经审查的依赖、不被允许的许可证表达式，以及已记录 shadcn 源码的变更。分发打包产物时保留所需声明。容器镜像、浏览器二进制文件、系统组件和托管服务/模型条款需要单独审查；npm 门禁不能证明拥有所有这些权利。

共享的配置或行为变化时，同步维护本 README 及其[完整英文版](README.md)。
