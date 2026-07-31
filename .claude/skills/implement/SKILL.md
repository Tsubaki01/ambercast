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
step01_issue=done
...
step17_merged=done
```

Artifacts live next to it: `.claude/impl/issue-<N>-plan.md` and `.claude/impl/issue-<N>-reviews/`.

## Reviews (steps 4, 8, 10, 12)

Reviews are independent: performed by OpenAI Codex CLI per the user-level codex-delegation rules (reviewer model: `gpt-5.6-sol`; load the codex-delegation skill before invoking `codex exec`). If Codex is unavailable in your environment, use an equally independent reviewer agent with a fresh context. Save every review verdict as a Markdown file under `.claude/impl/issue-<N>-reviews/`. Address every finding or record an explicit, reasoned rejection — silence is not an option.

## The 17 steps

1. **Issue** — If no GitHub issue covers the task, create one (`gh issue create`) with a clear problem statement and acceptance criteria. Record `issue=<N>`. → `step01_issue=done`
2. **Branch** — Single-PR work: create `issues/<N>` from up-to-date `main` (`git switch -c issues/<N>`). Stacked work (see step 3): create layer branches `issues/<N>-<slug>` via `gh stack init issues/<N>-<first-slug>` and `gh stack add issues/<N>-<next-slug>`. Hooks accept both forms and reject everything else; all layers of an issue share one state file. → `step02_branch=done`
3. **Plan** — Write the implementation plan to `.claude/impl/issue-<N>-plan.md`: scope, affected files, component/module design, algorithms, data structures, test strategy, out-of-scope notes. **Decide single PR vs stacked PRs here**: if the change splits into 2+ independently reviewable layers (foundation → consumers, e.g. schema → serializer → CLI wiring), plan a stack — list the layers in dependency order with one slug and one-line scope each. Stacks are strictly linear; unrelated work gets its own issue, not a layer. Follow the `gh-stack` skill (`.agents/skills/gh-stack/SKILL.md`) for all stack commands. → `step03_plan=done`
4. **Plan review (7 perspectives, parallel)** — Run parallel Codex reviews of the plan, one per perspective: component design (ONLY when the task involves frontend/UI work — skip otherwise and note the skip), code design, algorithms, data structures, test design, intended code, implementation plan. Save each verdict separately. → `step04_plan_review=done`
5. **Revise plan** — Fold review findings into the plan file (keep a short "review outcomes" section listing what changed and what was rejected why). → `step05_plan_revised=done` (hooks now allow `src/` edits)
6. **Scaffold** — Create every file the plan says will exist, as empty skeletons (exports, types, signatures — no logic). → `step06_scaffold=done`
7. **Docs first** — Write ALL comments/JSDoc before any logic: file-header comments and JSDoc that together cover the 5W1H substance — What/Why/Who/When/Where/How — with extra weight on **How** and **Why**. No fixed template or headings required; natural, well-written prose. These comments ARE the design document the next steps verify against. → `step07_docs=done`
8. **Docs review** — Codex review of the commented skeletons: is the code design sound, does it follow best practices, are the comments complete enough to implement from? → `step08_docs_review=done` (hooks now allow test edits)
9. **Tests** — Implement the full test suite from the comment spec: normal, error, boundary, and edge cases (plus performance/security where relevant). Exhaustiveness beats economy — a large test body is acceptable by design. Tests must fail at this point (red). → `step09_tests=done`
10. **Tests review** — Codex review of tests against the comment spec: contradictions? missing cases? → `step10_tests_review=done`
11. **Code** — Implement until the ENTIRE suite passes (green), then refactor with the suite kept green. Do not weaken or delete tests to pass; if a test is wrong, fix it with justification recorded in the plan file. → `step11_code=done`
12. **Code review** — Codex review of the implementation (correctness, best practices, consistency with comments/plan). → `step12_code_review=done`
13. **Push** — Single PR: push the branch. Stack: `gh stack push`. → `step13_push=done`
14. **CI** — Watch CI (`gh run watch` / `gh pr checks`); fix until everything is green (every layer PR in a stack). → `step14_ci=done`
15. **PR** — Single PR: open it referencing the issue (`Closes #<N>`), summarizing plan, reviews, and test coverage. Stack: `gh stack submit --auto --open`, then `gh pr edit` each layer PR so the bottom layer closes the issue and every body explains its layer's scope. → `step15_pr=done`
16. **CodeRabbit** — Wait for the CodeRabbit review on every PR (poll `gh pr view --comments`), address every finding, resolve all conversations. In a stack, fix findings on the layer they belong to (`gh stack checkout <branch>`), then `gh stack rebase --upstack` and `gh stack push`. → `step16_coderabbit=done`
17. **Merge** — Single PR: merge via GitHub (branch protection requires the PR checks and resolved conversations). Stack: `gh stack merge --yes` (bottom-to-top, all-or-nothing; `gh pr merge` does not work on stacked PRs), or merge reviewed lower layers first — upper PRs retarget automatically. Afterwards `gh stack sync --prune`, delete branches. → `step17_merged=done`

## Hard rules

- Steps run in order; never parallelize across steps (parallelism happens inside a step, e.g. the 7 review perspectives).
- Fixed design decisions in `AGENTS.md` are binding — do not re-litigate them in code or plans; propose changes to the human instead.
- If a step fails repeatedly or the plan proves wrong mid-flow, go back to step 3, revise the plan, and re-run reviews for what changed — do not improvise forward.
