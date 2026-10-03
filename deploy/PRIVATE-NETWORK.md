# Private-network deployment with remote workers

This guide runs the Docker server for a small team that reaches it only over a
private network (Tailscale or WireGuard), with **no browser login**, and has each
person run agents on their own PC as a **remote worker**. The server keeps the
projects and the chat; only the agent process runs on the person's PC, using the
agent CLIs installed and signed in there.

Read [`README.md`](README.md) first for the image, `.env` and the general Docker
setup. This guide only covers what differs.

## Read this before you start

With browser login off, **anyone who can reach the server's address can use
the site** — every project, every chat, every setting, and the Settings page
that issues worker tokens. The private network is the lock on the site.

The **worker token is the only lock on the worker bridge** (`/api/worker-bridge/*`).
Whoever holds a person's token can connect as that person's worker, receive the
project files of every run sent to that worker, and report the run's output and
file changes back into the project. Treat a worker token like a password, and
revoke it when a PC is lost or a person leaves.

**Never expose this server on the public internet.** Without browser login there
is no authentication between the internet and your projects, and worker traffic
is plain HTTP that carries the worker token on every request. Do not bind it to a
public interface, forward its port on a router, put a public reverse proxy or
tunnel in front of it, or turn on Tailscale Funnel for it. If the server must be
reachable from outside the private network, use the standard deployment in
[`README.md`](README.md) with `OD_API_TOKEN` and an authenticated TLS reverse
proxy instead.

## 1. Join the private network

Install Tailscale (or set up WireGuard) on the server and on every person's PC,
and check that each PC can reach the server's private address. You need:

- **The server's private address.** With Tailscale, run `tailscale ip -4` on the
  server; it is in `100.64.0.0/10`. With WireGuard it is the server's address on
  the tunnel interface, usually in `10.0.0.0/8`.
- **The browser origin** people will type: `http://<private-address>:7456`. If
  you also want a Tailscale MagicDNS name, list that origin too, for example
  `http://od-server.<tailnet>.ts.net:7456`.

Use Tailscale ACLs or WireGuard peer lists to limit who on the network can reach
port 7456, if not everyone on it should use the site.

## 2. Compose settings

The override file [`docker-compose.private-network.yml`](docker-compose.private-network.yml)
changes three things in `docker-compose.yml`:

| Setting | Base `docker-compose.yml` | With the private-network override |
| --- | --- | --- |
| Port binding | `127.0.0.1:${OPEN_DESIGN_PORT}:7456` (this machine only) | `${OPEN_DESIGN_PRIVATE_ADDRESS}:${OPEN_DESIGN_PORT}:7456` (the private address only) |
| Browser login | On when `OD_API_TOKEN` is set | Off: `OD_API_TOKEN` is forced empty and `OD_DISABLE_API_AUTH=1` |
| Allowed origins | Optional | Required: `OD_ALLOWED_ORIGINS` from `OPEN_DESIGN_ALLOWED_ORIGINS` |

The port is published on the private address only, so the server answers on the
private network but not on the host's LAN or public interfaces. Compose refuses
to start if `OPEN_DESIGN_PRIVATE_ADDRESS` or `OPEN_DESIGN_ALLOWED_ORIGINS` is
missing, so a forgotten setting cannot fall back to every interface. Never set
`OPEN_DESIGN_PRIVATE_ADDRESS` to `0.0.0.0` or a public address.

Allowed origins are required because the daemon only trusts loopback and
RFC 1918 addresses (`10/8`, `172.16/12`, `192.168/16`) as same-origin browser
hosts. Tailscale addresses and MagicDNS names are neither, so without this
setting the site loads but every change is refused with
`cross-origin request rejected`.

Browser login is disabled by `OD_DISABLE_API_AUTH=1`. The daemon normally
refuses to listen on a non-loopback address without `OD_API_TOKEN`; this flag is
the explicit opt-out, and the override sets it for you.

In `deploy/.env` set (Tailscale example):

```bash
OPEN_DESIGN_IMAGE=ghcr.io/nexu-io/od:latest
OPEN_DESIGN_PRIVATE_ADDRESS=100.101.102.103
OPEN_DESIGN_ALLOWED_ORIGINS=http://100.101.102.103:7456
OD_API_TOKEN=
OPEN_DESIGN_DISABLE_API_AUTH=
```

Leave `OD_API_TOKEN` and `OPEN_DESIGN_DISABLE_API_AUTH` empty; the override
decides both. For persistent data, follow root [`AGENTS.md`](../AGENTS.md) →
**Daemon data directory contract**; this guide does not restate it and the
override does not change it.

Start the server from `deploy/`:

```bash
docker compose -f docker-compose.yml -f docker-compose.private-network.yml pull
docker compose -f docker-compose.yml -f docker-compose.private-network.yml up -d --no-build
```

Check it from another PC on the private network:

```bash
curl -fsS http://100.101.102.103:7456/api/health
```

**After a reboot**, the private address exists only once Tailscale or
WireGuard has brought its interface up. If Docker starts the container before
that, publishing the port fails with `cannot assign requested address` and the
server stays down until someone runs `up` again. On a systemd host, make Docker
wait for the network service:

```bash
sudo systemctl edit docker.service
```

```ini
[Unit]
After=tailscaled.service
Wants=tailscaled.service
```

For WireGuard, use `wg-quick@<interface>.service` instead of `tailscaled.service`.
Reboot once and check `/api/health` from another PC.

Each person opens `http://100.101.102.103:7456` (or the MagicDNS origin you
listed). There is no sign-in prompt. If the browser shows a sign-in prompt, the
override was not applied; if the page loads but saving fails with
`cross-origin request rejected`, the address in the browser bar is not listed in
`OPEN_DESIGN_ALLOWED_ORIGINS` exactly (scheme, host and port).

The image does not bundle any agent CLI, so with this setup agents run on
people's workers, not on the server.

## 3. Worker tokens

Each person has one worker token. The server stores only a hash of it, so a
token is shown once, when it is created, and cannot be read back.

### Create

In the browser: **Settings → Remote worker**, enter **Your name**, **Save**, then
**Create worker token**. The page shows the token once and the command to run on
your PC, with this server's address filled in.

From the CLI, on the server:

```bash
docker compose -f docker-compose.yml -f docker-compose.private-network.yml \
  exec open-design node apps/daemon/bin/od.mjs worker token create --person alice
```

or from a PC on the private network that has `od` (see step 4):

```bash
od worker token create --person alice --daemon-url http://100.101.102.103:7456
```

Use the IP origin with `--daemon-url`; a MagicDNS name is accepted from the
browser but not from the CLI, which sends no `Origin` header.

### Rotate

Create the token again: **Rotate token** in Settings, or run the same create
command again:

```bash
od worker token create --person alice --daemon-url http://100.101.102.103:7456
```

Always pass `--daemon-url` when running `od` on a PC: without it, `od` talks to
a daemon on that PC, and the server token you meant to rotate keeps working.
The old token stops working at
once and a worker still using it is disconnected; it exits and asks for a new
token instead of retrying. Rotate whenever a token may have been seen by someone
else, for example after it was pasted into a chat.

### Revoke

**Revoke token** in Settings, or:

```bash
od worker token revoke --person alice --daemon-url http://100.101.102.103:7456
```

The token is deleted and the worker is disconnected at once. Runs that worker
was doing fail; they are not moved to the server. Revoke when a PC is lost, a
person leaves, or a worker should stop receiving runs.

`od worker status --daemon-url http://100.101.102.103:7456` lists every person's
worker, whether it is online, and the agents it offers.

## 4. Start a worker on each PC

On each person's PC (macOS, Linux or Windows):

1. Install and sign in to the agent CLI the person wants to use (for example
   Claude Code, Codex or opencode), so that it runs from a terminal on that PC.
2. Get the `od` CLI. From a checkout of this repository (Node 24, pnpm via
   Corepack):

   ```bash
   pnpm install
   pnpm --filter @open-design/daemon build
   ```

   `od` is then `node apps/daemon/bin/od.mjs`; the examples below write it as
   `od`.
3. Start the worker with the token from step 3. Prefer the environment variable
   over `--token`, so the token stays out of the process list:

   ```bash
   OD_WORKER_TOKEN=<token> od worker --server http://100.101.102.103:7456
   ```

   On Windows PowerShell:

   ```powershell
   $env:OD_WORKER_TOKEN = "<token>"
   od worker --server http://100.101.102.103:7456
   ```

The worker connects outbound to the server, so the PC needs no open port. It
stays connected until you stop it (Ctrl+C) and reconnects by itself after a
network drop or sleep. Settings → Remote worker shows it as **Online** with the
agents it found.

## 5. Run a real agent on your worker

In the browser, **Settings → Remote worker → Run new messages on** → *your
name's worker*. The choice is remembered in that browser. Pick an agent your
worker offers and send a message as usual: the agent runs on your PC against a
copy of the project, its output streams into the chat, and the files it writes
come back into the project on the server.

From the CLI the same run is:

```bash
od run start --project <projectId> --agent claude --worker alice \
  --message "Add a pricing page" --follow --daemon-url http://100.101.102.103:7456
```

What to expect:

- **One run per project when a worker is involved.** A second run in a project
  that a worker run holds is refused as busy, naming who holds it.
- **Worker offline means the run fails.** It is never silently run on the
  server instead.
- **Server edits win on conflict.** If someone changed a file on the server while
  the worker run was going, the server's version is kept.
- `node_modules`, `.git` and files over 25 MB are never moved between the server
  and a worker.
- Stopping a run stops the agent's whole process tree on the worker.

## Checklist

- [ ] Server and every PC are on the same tailnet or WireGuard network.
- [ ] `OPEN_DESIGN_PRIVATE_ADDRESS` is the server's private address, not
      `0.0.0.0` or a public address.
- [ ] `OPEN_DESIGN_ALLOWED_ORIGINS` lists exactly the origin(s) people type.
- [ ] No port forward, public reverse proxy, tunnel or Tailscale Funnel points at
      the server.
- [ ] Each person has their own worker token, and lost or shared tokens are
      rotated or revoked.
