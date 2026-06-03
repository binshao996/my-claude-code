# 06 - 发布、升级与回滚

## 当前章节目标

本章定义企业级发布流程。

## 发布内容

- desktop app。
- runtime sidecar。
- plugin compatibility metadata。
- migration scripts。
- release notes。

## 升级策略

```text
download
  -> verify signature
  -> install
  -> migrate
  -> smoke check
  -> rollback if failed
```

## 兼容性

升级不能破坏：

- sessions。
- workspace metadata。
- plugin settings。
- audit logs。

## Runtime / Client / Plugin 兼容矩阵

| 组件 | 升级风险 | 必须检查 |
| --- | --- | --- |
| Client | UI state schema 变化 | settings migration |
| Runtime sidecar | event schema 变化 | adapter compatibility |
| Plugin | manifest 或 tool schema 变化 | lockfile + policy |
| Session | transcript schema 变化 | resume smoke test |
| Audit | 字段变化 | redaction contract |

发布流程要先验证矩阵，再进入灰度；失败时回滚到上一个 Client / Runtime / Plugin 组合。

## 本章交付

本章交付 Release Compatibility Matrix 和升级 smoke check。

发布前必须检查：

- Client settings migration。
- Runtime event schema adapter。
- Plugin manifest/tool schema 和 lockfile。
- Session transcript resume。
- Audit redaction contract。

升级失败时要能解释回滚目标：上一个 Client / Runtime / Plugin 组合。

## Smoke Check

执行：

```bash
pnpm dev
pnpm typecheck
pnpm test
```

用一份模拟 release manifest 验证：

- UI 显示 Client / Runtime / Plugin / Session / Audit 兼容矩阵。
- 不兼容 plugin 被禁用并写入 reason。
- transcript schema 变化会触发 resume smoke test。
- redaction contract 失败会阻止发布。
- rollback plan 显示上一个可用版本组合和迁移回退状态。

## 当前章节缺陷

本章不实现具体 auto updater。

## 下一章预告

下一章会收束企业级架构闭环，并给出源码阅读路线。
