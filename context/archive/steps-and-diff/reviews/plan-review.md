# Plan review (agy gemini-3.8-flash-high, 2026-10-23)

Ocena planu implementacji **S-03 (Steps and diff)**:

### 1. WARNING — Spójność kroków z timing classifierem i szablonami tytułów
- **Lokalizacja:** `Critical Implementation Details -> Step grouping` oraz `packages/core/src/steps.ts`.
- **Szczegół:** Przenoszenie niesklasyfikowanych narzędzi (np. `Agent`, `MCP`) do fazy poprzedniego kroku oraz mechaniczne łączenie akcji w fazie `Fix` („consecutive actions of the same phase = one step”) tworzy ryzyko niespójności z `timing.ts`. Suma `durationMs` poszczególnych kroków może rozjechać się z czasem faz w `PromptSummary.timing`. Ponadto w fazie `Fix` kolejne odczyty i edycje zwiną się w jeden krok o mylącym tytule szablonowym (np. „Edit src/a.ts (+2 -1)”, gubiąc fakt wykonania odczytów).
- **Poprawka:** Zsynchronizować reguły faz w `timing.ts` i `steps.ts` (wspólny enum/funkcja kategoryzująca), rozbić `Fix` na pod-kroki (`Fix:Read`, `Fix:Write`) lub zdefiniować hybrydowy szablon tytułu dla kroków łączonych; dodać test asercji spójności sumy czasów kroków z czasem prompta.

---

### 2. WARNING — Zużycie pamięci przez cache sesji w trybie detail
- **Lokalizacja:** `Desired End State` oraz `Phase 3: Server detail API`.
- **Szczegół:** Cache LRU(3) przechowuje kompletne dane detail dla całych sesji. W przypadku sesji z 40–50 promptami, z których każdy modyfikuje po kilka plików, trzymanie w pamięci RAM wszystkich wygenerowanych struktur `Hunk` (do 2000 linii/plik) może wygenerować narzut rzędu 100–300 MB w procesie CLI, co grozi OOM na maszynach o ograniczonych zasobach.
- **Poprawka:** Generować i cachować diffy leniwie (na poziomie pojedynczego zapytania `diffFor(promptIndex, path)`), a w pamięci sesji trzymać wyłącznie odchudzoną strukturę kroków i metadane diffów, lub nałożyć limit rozmiaru bajtowego na wpis w LRU.

---

### 3. WARNING — Bezpieczeństwo i błędy dekodowania parametru `path`
- **Lokalizacja:** `Critical Implementation Details -> Path param safety` oraz `packages/cli/src/api.ts`.
- **Szczegół:** Założenie „path decoded once” jest niewystarczające: nieprawidłowo sformatowane sekwencje procentowe (np. `%E0%A4A`) powodują nieschwytany wyjątek `URIError` w standardowych parserach Node/Express, skutkując błędem 500 zamiast 400. Ponadto brak normalizacji separatorów ścieżek (Windows `\` vs POSIX `/`) doprowadzi do fałszywych 404 przy exact-matchu.
- **Poprawka:** Dodać bezpieczne dekodowanie query w bloku `try/catch` zwracające 400 Bad Request przy błędzie dekodowania; normalizować separatory do POSIX (`/`) przed porównaniem ze zbiorem `files`.

---

### 4. WARNING — Brak metadanych prompta w `PromptDetail` a deep linking
- **Lokalizacja:** `Desired End State -> GET .../prompts/:index` oraz `Phase 4: Web Steps view`.
- **Szczegół:** Kontrakt zwraca wyłącznie `{index, steps: Step[]}`. Bezpośrednie otwarcie URL `#/session/<id>/prompt/<index>` (odświeżenie strony, link od innego użytkownika) uniemożliwi wyrenderowanie nagłówka widoku (tekst prompta, ogólny status prompta, czas, timestamp), ponieważ stan z `SessionList`/`PromptTable` nie będzie dostępny.
- **Poprawka:** Rozszerzyć kontrakt `PromptDetail` o podstawowy kontekst prompta (`text`/excerpt, `status`, `durationMs`, `startedAt`) lub jawnie zapisać w Phase 4 wymóg równoległego pobierania `GET /api/sessions/:id` w kliencie webowym w przypadku braku danych w cache.

---

### 5. WARNING — Heurystyka parsowania wyniku Check
- **Lokalizacja:** `Critical Implementation Details -> Check result`.
- **Szczegół:** Pobieranie kodu wyjścia wyłącznie z tekstu regexem `Exit code N` i warunek `passed when no is_error` jest podatne na błędy: polecenie może w stdout/stderr wypisać ciąg `Exit code 0` (np. grep, log buildera, traceback), mimo że narzędzie zwróciło błąd wykonania (`is_error: true`).
- **Poprawka:** Odczytywać kod wyjścia i status w pierwszej kolejności z pól strukturalnych metadanych wyniku narzędzia (o ile obecne w logu); regex tekstowy traktować jako fallback. Dodać test dla przypadku kolizji tekstu `Exit code 0` z `is_error: true`.

---

### 6. OBSERVATION — Brak flagi `truncated` w definicji schematu `PromptDetail`
- **Lokalizacja:** `Critical Implementation Details -> Detail mode retention` vs `Desired End State`.
- **Szczegół:** W opisie retencji zdefiniowano limit 200 kroków per prompt z flagą `truncated: boolean`, jednak w specyfikacji typu `PromptDetail` w `Desired End State` pole to zostało pominięte. Brak też informacji, jak UI ma sygnalizować obcięcie listy kroków.
- **Poprawka:** Dodać `truncated: boolean` do typu `PromptDetail` w `packages/core/src/schema.ts` oraz określić w Phase 4 wyświetlanie banera informacyjnego w `StepsView`.

---

### 7. OBSERVATION — Przeładowanie fazy 5 w briefie workera
- **Lokalizacja:** `Phase 5: Web diff view and end-to-end`.
- **Szczegół:** Faza 5 łączy w sobie implementację widoku diffa w React, a11y/klawiaturę, rozbudowę skryptu `smoke-pack.mjs`, aktualizację dokumentacji (`packages/cli/README.md`, root `README.md`) oraz manualne testy e2e. To zbyt szeroki kontekst jak na jedno zadanie wykonawcze.
- **Poprawka:** Wydzielić fazę 5 na dwa mniejsze kroki: (5a) Implementacja `DiffView.tsx` wraz z testami widoku, oraz (5b) Integracja e2e smoke, synchronizacja dokumentacji i końcowy walk-through.

---

### 8. OBSERVATION — Brak mierzalnego kryterium dla NFR pamięci
- **Lokalizacja:** `Success Criteria` (Phase 1–3) oraz `Testing Strategy`.
- **Szczegół:** NFR zakłada „memory bounded by the caps”, ale w zautomatyzowanych kryteriach sukcesu zdefiniowano jedynie pomiar czasu odpowiedzi (< 3 s dla 20 MB sesji), pomijając weryfikację narzutu pamięciowego.
- **Poprawka:** Dodać w Phase 3 automatyczny test regresji sprawdzający przyrost sterty (np. `process.memoryUsage().heapUsed` poniżej określonego progu, np. delta < 100 MB przy parsowaniu sesji 20 MB).

---

### 9. OBSERVATION — Niejasny kontrakt `FileDiff.kind` dla usunięć i pustych plików
- **Lokalizacja:** `Desired End State -> GET .../diff` oraz `FR-006`.
- **Szczegół:** Zdefiniowano pole `kind` w `FileDiff`, ale plan nie precyzuje dopuszczalnych wartości (np. `"create" | "modify" | "delete"`) ani struktury hunka w sytuacji, gdy narzędzie Write wyczyściło plik do 0 bajtów lub plik został usunięty.
- **Poprawka:** Zdefiniować w `schema.ts` unię `kind: "create" | "modify" | "delete"` oraz sprecyzować reprezentację diffa dla plików pustych/usuniętych (np. syntetyczny hunk all-`-` lub pusty zestaw `hunks: []` z odpowiednim `kind`).
