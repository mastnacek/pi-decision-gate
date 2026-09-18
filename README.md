# 🛡️ pi-decision-gate — Plugin Specification & PRD

Rozšíření (plugin) pro [Pi coding agent](https://pi.dev/) zajišťující **human-in-the-loop schvalování každého rozhodnutí modelu** s jasnou modelovou atribucí, rychlým posouzením rizik přes **TypeSafe Jev** (OpenRouter) a přesným sledováním finanční spotřeby v **českých korunách (Kč)**.

Tento dokument slouží současně jako **uživatelská příručka**, **technická specifikace** a **Product Requirements Document (PRD)** pro případné přepsání, rozšíření či údržbu pluginu.

---

## 📑 Obsah

1. [Vize a cíle produktu (PRD)](#1-vize-a-cíle-produktu-prd)
   - [1.3 Přehled funkcí](#13-přehled-funkcí)
2. [Systémová architektura a toky dat](#2-systémová-architektura-a-toky-dat)
3. [Detailní popis modulů](#3-detailní-popis-modulů)
   - [3.1 `types.ts` — Datové struktury a typy](#31-typests--datové-struktury-a-typy)
   - [3.2 `config.ts` — Konfigurace, perzistence a dokumentace](#32-configts--konfigurace-perzistence-a-dokumentace)
   - [3.3 `gate.ts` — Jádro zachytávání a schvalování akcí](#33-gatets--jádro-zachytávání-a-schvalování-akcí)
   - [3.4 `jev.ts` — Sémantické hodnocení System One (OpenRouter)](#34-jevts--sémantické-hodnocení-system-one-openrouter)
   - [3.5 `models.ts` — Analýza historie sezení a konfigurace](#35-modelsts--analýza-historie-sezení-a-konfigurace)
   - [3.6 `balance.ts` — Směnný kurz ČNB a OpenRouter kredit](#36-balancets--směnný-kurz-čnb-a-openrouter-kredit)
   - [3.7 `status.ts` — Vykreslování statusbaru a nápovědy](#37-statusts--vykreslování-statusbaru-a-nápovědy)
   - [3.8 `index.ts` — Vstupní bod, CLI příkazy a autocompleti](#38-indexts--vstupní-bod-cli-příkazy-a-autocompleti)
   - [3.9 `herdr.ts` — Integrace s Herdr (panes, sub-agenti, delegace)](#39-herdrts--integrace-s-herdr-panes-sub-agenti-delegace)
4. [Funkční požadavky (FR)](#4-funkční-požadavky-fr)
5. [Nefunkční požadavky (NFR)](#5-nefunkční-požadavky-nfr)
6. [Konfigurace a hierarchie nastavení](#6-konfigurace-a-hierarchie-nastavení)
7. [Příkazová řádka a uživatelské rozhraní](#7-příkazová-řádka-a-uživatelské-rozhraní)
8. [Auditní logování (.jsonl)](#8-auditní-logování-jsonl)
9. [Instalace a vývoj](#9-instalace-a-vývoj)

---

## 1. Vize a cíle produktu (PRD)

### 1.1 Problém
Moderní LLM agenti (Pi, Claude Code, Cursor, Codex) provádějí volání nástrojů (spouštění bash příkazů, zápisy a editace souborů, volání externích API) plně autonomně. To přináší:
1. **Riziko nechtěných destruktivních změn:** Přepsání důležitých souborů, `git push --force`, `rm -rf`, nevhodné databázové operace.
2. **Absenci transparentnosti:** Uživatel často neví, jaký model (při přepínání či směrování) akci inicioval a s jakými přesnými argumenty.
3. **Nemožnost rychlého zásahu před provedením:** Běžné systémy buď akci provedou, nebo ji zcela zablokují; chybí možnost argumenty interaktivně upravit.
4. **Netransparentní náklady:** Hodnocení rizik a volání modelů není transparentně účtováno v lokální měně uživatele (CZK).

### 1.2 Řešení
`pi-decision-gate` funguje jako bezpečnostní a rozhodovací mezivrstva v Pi agentu. Předtím, než jakýkoli nástroj provede svou akci, je požadavek zachycen. Plugin:
- Identifikuje navrhující model a úroveň uvažování (`provider/model`, `thinkingLevel`).
- Vyhodnotí riziko pomocí specializovaného rychlého modelu **TypeSafe Jev (System One)** přes OpenRouter (latence ~250 ms, minimální cena).
- Nabídne uživateli interaktivní volbu: **Schválit**, **Schválit + nastavit thinking**, **Upravit argumenty v editoru**, **Přepnout model**, **Spustit v izolovaném okně (Herdr)**, **Odmítnout** nebo **Osvobodit nástroj pro zbytek sezení**.
- V patičce agenta (statusline) trvale zobrazuje aktivní režim, počet schválených/zamítnutých akcí a celkové náklady sezení v **Kč** podle denního kurzu ČNB.

### 1.3 Přehled funkcí

#### Bezpečnostní brána
- Zachytává každý `tool_call` před provedením (human-in-the-loop schvalování).
- 4 režimy schvalování: `always`, `risky`, `destructive`, `off`.
- Nastavitelný práh rizika (0.0–1.0) pro režim `risky`.
- Trvalé (`exemptTools`) i dočasné (`sessionExemptions`) výjimky nástrojů.
- Headless fallback: bez TUI se akce propustí dle konfigurace, plugin nikdy nezablokuje neinteraktivní běh.

#### Hodnocení rizik (Jev System One)
- Sémantické posouzení akce modelem **TypeSafe Jev** přes OpenRouter Decisions API (7 paralelních otázek).
- Offline regex heuristika jako pojistka při výpadku (`rm -rf`, `git reset --hard`, `git push --force`, `drop table`, …).
- Detekce citlivých dat (API klíče, tokeny, privátní klíče, hesla) — takový payload se nikdy neodesílá na externí API a vyhodnotí se lokálně.

#### Schvalovací dialog
- Atribuce modelu (provider/model + úroveň thinking).
- Skóre rizika, kategorie, pravděpodobnost nevratnosti a cena posouzení v Kč.
- Syntax-highlightovaný náhled argumentů (barvy Eldritch).
- Doporučení úrovně thinking + doporučení Herdr okna.
- Akce: Schválit · Schválit + thinking · Upravit argumenty · Přepnout model · Změnit thinking · Spustit v novém okně (Herdr) · Odmítnout · Osvobodit pro sezení.

#### Modelové statistiky a routing
- Přehled modelů používaných za posledních 7 dní (`/gate models`).
- Skóre vhodnosti modelů (45–99 %) včetně penalizace za ztrátu prompt cache.
- Přepnutí modelu přímo ze schvalovacího dialogu a opakování tahu.

#### Herdr integrace
- Rozdělení okna a spuštění sub-agenta v izolovaném pane.
- Delegace destruktivních, dlouhotrvajících či autonomních úkolů mimo hlavní relaci.

#### Finance a audit
- Spotřeba sezení na Jev v Kč (kurz ČNB s fallbackem na ECB).
- Zůstatek kreditu OpenRouteru (`/gate balance`).
- Auditní log rozhodnutí do `.pi/decision-gate/decisions.jsonl`.
- Statusline s režimem, modelem, počty ✓/✗ a náklady.

#### Konfigurace
- Kaskádová konfigurace: výchozí → globální → projektová.
- `/gate` i `/decision-gate` s víceúrovňovým našeptáváním a českou nápovědou.

---

## 2. Systémová architektura a toky dat

### 2.1 Diagram toku rozhodování (`tool_call`)

```text
[LLM Agent navrhuje tool_call]
             │
             ▼
    ┌─────────────────┐
    │  pi-decision-   │
    │      gate       │
    └────────┬────────┘
             │
             ├─► Je brána vypnuta nebo nástroj v exemptTools / sessionExemptions?
             │       ├─ ANO ──► [Tool se ihned spustí bez dotazu]
             │       └─ NE  ──► Pokračovat
             │
             ▼
    ┌──────────────────────────────────────────────┐
    │  Detekce modelu + Paralelní hodnocení rizik  │
    │  - ctx.model & ctx.thinkingLevel             │
    │  - Heuristika vzorů (rm, reset, drop...)     │
    │  - Volání Jev přes OpenRouter Decisions API  │
    └──────────────────────┬───────────────────────┘
                           │
                           ▼
    ┌──────────────────────────────────────────────┐
    │     Vyhodnocení režimu (mode evaluation)     │
    │  - always:      Vždy vyžaduje potvrzení      │
    │  - risky:       Vyžaduje potvrzení při ≥ práh│
    │  - destructive: Vyžaduje potvrzení u destr.  │
    │  - off:         Propustí bez dotazu          │
    └──────────────────────┬───────────────────────┘
                           │
             ┌─────────────┴─────────────┐
             ▼                           ▼
      [Není třeba schválit]       [Vyžaduje schválení]
             │                           │
             │                           ▼
             │               ┌───────────────────────┐
             │               │ ctx.ui.select Dialog: │
             │               │ - Model attribution   │
             │               │ - Risk score & CZK    │
             │               │ - Arguments preview   │
             │               └───────────┬───────────┘
             │                           │
             │       ┌───────────────────┼────────────────────┐
             │       ▼                   ▼                    ▼
             │  [ Schválit ]     [ Upravit argumenty ]   [ Odmítnout ]
             │       │                   │                    │
             │       │                   ▼                    │
             │       │          ┌─────────────────┐           │
             │       │          │  ctx.ui.editor  │           │
             │       │          │ (úprava JSONu)  │           │
             │       │          └────────┬────────┘           │
             │       │                   │                    │
             ▼       ▼                   ▼                    ▼
        [ Provedení akce ]       [ Provedení upravené ]   [ Blokováno ]
       (event.input zůstává)    (event.input zmutován)  ({ block: true })
```

---

## 3. Detailní popis modulů

Projekt je navržen v modulárním TypeScriptu bez externích runtime závislostí kromě standardního rozhraní Pi agenta (`@earendil-works/pi-coding-agent`, `@earendil-works/pi-ai`, `@earendil-works/pi-tui`).

```text
pi-decision-gate/
├── package.json          # Manifest balíčku a závislosti
├── tsconfig.json         # Konfigurace TypeScriptu
├── types.ts              # Typové definice a rozhraní
├── config.ts             # Načítání, ukládání a dokumentace konfigurace
├── gate.ts               # Zachytávání tool_call, schvalovací dialog a mutace
├── jev.ts                # Komunikace s OpenRouter Decisions API a heuristika
├── models.ts             # Historická analýza 7denních sezení a konfigurace
├── balance.ts            # ČNB API, kurz USD/CZK a kredit na OpenRouteru
├── status.ts             # Formátování statusbaru a česká nápověda
├── index.ts              # Vstupní bod, registrace příkazů a autocompleti
├── herdr.ts              # Integrace s Herdr workspace managerem (panes, sub-agenti)
└── README.md             # Specifikace a PRD
```

### 3.1 `types.ts` — Datové struktury a typy

Definuje základní doménové typy pluginu:

- `ApprovalMode`: `"always" | "risky" | "destructive" | "off"`
- `DecisionGateConfig`:
  - `enabled: boolean` — globální aktivace pluginu.
  - `mode: ApprovalMode` — strategie schvalování.
  - `threshold: number` — číselný práh rizika (0.0 až 1.0, výchozí 0.7).
  - `useJev: boolean` — zapnutí/vypnutí sémantického volání modelu Jev.
  - `jevModel: string` — model slug na OpenRouteru (`~typesafe/jev-latest`).
  - `exemptTools: string[]` — seznam nástrojů vyjmutých ze schvalování (výchozí `["read"]`).
  - `allowEdit: boolean` — zda nabídnout možnost editace parametrů před schválením.
  - `logDecisions: boolean` — zda ukládat auditní stopu do `.pi/decision-gate/decisions.jsonl`.
- `JevAssessment`: Výsledek vyhodnocení rizik (skóre 0..2, pravděpodobnost nevratnosti, odklonu od úkolu, konfidence, cena v USD a Kč).
- `DecisionRecord`: Záznam o jednom rozhodnutí pro auditní logování.
- `ModelUsageStat`: Agregovaná statistika použití modelu ze sezení.

### 3.2 `config.ts` — Konfigurace, perzistence a dokumentace

Zajišťuje:
1. **Líné načítání konfigurace (`loadConfig(cwd)`):**
   - Načte výchozí hodnoty `DEFAULT_CONFIG`.
   - Překryje globální konfigurací z `~/.pi/agent/pi-decision-gate.json`.
   - Pokud existuje projektová konfigurace `.pi/pi-decision-gate.json`, aplikuje ji na nejvyšší úrovni.
2. **Ukládání konfigurace (`saveConfig(cfg, global, cwd)`):**
   - S přepínačem `--global` ukládá do domovské složky uživatele.
   - Bez přepínače ukládá do `.pi/pi-decision-gate.json` aktuálního projektu.
3. **`COMMAND_DOCS`:** Slovník českých popisů všech příkazů použitý pro nápovědu i našeptávání 1. úrovně.

### 3.3 `gate.ts` — Jádro zachytávání a schvalování akcí

Funkce `handleToolCallGate(event, ctx)`:
1. Kontroluje aktivaci brány a whitelist nástrojů (`exemptTools` + dynamické `sessionExemptions`).
2. Z `ctx.model` a `ctx.thinkingLevel` extrahuje identitu navrhujícího modelu.
3. Volá `assessActionWithJev()` pro stanovení rizikovosti akce.
4. Porovná výsledek s nastaveným režimem:
   - `always`: Vždy se dotazuje.
   - `risky`: Dotazuje se, pokud $skóre / 2.0 \ge threshold$ nebo $irreversible \ge threshold$.
   - `destructive`: Dotazuje se, pokud je kategorie `destructive` nebo příkaz odpovídá destruktivnímu regexu.
5. Pokud je akce vyhodnocena jako bezpečná, zapíše se jako `auto_approved` a ihned pokračuje.
6. Pokud vyžaduje schválení, otevře dialog `ctx.ui.select()` s těmito akcemi:
   - **Schválit:** Započítá schválení, zapíše auditní záznam, tool se spustí.
   - **Schválit + thinking [úroveň]:** Nastaví doporučenou úroveň myšlení (`pi.setThinkingLevel`) a schválí.
   - **Upravit argumenty:** Otevře `ctx.ui.editor()` s naformátovaným JSONem. Uživatel parametry upraví. Pokud je JSON validní, kód přepíše klíče v `event.input` in-place a akce se spustí s novými parametry.
   - **Přepnout model a zopakovat tah:** Seřadí modely dle vhodnosti (skóre + četnost + cache penalty) a po výběru zavolá `pi.setModel()`, zruší původní volání a nechá nový model navrhnout pokračování.
   - **Změnit úroveň myšlení:** Nabídne `off | minimal | low | medium | high | max` a vrátí se do dialogu.
   - **Spustit v novém okně (Herdr pane):** Rozdělí okno, spustí sub-agenta s doporučeným modelem a deleguje úkol; původní volání je zablokováno (`delegated_to_pane`).
   - **Odmítnout:** Vrátí `{ block: true, reason: "..." }`. Agent obdrží vysvětlení jako výsledek toolu a může přeplánovat.
   - **Osvobodit pro sezení:** Přidá nástroj do `state.sessionExemptions` a schválí.
7. Pokud TUI není k dispozici (headless), akce se propustí bez dotazu, aby nedošlo k zablokování neinteraktivního běhu.

### 3.4 `jev.ts` — Sémantické hodnocení System One (OpenRouter)

Model **Jev** od TypeSafe AI negeneruje text, nýbrž vrací kalibrovaná pravděpodobnostní rozhodnutí v čase ~200–300 ms.
- **Endpoint:** `https://openrouter.ai/api/alpha/decisions`
- **Model:** `~typesafe/jev-latest` (nebo `typesafe/jev-1.13`)
- **Autentizace:** Automatické nalezení tokenu v `~/.pi/agent/auth.json` (klíč `openrouter.access` nebo `openrouter.apiKey`), `process.env.OPENROUTER_API_KEY` nebo přes `ctx.modelRegistry`.
- **Otázky předávané modelu** (7 paralelních otázek v jediném požadavku):
  1. `risk` (`score`): 3bodová rubrika (0 = Bezpečné čtení, 1 = Běžná vratná úprava, 2 = Destruktivní operace / smazání / externí přepis).
  2. `consequence` (`score`): závažnost dopadu při chybě (0–3, dosah / „blast radius“).
  3. `family` (`choice`): taxonomie úkolu (`routine-transformation`, `investigation`, `mutation`, `cleanup`).
  4. `effort` (`choice`): doporučená úroveň uvažování (`low`, `medium`, `high`).
  5. `isolate_pane` (`score`): přínos izolovaného běhu v samostatném okně / sub-pane.
  6. `irreversible` (`noul`): Pravděpodobnost (0..1) nevratnosti akce.
  7. `off_task` (`noul`): Pravděpodobnost (0..1) odklonu od programátorského kontextu.
- **Sanitizace citlivých dat:** Před odesláním na externí API plugin zkontroluje payload (API klíče, tokeny, privátní klíče, hesla). Při nálezu se payload neodešle a použije se lokální heuristika (`sanitized: true`).
- **Offline pojistka:** Pokud je Jev nedostupný nebo je vypnutý, vyhodnocuje se lokální regex vzory (`rm -rf`, `git reset --hard`, `git push --force`, `drop table` apod.).
- **Náklady:** Plugin čte `usage.cost` z odpovědi OpenRouteru a přičítá jej do `state.sessionCostUsd`.

### 3.5 `models.ts` — Analýza historie sezení a konfigurace

Uživatel vyžaduje přehled o tom, jaké modely reálně používá. Modul `models.ts`:
1. Prochází složku `~/.pi/agent/sessions/` (kde Pi ukládá sezení v podsložkách kódovaných dle cest k projektům, např. `--D--01_programovani-...`).
2. Filtruje pouze soubory `.jsonl` modifikované v posledních 7 dnech (`cutoff = Date.now() - 7 * 24 * 3600 * 1000`).
3. Parsuje řádky typu `model_change` a `message` (s rolí `assistant`) a extrahuje `provider` a `modelId`.
4. Agreguje četnost použití modelů (počet tahů) a čas posledního použití.
5. Doplňuje modely definované v `~/.pi/agent/settings.json` a aktivní model v sezení.
6. Výsledek je cachován s TTL 15 minut (nebo do příkazu `/gate models`).

### 3.6 `balance.ts` — Směnný kurz ČNB a OpenRouter kredit

1. **Kurz USD/CZK:**
   - Primárně volá oficiální denní API ČNB: `https://api.cnb.cz/cnbapi/exrates/daily?lang=EN`.
   - Fallback na ECB data přes `https://api.frankfurter.dev/v1/latest?base=USD&symbols=CZK`.
   - Výsledek cachuje pro daný kalendářní den.
2. **Kredit OpenRouteru:**
   - Volá `https://openrouter.ai/api/v1/credits` s autorizačním tokenem.
   - Zjišťuje `total_credits - total_usage` a cachuje po dobu 5 minut.
3. **Formátování částek:**
   - Funkce `fmtSmallAmount()` zabraňuje zaokrouhlení mikronákladů na `0.00 Kč` a zobrazuje přesné hodnoty (např. `0.0004 Kč`).

### 3.7 `status.ts` — Vykreslování statusbaru a nápovědy

Patička v Pi agentu (`ctx.ui.setStatus`) je rozdělena na 4 sémantické bloky v jedné položce:
```text
🛡️ always │ G:gemini-3.8 │ ✓4 · ✗1 │ 💳 0.0015 Kč / 48.50 Kč
```
1. **Režim brány:** `🛡️ always` / `🛡️ risky(≥0.7)` / `🛡️ destructive` / `🛡️ gate:off`
2. **Aktivní model:** `G:gemini-3.8` (poskytovatel + název modelu)
3. **Statistiky schvalování:** Počet schválených (`✓4`) a zamítnutých (`✗1`)
4. **Finanční přehled:** Náklady sezení na Jev v Kč a zůstatek kreditu na OpenRouteru v Kč

Modul také generuje přehledný nápovědní banner v češtině při zavolání `/gate help` nebo prázdného `/gate`.

### 3.8 `index.ts` — Vstupní bod, CLI příkazy a autocompleti

Registruje příkazy `/gate` a `/decision-gate` s víceúrovňovým našeptáváním (`getArgumentCompletions`):
- **1. úroveň:** Nabídka podpříkazů (`mode`, `threshold`, `jev`, `exempt`, `models`, `balance`, `reset`, `help`...).
- **2. úroveň:**
  - `mode ` $\rightarrow$ `always`, `risky`, `destructive`, `off`
  - `jev ` $\rightarrow$ `on`, `off`
  - `edit ` $\rightarrow$ `on`, `off`
  - `threshold ` $\rightarrow$ `0.3`, `0.5`, `0.7`, `0.9`
  - `exempt ` $\rightarrow$ `list`, `add`, `remove`
  - `balance ` $\rightarrow$ `refresh`

### 3.9 `herdr.ts` — Integrace s Herdr (panes, sub-agenti, delegace)

Modul propojuje bránu s [Herdr](https://herdr.dev/) workspace managerem a umožňuje izolovaný běh rizikových či dlouhotrvajících úkolů:
- `isHerdrEnvironment()` — detekce běhu uvnitř Herdr (`HERDR_ENV`, `HERDR_PANE_ID`, `HERDR_SOCKET_PATH`).
- `splitHerdrPane({ direction, cwd })` — rozdělí aktuální okno (vpravo/dole) a vrátí `paneId`.
- `startHerdrAgent({ name, kind, paneId, model, thinking, theme })` — spustí sub-agenta (výchozí `pi`) v novém pane.
- `promptHerdrAgent({ target, promptText, wait })` — odešle zadání běžícímu agentovi (sync/async).
- `closeHerdrPane(paneId)` — uzavře pane.

Doporučení delegace skládá `getHerdrPaneRecommendation()` (models.ts): kombinuje `shouldOffloadToPane` / `isolatePaneScore` od Jev, detekci dlouhotrvajících příkazů (npm test/build, cargo, pytest, docker, …) a destruktivní kategorii. Doporučený model pro izolovaný běh se vybírá dle `evaluateModelSuitability()`.

---

## 4. Funkční požadavky (FR)

- **FR-1 (Intercepce nástrojů):** Plugin musí zachytit každý `tool_call` před jeho spuštěním.
- **FR-2 (Atribuce modelu):** Každý schvalovací dotaz musí explicitně uvádět název poskytovatele a modelu, který akci navrhl, včetně úrovně uvažování (`thinkingLevel`).
- **FR-3 (Volitelné sémantické posouzení):** Pokud je aktivní `useJev`, plugin musí paralelně s heuristikou zaslat stav na OpenRouter Decisions API a zobrazit skóre rizika a nevratnosti.
- **FR-4 (In-place editace parametrů):** Uživatel musí mít možnost zvolit "Upravit argumenty", upravit JSON v textovém editoru Pi agenta a spustit nástroj s upravenými argumenty.
- **FR-5 (Vyloučení nástrojů):** Uživatel může trvale (v konfiguraci) nebo dočasně (pro dané sezení) osvobodit konkrétní nástroj (např. `read`) od schvalování.
- **FR-6 (Analýza sezení):** Příkaz `/gate models` musí proskenovat historii sezení za 7 dní a vypsat tabulku reálně používaných modelů a četnosti jejich tahů.
- **FR-7 (Finanční metriky):** Statusbar a příkaz `/gate balance` musí zobrazovat náklady v CZK přepočtené dle ČNB a zůstatek kreditu na OpenRouteru.
- **FR-8 (Perzistence nastavení):** Příkazy s příznakem `--global` se musí trvale uložit do `~/.pi/agent/pi-decision-gate.json`, bez příznaku do `.pi/pi-decision-gate.json`.
- **FR-9 (Rozšířené hodnocení Jev):** Posouzení musí kromě rizika pokrývat i závažnost dopadu (`consequence`), taxonomii úkolu (`family`), doporučenou úroveň uvažování (`effort`) a přínos izolace (`isolate_pane`).
- **FR-10 (Sanitizace citlivých dat):** Payload obsahující API klíče, tokeny, hesla či privátní klíče se nesmí odeslat na externí API a musí se vyhodnotit lokálně.
- **FR-11 (Modelový routing):** Schvalovací dialog musí nabídnout přepnutí modelu na základě skóre vhodnosti (vč. penalizace ztráty prompt cache) a umožnit opakování tahu.
- **FR-12 (Herdr delegace):** Destruktivní, dlouhotrvající či autonomní úkoly musí být delegovatelné do izolovaného okna Herdr se samostatným sub-agentem a doporučeným modelem.
- **FR-13 (Nastavení úrovně myšlení):** Uživatel musí moci přímo z dialogu změnit úroveň thinking (`off`–`max`) nebo schválit akci s doporučenou úrovní.

---

## 5. Nefunkční požadavky (NFR)

- **NFR-1 (Nulový dopad na stabilitu):** Žádná chyba sítě (výpadek OpenRouteru, ČNB API) nesmí způsobit pád Pi agenta ani zablokovat uživatele; v případě selhání se použije offline heuristika.
- **NFR-2 (Nízká latence):** Posouzení Jev modelem nesmí přidat zpoždění větší než ~300 ms. Pokud uživatel vypne Jev (`/gate jev off`), latence je < 1 ms.
- **NFR-3 (Bezpečnost API klíčů):** Plugin nikdy nezapisuje API klíče do konverzačního kontextu, systémového promptu ani auditního logu.
- **NFR-4 (TUI kompatibilita):** Statusbar i dialogy musí fungovat bez přetékání a respektovat tmavé i světlé téma terminálu (použita šetrná paleta ANSI barev).

---

## 6. Konfigurace a hierarchie nastavení

Konfigurace se načítá v kaskádě:
1. `DEFAULT_CONFIG` (zabudované výchozí hodnoty)
2. `~/.pi/agent/pi-decision-gate.json` (globální uživatelská nastavení)
3. `<projekt>/.pi/pi-decision-gate.json` (projektová nastavení)

### Příklad konfiguračního souboru:
```json
{
  "enabled": true,
  "mode": "always",
  "threshold": 0.7,
  "useJev": true,
  "jevModel": "~typesafe/jev-latest",
  "exemptTools": [
    "read"
  ],
  "allowEdit": true,
  "logDecisions": true
}
```

---

## 7. Příkazová řádka a uživatelské rozhraní

Příkazy lze volat pod `/gate` nebo `/decision-gate`:

```bash
/gate on                         # Zapne bránu
/gate off                        # Vypne bránu
/gate mode always                # Schvalovat vše
/gate mode risky                 # Schvalovat pouze rizikové (Jev >= 0.7)
/gate mode destructive           # Schvalovat pouze destruktivní příkazy
/gate threshold 0.8              # Nastavení prahu rizika na 0.8
/gate jev on|off                 # Povolit/zakázat OpenRouter Jev
/gate edit on|off                # Povolit/zakázat editaci parametrů
/gate exempt list                # Seznam osvobozených nástrojů
/gate exempt add read            # Přidat 'read' do výjimek
/gate exempt remove read         # Odebrat 'read' z výjimek
/gate models                     # Zobrazit tabulku používaných modelů za 7 dní
/gate balance [refresh]          # Zůstatek kreditu a kurz ČNB
/gate status                     # Kompletní diagnostika a stav
/gate reset                      # Návrat k výchozímu nastavení
/gate help                       # Zobrazí nápovědu
```

Přidáním `--global` na konec kteréhokoli příkazu se volba uloží pro všechna budoucí sezení.

---

## 8. Auditní logování (.jsonl)

Pokud je zapnuto `logDecisions: true`, každé rozhodnutí se zapisuje do `.pi/decision-gate/decisions.jsonl`:

```json
{
  "id": "k8x9a2b1",
  "timestamp": "2026-09-18T10:15:30.123Z",
  "model": {
    "provider": "google",
    "id": "gemini-3.8-flash",
    "thinking": "high"
  },
  "tool": "bash",
  "input": {
    "command": "git push --force origin main"
  },
  "verdict": "rejected",
  "assessment": {
    "riskScore": 1.93,
    "riskCategory": "destructive",
    "irreversibleProb": 0.95,
    "offTaskProb": 0.05,
    "confidence": 0.89,
    "costUsd": 0.0000139,
    "costCzk": 0.00029,
    "modelUsed": "typesafe/jev-1.13-20260917"
  }
}
```

---

## 9. Instalace a vývoj

### Instalace přes Pi:
```bash
pi install git:github.com/mastnacek/pi-decision-gate
```

### Lokální vývoj:
```bash
cd D:/01_programovani/pi/plugins/pi-decision-gate
npm run check    # Kontrola typů (npx tsc --noEmit)
```

Propojení do Pi sezení:
```bash
pi install D:/01_programovani/pi/plugins/pi-decision-gate
```

---

## 10. Licence

MIT © [mastnacek](https://github.com/mastnacek)
