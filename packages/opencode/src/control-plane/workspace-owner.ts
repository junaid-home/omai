// A MicroVM workspace is one user's project: the provisioner records who it
// was created for on the row, and only that user may reach the VM. Projects,
// sessions and files carry no owner of their own, so this is the check that
// keeps one user out of another's project.

/** The ID of the user a workspace was provisioned for, if recorded. */
export function of(workspace: { readonly extra?: unknown }) {
  const extra = workspace.extra
  if (!extra || typeof extra !== "object" || !("owner" in extra)) return undefined
  const owner = extra.owner
  if (!owner || typeof owner !== "object" || !("userID" in owner) || typeof owner.userID !== "string") return undefined
  return owner.userID
}

/**
 * Whether a request may use a workspace. `userID` is the signed-in user;
 * machine and single-user local clients carry none and are not limited.
 */
export function permits(userID: string | undefined, workspace: { readonly extra?: unknown }) {
  if (userID === undefined) return true
  return of(workspace) === userID
}

export * as WorkspaceOwner from "./workspace-owner"
