# 🛡️ pi-decision-gate

Rozšíření (plugin) pro [Pi coding agent](https://pi.dev/) zajišťující **human-in-the-loop schvalování každého rozhodnutí modelu** s jasnou atribucí použitého modelu, rychlým posouzením rizik přes **TypeSafe Jev** (OpenRouter) a zobrazením nákladů v **Kč**.

---

## ✨ Hlavní funkce

- **🛡️ Kontrola a schvalování akcí:** Každé volání nástroje (`bash`, `write`, `edit` atd.) je před spuštěním zachyceno a předloženo uživateli ke schválení.
- **🏷️ Modelová atribuce:** V dialogu i ve statusbaru vždy vidíte, který model akci navrhl (např. `google/gemini-3.8-flash`, `thinking: high`).
- **🧠 Posuzování rizik přes Jev (System One):** Využívá model `~typesafe/jev-latest` přes OpenRouter API k bleskovému sémantickému vyhodnocení rizika, nevratnosti a odklonu od zadání (~250 ms, zlomek haléře).
- **✏️ Interaktivní editace parametrů:** Uživatel může navržené parametry (příkaz, kód) přímo v editoru upravit a schválit upravenou verzi.
- **📊 Historická analýza modelů:** Analyzuje sezení Pi agenta za posledních 7 dní a přehledně zobrazuje, které modely byly v praxi použity.
- **💳 Statusline & Spotřeba v Kč:** Zobrazuje aktivní stav brány, emoji indikátor `🛡️`, aktivní model, statistiku schválení/odmítnutí a průběžnou spotřebu v českých korunách (s denním kurzem ČNB) a kredit na OpenRouteru.
- **🇨🇿 Česká nápověda & Líné doplňování:** Plná podpora standardu z `AGENTS.md` — vícedenní cache, víceúrovňové autocompleti a podrobná česká nápověda.

---

## 🚀 Instalace

```bash
pi install git:github.com/mastnacek/pi-decision-gate
```

Nebo lokální propojení ve vývoji:

```bash
pi install D:/01_programovani/pi/plugins/pi-decision-gate
```

---

## ⚙️ Režimy schvalování (`/gate mode <režim>`)

| Režim | Popis |
|---|---|
| `always` | **Výchozí.** Schvaluje každou akci modelu (kromě osvobozených nástrojů). |
| `risky` | Automaticky propouští bezpečné akce; vyžaduje schválení pouze při riziku Jev $\ge$ práh (výchozí 0.7). |
| `destructive` | Schvaluje pouze destruktivní akce (příkazy `rm -rf`, `git reset --hard`, `git push --force`, mazání databází apod.). |
| `off` | Brána je neaktivní, akce probíhají bez zdržení. |

---

## ⌨️ Příkazy (`/gate` nebo `/decision-gate`)

| Příkaz | Popis |
|---|---|
| `/gate on` / `/gate off` | Hlavní vypínač brány |
| `/gate mode <always\|risky\|destructive\|off>` | Nastavení režimu schvalování |
| `/gate threshold <0.1-1.0>` | Nastavení prahu rizika pro režim `risky` |
| `/gate jev on\|off` | Zapnutí/vypnutí sémantického hodnocení přes Jev na OpenRouteru |
| `/gate edit on\|off` | Povolení/zákaz interaktivní úpravy argumentů |
| `/gate exempt list` | Seznam osvobozených nástrojů (výchozí `read`) |
| `/gate exempt add <tool>` | Přidání nástroje do výjimek |
| `/gate exempt remove <tool>` | Odebrání nástroje z výjimek |
| `/gate models` | Přehled modelů používaných v sezeních za posledních 7 dní |
| `/gate balance [refresh]` | Zůstatek kreditu na OpenRouteru a kurz ČNB |
| `/gate status` | Detailní diagnostika, metriky sezení a náklady |
| `/gate reset` | Obnovení výchozího nastavení |
| `/gate help` | Kompletní nápověda a popis parametrů |

> 💡 **Tip:** Přidejte `--global` k jakémukoli příkazu pro trvalé uložení do `~/.pi/agent/pi-decision-gate.json` (např. `/gate mode risky --global`).

---

## 🛡️ Schvalovací dialog v TUI

Když model navrhne akci, zobrazí se dialog:

```text
🛡️ Rozhodnutí modelu vyžaduje schválení
Navrhl model: google/gemini-3.8-flash [thinking: high]
Nástroj:      bash
Posouzení Jev: Riziko 1.93/2.0 (destructive) │ Nevratnost: 95% │ Náklad: 0.0003 Kč

Navrhované argumenty:
{
  "command": "rm -rf ./dist"
}

Vyberte akci:
> Schválit
  Upravit argumenty
  Odmítnout
  Osvobodit 'bash' pro toto sezení
```

Pokud vyberete **Upravit argumenty**, otevře se textový editor s JSON strukturou, kterou můžete libovolně poupravit a spustit.

---

## 📈 Statusbar

V patičce Pi agenta se zobrazuje kompaktní indikátor:

```text
🛡️ always │ G:gemini-3.8 │ ✓4 · ✗1 │ 💳 0.0015 Kč / 48.50 Kč
```

1. **Režim brány:** `🛡️ always` / `🛡️ risky(≥0.7)` / `🛡️ gate:off`
2. **Aktivní model:** `G:gemini-3.8` (poskytovatel a model navrhující akce)
3. **Statistiky sezení:** `✓4` schváleno, `✗1` zamítnuto
4. **Spotřeba a zůstatek:** Spotřeba za Jev posuzování v Kč a zbývající kredit na OpenRouteru

---

## 📄 Licence

MIT © [mastnacek](https://github.com/mastnacek)
