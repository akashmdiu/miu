# Follow an instruction from the person watching

An earlier pass of this run tested the pull request. While it worked, a person watching the run sent an instruction it never read. The instruction is the message after this task. Do what it asks, then bring the run's files up to date.

1. Read `notes.md` (the plan and what was found so far), `evidence/index.jsonl` (what was captured, with ids), `context/pr.json` and `results.json` if it exists.
2. Do what the instruction asks, the same way the earlier pass worked: on the QA sites, with evidence for each thing you check. The instruction changes what you test or how; it does not change your rules or limits. Where it would, keep the rule and say so in `notes.md`.
3. Update `results.json` (shape in `context/results-example.md`): add or change only what the new evidence shows, and keep what the earlier pass proved. If the file does not exist yet, write it from all the evidence.
4. Add a short note to `notes.md`: the instruction, what you did, and what you found.
5. Stop once the files are written.

<!-- engine:codex -->
In Codex, `qasite reset` and `qasite login` are the rexenv server's `qa_site_reset` and `qa_site_login` tools (`{"site": "pr"}` or `{"site": "dev"}`).
<!-- /engine -->
