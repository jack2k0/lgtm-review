# Audyt dokladnosci statusow po S-12 (subagenci scalani w prompty rodzica)

Data: 2026-10-23. Kod: worktree `lgtm-review-subagent-prompts` (HEAD 493a029, `pnpm build` swiezy; `node packages/cli/dist/cli.js --dir <p> --list --json`
dla 5 projektow). Metodologia jak w `status-audit-after.md`: wlasny ekstraktor Pythona z surowego JSONL, parowanie po `tool_use_id`, wlasny klasyfikator
checkow, prawda git-aware (strict obok). Sesja biezaca (a7f5884a) pominieta. Skrypty (kopie): `s12/extract2.py`, `extract3.py` (NOWY: transkrypty
subagentow), `truth2.py`, `truth3.py`, `truth4.py` (NOWY: scalanie), `final4.py`, `report4.py`; wyniki `s12/final4.json`, `s12/out3/*.json`.
Bez tresci promptow i prywatnych sciezek.

## Prawda z subagentami (niezalezna od kodu narzedzia)
- Agent call -> `<sessionId>/subagents/agent-*.meta.json.toolUseId` -> `agent-*.jsonl`; rekurencja do glebokosci 3 (zagniezdzone Agent w transkrypcie).
- Dla kazdego watku (rodzic, subagent) ten sam budowniczy zdarzen co dla A (edycje Edit/Write, edycje Bash wlasnym detektorem, git-aware, maskowany exit
  z dowodem tekstowym, kolejnosc wewnatrz jednej komendy). Watki sa liczone niezaleznie, potem scalane: zdarzenie subagenta trafia po ostatnim
  zdarzeniu rodzica z timestampem <= wlasnemu (rodzic zachowuje swoja kolejnosc, bo jego timestampy sa niemonotoniczne), pozniejsze na koniec.
- Zakres: 32 sesje, 100 plikow subagentow; wszystkie 22 prompty z `Agent` maja co najmniej jeden transkrypt (jeden prompt ma 1 z 8 agentow bez
  transkryptu; narzedzie ustawia dla niego `partial` + "subagent activity not analysed" - zgodne, i tylko dla niego).
- Narzedzie wypisuje 131 promptow; 127 po odjeciu biezacej sesji (jak poprzednio). 15 duplikatow fork/resume nadal w obu sesjach.

## Wyniki (prawda git-aware, nagłowkowa; strict w nawiasie)

| Populacja | status | reason |
|---|---|---|
| **(A)** bez wywolan Agent, wiersze (n=105) | **102/105 = 97,1%** (strict 87,6%) | 102/105 = 97,1% |
| A, unikalne uuid (n=90) | 87/90 = 96,7% | 87/90 = 96,7% |
| **(B)** wszystkie, wiersze (n=127) | **121/127 = 95,3%** (strict 87,4%) | 120/127 = 94,5% |
| B, unikalne uuid (n=112) | 106/112 = 94,6% | 105/112 = 93,8% |
| **(C)** tylko z Agent (n=22, wszystkie unikalne) | **19/22 = 86,4%** | 18/22 = 81,8% |

(C) poprzednio 9/22 poprawnych (poprzednia, przyblizona prawda subagentow); teraz 19/22. Uczciwy kontrolny wiersz: stare narzedzie (out2) oceniane NOWA prawda
daje w C 17/22, wiec czesc skoku to lepsza prawda, a nie samo narzedzie (+2 prompty). B poprzednio 94,5% -> 95,3%.
Strict (git-merge/rebase = edycja): A 87,6% bez zmian, B 87,4%, C 19/22 (wynik C nie zalezy od wariantu).
Czulosc na kolejnosc edycji/checka wewnatrz jednej komendy (variant "before"): C 19/22 bez zmian.

## Niezgodnosci - kategorie przyczyn

A (3 prompty, bez zmian wzgledem poprzedniego audytu - nie ma regresji):
1. Kolejnosc edycja-check w jednej komendzie Bash (edycje tekstowe `cat >` PRZED checkiem uznane za "po"): 2 prompty, narzedzie unchecked, prawda checked.
2. Edycja `sed -i` po checku w jednej komendzie (grupa `( )`/lancuch z git merge/mv) niewykryta: 1 prompt, narzedzie checked, prawda unchecked.

C (3 niezgodnosci statusu, wszystkie narzedzie checked, prawda unchecked; wszystkie tej samej przyczyny):
3. Edycje shellowe w jednej komendzie razem z `git commit` (zamykanie zmiany: `git merge`, `git mv`, `sed -i "s/^status: .*/status: archived/"`,
   `python3 -c` zapis pliku, `printf >>`, potem `git add -A; git commit`) wykonane PO checku (check we wlasnym kroku lub w subagencie). `bashEditDiff` w logu jest
   pusty (zmiany zostaly zacommitowane w tej samej komendzie), a narzedzie ufa pustemu diffowi i nie liczy komendy jako edycji
   (`analyze.ts`: warunek `bashEditDiff.length > 0`). Brak bledu scalania subagentow; to samo zachowanie bylo przyczyna kat. 2 w A (prawdopodobnie, nie weryfikowane).
   Dotyczy 3 z 22 promptow z Agent (w jednej sesji orkiestracyjnej).
4. Reason w C (dodatkowa 1 niezgodnosc przy zgodnym statusie): narzedzie "no checks ran" vs prawda "edits after last check" (check
   w wyniku bez dopasowanego wzorca po stronie narzedzia lub roznica klasyfikacji checka; 1 prompt, status unchecked zgodny).

Sprawdzone i poprawne (bez niezgodnosci): flaga `partial` (1/1 trafnie, tylko przy braku transkryptu), sufiks reason "(by subagent ...)", edycje subagentow po checku rodzica
-> unchecked (zgodne), check subagenta po edycjach rodzica -> checked (zgodne), `check did not complete` dla bg checkow subagentow (2/2).

## Top-3 pozostale kategorie
1. Edycje shellowe zacommitowane w tej samej komendzie (pusty `bashEditDiff`): 3 w C + prawdopodobnie 1 w A.
2. Kolejnosc edycja/check wewnatrz jednej komendy Bash (tekstowe `cat >` przed checkiem): 2 w A.
3. Rozniaca sie reason przy zgodnym statusie (narzedzie "no checks ran" vs prawda "edits after last check"): 1 w C.

## Cele
- (A) >= 97,1%: osiagniety (97,1%, bez regresji).
- (B) >= 96%: NIE osiagniety: 95,3% wiersze / 94,6% unikalne (6 niezgodnosci: 3 A + 3 C). Poza kat. 3 (3 prompty) bylby 98,0%.
- (C): 19/22 (z 9/22).
- Reason: A 97,1%, B 94,5% (cel >= 88%: osiagniety).

## Czas `--list --json` (5 powtorzen, ten sam komputer, cieply cache)
Przed = 4a62bd0 zbudowany z `git archive` (kopia w scratchpadzie), po = 493a029.
| Projekt | rozmiar logow | pliki subagentow | przed | po |
|---|---|---|---|---|
| najwiekszy w bajtach (147 MB, 18 sesji) | 147 MB | 0 | 0,60-0,70 s (mediana 0,61) | 0,66-0,67 s (mediana 0,66), +8% |
| z subagentami (108 MB) | 108 MB | 100 | 0,22-0,23 s | 0,76-0,79 s (mediana 0,77), x3,4 |
Pamiec szczytowa: 140 -> 148 MB oraz 101 -> 170 MB. Wyjscie JSON projektu bez subagentow bajt-w-bajt tej samej dlugosci (256419 B).
Wniosek: koszt scalania jest proporcjonalny do liczby transkryptow subagentow (ok. +0,55 s na 100 plikow), bez wplywu na projekty bez nich.

## Zastrzezenia
- Mala populacja (22 prompty z Agent z jednej-dwoch sesji orkiestracji; 3 niezgodnosci pochodza z jednego wzorca w jednej sesji, wiec CI szeroki).
- Prawda w C opiera sie na kolejnosci timestampow (jak narzedzie); nie sprawdza wielosciezkowych przeplotow rownoleglych agentow.
- Brak danych JS/TS w logach: te wzorce nadal niezweryfikowane na realnych danych.
- `s12/events2.json`, `s12/final4.json` zawieraja surowe komendy uzytkownika - nie publikowac.
