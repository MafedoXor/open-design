# 08: Test the remote worker end to end on Windows

**What to build:** A hands-on test pass of the whole remote-worker feature with a Windows PC as the worker, against the Docker server set up by `deploy/PRIVATE-NETWORK.md`. Everything so far was built and verified on macOS only (unit tests, plus a smoke run with the `mocks/bin` replay CLIs). Fix what breaks, or file a ticket per defect with a red spec where one can be written cheaply.

**Blocked by:** none (01–03, 05–07 are done; 04's server side is done)

**Status:** ready-for-human (needs a real Windows 10/11 PC with Node 24)

## Setup

- Docker server on a private network per `deploy/PRIVATE-NETWORK.md`, with `docker-compose.private-network.yml`.
- A Windows PC on the same tailnet or WireGuard network, with Node 24, pnpm (`npm install -g pnpm@10.33.2`, since `corepack enable` fails with EPERM), and Visual Studio Build Tools for `better-sqlite3` (see root `AGENTS.md` → Windows native).
- At least one real agent CLI installed and signed in on the PC (Claude Code first; then Codex or opencode, which install as npm `.cmd` shims).
- Ideally a second PC (macOS or Linux) as another person, for the lock and two-people checks.

## Checks

- [ ] Following the guide, `pnpm install` and `pnpm --filter @open-design/daemon build` succeed on Windows, and `node apps/daemon/bin/od.mjs worker --help` runs
- [ ] The site opens at the server's private address from the Windows browser with no login, and Settings → Remote worker creates a token and shows a connect command that works when pasted into PowerShell (the shown command is POSIX `OD_WORKER_TOKEN=… od worker …`; check whether it needs a PowerShell form)
- [ ] `$env:OD_WORKER_TOKEN = "<token>"; od worker --server http://<private-address>:7456` connects, and the worker shows Online with the agents found on the PC, including CLIs installed as `.cmd` / `.ps1` shims
- [ ] A real agent run on the Windows worker streams into the chat and ends `succeeded`; prompts with quotes, newlines and non-ASCII text reach the agent intact (argv quoting with `shell: false` / `windowsVerbatimArguments`)
- [ ] Files round-trip: created, edited and deleted files come back to the server with the right relative paths (no backslashes in project paths), and text files keep their line endings
- [ ] Nested folders, files with spaces and non-ASCII names, and a project whose path is longer than 260 characters on the worker
- [ ] `node_modules`, `.git` and files over 25 MB are not sent in either direction; server edits win on conflict
- [ ] Stop from the chat (and `od run cancel`) ends the agent's whole process tree on Windows: no leftover `node.exe` / agent processes in Task Manager afterwards (`signalTree` uses a parent-pid snapshot on win32)
- [ ] After a run that ends normally, no tool processes it started are left running (on Windows only a stop reaches the tree; `reapProcessGroup` is a no-op there — decide whether that needs fixing)
- [ ] The worker's per-run temp copy is removed after the run, including when an agent or antivirus still holds a file open (EBUSY/EPERM on delete)
- [ ] Sleep and wake the PC, and drop Wi-Fi: the worker shows Offline within ~30 s, reconnects by itself, and a run that was active fails instead of hanging
- [ ] Rotating and revoking the token disconnects the Windows worker; it exits with the "token refused" message and does not keep retrying
- [ ] Ctrl+C in the worker's PowerShell window stops it cleanly and stops any running agent
- [ ] The project lock: while the Windows worker runs, a second person's run in the same project is refused as busy
- [ ] Windows Defender Firewall prompts nothing (the worker only connects outbound)

## Notes

Record the Windows build, Node version, agent CLI versions and any defects here or in follow-up tickets.
