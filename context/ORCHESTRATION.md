# ORCHESTRATION state

## Faza łańcucha
Etap A (fundament), kroki 2-4 zakończone (shape-notes.md, prd.md, tech-stack.md). Następnie: krok 5 `/10x-bootstrapper`

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
brak

## Notatki
- Repo lokalne, bez remote. Nie pushować. Branch startowy `master`, docelowy `main` (do zmiany przy commicie fundamentu).
- Narzędzia quoty (usage/agy-usage/grok-usage): niesprawdzone.

## Otwarte problemy
brak
