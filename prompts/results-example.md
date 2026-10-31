# results.json, a full example

A filled-in example of every field. Copy its shape; the values are from an old run.

```json
{
  "repo": "acme/shop",
  "pr": 812,
  "head_sha": "full sha",
  "round": 1,
  "context_line": "Tested Free #812 and Pro #307 together.",
  "verdict_summary": "One paragraph for the full report: the blocker in plain words and the claim it breaks, or what was verified.",
  "builds": [{ "label": "Free", "repo": "acme/shop", "pr": 812, "branch": "feat/x", "sha": "…", "version": "1.4.4" }],
  "linked_issues": ["acme/shop-pro#216"],
  "ran": "qa-dev.rex for the before state, qa-pr.rex for combos A, B and B-unlicensed (reset between them), nginx, PHP 8.3. Live OLS not run: not available to automated runs.",
  "environments": [{ "id": "A", "label": "Free alone" }, { "id": "B", "label": "Free + Pro licensed" }],
  "criteria": [
    {
      "id": 1,
      "claim": "Compressing original images stays off until the owner switches it on, and nothing changes while it is off",
      "source": "pr_body | issue | diff | implied | previous_round",
      "visible": true,
      "baseline": { "status": "reproduced | not_reproduced | absent_before | same_before", "evidence": ["ev-004", "ev-005"], "note": "on dev the valid value next to the empty one was lost" },
      "results": { "B": { "status": "pass", "evidence": ["ev-012", "ev-013"], "note": "sha1 unchanged" } }
    },
    {
      "id": 2,
      "claim": "Copied files are served with a one-year immutable cache policy",
      "source": "pr_body",
      "visible": false,
      "results": { "A": { "status": "untestable", "needs": "server", "evidence": ["ev-020"], "note": "needs the plugin's nginx rule installed and nginx reloaded, which the QA site may not do; Apache is not available. Tried a reset, a fresh copy and an anonymous GET: 200 without the header (ev-020)" } }
    }
  ],
  "issues": [
    {
      "severity": "blocker | major | minor | nit",
      "title": "With no active licence there is no way to restore originals from the dashboard.",
      "user_impact": "The whole tab turns into the License required screen, so a site whose licence lapses can't undo compression.",
      "claim_broken": "Restore works per image, per selection or for all, and works without a licence",
      "steps": ["…"], "expected": "…", "actual": "…",
      "evidence": ["ev-031"],
      "before_after": { "columns": ["What users get", "What it should be"], "images": ["ev-032", ""] },
      "code_ref": "src/components/ProTabBody.tsx:41",
      "suggested_fix": "…",
      "from_source_analysis": false
    },
    {
      "kind": "business",
      "severity": "blocker",
      "title": "Free sends the site URL to an outside service before the owner opts in.",
      "user_impact": "Breaks the no-telemetry-without-opt-in rule (AGENTS.md) and wordpress.org guidelines.",
      "rule": "No telemetry or outbound HTTP without explicit opt-in",
      "evidence": ["ev-051", "ev-052"], "code_ref": "includes/class-hub.php:88"
    }
  ],
  "business": [
    { "rule": "Free never names Pro", "status": "fits | conflicts", "where": "grep of the diff for shop-pro, Pro class names and the Pro textdomain: none", "evidence": ["ev-040"] },
    { "rule": "Compression of originals is a Pro feature (FEATURES.md)", "status": "fits", "where": "FEATURES.md row and the Module_Registry tier check in the diff" }
  ],
  "not_covered": [{ "what": "Backups unreachable over HTTP on OpenLiteSpeed", "why": "no OLS server in automated runs" }],
  "how_tested": "Markdown: build table, environment (web server, PHP, WP, image libraries), combo list.",
  "sections": [{ "title": "Combo B: Free + Pro, licensed", "body": "Markdown with the commands, values and evidence ids for this combo." }],
  "regressions": { "swept": ["Lazy Loading tab still renders"], "not_swept": ["bulk convert on a large library"] },
  "observations": ["Pre-existing: … (not from this PR)"],
  "infra_problems": [{ "what": "…", "impact": "criteria 4 and 5 blocked", "blocking": false }],
  "left_in_state": "Disposable containers, removed after the run."
}
```
