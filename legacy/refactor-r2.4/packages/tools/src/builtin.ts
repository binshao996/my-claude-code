import type { ProviderTool } from '@my-claude-code/model-provider'
import {
  agentWorkflowStateTool,
  jobClassifyTool,
  messageActionTool,
  reviewArtifactMutationTool,
  scheduleCronListTool,
  scheduleCronRunDueTool,
  scheduleCronTool,
  verificationAgentTool,
  workflowEventTool,
} from './tools/agentWorkflows.js'
import { askUserQuestionTool } from './tools/askUserQuestion.js'
import { bashTool } from './tools/bash.js'
import { configTool } from './tools/config.js'
import { computerUseInputTool, computerUseTool } from './tools/computerUse.js'
import { ctxInspectTool } from './tools/ctxInspect.js'
import { editTool } from './tools/edit.js'
import { enterPlanModeTool } from './tools/enterPlanMode.js'
import { exitPlanModeV2Tool } from './tools/exitPlanMode.js'
import { globTool } from './tools/glob.js'
import { grepTool } from './tools/grep.js'
import { localMemoryRecallTool } from './tools/localMemoryRecall.js'
import { lspTool } from './tools/lsp.js'
import {
  agentMemorySnapshotTool,
  extractMemoriesTool,
  memoryRankTool,
  sessionMemorySnapshotTool,
  teamMemorySyncTool,
} from './tools/memoryParity.js'
import { notebookEditTool } from './tools/notebookEdit.js'
import { overflowTestTool } from './tools/overflowTest.js'
import { powerShellTool } from './tools/powerShell.js'
import { readTool } from './tools/read.js'
import { replTool } from './tools/repl.js'
import { reviewArtifactTool } from './tools/reviewArtifact.js'
import { sendUserFileTool } from './tools/sendUserFile.js'
import { snipTool } from './tools/snip.js'
import { syntheticOutputTool } from './tools/syntheticOutput.js'
import { sleepTool } from './tools/sleep.js'
import { sendMessageTool, teamCreateTool, teamDeleteTool } from './tools/team.js'
import { testingPermissionTool } from './tools/testingPermission.js'
import { todoWriteTool } from './tools/todoWrite.js'
import { tungstenTool } from './tools/tungsten.js'
import { webBrowserTool } from './tools/webBrowser.js'
import { webFetchTool } from './tools/webFetch.js'
import { webSearchTool } from './tools/webSearch.js'
import { vaultHttpFetchTool } from './tools/vaultHttpFetch.js'
import { verifyPlanExecutionTool } from './tools/verifyPlanExecution.js'
import { writeTool } from './tools/write.js'
import type { Tool } from './types.js'
import { getEcosystemTools } from './ecosystem.js'
import { getRemoteTools } from './remote.js'
import { getWorkflowTools } from './workflows.js'

export function getBuiltinTools(): Tool[] {
  return [
    readTool,
    globTool,
    grepTool,
    todoWriteTool,
    askUserQuestionTool,
    enterPlanModeTool,
    exitPlanModeV2Tool,
    syntheticOutputTool,
    testingPermissionTool,
    configTool,
    ctxInspectTool,
    messageActionTool,
    verificationAgentTool,
    reviewArtifactMutationTool,
    jobClassifyTool,
    scheduleCronTool,
    scheduleCronRunDueTool,
    scheduleCronListTool,
    workflowEventTool,
    agentWorkflowStateTool,
    sleepTool,
    localMemoryRecallTool,
    memoryRankTool,
    extractMemoriesTool,
    agentMemorySnapshotTool,
    sessionMemorySnapshotTool,
    teamMemorySyncTool,
    sendUserFileTool,
    snipTool,
    notebookEditTool,
    replTool,
    powerShellTool,
    lspTool,
    reviewArtifactTool,
    verifyPlanExecutionTool,
    sendMessageTool,
    teamCreateTool,
    teamDeleteTool,
    overflowTestTool,
    webBrowserTool,
    computerUseTool,
    computerUseInputTool,
    webFetchTool,
    webSearchTool,
    vaultHttpFetchTool,
    tungstenTool,
    editTool,
    writeTool,
    bashTool,
    ...getEcosystemTools(),
    ...getWorkflowTools(),
    ...getRemoteTools(),
  ]
}

export function toolsToProviderTools(tools: Tool[]): ProviderTool[] {
  return tools.map(tool => ({
    name: tool.name,
    description: tool.description,
    input_schema: tool.inputJSONSchema,
  }))
}
