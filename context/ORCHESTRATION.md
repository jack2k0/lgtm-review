# ORCHESTRATION state

## Faza łańcucha
Etap A zakończony. MVP KOMPLETNE + v0.2 S-05 (review-hints + --summary) S-10-lite (live-refresh, FR-011) S-06 (html-export z redakcją, FR-008) i S-11 (status-accuracy, audyt realnych logów: status 97.1% bez subagentów) zmergowane (+ S-12 subagent-prompts): F-01, S-01, S-02, S-03 zmergowane lokalnie na main i zarchiwizowane (2026-10-23). Nic nie wypchnięte. Czeka na właściciela: push/remote, nazwa/trademark, kredyt autora pomysłu, publikacja npm; PRD v2 dodaje FR-009/010 (zrobione w S-05). Zaparkowane (S-13 dedup fork/resume, S-14 background tasks to następne kandydaty z audytu): S-04 import map, S-07 Play the change, S-08 LLM, S-09 Python, S-10 demo page (wymagają decyzji produktowych/rozszerzenia PRD). Procedura: plan Opus -> plan-review agy -> impl Sonnet -> weryfikacja Opus.

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

## Bramki
brak

## Log workerów
- F-01 p1-2: Sonnet subagent, medium, 0 poprawek, OK. F-01 p3-4: Sonnet subagent, medium, 0 poprawek (2 odstępstwa uzasadnione: npx --package, negatyw 3.2 odwrócony).
- Właściciel zdelegował wszystkie bramki do Opusa (2026-10-23): plan ok / merge ok daje orkiestrator. Push i publikacja nadal NIE (brak zgody). Skille /10x-* nie są zainstalowane - proces ręczny wg plików. Grok oszczędzać; agy/Sonnet do woli.

- S-01: spike+plan Opus; plan-review agy Flash high (agy headless: bez narzędzi, prompt inline); impl Sonnet high (p1-2) + medium (p3-4), 0 poprawek. Prawdziwe logi NIE do agy/zewnętrznych modeli (klasyfikator zablokował) - tylko lokalne subagenty Claude.
- S-02: plan Opus, plan-review agy, impl Sonnet high/medium (p1-4 + hardening), security review Opus (agy zablokowany filtrem Gemini). Weekly limit trafiony raz, worker wznowiony SendMessage.
- OpenCode (pane w1:pJ) działa przez `herdr agent prompt w1:pJ "..." --wait` (użyty do plan-review live-refresh; wynik do pliku w scratchpadzie). agy headless: tylko prompt inline.
- POLECENIE WŁAŚCICIELA (2026-10-23): priorytet Agy (pane w1:p3, ustawiony model Claude Sonnet 4.6 Thinking; ~99% tygodnia na Claude/GPT, ~16% Gemini). Deleguj implementacje i review do Agy przez `herdr agent prompt w1:p3 "..." --wait`; Claude Code = architekt/weryfikacja; Grok tylko krytyczne.

## Notatki
- Repo lokalne, bez remote. Nie pushować. Branch startowy `master`, docelowy `main` (do zmiany przy commicie fundamentu).
- Env: node 22 + pnpm przez PATH=/tmp/claude-1000/shim:$HOME/.local/opt/node22/bin. git user nie ustawiony: commity z GIT_AUTHOR_*/GIT_COMMITTER_* (jack / bogatyszejksponsor2@gmail.com). Narzędzia quoty niesprawdzone.

## Otwarte problemy
brak
