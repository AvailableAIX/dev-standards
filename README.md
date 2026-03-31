# dev-standards

团队开发约定与参考文档的集中存放仓库，便于在多个项目间复用同一套规范说明。

## 目录说明


| 目录                                                   | 内容                                                   |
| ---------------------------------------------------- | ---------------------------------------------------- |
| [python/](python/)                                   | Python 包管理与虚拟环境规范（`uv`）                              |
| [js-ts/](js-ts/)                                     | JavaScript/TypeScript 与包管理规范（`pnpm`），以及 npm 代理仓库配置说明 |
| [cicd/](cicd/)                                       | 基于 Gitea Actions 与自建 Runner 的 CI/CD 基线说明             |
| [team-ci-autofix-toolkit/](team-ci-autofix-toolkit/) | 通用 CI autofix CLI：团队规范、项目配置、可初始化到任意仓库的骨架             |


## 文档索引

- **Python**：[python/python.mdc](python/python.mdc) — 依赖与虚拟环境使用 `uv`，避免默认使用 `pip` / `poetry`（除非项目另有说明）。
- **JS/TS**：[js-ts/javascript.mdc](js-ts/javascript.mdc) — 使用 `pnpm`；核心代码优先 TypeScript。
- **npm 代理**：[js-ts/npm缓存代理仓库配置.md](js-ts/npm缓存代理仓库配置.md) — Verdaccio 内网 registry 配置示例。
- **Gitea CI/CD**：[cicd/Gitea CICD Guideline.mdc](cicd/Gitea%20CICD%20Guideline.mdc) — 工作流目录、Runner、群晖 NAS 部署等基线。
- **CI Autofix 工具包**：[team-ci-autofix-toolkit/README.md](team-ci-autofix-toolkit/README.md) — `init` / `validate-config` / `render-workflow`；规范见 [team-ci-autofix-toolkit/docs/team-standard.md](team-ci-autofix-toolkit/docs/team-standard.md)。

## 关于 `.mdc` 文件

带 YAML 前置元数据（`description`、`globs` 等）的 `.mdc` 文件可按 [Cursor Rules](https://docs.cursor.com/context/rules) 的方式引用，用于在对应文件类型或场景下自动应用规范；也可当作普通 Markdown 阅读。

## 使用方式

- 在本仓库内直接查阅或更新文档。
- 在其他仓库中可将本仓库作为子模块、或复制所需片段到项目内的 `.cursor/rules` / 团队 Wiki，保持与这里同步。
- 需要为业务仓库接入 CI autofix 时，按 [team-ci-autofix-toolkit/README.md](team-ci-autofix-toolkit/README.md) 使用 CLI 生成骨架并调整验证命令。

