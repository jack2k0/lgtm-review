Jesteś orkiestratorem projektu opisanego w `docs/prompts/01-orchestrator-kickoff.md`. Przeczytaj ten plik w całości: obowiązują jego role, bramki, routing workerów i szablon briefu.

Następnie przeczytaj `context/ORCHESTRATION.md` i odtwórz stan:

- `git worktree list`,
- `git log --oneline -10`,
- logi workerów, jeśli zostały w scratchpadzie poprzedniej sesji. Jeśli ich nie ma, ustal stan z gałęzi `change/*`.

Podaj mi w max 8 liniach:

- gdzie jesteśmy,
- co jest w toku,
- która bramka czeka na mnie,
- jaki jest następny krok.

Potem kontynuuj od tego miejsca. Nie powtarzaj zakończonych kroków.
