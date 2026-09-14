# emachine v1 contracts

## Boundaries

Linux MoonBit machine servers own local projects. Clients aggregate servers; servers never coordinate. The FreeBSD gateway is optional. Managed projects receive no emachine-owned files. Independent feature source, state, releases and checkpoints live outside managed projects. Initial projects expose only the built-in terminal. Trusted features run as the user's normal account.

## Client transport

Each saved connection: `{id?: string, name: string, direct: string, gateway?: string}`. Addresses are HTTP(S) base URLs, normalized with a trailing slash; gateway URLs may contain a path prefix. HTTPS is required except localhost. Add relative endpoint paths to the selected base; never discard a gateway prefix. Machine identity comes from the server, not its URL. Prefer direct; retain an established route until it fails. Preserve cached project rows for offline machines. Never replay terminal input across reconnection.

`GET bootstrap.json` returns `{servers: Connection[]}`. The server serves its own bootstrap; a static host or desktop bundle may provide a seed list. Absence is allowed; show machine setup. Store editable connections and theme locally. Do not store terminal output or project data in the service-worker cache.

`GET api/v1/health` -> `{ok: true, protocol: 1}`.

`GET api/v1/state` -> State:
```
{
  protocol: 1,
  machine: {id: string, name: string, version: string, projectRoot: string},
  projects: [{id: string, name: string, path: string,
    features: [{id: string, title: string, revision: string, entry: string,
                status: "ready" | "stale", updatedAt: number}],
    diagnostics: [{feature: string, message: string, updatedAt: number}]}]
}
```
`entry` is relative to the selected server base, including a content-addressed revision. Features are project-owned; empty features means terminal only. The client supplies the terminal tab itself. The composite workspace key is machine ID + project ID. Diagnostics do not replace working features.

`WS api/v1/events` sends `{type:"inventory", state: State}` on connection and on changes. Reconnection receives a fresh inventory; clients reconcile changed feature revisions without remounting unrelated frames or terminals. Also tolerate `{type:"job", job: Job}` and `{type:"error", message:string}`.

## Terminal

`WS api/v1/terminal/{projectId}?cols=100&rows=30` attaches one persistent project zmx session. Creation happens on first attachment. Every browser connection gets its own native attachment; disconnection closes only that attachment. The session survives machine-server restarts.

Server binary frames contain raw terminal bytes. Server text frames:
- `{type:"state", session:string, mode:"control"|"observe", cols:number, rows:number}`.
- `{type:"error", message:string}`.
- `{type:"pong"}`.

Client binary frames contain raw UTF-8 input, accepted only from the controller. Client text frames:
- `{type:"resize", cols:number, rows:number}` (controller only, dimensions 2..500).
- `{type:"claim"}` (explicit take-control action).
- `{type:"ping"}`.

First connection controls; others observe until claiming control or controller disconnection. All native attachments use the controller's dimensions. Observer terminals render those dimensions instead of resizing the shared shell. Clear the browser terminal before reconnecting: zmx replays terminal state. Do not interpret terminal OSC as authority to read clipboard or open external URLs automatically.

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
IDs: lower-case ASCII `[a-z0-9][a-z0-9-]{0,47}`. `build` is an argv array, not an interpolated shell string. `output` and `entry` stay inside the feature workspace/build output; reject symlink/path traversal. An empty build uses existing static files. `actions` maps action names to argv arrays. Input is JSON on stdin. The runtime sets `EMACHINE_PROJECT`, `EMACHINE_FEATURE`, `EMACHINE_STATE`, `EMACHINE_ARTIFACTS` and runs inside the external feature workspace. Worker logs/artifacts stay external. The process has ordinary account permissions.

`refresh:"manual"` marks results stale after matching input changes; it never runs an action automatically. `watch` is a list of project-relative files/directories. Cheap deterministic features may explicitly request `refresh:"automatic"` with an `analyze` action; bound concurrent execution and coalesce changes. Never infer expensive agent/model execution permission from a file change.

## Activation

A local CLI handles list/create/begin/activate/remove/checkpoint/restore. Management uses a local control token, never a browser-exposed token. Validate and build candidates before publication. Releases are immutable; atomically replace per-project active metadata. Failed validation/build preserves the active release and records diagnostics. Candidate source remains editable. Same feature IDs in different projects remain independent. A latest-request generation prevents older builds from overwriting newer ones. Source and mutable state checkpoints have separate timing; restore only a named emachine-owned boundary, never a managed project.

## Access

Backend binds loopback. Trust verified Tailscale identity only from the local Serve path; public forwarding additionally requires a gateway secret and the existing Caddy authentication. Reject unconfigured browser origins for API requests and WebSocket upgrades. Local CLI control requests use a separate secret. Client secrets never enter URLs, frontend bundles or logs. CORS uses exact configured origins. Public access is not anonymous. The desktop client has no Node integration or privileged renderer bridge.
