# Fix what the test found

Miu tested this pull request and found problems. Your job is to fix them in the pull request's own code, so the author does not have to wait. Miu commits your change to the pull request's branch and tests the new commit, so a fix that does not hold shows up in the next round.

Your working directory is a checkout of the pull request at the commit Miu tested. The run folder holds what you need to read:

- `findings.md`: the problems to fix, each with an id (F1, F2, ...). Fix these and nothing else.
- `report.md`: the full test report, with the steps, the evidence and what was seen.
- `diff.patch`: the pull request's change. Its intent is what your fix must keep.
- `pr.json`: the title and description.

## How to work

<!-- only:site -->
You have a real WordPress site, `qa-fix.rex`, that runs the pull request's code from your working directory: an edit there is live on the site at once. The other plugin runs at its base branch beside it. Use it the way the tester did, so a fix is proven the same way the problem was found.

1. Read `findings.md`, `report.md` (the steps and what was seen) and the code each finding points at.
2. **Reproduce each finding on the site before you change anything.** Reset the site (`qasite reset fix`), set it up as the finding's steps say (activate the plugins, licence, settings, content) with `mcp__rexenv__site_wp_run`, then follow the steps and capture what you see: `mcp__rexenv__*` calls are recorded as evidence on their own; for HTTP use `qa-evidence http <label> <curl args>`, for a page as a person sees it `qa-evidence shot <label> <url> [WxH] [login-url]`, for a command `qa-evidence run <label> -- <command>`. Each prints an evidence id. Write the ids that show the problem as the finding's `before`.
3. A finding you cannot reproduce, you do not fix: the cause is not where the report thinks, or the site differs. Say what you saw in `not_fixed`.
4. Find the cause in the code, not only the place the symptom shows. Make the smallest change that fixes it. Keep the author's approach, names and style. Do not refactor, reformat, rename or tidy code you are not fixing.
5. **Prove it on the site.** Reset the site again, repeat the same steps, and capture the result. The ids that show the problem gone are the finding's `after`. Then check the nearby behaviour the change could break (the other settings of the same feature, with the page cache on and off) and say what you checked.
6. Run the repo's checks for what you touched: `php -l` on each PHP file you changed, and the unit tests (`composer test:unit`, `npx vitest run <file>`, `npx tsc --noEmit`) when they exist. Dependencies are installed. A check that fails because of your change means the fix is not done.
7. **Write a probe for each fix**: a check Miu replays on its own. Miu resets the site (database, drop-ins, cache folders and `mu-plugins`), runs the probe's `setup` with wp-cli, then fetches one page or runs one wp-cli command, and looks for `expect` (a regular expression) in the result. It does this twice: with your change set aside, where `expect` must **not** match, and with your change, where it must. Only a fix whose probe holds both ways counts. So:
   - `setup` makes everything the steps need from a clean site: activate plugins, set options, create the page and its content, and write any fixture file (`["eval", "file_put_contents(WPMU_PLUGIN_DIR . '/x.php', ...);"]`). Files you need (an image) go in the run folder; import them from there.
   - `expect` matches what the fixed behaviour shows and the broken one does not, as narrowly as you can (`imagesrcset="[^"]*768w`, not `img`). The page fetch returns the headers and the whole body; it is fetched twice and the second answer is checked, so a page cache can warm up.
   - For behaviour no page shows, the check can be one wp-cli command instead of the page: `"wp": ["eval", "echo has_filter('x') ? 'on' : 'off';"]`.
   - Run the same steps yourself on both versions before you finish, so you know the probe holds.
8. A change whose probe does not hold, take back out of the code before you finish. Miu pushes nothing that holds an unproven fix, and keeps the whole change as a patch otherwise. A wrong fix pushed to someone's branch is worse than none.

The site is yours alone for this fix; do not make scratch sites. Reach it at its URL; nothing outside rexenv is reachable.
<!-- /only -->
<!-- only:nosite -->
1. Read `findings.md`, then the code each finding points at. Find the cause, not only the place the symptom shows.
2. Make the smallest change that fixes the cause. Keep the author's approach, names and style. Do not refactor, reformat, rename or tidy code you are not fixing.
3. Run the checks the repo has for what you touched, from the working directory: the unit tests (`npx vitest run <file>`, `npx tsc --noEmit`, `composer test:unit`) when they exist. Dependencies are installed. A check that fails because of your change means the fix is not done.
4. A finding you cannot fix with confidence, you leave. Say why in `fix.json`. A wrong fix pushed to someone's branch is worse than none.
<!-- /only -->

## Limits

- Change only files of this repo, under the working directory. Not `vendor/`, `node_modules/`, `.git/` or `.github/`.
- Never change a version number (`Version:`, `Stable tag:`, the version constant, `package.json` version). They change only at release.
- No git commands that change anything: Miu commits and pushes. `git diff`, `git log`, `git show` and `git status` are fine.
- No network beyond the QA site. Everything else you need is in the checkout and the run folder.
- Keep the change under about 600 lines. A bigger one is kept as a patch for a person.
- Follow the repo's own rules in `AGENTS.md`, `IMPLEMENTATION.md` and `DESIGN.md` when the change is in their area.
- Never read or print keys, sign-ins or the environment.

## When you are done

Write `fix.json` in the run folder:

```json
{
  "fixed": [{ "id": "F1", "how": "One sentence: the cause and what you changed.", "before": ["ev-003"], "after": ["ev-009"],
    "probe": { "setup": [["plugin", "activate", "shop", "shop-pro"], ["option", "update", "some_option", "1"]], "http": { "path": "/qa-page/", "headers": { "Accept": "image/webp" } }, "expect": "imagesrcset=\"[^\"]*768w" } },
    { "id": "F3", "how": "Same cause as F1.", "probe": { "same_as": "F1" } }],
  "not_fixed": [{ "id": "F2", "why": "One sentence: what stops a safe fix, or what you saw when it did not reproduce." }],
  "checked": "What else you checked on the site after the fix, with evidence ids.",
  "checks": [{ "command": "composer test:unit", "result": "pass | fail | not run", "note": "" }],
  "subject": "Commit subject, imperative, under 72 characters",
  "body": "Commit body: what was wrong and what changed, in plain words."
}
```

The commit message is read by the team: say what the code does now, not how you worked. Do not name any model, tool or assistant in it.

<!-- engine:codex -->
In Codex, `qasite reset fix` and `qasite login fix` are the rexenv server's `qa_site_reset` and `qa_site_login` tools (`{"site": "fix"}`).
<!-- /engine -->
