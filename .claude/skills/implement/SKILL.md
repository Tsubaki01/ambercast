---
name: implement
description: Mandatory 17-step implementation flow for this repository — issue, branch, plan, multi-perspective review, docs-first coding, comprehensive tests, CI, CodeRabbit, merge. Use for EVERY implementation task (feature, fix, refactor). Invoke before writing any source code.
---

# /implement — the only way code lands in this repository

Every implementation task MUST go through these 17 steps, in order. Progress is tracked in a per-issue state file; PreToolUse hooks block source/test edits until the required steps are recorded as done. Do not edit the state file to skip a step — a step is `done` only when its completion criteria and artifacts exist.

## State file

Path: `.claude/impl/issue-<N>.state` (gitignored). One `key=value` per line:

```
issue=<N>
branch=issues/<N>
layers=<slug1>,<slug2>
step01_issue=done
...
step17_merged=done
```

`branch=` is `issues/<N>` for single-PR work. For stacked work, set `branch=` to the bottom layer branch (`issues/<N>-<slug1>`) and list every layer slug bottom-to-top in `layers=` (omit `layers=` for single-PR work). All layer branches of an issue share this one state file — the hooks resolve any `issues/<N>-<slug>` branch to `issue-<N>.state`.

Artifacts live next to it: `.claude/impl/issue-<N>-plan.md` and `.claude/impl/issue-<N>-reviews/`.

## Reviews (steps 4, 8, 10, 12)

Reviews are independent: performed by OpenAI Codex CLI per the user-level codex-delegation rules (reviewer model: `gpt-5.6-sol`; load the codex-delegation skill before invoking `codex exec`). If Codex is unavailable in your environment, use an equally independent reviewer agent with a fresh context. Save every review verdict as a Markdown file under `.claude/impl/issue-<N>-reviews/`. Address every finding or record an explicit, reasoned rejection — silence is not an option.

## The 17 steps

1. **Issue** — If no GitHub issue covers the task, create one (`gh issue create`) with a clear problem statement and acceptance criteria. Record `issue=<N>`. → `step01_issue=done`
2. **Branch** — Single-PR work: create `issues/<N>` from up-to-date `main` (`git switch -c issues/<N>`). Stacked work (see step 3): create layer branches `issues/<N>-<slug>` via `gh stack init issues/<N>-<first-slug>` and `gh stack add issues/<N>-<next-slug>`. Hooks accept both forms and reject everything else; all layers of an issue share one state file. If any `gh stack` command exits with code 9 (stacks unavailable), stop and tell the maintainer. → `step02_branch=done`
3. **Plan** — Write the implementation plan to `.claude/impl/issue-<N>-plan.md`: scope, affected files, component/module design, algorithms, data structures, test strategy, out-of-scope notes. **Decide single PR vs stacked PRs here**: if the change splits into 2+ independently reviewable layers (foundation → consumers, e.g. schema → serializer → CLI wiring), plan a stack — list the layers in dependency order with one slug and one-line scope each. Stacks are strictly linear; unrelated work gets its own issue, not a layer. Follow the `gh-stack` skill (`.agents/skills/gh-stack/SKILL.md`) for all stack commands. → `step03_plan=done`
4. **Plan review (7 perspectives, parallel)** — Run parallel Codex reviews of the plan, one per perspective: component design (ONLY when the task involves frontend/UI work — skip otherwise and note the skip), code design, algorithms, data structures, test design, intended code, implementation plan. Save each verdict separately. → `step04_plan_review=done`
5. **Revise plan** — Fold review findings into the plan file (keep a short "review outcomes" section listing what changed and what was rejected why). → `step05_plan_revised=done` (hooks now allow `src/` edits)
6. **Scaffold** — Create every file the plan says will exist, as empty skeletons (exports, types, signatures — no logic). → `step06_scaffold=done`
7. **Docs first** — Write ALL comments/JSDoc before any logic, following the comment rules in `.claude/rules/implementation-flow.md`: English, natural prose, emphasizing **Why** (rationale, rejected alternatives, constraints) and **design-level How** (approach choice, invariants, contracts). 5W1H — What/Why/Who/When/Where/How — is the reviewer's completeness checklist, NOT a writing format: never write labeled `What:`/`Why:` headings. Spec tense ("the eventual regex is …") is allowed and expected at this step. Public API JSDoc must read as consumer documentation (TSDoc style); internal rationale goes in implementation-side comments or `@remarks`. Reference only committed artifacts (issue/PR numbers yes, `.claude/impl/` plans no). These comments ARE the design document the next steps verify against. → `step07_docs=done`
8. **Docs review** — Codex review of the commented skeletons: is the code design sound, does it follow best practices, are the comments complete enough to implement from? → `step08_docs_review=done` (hooks now allow test edits)
9. **Tests** — Implement the full test suite from the comment spec: normal, error, boundary, and edge cases (plus performance/security where relevant). Exhaustiveness beats economy — a large test body is acceptable by design. Tests must fail at this point (red). → `step09_tests=done`
10. **Tests review** — Codex review of tests against the comment spec: contradictions? missing cases? → `step10_tests_review=done`
11. **Code** — Implement until the ENTIRE suite passes (green), then refactor with the suite kept green. Do not weaken or delete tests to pass; if a test is wrong, fix it with justification recorded in the plan file. Then reconcile comments with the final code: rewrite spec tense to timeless present tense, prune any How the code now expresses line-by-line, and remove references to repo development status or uncommitted artifacts — keep Why, invariants, and contracts. → `step11_code=done`
12. **Code review** — Codex review of the implementation (correctness, best practices, consistency with comments/plan) including comments against every comment rule in `.claude/rules/implementation-flow.md`: Why and design-level How substance present, English natural prose with no labeled 5W1H headings, no line-by-line restatement of code, no stale spec tense or repo-status remarks, no references to uncommitted artifacts, public API JSDoc reads as consumer-facing TSDoc. Any missing comment-policy substance blocks this step. → `step12_code_review=done`
13. **Push** — Single PR: push the branch. Stack: `gh stack push`. → `step13_push=done`
14. **PR** — Single PR: open it referencing the issue (`Closes #<N>`), summarizing plan, reviews, and test coverage. Stack: `gh stack submit --auto --open`, then `gh pr edit` every layer PR: retitle each to a Conventional Commit describing that layer (each squash subject reaches main and the pr-title check runs per PR), make the bottom layer close the issue, and make every body explain its layer's scope. → `step14_pr=done`
15. **CI** — Watch the PR checks (`gh pr checks` / `gh run watch`); fix until everything is green on every PR (each layer in a stack). CI runs against pull requests, so this step must follow PR creation. → `step15_ci=done`
16. **CodeRabbit** — Wait for the CodeRabbit review on every PR (poll `gh pr view --comments`), address every finding, resolve all conversations. In a stack, fix findings on the layer they belong to (`gh stack checkout <branch>`), then `gh stack rebase --upstack` and `gh stack push`. Never invoke CodeRabbit commands (`@coderabbitai ...`) after a PR has merged; findings that arrive post-merge are filed as follow-up issues, not left as orphaned threads. → `step16_coderabbit=done`
17. **Merge** — Single PR: merge via GitHub (branch protection requires the PR checks and resolved conversations). Stack: never use `gh pr merge` on stacked PRs — use `gh stack merge --squash --yes` to land the whole stack bottom-to-top, or `gh stack merge <PR-number> --squash --yes` to land only the reviewed lower layers (upper PRs retarget automatically). `--squash` is mandatory: the repo allows only squash merges, and without the flag gh-stack falls back to a "last-used" method that may be unset or disabled. Direct stack merges are all-or-nothing, but if the base branch uses a merge queue, PRs are queued together and may land in separate groups. Verify every PR reports `MERGED` (`gh stack view --json`) before `gh stack sync --prune` and branch deletion. → `step17_merged=done`

## Hard rules

- Steps run in order; never parallelize across steps (parallelism happens inside a step, e.g. the 7 review perspectives).
- Fixed design decisions in `AGENTS.md` are binding — do not re-litigate them in code or plans; propose changes to the human instead.
- If a step fails repeatedly or the plan proves wrong mid-flow, go back to step 3, revise the plan, and re-run reviews for what changed — do not improvise forward.

## Autonomous continuation

- After completing each step, update the state file and state the progress in one line of the reply (e.g. "issue-13: step10_tests_review done, next: step11_code").
- After handling ANY background-task completion notification (Codex jobs, subagents, monitors), do not end the turn there: verify the result, update the state file and logs, then continue with the next incomplete step in the same turn. End a turn mid-flow only when the maintainer's input is strictly required.
- To pause the flow intentionally, append `paused=true` to the issue's state file (remove the line to resume). The Stop hook `.claude/hooks/guard_stop.py` blocks turn-ends while incomplete steps remain, names the next step, and backs off automatically after 3 consecutive blocks without progress.
- Idling while delegated background work (a teammate, subagent, or background shell) is still running is legitimate: the Stop hook allows it, and the completion notification re-wakes the session — at which point the continuation rules above apply again. Orchestrator sessions must delegate, not implement, even when pushed to continue.
- To disable the Stop hook entirely, set `AMBERCAST_GUARD_STOP=0` in the environment.
