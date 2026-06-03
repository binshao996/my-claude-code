# AI Coding Agent 工程真实案例复盘

这份文档补充主文档里的“真实踩坑”。它不追求覆盖所有经验，而是把几个高频、隐蔽、代价大的事故拆开讲清楚。

每个案例都按同一结构写：

- 背景
- 错误 Prompt
- AI 的错误输出
- 问题为什么发生
- 排查过程
- 最终修复
- 修正后 Prompt
- 可复用经验

## 案例 1：Tool Calling ID 对不上，模型反复调用同一个工具

### 背景

在实现 Claude Code Mini 的 Tool Calling 闭环时，链路大致是：

```text
model response tool_use
-> Tool Registry 查找工具
-> execute(tool_input)
-> append tool_result
-> second model call
```

现象是：模型已经调用过 `write_file`，工具也确实执行成功，但下一轮模型继续要求调用同一个 `write_file`，像是完全没看到结果。

### 错误 Prompt

```text
Agent 一直重复调用 write_file，帮我优化一下工具调用 Prompt，让它不要重复。
```

### AI 的错误输出

AI 一开始建议在 system prompt 里加：

```text
如果工具已经调用成功，不要重复调用同一个工具。
```

还建议在工具结果里追加：

```text
The tool has completed successfully. Do not call it again.
```

这些改动表面合理，但没有解决问题。

### 问题为什么发生

真实原因不是模型“不听话”，而是 `tool_result` 的 `tool_use_id` 没有和上一轮 `tool_use.id` 对上。

模型收到的消息等价于：

```json
{
  "type": "tool_result",
  "tool_use_id": "generated-local-id",
  "content": "ok"
}
```

但上一轮模型发的是：

```json
{
  "type": "tool_use",
  "id": "toolu_01abc",
  "name": "write_file",
  "input": {}
}
```

对模型来说，这不是同一个工具调用的结果。它只能继续等待原始 `toolu_01abc` 的结果，于是重复调用。

### 排查过程

正确排查不是先改 Prompt，而是按 Agent Loop 节点查：

1. 打印 streaming event，确认模型发出的 `tool_use.id`。
2. 打印 Tool Registry 查找结果，确认工具被执行。
3. 打印 append 到 messages 的 `tool_result.tool_use_id`。
4. 打印下一轮 model call 的完整 messages 投影视图。
5. 对比 `tool_use.id` 和 `tool_result.tool_use_id`。

真正的断点出现在第 3 步。

### 最终修复

修复方向：

- Tool runner 必须把原始 `tool_use.id` 传入 execute result builder。
- `tool_result.tool_use_id` 必须直接使用原始 id。
- 不允许在本地重新生成 tool result id。
- 增加测试：同一个 `tool_use.id` 必须出现在下一轮 message 的 `tool_result.tool_use_id`。

核心验收不是“模型不重复调用”，而是消息结构正确：

```text
assistant.tool_use.id === user.tool_result.tool_use_id
```

### 修正后 Prompt

```text
现象：模型重复调用 write_file。不要先改 system prompt。

请按 Tool Calling 链路排查：
1. 找到 assistant tool_use 的原始 id。
2. 找到 append 到下一轮 messages 的 tool_result.tool_use_id。
3. 判断二者是否一致。
4. 如果不一致，只修 ID 传递链路。

约束：
- 不修改工具行为。
- 不新增“不要重复调用”的 Prompt。
- 增加一个单元测试覆盖 tool_use.id 与 tool_result.tool_use_id 匹配。
```

### 可复用经验

Tool Calling 问题优先查协议结构，不要先调 Prompt。

模型重复调用工具，经常不是模型意图问题，而是：

- tool result id 对不上。
- tool result 没进入下一轮 messages。
- tool result 被 compact/truncate 裁掉。
- tool schema 和 tool result 格式不符合 provider 协议。

## 案例 2：Context Compaction 按消息裁剪，切断 tool_use/tool_result 配对

### 背景

长会话进入自动压缩时，最初实现是按 token 从旧到新裁剪 messages：

```text
保留最近 N 条消息
把更旧消息总结成 compact summary
```

压缩后模型开始出现异常：它认为某个工具还没有返回，或者继续追问一个已经完成的工具结果。

### 错误 Prompt

```text
上下文太长了，帮我保留最近消息，把旧消息总结一下。
```

### AI 的错误输出

AI 生成了一个简单策略：

```text
messages.slice(-recentCount)
```

再把前面的消息拼成摘要。这个策略对普通聊天看起来可行，但对 Agent Loop 是错的。

### 问题为什么发生

Coding Agent 的一轮不是单条消息，而是一个 API round。

典型结构是：

```text
assistant: text + tool_use(id=A)
user: tool_result(tool_use_id=A)
assistant: 根据结果继续
```

如果裁剪点落在 `assistant tool_use` 和 `user tool_result` 中间，模型会看到一个悬空的工具调用。

这不是摘要写得好不好，而是消息协议被破坏。

### 排查过程

排查时不要只看 token 数，要检查消息边界：

1. 找 compact 前后的 message 列表。
2. 标出每个 assistant response 里的 `tool_use.id`。
3. 标出每个 user message 里的 `tool_result.tool_use_id`。
4. 检查压缩后是否存在 unmatched tool_use 或 unmatched tool_result。
5. 检查 compact boundary 是否记录了 preserved segment。

### 最终修复

修复策略：

- 不按单条 message 裁剪，改成按 API round 分组。
- 裁剪前先识别 tool_use/tool_result 配对。
- 保留窗口不能从配对中间开始。
- compact boundary 记录 `preservedSegment`，恢复时可以验证边界。
- 增加测试：裁剪点落在工具配对中间时必须向前或向后扩展。

### 修正后 Prompt

```text
实现 Context Compaction 时，不允许按单条 message 直接 slice。

请先定义 API round：
- assistant tool_use
- 对应 user tool_result
- 后续 assistant response

压缩规则：
- 不切断 tool_use/tool_result 配对。
- compact summary 必须保留当前目标、已改文件、失败测试、未完成决策。
- compact boundary 必须记录 trigger、preTokens、preservedSegment。

验收：
- 测试裁剪点落在 tool_use/tool_result 中间。
- 测试恢复后不存在 unmatched tool_use。
```

### 可复用经验

Context Compression 不是文本摘要功能，而是会话状态重写协议。

只要系统里有 Tool Calling、Streaming、Permission、Sub-agent，就不能把 conversation 当普通 chat history 处理。

## 案例 3：Todo 全完成后直接总结，跳过 Verification Gate

### 背景

在多步骤开发任务中，Agent 用 todo 追踪进度：

```text
1. 修改 parser
2. 更新 command
3. 补测试
```

当 todo 全部标记 completed 后，模型直接向用户总结“已完成”。但实际只跑了 typecheck，没有运行相关行为测试。

### 错误 Prompt

```text
完成所有 todo 后总结你做了什么。
```

### AI 的错误输出

AI 输出：

```text
已完成 parser 修改、command 接入和测试更新。整体实现已完成。
```

但没有证据证明 command 路径真的调用了新 parser。

### 问题为什么发生

Todo completed 只是任务状态，不是交付证据。

模型有一个常见倾向：当内部计划全部打勾后，它会自然进入总结模式。这个行为来自“帮助用户收尾”的对话模式，但工程上会导致提前交付。

### 排查过程

排查方式：

1. 检查最后一轮 assistant 总结前是否存在 verification run。
2. 检查测试命令是否覆盖真实入口。
3. 检查 todo 完成事件是否触发 verification nudge。
4. 检查交付逻辑是否区分 completed todo 和 verified delivery。

### 最终修复

修复策略：

- Todo 工具在 3 个以上任务全部 completed 且没有验证记录时，返回 nudge。
- Delivery Gate 检查最新 verification run。
- verification verdict 只允许 `PASS` 时交付。
- `PARTIAL` 和 `FAIL` 必须继续修复或说明缺口。
- 主 Agent 不能自己给 verification verdict，必须由只读 verifier 或真实命令证据产生。

### 修正后 Prompt

```text
当 todo 全部完成时，不要直接总结完成。

交付前必须检查：
1. 是否运行了与改动相关的最小验证命令。
2. 验证是否覆盖真实用户入口。
3. 是否存在 FAIL 或 PARTIAL。

输出规则：
- 有 PASS 证据才能说完成。
- 没有验证只能说实现已修改，验证未完成。
- FAIL 后先修复，不要总结。
```

### 可复用经验

Todo 是进度管理，不是质量门禁。

复杂工程必须把“任务完成”和“交付可用”拆开：

```text
completed todos != verified delivery
```

## 案例 4：签名校验函数存在，但没有接入插件安装链路

### 背景

实现插件供应链安全时，AI 写了 signature verifier：

```text
verifyPluginSignature(pluginDir, lockfile)
```

单元测试也通过了。但实际安装插件时，仍然可以安装未签名或签名不匹配的插件。

### 错误 Prompt

```text
帮我实现插件签名校验，并补测试。
```

### AI 的错误输出

AI 新增了：

- `signatureVerifier.ts`
- `signatureVerifier.test.ts`
- 若干 hash/signature 解析函数

测试覆盖了 verifier 的纯函数行为，但安装流程没有调用它。

### 问题为什么发生

Prompt 要求“实现签名校验”，但没有要求“接入真实安装链路”。

AI 很容易把工程能力理解成“新增一个模块”，而不是“改变用户路径行为”。

### 排查过程

排查时看三件事：

1. 安装入口在哪里。
2. 安装入口是否 import verifier。
3. 校验失败是否阻止复制插件目录。
4. 测试是否覆盖 install command，而不是只测 verifier。

结果发现 verifier 没有被任何安装路径调用。

### 最终修复

修复策略：

- 在 install pipeline 中加入 signature verification step。
- 校验失败时阻止安装，并记录 audit event。
- lockfile 中记录已授权的 plugin digest。
- 增加集成测试：签名不匹配时 install 失败，插件目录不落盘。
- 保留纯函数测试，但不把它当成交付证据。

### 修正后 Prompt

```text
目标不是只写 verifier 函数，而是让插件安装路径强制执行签名校验。

请先找到真实 install pipeline，然后实现：
1. 安装前计算 plugin digest。
2. 校验 digest/signature/lockfile consent。
3. 失败时阻止安装。
4. 成功时写入 lock record。
5. 记录 audit event。

测试必须覆盖 install 入口：
- 签名不匹配 -> install 失败。
- 插件目录不能被复制到目标位置。
```

### 可复用经验

安全能力必须接入主链路。纯函数存在不等于安全策略生效。

凡是认证、权限、签名、审计、沙箱，都要问一句：

```text
攻击者走真实入口时，这段代码会不会执行？
```

## 案例 5：临时调试规则进入长期 Memory，后续任务持续跑偏

### 背景

某次调试 API fallback 时，为了快速定位问题，临时告诉 AI：

```text
接下来优先跳过 provider fallback，直接看 firstParty 请求。
```

后来这个规则被写进了长期 memory。几天后处理 OpenAI/Gemini 兼容层问题时，AI 仍然默认绕过 fallback 逻辑，导致排查方向错误。

### 错误 Prompt

```text
记住：以后调 API 问题时，优先跳过 fallback，直接看 firstParty。
```

### AI 的错误输出

后续任务里，AI 自动套用了这个规则：

```text
先忽略 OpenAI/Gemini provider，检查 firstParty Claude 请求。
```

但当前 bug 恰好发生在 provider routing 和 fallback adapter。

### 问题为什么发生

Memory 没有分层。

临时调试策略被当成长期工程偏好保存，后续任务无法区分：

- 用户稳定偏好。
- 项目长期架构决策。
- 当前任务临时假设。
- 已废弃调试路径。

### 排查过程

排查不是只看当前 Prompt，而要看 memory 注入：

1. 打印本轮请求前注入的 memory。
2. 找到“跳过 fallback”的来源。
3. 判断它是用户偏好、项目规则还是临时任务状态。
4. 检查 memory 是否有过期机制或分类字段。

### 最终修复

修复策略：

- Memory 分层：user preference、project rule、architecture decision、task note。
- 临时调试假设只进 task note，不进长期 memory。
- task note 在任务结束后归档或删除。
- 长期 memory 写入前必须问：这个规则是否跨任务稳定有效。
- Context 注入时标注 memory 类型和时间。

### 修正后 Prompt

```text
这是一条临时调试假设，不要写入长期 memory：
- 当前只为定位 firstParty 请求问题，暂时跳过 fallback 分支。

任务结束时请判断：
- 这个假设是否被证实？
- 是否需要删除？
- 是否有任何内容值得升级为 project rule？

除非我明确说“长期记住”，否则不要把临时调试策略保存为长期偏好。
```

### 可复用经验

Memory 是长期上下文，不是垃圾桶。

写入 memory 前必须分类：

```text
稳定偏好？
项目规则？
架构决策？
临时任务状态？
已废弃假设？
```

不能分类的信息，不应该长期保存。

## 总结

这 5 个案例背后是同一个原则：AI 工程失败经常不是“模型写错一行代码”，而是协作系统缺少边界。

- Tool Calling 需要协议边界。
- Context Compaction 需要消息边界。
- Verification 需要交付边界。
- Supply Chain 需要主链路边界。
- Memory 需要生命周期边界。

遇到 AI 跑偏时，不要只追加 Prompt。先问：

```text
这个问题缺的是指令，还是缺工程边界？
```

大多数复杂事故，缺的都是后者。
