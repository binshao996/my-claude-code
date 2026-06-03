# 07 - 企业级架构闭环

## 当前章节目标

本章判断 Client 是否形成企业级闭环。

## 闭环标准

```text
Workspace
  -> Editor
  -> Terminal
  -> Agent
  -> Diff
  -> Session
  -> Plugin
  -> Policy
  -> Audit
  -> Release
```

如果一个模块不能被审计、不能被策略约束、不能在失败后恢复，它就还不是企业级能力。

## 最终交付

- [Claude Code Client 全景架构图](../../claude-code-client-architecture-map.md)
- [Claude Code Client 源码阅读路线图](../../claude-code-client-source-reading-roadmap.md)

## 调试验证

闭环验证不靠单一页面截图，而是逐项检查：

- V0-V10 README 都能从总 README 跳转。
- 每个版本都有架构图或清晰结构说明。
- Runtime / Client 边界没有被后续章节反转。
- 权限、插件、diff、terminal 都能进入 Policy 或 Audit 解释。
- 示例骨架能跑通一次伪 Runtime 事件流。

## 本章交付

本章交付闭环检查清单，而不是新增页面。

Closure checklist：

- Workspace：所有文件、session、plugin 都有 workspace scope。
- Editor：写入、refresh、dirty buffer 都有失败边界。
- Terminal：输出预算和权限决策可解释。
- Agent：tool event、plan、diff decision 可进入 timeline。
- Diff：Accept / Reject 可审计、可恢复。
- Session：Resume / Continue 按项目隔离。
- Plugin：manifest、registry、tool、panel、supply chain 可被 policy 约束。
- Policy：能解释来源、锁定和拒绝原因。
- Audit：记录决策，不记录 secrets。
- Release：兼容矩阵和回滚路径明确。

## Smoke Check

执行：

```bash
pnpm dev
pnpm typecheck
pnpm test
```

最后跑一条端到端人工检查：

- 打开 workspace，执行一次 Agent 修改，审查并 Accept/Reject diff。
- session timeline 能看到 message、tool、diff decision。
- 启用再禁用一个插件，command/tool/panel 状态同步变化。
- enterprise policy 禁止一个插件来源后，Marketplace、Registry、Permission、Audit 都能解释原因。
- 导出 diagnostics 后确认不含 secrets。
- Release compatibility matrix 能说明当前 Client / Runtime / Plugin 组合是否可发布。

## 当前章节缺陷

本章完成的是教学闭环，不等于生产闭环。

生产版还需要远程策略服务、fleet management、集中审计平台、真实插件市场和长期兼容性测试。

## 下一步预告

教程主线到 V10 收束。后续可以回补或深化：

- V9 Marketplace / supply chain。
- Remote session。
- Background task。
- Multi-agent。
- Enterprise admin console。
