# NexRun

[英文版](README.md) · [架构文档](docs/architecture.zh-CN.md) · [Sprint 1](docs/sprints/sprint1.zh-CN.md) · [Sprint 2](docs/sprints/sprint2.zh-CN.md)

NexRun 是一个本地运行、单一所有者的聊天应用，采用 React/shadcn UI、Node.js API、PostgreSQL 持久化和 Agent 流式回复。Sprint 1 提供私聊、确定性模拟 Adapter 和纯文本 Pi Adapter。群聊、Agent Teams、仓库执行以及更广泛的执行基础设施仍属于后续工作。

[Sprint 2](docs/sprints/sprint2.zh-CN.md) 加入版本化 Agent 配置档案、显式身份与会话作用域、持久化文本 Workspace、受限文件工具，以及人工启用的知识/技能和上下文清单。本地实现与确定性检查已完成；配置中的真实 Pi/OpenAI 凭据认证失败，最终验收仍未验证，不声称已成功完成真实模型驱动的工作区编辑。

## 环境要求

- Node.js **22.19.0 或更新版本**，并安装 npm。
- Docker、Docker Compose v2，以及正在运行的 Docker 守护进程，用于开发数据库。
- 当前 Pi 宿主生命周期实现使用 `/bin/ps` 和进程信号，因此需要 macOS 或 Linux。
- 模型驱动的 Workspace 文件工具还要求经过审查的 macOS arm64 环境，并使用[原生运行时清单](docs/dependencies/native-runtime.json)中哈希匹配的 Node **22.20.0** 与 Apple 可执行文件。不支持或未经审查的运行时会拒绝执行；普通文本聊天无需该文件工作进程。
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

## Agent 管理配置

打开侧栏中的**设置**，或访问 [http://127.0.0.1:5173/admin/settings](http://127.0.0.1:5173/admin/settings)。通过 shadcn 表单配置 Mock/Pi、OpenAI 模型、Agent 回复语言和 API Key。服务空闲时，保存立即生效。已保存的 Key 会被加密，API 不会回传，可以替换、移除或明确继承环境变量。

共享部署应配置 `NEXRUN_ADMIN_TOKEN` 和经身份验证的 TLS 访问。备份数据库时同时保留加密主密钥；默认位于 `.data/pi/configuration/encryption.key`，也可以提供稳定的 32 字节 base64 `NEXRUN_CONFIG_ENCRYPTION_KEY`。访问规则、凭据操作、版本冲突、模型绑定和备份步骤见完整的[管理与恢复指南](docs/admin-settings.zh-CN.md)。

## Agent 配置与 Workspace

打开侧栏中的 **Agent 与工作区**，或访问 [http://127.0.0.1:5173/agents-workspaces](http://127.0.0.1:5173/agents-workspaces)。

1. 在 **Agent 配置**中创建可复用角色，设置模型/运行时、独立的回复语言和允许的文件操作。编辑会创建新版本；已有聊天保留所选版本，直到显式应用变更。凭据继续由设置页面管理，不会复制进配置档案。
2. 在**工作区**中创建 Project 和 Workspace，然后通过相对路径和文件内容编辑器添加文本。数据库保存不可变文件版本，界面支持比较版本。这些是有大小限制的虚拟文本文件，不是挂载的宿主机目录、导入的 Git 仓库或可执行项目。
3. 在**知识与技能**中添加有明确来源的事实/文档或声明式技能指令，选择用户、项目或工作区作用域。技能要求获准采用的许可证和已记录的授权依据，只能要求所选配置已允许的文件操作。不运行脚本或自动发现。
4. 打开聊天并选择**聊天资源**，绑定配置、可选 Workspace、知识和技能。应用变更会开启新的原生上下文代次，同时保留可见聊天历史。不同聊天保持独立的 Agent 身份与 Session，即使复用同一配置，或串行使用同一个 Workspace。
5. 配置可用的 Pi 连接后，让 Agent 列出、读取、搜索或编辑绑定的文本文件。在**工作区**中查看实际版本/差异，在**聊天资源**中查看最近 Run 的来源清单和操作记录。Mock 回复仍是确定性测试样例，不能证明真实模型驱动的工具执行。

Workspace Run 持有独占租约；竞争实时访问和编辑会返回忙碌状态。文件写入检查预期版本和操作 ID。来源更正、撤回、绑定变化及外部文件版本变化会使受影响的原生上下文失效。检查点将文件版本与兼容原生状态的不可变副本绑定；备份时应同时保留数据库和私有 Pi 状态。

本地文件工作进程使用默认拒绝的 macOS Seatbelt 约束，通过 stdin 接收有界快照，仅执行平台自有的内存文件操作，不能读取用户宿主机文件内容、写入宿主机文件、联网或创建子进程。受信任的 Pi 宿主和具有最终写入权限的数据库代理位于该工作进程外。精确哈希、就绪探测、资源限制，以及已弃用平台接口的局限见[原生运行时审查](docs/dependencies/native-runtime.zh-CN.md)。这是经过审查的本地实现，不是 VM 或通用仓库代码沙盒。

## Pi 运行时与凭据

可以通过设置页面交互配置 Pi。首次明确保存设置前，以下私有 `.env` 值也可提供启动默认值：

```dotenv
AGENT_MODE=pi
PI_PROVIDER=openai
PI_MODEL=gpt-5-mini
NEXRUN_OPENAI_API_KEY=replace-with-your-authorized-key
```

`NEXRUN_OPENAI_API_KEY` 优先于 `OPENAI_API_KEY`；后者仍可作为服务端环境的回退值。请使用已获授权且可用的 OpenAI API 凭据。环境变量存在，并不代表身份验证、额度或模型访问一定有效。不要将密钥放入聊天消息、源文件、客户端环境变量、截图或日志。Git 会忽略 `.env`。

设置页面保存后无需重启。环境变量变化需要重启 API；首次保存后，持久化的运行时、模型和语言选择优先于这些默认值。使用服务默认配置的聊天在运行时/模型发生不兼容变更后，需要新建聊天。显式配置档案可以在空闲时通过**聊天资源**应用，创建兼容的上下文代次。已有历史仍可查看；替换同一 Pi 模型的密钥可以继续兼容的已有 Session。

Pi 每次生成都在专用的受监督子进程中运行，每个 Agent/上下文作用域具有独立持久化的原生 Session。纯文本聊天不开放工具。显式 Workspace 绑定只可通过代理和隔离文件工作进程开放所选的 `file.list`、`file.read`、`file.search` 和 `file.write` 工具。知识与声明式技能来自已接受的资源版本。内置工具、可执行扩展/hook、提示模板、仓库指令和自动资源发现继续禁用。以斜杠开头的输入仍按文本处理。宿主仅接收所选模型凭据和受控环境配置，不读取个人 Pi 身份验证或设置。原生会话文件和清单保留在服务端，并限制访问权限。

Pi 子进程边界本身不是用于执行不可信代码的沙盒。独立文件工作进程只处理有界数据，不执行导入的代码。Shell/构建命令、仓库执行、浏览器操作和用户扩展继续不可用；这些能力需要单独审查的执行提供方。

`.env.example` 中的配置包括：

| 变量 | 提供的值或含义 |
| --- | --- |
| `DATABASE_URL` | `postgres://nexrun:nexrun@127.0.0.1:55439/nexrun` |
| `API_HOST` / `API_PORT` | `127.0.0.1` / `3001` |
| `AGENT_MODE` | `mock`；使用 `pi` 启用已配置的真实 Adapter |
| `PI_PROVIDER` / `PI_MODEL` | `openai` / `gpt-5-mini`；模型在服务端选择 |
| `AGENT_RESPONSE_LANGUAGE` | `auto`、`en` 或 `zh-CN`；独立于 UI 语言的初始回复语言默认值 |
| `PI_STATE_DIR` | `../../.data/pi`，相对于 API 工作区目录解析 |
| `NEXRUN_OPENAI_API_KEY` | 优先使用的项目专用服务端凭据；请私下提供 |
| `OPENAI_API_KEY` | 服务端回退凭据 |
| `NEXRUN_ADMIN_TOKEN` | 可选的长随机令牌；共享部署中的管理访问必须配置 |
| `NEXRUN_CONFIG_ENCRYPTION_KEY` | 可选的稳定 32 字节 base64 密钥；否则使用私有服务端状态 |
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

Playwright 会启动隔离的测试 API/Web 服务，强制使用模拟模式，默认使用端口 3001 和 5173。已安装 Google Chrome 且这些端口空闲的本地机器可运行：

```sh
npm run test:e2e
```

如需保留正在运行的开发应用，可以选择其他空闲测试端口：

```sh
NEXRUN_E2E_API_PORT=3101 NEXRUN_E2E_WEB_PORT=5273 npm run test:e2e
```

测试服务显式允许所选的本机 Web 源，并使用独立生成的数据库模式和临时状态，不改变默认开发配置。

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

2026-11-05 的本地验证通过 typecheck、lint、build、许可检查、全部 **113 个 Node 测试**和 **22 个浏览器场景**，包括真实本地文件工作进程隔离检查，以及确定性 SDK/模型测试样例。真实 Pi 认证仍失败，Sprint 2 最终的模型驱动工作区验收尚未验证。证据边界见 [Sprint 2 记录](docs/sprints/sprint2.zh-CN.md)。

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
| 已有本地 OS/Node 运行时证据 | `docs/dependencies/native-runtime.json` 和[原生运行时审查](docs/dependencies/native-runtime.zh-CN.md) |

新增或升级时，检查实际选定的发布产物、上游源码、LICENSE/NOTICE 文件、打包代码和分发义务。范围应包含直接、传递、开发、可选/原生依赖、复制的源码、资产及额外下载。固定变更版本并更新证据后，再重新生成记录：

```sh
npm run licenses:review
npm run licenses:check
```

`licenses:review` 可以获取本地未安装的平台对应的锁定产物，并重新生成依赖清单、声明和 SBOM。审查生成的变更与所选许可证分支；不要将生成过程视为自动批准。将已审查的锁文件和证据一起提交。`licenses:check` 会拒绝锁文件/证据不一致、未经审查的依赖、不被允许的许可证表达式，以及已记录 shadcn 源码的变更。分发打包产物时保留所需声明。容器镜像、浏览器二进制文件、系统组件和托管服务/模型条款需要单独审查；npm 门禁不能证明拥有所有这些权利。用户填写的知识/技能授权元数据仅记录其声明，平台依赖审查结论不会自动授予导入第三方内容的使用权。

共享的配置或行为变化时，同步维护本 README 及其[完整英文版](README.md)。
