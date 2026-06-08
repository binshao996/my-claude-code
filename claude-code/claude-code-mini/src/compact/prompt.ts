export function buildCompactPrompt(customInstructions?: string): string {
  const extra = customInstructions
    ? `\n\n用户额外要求：\n${customInstructions}\n`
    : "";

  return `你要为一个 AI Coding Agent 的长会话生成继续工作摘要。

请只输出摘要正文，不要调用工具。

摘要必须保留：
1. 用户的主要目标和最新明确要求。
2. 已经做过的关键步骤。
3. 修改、读取、创建过的重要文件路径。
4. 重要代码结构、函数名、配置项和命令。
5. 遇到过的错误以及修复方式。
6. 尚未完成的任务。
7. 下一步应该继续做什么。

写作要求：
- 使用中文。
- 按条目组织。
- 不要编造没有出现过的文件、命令、API 或结果。
- 如果某个信息不确定，明确写"不确定"。
${extra}`;
}

export function buildCompactSummaryMessage(summary: string): string {
  return `以下是此前对话的压缩摘要。后续工作必须把它当作历史上下文继续执行。

${summary}`;
}
