import type { ClientState } from "./domain";

export const initialState: ClientState = {
  activeSection: "workspace",
  runtime: {
    session: null,
    activeTurnId: null,
    isRunning: false,
    events: [
      {
        id: "boot",
        label: "Client shell ready",
        detail: "Fake runtime adapter is available without model keys.",
        tone: "success",
      },
    ],
  },
  chat: {
    prompt: "为当前项目实现一个带权限审计的文件编辑能力",
    messages: [
      {
        id: "welcome",
        role: "assistant",
        content:
          "已加载企业级 AI Coding Agent Client 教学切片。发送任务后可以看到 Chat、Plan、Tool、Permission、Diff、Audit 同步更新。",
        status: "complete",
      },
    ],
  },
  workspace: {
    activeProjectId: "client",
    searchQuery: "",
    projects: [
      {
        id: "client",
        name: "claude-code-client",
        rootPath: "/Users/bin.ke/my-compony/my-claude-code/claude-code/claude-code-client",
        lastOpenedAt: "2026-06-04 09:40",
        trust: "trusted",
      },
      {
        id: "mini",
        name: "claude-code-mini",
        rootPath: "/Users/bin.ke/my-compony/my-claude-code/claude-code/claude-code-mini",
        lastOpenedAt: "2026-06-03 18:12",
        trust: "restricted",
      },
    ],
    files: [
      {
        id: "src",
        name: "src",
        path: "src",
        kind: "directory",
        children: [
          {
            id: "app",
            name: "App.tsx",
            path: "src/App.tsx",
            kind: "file",
            language: "tsx",
          },
          {
            id: "store",
            name: "clientStore.ts",
            path: "src/store/clientStore.ts",
            kind: "file",
            language: "ts",
          },
          {
            id: "runtime",
            name: "fakeRuntime.ts",
            path: "src/runtime/fakeRuntime.ts",
            kind: "file",
            language: "ts",
          },
        ],
      },
      {
        id: "package",
        name: "package.json",
        path: "package.json",
        kind: "file",
        language: "json",
      },
    ],
  },
  editor: {
    activePath: "src/App.tsx",
    openFiles: [
      {
        path: "src/App.tsx",
        language: "tsx",
        content: `export function ClientShell() {\n  return <main>Agent workspace ready</main>;\n}\n`,
        savedContent: `export function ClientShell() {\n  return <main>Agent workspace ready</main>;\n}\n`,
      },
      {
        path: "src/store/clientStore.ts",
        language: "ts",
        content: `export function reduceRuntimeEvent(state, event) {\n  return state;\n}\n`,
        savedContent: `export function reduceRuntimeEvent(state, event) {\n  return state;\n}\n`,
      },
    ],
  },
  terminal: {
    command: "pnpm typecheck",
    lines: [
      { id: "term-1", kind: "input", text: "$ pnpm dev" },
      {
        id: "term-2",
        kind: "output",
        text: "VITE v8 ready in 412 ms - Local: http://127.0.0.1:5174/",
      },
    ],
  },
  agent: {
    plan: [
      { id: "plan-1", title: "读取 workspace 与最近会话", status: "done" },
      { id: "plan-2", title: "生成文件编辑 patch", status: "running" },
      { id: "plan-3", title: "等待权限审批后落盘", status: "pending" },
    ],
    tools: [
      {
        id: "tool-seed",
        name: "read_workspace",
        input: { cwd: "claude-code-client" },
        output: "2 open files, 1 active session",
        status: "success",
      },
    ],
    permissions: [
      {
        id: "perm-seed",
        toolName: "write_file",
        reason: "需要修改 src/App.tsx 以接入 diff viewer",
        risk: "medium",
        status: "pending",
      },
    ],
  },
  diff: {
    activeProposalId: "diff-seed",
    proposals: [
      {
        id: "diff-seed",
        filePath: "src/App.tsx",
        title: "Add enterprise client status strip",
        before: `return <main>Agent workspace ready</main>;`,
        after: `return <main>\n  <StatusStrip policy="review" audit="enabled" />\n  Agent workspace ready\n</main>;`,
        status: "pending",
      },
    ],
  },
  sessions: {
    activeSessionId: "session-001",
    items: [
      {
        id: "session-001",
        workspaceId: "client",
        title: "Build enterprise client shell",
        status: "running",
        updatedAt: "2026-06-04 09:45",
        turns: 8,
      },
      {
        id: "session-002",
        workspaceId: "mini",
        title: "Review runtime adapter boundary",
        status: "complete",
        updatedAt: "2026-06-03 20:18",
        turns: 14,
      },
    ],
  },
  plugins: {
    items: [
      {
        id: "policy-pack",
        name: "Enterprise Policy Pack",
        version: "1.2.0",
        capabilities: ["command", "tool"],
        enabled: true,
        verified: true,
      },
      {
        id: "review-panel",
        name: "Architecture Review Panel",
        version: "0.8.4",
        capabilities: ["panel"],
        enabled: false,
        verified: true,
      },
      {
        id: "sandbox-tools",
        name: "Sandbox Tool Suite",
        version: "0.4.1",
        capabilities: ["tool", "panel"],
        enabled: false,
        verified: false,
      },
    ],
  },
  governance: {
    policies: [
      {
        id: "policy-1",
        name: "写入受保护路径",
        scope: "src/**, packages/**",
        effect: "review",
      },
      {
        id: "policy-2",
        name: "外部网络请求",
        scope: "fetch, curl, package install",
        effect: "deny",
      },
      {
        id: "policy-3",
        name: "只读诊断命令",
        scope: "git status, typecheck, test",
        effect: "allow",
      },
    ],
    audits: [
      {
        id: "audit-1",
        actor: "agent",
        action: "requested_permission",
        target: "write_file src/App.tsx",
        at: "2026-06-04 09:46:22",
        severity: "review",
      },
      {
        id: "audit-2",
        actor: "user",
        action: "enabled_plugin",
        target: "Enterprise Policy Pack",
        at: "2026-06-04 09:41:06",
        severity: "info",
      },
    ],
    release: {
      current: "0.1.0",
      available: "0.1.1",
      compatibility: "compatible",
    },
  },
};
