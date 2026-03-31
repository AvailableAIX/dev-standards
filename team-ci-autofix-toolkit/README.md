# Team CI Autofix Toolkit

面向团队的通用 `CI autofix` 工具仓库。

目标不是把某个项目的 `ci-autofix` 脚本硬拷过去，而是统一成：

- 一份团队规范
- 一份项目配置
- 一套可初始化到任意仓库的骨架

## 目录说明

- `bin/ci-autofix.mjs`
  团队 CLI 入口。
- `src/toolkit.mjs`
  初始化、渲染 workflow、配置校验等通用逻辑。
- `templates/runner.mjs`
  vendored 到业务仓库内的通用执行器。
- `examples/`
  示例项目配置。
- `docs/team-standard.md`
  团队开发指南和接入规范。
- `docs/ci-autofix-config.schema.json`
  项目配置字段参考。

## 推荐用法

1. 为目标仓库生成骨架：

```bash
node /Users/sft/Projects/dev-standards/team-ci-autofix-toolkit/bin/ci-autofix.mjs init /path/to/repo
```

2. 在目标仓库内检查生成结果：

- `ci-autofix.config.json`
- `.github/workflows/ci-autofix.yml`
- `tools/ci-autofix/run.mjs`

3. 根据项目实际情况修改 `validation` 命令。

4. 推送到测试分支，制造一次可回滚的 CI 失败，验证端到端闭环。

## CLI

```bash
node ./bin/ci-autofix.mjs init <repo-dir> [--force]
node ./bin/ci-autofix.mjs validate-config <config-path>
node ./bin/ci-autofix.mjs render-workflow <config-path> [--output <path>]
```

## 核心原则

- `CI` 仍然是质量门禁真源
- `autofix` 只处理 CI 直接相关问题
- 默认跳过 fork 和受保护分支
- 默认限制自动修复次数
- 默认保留完整日志和 artifact
- 默认优先复用 self-hosted runner 上本机已有的 Codex 登录态

详细规范见 [docs/team-standard.md](/Users/sft/Projects/dev-standards/team-ci-autofix-toolkit/docs/team-standard.md)。
