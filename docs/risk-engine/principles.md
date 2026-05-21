# Risk engine — principles

Signal's risk engine exists to keep growth activity sustainable. It is structured, not aggressive. Its recommendations are calm and reversible.

## Categories

| Category | What it watches |
|---|---|
| `duplicate_content` | Same or near-identical content across accounts inside a short window. |
| `link_repetition` | Same outbound link from the same account inside a short window. |
| `overposting` | Account exceeds the platform's healthy cadence. |
| `synchronized_posting` | Multiple workspace accounts posting within minutes of each other. |
| `promotional_tone` | Tone reads more salesy than the product's allowed CTA style. |
| `account_fatigue` | Account is still in warm-up or has not earned the trust required to publish. |
| `platform_cadence` | Cadence drifts from the platform-native rhythm for this content type. |

## Levels

- `low` — informational. No action needed.
- `medium` — recommended cooldown, soften, or delay.
- `high` — hold publishing. Move to backlog.

## Recommendation tone

Risk messages are written calmly and concretely. Examples:

- "Recommended cooldown: 2 days."
- "This account already has enough promotional activity this week."
- "Suggested: move item to backlog."

The engine never says "must," "warning," or "danger." It surfaces facts and a suggestion. The founder is always the decision-maker.

## Input signals (MVP)

The MVP risk engine reads:

- The weekly plan and the product's allowed CTA style.
- Account status (`planned` … `active`) and last activity timestamp.
- Platform cadence guidance defined on each `Platform`.
- Per-product risk tolerance.

## Future signals

- Real post history once OAuth providers are connected.
- Aggregate per-account fatigue over multiple weeks.
- Cross-product link-repetition checks.
