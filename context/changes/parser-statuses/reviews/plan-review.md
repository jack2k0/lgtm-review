# Plan review (agy gemini-3.8-flash-high, 2026-10-23)

Oto recenzja planu implementacji slice'a **S-01** w odniesieniu do wymagań PRD i założeń architektonicznych:

### 1. [BLOCKING] Niespójność interfejsu analizatora: `Iterable` (sync) vs `AsyncIterable` (Node streaming)
* **Lokalizacja:** Faza 1 (`parseLines`), Faza 2 (`analyzeSession`), Faza 3 (`readSessionLines`).
* **Szczegół:** Fazy 1 i 2 definiują analizator jako synchroniczny (`lines: Iterable<string>`). W Fazie 3 strumieniowanie z Node.js (`readline` / `fs.createReadStream`) bez ładowania całego pliku do pamięci zwraca `AsyncIterable<string>`. Odłożenie decyzji do Fazy 3 („*Async generator variant acceptable if analyzeSession accepts AsyncIterable too; then add analyzeSessionAsync*”) wymusi refaktoryzację rdzenia i testów z Faz 1–2 w Fazie 3.
* **Poprawka:** Od Fazy 1 zdefiniuj `parseLines` i `analyzeSession` jako obsługujące `AsyncIterable<string> | Iterable<string>` (lub od razu asynchroniczne). Zapewni to spójność z NFR dotyczącym strumieniowania od początku.

### 2. [BLOCKING] Konflikt deduplikacji międzyplikowej z przetwarzaniem sesji
* **Lokalizacja:** Critical Details oraz Faza 3.1 (`Cross-file dedupe by uuid within the project: process sessions oldest-first sharing one seen-set`).
* **Szczegół:** Przetwarzanie sesji od najstarszej ze wspólnym zbiorem `uuid` sprawi, że sesja wznowiona (*resume*), która kopiuje historię, utraci wcześniejsze prompty w swojej analizie, zafałszowując statystyki promtów per sesja. Dodatkowo wymusza to wczytanie wszystkich plików projektu przed zwróceniem wyników, co uniemożliwia niezależne strumieniowanie sesji (CLI ma wyświetlać sesje *newest first*).
* **Poprawka:** Ogranicz deduplikację `uuid` wyłącznie do wnętrza pojedynczej sesji (`parseLines` w Fazie 1 już to robi). Jeśli sesje wznowione mają być scalane, zdefiniuj jawną regułę merge'owania sesji w S-02 zamiast gubienia zdarzeń globalnym `seen-set`.

### 3. [WARNING] Sprzeczność z PRD: ciche pomijanie nieznanych rekordów
* **Lokalizacja:** Faza 1.2 (`Skips (silently): ... unknown type skipped without warning`) vs PRD Access Control.
* **Szczegół:** PRD wymaga: *„Unknown or malformed log records are skipped and listed as warnings, not fatal”*. Plan w Fazie 1 zakłada ciche ignorowanie nieznanych typów (`unknown type skipped without warning`), co uniemożliwi wykrycie zmian w formacie Claude Code.
* **Poprawka:** Rejestruj `Warning` dla nierozpoznanych wartości pola `type`. Ciche pomijanie zarezerwuj ściśle dla znanych, udokumentowanych w spike'u typów metadanych (`isMeta`, `isSidechain`, itp.).

### 4. [WARNING] Niejednoznaczność pierwszeństwa reguły statusu: `failing` vs `unchecked`
* **Lokalizacja:** Critical Implementation Details (Status rule per prompt).
* **Szczegół:** Zapis: *„failing also wins when a check failed and no later check passed even if edits came earlier than the failure”* jest mylący w sytuacji: *błąd checka -> edycja naprawcza -> brak kolejnego checka*. W PRD edycja po ostatnim checku to stan nieweryfikowany (`unchecked` z powodem *„N edit(s) after last check”*). Nadanie priorytetu `failing` ukryłoby fakt wprowadzenia niesprawdzonych zmian.
* **Poprawka:** Doprecyzuj wprost priorytet: jeśli po ostatnim wykonanym checku nastąpiła jakakolwiek udana edycja (`lastEditIndex > lastCheckIndex`), statusem ZAWSZE jest `unchecked`. Status `failing` przysługuje tylko wtedy, gdy ostatnią akcją weryfikacyjną w promptcie był nieudany check (`lastCheckIndex > lastEditIndex && lastCheck.exitCode !== 0`).

### 5. [WARNING] Ryzyko niestabilności testu wydajnościowego 20 MB w CI
* **Lokalizacja:** Faza 3.2 (`asserting analyze < 3000 ms ... No: keep assertion at 3000 ms, it must hold`).
* **Szczegół:** PRD określa NFR: *„< 3 s on a typical developer laptop”*. Wirtualizowane środowiska CI (np. GitHub Actions) mają zmienne I/O i narzut CPU. Sztywny próg 3000 ms bez tolerancji w `pnpm check` na maszynach CI doprowadzi do losowych błędów w pipeline.
* **Poprawka:** Wprowadź mnożnik tolerancji w środowisku CI (np. próg 6000 ms przy `process.env.CI`, z zachowaniem 3000 ms lokalnie) i loguj dokładny czas wykonania w teście.

### 6. [WARNING] Brak źródła danych dla pola `branch` (FR-001)
* **Lokalizacja:** Current State Analysis oraz Faza 1.1 (`SessionAnalysis { ... branch ... }`).
* **Szczegół:** FR-001 wymaga wyświetlania gałęzi Gita dla sesji. W sekcji analizy formatu Claude Code nie wskazano, z którego rekordu JSONL odczytywany jest `branch`, ani jak zachować się, gdy rekord ten nie występuje.
* **Poprawka:** Zdefiniuj w Fazie 1 mapowanie rekordu środowiskowego/początkowego sesji na pole `branch` oraz fallback (np. `undefined` lub `"(detached/unknown)"`).

### 7. [WARNING] Pominięcie wyliczania delt dla nadpisania pliku (`Write` bez `create`)
* **Lokalizacja:** Current State Analysis & Faza 2.2 (`File aggregation`).
* **Szczegół:** Plan przewiduje delty z `structuredPatch`, `bashEditDiff` oraz `Write` z `type: "create"`. Narzędzie `Write` może jednak nadpisać istniejący plik (brak patcha i brak poprzedniej zawartości w logu).
* **Poprawka:** Jawnie oznacz takie przypadki flagą `maybeIncomplete: true` i przyjmij zdefiniowaną konwencję (np. `added = newContent.lines`, `removed = 0`), aby uniknąć błędów parsowania.

### 8. [OBSERVATION] Zbyt wąska weryfikacja czystości rdzenia (`node-free core`)
* **Lokalizacja:** Faza 1 (Automated Verification) i Faza 3.
* **Szczegół:** Weryfikacja opiera się na `grep -rn "node:" packages/core/src/index.ts packages/core/src/schema.ts packages/core/src/parse.ts`. Faza 2 dodaje pliki `check-patterns.ts` i `analyze.ts`, które nie są objęte tą komendą.
* **Poprawka:** Zmień asercję na skanowanie całego katalogu z wykluczeniem podkatalogu Node: `grep -rn "node:" packages/core/src/ --exclude-dir=node`.

### 9. [OBSERVATION] Nieergonomiczny kod wyjścia CLI przy braku sesji
* **Lokalizacja:** Faza 4.1 (`exit 1 only for unreadable projects dir / no sessions found`).
* **Szczegół:** Zwrócenie kodu wyjścia `1` w sytuacji, gdy katalog projektu istnieje, ale nie zawiera jeszcze żadnych sesji Claude Code, traktuje poprawny stan pusty jako awarię procesu (łamie standardy uniksowe dla poleceń listujących).
* **Poprawka:** Zwracaj `exit 0` z komunikatem `"No Claude Code sessions found for <dir>"`. Kod `1` zarezerwuj wyłącznie dla błędów wejścia/wyjścia, braku uprawnień lub błędnych flag.

### 10. [OBSERVATION] Niejednoznaczność komend złożonych w detekcji checków
* **Lokalizacja:** Critical Implementation Details (`Check detection`).
* **Szczegół:** Komendy są dzielone po operatorach `&&`, `;`, `|`. Plan nie precyzuje, jak traktować komendę łączącą operacje, np. `git status && pnpm test`. Jeśli segment testowy kończy się sukcesem, ale wcześniejszy zawiódł, status komendy zależy od interpretacji powłoki.
* **Poprawka:** Wprowadź regułę: całe wywołanie jest traktowane jako check, jeśli którykolwiek z segmentów wykonawczych jest checkiem; exit code dotyczy całego łańcucha poleceń Bash zwróconego w `tool_result`.

---
*Podsumowanie wykonalności faz*: Podział na 4 fazy jest zrównoważony i każda z nich mieści się w pojedynczym briefie wykonawczym (worker brief), pod warunkiem zaadresowania blokady interfejsu strumieniowania (punkt 1) na samym początku.
