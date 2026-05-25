# Refactor Docs

本目录只记录“源码级 1:1 复刻 Claude Code”的重构线。这里的完成标准高于旧的 `docs/08-version-roadmap.md` 和 `docs/11-strict-1to1-parity-roadmap.md`。

旧版本线曾经使用 manifest mapping、feature coverage、symbol evidence、local runtime tests 来证明阶段性 parity。新的 refactor 线不再接受这种标准。

## 文档

1. [Source-First 1:1 Refactor Plan](./01-source-first-1to1-refactor-plan.md)
2. [PJM Roadmap](./02-pjm-roadmap.md)
3. [True Source 1:1 Refactor Roadmap](./03-true-source-1to1-roadmap.md)

注意：`02-pjm-roadmap.md` 记录的是第一轮 refactor 计划和历史执行结果；它曾把“镜像覆盖 + golden evidence”作为阶段完成口径。真正最终验收以后只看 `03-true-source-1to1-roadmap.md` 和 `bun run parity:true-1to1`。

## 核心原则

- `claude-code/` 是唯一规格源。
- 本仓库必须向 Claude Code 的源码结构、模块边界、entrypoint、package surface、runtime side effect、TUI 行为和测试 fixture 靠齐。
- 旧的 `docs/strict-parity-manifest.json` 只能作为迁移索引，不能作为完成证明。
- 所有 many-to-one mapping 都是重构债务，不能作为最终形态。
- 任何版本只有通过结构 diff、export diff、行为 golden diff、transport smoke、native smoke、upstream fixture diff，才允许标记完成。
- 最终 1:1 必须通过 `parity:true-1to1`：完整文件树 diff 0、byte hash diff 0、structure marker 0、many-to-one debt 0。
