# QA methodology

This is how a QA engineer tests a pull request, written down from one person's reports on a WordPress plugin, its Pro add-on and the app they talk to (469 pull request comments over four months, plus the full reports they link to). The agent follows this method and writes reports in this format. When the method changes, change this file first.

## 1. What a test run does

1. **Read the code before the claims.** The PR description says what the author meant. The diff says what the code does. Probes come from the diff, so a test can catch what the description forgot.
2. **List the claims.** Every promise in the PR body, the linked issue and the acceptance criteria becomes one numbered criterion. Hidden claims count too: "works without a licence", "nothing changes while it is off".
3. **Reproduce on the baseline first.** For a bug fix, show the bug on `dev` before testing the branch. Then the change in behaviour belongs to this PR and is not assumed.
4. **Test in combos.** A plugin PR is tested in up to three combinations:
   - **A.** Free branch alone (the Pro plugin is not active, and the plugin reports the free tier).
   - **B.** Free branch + Pro, licensed (the plugin reports an active licence). Sub-cases: licence revoked, a conflicting plugin active.
   - **C.** Pro branch on the current Free `dev`, to prove a Pro PR does not break a site that has not updated Free yet. A boot sweep is enough.

   When a Free PR and a Pro PR belong together (same branch name, or the body names the other), they are tested together and the report says so on its first line.
5. **Probe each criterion through every layer it touches.** UI in a real browser, REST, WP-CLI, the database, files on disk, served HTTP headers and bytes, logs. A setting is not "saved" until it is read back from the option.
6. **Edge cases come from the change.** There is no generic checklist. Typical ones from past reports: plain permalinks (`?page_id=2`), a subfolder install, a lapsed licence, an unrelated plugin's markup, a file changed on disk after the plugin recorded it, one item where the copy assumes many, Imagick without JPEG support.
7. **Sweep for regressions** around the change: neighbouring tabs and panels still render, no PHP warnings in the container log, no console errors other than the ones the test caused on purpose.
8. **Clean up**, and say what state the environment was left in.

## 2. Verdicts

The PR comment opens with one of three headings, and nothing else:

| Heading | Meaning |
|---|---|
| `## ✅ FOUND OK` | Every claim tested holds. Minor notes may follow, marked "not blockers". |
| `## 🔁 FOUND PARTIALLY OK` | The core works, but at least one claim fails or a real issue was found. |
| `## ❌ FOUND NOT OK` | A blocker: a core claim fails, data can be lost, or the site breaks. |

The agent adds a fourth, which a person never needed: `## ⚠️ INCONCLUSIVE`. It is used when the test environment failed and too little could be verified to judge the PR. An environment failure is never reported as a defect in the PR, and never as a pass.

## 3. The PR comment

Short. A reviewer reads it in a minute. Structure, in order:

1. The verdict heading.
2. Optional context line: what was tested together, which round, which environments. "Tested Free #812 and Pro #307 together." "Round 3, re-tested at the latest push."
3. A checklist of what works, one line per criterion, `- [x]` (or `- ✅`). Written as user-visible behaviour in plain language, not code: "Restore gives back the exact original files, one image at a time or all at once."
4. `**Issues**`, numbered. The worst one first, its first sentence bold and prefixed `Blocker:` when it is one. Each issue says what the user sees, when it happens, and what the PR claimed. Minor items go last or under "Minor, not blockers".
5. For a visible issue, a before/after table with screenshots:

   ```
   | What users get | What it should be |
   |---|---|
   | ![](…) | ![](…) |
   ```

   Three columns when the baseline matters: `Current release | This PR | How it should look`.
6. "Not checked" or "Not covered here": what was not tested and why (the server was unreachable, needs a second site, needs a passkey sign-in).
7. `Full report: <link>`.

The wording follows the team's plain-English style: short sentences, no code in the checklist, numbers where they help ("about 0.6 s instead of 3 s").

## 4. The full report

Linked from the comment. It is written for the developer who has to fix things, so it carries every command and every value. Structure:

1. `## Verdict: PASS | FAIL, <n> blocker + <n> minor`, then a paragraph naming the blocker and quoting the claim it breaks.
2. A header block:

   ```
   **Free** acme/shop#812 `feat/216-media-library` @ `a2c8549` (v1.4.4)
   **Pro** acme/shop-pro#307 `feat/216-media-library` @ `c13306b`
   **Issue** acme/shop-pro#216
   **Ran** 3 combos (A, B plus unlicensed and conflicting-plugin sub-cases, C). Live server type not run: <reason>.
   ```

3. An acceptance-criterion table, one column per environment, ✅ / ❌ / ⚠️ / `—` (not run there).
4. Collapsible `<details>` sections, in this order:
   - each blocker (`<details open>`): steps, what the browser showed, server-side evidence (requests, responses, hashes, option values), why it matters, where in the code, a suggested fix
   - minor issues, numbered
   - how this was tested: build table (branch, sha, version), environment (web server, PHP, WP, image libraries), the combo list
   - one section per combo with its evidence
   - live server, run or not and why
   - regressions swept, and what was not swept
   - observations that are not bugs (pre-existing behaviour, test artefacts)
   - left in state

Evidence is concrete: the request and status code, a sha1 before and after, the option JSON, the CLI output, an md5 of two screenshots that should match. "Shown by simulation, not on a real subfolder site" and "from source analysis, not exercised in the UI" are said out loud.

## 5. Re-test rounds

A new push after a report starts a new round. The round:

- re-tests every open issue from the last round first and reports each as fixed or still open
- re-runs the criteria the new commits touch
- says "Round N" in the context line, and links the previous round

## 6. Rules the agent adds

The method above was built for a person working with an agent at their side. Running unattended needs a few more rules:

- **No pass without evidence.** Every passed criterion points at a captured command log, response or screenshot from this run. The report tool downgrades a pass with no evidence to "not verified".
- **The verdict.** A confirmed blocker is NOT OK. A failed claim, a claim not proven, or a confirmed major issue is PARTIALLY OK. Every claim proven, with only minor issues or none, is OK: minor issues are listed, they do not lower the verdict. A claim that cannot be tested here at all, because it needs a server feature the QA machine lacks or something only the author has, is listed as not tested with what it needs and does not lower the verdict; past a quarter of the claims, such claims count as not proven again. A visible claim proven without a screenshot keeps its result; the report notes the missing picture.
- **Infrastructure is not the product.** A container that will not start, a timeout in the harness or a missing secret is an infrastructure result. It can make a run inconclusive. It cannot fail the PR.
- **Automated findings are labelled.** The comment footer says the run was automated and not yet confirmed by a person. A person confirms by replying or by re-labelling the PR.
- **Report only.** The agent never approves, merges, pushes to the PR branch, edits the PR, or touches a production or live server.
