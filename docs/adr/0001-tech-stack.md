# ADR 0001: V0.1 技术栈锁定

## 状态

Accepted

## 决策

- Runtime 使用 Bun，版本下限 `>=1.3.0`。
- 语言使用 TypeScript strict mode。
- CLI 使用 `@commander-js/extra-typings`。
- Runtime schema 使用 `zod/v4`。
- Lint/format 使用 Biome。
- 仓库采用 workspace monorepo，V0.1 包边界为：
  - `@my-claude-code/core`
  - `@my-claude-code/model-provider`
  - `@my-claude-code/cli`

## 参考源码

- `claude-code/package.json`
- `claude-code/tsconfig.json`
- `claude-code/biome.json`
- `claude-code/src/main.tsx`
- `claude-code/packages/@ant/model-provider`
- `claude-code/packages/agent-tools`

## 约束

- 产品目标 provider 固定为 `deepseek-v4-flash`。
- 内部事件和工具协议保持 Claude-compatible。
- V0.1 不做真实网络调用，只用 fixtures 验证 DeepSeek/OpenAI-compatible streaming parser。
