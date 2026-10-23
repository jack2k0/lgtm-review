# Plan review (agy gemini-3.8-flash-high, 2026-10-23)

### Ocena planu S-02 (Plan Review)

Plan dobrze adresuje główne wymagania biznesowe i NFR, jednak zawiera krytyczne luki w implementacji bezpieczeństwa, błąd logiki niszczący UX przy odświeżaniu strony oraz ryzyka wykonawcze. Poniżej zestawienie uwag.

---

### 1. [BLOCKING] Podatność Path Traversal przez dowiązania symboliczne (`path.resolve`)
- **Lokalizacja:** *Critical Implementation Details* (Token transport & static files).
- **Szczegół:** Plan zakłada weryfikację ścieżek za pomocą `path.resolve` + prefiks `dist/web`. Metoda `path.resolve` nie rozwiązuje symlinków w systemie plików. Jeśli w katalogu `dist/web` znajdzie się symlink (lub zostanie spreparowany), atakujący odczyta dowolne pliki z systemu użytkownika. Ponadto surowy serwer `http` nie dekoduje `req.url` (ryzyko `%2e%2e` oraz bajtów zerowych `%00`).
- **Poprawka:** Użyć `decodeURIComponent` (z `try/catch` dla `URIError`), odrzucać znaki `\0`, a po wstępnym `path.resolve` wywołać `fs.realpath` i dopiero wtedy sprawdzić, czy ścieżka zaczyna się od `fs.realpath(webRoot)`.

### 2. [BLOCKING] Usunięcie tokenu z URL blokuje odświeżanie strony (F5)
- **Lokalizacja:** *Overview* / *Critical Implementation Details* / *What We're NOT Doing*.
- **Szczegół:** Plan nakazuje natychmiastowe usunięcie `#k=<token>` z URL za pomocą `history.replaceState` i trzymanie go wyłącznie w pamięci SPA. Jednocześnie odrzuca live-reload, zalecając *"reload the page to re-read"*. Wciśnięcie F5 wyczyści pamięć SPA, a brak tokenu w URL spowoduje natychmiastowy błąd 403 i uniemożliwi pracę bez ponownego kopiowania URL z terminala.
- **Poprawka:** Przechowywać token w `sessionStorage` (jest odizolowany do karty, przeżywa przeładowanie F5, znika po zamknięciu karty). Przy starcie SPA pobierać token z `location.hash` (i zapisywać do `sessionStorage`) lub bezpośrednio z `sessionStorage`.

### 3. [BLOCKING] Brak walidacji nagłówka `Host` na plikach statycznych (DNS Rebinding)
- **Lokalizacja:** *Critical Implementation Details* / *Phase 2*.
- **Szczegół:** W planie zapisano: *"Static assets are served without the token... API requires token and Host check before anything else"*. Jeśli weryfikacja nagłówka `Host` dotyczy tylko `/api/*`, serwer jest podatny na DNS Rebinding na endpointach statycznych (`/`, `/index.html`). Złośliwa domena wskazująca na `127.0.0.1` mogłaby załadować aplikację SPA w obcym kontekście.
- **Poprawka:** Walidację nagłówka `Host` (`127.0.0.1:PORT` lub `localhost:PORT`) umieścić jako bezwzględnie pierwszy middleware w potoku `http`, odrzucający (403) zapytania do *wszystkich* zasobów (w tym statycznych).

### 4. [WARNING] Brak obsługi MIME types w surowym serwerze Node przy `nosniff`
- **Lokalizacja:** *Phase 2: Local server and JSON API*.
- **Szczegół:** Plan zakłada użycie surowego `http` bez frameworka oraz wymuszenie nagłówka `X-Content-Type-Options: nosniff`. Node.js nie nadaje automatycznie nagłówków `Content-Type`. Przy włączonym `nosniff` nowoczesne przeglądarki zablokują wykonanie skryptów JS (`dist/assets/*.js`) i stylów CSS, jeśli nie otrzymają poprawnego MIME type.
- **Poprawka:** Dodać wbudowaną, statyczną mapę rozszerzeń na Content-Type (`.html` -> `text/html; charset=utf-8`, `.js` -> `application/javascript`, `.css` -> `text/css`, `.svg` -> `image/svg+xml`, `.json` -> `application/json`).

### 5. [WARNING] Błędne naliczanie czasu (double-counting) przy równoległych narzędziach
- **Lokalizacja:** *Critical Implementation Details* (Time split) / *Phase 1*.
- **Szczegół:** Claude Code wykonuje narzędzia równolegle (kilka bloków `tool_use` w jednej wiadomości). Liniowe sumowanie delty `tool_result - tool_use` oraz przypisywanie przerw spowoduje, że `activeMs` przekroczy rzeczywisty czas zegarowy (wall-clock). Ponadto nie-monotoniczne timestampy (~7% malejących) bez uprzedniego posortowania zniekształcą fazy i wyzerują poprawne interwały.
- **Poprawka:** Przed obliczeniami posortować eventy i dokonać fuzji nakładających się przedziałów czasowych (algorytm scalania przedziałów / interval union) per faza, aby czas aktywny nie dublował się w ramach współbieżnych operacji.

### 6. [WARNING] Nadpisywanie assetów: `tsup` usuwa skopiowany katalog `dist/web`
- **Lokalizacja:** *Implementation Approach* / *Phase 4*.
- **Szczegół:** Skrypt `copy-web.mjs` kopiuje zbudowane SPA do `packages/cli/dist/web`. Jeśli `tsup` w paczce CLI ma skonfigurowaną opcję `clean: true`, kompilacja CLI wyczyści cały katalog `dist`, usuwając wcześniej skopiowany frontend.
- **Poprawka:** W `turbo.json` lub skryptach `package.json` wymusić ścisłą kolejność: `build:web -> build:cli (tsup) -> copy-web`. W `tsup.config.ts` upewnić się, że `clean` nie czyści wygenerowanego podfolderu `web` lub czyści katalog przed startem kopiowania.

### 7. [WARNING] Zawieszenie smoke testu przez buforowanie stdout procesu Node.js
- **Lokalizacja:** *Critical Implementation Details* / *Phase 4*.
- **Szczegół:** Uruchomienie CLI przez npx w procesie potomnym (child process) bez alokacji pseudoterminala (TTY) powoduje, że Node domyślnie buforuje `stdout` w blokach 4 KB. Smoke test czekający na URL serwera zawiesi się w nieskończoność, czekając na flush bufora.
- **Poprawka:** W kodzie CLI po uruchomieniu serwera jawnie wywołać `process.stdout.write(url + '\n')`, a w skrypcie `smoke-pack.mjs` dodać sztywny timeout (np. 10 s) z ubijaniem procesu w bloku `finally`.

### 8. [WARNING] Przeładowany zakres Fazy 2 (ryzyko dla pojedynczego workera)
- **Lokalizacja:** *Phase 2: Local server and JSON API with security properties*.
- **Szczegół:** Faza 2 obejmuje jednocześnie: serwer HTTP od podstaw, serwowanie plików statycznych z obroną traversal, warstwę bezpieczeństwa (Host, Origin, Token, CSP, nosniff), 2 endpointy API, streaming/caching analizy, refaktoryzację flag CLI (`--list`, `--port`, `--no-open`), helper `open.ts` oraz testy integracyjne. To zbyt duży narzut implementacyjny na jeden brief.
- **Poprawka:** Rozbić Fazę 2 na dwa etapy: 2A (Serwer HTTP, middleware bezpieczeństwa, statyczne pliki, testy izolacji) oraz 2B (Endpointy `/api/sessions*`, integracja z CLI, obsługa flag i launchera).

### 9. [WARNING] Niepełna ochrona przed CSRF przy `Origin: null`
- **Lokalizacja:** *Critical Implementation Details* (Security) / *Phase 2*.
- **Szczegół:** Reguła *"Origin if present must equal the server origin"* nie definiuje zachowania dla `Origin: null`. Żądania z piaskownicy iframe (`sandbox`), schematów `data:` lub plików lokalnych wysyłają nagłówek `Origin: null`, co przy naiwnej walidacji może doprowadzić do obejścia sprawdzania pochodzenia.
- **Poprawka:** Jawnie zdefiniować regułę: odrzucać żądania, w których `Origin` ma wartość `null`, `undefined` lub inną niż dokładny adres serwera (`http://127.0.0.1:PORT`).

### 10. [OBSERVATION] Brak obsługi IPv6 loopback (`::1`) przy akceptacji `Host: localhost`
- **Lokalizacja:** *Overview* / *Desired End State*.
- **Szczegół:** Serwer binduje wyłącznie `127.0.0.1`, podczas gdy nagłówek `Host` dopuszcza `localhost:PORT`. W nowszych dystrybucjach Linuksa i środowiskach Node.js `localhost` jest rozwiązywany priorytetowo na IPv6 `::1`. Jeśli użytkownik otworzy stronę pod adresem `localhost`, połączenie zostanie odrzucone (connection refused).
- **Poprawka:** Wypisywać i otwierać w przeglądarce wyłącznie literalny adres `http://127.0.0.1:PORT` (zgodnie z planem), a w testach upewnić się, że nie ma prób łączenia pod alias `localhost`.

### 11. [OBSERVATION] Niemierzalne i subiektywne kryteria sukcesu (Manual Verification)
- **Lokalizacja:** *Progress* / *Success Criteria* (Fazy 1, 2, 4).
- **Szczegół:** Kryteria takie jak *"Reviewer reads security.ts once"*, *"Reviewer reads two goldens' split numbers"* czy *"unless small (< 1 MB total)"* są niemierzalne i nie dają gwarancji poprawności.
- **Poprawka:** Zastąpić manualne czytanie zautomatyzowanymi asercjami: test macierzowy wektorów ataków (testy negatywne w Phase 2), test dopuszczalnego błędu splitu w fixture (tolerancja < 5%), a dla paczki npm twarda asercja w skrypcie: `size < 2MB`.
