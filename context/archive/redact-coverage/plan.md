# Redaction covers common secret spellings (S-22)

## Cause

`packages/core/src/redact.ts` is meant to fail closed (AGENTS.md), but these inputs come back unchanged from `redact()` today:

`DB_PASS=hunter2secret`, `MYSQL_PWD=hunter2xyz`, `pwd=hunter2xyz`, `passphrase=correcthorse`, `ACCESS_KEY=abcd1234efgh`, `AUTH_KEY=abcd1234efgh`, `password=abc12`, `--pass hunter2xyz`, `mysql -u root -phunter2xyz`, `sshpass -p hunter2xyz ssh x`, `curl -u bob:hunter2xyz https://x.io`, `xai-abcdefghij1234567890abcdefghij12345`, `gsk_abcdefghij1234567890abcdefghij12345`, `dop_v1_abcdef1234567890abcdef1234567890`, `https://hooks.slack.com/services/T000/B000/XXXXXXXXXXXXXXXX`.

## Phase 1: rules and tests

Files: `packages/core/src/redact.ts`, `packages/core/src/redact.test.ts`.

1. Tests first: add every input above as a new case; each must lose its secret value. Build secret-shaped literals the way the file already does, so the fixture-secrets test stays green.
2. `SECRET_WORD`: add `passphrase`, `access[_-]?key`, `auth[_-]?key`, and `pass` / `pwd` / `passwd` only as a whole `_.-`-separated word of the key (`DB_PASS`, `MYSQL_PWD`, `pwd`, not `compass`, `bypass`, `passive`). `NOT_SECRET_SUFFIX` still applies.
3. Unquoted values of a secret key: minimum length 3, as quoted values already have. Non-secret keys must not get more expensive in a way that breaks `redact.perf.test.ts`.
4. Flags: the flag rule (`CLI_FLAG`) goes through `isSecretKey`, so `--pass` follows from step 2. Add command-specific rules, bounded and linear: `mysql`/`mariadb`/`mysqldump` attached `-p<value>`; `sshpass -p <value>`; `curl`/`wget` `-u`/`--user`/`--user=` with `user:value` (the value is redacted, the user may stay).
5. Tokens in `TOKEN_PATTERNS`: `xai-`, `gsk_`, `dop_v1_`, and Slack webhook URLs (`hooks.slack.com/services/...`).
6. Negative tests must stay unchanged, and add: `compass=northwest1`, `bypass=enabled123`, `pwd` alone, `cd $(pwd)`, `curl -u` with no colon, `mysql -p` alone.

Done when: all cases pass, `redact` stays idempotent (the existing property tests pass), and `pnpm check` and the gate are green. Existing expectations are not edited: if one disagrees, stop and report.

## Non-goals

Reworking the pipeline, entropy thresholds, `--list`/`--json` (S-23), status rules.

## Gate
```gate
allow: ^packages/core/src/redact(\.test)?\.ts$
allow: ^context/(changes|archive)/redact-coverage/
deps: no
schema: no
```

## Review fixes (round 1)

Same two files. Each fix gets a test that fails on the current branch. Do not edit existing expectations.

- R1: the mysql attached flag is case-sensitive: `mysql -P3306 -h x` stays unchanged, `mysql -pabc123` is still redacted.
- R2: curl/wget partial quoting loses the value: `curl -u bob:'hunter2xyz' x`, `curl -u 'bob':hunter2xyz x`, `curl -u "bob":hunter2xyz x`.
- R3: combined short flags: `curl -su bob:hunter2xyz x`, `curl -fsSu bob:hunter2xyz x`.
- R4: backslash-escaped quotes lose the whole value for mysql and sshpass: `mysql -p\"hunter2xyz\"`, `sshpass -p \"hunter2xyz\" ssh x`. The output must not contain `hunter2xyz`.
- R5: sshpass reads `-p` only among its own options, before the wrapped command: `sshpass -e ssh x -p 22` and `sshpass -f file ssh -p 2222 host` stay unchanged; `sshpass -v -p hunter2xyz ssh x` is redacted.
- R6: a key that is exactly `pwd` (any case) with a value starting with `/`, `~` or `.` is a working directory, not a secret: `PWD=/home/u/app` must behave as on main (`PWD=~/app`); `pwd: /srv` stays. `pwd=hunter2xyz` stays redacted.
- R7: the unquoted minimum is 3 for `:` too, as the plan says: `password: abc` is redacted. If this breaks an existing expectation, keep 4 for `:`, do not edit the expectation, and name the test in your report.
