/** projects.ts */

/* 2026-11-13 按职责整段切到同目录的多个文件；本文件只做 re-export，保持原路径的导入方零改动。 */

export { ProjectError, currentProjectEnabled, isInside, projectArchiveChatsEnabled, projectOutsideWorkspaceEnabled, validateProjectRoot, validateWorkspaceRoot } from "./project-types.ts";
export type { Project, ProjectProposal, ProjectRef, ProjectRoot, ProposalStatus, Vcs, Workspace } from "./project-types.ts";
export { resolveProjectPath } from "./project-rows.ts";
export { ProjectsStore } from "./project-store.ts";
export { defaultWorkspaceRoot, mountProjects, projectsStore, resetProjectsStoreForTest, resolveChatDir, resolveDelegationProject, seedDefaultWorkspace, workspaceRootReal, workspaceRootsReal } from "./project-api.ts";
export type { ChatDirPick } from "./project-api.ts";
