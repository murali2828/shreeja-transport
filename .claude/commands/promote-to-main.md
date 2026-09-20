---
description: Fast-forward qa into main safely after UAT sign-off (prints the plan, pushes only on explicit approval)
---
Promote the UAT-approved `qa` branch to `main`. Follow every step; stop and report on any surprise.

1. `git fetch origin --prune` and confirm the working tree is clean (`git status -sb`); abort if not.
2. Show what would be promoted: `git log --oneline origin/main..origin/qa`. If it is empty, say "nothing to promote" and stop.
3. Confirm `main` has nothing that `qa` lacks: `git log --oneline origin/qa..origin/main` must be empty. If it is not, do NOT merge or rebase anything; report the divergence and stop — the user decides.
4. Confirm CI is green for the `origin/qa` head (`gh run list --branch qa --limit 3` if `gh` is available; otherwise ask the user to confirm).
5. List the migrations that `main` does not have yet (`git diff --name-only origin/main..origin/qa -- backend/migrations/`) and any new env vars (`git diff origin/main..origin/qa -- .env.example .env.qa.example`), so the operator can prepare `.env` before deploying.
6. Print the exact commands and ask for approval before running them:
   ```
   git checkout main && git pull --ff-only origin main
   git merge --ff-only origin/qa
   git push origin main
   git checkout qa
   ```
   Never use `--force`, never merge with a merge commit, never rebase `main`.
7. After the push, print the PROD deploy commands (`/deploy-commands prod`) and the list from step 5, and add a dated line to `## Current state` in `CLAUDE.md` plus move the `[Unreleased]` items in `docs/CHANGELOG.md` under a dated heading (commit on `qa`).
