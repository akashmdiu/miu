# Finish this QA run

An earlier pass of this run tested the pull request and ran out of turns or time before it wrote `results.json`. Your only job is to write that file now from what it already captured. Do not test anything new, start servers, or change the sites.

1. Read `notes.md` (its plan and findings), `evidence/index.jsonl` (every captured command, HTTP response and screenshot, with ids) and `context/pr.json` for the claims.
2. Read `context/results-example.md` for the exact shape of `results.json`.
3. Write `results.json` in the run directory:
   - one criterion per claim of the PR, in the PR's words
   - a result only where the evidence shows it, citing the evidence ids; open an evidence file when its label does not say enough
   - a claim the earlier pass never reached is `not_run`, with a note that the run ran out before it
   - issues only where the evidence shows a real failure
4. Stop once the file is written. Keep it short: you have about 20 turns.
