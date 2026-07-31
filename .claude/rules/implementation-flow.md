# Implementation flow (binding)

- ALL implementation work (features, fixes, refactors) goes through the `/implement` skill's 17-step flow. No source or test file may be edited outside it.
- Never commit to `main`. Work happens on `issues/<N>` branches (single PR) or stack layer branches `issues/<N>-<slug>` (stacked PRs) only; changes reach `main` exclusively via pull requests (branch protection enforces this server-side, hooks enforce it locally).
- The guard hooks (`.claude/hooks/`), this rule file, and the /implement skill change only through a maintainer-approved pull request dedicated to workflow changes — never as a side effect of an implementation task.
- The per-issue state file `.claude/impl/issue-<N>.state` must reflect reality. Marking a step `done` without its completion criteria and artifacts is a violation, not a shortcut.
- Fixed design decisions listed in `AGENTS.md` are binding. Do not re-litigate them in plans, comments, or code. To change one, stop and ask the human maintainer.
- Reviews (plan / docs / tests / code) are independent Codex reviews per the user-level codex-delegation rules; every finding is either addressed or explicitly rejected with a recorded reason.
- Comments and JSDoc are the design document: they must cover the 5W1H substance with emphasis on How and Why, in natural prose — no fixed template is required, but missing substance is a review blocker.
