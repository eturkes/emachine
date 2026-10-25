# emachine v1 contracts

## Boundaries

Linux MoonBit machine servers own local projects. Clients aggregate servers; servers never coordinate. The FreeBSD gateway is optional. Managed projects receive no emachine-owned files. Independent feature source, state, releases and checkpoints live outside managed projects. Initial projects expose only the built-in terminal. Trusted features run as the user's normal account.

## Client transport

Each saved connection: `{id?: string, name: string, direct: string, gateway?: string}`. Addresses are HTTP(S) base URLs, normalized with a trailing slash; gateway URLs may contain a path prefix. HTTPS is required except localhost. Add relative endpoint paths to the selected base; never discard a gateway prefix. Machine identity comes from the server, not its URL. Prefer direct; retain an established route until it fails. Preserve cached project rows for offline machines. Never replay terminal input across reconnection.

Inventory requests start with a 4.5-second deadline for prompt route fallback. A route that times out receives 15 seconds on its next attempt, then up to 30 seconds; retain that allowance after success for the current client session. Retry the last successful route first. Job-history recovery has a 30-second deadline and is cancelled when its connection is replaced or stopped.

Event and terminal sockets send heartbeats every 10 seconds. After more than 30 seconds without a message, detach the stale socket locally and retry without waiting for its close handshake. Visibility, online, pageshow and window-focus wakeups replace sockets silent for more than 25 seconds immediately. Ignore callbacks from detached sockets; preserve mounted views, independent healthy terminals and server sessions. Disconnected terminal input is dropped. Regression coverage runs in Chromium and WebKit through `tests/recovery.spec.ts`.

`GET bootstrap.json` returns `{servers: Connection[]}`. The server serves its own bootstrap; a static host or desktop bundle may provide a seed list. Absence is allowed; show machine setup. Store editable connections and theme locally. Do not store terminal output or project data in the service-worker cache.

`GET api/v1/health` -> `{ok: true, protocol: 1}`.

`GET api/v1/state` -> State:
```
{
  protocol: 1,
  machine: {id: string, name: string, version: string, projectRoot: string},
  projects: [{id: string, name: string, path: string,
    phase?: "PROTOTYPE" | "ITERATE" | "IMPLEMENT" | "MAINTAIN" | "UNKNOWN" | null,
    claudeStatus?: "working" | "completed" | "waiting" | null,
    features: [{id: string, title: string, revision: string, entry: string,
                status: "ready" | "stale", updatedAt: number}],
    diagnostics: [{feature: string, message: string, updatedAt: number}]}]
}
```
`entry` is relative to the selected server base, including a content-addressed revision. Features are project-owned; empty features means terminal only. The client supplies the terminal tab itself. The composite workspace key is machine ID + project ID. Diagnostics do not replace working features.

Discovery excludes the immediate `.snapshots` and `.pnpm-store` directories, including previously registered identities. Clients also filter those exact names from older inventories and offline caches. Other dot-prefixed directories remain eligible.

`phase` is additive sidebar metadata. Older servers can omit it; clients then show no phase label.
A root `CLAUDE.md` file enables the label. Without that file, `phase` is `null`.
The source is `.agent/spec.md`, not Git history or a feature artifact.
Its `Phase` heading starts the declaration; a standalone `Phase:` field is also accepted.
The current scoped form is `<PHASE> — <scope>`. The scope must be nonempty, with whitespace on both sides of the dash.
The active line sets the label. Later unquoted lines in that section must be valid `Suspended: <PHASE> — <scope>` entries. Suspended scopes do not change the label, even when they name the same phase.
Older bare phase tokens and narrative declarations remain supported. Emphasis and letter case are accepted; examples, comments, and quoted request lines are ignored.
Multiple active declarations, malformed scoped state, unsupported tokens, missing files, and read failures yield `UNKNOWN`.
Reads accept only regular spec files within the project, up to 1 MiB.
Inventory events carry changes to the phase or eligibility without remounting project views. No source text is exposed in the inventory.

`claudeStatus` is optional live sidebar metadata, independent of `phase` and `CLAUDE.md`.
The server reads Claude Code's local `sessions/<pid>.json` registry under `CLAUDE_CONFIG_DIR` or `~/.claude`.
Interactive sessions map `busy` and `shell` to `working`, `idle` to `completed`, and `waiting` to `waiting`.
Completed means Claude Code is idle and ready for another prompt; it is not a claim that the task succeeded.
Match canonical session working directories to a project or its descendants.
For multiple sessions, waiting takes priority over working, then completed.
Validate the process owner, kernel start stamp, and supplied PID domain before showing a session.
Dead processes, absent or unsupported metadata, and unreadable records produce no indicator.
Read at most 512 records of 64 KiB each; accept only regular files inside the session directory.
No transcripts, key files, prompts, tool output, or socket credentials are exposed.
Inventory polling updates all projects without terminal attachments or configuration changes.
Clients hide indicators while disconnected and exclude live status from offline caches.
Older servers can omit the field; their sidebar appearance stays unchanged.

`WS api/v1/events` sends `{type:"inventory", state: State}` on connection and on changes. Reconnection receives a fresh inventory; clients reconcile changed feature revisions without remounting unrelated frames or terminals. Also tolerate `{type:"job", job: Job}` and `{type:"error", message:string}`.

## Terminal

`GET api/v1/prompts` returns `{prompts: [{id: string, title: string, body: string, steered: boolean}]}` under the existing API authorization and `no-store` policy.
The server reads Markdown templates from its user's `~/.local/app/agents/claude/prompts/{auto,steered}/` directories on demand. Single-body IDs remain paths relative to the agents repository. Named sections append `/sections/NAME`, with `%` and `/` escaped as `%25` and `%2F`. Repeated names append `/body/SHA256` of the extracted body; identical duplicates append `/2`, `/3`, and so on. IDs stay stable when uniquely named sections move or their bodies change. Distinct bodies with the same name keep their identity when reordered. Titles include the file title, section name when present, and variant.
Automatic prompts appear first. Each group is sorted by filename; sections retain source order. The reader accepts immediate, regular UTF-8 `.md` files up to 1 MiB and skips README files, malformed templates, and paths outside the prompt directory.
A single-body template supplies everything below its first standalone `---` rule. When a `## Section` heading immediately precedes that rule, with optional blank lines, the file instead supplies named sections. Each section starts with that heading and opening rule and ends at the next standalone `---`. Boundary padding, section labels, and rules stay outside the body; body headings, indentation, and line endings are preserved. Fenced and indented code cannot introduce boundaries. Empty bodies, missing closing rules, and invalid steering slots are skipped.
Steered bodies have a leading standalone `<request>` or `<rows>` slot. The catalog removes that slot, and the client replaces it with the user's nonblank steering plus a blank line.
The client normalizes line endings to LF for the native text preview and removes final line endings. Both copy and paste use that preview text. It never sends on selection, typing, loading, or reconnecting. Paste uses the guarded terminal paste path and adds no Enter key.
Prompt bodies and steering stay outside inventory, events, persistent client storage, and the service-worker cache. Drafts are local to each terminal pane and prompt until the page closes. A successful catalog reload removes drafts for IDs that are no longer present, so a later section cannot inherit a removed section's draft.
Older servers may return `404`; the selector explains the required server update without affecting the terminal.

`WS api/v1/terminal/{projectId}?cols=100&rows=30` attaches a zmx session named exactly after the current project. The server inherits `ZMX_DIR`; otherwise, zmx resolves its normal socket directory. An existing manual SSH session is reused, including its working directory and shell state. A missing session starts in the project directory. Every browser connection gets its own native attachment; disconnection closes only that attachment. The session survives machine-server restarts. After a project rename, new attachments use the new name; existing attachments remain intact.

`WS api/v1/terminal/general/{session}?cols=100&rows=30` uses the same authorization, Origin checks, namespace, and terminal messages. The session is `general` or `generalN`, where N is an integer of at least 2 without leading zeroes; names have at most 48 ASCII characters. A new session starts in the server user's home directory. This route does not require a project. Closing a General tab closes only its attachment. Rooms share control by exact zmx session name across both terminal routes, including a project named `general` or `generalN`.

General tab state belongs to each machine in the client: open session names, selected session, and the next number survive reload. Tabs attach lazily. Closing a tab preserves its zmx session and does not reuse its number for the next new tab. An existing session with the next name is attached without resetting its shell state.

Server binary frames contain raw terminal bytes. Server text frames:
- `{type:"state", session:string, mode:"control"|"observe", cols:number, rows:number}`.
- `{type:"error", message:string}`.
- `{type:"pong"}`.

Client binary frames contain raw UTF-8 input, accepted only from the controller. Client text frames:
- `{type:"resize", cols:number, rows:number}` (controller only, dimensions 2..500).
- `{type:"claim"}` (explicit take-control action).
- `{type:"ping"}`.

First connection controls; others observe until claiming control or controller disconnection. All native attachments use the controller's dimensions. Observer terminals render those dimensions instead of resizing the shared shell. Clear the browser terminal before reconnecting: zmx replays terminal state. Do not interpret terminal OSC as authority to read clipboard or open external URLs automatically.

The controller policy applies only to Emachine clients. Manual zmx attachments can also send input and affect terminal dimensions.

## Feature frames and jobs

Serve a feature in an independent iframe, not in the shell DOM. It is trusted code, not a security sandbox. Give it optional camera/microphone permission delegation, subject to browser prompts. Preserve frame instances across tab switches. On revision changes replace only the affected frame. Do not install legacy plugins by default.

On iframe load, send `{type:"emachine:context", protocol:1, machine, project, feature, baseUrl, theme:"dark"|"light"}` with an exact target origin. The frame may send `{type:"emachine:ready"}` to request context or `{type:"emachine:error", message:string}` for render diagnostics. Validate message source against the actual frame. Theme changes resend context. Provide the same CSS tokens in shell and optional SDK styling.

`POST api/v1/projects/{project}/features/{feature}/jobs` body `{action:string, input: any}` starts an action declared by the active feature manifest. `GET api/v1/jobs/{id}` returns Job; `GET api/v1/jobs/{id}/log` returns bounded text. A job is server-owned, not frame-owned. No automatic restart or retry after interruption.

Job: `{id:string, project:string, feature:string, action:string, status:"running"|"succeeded"|"failed"|"interrupted", startedAt:number, finishedAt?:number, exitCode?:number, message?:string}`.

## Local feature source

A feature workspace has `feature.json` plus source files. Manifest:
```
{"id":"pipeline","title":"Pipeline","entry":"index.html",
 "output":".","build":[],"refresh":"manual","watch":[],"actions":{}}
```
IDs: lower-case ASCII `[a-z0-9][a-z0-9-]{0,47}`; `terminal` is reserved. `build` is an argv array, not an interpolated shell string. `output` and `entry` stay inside the feature workspace/build output; reject symlink/path traversal. An empty build uses existing static files. `actions` maps action names to argv arrays. Input is JSON on stdin. The runtime sets `EMACHINE_PROJECT`, `EMACHINE_FEATURE`, `EMACHINE_STATE`, `EMACHINE_ARTIFACTS`, `EMACHINE_JOB` and runs actions inside the immutable active release. Builds run inside the editable external workspace. Worker logs/artifacts stay external. The process has ordinary account permissions.

`refresh:"manual"` marks results stale after matching input changes; it never runs an action automatically. An `analyze` feature stays stale until analysis succeeds for its active revision. `watch` is a list of project-relative files/directories. Cheap deterministic features may explicitly request `refresh:"automatic"` with an `analyze` action; bound concurrent execution and coalesce changes. Never infer expensive agent/model execution permission from a file change.

## Activation

A local CLI handles list/create/begin/activate/remove/checkpoint/restore. Management operates on user-owned local files under locks; there is no remote activation endpoint or management token. Validate and build candidates before publication. Releases are immutable; atomically replace per-project active metadata. Failed validation/build preserves the active release and records diagnostics. Candidate source remains editable. Same feature IDs in different projects remain independent. A latest-request generation prevents older builds from overwriting newer ones. Source and mutable state checkpoints have separate timing; restore only a named emachine-owned boundary, never a managed project.

## Access

Backend binds loopback. Trust verified Tailscale identity only from the local Serve path; public forwarding additionally requires a gateway secret and existing Caddy authentication. Reject unconfigured browser origins for API requests and WebSocket upgrades. Client secrets never enter URLs, frontend bundles or logs. CORS uses exact configured origins. Public access must not be anonymous. The desktop shell has no Node integration or privileged renderer bridge; its separate gateway-login dialog has only a scoped credential-submit channel.
