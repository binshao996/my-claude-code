export type Workspace = {
  id: string;
  name: string;
  rootPath: string;
  openFiles: string[];
};

export type RuntimeWorkspaceContext = {
  workspaceId: string;
  rootPath: string;
  openFiles: string[];
};

export function createWorkspace(input: {
  id: string;
  name: string;
  rootPath: string;
  openFiles?: string[];
}): Workspace {
  return {
    id: input.id,
    name: input.name,
    rootPath: input.rootPath,
    openFiles: input.openFiles ?? [],
  };
}

export function toRuntimeWorkspaceContext(workspace: Workspace): RuntimeWorkspaceContext {
  return {
    workspaceId: workspace.id,
    rootPath: workspace.rootPath,
    openFiles: workspace.openFiles,
  };
}
