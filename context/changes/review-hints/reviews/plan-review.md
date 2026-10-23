# Plan review (agy gemini-3.8-flash-high, 2026-10-23)

Oto ocena planu implementacji S-05 pod kątem spójności, ryzyk technicznych i kompletności:

---

### 1. [BLOCKING] Statusy `failed`/`unchecked` a rekomendacja `skim`
* **Lokalizacja:** *Desired End State* $\to$ *Recommendation*.
* **Szczegół:** Reguła wyliczania rekomendacji bazuje wyłącznie na hintach: `any high hint -> read-all / read-flagged; only warn/info -> skim; no hints -> skim`. Jeśli prompt ma status `failed` (wyłożone testy) lub `unchecked` (kod wdrożony bez weryfikacji), ale nie wywołał żadnego hintu `high`, system zarekomenduje reviewerowi `skim` (przejrzyj pobieżnie). Jest to sprzeczne z celem narzędzia i niebezpieczne.
* **Poprawka:** Wpleść status promptu do kalkulatora rekomendacji: jeśli `status === 'failed'` lub `'unchecked'`, minimalna rekomendacja to `read-flagged` (nawet przy braku hintów `high`).

---

### 2. [WARNING] Skrajne False Positives reguły `assertions-removed` przez słowo `should`
* **Lokalizacja:** *Desired End State* $\to$ *Rules* (`assertions-removed`).
* **Szczegół:** Wyszukiwanie usuniętych linii zawierających `should` w plikach testowych wywoła lawinę fałszywych alarmów w ekosystemach JS/TS i Python. Tytuły bloków testowych w Mocha/Jest/Jasmine nagminnie używają konwencji `it('should return 200', ...)` lub `def test_should_...`. Usunięcie lub edycja opisu testu zostanie zliczona jako usunięcie asercji.
* **Poprawka:** Usunąć generyczne `should` z prostego substring matchera. Jeśli wspierana jest asercja w stylu Chai (`.should.`), sprawdzać wywołanie jako metodę/właściwość (np. regex `\b(expect|assert[A-Za-z0-9_]*)\s*\(` lub `\.\s*should\b`).

---

### 3. [WARNING] False Positives reguły `sensitive-path` przez dopasowania podciągów (substrings)
* **Lokalizacja:** *Desired End State* $\to$ *Rules* (`sensitive-path`).
* **Szczegół:** Użycie dopasowania podciągów (np. `token`, `auth`, `security`) dopasuje nieszkodliwe pliki frontendu lub bibliotek, np. `tokens.css`, `design-tokens.ts`, `tokenizer.ts`, `author.ts`, `SecurityHeaders.spec.ts`.
* **Poprawka:** Dopasowywać pełne segmenty ścieżek katalogów lub nazwy plików (np. `(^|/)(\.env|Dockerfile)$` oraz `/(auth|secret|tokens?|migrations?)/`), zamiast wolnego `includes()`, z jawną listą wykluczeń (allowlist, np. `tokenizer`, `design-tokens`).

---

### 4. [WARNING] Narzut CPU i pamięci w domyślnej analizie (diff streaming)
* **Lokalizacja:** *Current State Analysis* vs *Critical Implementation Details*.
* **Szczegół:** Dotychczas diffy z patchy logów były procesowane wyłącznie w trybie szczegółowym (*detail mode*). Plan zakłada liczenie asercji i skipów w domyślnej analizie (*default analysis* dla widoku listy sesji). Mimo limitu 2000 linii per edit, parsowanie diffów przy każdej komendzie w sesjach z dużymi logami wprowadzi narzut CPU/pamięci w operacjach, które dotąd były bardzo szybkie (`--list`).
* **Poprawka:** Zapewnić streamingowe przetwarzanie linii bez alokacji całych struktur diff w pamięci parsera oraz zdefiniować test wydajnościowy (np. parsowanie 100-promptowej sesji nie może spowolnić o więcej niż 15%).

---

### 5. [WARNING] Ryzyko wycieku wrażliwych danych w `lgtm-review --summary` (tytuły promptów)
* **Lokalizacja:** *Desired End State* $\to$ *CLI* oraz *Critical Implementation Details*.
* **Szczegół:** Plan słusznie zakazuje umieszczania excerptów błędów w podsumowaniu, ale nakazuje generowanie tabeli z `80-char title`. W logach agentów tytuł prompta to często surowy początek promptu użytkownika, który bywa wklejany z tokenami, kluczami API, danymi PII lub poufnymi nazwami wewnętrznymi, a wynik `--summary` ma trafiać wprost do opisu PR na GitHubie.
* **Poprawka:** Zaimplementować sanityzację/maskowanie tytułu (redagowanie typowych wzorców tokenów/kluczy) oraz dodać flagę CLI pozwalającą na generowanie summary bez tytułów promptów (np. `--no-titles` lub `--redact`).

---

### 6. [OBSERVATION] Niejednoznaczność progu eskalacji do `read-all`
* **Lokalizacja:** *Desired End State* $\to$ *Recommendation*.
* **Szczegół:** Zapis `read-all if >= 3 distinct high hints else read-flagged` jest dwuznaczny: czy chodzi o 3 różne *reguły* o wadze high, czy o 3 wystąpienia tej samej reguły (np. zmodyfikowano 3 pliki w katalogu `auth/`, co da 3 hinty `sensitive-path`)? Przy interpretacji instancji, dotknięcie 3 plików wrażliwych natychmiast wymusza `read-all`, prowadząc do zmęczenia alertami (alert fatigue).
* **Poprawka:** Doprecyzować warunek jako `>= 3 distinct high rules` (unikalne typy reguł) lub `>= 3 distinct paths` w połączeniu ze zmianą testów.

---

### 7. [OBSERVATION] Łamanie kompatybilności wstecznej schematu Zod `PromptAnalysis`
* **Lokalizacja:** *Critical Implementation Details* & *Phase 1*.
* **Szczegół:** Uczynienie pól `hints` i `recommendation` wymaganymi (`required`) w schemacie Zod unieważni wszystkie stare sesje offline i zapisane wcześniej pliki JSON.
* **Poprawka:** W schemacie Zod dla odczytu sesji nadać domyślne wartości rezerwowe: `.default([])` dla `hints` oraz `.default('skim')` dla `recommendation`, dzięki czemu regeneracja obejmie tylko nowe testy/goldeny bez utraty wstecznej zgodności z istniejącymi logami.

---

### 8. [OBSERVATION] Niemierzalne, manualne kryteria akceptacji w Fazach 2 i 3
* **Lokalizacja:** *Phase 2: Success Criteria* oraz *Phase 3: Progress*.
* **Szczegół:** Kryteria typu *„Screenshots reviewed”* oraz *„Summary reviewed on a real local session (not committed)”* są subiektywne, podatne na błędy ludzkie i niemożliwe do zweryfikowania w procesie CI/CD.
* **Poprawka:** Zastąpić je kryteriami automatycznymi: w Fazie 2 test snapshotowy/RTL weryfikujący czytelność rekomendacji bez stylów kolorystycznych i obecność atrybutów dostępności; w Fazie 3 test integracyjny porównujący wyjście `--summary` z goldenem markdowna dla syntetycznego scenariusza.
