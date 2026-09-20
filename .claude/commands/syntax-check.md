---
description: node -c every changed backend .js file and run the Vite build when frontend files changed
---
Run the same checks CI runs, scoped to what changed. Report each result; fix and re-run on failure.

1. Collect changed files vs the upstream branch plus uncommitted work:
   `git diff --name-only origin/qa...HEAD -- backend/src backend/scripts frontend/src` and
   `git status --porcelain -- backend frontend` (union, de-duplicated).
2. For every changed `backend/**/*.js` file that still exists, run `node -c <file>`. If no backend
   file changed, say so. If the user passed `all` as `$ARGUMENTS`, instead walk all of `backend/src`
   the way CI does: `cd backend && node -e "const fs=require('fs'),cp=require('child_process');function walk(d){for(const f of fs.readdirSync(d,{withFileTypes:true})){const p=d+'/'+f.name;if(f.isDirectory())walk(p);else if(f.name.endsWith('.js'))cp.execSync('node -c '+p);}}walk('src')"`.
3. If any `frontend/**` file changed (or `all` was passed), run `cd frontend && npx vite build --logLevel error`
   (run `npm ci` first if `frontend/node_modules` is missing). Do not commit `frontend/dist`.
4. Also grep the changed backend files for new `process.env.` names and check each one exists in
   `.env.example` and `.env.qa.example`; list any that are missing.
5. Summarise: files checked, pass/fail per file, build result, missing env vars.

There is no automated test suite in this repo; do not invent test commands.
