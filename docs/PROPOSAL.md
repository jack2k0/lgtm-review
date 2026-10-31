---
title: "Strata (nazwa robocza) — wizualny review sesji agentów AI"
status: historical (superseded by context/foundation/prd.md)
created: 2026-10-22
author: jack2k (+ Claude)
purpose: >
  Seed dla łańcucha 10xDevs (/10x-shape @docs/PROPOSAL.md → /10x-prd → …).
  Wszystkie decyzje produktowe w tym pliku są PROPOZYCJAMI do potwierdzenia
  w /10x-shape — nie są jeszcze zablokowane.
---

> **Dokument historyczny:** To jest historyczna propozycja z dnia 2026-10-22. „Strata” była nazwą roboczą — produktem jest obecnie `lgtm-review`. Poniższe polecenia oraz nazwy pakietów nie są aktualne; aktualnymi źródłami są `context/foundation/prd.md` oraz `README.md`.

# Strata — wizualny review sesji agentów AI

> **TL;DR** Lokalne narzędzie open source (`npx strata`), które zamienia log sesji
> Claude Code w czytelną historię zmian: lista promptów ze statusem weryfikacji
> (checked / unchecked / failing), oś kroków z podziałem czasu (Read / Write /
> Check / Fix), warstwowa mapa izometryczna zmienionych plików z krawędziami
> importów oraz „Play the change" — odtworzenie zmiany krok po kroku z podpisami.
> Cel: reviewer schodzi do diffa tylko tam, gdzie trzeba, zamiast czytać 50 plików
> wygenerowanego kodu po kolei.

Spis treści

1. [Geneza i uczciwość wobec autora pomysłu](#1-geneza)
2. [Problem](#2-problem)
3. [Persony](#3-persony)
4. [Wizja: poziomy abstrakcji](#4-wizja-poziomy-abstrakcji)
5. [Funkcje — ekran po ekranie](#5-funkcje--ekran-po-ekranie)
6. [Reguła domenowa (business logic)](#6-reguła-domenowa)
7. [Źródła danych — co faktycznie jest w logach](#7-źródła-danych)
8. [Architektura](#8-architektura)
9. [Algorytmy](#9-algorytmy)
10. [Warstwa LLM (opcjonalna)](#10-warstwa-llm-opcjonalna)
11. [CLI i dystrybucja](#11-cli-i-dystrybucja)
12. [Prywatność i bezpieczeństwo](#12-prywatność-i-bezpieczeństwo)
13. [Open source — jak prowadzić projekt](#13-open-source)
14. [Konkurencja i pozycjonowanie](#14-konkurencja-i-pozycjonowanie)
15. [Zakres: MVP, później, nigdy](#15-zakres)
16. [Ryzyka i otwarte pytania](#16-ryzyka-i-otwarte-pytania)
17. [Roadmapa (draft dla /10x-roadmap)](#17-roadmapa-draft)
18. [Realizacja we frameworku 10xDevs](#18-realizacja-w-10xdevs)
19. [Mapowanie dokumentu na schemat PRD](#19-mapowanie-na-prd)

---

## 1. Geneza

Pomysł pochodzi z prezentacji prywatnego prototypu (roboczo „Trailo", makieta
w Claude Design) pokazanego podczas live'a kursu AI Tech Leaders (21.10.2026).
Autor zaznaczył, że narzędzie nie jest wydane i służy mu do review **własnego**
kodu i promptowania. Publicznie nie istnieje — stąd ten projekt.

Zasady:

- **Nie kopiujemy nazwy, brandingu ani 1:1 wyglądu** prototypu. Bierzemy koncepcję
  (poziomy abstrakcji w review), a UI projektujemy sami.
- W README dajemy kredyt za inspirację (po zapytaniu autora, czy sobie tego życzy).
- Materiałów z kursu (transkrypcja, screeny) **nie commitujemy** do publicznego repo.
  Repo projektu zakładamy w nowym katalogu; ten folder (`CodeReviewer/`) zostaje
  prywatnym notatnikiem.

## 2. Problem

Agent w 15 minut zmienia 6–60 plików. Review tego trwa dłużej niż pisanie, bo:

1. **Diff nie mówi „dlaczego" ani „w jakiej kolejności".** PR pokazuje stan końcowy
   plik po pliku, alfabetycznie. Ginie narracja: co agent przeczytał, co próbował,
   co się wywaliło, co poprawił.
2. **Nie wiadomo, co zostało zweryfikowane.** Czy testy poleciały *po* ostatniej
   edycji? Czy agent nie „naprawił" testu zamiast kodu? Tej informacji nie ma
   w diffie — jest tylko w logu sesji, którego nikt nie czyta.
3. **80% wygenerowanego kodu to rutyna**, ale żeby znaleźć 20% istotnego
   (API, auth, migracje, usunięte asercje), trzeba przeczytać wszystko.
4. **Kontekst sesji wyparowuje.** Następnego dnia nikt nie pamięta, co agent robił
   w 4. prompcie. Terminal scrollback to nie jest artefakt.

Koszt dziś: review jako wąskie gardło (praca „utyka na review, nie w developmencie"),
albo — gorzej — review „bocznym okiem" i merge bez zrozumienia.

**Insight:** log sesji agenta zawiera *więcej* informacji niż diff (kolejność,
intencję, wyniki checków, tekst agenta między krokami). Wystarczy go przetworzyć
na kolejne poziomy abstrakcji, żeby reviewer czytał kod **selektywnie**.

## 3. Persony

**Primary — „Solo dev / tech lead pracujący z agentem"** (to jest właściciel projektu).
Codziennie kilka–kilkanaście sesji Claude Code, często równolegle w worktree.
Moment użycia: koniec sesji / przed commitem lub PR — „co właściwie wleciało
i czy mogę to zmerge'ować bez czytania wszystkiego?".

**Secondary — „Reviewer PR w zespole".** Dostaje PR napisany przez agenta kolegi.
Moment: otwiera PR i widzi link / załącznik z raportem sesji (eksport HTML).
Nie ma dostępu do maszyny autora — potrzebuje artefaktu samowystarczalnego.

**Tertiary (później) — „Lider zespołu".** Chce widzieć, gdzie agenci tracą czas
(fixing vs writing), które prompty kończą się bez weryfikacji.

## 4. Wizja: poziomy abstrakcji

Rdzeń koncepcji — reviewer schodzi w dół tylko gdy musi:

```
L0  Sesje          „Dziś 5 sesji, 2 mają niezweryfikowane zmiany"
 │
L1  Prompty        „4 prompty, 15 min pracy agenta: 2 checked, 1 unchecked, 1 failing"
 │                  + jednozdaniowy tytuł każdego promptu
 │
L2  Kroki | Mapa   Steps: gdzie poszedł czas, oś Read→Write→Check→Fix, cytaty agenta
 │                  Map: warstwy (Tests/Server/UI/Config), pliki, nowe/usunięte importy
 │                  Play: odtworzenie zmiany krok po kroku z podpisami
 │                  Hints: „czytaj te 3 pliki — dotykają auth / usunięto asercje"
 │
L3  Diff           klasyczny diff pliku — dopiero tutaj czytamy kod
```

## 5. Funkcje — ekran po ekranie

Opis odwzorowuje to, co było widać na 4 screenach prototypu (S1–S4), plus elementy
dodane przez nas (oznaczone **[nowe]**).

### 5.1 Lista sesji (L0) **[nowe]**

- Sesje dla bieżącego repo (domyślnie: cwd), sortowane od najnowszej.
- Wiersz: tytuł sesji (z `ai-title` w logu lub pierwszy prompt), branch, czas,
  liczba promptów, licznik statusów, źródło (`claude CLI`, później inne agenty).
- Filtr: wszystkie repo / bieżące repo / worktree tego repo.

### 5.2 Prompty sesji (L1) — screen S1

- Nagłówek: ścieżka repo, branch (`feat/storefront-reviews`), źródło (`claude CLI`).
- Headline: **„4 prompts, 15 minutes of agent work."** + liczniki
  `● 2 checked ● 1 unchecked ● 1 failing`.
- Wiersz promptu (od najnowszego):
  - kropka statusu (zielona / pomarańczowa / czerwona),
  - numer, **tytuł w jednym zdaniu w czasie przeszłym, z „haczykiem"**
    („Added reviews. Two edits were never checked.", „Renamed the hook, missed
    three test imports."),
  - pod spodem oryginalny prompt (przycięty),
  - czas pracy (`7m 12s`), pasek faz w kolorach Read/Write/Fix/Check proporcjonalny
    do czasu, licznik plików `+2 ~3 −1` (dodane / zmienione / usunięte).
- Klawiatura: `↑↓` ruch, `Enter` otwórz, `Esc` wróć. Legenda kolorów faz na dole.

### 5.3 Steps (L2) — screen S2

- Nagłówek: pełny prompt jako tytuł, `7m 12s · 6 files`, zakładki **Map | Steps**.
- **„Where the time went"**: zdanie-wniosek („Most of this turn went to fixing.
  2m 40s of 7m 12s. Checks took 48s.") + 4 paski: Fix / Write / Read / Check
  z czasem i %.
- **Oś kroków** (lewa kolumna: offset czasu `0:00`, `1:10`, `3:30`…), każdy krok:
  - faza (kolor) + tytuł kroku („Read the route, the mail helper and the test setup"),
  - Read: `Read 11 files`, `Grep × 5`,
  - Write/Fix: chipy plików z `+52`, `~ route.ts +14 −2`, klik → diff (L3),
  - Check: komenda (`pnpm vitest run tests/api`) i wynik
    (`exit 1 · expected 429, received 200`) — czerwony chip przy porażce,
  - cytat agenta z tekstu między narzędziami
    („The header check runs before the limiter, moving it."),
  - czas trwania kroku po prawej, mini-pasek.

### 5.4 Map (L2) — screeny S3, S4

- Rzut **izometryczny** (2.5D) z poziomymi płaszczyznami-warstwami, np. dla Next.js:
  `Tests` (różowa), `Server` (niebieska), `Config & deps` (żółta); presety dla
  innych stacków (sekcja 9.6).
- Etykieta warstwy z licznikiem: „Server — 2 changed · 1 linked".
- Węzły = pliki. Stany: **Added** (pierścień), **Changed** (pełna kropka),
  **Deleted** (przekreślony, wyszarzony, np. `contact.spec.ts −31`),
  **Linked, unchanged** (przerywany — sąsiad z importu, np. `mail.ts`),
  **Flagged** (pomarańczowa kropka — patrz Review hints).
- Węzeł paczki (np. `@sinonjs/fake-timers`) w warstwie Config & deps, gdy dochodzi
  zależność.
- Krawędzie = importy: **New import** (jasna linia), **Existing** (szara),
  **Removed** (kropkowana); etykieta krawędzi = importowane symbole (`POST`,
  `useFakeTimers`). Liczniki w legendzie (`New import 4 · Existing 1 · Removed 1`).
- Filtry warstw (`All layers / Tests / Server / Config & deps`), zoom (`− 97% +`),
  pan, „Click a file to focus" (wygasza resztę), wybór presetu.

### 5.5 Play the change (L2) — screen S4

- Przycisk **▶ Play the change** — sekwencja „beatów" (`3 / 6`), każdy podświetla
  węzeł/krawędź na mapie i pokazuje:
  - linię techniczną: `contact.test.ts now imports route.ts`,
  - podpis ludzkim językiem: „A new test sends the form 6 times and expects the 6th
    to be blocked." + uzasadnienie: „This proves the limit actually works.",
- sterowanie: `‹ ›`, Pause, Done; klawiatura `←/→/Space`.

### 5.6 Diff (L3) **[nowe w stosunku do screenów, wspomniane na live]**

- Panel boczny / modal z diffem pliku dla danego kroku **albo** zbiorczo dla promptu.
- Unified / split, podświetlanie składni, zwijanie niezmienionych fragmentów.
- Nad diffem: podsumowanie pliku (co się zmieniło, dodane/usunięte importy i zależności).

### 5.7 Review hints **[nowe]**

Deterministyczne flagi „tu patrz" — realizują praktykę „czytamy kod tylko gdy dotyka
core'a, API, bazy, bezpieczeństwa". Pełna lista reguł w 9.7. Prezentacja:

- pomarańczowa kropka na węźle mapy + powód w tooltipie,
- sekcja „Where to look" nad krokami: 1–5 plików z powodami,
- rekomendacja na poziomie promptu: **Skim** / **Read flagged** / **Read all**.

### 5.8 Eksport i udostępnianie **[nowe]**

- `strata export` → **jeden plik HTML** (wszystko inline, działa offline) z redakcją
  sekretów — do załączenia do PR, wysłania koledze, archiwum zmiany.
- `strata summary --md` → markdown do opisu PR (prompty, statusy, hints).

## 6. Reguła domenowa

**Jednym zdaniem:** dla każdego promptu w sesji agenta narzędzie klasyfikuje każdą
akcję agenta do fazy Read / Write / Check / Fix i wylicza status weryfikacji —
*checked* tylko wtedy, gdy po ostatniej edycji przeszedł check zakończony sukcesem —
żeby reviewer przed przeczytaniem jakiegokolwiek kodu wiedział, które zmiany
są niezweryfikowane i gdzie patrzeć.

Wejście: zapis sesji (prompty użytkownika, akcje agenta, wyniki akcji, czasy).
Wyjście: status + powód dla każdego promptu, rozkład czasu na fazy, lista plików
z rodzajem zmiany i flagami. Użytkownik spotyka regułę na L1 (kropki statusów)
i L2 (paski czasu, flagi).

Statusy (precyzyjnie w 9.3):

| Status | Warunek | Przykładowy tytuł |
|---|---|---|
| `checked` | były edycje; ostatni check po ostatniej edycji zakończony sukcesem | „Rate-limited the contact form." |
| `unchecked` | były edycje po ostatnim checku albo nie było żadnego checku | „Added reviews. Two edits were never checked." |
| `failing` | ostatni check w promptcie zakończył się porażką | „Renamed the hook, missed three test imports." |
| `no-changes` | prompt bez edycji (pytanie, research) | szary, bez kropki |

## 7. Źródła danych

### 7.1 Claude Code (MVP) — zweryfikowane na lokalnych logach

Lokalizacja: `~/.claude/projects/<slug-ścieżki-cwd>/<sessionId>.jsonl`
(slug = ścieżka z `/` zamienionymi na `-`). Format: JSONL, jeden rekord na linię.
**Format nie jest oficjalnie udokumentowanym, stabilnym API** — parser musi być
tolerancyjny (sekcja 16).

Co znaleźliśmy w logach (wersja Claude Code 2.1.x, X 2026):

| Dane | Gdzie | Użycie |
|---|---|---|
| typ rekordu | `type`: `user`, `assistant`, `system`, `attachment`, `file-history-snapshot`, `ai-title`, `last-prompt`, `mode`, … | segmentacja |
| czas | `timestamp` (ISO) na rekordach; `durationMs` na części | czas faz |
| powiązania | `uuid`, `parentUuid`, `promptId`, `sessionId`, `isSidechain` | drzewo, tury |
| kontekst | `cwd`, `gitBranch`, `version`, `entrypoint` | nagłówek, filtr repo |
| prompt | `message.content` (string lub bloki `text`) w rekordzie `user` | L1 |
| akcje | bloki `tool_use` (`name`, `input`) w `assistant` | fazy |
| wyniki | bloki `tool_result` (`is_error`, treść) + `toolUseResult` | check ok/fail |
| diff edycji | `toolUseResult.structuredPatch` (hunki: `oldStart`, `oldLines`, `newStart`, `newLines`, `lines` z prefiksem `+`/`-`), `filePath`, `type: create/update`, `oldString/newString` | +/− i importy |
| edycje przez Bash | `toolUseResult.bashEditDiff.files[].hunks` | Write/Fix przez `sed -i` itp. |
| operacje git | `toolUseResult.gitOperation` (np. push) | oś kroków |
| tekst agenta | bloki `text` w `assistant` między narzędziami | cytaty w Steps |
| tytuł sesji | rekord `ai-title` | L0 |
| subagenty | `<sessionId>/subagents/*.jsonl` + wynik narzędzia `Agent` (`agentId`, `description`, `resolvedModel`) | kroki zagnieżdżone |
| kopie plików | `~/.claude/file-history/<sessionId>/<hash>@vN` + rekordy `file-history-snapshot` | stan „przed" |

Czego **nie ma**: treści myślenia — bloki `thinking` są zapisywane puste.
„Myśli AI" w UI = tekst, który agent pisze między wywołaniami narzędzi (wystarcza).

**Retencja:** Claude Code domyślnie kasuje sesje starsze niż 30 dni
(`cleanupPeriodDays`, [docs](https://code.claude.com/docs/en/claude-directory)).
Wniosek: `Story` warto utrwalać (eksport / lokalne archiwum `~/.strata/`), inaczej
historia review znika razem z logiem.

**Alternatywne źródła na żywo:** hooki `PreToolUse`/`PostToolUse` (dają `tool_name`,
`tool_input`, `tool_response`, `duration_ms`, `transcript_path` —
[docs](https://docs.anthropic.com/en/docs/claude-code/hooks.md)) i OpenTelemetry
(`CLAUDE_CODE_ENABLE_TELEMETRY=1`, traces w becie —
[docs](https://code.claude.com/docs/en/monitoring-usage)). Nie zastępują JSONL
(brak pełnych diffów), ale hook `Stop` + `transcript_path` to naturalny wyzwalacz
trybu live i pluginu.

Do zweryfikowania w spike'u (faza 1): dokładny format exit code porażki Basha
(`is_error` + prefiks `Exit code N`), rekordy kompaktowania kontekstu, sesje wznowione
(`--resume`/fork), równoległe wywołania narzędzi, przerwania (Esc).

### 7.2 Uzupełnienie z git (opcjonalne, gdy repo dostępne)

- Uzgodnienie stanu końcowego (`git diff --numstat`) — wykrycie zmian zrobionych
  poza agentem (ręcznie przez usera) → oznaczenie `external`.
- Usunięcia plików zrobione przez `rm`/`git rm` w Bashu.
- Treść plików „po" do budowy grafu importów.

### 7.3 Inne agenty (po MVP) — przez adaptery

Codex CLI, Gemini CLI / Antigravity, Grok Build, OpenCode, Cursor CLI — każdy
przez adapter mapujący na wspólny model zdarzeń (8.3). Szczegóły formatów:
patrz sekcja 14 (research).

## 8. Architektura

### 8.1 Widok z góry

```
             ┌──────────────── packages/core (czysty TS, bez IO w analizie) ───────────────┐
 JSONL  ──►  │ adapters/claude-code ─► normalize ─► NormalizedEvent[]                      │
 file-hist   │                                         │                                    │
 git (opc.)  │   analyze: turns ► phases ► time ► status ► files ► graph ► hints ► beats    │
             │                                         │                                    │
             │                                     Story (JSON, wersjonowany schemat)       │
             └─────────────────────────────────────────┬────────────────────────────────────┘
                                                       │
         ┌─────────────────────┬───────────────────────┼──────────────────────┐
         ▼                     ▼                       ▼                      ▼
 packages/summarizer    packages/cli             packages/web           export HTML
 (opcjonalny LLM,       strata serve|export|     Vite + React SPA       (web build +
  cache po hashu)       list|inspect|summary     L0–L3, Map, Play       Story inline)
```

### 8.2 Pakiety (monorepo)

| Pakiet | Odpowiedzialność | Zależy od |
|---|---|---|
| `@strata/schema` | typy + walidatory (zod) modelu `Story`, wersja schematu | — |
| `@strata/core` | adaptery, normalizacja, analizatory, graf importów, presety, hints | schema |
| `@strata/summarizer` | opcjonalne tytuły/podpisy z LLM, cache | schema |
| `@strata/web` | SPA: listy, Steps, Map (SVG izometryczny), Play, Diff | schema |
| `strata` (cli) | komendy, lokalny serwer, watch, eksport | core, summarizer, web (build) |

Zasada: **`Story` JSON to kontrakt** między analizą a UI. Dzięki temu (a) UI da się
rozwijać na fixture'ach bez parsera, (b) inne narzędzia mogą produkować `Story`,
(c) eksport HTML = build UI + osadzony JSON.

### 8.3 Model danych (szkic)

```ts
// Znormalizowane zdarzenie — wspólne dla wszystkich adapterów
type NormalizedEvent =
  | { kind: "prompt"; id: string; at: string; text: string }
  | { kind: "agent_text"; at: string; text: string; subagent?: string }
  | { kind: "action"; id: string; at: string; tool: string;
      category: "read" | "search" | "edit" | "exec" | "delegate" | "ask" | "other";
      files?: string[]; command?: string; subagent?: string }
  | { kind: "result"; actionId: string; at: string; ok: boolean; exitCode?: number;
      output?: string; durationMs?: number; patches?: FilePatch[] }
  | { kind: "meta"; at: string; type: "compaction" | "interrupt" | "resume" | "title"; data?: unknown };

interface FilePatch { path: string; op: "create" | "update" | "delete";
  hunks: { oldStart: number; oldLines: number; newStart: number; newLines: number; lines: string[] }[] }

// Wynik analizy — to konsumuje UI
interface Story {
  schemaVersion: 1;
  session: { id: string; agent: "claude-code" | string; agentVersion?: string;
    cwd: string; branch?: string; title?: string; startedAt: string; endedAt: string };
  turns: Turn[];
}

interface Turn {
  id: string; index: number; prompt: string;
  title?: string;                      // LLM albo fallback deterministyczny
  startedAt: string; activeMs: number;  // bez czekania na usera
  status: "checked" | "unchecked" | "failing" | "no-changes";
  statusReason: string;                // np. "2 edits after last check"
  phaseMs: Record<Phase, number>;
  headline?: string;                   // "Most of this turn went to fixing."
  steps: Step[];
  files: FileChange[];
  graph: Graph;
  beats: Beat[];
  hints: Hint[];
  recommendation: "skim" | "read-flagged" | "read-all";
}

type Phase = "read" | "write" | "check" | "fix" | "delegate" | "other";

interface Step {
  phase: Phase; offsetMs: number; durationMs: number;
  title: string;                       // LLM albo "Read 11 files · Grep × 5"
  actions: { tool: string; label: string; ok?: boolean }[];
  files: { path: string; added: number; removed: number; op: FilePatch["op"] }[];
  check?: { command: string; exitCode: number; excerpt?: string };
  quotes: string[];                    // tekst agenta między narzędziami
  substeps?: Step[];                   // subagent
}

interface FileChange { path: string; status: "added" | "changed" | "deleted" | "linked";
  added: number; removed: number; layer: string; flags: string[] }

interface Graph {
  layers: { id: string; label: string; color: string; changed: number; linked: number }[];
  nodes: { id: string; kind: "file" | "package"; layer: string; status: FileChange["status"]; flagged: boolean }[];
  edges: { from: string; to: string; kind: "new" | "existing" | "removed"; symbols: string[] }[];
}

interface Beat { index: number; focus: string[]; technical: string; caption?: string; detail?: string }
interface Hint { file: string; rule: string; reason: string; severity: "info" | "warn" | "high" }
```

## 9. Algorytmy

### 9.1 Segmentacja na prompty (tury)

- Nowa tura = rekord `user`, którego treść jest tekstem użytkownika (nie
  `tool_result`, nie `isMeta`, nie wynik komendy lokalnej). Pomocniczo `promptId`.
- Slash commandy i `/goal`: tytuł z argumentów komendy.
- Tura kończy się przed następnym promptem albo końcem pliku.
- Subagenty (`isSidechain` / pliki w `subagents/`) doklejane jako `substeps`
  kroku `delegate` w turze rodzica.
- Kompaktowanie i wznowienie sesji: zdarzenia `meta`, nie przerywają tury.

### 9.2 Klasyfikacja faz

```
lastCheckFailed = false
dla każdej akcji w turze (chronologicznie):
  Read / Grep / Glob / LS / WebFetch / WebSearch, Bash read-only (cat, ls, rg, git log|diff|status)
                                                  → read
  Bash pasujący do wzorca checku                  → check
        ok = exit 0 ; lastCheckFailed = !ok
  Edit / Write / MultiEdit / NotebookEdit, Bash z bashEditDiff
                                                  → lastCheckFailed ? fix : write
  Agent / Task                                    → delegate (substeps klasyfikowane rekursywnie)
  AskUserQuestion, oczekiwanie na zgodę           → wyłączone z czasu agenta
  pozostałe                                       → other
```

Wzorce checku (konfigurowalne, domyślne): testy (`vitest`, `jest`, `mocha`,
`playwright test`, `pytest`, `go test`, `cargo test`, `npm|pnpm|yarn|bun test`,
`./scripts/check.sh`), typy (`tsc`, `mypy`, `pyright`), lint (`eslint`, `ruff`,
`biome`), build (`next build`, `vite build`, `cargo build`).

Grupowanie: kolejne akcje tej samej fazy → jeden `Step` („Read 11 files · Grep × 5").

### 9.3 Status promptu

```
edits  = akcje write|fix w turze (łącznie z substeps)
checks = akcje check w turze
jeśli edits puste                         → no-changes
jeśli brak check po ostatniej edycji      → unchecked  (powód: "N edits after last check" / "no checks ran")
jeśli ostatni check w turze = porażka     → failing    (powód: excerpt błędu)
w przeciwnym razie                        → checked
```

v2: „partially checked" — check nie obejmuje edytowanych plików (np. `vitest run
tests/api`, a edycje w `components/`).

### 9.4 Czas

- Czas akcji = od końca poprzedniego zdarzenia do końca wyniku akcji (`timestamp`
  wyniku); `durationMs`, jeśli jest, ma pierwszeństwo.
- Czas „myślenia" modelu przed akcją przypisany do fazy tej akcji.
- Luki > progu (domyślnie 120 s) bez działającego narzędzia = czekanie na usera →
  odcięte z `activeMs`.
- Headline: faza dominująca → szablon („Most of this turn went to fixing.").

### 9.5 Pliki i graf importów

1. **Zmiany plików**: z `structuredPatch`/`bashEditDiff` → `added/removed`; `create`
   → added; usunięcia z komend Bash (`rm`, `git rm`, `git mv`) + uzgodnienie z git.
2. **Krawędzie bez rekonstrukcji snapshotów (sprytny skrót na MVP)**:
   - linie importu w hunkach `+` → krawędź **new**,
   - linie importu w hunkach `−` → krawędź **removed**,
   - importy w aktualnej treści pliku, które łączą dwa zmienione pliki → **existing**.
3. **Rozwiązywanie specyfikatorów**: aliasy z `tsconfig` `paths`, rozszerzenia,
   `index.*`; bare specifier → węzeł paczki.
4. **Linked, unchanged**: pliki niezmienione, do których prowadzi krawędź z/do
   zmienionego pliku (1 hop, limit N=8 na turę).
5. **Paczki**: nowe wpisy w `dependencies`/`devDependencies` z diffa `package.json`.
6. **Języki**: MVP = TS/JS (ESM + CJS `require`). v0.2 = Python (`import`,
   `from … import`). Inne: węzły bez krawędzi (warstwy nadal działają).

### 9.6 Warstwy i presety

Warstwa = reguła glob → id; pierwsza pasująca wygrywa; kolejność = od góry mapy.

```jsonc
// strata.config.json (opcjonalny; inaczej auto-detekcja presetu)
{
  "preset": "nextjs",
  "layers": [
    { "id": "tests",  "label": "Tests",         "match": ["**/*.{test,spec}.*", "**/__tests__/**", "e2e/**", "tests/**"] },
    { "id": "ui",     "label": "UI",            "match": ["app/**/page.tsx", "app/**/layout.tsx", "components/**"] },
    { "id": "server", "label": "Server",        "match": ["app/**/route.ts", "middleware.ts", "lib/server/**", "server/**"] },
    { "id": "shared", "label": "Shared",        "match": ["lib/**", "utils/**", "hooks/**"] },
    { "id": "config", "label": "Config & deps", "match": ["package.json", "*lock*", "*.config.*", "tsconfig*.json", ".github/**"] }
  ],
  "checks": ["pnpm vitest*", "pnpm tsc*"],
  "sensitive": ["**/auth/**", "**/migrations/**", "**/*secret*", ".github/workflows/**"]
}
```

Presety MVP: `nextjs`, `vite-react`, `node-api`, `generic` (warstwy wg katalogu
najwyższego poziomu). v0.2: `django`, `fastapi`, `monorepo` (warstwa = pakiet).
Auto-detekcja z `package.json` / `pyproject.toml` / struktury katalogów.

### 9.7 Review hints (reguły)

| Reguła | Wyzwalacz | Waga |
|---|---|---|
| `test-modified-during-fix` | plik testu edytowany w fazie Fix po nieudanym checku | high |
| `assertions-removed` | w testach więcej usuniętych niż dodanych `expect/assert` | high |
| `test-skipped` | dodane `.skip`, `xit`, `@pytest.mark.skip`, `test.todo` | high |
| `sensitive-path` | ścieżka pasuje do `sensitive` (auth, migracje, CI, sekrety) | high |
| `unchecked-edit` | plik edytowany po ostatnim checku | warn |
| `dependency-change` | nowa/usunięta zależność, zmiana lockfile | warn |
| `public-surface` | route handler, eksport z `index.ts`, schemat API | warn |
| `config-change` | tsconfig, lint, bundler, CI | info |
| `large-change` | > 300 zmienionych linii w pliku | info |

Rekomendacja promptu: jakiekolwiek `high` → **Read flagged** (lub **Read all**, gdy
`high` ≥ 3); tylko `warn`/`info` → **Skim**.

### 9.8 Beaty dla „Play the change"

- Kolejność = moment pierwszej edycji pliku w turze; potem zdarzenia checków.
- Typy beatów: plik dodany / zmieniony / usunięty, nowa krawędź importu, nowa paczka,
  check failed / passed, fix.
- Tekst techniczny z szablonu (`contact.test.ts now imports route.ts`);
  `caption` + `detail` ludzkim językiem z LLM (opcjonalnie).

### 9.9 Layout izometryczny

1. Dla każdej warstwy osobny layout 2D w kwadracie [0,1]² (d3-force z kolizją,
   grupowanie po katalogu; deterministyczny seed → stabilny obraz między renderami).
2. Projekcja izometryczna: `x' = (x − y)·cos30°·W`, `y' = (x + y)·sin30°·H + layer·gap`.
3. Płaszczyzny = równoległoboki SVG; etykiety plików jako tekst „billboard"
   (nie skośny); krawędzie między warstwami = krzywe Béziera.
4. Pan/zoom (d3-zoom), focus po kliknięciu, filtry warstw.
5. Budżet: ≤ 300 węzłów płynnie w SVG; powyżej zwijanie katalogów do węzłów-grup.
6. Fallback dostępności: widok listy (tabela pliki/warstwy/krawędzie) dla czytników ekranu.

Bez WebGL/three.js w MVP — SVG daje ostre etykiety, prosty eksport i dostępność.

## 10. Warstwa LLM (opcjonalna)

Wszystko w sekcjach 5–9 działa **bez LLM** (tytuły i podpisy z szablonów).
LLM poprawia tylko teksty: tytuł promptu w jednym zdaniu, tytuły kroków, headline,
podpisy beatów.

| Backend | Jak | Plusy | Minusy |
|---|---|---|---|
| `claude-cli` (domyślny, gdy `claude` w PATH) | `claude -p --json-schema <schema> --output-format json --no-session-persistence --tools ""` | zero konfiguracji, subskrypcja usera, dane trafiają do tego samego dostawcy co sesja | wolniejszy start procesu; zużywa limit subskrypcji |
| `anthropic-api` | `@anthropic-ai/sdk`: `client.messages.parse({ output_config: { format: zodOutputFormat(Schema) } })` | szybki, równoległy, Batch API dla backfillu (−50%) | wymaga klucza / `ant auth login` |

- `--no-session-persistence` jest **kluczowe**: inaczej każde podsumowanie
  tworzyłoby nową sesję w `~/.claude/projects` i zaśmiecało listę.
- Wejście do modelu = **skondensowana** tura (akcje, ścieżki, statystyki, excerpty,
  cytaty agenta), nie całe pliki; przed wysłaniem redakcja sekretów (12).
- Model konfigurowalny (`--model`). Propozycja domyślna: `claude-opus-5-5` z
  `effort: "low"`; dla dużych backfilli rozważyć `claude-haiku-5-5`
  ($0.10 / $0.50 za MTok vs $4 / $20) — **decyzja do podjęcia w planie fazy LLM**.
- Cache lokalny: klucz = hash(tura + wersja promptu + model) → ponowne otwarcie
  sesji nic nie kosztuje.
- Jeden request na turę (wszystkie teksty tury naraz w jednym obiekcie JSON).

## 11. CLI i dystrybucja

```
npx strata                      # = strata serve: UI dla sesji bieżącego repo, otwiera przeglądarkę
strata list [--all]             # tabela sesji/promptów w terminalu (statusy, czasy)
strata inspect <session> --json # Story JSON na stdout (debug, integracje)
strata export <session> -o report.html [--no-redact]
strata summary <session> --md   # markdown do opisu PR
strata serve --watch            # live: odświeżanie przy dopisaniu do JSONL (SSE)
strata summarize <session>      # wymuszenie warstwy LLM
```

- Node ≥ 22 LTS; jeden pakiet npm z prebuildem UI.
- Później: plugin Claude Code (slash command `/strata` → eksport bieżącej sesji
  i otwarcie; hook `Stop` → odświeżenie raportu), GitHub: `strata pr` (komentarz
  z podsumowaniem przez `gh`).

## 12. Prywatność i bezpieczeństwo

- **Local-first**: brak kont, chmury, telemetrii. Serwer tylko na `127.0.0.1`,
  losowy token w URL + walidacja nagłówka `Host` (ochrona przed DNS rebinding —
  inna strona w przeglądarce nie odczyta sesji).
- API serwera zwraca tylko sesje z katalogu logów (bez ścieżek z requestu → brak
  path traversal).
- **Treść logów = niezaufane dane** (prompt injection, HTML w outputach): render
  wyłącznie jako tekst / sanitizowany markdown, zero `dangerouslySetInnerHTML`.
  Eksport HTML z restrykcyjnym CSP.
- **Redakcja sekretów** w eksporcie i w payloadzie LLM: klucze `sk-ant-…`, `sk-…`,
  `ghp_…`/`github_pat_…`, AWS `AKIA…`, JWT, klucze prywatne PEM, linie
  `*_TOKEN=`/`*_SECRET=`/`PASSWORD=`; raport redakcji + flaga `--no-redact`.
- LLM tylko opt-in, z jawną informacją, dokąd idą dane.

## 13. Open source

- **Licencja**: MIT (najprostsza adopcja) — alternatywa Apache-2.0, jeśli zależy
  nam na klauzuli patentowej. Propozycja: MIT.
- **Repo**: `README` (GIF z demem, quickstart `npx strata`), `CONTRIBUTING`,
  `CODE_OF_CONDUCT`, `SECURITY.md` (zgłaszanie podatności), szablony issue/PR,
  `docs/` (schemat `Story`, pisanie adaptera, pisanie presetu).
- **Punkty rozszerzeń dla społeczności** (to buduje kontrybucje):
  1. adaptery agentów (Codex, Gemini, Grok, OpenCode, Cursor),
  2. presety warstw (Rails, Laravel, Django, Spring…),
  3. ekstraktory importów (Python, Go, Rust…),
  4. reguły hints.
- **Fixture'y demo**: przykładowe repo `examples/storefront` + nagrane prawdziwe
  sesje Claude Code odtwarzające scenariusze ze screenów (rate limiting z fail→fix,
  rename z brakującymi importami, niezweryfikowane edycje, czysty prompt). Licencja
  nasza, zero danych prywatnych. Służą jako testy kontraktowe i jako **demo na
  GitHub Pages** (statyczny eksport — „zobacz bez instalowania").
- **Release**: changesets + GitHub Actions, npm publish z provenance, semver;
  schemat `Story` wersjonowany osobno.
- **Nazwa**: `strata` na npm jest zajęte → `@<org>/strata` albo nazwa alternatywna
  (wolne na npm 2026-10-22: `agentstrata`, `tracemap`, `reviewtrail`, `sessionlens`,
  `changestory`). Sprawdzić GitHub + znaki towarowe przed publikacją.

## 14. Konkurencja i pozycjonowanie

Stan na 2026-10-22, research Grok (web + GitHub + X) + `npm view`. Liczby gwiazdek
przybliżone — zweryfikować przed publikacją README.

### 14.1 Przeglądarki / analityka sesji agentów

| Narzędzie | Licencja | Co robi | Czego brakuje vs Strata |
|---|---|---|---|
| [vibe-replay](https://github.com/tuo-lei/vibe-replay) | — | interaktywny replay sesji wielu agentów, eksport HTML | **najbliższy konkurent**; brak statusów weryfikacji, faz czasu, mapy importów |
| [agent-replay](https://github.com/mttetc/agent-replay) (npm) | — | „DevTools" do sesji Claude Code i Cursor, oś czasu | timeline narzędzi, bez warstwy review |
| [agent-debrief](https://github.com/kalynnka/agent-debrief) (npm) | — | snapshot po każdej turze, diff turn-over-turn, komentarze do linii | review diffów per tura; bez narracji, statusów, mapy |
| [hindcast](https://github.com/karanb192/hindcast) | MIT | Mac: suwak osi czasu, resume, koszt (Claude) | brak mapy i statusów |
| [claude-code-log](https://github.com/daaain/claude-code-log) | MIT | JSONL → HTML/Markdown, TUI, watch | transkrypt, nie historia zmian |
| [claude-code-transcripts](https://github.com/simonw/claude-code-transcripts) | Apache-2.0 | publikacja transkryptów jako HTML | j.w. |
| [Sessions Viewer](https://github.com/jerrywu001/cc-sessions-viewer) | MIT | desktopowy czytnik sesji 7 agentów (w tym Grok, Antigravity), wyszukiwanie | czytnik, bez analizy |
| [ccusage](https://github.com/ccusage/ccusage) | MIT | tokeny / koszt wielu agentów | tylko koszty |
| [sniffly](https://github.com/chiphuyen/sniffly) | MIT | dashboard użycia/błędów | nieaktywny ~1 rok |
| [opcode](https://github.com/winfunc/opcode) | AGPL-3.0 | GUI do prowadzenia sesji, checkpointy | narzędzie operatora, nie reviewera |
| [vibe-log-cli](https://github.com/vibe-log/vibe-log-cli) | MIT | raporty produktywności / standupy | j.w. |
| [claude-trace](https://github.com/badlogic/lemmy/blob/main/apps/claude-trace/README.md) | — | przechwytuje ruch API | surowy ruch |
| [agent-dump](https://agent-dump.xingkaixin.me/) | — | eksport/wyszukiwanie 16+ formatów agentów | CLI dump; **ciekawe źródło wiedzy o formatach** |

### 14.2 Wizualizacja PR / repo

| Narzędzie | Status | Uwagi |
|---|---|---|
| [CodeSee Review Maps](https://docs.codesee.io/docs/user-guide) | zamknięte 2024, kupione przez GitKraken; Codemaps „coming soon" | najbliższe koncepcyjnie mapie importów PR — **nisza pusta** |
| [CodeRabbit walkthroughs](https://docs.coderabbit.ai/pr-reviews/walkthroughs) | komercyjny | warstwowe walkthroughy PR (od 2026-05), ale z gita, nie z logu sesji |
| [Graphite](https://graphite.com/docs/review-pull-requests) | komercyjny | stacked PR + komentarze AI |
| [Alokai AI review](https://docs.alokai.com/ai-coding-support/ai-review) | komercyjny | bot review PR w CI |
| [git-truck](https://github.com/git-truck/git-truck), [Gource](https://gource.io) | MIT / GPL-3 | wizualizacja historii repo, nie zmiany |

### 14.3 Pozycjonowanie

Nikt nie łączy w jednym narzędziu: **statusu weryfikacji per prompt + podziału czasu
na fazy + warstwowej mapy importów + odtworzenia zmiany z podpisami — wyliczonych
z logu sesji agenta**. Przeglądarki sesji pokazują *co agent pisał*; narzędzia PR
pokazują *stan końcowy*. Strata pokazuje *czy zmiana jest zweryfikowana i gdzie
patrzeć*.

Hasło robocze: **„Review the story, not the diff."**

Ryzyko: vibe-replay może pójść w tę stronę — przewagą ma być reguła domenowa
(statusy + hints), nie sam replay. Przed startem warto przejrzeć vibe-replay
i agent-debrief (licencje, architektura, czy da się współpracować zamiast dublować).

### 14.4 Formaty sesji innych agentów (dla przyszłych adapterów)

| Agent | Lokalizacja | Format | Oficjalna dokumentacja |
|---|---|---|---|
| Claude Code | `~/.claude/projects/<cwd>/<id>.jsonl`, `subagents/`, `tool-results/`, `~/.claude/file-history/` | JSONL, schemat nieoficjalny | [claude-directory](https://code.claude.com/docs/en/claude-directory) |
| Codex CLI | `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` | JSONL (`session_meta`, `event_msg`, `response_item`…) | [features](https://developers.openai.com/codex/cli/features/) (tylko ścieżka) |
| Gemini CLI | `~/.gemini/tmp/<hash>/chats/` | JSON/JSONL | [session-management](https://geminicli.com/docs/cli/session-management/) |
| Grok Build | `~/.grok/sessions/<id>/` (`updates.jsonl`, `chat_history.jsonl`, `rewind_points.jsonl`, `subagents/`) | JSONL (zdarzenia ACP) | [sessions](https://x.ai/docs/build/features/sessions) |
| OpenCode | `~/.local/share/opencode/opencode.db` | SQLite | brak gwarancji schematu |
| Cursor CLI | `~/.cursor/projects/<p>/agent-transcripts/` | JSONL, nieudokumentowane | brak |

## 15. Zakres

### MVP (v0.1) — propozycja

1. Adapter Claude Code + `Story` + statusy + fazy + czas (sekcje 9.1–9.4).
2. `strata list` (terminal) i `strata serve` z L0 + L1 + Steps + Diff.
3. Map: warstwy izometryczne + graf importów TS/JS + presety `nextjs`, `vite-react`,
   `node-api`, `generic`.
4. Review hints (reguły z 9.7).
5. `strata export` (jeden HTML z redakcją) + lokalne archiwum `Story` w `~/.strata/`
   (przeżywa 30-dniowe czyszczenie logów Claude Code).

### v0.2

Play the change; warstwa LLM (tytuły, podpisy); Python (importy + preset Django);
live `--watch`; `strata summary --md`; demo na GitHub Pages.

### Później

Adaptery innych agentów; plugin Claude Code; `strata pr`; „partially checked";
widok zespołowy / statystyki (gdzie agent traci czas); rozszerzenie VS Code.

### Non-goals (propozycja)

- **Nie** jest botem oceniającym poprawność kodu (nie zastępuje testów ani review AI)
  — pokazuje, co się stało i gdzie patrzeć.
- **Nie** zastępuje PR/diffa na GitHubie — prowadzi do niego.
- **Nie** hostujemy niczego (SaaS, konta, sync) — local-first.
- **Nie** edytuje kodu ani nie steruje agentem.
- **Nie** pełny 3D (WebGL) — 2.5D w SVG wystarcza.
- **Nie** wspieramy innych agentów niż Claude Code w MVP.

### Kryteria sukcesu (propozycja)

- **Primary**: dla prawdziwej, godzinnej sesji Claude Code właściciel w < 2 min
  (bez otwierania diffa) wskazuje wszystkie prompty `unchecked`/`failing`
  i pliki do przeczytania; status zgadza się z ręczną weryfikacją w ≥ 95% tur
  na korpusie fixture'ów.
- **Secondary**: 3 zewnętrznych kontrybutorów (np. adapter/preset) w 3 miesiące
  od publicznego wydania.
- **Guardrails**: żaden sekret z fixture'ów testowych nie przecieka do eksportu;
  parser nie pada na nieznanych rekordach (pomija + ostrzega); sesja 20 MB JSONL
  otwiera się w < 3 s.

## 16. Ryzyka i otwarte pytania

| # | Ryzyko / pytanie | Mitigacja / kto decyduje |
|---|---|---|
| 1 | Format JSONL Claude Code zmienia się bez zapowiedzi | tolerancyjny parser (nieznane pola/rekordy pomijane), korpus fixture'ów z wielu wersji, adapter wersjonowany po `version`; obserwacja changelogu |
| 2 | Czasy faz są przybliżone (różnice timestampów) | uczciwy opis w UI („approx."); proporcje ważniejsze niż sekundy |
| 3 | Detekcja checków po komendach zawodzi (własne skrypty) | konfigurowalne wzorce + auto-wykrycie skryptów `test`/`check` z `package.json` |
| 4 | Graf importów niepełny (aliasy, monorepo, dynamiczne importy) | resolver z `tsconfig`, oznaczenie „unresolved"; graf to wskazówka, nie dowód |
| 5 | Duże sesje (tysiące akcji) | streaming parsera, wirtualizacja list, zwijanie węzłów |
| 6 | Wyciek sekretów przy udostępnianiu eksportu | redakcja domyślnie włączona, ostrzeżenie przed eksportem, testy na fixture'ach z fałszywymi sekretami |
| 6a | Claude Code kasuje logi po 30 dniach — review „sprzed miesiąca" znika | lokalne archiwum `Story` w `~/.strata/` + eksport; info w README o `cleanupPeriodDays` |
| 6b | Konkurent (vibe-replay) dobuduje statusy/mapę | szybkie MVP z regułą domenową jako wyróżnikiem; rozważyć współpracę |
| 7 | Nazwa projektu | **user** — przed publikacją repo |
| 8 | Licencja MIT vs Apache-2.0 | **user** |
| 9 | Domyślny model LLM i backend | **user**, w planie fazy LLM |
| 10 | Czy MVP obejmuje Python (projekt wdAir to Django) | **user** w /10x-shape — wpływa na zakres MVP |
| 11 | Ile czasu tygodniowo (after-hours?) → realny horyzont MVP | **user** w /10x-shape |

## 17. Roadmapa (draft)

Draft dla `/10x-roadmap` (skill i tak sam zdekomponuje i zsekwencjonuje — to jest
punkt startowy). Każdy slice jest pionowy: kończy się czymś, co da się uruchomić.

| ID | Slice | Wynik widoczny dla usera | Zależy od | Równolegle z |
|---|---|---|---|---|
| F-01 | Fundament repo | monorepo, CI, lint, schemat `Story` v1, fixture'y demo | — | — |
| S-01 | Parser + statusy w terminalu | `strata list` pokazuje prompty, statusy, czasy, pliki dla prawdziwej sesji | F-01 | — |
| S-02 | Web: sesje i prompty (L0/L1) | `strata serve` → ekran jak S1 | S-01 | — |
| S-03 | Steps + Diff (L2/L3) | ekran jak S2, klik w plik → diff | S-02 | S-04 |
| S-04 | Map v1: warstwy + graf TS/JS | mapa izometryczna jak S3, filtry, focus | S-02 | S-03 |
| S-05 | Review hints | flagi na mapie, „Where to look", rekomendacja | S-03, S-04 | — |
| S-06 | Eksport HTML + redakcja | `strata export` → plik do załączenia do PR | S-03 | S-05 |
| — | **MVP v0.1 / publiczne repo** | README, npm publish | S-01…S-06 | — |
| S-07 | Play the change | ekran jak S4 | S-04 | S-08 |
| S-08 | Warstwa LLM | tytuły/podpisy jak na screenach | S-03 | S-07 |
| S-09 | Python + preset Django | mapa dla projektów Python | S-04 | S-07/S-08 |
| S-10 | Live `--watch` + `summary --md` + demo Pages | — | S-06 | — |

## 18. Realizacja w 10xDevs

Proces zgodny z `CLAUDE.md` i zainstalowanymi skillami (`~/.claude/skills/10x-*`).

### 18.1 Fundament (raz)

```bash
# 1. Nowe repo — NIE w folderze z materiałami kursu
mkdir -p ~/git/strata && cd ~/git/strata && git init
mkdir docs && cp ~/git/CodeReviewer/docs/PROPOSAL.md docs/
```

W Claude Code, w `~/git/strata`:

1. `/10x-init` — szkielet `context/`.
2. `/10x-shape @docs/PROPOSAL.md` — tryb greenfield; skill przeprowadzi przez fazy
   i **potwierdzi każdą propozycję z tego dokumentu** (persona, MVP flow, FR-y,
   reguła domenowa, non-goals). Odpowiedzi na pytania 7–11 z sekcji 16 przygotuj
   wcześniej.
3. `/10x-prd` — `context/foundation/prd.md`.
4. `/10x-tech-stack-selector` — wejście: sekcja „Forward: tech-stack" poniżej.
   Spodziewany wynik: TypeScript, Vite + React dla web, monorepo (pnpm workspaces /
   Turborepo z rejestru starterów).
5. `/10x-bootstrapper` — scaffold.
6. `/10x-agents-md` (opcjonalnie) — onboarding dla agentów.
7. `/10x-roadmap` — `context/foundation/roadmap.md` (draft z sekcji 17 jako wejście).

### 18.2 Każdy slice

```
/10x-new <change-id>                 # np. s01-parser-statuses
/10x-plan                            # czytaj context/foundation/lessons.md
/10x-plan-review                     # inny model niż autor planu — bramka akceptu
/10x-implement <change-id> phase <n> # jedna faza = jeden brief
/10x-impl-review                     # nigdy ten sam model co autor kodu
<testy repo zielone>
/10x-archive
```

Routing workerów (wg `CLAUDE.md`, sprawdź quotę przed każdym):

| Krok | Worker |
|---|---|
| research formatów logów, API bibliotek, „co jest aktualne" | Grok 4.6, effort high |
| skan dużych plików JSONL / wielu sesji, porównanie spec vs kod | agy Flash |
| implementacja fazy | Grok 4.6, effort medium, worktree `../strata-<change-id>`, gałąź `change/<change-id>` |
| impl-review po Groku | Claude albo agy Pro (nigdy Grok po Groku) |
| spec, architektura, merge, archive | Claude |

Równoległość: S-03 ‖ S-04 i S-07 ‖ S-08 — maksymalnie 2 worktree naraz
(limit = przepustowość review jednej osoby).

### 18.3 Forward: tech-stack (informacyjnie, nie do PRD)

- Język: TypeScript wszędzie (wspólny schemat zod dla core i web).
- Runtime CLI: Node ≥ 22 LTS; dystrybucja npm (`npx`).
- Web: Vite + React; SVG + d3-force/d3-zoom/d3-shape; diff: komponent oparty
  o Shiki lub gotowa biblioteka diff-view; Tailwind.
- Importy TS/JS: parser oxc (`oxc-parser`) lub `es-module-lexer` + `oxc-resolver`
  / `enhanced-resolve` dla aliasów.
- Monorepo: pnpm workspaces (+ Turborepo, jeśli selektor to potwierdzi).
- Testy: golden tests na fixture'ach (JSONL → `Story` snapshot), testy komponentów
  UI na `Story` fixture'ach.
- LLM: `@anthropic-ai/sdk` (`messages.parse` + `zodOutputFormat`) i backend
  `claude -p`.

### 18.4 Forward: technical-roadmap (informacyjnie)

- Spike na start S-01: przegląd 10–20 własnych sesji (różne wersje Claude Code,
  subagenty, kompaktowanie, przerwania) → lista przypadków brzegowych do planu.
- Fixture'y: zanonimizowane wycinki własnych sesji + nagrane sesje na
  `examples/storefront`.

## 19. Mapowanie na PRD

| Sekcja PRD (greenfield) | Źródło w tym dokumencie |
|---|---|
| Vision & Problem Statement | 2 |
| User & Persona | 3 |
| Success Criteria | 15 → „Kryteria sukcesu" |
| User Stories | 5 (do sformułowania w /10x-shape jako US-01…) |
| Functional Requirements | 5 + 15 MVP (do sformułowania jako FR-NNN) |
| Non-Functional Requirements | 12, 15 Guardrails, 16 (wydajność) |
| Business Logic | 6 |
| Access Control | „Pojedynczy użytkownik, brak auth, dane lokalne; serwer tylko localhost z tokenem" |
| Non-Goals | 15 → Non-goals |
| Open Questions | 16 (pozycje 7–11) |

Frontmatter (propozycja): `product_type: cli` (z lokalnym UI web),
`target_scale.users: large` (publiczne OSS) — do potwierdzenia,
`timeline_budget`: do ustalenia w /10x-shape.
