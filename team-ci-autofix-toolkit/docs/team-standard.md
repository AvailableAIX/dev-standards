# Team CI Autofix Standard

## 适用范围

这套标准适用于：

- 构建失败
- 类型错误
- lint 错误
- 确定性测试失败
- 依赖或脚本配置错误

不建议直接开启全自动推回的场景：

- flaky test
- 外部服务不稳定
- 需要真实生产数据才能复现
- 支付、权限、安全、计费等高风险域

## 团队统一规则

1. `CI` 是质量门禁真源，`autofix` 只做补救，不改写门禁定义。
2. 默认跳过 fork。
3. 默认跳过受保护分支。
4. 默认限制最大自动修复次数。
5. 默认保留完整日志、summary 和 artifact。
6. 默认不让 Codex 直接 `commit` 或 `push`，这些动作由外层脚本统一控制。
7. 优先复用 self-hosted runner 上本机已有的 Codex 登录态；`OPENAI_API_KEY` 只作为可选兜底。

## 团队落地建议

推荐标准化成两层：

- 中央工具仓库
  - 维护 CLI、runner 模板、workflow 渲染逻辑和团队文档
- 项目仓库
  - 维护 `ci-autofix.config.json`
  - vendor 一份 `tools/ci-autofix/run.mjs`
  - 保留项目自己的验证命令

## 每个项目接入时必须确认

- runner 标签
- `workflowName`
- 允许自动修复的分支范围
- 永远禁止自动修复的分支范围
- 验证命令是否真正能无交互执行
- 是否允许给 PR 自动评论

## 接入流程

```bash
node /Users/sft/Projects/dev-standards/team-ci-autofix-toolkit/bin/ci-autofix.mjs init /path/to/repo
```

然后在目标仓库里：

1. 打开 `ci-autofix.config.json`
2. 改成项目真实的 `validation` 命令
3. 检查 `.github/workflows/ci-autofix.yml`
4. 推送到测试分支
5. 制造一次可回滚的 CI 失败做首轮演练

## 审计与留痕

每次自动修复至少保留：

- workflow run 元数据
- job 列表
- 失败 job 原始日志
- Codex prompt
- Codex 事件输出
- 本地验证 stdout / stderr
- `git commit` / `git push` 输出
- summary markdown / json

## 后续演进建议

- 内部 npm 私包化
- reusable workflow 化
- PR comment 模板统一
- 日志集中汇总到内部 observability 平台
