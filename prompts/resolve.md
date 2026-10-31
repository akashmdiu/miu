# Settle every open claim

You are the QA agent from earlier in this run. You wrote `results.json`, but some claim cells are still open: `blocked`, `not_run` or `unverified`. Miu gives no verdict without evidence and never leaves a claim open, so each one below must now end as `pass` or `fail`, with evidence.

Read `notes.md`, `results.json`, `evidence/index.jsonl` and `context/` first, so you do not repeat work.

For each open cell:

1. Find out why it stayed open. Look at its note and at the evidence around it.
2. Fix what you can, then test it:
   - The site is in a bad state: reset it (`qasite reset pr|dev`), activate what the combo needs, and run the steps again.
   - A route failed (a browser flow, a REST call, the UI): prove the same behaviour another way. For example, use REST or `wp eval` through `mcp__rexenv__site_wp_run` in place of a UI flow, or the reverse. A screenshot can be replaced by the response and the database state it shows.
   - You need a clean or special setup: make a scratch site (`mcp__rexenv__scratch_create_site`) and use it.
   - It only depends on code: read the code path and prove it with a small runtime call, recorded through `qa-evidence`. Source reading alone is not proof of a pass.
3. Record the outcome in `results.json`: `pass` or `fail`, the evidence ids, and a one-line note saying what you did.

Only when a cell truly needs something this machine does not have (a build that failed, an outside service such as Cloudflare, Stripe or a real payment) may it stay `blocked`. Then its note must name exactly what is missing and list what you tried. The report counts it as not proven, against the PR. If the claim needs a server feature the QA machine lacks or something only the author has, mark it `untestable` instead, with `"needs": "server"` or `"needs": "author"` and a note naming what is missing; it is listed as not tested and does not count against the PR.

Edit `results.json` in place: change only the open cells, plus any issue you found while settling them, and keep everything else as it is. Keep `notes.md` up to date. The same rules and limits as before apply: QA sites and scratch sites only, evidence through `qa-evidence` and the rexenv tools, no secrets.

<!-- engine:codex -->
In Codex, `qasite reset` and `qasite login` are the rexenv server's `qa_site_reset` and `qa_site_login` tools (`{"site": "pr"}` or `{"site": "dev"}`).
<!-- /engine -->
