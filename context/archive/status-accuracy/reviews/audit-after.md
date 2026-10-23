# Ponowny audyt dokladnosci statusow lgtm-review (po status-accuracy)

Data: 2026-10-23. Kod: worktree `lgtm-review-status-accuracy` (HEAD c68079a, dist zbudowany; `--dir <p> --list --json` dla 5 projektow).
Metodologia jak w `status-audit.md`: wlasny ekstraktor Pythona z surowego JSONL (`extract2.py`), parowanie po `tool_use_id`, kolejnosc po
pozycji wyniku w pliku, wlasny klasyfikator checkow (`truth2.py`), prawda wg PRD Business Logic. Bez prompto-tresci i prywatnych sciezek
(tylko wzorce/ksztalty komend). Pominieta sesja biezaca (a7f5884a). Skrypty: `extract2.py`, `truth2.py`, `truth3.py`, `final3.py`,
`report.py`, `diag3.py`, `seg.py` (kopie; oryginaly nietkniete); wyniki `final3.json`, `out2/*.json`.

## 1. Zakres

- 32 pliki sesji (bez biezacej), 100 plikow subagentow. Tury w prawdzie: 130 (= 120 jak poprzednio + 10 nowych tur slash `/goal`, `/usage`,
  `/model`, `/context`; `/clear`, `/exit`, `/compact` pominiete jako nie-prompty). Narzedzie wypisuje 127 promptow (w tym 18 tur slash:
  `/herdr` 8, `/usage` 4, `/loop` 3, `/goal` 3); 3 tury prawdy bez zadnej aktywnosci (`/model`, `/context`) narzedzie slusznie pomija
  (wylaczone z mianownika).
- Populacja A = prompty bez aktywnosci subagentow (zero wywolan `Agent`/`Task`): 105 wierszy (90 unikalnych uuid).
  Populacja B = wszystkie 127 wypisanych (112 unikalnych uuid; 15 duplikatow fork/resume, spojne miedzy soba). W B prawda uwzglednia
  subagentow (kolejnosc po timestampach, jak poprzednio); w B 22 prompty z `Agent`, 21 z logami subagentow.
- Brak danych JS/TS (pnpm/npm/vitest/tsc/cargo/go) w logach: te wzorce nadal NIE sa zweryfikowane na realnych danych.

## 2. Zmiany prawdy wzgledem poprzedniego audytu (jawne, bo wplywaja na liczby)

Poprzednia prawda miala slepe plamy, ktore poprzedni raport sam wymienil jako bledy narzedzia (nowe narzedzie je juz widzi, wiec
doslowna stara prawda karalaby narzedzie za poprawne zachowanie). Rozszerzylem ja NIEZALEZNIE (wlasne regexy Pythona):

1. Edycje Bash: oprocz `bashEditDiff.files != []` licze wlasne wykrycie (`sed -i`, `perl -pi`, `cp/mv` poza scratch, `cat/echo/printf/tee >`
   poza `$S`//tmp, `python - <<` z zapisem pliku, `ruff --fix/format`, operacje git). Scratch = `$S`, `/tmp`, `/dev/null`.
2. Kolejnosc wewnatrz jednej komendy Bash (check i edycja razem): po indeksie segmentu (edycja przed/po ostatnim segmencie checka).
3. Zamaskowany exit: gdy check ma `| tail`/`;`/`||`, exit 0 i w wyniku jest dowod bledu (`N failed`, `exit/check=N`, `BUILD FAILURE`,
   `Tests run: ... Failures: N`, linia `FAILED`), prawda = `failing`. Reczny przeglad: wszystkie 5 takich promptow to prawdziwe "N failed".
4. Operacje git (`merge|rebase|pull|checkout|switch|stash|cherry-pick|mv|reset|restore`): dwa warianty prawdy.
   - **strict** (dokladnie stara definicja): kazda zmiana plikow przez git to edycja;
   - **git-aware** (zgodnie z rekomendacja #10 poprzedniego audytu): komenda, w ktorej jedyne mutacje to operacje git, nie jest edycja
     agenta i nie uniewaznia checka; prompt wylacznie z git = `no-changes`.
   PRD mowi tylko "edits"; nie rozstrzyga operacji git, wiec podaje oba warianty. Wynik NAGLOWKOWY = git-aware, strict podany obok.

Ostrzezenie o korelacji: punkty 1, 3, 4 pokrywaja sie z rekomendacjami, ktore narzedzie zaimplementowalo; implementacja prawdy jest
jednak osobna (Python, wlasny segmenter), a niezgodnosci ponizej rozstrzygalem recznie na surowych komendach.

## 3. Wyniki (zgodnosc narzedzie vs prawda)

| Populacja | prawda git-aware: status | git-aware: reason | prawda strict: status | strict: reason |
|---|---|---|---|---|
| **A** bez subagentow, wiersze (n=105) | **102/105 = 97,1%** | **102/105 = 97,1%** | 92/105 = 87,6% | 92/105 = 87,6% |
| A, unikalne uuid (n=90) | 87/90 = 96,7% | 87/90 = 96,7% | 79/90 = 87,8% | 79/90 = 87,8% |
| **B** wszystkie, wiersze (n=127) | 120/127 = 94,5% | 111/127 = 87,4% | 110/127 = 86,6% | 101/127 = 79,5% |
| B, unikalne uuid (n=112) | 105/112 = 93,8% | 96/112 = 85,7% | 97/112 = 86,6% | 88/112 = 78,6% |

- A, tylko prompty z prawdziwymi zmianami (49): status 46/49 = 93,9% (latwe `no-changes` 56 nie zawyzaja wyniku bardziej niz wczesniej).
- Macierz A (narzedzie -> prawda, git-aware): no-changes/no-changes 56, unchecked/unchecked 28, checked/checked 13, failing/failing 5,
  unchecked->checked 2, checked->unchecked 1. Galaz `failing`, wczesniej bez pokrycia, ma teraz 5 promptow w A (2 pary fork-duplikat + 1),
  wszystkie zgodne z prawda.
- Tury slash (18 wypisanych): status zgodny 17/18 (git-aware); jedyna roznica to prompt z subagentami. Pominiecie slash znikneło
  (poprzednio 11 pominietych tur, 125 plikow doklejonych do cudzego prompta).
- Dedup: 15 duplikatow fork/resume nadal wypisywanych w obu sesjach (statusy identyczne), zadnego bledu statusu z tego powodu.

### Porownanie z poprzednim audytem

| Miara | Poprzednio (stara prawda, 109 wierszy) | Teraz B (127 wierszy, git-aware) | Teraz A |
|---|---|---|---|
| status | 90,8% | 94,5% | 97,1% |
| reason | 76,1% | 87,4% | 97,1% |

Uczciwe porownanie na tej SAMEJ (nowej, szerszej) prawdzie i tych samych 109 promptach obecnych w obu wersjach narzedzia:
stare narzedzie 73,4% (git-aware) / 74,3% (strict) -> nowe 93,6% / 86,2%; na samym A (89 promptow): 70,8% -> 96,6% (git-aware),
71,9% -> 87,6% (strict). Czyli stara liczba 90,8% byla zawyzona przez slepe plamy starej prawdy; realny skok to ok. +20 pp statusu.
Doslowna stara prawda (tylko `bashEditDiff` i kody wyjscia) daje dla nowego narzedzia w A 76,2% - ale ta roznica to dokladnie
niewidoczne edycje Bash i zamaskowane bledy, ktore stary raport uznawal za wady narzedzia.

## 4. Pozostale niezgodnosci - kategorie przyczyn (liczby)

### A, prawda git-aware (3 prompty, status = reason)

| # | Kategoria | Prompty | Kierunek | Ksztalt (anonimowo) |
|---|---|---|---|---|
| 1 | Edycja i check w jednej komendzie Bash: kolejnosc (edycje tekstowo PRZED checkiem uznane za "po") | 2 | narzedzie unchecked, prawda checked | `cat > plik <<EOF; cat > plik2 <<EOF; ./scripts/check.sh 2>&1 | tail -4`; reason "1 edit after last check" / "edit in the same command as the last check" |
| 2 | Edycja PO checku w tej samej komendzie niewykryta (nawias/subshell) | 1 | narzedzie checked, prawda unchecked | `( ... bash scripts/verify-all.sh > log; tail ...; git merge ...; git mv ...; sed -i 's/^status: .*/status: archived/' plik )` - `sed -i` po checku w jednym Bash, w grupie `( )` |

### A, prawda strict (dodatkowo 10 promptow, wszystkie to semantyka operacji git, nie blad detekcji)

| Kategoria | Prompty | Opis |
|---|---|---|
| Prompt tylko z operacjami git: narzedzie `no-changes (git operations only)`, strict liczy edycje | 5 | `git pull`, `git rebase -q main` + bg check, `git merge/checkout --ours` + bg check, `git add/commit` w orkiestracji |
| Merge/rebase po checku nie uniewaznia checka u narzedzia, strict: edycja po checku | 5 | z czego 4 to `failing` (ostatni check z `N failed` w masce `| tail`, potem `git merge/reset` w tym samym prompcie: 2 prompty x 2 duplikaty fork) i 1 `checked` |

Rozstrzygniecie definicji git jest decyzja produktowa; przy strict cel statusu (>=95%) NIE jest osiagniety, przy git-aware tak.

### B (dodatkowo, tylko prompty z subagentami; 22 prompty z `Agent`, 21 z logami subagentow)

| Kategoria | Prompty | Efekt |
|---|---|---|
| Aktywnosc subagentow nieanalizowana (flaga partial, "subagent activity not analysed") | 13 niezgodnosci reason, w tym 4 statusu | 4 statusy: narzedzie unchecked/no-changes, prawda checked (subagent uruchomil check po edycjach) x3; narzedzie checked, prawda unchecked (subagent edytowal po checku) x1; reszta: "no checks ran" vs "N edits after last check"/"check did not complete" |
| Razem B ponad A | 13 z 22 promptow z `Agent` (4 statusu); B: 7 statusow i 16 reason lacznie z 3 z A | oczekiwana luka |
| Duplikaty fork/resume miedzy sesjami (nie blad, zawyzaja liczbe wierszy) | 15 wierszy | statusy spojne, 0 bledow |

Uwaga: prawda z subagentami w B jest przyblizona (kolejnosc po timestampach, bez rozroznienia git-aware w logach subagentow).

## 5. Top pozostale kategorie

1. Subagenci nieanalizowani: 13 promptow (reason) / 4 (status), tylko B; flaga `partial` honestly ostrzega, ale reason bywa zly.
2. Semantyka operacji git (tylko wariant strict): 10 promptow w A; 0 przy git-aware (tu narzedzie przyjelo zalecenie z poprzedniego audytu).
3. Kolejnosc edycji i checka w jednej komendzie Bash: 3 prompty w A (2 narzedzie zbyt konserwatywne, 1 przepuszcza edycje w `( )`).

## 6. Cele

| Cel | Wymog | A git-aware | A strict |
|---|---|---|---|
| status | >=95% | 97,1% osiagniety | 87,6% nieosiagniety |
| reason | >=88% | 97,1% osiagniety | 87,6% (0,4 pp ponizej) |

## 7. Zastrzezenia

- Mala, nietypowa populacja (2 duze projekty, wiele orkiestracji wieloagentowych); 15 duplikatow fork/resume; 4 z 5 `failing` w A to
  dwie pary duplikatow fork. Przedzial ufnosci szeroki (A: 3 bledy na 105).
- Failing z maskowanego exitu opiera sie na dowodzie tekstowym; sonda mutacyjna (celowo czerwony test) bylaby tak samo "failing" w
  obu systemach - prawda tego nie rozroznia.
- Brak wzorcow JS/TS w danych; sciezka `pnpm`/`vitest`/`tsc` nadal tylko z testow jednostkowych.
- `cmds`/`events` w scratchpadzie zawieraja surowe komendy uzytkownika - nie publikowac.
