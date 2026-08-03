# HUMAN_README

How to operate this repo, from a phone if that is all you have. Written for you.
Agents read [AGENTS.md](./AGENTS.md).

Verified 2026-08-04 against the live boxes, except where a line says otherwise.

---

## Read this before you use WhatsApp for anything real

**WhatsApp is a production console with no confirmation step.**

The openclaw agent on h1claw runs with `security=full, ask=off`. There is no
approval prompt between a sentence you type on a phone and a command running as
`claw` on the build box — which has SSH to prod, registry credentials, and your
GitHub token. A misread message, an unlocked phone, or a hijacked WhatsApp
session is arbitrary shell on your infrastructure.

**There is no rollback.** `--version` and `--since` are parsed and ignored. Every
real deploy is fix-forward. A bad deploy is fixed by deploying something better,
under whatever pressure you are already under.

So, the rule:

> **Never put `--execute` in a first message.**
>
> 1. Ask for the dry run. Require the reply to state: checkout commit, dirty or
>    clean, images, target, and what it _would_ change.
> 2. Read it.
> 3. Authorise in a **separate** message, naming one exact command.

This is a habit, not a mechanism — nothing enforces it today. If you want it
enforced, that is an `approvals`/allowlist change on the gateway, and it is worth
doing before the first phone deploy.

---

## Prod is broken and you have a phone

**Prod:** <https://wbs.bulletpoints.club> · host `h2puni` · reached from `h1claw`
over SSH. Blue/green: each tier runs one colour at a time.

### Step 1 — is it actually down

Send:

> in ~/wd/puni/wbs-tool-v1 — check prod: curl the public site and /health, then
> ssh h2puni and run docker ps. Report raw output, change nothing.

Expected when healthy: site `200`, `/health` `200`, and six containers up — one
per tier (`be-01-<colour>`, `gw-01-<colour>`, `fe-01-<colour>`) plus
`wbs-caddy-1`, `wbs-registry-1` and `dagger-engine`. Tiers hold colours
independently: `fe` on blue while `be` and `gw` are on green is normal, not a
half-finished deploy.

Note `/api/health` returns `NOT_FOUND` — there is no such route. Do not read it
as an outage.

> ⚠️ **A 200 from `/health` does not mean healthy.** be-01's health is an
> in-memory boolean and gw-01's is unconditional. Break `BE_URL` or delete the
> SQLite file and both still answer 200. Treat health as "the process is
> running", never as "the system works". Confirm with real traffic.

### Step 2 — what is actually deployed

> ssh h2puni and cat /srv/wbs/state/be.json, gw.json and fe.json. Report
> activeColor and lastDeployedSha for each.

Each file gives the live colour and the commit. Compare against `main`. As of
writing prod is on `0afc777`, three commits behind.

Also check the deploy lock. **The file always exists — its presence means
nothing.** The lock is a real `flock(2)` on an open descriptor, so the only
honest test is whether something holds it:

> ssh h2puni and check whether /srv/wbs/state/deploy.lock is actually held —
> grep its inode in /proc/locks. Do not run `flock` to test it, that would take
> the lock.

An entry in `/proc/locks` means a deploy is mid-flight; do not start another. No
entry means it is free, however old the file looks. A file with contents but no
live lock is the fingerprint of a deploy that was killed — the contents name the
last holder.

> ⚠️ **`readRecordedColor` in `swap.js` reads absent, unreadable and malformed
> state files all as "no state".** If a state file looks wrong, do not trust a
> tool's summary of it — read the file.

### Step 3 — logs

> ssh h2puni and run: docker logs --tail 100 be-01-green (use the colour from
> step 2), same for gw-01 and fe-01. Report anything that looks like an error.

### Step 4 — fix forward

There is no undo, so the shape is always: find the commit, fix, gate, publish,
dry-run, authorise, verify.

> in ~/wd/puni/wbs-tool-v1 — pull main, run `bunx nx format:check --all` and
> `bunx nx run-many -t test lint typecheck build --parallel=2`, report failures
> only

Then publish and dry-run — still no `--execute`:

> in the same checkout, export REGISTRY_USER=wbs and REGISTRY_PASS from h2puni's
> /srv/wbs/.env, run `bunx nx run tool-dagger:publish-all`, then
> `bunx nx run tool-deploy:deploy -- --all` and paste the dry-run output

**Stop and do not authorise if** the tree is dirty, `release.json` is stale, the
gate failed, the bundle is unbuilt, or the deploy lock is held. Those refusals
are the safety gates working — do not talk the agent past them.

Only then, in a new message, one command:

> run: bunx nx run tool-deploy:deploy -- --all --execute

### Step 5 — prove it worked

> re-check the public site and /health, ssh h2puni and re-read the three state
> files, and report the new activeColor and lastDeployedSha

`lastDeployedSha` must be the commit you meant. The colour should have flipped.

> ⚠️ `caddy reload` **exits 0 when it did nothing**. A green deploy log is not
> proof the public route moved — the sha and the colour are.

---

## When openclaw itself is unreachable

`openclaw daemon status` needs a shell, which is exactly what you do not have in
this scenario. In order:

1. **Tailscale dashboard** — <https://openclaw-gw.tailc433ee.ts.net> from any
   device on the tailnet (phone included). Verified reachable, returns 200. If
   this loads, the gateway is alive and WhatsApp is the broken part.
2. **SSH from a phone** — a terminal app to `h1claw`, then
   `systemctl --user restart openclaw-gateway` and `openclaw doctor`.
3. **Neither** — you need a laptop. Prod keeps serving whatever colour is live;
   a broken openclaw does not take the site down.

Worth doing before you need it: confirm you can SSH to h1claw from your phone.
Untested by me.

---

## Everyday work

Three surfaces, same repo, same rules.

| Surface              | Use it for                                | Catch                                     |
| -------------------- | ----------------------------------------- | ----------------------------------------- |
| Mac                  | writing code, fast loops, anything visual | arm64 — cannot build prod images natively |
| h1claw over SSH      | builds, deploys, long jobs                | non-login shells need a PATH export       |
| h1claw over WhatsApp | all of the above, from anywhere           | you steer an agent; see the red box       |

**h1claw is the build box** — amd64 with a local Dagger engine, so it builds
natively. The Mac would emulate.

### Mac

```sh
bun install
bun run dev:setup     # writes the three .env files
bun run dev           # be :3100, gw :3200, fe :4200
```

Gate before pushing — CI runs exactly this:

```sh
bunx nx format:check --all
bunx nx run-many -t test lint typecheck build
```

Root `bun test` runs **none** of fe-01's tests and still reports success. Use the
gate. More in [docs/local-dev.md](./docs/local-dev.md).

### h1claw over SSH

```sh
ssh h1claw
export PATH=$HOME/.bun/bin:$HOME/.local/bin:$PATH
cd ~/wd/puni/wbs-tool-v1
```

That export is the one thing that bites: `bun`, `dagger` and `shellcheck` live
under `~/.bun/bin` and `~/.local/bin`, and a non-interactive
`ssh h1claw '<cmd>'` will not find them. A login shell does. So does the agent.

Present and verified: bun, dagger, shellcheck, docker, node, gh (as
`dany-fedorov`), `codex`, `claude`. `openspec` is not global — use
`bunx @fission-ai/openspec@1.3.0`. The full gate passes on h1claw: 20 projects.

### h1claw over WhatsApp

Message Claire. **Always open with the path** — the agent's workspace is
`~/.openclaw/workspace`, which is Claire's own, not this repo:

> in ~/wd/puni/wbs-tool-v1, ...

Verified: the agent ran the entire gate from a single message and returned both
exit codes and the NX summary. Development through WhatsApp works today.

To skip the path prefix, symlink it once —
`ln -s ~/wd/puni/wbs-tool-v1 ~/.openclaw/workspace/wbs-tool-v1`. Not done:
`~/.openclaw/workspace` is itself a git repo and that would add a file to yours.

Good things to hand it: run the gate; investigate a red CI run; open a PR for a
small fix; summarise what changed on main; dry-run a deploy and report.

---

## Making a change

Rules: [AGENTS.md](./AGENTS.md). Five of them. R5 — _unknown is not OK, and every
check must be provably breakable_ — is the one this repo learned the expensive
way, eight times.

Behaviour, contracts, migrations, deploy safety and architecture go through
OpenSpec: `/opsx:new` → `/opsx:apply` → `/opsx:verify` → `/opsx:archive`. Docs
and mechanical refactors do not. The intent step runs an interview that argues
with you on purpose; terms it settles land in `CONTEXT.md`, hard-to-reverse
decisions become ADRs.

Reviews: `codex exec "..."` works on the Mac and on h1claw. `agy` is **Mac only**
— it is a macOS arm64 binary. `/code-review` covers the working diff.

---

## Symptoms

| Symptom                                | Cause                                                                      |
| -------------------------------------- | -------------------------------------------------------------------------- |
| `bun: command not found` on h1claw     | non-login shell — export the PATH above                                    |
| Root `bun test` green, CI red          | root `bun test` skips fe-01 entirely                                       |
| CI format fails, files look fine       | `CLAUDE.md`/`GEMINI.md` are symlinks — see `.nxignore`                     |
| Deploy refuses to run                  | dirty tree, stale `release.json`, unbuilt bundle, or lock held — by design |
| `/health` is 200 but the app is broken | health is a status flag, not a dependency check                            |
| Deploy logged success, site unchanged  | `caddy reload` exits 0 having done nothing — check the sha                 |
| Agent cannot find the repo             | say the path                                                               |

Known-broken things are in `LLM_README.md` under **Open findings** — read it
before concluding you broke something.

---

## Map

| File                                     | What                          |
| ---------------------------------------- | ----------------------------- |
| [README.md](./README.md)                 | shortest start                |
| **HUMAN_README.md**                      | this — operating the thing    |
| [AGENTS.md](./AGENTS.md)                 | rules, loaded by every agent  |
| [LLM_README.md](./LLM_README.md)         | landmines, open findings      |
| [docs/local-dev.md](./docs/local-dev.md) | local detail, troubleshooting |
