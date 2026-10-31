<h1>
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/brand/miu-logo-big-white.svg">
    <img src="assets/brand/miu-logo-big-black.svg" alt="Miu" height="56">
  </picture>
</h1>

Miu is a QA agent for WordPress plugin pull requests. When a pull request opens, Miu checks out the branch and starts two WordPress sites: one runs the base branch, the other runs the pull request. An AI agent (Claude or GPT) shows each claim in the pull request on the base site first, then checks it on the pull request site. Each result comes with screenshots, HTTP responses and command output. Miu then posts a verdict on the pull request: **Found OK**, **Found partially OK** or **Found NOT OK**. The full report sits behind a link.

Miu runs on your own server. It uses your own Claude or ChatGPT account and your own GitHub App, and only your team can sign in.

## Install

On a fresh Ubuntu 24.04 server (4 GB of memory or more):

```sh
curl -fsSL https://raw.githubusercontent.com/akashmdiu/miu/main/install.sh | sudo bash -s -- --domain miu.example.com
```

The domain must already point at the server. Without `--domain`, Miu listens on `127.0.0.1:4747` only, and you reach it through an SSH tunnel. Run the same command again to update Miu.

Then finish in the browser, in this order:

1. Create the owner account with the setup code the installer printed.
2. Open **GitHub** at the bottom of the sidebar (`/github-app`). Create Miu's GitHub App there and install it on your repositories.
3. On the same page, under **Repositories**, press **Make a profile** next to each plugin to test.
4. **Settings → AI & agents**: sign in with Claude or ChatGPT.

[docs/install.md](docs/install.md) explains each step and what the installer changes on the server.

## What a run does

1. **Gather.** Miu reads the pull request, its diff, linked issues, earlier rounds and related pull requests (a Pro add-on pull request with the same branch name, for example).
2. **Prepare.** Miu fetches the branch into a reusable worktree and points the two WordPress sites (`qa-pr.rex` and `qa-dev.rex`) at it. Each site goes back to a clean snapshot in about a second.
3. **Test.** The agent writes one criterion per claim. It reproduces each claim on the base branch, then checks it on the pull request, in a real browser, through REST, wp-cli and the database. It saves every command, response and screenshot as evidence.
4. **Report.** Miu checks that each piece of evidence the agent cites exists, then works out the verdict from the results. The model never writes the verdict itself. Miu posts the comment, sets the labels and, if Cloudinary is set up, uploads the screenshots.

Each new commit starts a new round. Miu tests again what the commit changed, and earlier rounds collapse under the new comment. While a run is in progress, anyone on the team can send the agent an instruction from the run's page. A finding can also be fixed on the pull request's own branch. A fix counts only when Miu can replay a check that fails without the change and passes with it.

## Why the verdict can be trusted

- Evidence is captured by Miu's tools, not written by the model. A result that cites no real evidence counts as "not verified".
- The verdict is computed: a confirmed blocker makes it NOT OK. A failed claim or a major issue makes it partially OK.
- A run that hits a problem with the environment, such as a site that won't start, ends without a verdict. It is never counted as a pass or as a defect in the pull request.
- The agent runs as its own Linux account. That account cannot read Miu's tokens, the GitHub App key or the sites' `wp-config.php`. It can reach only the two QA sites and any scratch sites it creates.

[docs/security.md](docs/security.md) covers sign-in, roles, request checks and how secrets are stored.

## Configure

- **Profiles** say how to test each repository: the base branch, the test commands, what counts as a documentation-only change, and how a plugin pairs with its add-on. See [docs/profiles.md](docs/profiles.md).
- **Product notes** (`project.md` beside the profiles) are your product's rules, such as "Pro features fail closed without a licence". They are added to the agent's instructions.
- **Instructions**: every prompt the agent gets can be read and edited under Settings → Instructions.
- **Method**: [docs/methodology.md](docs/methodology.md) describes how a test is done and what the report looks like. The agent follows it.

## Run it on a laptop

macOS and Linux both work. You need [rexenv](https://rexenv.rex.bd), Node 22 or later, PHP with composer, and `gh` signed in:

```sh
npm ci && npx playwright install chromium
MIU_PROFILES=./profiles node bin/qa-dashboard            # http://localhost:4747
node bin/qa-run --repo owner/plugin --pr 12 --dry-run   # one run; posts nothing
```

## Limits

- Miu tests WordPress plugins. Other kinds of project need a profile and an env script of their own (`env/<kind>/env.sh`).
- rexenv on Linux has no MariaDB, Apache or Memcached yet. A claim that needs them is reported as not covered.
- Runs happen one at a time, and each run uses the usage limits of the Claude or ChatGPT plan behind it.

## Licence

[MIT](LICENSE)
