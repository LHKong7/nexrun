# 依赖审查

[英文版](README.md)

如果锁文件、已安装软件包的许可证据或复制的 shadcn 源码在未审查的情况下发生变化，`npm run licenses:check` 会失败。`inventory.json` 记录每个精确锁定的发布产物，包括可选的平台归档；`sbom.cdx.json` 记录解析后的组件集合。`THIRD_PARTY_NOTICES.txt` 保留实际许可证和声明材料。

新增或升级依赖前，按照仓库政策检查精确发布版本及其传递依赖。使用 `npm install --ignore-scripts`，再运行 `npm run licenses:review` 收集实际归档证据。此命令需要注册表访问和 `tar`；它是证据生成器，不是自动批准。提交前阅读失败信息、完整许可文本、捆绑声明及生成的差异。缺少许可文件时，必须在 `upstream-licenses/index.json` 中提供适用于该发布版本的上游证据；不得仅凭未经核实的许可证字段绕过门禁。

部分发布者未在 npm 归档中包含许可文件。补充记录标明上游修订、发布者链接的授权或相同版本父包的声明，并解释适用依据。`dlv` 声明保留精确发布版本 README 中的明确 MIT 声明，并附上标准 MIT 条款及发布作者署名。未知或不兼容条款仍会被阻止。多重许可证表达式记录实际选用的宽松分支；所有 `AND` 义务仍然适用。

有意固定 Vite 7、Tailwind 3 和 Rollup 4.43，避免引入未经批准的 copyleft CSS 处理组件，以及不必要且声明证据不完整的可选二进制组件。不要盲目升级。复制的 shadcn Base UI 源码来自官方注册表；其内容指纹、来源 URL、修改说明和固定修订的上游 MIT 文本记录在 `shadcn-sources.json` 与 `vendor/shadcn/LICENSE` 中。

应用依赖扫描不等于审计整个操作系统。固定的 PostgreSQL 镜像是上游开发和 CI 服务，不是 NexRun 捆绑的应用镜像。GitHub Actions 和测试浏览器作为外部开发工具运行。交付客户托管版本前，需要分别审查其条款以及实际操作系统和镜像内容。Chromium/Chrome 及其第三方声明不会随 Web 打包产物重新分发。本 Sprint 不交付生产容器镜像。

许可证检查和 SBOM 用于支持审查，不能替代实际义务，也不代表取得模型服务的使用权。OpenAI 凭据仅保留在服务端；模型访问与 Pi 软件包许可证分别验证。
