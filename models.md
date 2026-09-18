# Models — Latest & Free (Google, Z-AI, MoonshotAI, DeepSeek)

Reference data fetched live from the OpenRouter catalog (`GET https://openrouter.ai/api/v1/models`, no auth required).

- **Latest** = OpenRouter *latest router* slugs `~author/family-latest`. They always resolve to the newest concrete model in a family; the `alias_target` column shows the current resolution.
- **Free** = catalog variants with `:free` suffix (prompt = completion = $0).

Key facts:

- A `~...-latest` router is **never free** — there are 0 `-latest:free` slugs on OpenRouter. Free models are separate, version-pinned `:free` entries.
- **MoonshotAI has no free model.**

---

## 1. Latest models (`~author/family-latest`)

| Provider   | Latest alias                    | Resolves to                        | Context | Input                      | Price $/tok (in / out) |
| ---------- | ------------------------------- | ---------------------------------- | ------- | -------------------------- | ---------------------- |
| Google     | `~google/gemini-flash-latest`   | `google/gemini-3.8-flash`          | 1.05 M  | text+image+video+file+audio | $0.00000075 / $0.00000375 |
| Google     | `~google/gemini-pro-latest`     | `google/gemini-3.1-pro-preview`    | 1.05 M  | text+image+video+file+audio | $0.000002 / $0.000012    |
| Z-AI       | `~z-ai/glm-latest`              | `z-ai/glm-5.3`                     | 1.31 M  | text                       | $0.0000008775 / $0.00000297 |
| Z-AI       | `~z-ai/glm-flash-latest`        | `z-ai/glm-5.3-flash`               | 1.31 M  | text+image+video           | $0.000000075 / $0.00000025 |
| MoonshotAI | `~moonshotai/kimi-latest`       | `moonshotai/kimi-k3`               | 1.05 M  | text+image+video           | $0.0000021 / $0.00001095 |
| DeepSeek   | `~deepseek/deepseek-pro-latest` | `deepseek/deepseek-v4-pro-0813`    | 1.05 M  | text                       | $0.00000066 / $0.00000198 |
| DeepSeek   | `~deepseek/deepseek-flash-latest` | `deepseek/deepseek-v4.1-flash`   | 1.05 M  | text+image                 | $0.00000015 / $0.0000006 |
| DeepSeek   | `~deepseek/deepseek-v4-flash-latest` | `deepseek/deepseek-v4-flash-0731` | 1.31 M | text                     | $0.0000000558 / $0.0000001767 |

## 2. Free models (`:free`)

| Provider   | Free model                        | Context | Input            | Price   |
| ---------- | --------------------------------- | ------- | ---------------- | ------- |
| DeepSeek   | `deepseek/deepseek-v4-flash-0731:free` | 1.05 M | text           | $0      |
| Z-AI       | `z-ai/glm-5.2:free`               | 32 K    | text             | $0      |
| Google     | `google/gemma-4-26b-a4b-it:free`  | 256 K   | text+image+video | $0      |
| Google     | `google/gemma-4-31b-it:free`      | 256 K   | text+image+video | $0      |
| MoonshotAI | — none —                          | —       | —                | —       |

## 3. Notes

- **DeepSeek's free model is the twin of its latest-flash**: `~deepseek/deepseek-v4-flash-latest` resolves to `deepseek/deepseek-v4-flash-0731`, and its free variant is `deepseek/deepseek-v4-flash-0731:free`.
- **Google free = Gemma 4** (open models), not Gemini. The `gemini-*-latest` routers are paid.
- **Z-AI free is one version behind latest**: `glm-latest` → `glm-5.3`, free is `glm-5.2:free` (32 K context, text only).
- Total models scanned for the 4 providers: 94.
