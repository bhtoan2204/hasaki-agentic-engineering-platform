# GitLab

GitLab (gitlab.com and self-hosted instances such as gitlab.example.work) is the third Git host next to Bitbucket and
GitHub. It uses the same registry, grants, worktrees, push path, PR recording and workflow definitions. Nothing in the
workflow engine knows about GitLab: it calls `gitProviderFor(repository.provider)`.

## Provider seam

| Part         | Where                                                | What it does                                                                                                             |
| ------------ | ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| URL identity | `src/repos/remote.ts`                                | Accepts `https://<allowed host>/<group>[/<subgroup>...]/<project>[.git]` and canonicalises it to lower case with `.git`. |
| Host adapter | `src/git/hosts.ts`                                   | Git transport credentials (`oauth2` + token), extra Git options (internal CA), label and access policy per host.         |
| REST adapter | `src/gitlab.ts`, registered in `src/git/provider.ts` | Merge requests, diffs, discussions, comments, approvals and mergeability, merge, close, pipelines, jobs and job logs.    |
| Shared model | `src/git/model.ts`                                   | Provider-neutral change request, pipeline and merge-readiness types, and the shared merge policy.                        |
| Access check | `src/repos/access.ts`                                | Per-host verifier map; GitLab asks `GET /projects/:id` with the user's own token.                                        |

Adding another host needs one URL rule in `remote.ts`, one entry in `gitHosts`, one `GitProvider` adapter with
`registerGitProvider(name, adapter)`, one verifier in `access.ts`, and one clause in the `repositories_remote_canonical`
constraint. `gitProviderFor` maps a null or empty provider to Bitbucket (legacy rows) and refuses unknown values.

The unified methods (`getPullRequest`, `pullRequestChanges`, `pullRequestDiscussions`, `commentOnPullRequest`,
`mergeReadiness`, `mergePullRequest`, `closePullRequest`, `pipelines`, `jobLog`) are optional on `GitProvider`. GitLab
implements all of them. GitHub and Bitbucket currently implement push, open-or-update and state only; the agent tools
answer "unsupported for <provider>" for the rest.

## Instances (self-hosted)

```json
"gitlab": {
  "instances": [
    { "host": "gitlab.com" },
    {
      "host": "gitlab.example.work",
      "caFile": "/etc/ssl/certs/hasaki-ca.pem",
      "sshHostKeys": ["ssh-ed25519 AAAA…"],
      "sshPort": 22
    }
  ],
  "token": "",
  "allowSharedCredentials": false,
  "accessVerification": "strict",
  "requestTimeoutMs": 30000,
  "maxRetries": 3
}
```

- Only hosts in `instances` are accepted as repository URLs. The API base is always `https://<host>/api/v4`, derived
  from the canonical URL, so a token is never sent to a host that is not configured. There is no free-form base-URL
  column. The UI "instance" field picks one of these hosts.
- Exact host match, case-insensitive. Ports and instances under a relative URL root (`https://host/gitlab`) are not
  supported.
- `caFile` is a PEM bundle for an internal CA. Git transport uses it with `http.https://<host>/.sslCAInfo`. For the
  REST API, add the same CA to the system store (the server starts with `--use-system-ca`) or set
  `NODE_EXTRA_CA_CERTS`. TLS verification is never disabled.
- Upgrade every instance that shares the PostgreSQL database before registering a GitLab repository. Older instances
  do not know the provider. Migration `060_gitlab_repositories.sql` only widens the URL constraint and adds
  `repositories.delete_source_branch`; existing rows are unchanged.

## Tokens and minimum permissions

Each member saves their own token per instance under **Integrations → GitLab** (user secret `gitlab_token:<host>`,
encrypted like the other personal credentials). Saving checks the token first
(`GET /personal_access_tokens/self`, then `GET /user`) and reports authentication (401), permission (403/404),
connectivity (DNS, TLS, timeout) and missing-scope failures separately. **Test connection** re-checks a saved token.
The token is never returned to the browser.

| Use                                                  | Token                            | Scopes                                            | Role on the project                                                          |
| ---------------------------------------------------- | -------------------------------- | ------------------------------------------------- | ---------------------------------------------------------------------------- |
| Full workflow (push, MR, comments, pipelines, merge) | Personal or project access token | `api`                                             | Developer; Maintainer only where protected-branch rules require it for merge |
| Read and push only (no MR API)                       | Personal or project access token | `read_api`, `read_repository`, `write_repository` | Developer                                                                    |

A project access token works for one project only; use a personal access token when one member works on several
projects. A token is not a platform grant: an administrator still grants each repository. The shared `GITLAB_TOKEN`
is used only when `gitlab.allowSharedCredentials` is true, and never decides what a user may access.

Git over HTTPS authenticates as `oauth2` with the token through the existing askpass helper: the token exists only in
the short-lived child environment, never in arguments, `remote.origin.url`, Git config or error text. Job logs and
error text are passed through `redactSecrets`, which masks `glpat-`-style tokens, `PRIVATE-TOKEN:` headers and
credentials embedded in URLs.

### SSH transport

Git over SSH is available per instance and per user:

1. An operator pins the instance's SSH host keys in `config.gitlab.instances[].sshHostKeys` (the `<type> <base64>`
   part of `ssh-keyscan` output, verified out of band), plus `sshPort` when it is not 22. Without pinned keys SSH is
   off for that instance and cannot be enabled from the UI.
2. Each member saves an unencrypted OpenSSH private key for that instance under **Integrations → GitLab → SSH key**
   (user secret `gitlab_ssh_key:<host>`). Passphrase-protected keys are refused because Git runs non-interactively.
   Add the matching public key to the member's GitLab account (or as a deploy key with write access).

When both exist for the run owner, every fetch, clone and push for that repository uses SSH:

- the key and a `known_hosts` file holding only the pinned keys are written as 0600 files in the per-call temp
  directory and removed afterwards;
- `GIT_SSH_COMMAND` is `ssh -F /dev/null -i <key> -o IdentitiesOnly=yes -o IdentityAgent=none -o BatchMode=yes
-o StrictHostKeyChecking=yes -o UserKnownHostsFile=<pinned> -o GlobalKnownHostsFile=/dev/null`; an unknown or
  changed host key fails with "SSH host key verification failed", it is never accepted;
- only `protocol.ssh` is allowed on that call, and the canonical HTTPS URL is rewritten to SSH with a command-line
  `url.<ssh>.insteadOf=<https>`, so `remote.origin.url` and Git config keep the HTTPS identity and never hold a key.

The access token is still required for the REST API (merge requests, pipelines) and for permission verification; SSH
replaces only the Git transport. Detected SSH origins (`git@host:group/project.git`, `ssh://git@host:port/...`) of
allow-listed hosts map to the same HTTPS identity.

## API client behaviour

- `PRIVATE-TOKEN` header, `redirect: "error"`, a per-request timeout (`requestTimeoutMs`).
- 429 waits for `Retry-After` (capped at 30 s); 502/503/504 and network errors back off exponentially; at most
  `maxRetries` attempts.
- Lists follow `x-next-page` (or `Link: rel="next"`) up to a page cap and report `truncated` instead of pretending the
  list is complete.
- Typed errors: `GitlabAuthError` (401), `GitlabPermissionError` (403/404), `GitlabConnectivityError`,
  `GitlabHttpError`. No error carries a response body, header or token.

## Merge requests and CI in workflows

- The PR step pushes the branch and opens or updates the MR for source → target (idempotent; a draft run creates a
  `Draft:` MR; an update keeps the MR's current draft status). The MR URL is stored in `pull_requests` like any PR, and
  the latest pipeline of the branch is added to the step output and log when GitLab reports one.
- Read-only agent tools, for every provider that supports them: `git.pull_request` (state and merge readiness),
  `git.pull_request_diff`, `git.pull_request_discussions`, `git.pipelines` and `git.job_log` (tail of a failed job,
  redacted), plus `git.repository` (default and protected branches). They only read repositories in the run's allowed
  set and only MRs of that repository.
- Review comments: when the run has review steps (`{ approved | verdict, findings, summary }`), the PR step posts their
  findings as one comment on the MR through `provider.commentOnPullRequest` (secrets masked). A hidden marker
  (`<!-- platform-review:run-<id> -->`) makes retries skip it. No agent tool can post comments; posting failures are
  logged and never fail the published MR.
- PR state sync (`syncPullRequestStates`) maps `opened` → OPEN, `merged` → MERGED, `closed` → DECLINED.

## Merge policy

Merging is never automatic and never an agent tool. The run owner merges or closes from the run page
(`POST /api/pull-requests/:id/merge|close`); both successful and refused actions are audited. At that moment the
server:

1. requires the acting user to own the run and to still hold `pull_request` permission on the repository
   (`requireRunRepositoryAccess`);
2. evaluates the shared merge policy (`evaluateMergeReadiness`): the MR is open and not a draft, GitLab's
   `detailed_merge_status` is `mergeable`, there are no conflicts, approvals given ≥ required, the head pipeline
   succeeded (a running, failed, canceled or missing-but-required pipeline refuses), and anything unknown refuses;
3. merges with `sha=<checked head>` so a push in between makes GitLab refuse (409), and
   `should_remove_source_branch` from the repository's **Delete source branch on merge** setting (default off).

GitLab still enforces protected branches and approval rules on its side; the platform never pushes to a protected
branch directly. On GitLab Free, merge request approval rules are not enforced. When the approvals endpoint is unavailable
(403/404), the platform records zero required approvals and the UI labels approvals "not enforced on this tier".
