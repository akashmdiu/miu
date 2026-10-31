# Security: GitHub access, sign-in and members, the dashboard

How Miu reaches GitHub and who can use its dashboard. Read this before you put
Miu on a server.

## GitHub access

All GitHub traffic goes through [lib/github.mjs](../lib/github.mjs) over HTTPS;
the gh CLI is not needed. The token, in order:

1. **The Miu GitHub App's installation token** for the repo's owner. This is the
   production path: comments, labels and statuses show as the App, and the
   App's own rate limit applies. Tokens last an hour and are renewed
   15 minutes before they expire.
2. `GITHUB_TOKEN` from the environment.
3. On a developer machine only: the local `gh auth token`.

Rules the code keeps:

- Tokens are never logged, never put on a command line or in a URL, and never
  sent to a page. Git fetches carry the token in `GIT_CONFIG_*` environment
  variables, which a process list does not show.
- Repo names and PR numbers are checked before they reach an API path or a
  query; GraphQL uses variables.
- Network errors, 5xx answers and the secondary rate limit are retried with a
  back-off; anything else fails at once.
- The QA agent gets no GitHub, Cloudinary, agent-notes or Slack token.
- A comment can be edited only by whoever wrote it: editing one posted before
  the App was installed uses the fallback account (`fallback: true`).

The App may write comments, labels and commit statuses, and read code. It
cannot push, merge or approve. Its private key and client secret live in
`~/.config/miu/github-app.json` (mode 600), outside the repo.

### Pushing a fix

A fix ([bin/qa-fix](../bin/qa-fix)) is the one thing Miu pushes. The App cannot
push, so the push uses the GitHub account connected under GitHub and notices,
and no other: the commit, the push and the fix comment are all that person's.
No account connected, or no write access, means no push. The sign-in goes
through the Miu App, so the App needs Contents: Read and write as well (a
sign-in through an App can do only what the App may).

- The fix agent gets no token and reaches only its QA site (`qa-fix.rex`, through rexenv and URLs on `.rex`), with no scratch sites; its tool rules
  ([lib/rules.mjs](../lib/rules.mjs) `fixToolRule`) let it write only in its
  worktree and its run folder, never `vendor/`, `.git/` or `.github/`, and never
  run git that changes anything. Codex runs it in its sandbox; the rexenv guard limits it to that site.
- Miu checks the change before it commits ([lib/fix.mjs](../lib/fix.mjs)
  `checkChange`) and keeps anything that fails as a patch.
- The push is never forced and never goes to a fork, `dev` or `main`.
- The commit message is cleaned of any line naming a model or a tool.

## Sign-in and members

Each Miu has its own accounts ([lib/users.mjs](../lib/users.mjs)), kept in
`~/.config/miu/users.json` (mode 600).

- **The first account** is the owner. A new install has none: the server writes
  a one-time setup code to its log and to `~/.config/miu/setup-code` (mode
  600), and `/auth/setup` asks for it, so whoever reaches the page first cannot
  take the install. The code is deleted once the owner exists.
- **Others join by invite.** An admin invites an email address or a GitHub
  username with a role and gets a link (`/auth/invite/<token>`) to send. The
  link works once and for 7 days; only its SHA-256 is stored. An email invite
  sets a password; a GitHub invite signs in with that GitHub account and no
  other.
- **Roles.** Owner: everything, including who is owner. Admin: Settings (AI
  connections, rules, instructions, posting) and members. Member: starts and
  stops tests, posts reports, reviews findings. Viewer: reads reports. A role
  is read from the account on every request, so a change or a removal applies
  at once. There is always at least one owner, only an owner changes an owner,
  and nobody removes themselves.
- **Passwords** are scrypt hashes (N=2^15, 16-byte salt), 10 to 200 characters,
  checked in constant time, with the same work for an unknown email. Five
  wrong tries for an email or an address mean a 5-minute wait.
- **Sign in with GitHub** appears once the Miu App has a client secret. OAuth
  with `state` and PKCE (S256); the user's GitHub token is used once to read
  who they are and is not kept. The login must belong to a member or match the
  invite being accepted. The redirect after sign-in only goes to a path on
  this server.
- **Pictures:** a GitHub account shows its GitHub picture; an email account its
  Gravatar, asked for by the SHA-256 of the email (`d=404`, so an email with
  none shows initials). The browser fetches them; the email itself is not sent.
- **Sessions:** a random 32-byte id in a cookie that is `HttpOnly`,
  `SameSite=Lax` and `Secure` on https. The server keeps only its SHA-256, with
  the account id and an expiry (12 hours), in `runs/.sessions.json` (mode 600).
- **When sign-in is on:** as soon as an account exists, whenever the dashboard
  listens on anything but 127.0.0.1, or with `MIU_AUTH=github`. A local Miu
  with no accounts has sign-in off, and the person at the keyboard is the
  owner. The setup, sign-in and invite forms need an `Origin` (or `Referer`) of
  this server.

## Requests

- Every response: `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`,
  `Referrer-Policy: same-origin`, `Cross-Origin-Opener-Policy`, and HSTS on
  https.
- The dashboard page has a Content-Security-Policy with a per-request script
  nonce: no inline handlers, no framing, scripts only from this page and
  cdnjs, images only from this server, Cloudinary and GitHub.
- Writes (POST) need the `X-QA-Dashboard: 1` header, which a cross-site form
  cannot send, and an `Origin` of this server; with sign-in on, the Origin is
  required and must be `MIU_PUBLIC_URL`.
- Text from GitHub (comments in the History view) is rendered as Markdown and
  then stripped of scripts, event handlers and `javascript:` links.

## Running on a server

| Variable | What it does |
|---|---|
| `MIU_HOST` | Address to listen on (default `127.0.0.1`). Anything else turns sign-in on. |
| `MIU_PUBLIC_URL` | The URL people use, e.g. `https://miu.example.com`. Sign-in callbacks and the Origin check use it. |
| `MIU_AUTH=github` | Require sign-in even on 127.0.0.1 before the first account exists (behind a reverse proxy on the same machine). |
| `MIU_GH_CLIENT_SECRET` | The App's client secret, if you prefer the environment to the key file. |
| `GITHUB_TOKEN` | A fallback token before the App is installed. |

Put Miu behind a reverse proxy that terminates TLS, set `MIU_PUBLIC_URL` to the
https address, and add `<MIU_PUBLIC_URL>/auth/callback` as a callback URL in
the App's settings.
