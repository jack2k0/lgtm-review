# test-projectdir

`api.map.test.ts:78` and `api.play.test.ts:55` build the Claude project dir with `cwd.replace(/[/.]/g, "-")`; the server (`discover.ts` `projectDirFor`) replaces every non-alphanumeric. With a temp dir containing `_` (macOS `/var/folders/…/s_v1…`) the session is not found → 404 (10/12 api.map tests fail on main). Fix the two helpers to `/[^a-zA-Z0-9]/g`. Proof: both files fail on main with the default macOS `TMPDIR` and pass after.

```gate
allow: ^packages/cli/src/api\.(map|play)\.test\.ts$
allow: ^context/(changes|archive)/test-projectdir/
deps: no
schema: no
```
