# ORCHESTRATION state

## Kolejka właściciela
Każda pozycja: akcja → dowód → ile minut.
- Push lokalnych commitów → bloki bramki w opisach merge od ostatniego pushu (`git log origin/main..main --merges`), High czytać przed pushem → ~5 min na merge High.
- S-08 LLM: decyzje O-1..O-3 → `context/foundation/prd.md` → ~15 min.
- Przegląd UI w przeglądarce (S-17/S-19/S-21) → `npx lgtm-review` w repo → ~15 min.
- Audyt celu ≥97% na prawdziwych logach → skrypty audytu (scratchpad, agregaty) → ~30 min.
- Nazwa/znak towarowy, publikacja npm → ~?

## Proces przeglądu (od 2026-10-26, na wzór Anthropic; „chcę mieć system pod review Anthropica”)
Reguły: `AGENTS.md` (wszyscy agenci), `REVIEW.md` (tiery, uwagi, rejestr, maks. 2 rundy, fix at the source), briefy `docs/prompts/03-review.md`, bramka `node scripts/gate.mjs ... --merge`. Domyślne odpowiedzi Opusa na otwarte pytania (do korekty przez właściciela):
- High: Opus merguje lokalnie; akceptacją właściciela jest push po przeczytaniu bloków bramki merge'ów High.
- Lista High = `TIERS` w `scripts/gate.mjs` (+ pliki reguł AGENTS/REVIEW/CLAUDE.md, gate.mjs, build-demo.mjs).
- Pliki publiczne: tylko reguły procesu; notatki o modelach, limitach i panelach zostają w prywatnej pamięci.
- Język: pliki dla agentów po angielsku, ORCHESTRATION po polsku.
- Zapasowy recenzent: Haiku (Medium), subagent Sonnet za jednego z dwóch (High), gdy Agy/OpenCode bez limitu.
- Przeglądy cykliczne (sweep): tylko na prośbę właściciela, nie bez nadzoru. Dist-tag `next` przy publikacji npm: decyzja przy publikacji.
- Pilot: następne 2 zmiany; metryki na merge (tier, liczba uwag, werdykty, rundy) w rejestrze `reviews/findings.md`.

## Faza łańcucha
Etap A zakończony. MVP KOMPLETNE + v0.2 S-05 (review-hints + --summary) S-10-lite (live-refresh, FR-011) S-06 (html-export z redakcją, FR-008) i S-11 (status-accuracy, audyt realnych logów: status 97.1% bez subagentów) zmergowane (+ S-12 subagent-prompts, + S-13 fork-dedupe 2026-10-23): F-01, S-01, S-02, S-03 zmergowane lokalnie na main i zarchiwizowane (2026-10-23). Czeka na właściciela: nazwa/trademark, kredyt autora pomysłu, publikacja npm; PRD v2 dodaje FR-009/010 (zrobione w S-05). + S-14 bg-checks (zmergowane, audyt realnych logów zrobiony) + S-09 python-map (2026-10-23). Brak kolejnych slice'ów bez decyzji produktowych. Zaparkowane: S-04 import map, S-07 Play the change, S-08 LLM, S-10 demo page (wymagają decyzji produktowych/rozszerzenia PRD). Procedura: plan Opus -> plan-review agy -> impl Sonnet -> weryfikacja Opus.

## Decyzje właściciela (2026-10-23)
- Nazwa projektu/pakietu npm: `lgtm-review` (wolne na npm 2026-10-23; GitHub/znak towarowy do sprawdzenia przed publikacją). Hasło robocze: "Earn your LGTM."
- Licencja: Apache-2.0
- Python w MVP: nie (v0.2, slice S-09)
- Czas: ~5 h/tydz, after-hours: tak
- Model warstwy LLM: decyzja w planie S-08
- MVP = S-01..S-03 (scope down), mvp_weeks 7. Priorytet właściciela: przeglądarka jak najszybciej (S-01 cienki parser -> S-02 web od razu).
- Pozostałe decyzje shape (non-goals, ramy: cli, users large, after-hours) oddelegowane do orkiestratora - założenia, do korekty.

## Decyzje stack (2026-10-23, Opus na delegację właściciela)
- Turborepo, packages core/cli/web; publikowany tylko cli (`lgtm-review`), core+web private i bundlowane.
- Dev PM: pnpm. Hand-off `package_manager: npm` (zgodnie ze schematem); konwersja na pnpm workspaces = pierwszy krok F-01. W AGENTS.md/briefach: "pnpm, nie npm".
- deployment self-host, CI GitHub Actions (Node 22+24), flow manual-promotion; has_* = false.
- Uwagi do F-01: create-turbo stawia przykład Next.js, wymienić na core/cli/web; fixture'y w packages/core albo w turbo inputs; LICENSE+README w packages/cli; smoke test `pnpm pack` + npx w `pnpm check`; schemat Story eksportowany bez importów node:.

## Aktywne slice'y / worktree
brak
- v0.3 (2026-10-25): roadmapa i PRD v3 przygotowane przez Opusa (max); S-16..S-21 zaimplementowane przez Haiku/Sonnet/OpenCode (DeepSeek)/Agy (Gemini), zweryfikowane i zmergowane przez Opusa, zarchiwizowane. zod 3 -> 4.6.6 (audit). Czeka na właściciela: S-08 (O-1..O-3 w PRD), widok w przeglądarce S-17/S-19/S-21, ponowny audyt ground truth (>= 97% niezmierzone), push.
- S-09 walidacja na wdAir (subagent Sonnet, read-only): ekstraktor+resolver vs Python ast 2908/2908 krawędzi, 0 FP/0 FN; luka: zagnieżdżone projekty (vendor/letsfg) -> fix py-roots (OpenCode pQ, 6528775, zmergowany, zweryfikowany: 21/21 importów letsfg rozwiązanych).

- Runda przeglądów v0.3 (2026-10-26, bez decyzji właściciela): read-only review S-17/S-21/S-20 (Agy, Gemini 3.8 Flash) i S-18/S-19 (OpenCode, DeepSeek V4.1 Flash), poprawki w osobnych worktree, zweryfikowane przez Opusa (diff + pnpm check), zmergowane lokalnie, NIE wypchnięte. S-21: `git log -z` (ścieżki z tab/cudzysłowem), symlinkowany katalog sesji. S-19: etykieta worktree w kluczach cache API. S-20: `/private/tmp` (macOS) w regule scratch, CRLF po `\` w stringach Pythona. S-18: 8 poprawek check-scope (opcje vitest/jest z wartością, `cd` w subshellu, reguła stem/katalogu tylko w obrębie pakietu, `packages/e2e`, `pnpm -r`, filtry glob, `npm test --prefix`, `make -Cdir`) + poprawka Opusa: OpenCode zmienił oczekiwanie testu `{packages/web}` zamiast zachować obsługę. S-17: Esc i link "All sessions" wracają do listy z filtrami; nieznane query sesji nie zrzucają na listę. Nowe: `turbo`/`nx` rozpoznawane jako checki (z zakresem `--filter`), fixture `turbo-checks`. Znane ograniczenia (świadomie bez zmian): worktree pod /tmp edytowany z sesji głównej liczony jako scratch; zagnieżdżone f-stringi PEP 701 w mapie Pythona.

- Runda przeglądów v0.2 (2026-10-26): S-06 eksport/redakcja (review OpenCode z reprodukcjami na zbudowanym CLI: 2 wycieki w `--summary`, 9 luk wzorców), S-15 archiwum (Agy: utrata danych przy obciętym pliku źródłowym, symlinki, id `..`, katalog archiwum w repo, temp 0600, live vs archived między rootami), S-16 (Agy: nazwy doc bez rozszerzenia tylko wielkimi literami, CONTRIBUTING/SECURITY/...; `.md` pod src odrzucone, decyzja PRD). Poprawki: summary/export-html Agy; redact.ts zaczęty przez OpenCode (limit darmowy do 27.10 00:45), dokończony przez Opusa (dekodowanie escape'ów JSON tylko na kopii, gdy ujawnia sekret; samodzielny Bearer zachowuje wymóg cyfry; zmiana oczekiwania: `secret: <uuid>` redagowane); archiwum subagent Sonnet (0 poprawek); ucinanie tekstu na granicy słowa + wartości opcji `--password` itp. nigdy nie są zakresem (Agy; zmieniony golden: tytuł subagent-async). Wszystkie reprodukcje z przeglądu S-06 sprawdzone na main: brak wycieków. Uwaga: `--archive` odmawia, gdy katalog archiwum leży w `--dir` (np. uruchomienie w `~`). Nie wypchnięte.

- Runda przeglądów S-12/S-13/S-14 + mapa (2026-10-26, przeglądy Agy, poprawki Agy/Sonnet, weryfikacja Opus). S-14: kod wyjścia z OSTATNIEGO 'exit code N' w podsumowaniu powiadomienia; nieznane statusy (np. running) to postęp, zatrzymują tylko killed/stopped/cancelled/timeout/aborted (zmienione oczekiwanie). S-12: zdarzenia subagenta nigdy przed jego wywołaniem Agent, remisy wg kolejności wywołań; check w worktree agenta (`.claude/worktrees/<id>`) nie pokrywa edycji w głównym checkoucie (test reprodukcji pada na starym kodzie). Odrzucone/odłożone: 4.2 (zaufanie pustemu bashEditDiff) wycofane przez Opusa — łamało prawdziwy przypadek S-20 i Agy zmienił etykiety ground truth; 1.1 (agent kontynuowany przez SendMessage liczony w pierwszym prompcie) — OTWARTE, wymaga sprawdzenia formatu na prawdziwych logach. S-13: na prawdziwych logach wszystkie kopie forka remisują na startedAt (75/75), więc właściciela wybierało losowe id; teraz wygrywa sesja, której zbiór promptów jest podzbiorem (oryginał), jedna reguła 'inherited from' (core `inheritedSource`) w API/CLI/web, limit diffów eksportu bez odziedziczonych, `line-N` ignorowane. Mapa: timeout `git ls-files`, rozszerzenia NodeNext (.js->.tsx, .mjs->.mts), `baseUrl`, importy pakietów workspace (np. @lgtm/core), manifesty w ETag, nazwy w Play przy kolizji basename, 404 mapy dla odziedziczonych promptów. Nie wypchnięte.

- 2026-10-26 (cd.): ZAMKNIĘTE otwarte S-12 1.1 — format na prawdziwych logach (agregaty): 19 wywołań SendMessage do subagentów, wszystkie w PÓŹNIEJSZYM prompcie niż wywołanie Agent, kontynuacja dopisywana do tego samego agent-<id>.jsonl (15/19 z narzędziami), wynik ma resumedAgentId/revivedAgentId. Poprawka (Sonnet): transkrypt dzielony na przebiegi wg znacznika czasu SendMessage, przebieg doliczany do promptu z SendMessage. Real-log PRE/POST (154 własne prompty): 7 zmian (2 checked->unchecked, 1 unchecked->no-changes, 4 tylko lista plików). Niezrobione: SendMessage zagnieżdżony w subagencie. S-11 review (Agy): przyjęte F1.1 (FAIL/--- FAIL:/Killed w maskowanym wyjściu), F1.2 (komendy listujące nie są checkami), F2.1 (pnpm/yarn/bun <bin>), F2.2 (deno, just), F2.3 (python -m linters) — impl Sonnet (OpenCode zablokowany limitem); real logs: bez zmian statusów. Odrzucone: F3.1 (real logs: 169/169 błędów Bash zaczyna się od 'Exit code N', reszta to zablokowane/odmowa — ignorowanie poprawne), F1.3, F3.2. Flaky: perf test '20 MB session analysed fast' pod obciążeniem (load ~6). Agy: prompt przeglądu z 'attack/injection' blokowany filtrem Gemini — formułować neutralnie.

- 2026-10-26 (cd. 2): przegląd serwera S-02/S-10 (Agy, prompt neutralny): brak uwag (loopback, token 256 bit we fragmencie + timingSafeEqual, Host/Origin, statyczne pliki z realpath, limity, ogólne błędy, CSP). S-05 hinty (Agy): przyjęte 1.1-1.6 (komentarze/stringi, asercje netto w prompcie, .env.example, migration/, .snap, lockfile'i), impl Agy, zweryfikowane. Odłożone: S-03 kroki/diffy 2.1 (rm bez bashEditDiff), 2.2 (mv/git mv), 3.1-3.3 (drobne liczniki w tytułach/eksporcie). Wszystkie slice'y przejrzane przynajmniej raz.

- 2026-10-26 (cd. 3): S-03 (Agy): git mv/git rm w heurystyce jako D+A/D, tytuły kroków z oboma licznikami; zwykłe rm/mv celowo pominięte (real logs: 161 rm bez bashEditDiff, głównie sprzątanie). SendMessage zagnieżdżony w subagencie: 0 przypadków na real logs — odłożone. Proces na wzór Anthropic ('Solving code review at Anthropic', analiza Opus xhigh: scratchpad anthropic-process-analysis.md): zrobiony krok 1 z 3 — `scripts/gate.mjs` (bramka przed merge: zakres z bloku ```gate w plan.md, zakaz zmian istniejących *.labels.json, goldeny, usunięte oczekiwania testów, zależności, schema, opcjonalnie pnpm check, tier Low/Medium/High). Od teraz: uruchamiać `node scripts/gate.mjs --base main` przed każdym merge i wklejać blok do opisu merge. AGENTS.md/REVIEW.md i przegląd przed merge wg tieru CZEKAJĄ na decyzje właściciela (publiczność plików, akceptacja High, język, Sonnet jako zapasowy recenzent, lista High).

- 2026-10-26 (cd. 4): testy czasowe (20 MB core, 20 MB e2e HTTP, długie komendy shell) przeniesione bez zmian progów do *.perf.test.ts (sekwencyjnie) — koniec flaky pod obciążeniem; eksport: nagłówek diffu ma liczniki pliku + '(diff truncated)' (S-03 3.2/3.3). Pierwszy merge przez bramkę: NEEDS-EYES, pozycje uzasadnione. Kickoff prompt: bramka w B3 i w briefie workera.

## Bramki
- Npm publish: czeka na decyzję właściciela.

## Log workerów
- F-01 p1-2: Sonnet subagent, medium, 0 poprawek, OK. F-01 p3-4: Sonnet subagent, medium, 0 poprawek (2 odstępstwa uzasadnione: npx --package, negatyw 3.2 odwrócony).
- Właściciel zdelegował wszystkie bramki do Opusa (2026-10-23): plan ok / merge ok daje orkiestrator. Push i publikacja nadal NIE (brak zgody). Skille /10x-* nie są zainstalowane - proces ręczny wg plików. Grok oszczędzać; agy/Sonnet do woli.

- S-01: spike+plan Opus; plan-review agy Flash high (agy headless: bez narzędzi, prompt inline); impl Sonnet high (p1-2) + medium (p3-4), 0 poprawek. Prawdziwe logi NIE do agy/zewnętrznych modeli (klasyfikator zablokował) - tylko lokalne subagenty Claude.
- S-02: plan Opus, plan-review agy, impl Sonnet high/medium (p1-4 + hardening), security review Opus (agy zablokowany filtrem Gemini). Weekly limit trafiony raz, worker wznowiony SendMessage.
- OpenCode (pane w1:pJ) działa przez `herdr agent prompt w1:pJ "..." --wait` (użyty do plan-review live-refresh; wynik do pliku w scratchpadzie). agy headless: tylko prompt inline.
- POLECENIE WŁAŚCICIELA (2026-10-23): priorytet Agy (pane w1:p3, ustawiony model Claude Sonnet 4.6 Thinking; ~99% tygodnia na Claude/GPT, ~16% Gemini). Deleguj implementacje i review do Agy przez `herdr agent prompt w1:p3 "..." --wait`; Claude Code = architekt/weryfikacja; Grok tylko krytyczne.
- STOP na polecenie właściciela (2026-10-23): praca wstrzymana po fazie 1 slice'a S-13 (fork-dedupe). Gałąź `change/fork-dedupe` (worktree `../lgtm-review-fork-dedupe`, commit 7cd3010, zweryfikowane: pnpm check 10/10, audit czysty) zawiera fazę 1 (core `markInherited`, schemat); NIE zmergowana na main. Do zrobienia: faza 2A (API/CLI/export/summary/ETag/smoke) i 2B (web) wg `context/changes/fork-dedupe/plan.md` + amendments I1-I8, potem merge i archiwizacja. Implementacje przez Agy (pane w1:p3, Claude Sonnet 4.6; `herdr agent prompt ... --wait` zwraca się za wcześnie gdy Agy uruchamia własnego subagenta - czekać na commit w worktree).
- S-13 wznowione i ukończone (2026-10-23): Agy bez limitu Sonnet (nic nie zrobił) -> 2A Sonnet subagent medium (0 poprawek; fixture'y z tymi samymi uuid uniknione prefiksem w e2e/smoke). 2B: OpenCode/Nemotron 2x niekompletne -> dokończone Haiku (brak testu kliknięcia - web nie ma DOM env). Flaky: core redact perf test pod obciążeniem. Zasady modeli: memory delegation-models (Haiku do mechanicznych, OpenCode -> mimo-v2.6-flash-free).

- S-09 python-map (2026-10-23): plan Opus, plan-review Agy (5 major/5 minor -> A1-A7), faza 1 core + faza 2 cli/web: Agy (Gemini 3.8 Flash medium), 0 poprawek; faza 3 docs Opus (README Import map, PRD FR-013, roadmap). pnpm check zielone na main (35a559b + docs). Znane drobne ograniczenie: `# """` w komentarzu może przesłonić importy (regex, zgodnie z non-goals).
- chore perf-split (2026-10-23, OpenCode pQ Big Pickle, 0 poprawek): perf testy osobno, sekwencyjnie w `pnpm check`.

- S-07 play-the-change ZMERGOWANE (e0592cd + docs): plan Opus, plan-review Agy (B1-B9), fazy 1-3 Agy (0 poprawek), poprawki Opus: deterministyczne sortowanie, brak beatów dla plików spoza --dir, komunikat o obcięciu. Zweryfikowane na wdAir (play ~0.55 s; mapa na zimno 1.7 s przez detailFor 84 MB logu). UI nie oglądane w przeglądarce.

- S-10 demo ZMERGOWANE (678814d): OpenCode pP Big Pickle, 0 poprawek; `pnpm demo` deterministyczne, prywatność sprawdzona (Opus). Hosting (Pages) czeka na właściciela.

- map-304 (OpenCode pQ, 0 poprawek): 304 mapy/play bez analizy szczegółowej. ZMERGOWANE.
- S-15 session-archive ZMERGOWANE (5d218f2): plan Opus, plan-review Agy (1 blocker meta.json + 6 -> C1-C7), fazy 1-2 Agy (0 poprawek), Opus: exit code 1. Test na prawdziwych logach (43 MB, archiwum w scratchpadzie, usunięte): 84 pliki, drugi przebieg 0 kopii, lista z samego archiwum identyczna z live.

## Notatki
- Repo ma remote `origin` (github.com/jack2k0/lgtm-review). Push main 426a7f4 za zgodą właściciela (2026-10-23); kolejne pushe tylko na polecenie.
- Push main e93427d za zgodą właściciela (2026-10-26); CI zielone (run 40285484561). Push e93427d..c54447b (56 commitów) za zgodą Jacka (2026-10-26, wykonał Shepherd); CI zielone (run 40343934760).
- Env (2026-10-26): domyślny node to 20; `pnpm check` wymaga PATH=<scratchpad>/bin:$HOME/.local/opt/node22/bin, gdzie `bin/pnpm` to wrapper `exec corepack pnpm "$@"` (turbo szuka binarki pnpm w PATH). Env (2026-10-25): shim /tmp/claude-1000/shim zniknął; pnpm przez corepack. Wcześniej: node 22 + pnpm przez PATH=/tmp/claude-1000/shim:$HOME/.local/opt/node22/bin. git user nie ustawiony: commity z GIT_AUTHOR_*/GIT_COMMITTER_* (jack / bogatyszejksponsor2@gmail.com). Narzędzia quoty niesprawdzone.

## Otwarte problemy
brak (S-04 import-map zmergowane i zarchiwizowane 2026-10-23; audyt realnych logów S-14 zrobiony)
