# Miu emoji for Slack

30 emoji, 128×128, each under 35 KB. Built by `node assets/brand/build/slack-emoji.mjs`; `preview.png` shows them on a light and a dark background.

| Kind | Emoji |
|---|---|
| Faces | `miu` `miu-happy` `miu-love` `miu-wink` `miu-cool` `miu-blush` `miu-sad` `miu-cry` `miu-angry` `miu-shock` `miu-nervous` `miu-thinking` `miu-sleepy` `miu-eyes` `miu-party` `miu-dead` |
| Work | `miu-lgtm` `miu-ship-it` `miu-on-it` `miu-qa` `miu-bug` `miu-fire` `miu-coffee` `miu-plus1` |
| Verdicts | `miu-ok` `miu-partial` `miu-notok` `miu-running` |
| Other | `miu-light` (a light tile), `miu-blink` (animated) |

## Adding them to Slack

Your workspace must let members add emoji (Workspace settings → Permissions → Customize; an admin can change it).

**One at a time**
1. In Slack, open any message's emoji picker and press **Add Emoji** (or open `https://<your-workspace>.slack.com/customize/emoji`).
2. Upload the file, for example `miu-lgtm.png`.
3. Name it as the file is named, without `.png`: `miu-lgtm`. Save.

**All at once**
1. Install the free **Neutral Face Emoji Tools** extension (Chrome or Firefox).
2. Open `https://<your-workspace>.slack.com/customize/emoji`.
3. Drop every `.png` and `.gif` from this folder on the drop area the extension adds. Each emoji takes its file name.
