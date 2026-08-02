# Implementation flow (binding)

- ALL implementation work (features, fixes, refactors) goes through the `/implement` skill's 17-step flow. No source or test file may be edited outside it.
- Never commit to `main`. Work happens on `issues/<N>` branches (single PR) or stack layer branches `issues/<N>-<slug>` (stacked PRs) only; changes reach `main` exclusively via pull requests (branch protection enforces this server-side, hooks enforce it locally).
- The guard hooks (`.claude/hooks/`), this rule file, and the /implement skill change only through a maintainer-approved pull request dedicated to workflow changes — never as a side effect of an implementation task.
- The per-issue state file `.claude/impl/issue-<N>.state` must reflect reality. Marking a step `done` without its completion criteria and artifacts is a violation, not a shortcut.
- Fixed design decisions listed in `AGENTS.md` are binding. Do not re-litigate them in plans, comments, or code. To change one, stop and ask the human maintainer.
- Reviews (plan / docs / tests / code) are independent Codex reviews per the user-level codex-delegation rules; every finding is either addressed or explicitly rejected with a recorded reason.
- Comments and JSDoc are the design document, written in English, with emphasis on **Why** (rationale, rejected alternatives, constraints) and **design-level How** (approach choice, invariants, contracts, non-obvious mechanics). Never restate what adjacent code expresses line-by-line — that includes copying literal values, string content, or step sequences the code already shows.
- 5W1H is a reviewer's completeness checklist, not a writing format: comments are natural prose. Labeled section headings (`What:`, `Why:`, `How:`, …) are forbidden.
- During the docs-first step the comment prose is the spec and may describe the future implementation ("the eventual regex is …"). The implementation step must reconcile comments with the final code: rewrite spec tense to timeless present tense, and prune any How the code now expresses directly. Comments never describe the repository's current development status or what existed before an issue — git history, issues, and PRs carry process context.
- Shipped comments reference only artifacts that exist in the public repository. GitHub issue/PR numbers (`#14`) are allowed; references to uncommitted files (`.claude/impl/` plans, local state) are forbidden.
- Public API JSDoc is consumer-facing documentation surfaced in editor tooltips and generated docs: behavior, parameters, returns, errors, and examples in TSDoc style. Internal design rationale goes in implementation-side comments or `@remarks`, not in the summary a library consumer reads.
- Missing substance in any of the above is a review blocker.
