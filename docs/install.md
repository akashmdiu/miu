# Installing Miu

```sh
curl -fsSL https://raw.githubusercontent.com/akashmdiu/miu/main/install.sh | sudo bash -s -- --domain miu.example.com
```

Read [install.sh](../install.sh) before you run it. It changes the server as root, so check what it does first.

## What you need

- A server running Ubuntu 24.04, x86_64 or arm64, with 4 GB of memory and 20 GB of free disk. Use a machine of its own, or one that runs nothing you would mind an AI agent being near. The agent is locked down, but it does have a shell.
- For `--domain`, a DNS name that points at the server, with ports 80 and 443 free. Caddy gets the certificate from Let's Encrypt.
- A Claude (Pro or Max) or ChatGPT (Plus or Pro) subscription, or an API key, for the agent.
- Admin rights on the GitHub account or organization that owns the repositories, to install Miu's App.

## Options

| Option | What it does |
|---|---|
| `--domain NAME` | Serves Miu at `https://NAME` through Caddy, and turns sign-in on from the first request. |
| `--ref REF` | Installs this branch or tag of Miu. The default is `main`. |
| `--repo URL` | Gets Miu from a fork. |
| `--no-agent-user` | Runs the agent as Miu's own account. Only do this for a test machine. |

## What it changes on the server

| Piece | Where |
|---|---|
| Account `miu` | Runs the dashboard and rexenv, and holds every secret. It has no sudo and is not in the `docker` group. |
| Account `miu-agent` | Runs the AI agent. It cannot read anything that belongs to `miu`. |
| rexenv, headless | The `rexenv` apt package, plus `rexenv-headless.service` running as `miu`. Its edge listens on `127.0.0.1:8180` and `127.0.0.1:8543`, so ports 80 and 443 stay free. |
| Node, `claude`, `codex`, Chromium | `/opt/miu`, owned by root. Neither account can change them. |
| Miu | `/srv/miu` (code, owned by root), with `runs/` and `.cache/` owned by `miu`. It runs as the `miu.service` unit on `127.0.0.1:4747`. |
| Profiles | `/etc/miu/profiles` |
| Settings and sign-ins | `/home/miu/.config/miu`. Tokens are stored in `keys.enc.json`, encrypted with AES-256-GCM. |
| Secrets key | `/etc/credstore.encrypted/miu-secrets-key`, sealed with the machine's own key. systemd decrypts it for `miu.service` only. |
| Agent helpers | The scripts in `/usr/local/lib/miu`, the sudoers rule in `/etc/sudoers.d/miu`, and the AppArmor profile in `/etc/apparmor.d/miu-codex-bwrap`. |
| Packages | git, PHP 8.3 CLI with common extensions, composer, gh, acl, xvfb. With `--domain`, Caddy too. |

### How the agent is kept apart

`miu` starts the agent's CLI through `sudo -u miu-agent /usr/local/lib/miu/agent-exec`. That is the only command `miu` may run as `miu-agent`. The agent can run two commands as `miu`, and nothing else: rexenv's MCP server and the QA-site reset. The MCP server goes through Miu's guard, which refuses any site except the run's own. Each run folder gets an ACL so the agent can write its results there.

Codex runs commands inside bwrap. Ubuntu 24.04 lets a program create the user namespace that bwrap needs only if the program has an AppArmor profile. The installer adds a profile for the bwrap that ships with Codex, and for nothing else.

## After the installer

1. **Owner account.** Open the address and go to `/auth/setup`. Enter the setup code the installer printed. You can also read it with `sudo cat /home/miu/.config/miu/setup-code`.
2. **GitHub App.** Open **GitHub** at the bottom of the sidebar and press **Create the App on GitHub**. GitHub asks for the App's name. Names must be unique across GitHub, so add a word if the one offered is taken. Then install the App on the account or organization that owns your plugins, and choose the repositories. The App can write comments, labels and statuses, and read code. It cannot push, merge or approve.
3. **Repositories.** On the same page, press **Make a profile** for each plugin. Miu reads the repository and writes a first profile. Tune it later ([profiles.md](profiles.md)).
4. **AI.** Go to **Settings → AI & agents** and press **Sign in with Claude** or **Sign in with ChatGPT**, or paste an API key.
5. **Sign-in for the team.** On the GitHub page, add the App's client secret so people can sign in with GitHub. Then invite them under **Settings → Members**.
6. **Optional.** Set `CLOUDINARY_URL` under Settings so screenshots show inside the comment. To post the full report to agent-notes, set `AGENT_NOTES_TOKEN` and `AGENT_NOTES_MCP_URL` in `/home/miu/.config/miu/env`.

Auto-test is on from the start, for pull requests opened or pushed after the install. Pull requests that already existed wait until you press **Test** on them. Posting to GitHub starts off: reports show only on the dashboard until you turn on posting under Settings. Read a few reports first, then turn it on.

## Updating

Run the installer again. It fetches Miu, reinstalls the dependencies and the CLIs, and restarts the service. It does not touch runs, settings, profiles or sign-ins.

## Checking it works

```sh
systemctl is-active rexenv-headless miu
sudo -u miu XDG_RUNTIME_DIR=/run/user/$(id -u miu) rex status
journalctl -u miu -n 50
```

## Removing it

```sh
sudo systemctl disable --now miu rexenv-headless
sudo rm -rf /srv/miu /opt/miu /etc/miu /usr/local/lib/miu /etc/sudoers.d/miu /etc/apparmor.d/miu-codex-bwrap \
  /etc/systemd/system/miu.service /etc/credstore.encrypted/miu-secrets-key /etc/caddy/conf.d/miu
sudo userdel -r miu-agent; sudo userdel -r miu
sudo apt-get remove rexenv
```
