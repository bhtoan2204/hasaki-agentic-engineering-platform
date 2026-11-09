# Multiple developer instances with one PostgreSQL database

Each developer uses their own local config and dataDir, unique persistent instance identity, agent CLI logins and Bitbucket credentials. All instances use the same PostgreSQL registry and the same stable AUTH_SECRET required to decrypt personal integration credentials. Protect that shared encryption key as an organization secret.

Register each remote once through Repositories. Other authorized members see the same logical repository and project mappings immediately. They need no absolute path mapping: the assigned instance clones on first preparation or filesystem execution. Registry reads and ranking never clone. Prepare/Refresh and workspace status apply only to the server instance serving the request. Do not share dataDir across instances.

Instance identity is persisted in dataDir unless PLATFORM_INSTANCE is explicitly configured. Retain dataDir and identity across restarts to recover local worktrees and sessions. Existing platform instance registration and job fencing prevent a second live worker claiming the same identity. Reassigning an offline run does not copy private files; use existing reconciliation/recovery controls and require explicit reconstruction rather than treating another instance's paths as yours.

Repositories are shared metadata, checkouts are local instance state, and writable worktrees/agent directories are run state. A repository may be cloned independently on Linux, macOS or Windows. Managed directory identities are numeric IDs and a safe hash of the instance ID. The Git askpass helper uses Git's shell and Node; automated transport/worktree validation currently runs on Linux. Real Windows/macOS and live Bitbucket smoke tests must be performed in the deployment environment.

Legacy local source overrides remain local configuration for unresolved entries. See [migration instructions](repository-migration.md), [architecture](repositories.md) and [credentials](bitbucket-credentials.md).

This remains application isolation for trusted team members when workers share an OS account. It is not a container or filesystem security boundary. Run mutually untrusted workloads under separate accounts or hosts.
