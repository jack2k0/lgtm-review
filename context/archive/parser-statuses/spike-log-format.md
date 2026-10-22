# Spike: format logow sesji Claude Code (~/.claude/projects)

Probka: 132 pliki .jsonl (5 katalogow projektow; 32 sesje glowne + ~100 plikow subagentow), ~36.7k rekordow w pelnym skanie
(plus 18 plikow w skanie rozkladu pol). Rozmiar pliku: min 1 KB, mediana 0.68 MB, p90 2 MB, max 84 MB; najdluzsza linia ~257 KB.
Parsowanie: 0 uszkodzonych linii JSON. Wersja formatu dryfuje (pole `version` w rekordach) - parser musi byc tolerancyjny.
Wszystkie liczby ponizej to ordery wielkosci z probki, bez tresci promptow.

## 1. Typy rekordow, rozroznianie promptow

Pole `type` (czestosc w probce 18 plikow, 13.1k rekordow): assistant 4695, attachment 3120, user 2693, queue-operation 1518,
mode 1152, last-prompt 1149, atis-latch 1148, bridge-session 1035, ai-title 998, api-request 566, api-request-blob 539,
system 519, permission-mode 362, file-history-snapshot 86, file-history-delta 30, cost-state 22, api-request-shape 3,
agent-setting 1, continued-in 1.
`system.subtype`: turn_duration (378; durationMs, messageCount), scheduled_task_fire, away_summary, local_command,
informational, compact_boundary, stop_hook_summary, bridge_status.

Rekordy "wiadomosci" (maja `uuid`, `parentUuid`, `timestamp`, `sessionId`, `cwd`, `gitBranch`, `isSidechain`, `version`):
user, assistant, attachment, system. Reszta (mode, last-prompt, ai-title, bridge-session, atis-latch, queue-operation,
cost-state, api-request*, permission-mode, file-history-*) to metadane sesji BEZ uuid/parentUuid lancucha - ignorowac.

Prawdziwy prompt uzytkownika = `type:"user"` AND NOT `isMeta` AND NOT `isSidechain` AND `message.content` jest:
- stringiem, albo listą bez bloku `tool_result` (bloki `text`/`image`); AND
- nie zaczyna sie od znacznikow: `<command-name>` (slash command), `<local-command-stdout|caveat>`, `<task-notification`,
  `<system-reminder`, `[Request interrupted`; AND
- nie jest `isCompactSummary`; AND `origin.kind` nie jest `task-notification`/`peer`/`coordinator`/`auto-continuation`.
`origin` (opcjonalne, obiekt): `{"kind":"human"}` (wyraznie ludzki), `task-notification`, `peer` (`from`: agentId), `coordinator`,
`auto-continuation`. Brak `origin` na zwyklym prompcie jest normalny (7 vs 107 z origin=human w probce).
Ksztalty user (cala baza): content=list[tool_result] ~8.2k (w tym sidechain 4.5k), task-notification ~300, str+isMeta ~280,
prawdziwy str ~215, list[text] meta 26, slash-command ~35, local-command output 7, interrupt 2.
Dodatkowe pola user: `promptId` (ten sam dla calej tury), `permissionMode`, `promptSource`, `turnOrigin`, `turnPosition`,
`sourceToolAssistantUUID` (tylko tool_result), `scheduledTaskId/scheduledFireId` (prompty cron - nie ludzkie, `system.scheduled_task_fire` + user z tymi polami).
Slash command: user str zawierajacy `<command-name>/x</command-name><command-message>..<command-args>`; wynik komendy lokalnej: user `<local-command-stdout>`
albo `system` subtype `local_command`. `isSidechain:true` = wiadomosc subagenta (patrz 4); w plikach subagentow WSZYSTKIE rekordy maja isSidechain=true,
a pierwszy `user` (parentUuid:null) to prompt zlecony przez rodzica (nie czlowiek).
`attachment` (3120): `attachment.type` roznorodne (hooki, reminders, edited_file itd.), nie sa promptem; `renderedRole` mowi czy wstrzykniete jako user.

## 2. Wynik Bash i exit code

tool_use: `{type:"tool_use", id, name:"Bash", input:{command, description, timeout?, run_in_background?}}`.
Wynik: rekord `user`, content=[{type:"tool_result", tool_use_id, content:<str|list>, is_error?}], oraz `toolUseResult`.
- exit != 0: `is_error:true` AND tekst content zaczyna sie od `Exit code N\n...` (regex `^Exit code (\d+)`); w tym przypadku
  `toolUseResult` jest STRINGIEM ("Error: Exit code N\n<output>"), nie obiektem. Obserwowane N: 1 (62), 2 (28), 144, 127, 128, 4, 137, 255, 120.
- exit 0: brak `is_error`, `toolUseResult` to obiekt `{stdout, stderr, interrupted:false, isImage, noOutputExpected, [bashEditDiff], [gitOperation],
  [returnCodeInterpretation], [backgroundTaskId, backgroundCwdHint], [timedOutAfterMs]}`. Exit code NIE jest zapisany jawnie przy sukcesie (= 0).
- `returnCodeInterpretation` (np. "No matches found" dla grep=1, "Files differ" dla diff=1): exit 1 uznany za semantycznie nie-blad, `is_error` wtedy brak (52+1 w probce).
  => grep/diff/test-style z exit 1 moga wygladac jako sukces; polegaj na `is_error`, nie na samym kodzie.
- `is_error:true` BEZ "Exit code": blokady narzedzia (`<tool_use_error>Blocked: sleep ...`, `InputValidationError`, `No such tool`), odmowy uprawnien
  ("Permission for this command was denied", "The user doesn't want to proceed" + `toolDenialKind`), bledy srodowiska. To NIE jest wynik komendy -
  nie liczyc jako failing testu (komenda nie wykonana).
- Bash z `run_in_background:true`: wynik natychmiast z `backgroundTaskId` (exit code nieznany); koniec zadania przychodzi pozniej jako user `<task-notification>`
  (origin.kind=task-notification) z statusem/exit w tekscie. Dla nich status check jest "nieznany/pending" dopoki nie przyjdzie notyfikacja.
- `interrupted:true` w toolUseResult: 0 trafien w probce (przerwanie widac w 5).
- Czesc komend to zlozone (`cd x && cmd`, pipe, `;`): 6976/7.2k Bash zlozone, 3347 zaczyna sie od `cd ... &&`; exit code dotyczy calosci
  (przy pipe bez pipefail - ostatniego polecenia).

## 3. Kompaktowanie i resume

- Kompakt: `system` subtype `compact_boundary` (content "Conversation compacted", parentUuid:null, `logicalParentUuid` -> ostatni rekord przed kompaktem,
  `compactMetadata:{trigger:auto|manual, preTokens, durationMs, preservedSegment:{headUuid,anchorUuid,tailUuid}, preCompactDiscoveredTools}`),
  nastepnie `user` z `isCompactSummary:true` (+ `isVisibleInTranscriptOnly:true`, ~14 KB streszczenia) - NIE prompt uzytkownika.
  Po boundary lancuch parentUuid zaczyna sie od null: wiele "rootow" w jednym pliku jest normalne (127 user-rootow + 9 system-rootow w 132 plikach;
  tylko 1 prawdziwy orphan parentUuid na 36.7k rekordow).
- Resume/continue/fork: ten sam uuid wystepuje w >1 pliku sesji glownych (2178 uuid wspoldzielonych w probce: assistant 1033, user 566, attachment 504,
  system 75) - nowa sesja kopiuje historie poprzedniej z nowym `sessionId` w nowym pliku. Rekord `continued-in` ({continuedInSessionId}) wskazuje nastepce.
  Dedup po `uuid` w obrebie projektu, inaczej podwojne liczenie edycji/checkow. Pliki subagentow nie dziela uuid z plikiem rodzica.
- `timestamp` bywa nierosnacy (959 z 13k spadkow kolejnosci) - po kompaktach/resume; porzadkowac po kolejnosci w pliku/lancuchu parentUuid, nie po sortowaniu timestampow.
- Wiele rekordow assistant ma to samo `message.id` (jeden blok content na rekord, `apiBlockIndex`); rekord = 1 blok (thinking/text/tool_use) w typowym przypadku.

## 4. Subagenty

- Narzedzie nazywa sie `Agent` (nie `Task`; "Task" 0 trafien). input: `{description, prompt, model, run_in_background?, subagent_type?, effort?, isolation?}`.
- Layout: `~/.claude/projects/<proj>/<sessionId>.jsonl` + katalog `<sessionId>/subagents/agent-<agentId>.jsonl` i `agent-<agentId>.meta.json`
  (`{agentType, description, toolUseId, spawnDepth, requestShape, requestNonInteractive, model}`); `toolUseId` laczy z tool_use Agent w rodzicu.
  Dodatkowo `<sessionId>/tool-results/<id>.txt` - duze wyniki narzedzi wyniesione do plikow (w jsonl jest wtedy wskazanie/skrot, nie pelna tresc).
- W pliku subagenta: wszystkie rekordy `isSidechain:true`, `agentId`; pierwszy user ma parentUuid:null.
- W rodzicu wynik Agent (async): toolUseResult `{agentId, status, isAsync, outputFile, prompt, description, canContinueAgent, resolvedModel...}`;
  pozniej `<task-notification>`. Dla `isSidechain` rekordy w pliku rodzica (309 assistant/184 user w probce) tez wystepuja - filtrowac po `isSidechain`/`agentId`.
- Komendy/edycje subagentow (np. reviewer wywolujacy testy) dzieja sie w osobnych plikach; parser musi zdecydowac czy liczyc je do statusu promptu
  (sugestia: tak, jesli pochodza z poddrzewa tury - zlaczyc po toolUseId/agentId; domyslnie pomijac, gdy brak powiazania).
- `SubagentHandback`, `SendMessage`, `ListAgents`, `TaskStop` to narzedzia koordynacji (nie edycje/checki).

## 5. Przerwania

User str lub list[text] rowne `[Request interrupted by user]` (po przerwaniu w trakcie generacji) lub `[Request interrupted by user for tool use]`
(po odrzuceniu/przerwaniu narzedzia; pole `interruptedMessageId`, czasem tool_result z `is_error` i "The user doesn't want to proceed with this tool use");
`toolEndsTurn`/`toolDenialKind` na rekordach odmowy. Rzadkie (2 rekordy w probce, kilkanascie w calosci). To NIE jest nowy prompt - nie zaczynac nowej tury.
Przerwana komenda Bash nie ma wiarygodnego `interrupted:true` w probce - brak wyniku tool_result dla tool_use = komenda nie ukonczona (status nieznany).

## 6. Rownolegle tool_use

Jeden `message.id` -> N rekordow assistant (po 1 bloku): 7276 wiadomosci z 1 tool_use, 331 z 2, 58 z 3, 8 z 4, 2 z 5.
Kazdy tool_result jest w OSOBNYM rekordzie user (399/399 w probce; nie scalone). Kolejnosc wynikow vs wywolan: zgodna w 357, odwrocona w 42 przypadkach (11%) -
laczyc wylacznie po `tool_use_id` == `tool_use.id`, nigdy po pozycji. Uwaga: tool_result moze miec kilka user-rekordow miedzy soba z `attachment`.
Brak tool_result dla tool_use (przerwanie/koniec logu) jest mozliwy.

## 7. Narzedzia edycji

Obserwowane (probka calej bazy, lacznie ~1k tool_use): `Write` {file_path, content} (148), `Edit` {file_path, old_string, new_string, replace_all} (51), `Read` {file_path}.
`MultiEdit` i `NotebookEdit`: 0 trafien w tych logach, ale parser powinien je znac (MultiEdit: `edits[]`; NotebookEdit: `notebook_path`). Znany zestaw edytujacych: Edit, MultiEdit, Write, NotebookEdit.
Wynik Edit/Write: `toolUseResult` = `{type:"update"|"create", filePath, originalFile, structuredPatch:[{oldStart,oldLines,newStart,newLines,lines:[" ctx","-del","+add"]}], userModified, [content]}`;
Edit dodatkowo `oldString,newString,replaceAll,contentNotInModelContext,staleRecovered`. Delta linii: liczyc linie `+`/`-` w `structuredPatch[].lines`
(Write nowego pliku: `type:"create"`, structuredPatch = [] i delta = liczba linii `content`; dla `update` patch jest). `originalFile` bywa duzy - nie trzymac.
Edycja nieudana: tool_result `is_error:true` (np. "String to replace not found") - nie liczyc jako edycji.
Edycje przez Bash: `toolUseResult.bashEditDiff` = `{files:[{filePath, hunks:[{oldStart,oldLines,newStart,newLines,lines}]}]}` (249+17 wynikow w probce)
- czyli harness sam wykrywa zmiany plikow po komendach Bash i daje hunki. Heurystyka po komendzie (sed -i, `> plik`, tee, git apply, python -c) trafia w ~1087 Bash,
ale bashEditDiff jest wiarygodniejszy; nie zawsze obecny (ktorys Bash z `git commit` ma `gitOperation` zamiast tego). Zmiany pozaprogramowe (edytor uzytkownika)
widac tylko przez `attachment` typu edited_file / `file-history-snapshot|delta` (backupy, bez tresci diffow).
`userModified:true` = uzytkownik zmienil proponowana edycje przed zapisem.
Rozmiar: wyniki Write/Edit z `originalFile`/`content` powieksaja linie do setek KB.

## 8. Komendy "check"

W probce dominuja projekty Python/Java/shell uzytkownika (nie JS): trafienia na Bash (7.2k): pytest/py-moduly ~183, ruff/mypy/flake8 ~47, tsc/vitest/jest/eslint ~93,
`./scripts/check.sh` 280, `./mvnw` 212, `uv run` 259, make ~42, node --test 15, `pnpm|npm run test|lint|build|typecheck` 8. go/cargo: 0 trafien (wzorce ponizej z wiedzy ogolnej, bez weryfikacji logow).
Wzorce detekcji (po rozbiciu zlozonej komendy na `&&`, `;`, `||`, `|`; pomin prefiksy `cd x &&`, `VAR=v`, `time`, `timeout N`, `env`, `sudo`, `uv run`, `npx`, `pnpm exec`, `-C dir`):
- JS: `(pnpm|npm|yarn|bun)( run)? (test|lint|typecheck|check|build|tsc)`, `tsc`, `vitest`, `jest`, `eslint`, `biome (check|lint)`, `node --test`
- Python: `pytest`, `python -m (pytest|unittest|mypy)`, `ruff (check|format --check)`, `mypy`, `flake8`
- Go/Rust: `go (test|vet|build)`, `golangci-lint`, `cargo (test|check|clippy|build)`
- Java/Make: `./mvnw|mvn (test|verify|package)`, `gradle(w) (test|check|build)`, `make (test|check|lint|build)`
- Skrypty repo (check.sh itd.): wykrywac z package.json `scripts` (nazwy test/lint/typecheck/check/build), Makefile targets, `scripts/*.sh` o nazwach check|test|lint|ci, pyproject (tool.pytest/ruff), go.mod/Cargo.toml.
  Plik skryptow czytac z repo w momencie parsowania (HEAD) albo z `Read`-ow w logu; dopasowanie komendy z logu do skryptu: pierwszy token po normalizacji `pnpm run X` == `pnpm X`.
Pulapki: komendy wypisujace (`echo`, `grep "pytest"`) nie sa checkiem - dopasowywac tylko na poczatku segmentu; checki z pipe (`pytest | tail`) maskuja exit (bez pipefail exit = tail);
`pytest ... || true` / `; echo done` falszywe sukcesy; `-k`/pojedynczy plik = check czesciowy (do decyzji w PRD); `git commit` odpala hooki - nie liczyc.

## 9. Timestampy, rozmiary, dlugosc linii

`timestamp`: zawsze ISO-8601 UTC z ms `YYYY-MM-DDTHH:MM:SS.mmmZ` (39.9k/39.9k) na rekordach wiadomosci i wiekszosci metadanych; brak w: ai-title, mode, last-prompt, atis-latch,
bridge-session, permission-mode, agent-setting (trzeba dziedziczyc z poprzedniego rekordu z timestamp). Nierosnace timestampy: ~7% (patrz 3).
Pliki: mediana 0.68 MB, p90 2 MB, 1 plik 84 MB (7.3 MB i 13.6 MB tez); najdluzsza linia ~257 KB. Wniosek: czytac strumieniowo linia po linii, nie wczytywac calego pliku;
szybki prefiltr po podlancuchu (`"type":"user"`, `"name":"Bash"`) zanim JSON.parse. Rekordy `api-request*`, `file-history-*`, `attachment` to znaczna masa - pomijac wczesnie.
Kodowanie UTF-8, kazda linia jedno JSON; ostatnia linia pliku moze byc ucieta przy aktywnej sesji (try/catch).

## 10. Nieznane/rzadkie typy do tolerowania

Typy, ktore mozna spotkac i trzeba ignorowac bez bledu: queue-operation (operation: enqueue|dequeue|remove, `content` = tresc kolejkowanego promptu - nie liczyc jako prompt),
mode, last-prompt (`lastPrompt`, `leafUuid`), atis-latch, bridge-session, ai-title, api-request / api-request-blob / api-request-shape, cost-state (totalLinesAdded/Removed - zagregowane, nie per prompt),
permission-mode, agent-setting, continued-in, file-history-snapshot/delta, attachment (nowe `attachment.type` pojawiaja sie), system (nowe subtype: informational, bridge_status, away_summary, scheduled_task_fire...).
Bloki content: text, thinking, tool_use, tool_result, image, `tool_addition`, `DeferredToolPlaceholder`; `tool_result.content` moze byc str lub list[{type:text|image}].
Nazwy narzedzi: wiele MCP (`mcp__*`), Artifact, Skill, Monitor, ToolSearch, CronCreate/Delete/List, PushNotification, ReportFindings, ScheduleWakeup... - nieznane = ignorowac.
Pola dochodza i znikaja miedzy wersjami (`session_id` obok `sessionId`, `requestRef`, `wireToolInputs`) - czytac defensywnie, nigdy nie zakladac obecnosci.

## Rekomendacje dla parsera

1. Strumieniowo czytaj linie; prefiltr po podlancuchu; `try/catch` na JSON (ucieta ostatnia linia); nieznane `type`/pola ignoruj.
2. Buduj wlasny porzadek: kolejnosc w pliku + parentUuid; NIE ufaj sortowaniu timestampow (7% nierosnacych); timestampy dziedzicz dla rekordow bez nich.
3. Dedupuj po `uuid` w obrebie projektu (resume/fork kopiuje historie miedzy plikami; ~2k wspolnych uuid).
4. Prawdziwy prompt = user, !isMeta, !isSidechain, !isCompactSummary, bez tool_result, bez znacznikow (`<command-name>`, `<local-command`, `<task-notification`, `<system-reminder`, `[Request interrupted`), origin.kind nie task-notification/peer/coordinator/auto-continuation/cron.
5. Granica tury = prompt id (`promptId`) / kolejny prawdziwy prompt; slash-commandy (np. /clear) i compact_boundary traktuj jako granice sesji/kontekstu, nie jako prompt.
6. Paruj tool_use->tool_result wylacznie po `tool_use_id`; wyniki rownoleglych wywolan przychodza w osobnych rekordach i w innej kolejnosci (11%).
7. Exit code: `is_error` + `^Exit code (\d+)` => failing; sukces = brak `is_error`. `is_error` bez "Exit code" (Blocked/Permission/InputValidation/denied) = komenda nie wykonana, ignoruj jako check.
8. Uwazaj na `returnCodeInterpretation` (grep/diff exit 1 nie jest bledem) oraz na pipe/`|| true`; zapisuj tez `toolUseResult` typu string vs obiekt.
9. Bash w tle (`backgroundTaskId`) -> status pending do `<task-notification>`; brak tool_result -> check przerwany/nieukonczony (nie checked).
10. Edycje: Edit/MultiEdit/Write/NotebookEdit po `input.file_path` (NotebookEdit `notebook_path`); sukces tylko bez `is_error`; delta linii z `toolUseResult.structuredPatch` (+/-), dla create z `content`.
11. Edycje przez Bash bierz z `toolUseResult.bashEditDiff.files[].hunks`; heurystyke komendy (sed -i, redirect, tee, git apply) tylko jako fallback; `git checkout/restore/stash` moze cofnac edycje - rozwaz jako reset.
12. Check = segment komendy dopasowany na poczatku do wzorcow (sekcja 8) po zdjeciu prefiksow `cd &&`, env, `uv run`, `npx`; mapuj na skrypty repo (package.json scripts, Makefile, scripts/*.sh); wersjonuj liste wzorcow konfiguracyjnie.
13. Status: "ostatni check po ostatniej edycji" w kolejnosci strumienia tury; edycje subagentow (pliki `subagents/agent-*.jsonl` laczone po meta.toolUseId) licz do tury rodzica, inaczej pomijaj z flaga niepewnosci.
14. Rozdziel rekordy sidechain przez `isSidechain`/`agentId`, a pliki w `<session>/subagents/` wczytuj osobno; `tool-results/*.txt` czytaj tylko gdy potrzebny pelny output (exit code jest w pierwszej linii tekstu).
15. Nie loguj/wyswietlaj tresci promptow, `originalFile`, `content` - trzymaj tylko skrocone pola (uuid, ts, tool, file_path, exit, delta).
