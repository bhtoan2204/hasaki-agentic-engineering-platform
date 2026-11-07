# Repository registry and local workspaces

The shared PostgreSQL registry identifies repositories by a canonical HTTPS Bitbucket Cloud URL. Logical names and existing numeric IDs remain stable. Names continue to connect project mappings, dependencies, knowledge, historical runs and artifacts. No remote identity is inferred from a local folder name. `remote_slug` is maintained as a compatibility projection for existing Bitbucket tools, not an independently editable identity. Workspace and slug are parsed from the URL rather than stored in separate columns.

`src/repos/remote.ts` validates and canonicalizes URLs. Only `https://bitbucket.org/<workspace>/<slug>[.git]` is accepted. Case is normalized, an optional trailing slash is removed and `.git` is appended. Credentials, ports, queries, fragments, escaped paths, traversal and alternate hosts or schemes are refused. A partial unique PostgreSQL index prevents aliases of the same canonical remote.

`src/repos/paths.ts` resolves local paths without cloning. `src/repos/workspaces.ts` provisions only for filesystem access or an explicit prepare/index request. Ranking and registry reads use PostgreSQL metadata. New registry entries are created through the existing administrator API and Repositories page; members may prepare and use enabled repositories with read permission. Write and publication permissions are checked again when executing.

Managed paths use stable IDs:

```text
<dataDir>/repositories/<sha256(instance-id)[0:32]>/<repository-id>/checkout
<dataDir>/worktrees/<sha256(instance-id)[0:32]>/<run-id>/<repository-id>
<dataDir>/worktrees/<sha256(instance-id)[0:32]>/<run-id>/agent
```

The hash safely encodes existing instance IDs, which may contain filesystem separators. Each instance owns independent clones; each run owns its writable worktrees and agent directory. A PostgreSQL session advisory lock keyed by instance and repository serializes clone, fetch and worktree provisioning. Process death releases the lock. Interrupted clones use a reserved `clone.partial` directory, removed on retry; existing checkouts are never deleted automatically. Origins and local roots are verified before reuse. Fetch updates refs without resetting a developer's checkout. Git refuses simultaneous worktrees of the same branch; the platform reports the conflict rather than borrowing another run's worktree.

Run execution continues through the existing instance pin, instance heartbeat ownership, job lease/fencing token, run owner and tool authorization. Recorded worktree paths and session directories remain authoritative for legitimate local resume. A registry URL migration does not move those files. Recovery checks origin and common Git directory before reuse. An offline instance cannot transfer private local files to a different instance.

Default branches come from registry metadata, with the installation default retained for legacy fixtures. Branch creation, publication, code indexing, review evidence, command test baselines and reports resolve the repository branch. Claude, Codex and Cursor use the same run directory and platform workspace tools. Tree-sitter indexing and ripgrep resolve the same local sources. Index jobs retain their requesting principal; run overlay jobs use the persisted run owner. Startup indexing remains an explicit existing schedule and may provision enabled repositories using an explicitly configured service account.

Benchmark repositories retain their existing explicit `provider: benchmark` fixture lifecycle and are excluded from ordinary registry discovery. Legacy `provider: local` and filesystem registrations remain internal compatibility mechanisms; new public registrations require URLs.

## Operations

1. An administrator adds a Bitbucket repository URL, default branch and project mappings on Repositories.
2. PostgreSQL stores identity, permissions and metadata.
3. A member selects a work item and the platform ranks authorized repositories from metadata.
4. The assigned worker resolves the run owner's personal Bitbucket credentials, or an authorized configured service account.
5. The worker prepares its own clone and validates remote identity.
6. It fetches refs and creates an isolated run worktree.
7. The selected agent makes changes and runs tests in authorized worktrees.
8. The platform pushes with temporary authentication and creates a PR in the URL's workspace, targeting its default branch.
9. Outputs, artifacts, sessions and execution workspace records persist through the existing workflow lifecycle.

The repository detail page exposes connection testing, clone/preparation, refresh and local status. Status includes only the current instance identity and repository ID, never a private local path. The availability check performs no network request. Clone activity/errors are process-local observations; after restart availability is reconstructed from disk. Git errors exposed to users contain actionable guidance and no raw subprocess output.

Separate directories provide application isolation, not OS security boundaries. Workers and agent CLIs running as one OS user can read that user's files. Use distinct OS accounts or isolated worker hosts for mutually untrusted members. Do not share dataDir or an instance ID across live installations.


## Compatibility retained during production cleanup

A read-only inspection during cleanup found 26 registry rows with `repository_url IS NULL`. Legacy layout hints, local overrides, configured-source discovery, the explicit migration CLI, fixture paths and persisted worktree recovery therefore remain supported. Nothing in cleanup applies repository migrations or rewrites shared identity. See the [cleanup evidence and blockers](../validation/production-cleanup.md).

The exact legacy Bitbucket SSH-to-HTTPS translation now lives in `src/repos/remote.ts` and is reused by Git, origin validation and explicit migration. New registration still requires strict HTTPS validation. Clone/fetch authentication remains centralized in `src/repos/git.ts`; personal/shared credential resolution remains in `src/bitbucket.ts`. A PR operation resolves its principal's credentials once for its HTTP requests; the next operation rereads rotated credentials. No credentials are cached across operations.

Run authorization and the saved repository workspace are resolved in one database lookup. Preparation retains the separate post-provisioning authorization and fencing checks, origin checks, containment checks and repository locks. The repository list does not request detail-only index status; the detail view retains all existing controls and localization.
