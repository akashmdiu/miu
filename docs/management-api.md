# Management API development

The management integration is under development. Its HTTP handler, dashboard,
queue and direct CLI now share admission. Passing synthetic checks does not
qualify a managed Miu installation.

The proposed API uses `/management/v1` on the dashboard listener. Service
credentials are separate from browser sessions. Requests require a scoped
Bearer credential even on loopback; cookie and Origin headers are refused.
Plain HTTP is accepted only from loopback. Remote access requires TLS.
Managed mode also requires a browser account for legacy dashboard controls;
loopback does not imply an owner session. Owner setup codes are excluded from
server output. A human obtains the code with `node bin/miu-manage owner-setup`
in a private foreground terminal and completes the existing browser setup.
Agents must not invoke that display command in a PTY or capture its output.

| Operation | Scope |
| --- | --- |
| `GET /health`, `GET /capabilities` | `health:read` |
| `GET /app` | `app:read` |
| `POST /requests` | `runs:submit`, `runs:trusted` |
| `GET /requests/:id` | `runs:read` |
| `GET /requests` | `runs:read` |
| `GET /requests/:id/result` | `runs:read` |
| `POST /requests/:id/cancel` | `runs:cancel` |
| `GET /requests/:id/evidence` | `evidence:read` |

Submission requires `Idempotency-Key` and a closed JSON object containing
`repo`, `pr`, `baseSha`, `headSha`, `model`, and `trust: "trusted"`.
`mode` defaults to `report-only`; `publish` additionally requires `runs:publish`.
Both service configuration and the credential must allow the repository.
The server binds its selected `plan` or `api` authentication mode to the
admitted intent; clients cannot provide or override that field.
Request bodies are limited to 16 KiB and responses to 64 KiB. The handler's
default deadline is five seconds. A timeout does not establish whether a
submitted operation took effect: look up the same request identity before retrying.

The local owner can provision a credential with `node bin/miu-manage
credential-set --id <id> --scope <scope> --repository <owner/repo> --stdin`.
Repeat `--scope` and `--repository` for additional grants. Supply a separately
generated credential through protected stdin, never through arguments. The
command prints only principal metadata. `credential-revoke --id <id>` revokes
that principal. `--directory` selects an absolute private state directory;
the default is `~/.config/miu/management`. This tool does not generate or print
credentials. Browser App setup remains a human operation.

The credential store contains salted digests and grants. It rejects unsafe
permissions, symlinks and unsupported data. Provisioning is atomic; an uncertain
durability result is reported without claiming success. Authentication rereads
the store so revocation applies to subsequent requests.

`RequestStore` uses Node's built-in SQLite API, requiring Node 22.13 or later.
The installer already selects Node 24. Request identity and the single capacity
slot are reserved in one transaction before launch. Identical retries return
the existing request using its admitted authentication mode, even if that engine
has since been disabled or its mode changed; changed caller intent is refused.
Current principal scopes and repository grants still apply. There is no automatic key
expiry, PID-based takeover or uncertain-launch replay. The default retention
limit is 10,000 requests; reaching it refuses new admissions.

`ManagedRuns` keeps live child handles separate from retained records. A new
controller reports retained state and cannot signal a persisted PID. Terminal
completion requires a worker acknowledgement bound to the request, run and
revisions, successful cleanup (including verified absence after an agent-account removal fallback), child closure, and a positive observation that
the owned process group has stopped. Missing proof records `unknown_effect`
and retains capacity. Cancellation persists intent and sends an IPC message;
delivery alone does not prove cancellation. Evidence currently exposes only
bounded metadata for fixed filenames, excluding symlinks and arbitrary paths.

Managed GitHub calls use repository-scoped App installation tokens. They
refuse environment, saved-token and `gh` fallback, caller-supplied tokens,
repository widening and automatic request retries. Legacy behavior outside
the managed policy remains available. The IPC worker applies this policy before importing or running the QA body.
Managed requests stay on the GitHub API origin, refuse redirects and bound
provider response bodies to 8 MiB before parsing.
Legacy behavior remains available when management has not been configured.

The worker launcher checks revisions through a bounded, read-only preflight
before creating a run directory or starting a child. It refuses existing run
directories and unsafe worker paths. The child receives an explicit environment
allowlist and its admitted record over IPC; GitHub tokens, Composer credentials
and ambient Git configuration are excluded. A known refusal before spawn can
finish as failed and release capacity. Any uncertain child effect retains it.

The internal `bin/qa-worker` receives admission over IPC before importing the
QA body. Its extracted `runQa` returns an outcome instead of terminating the
supervisor. Resource finalizers await fast checks and environment cleanup;
cancellation reaches both AI runners. Managed runs pin the submitted revisions,
disable implicit paired runs, and keep reports and images local. Managed
publication uses GitHub only. Dependency commands receive a separate home to
avoid ambient Git and Composer authentication. These worker changes are connected to the public entrypoints and still require
verification and review.

Remaining acceptance includes interruption and cleanup checks, actual HTTP and
CLI entrypoint checks, installed-version provenance, and qualification
on an approved disposable Ubuntu 24.04 host. No live App, QA run, installation
or provider connectivity has been verified by the module checks.

## Enable management

Start the existing dashboard with explicit management authority and an owned
run root:

```sh
node bin/qa-dashboard --management --management-dir /absolute/private/state --runs /absolute/runs
```

The state directory is owner-only and holds the immutable versioned service
configuration, credential digests, request database and evidence metadata. The
run root must be owned by the service account and must not be writable by a
group or by others. Existing permissions are checked, never repaired. New
directories start as mode 0700. A separate agent receives named ACL traversal
on the run parent and access to its own run; this does not grant access to the
management state directory. Linux ACL behavior remains a live qualification
requirement.

Subsequent dashboard starts use the configured run root. Direct `qa-run` starts
use the same default state directory, or the explicitly supplied
`--management-dir`. With management configured, `--request-id` supports an
explicit replay: the same arguments resolve the retained request, and changed
arguments conflict. No new worker starts on a replay. A custom `--run-dir` must
be directly under the configured run root. Configured runs use App-only
identity; Slack notices are refused.
Configured CLI runs default to report-only; publication requires `--publish`.
The admitted intent binds the configured `plan` or `api` authentication mode.
Disabled engines are refused, and policy changes before launch cannot select a
different sign-in source. A conflicting replay remains inspectable by its
original request identity.
Managed records retain their admitted model. Legacy fix, review and repost
controls cannot authorize new effects for them; publication is selected in a
separate explicitly authorized request.

The dashboard queue saves its request identity and input before admission and
removes the entry only after acceptance. A held or uncertain request is not
replaced with a new identity. Retained or unknown records are protected from
the legacy crash cleanup and pruning paths.
Queue replacement is atomic and synced before admission. A separate
kernel-held database lease permits one dashboard queue writer; process death
releases that lease while active request reservations remain durable.

After proven worker closure and process-group cessation, the controller saves
bounded metadata for Miu-owned report files in the private state directory. It
does not expose raw logs, arbitrary files or report content. This metadata
snapshot accommodates ACL-shared run folders without using their contents as
cleanup or release authority. Missing metadata while a run is active is not
completion proof. Unknown external publication effects retain capacity rather
than triggering a retry.

The result endpoint returns the finite QA verdict, run mode and attributed
site identities from the worker's completion data, together with the request's
pinned revisions. It returns `null` until that data has been validated and
saved after shutdown and cleanup. Request state tracks execution and cleanup;
the result field reports the QA verdict. Logs and private response fields are
excluded. The dashboard labels uncertain outcomes and protects their run slot.
Request listing returns at most 25 records belonging to the authenticated
principal and its currently configured repositories. Send the returned
`nextCursor` in `X-Miu-After-Request` to read the next page. Listing does not
launch or replay work.

`runs:trusted` grants authority to execute the selected PR's code on a trusted
shared host. Require a prior trust decision before issuing that scope.

The supervised worker receives an explicit environment. Installed agent CLI,
agent library, Codex working-directory, browser-binary, and sealing-key locator
configuration is retained only as absolute paths. Secret values and ambient
GitHub tokens are excluded; agent subprocesses apply their own environment filter.
