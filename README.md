# Comfy Studio Scene Generator — SillyTavern extension

A SillyTavern **third-party UI extension** (classic layout, **no build step**, no npm) that turns
image generation into **one button**. It talks to your local **comfy-studio** service (FastAPI in
front of ComfyUI, default `http://127.0.0.1:8090`).

**v1.1.0 — one-button flow.** A single primary button, **Generate scene**, does the whole pipeline
with no typing:

1. reads the chat (last N messages, stripped of HTML), the character's card appearance fields
   (`description` / `first_mes`) and the persona name;
2. asks **SillyTavern's own configured LLM** for ONE image caption (a hidden "quiet" completion);
3. POSTs that caption to comfy-studio `/api/generate` with the selected model/params;
4. shows the image and **attaches it to the last chat message as message media** — the same
   mechanism ST's Image Generation uses — with **no new turn and nothing sent**.

A secondary **↻ regenerate caption** link re-runs *only* the caption step (a bad caption can be
redone without spending a render). The manual composer (prompt, negative, model, LoRAs, sampler,
steps, cfg, size, batch, seed) still exists, collapsed behind an **Advanced** disclosure that is
**closed by default**.

Other features:

- explicit **model / LoRA / sampler / scheduler / steps / cfg / size / batch / seed** control
- **LoRA rows** with weights; LoRAs the backend marks incompatible for the current model are greyed out
- a fixed **floating progress pill** (on `<body>`, not in the panel) that stays visible while a job
  runs — even with the settings drawer closed and you typing in the chat — showing an honest
  phase + percentage (`Queued` → `Generating image` / `loading model` → step N/M)
- an auto-growing **prompt** and **negative prompt** composer (Advanced)
- a **progress bar** polled from `/api/job/{id}` every ~800 ms, with the backend's error shown verbatim
- a **result thumbnail** with **Insert** (attaches the image to the last message; never sends) and
  **Copy image URL**
- **prompt history** from `/api/history`, click a row to load its prompt + parameters back into the composer

No typing, no prompts to write, nothing auto-sent.

---

## Install

The extension folder must live under SillyTavern's `data/<user-handle>/extensions/` (per-user) or
`public/scripts/extensions/third-party/` (all users).

### Option A — via SillyTavern's UI (recommended)

1. SillyTavern → **Extensions** → **Install extension**.
2. Paste the repository URL:

   ```
   https://github.com/your-user/st-comfy-studio-composer
   ```

   *(placeholder — replace with your real repo URL once you push this folder).*
3. Reload SillyTavern. The panel appears under **Extensions** → *Comfy Studio — Scene Generator*.

### Option B — manual copy

Copy this whole folder into SillyTavern, keeping the folder name:

```text
<SillyTavern>/data/<your-handle>/extensions/st-comfy-studio-composer/
    manifest.json
    index.js
    style.css
    README.md
    dev/            (offline harness — not needed at runtime)
```

Reload the page (F5).

---

## How it works

One button: **Generate scene**.

1. It takes **only the last message of the chat** — not the whole context, not the
   character card, not older turns. Whatever was written last is what gets illustrated.
2. It sends that message to **the API you are already roleplaying with** (the active
   SillyTavern connection: OpenRouter, Anthropic, a local model, whatever is selected
   in the Connection Manager) with a permissive, no-refusal system prompt that asks for
   the scene **as JSON**:

   ```json
   {"prompt": "visual tags for the image", "negative": "artefacts to avoid", "scene": "one line"}
   ```

   The extension never carries an API key or a provider URL of its own: it calls ST's
   own quiet-prompt path, so it always uses the current model.
3. The JSON is parsed strictly (code fences and stray prose are discarded). If a model
   ignores the format and answers with prose, the whole reply is used as the prompt and
   the button still works.
4. Your **style suffix** is merged in tag by tag, skipping tags the caption already has.
5. The caption goes to comfy-studio. The image is **attached to the last message as
   media** — no new turn, nothing auto-sent, so no LLM reply is triggered.

### Three ways to fire it

| Where | What |
|---|---|
| **Magic wand** (the menu next to the chat input) → *Illustrate this message* | Fastest. No panel, no typing. |
| `/illustrate` slash command | Same thing from the keyboard or a quick reply. |
| **Generate scene** in the extension panel | Same thing, with the caption preview in front of you. |

All three capture **the message id at the moment you click**. You can keep
roleplaying while the image renders: new replies arriving mid-job do not steal
the image — it is attached to the message you asked about, not to the newest one.

If the LLM answers with **nothing** (provider hiccup, empty completion, filter),
the extension does not fail: it falls back to using the last message's own text as
the prompt, tells you so in a toast, and still renders.

**↻ regenerate caption** re-runs only the caption step when the JSON came out wrong —
no render is wasted.

A floating pill above the chat input shows progress while a job runs, even with the
settings drawer closed: `Generating image… 43%` with `step 11/25` underneath. Cold model
loads report `loading model` and advance 8→25% on a timer instead of sitting at 0%.

### LLM fallback chain (v1.4)

The caption no longer depends on one entry point. Each path is tried in order and
an error **or an empty reply** moves on to the next:

| # | Path | Why it is there |
|---|---|---|
| 1 | `generateQuietPrompt({removeReasoning:true})` | ST's canonical hidden completion |
| 2 | same call with `removeReasoning:false` | reasoning models put the answer inside the thinking block; #1 strips it and returns `''` — this is the old *"generateQuietPrompt returned empty reply"* |
| 3 | `generateRaw()` | no chat history, no character card: a blown context cannot kill it |
| 4 | `POST /api/backends/chat-completions/generate` | body built from the live chat-completion settings, so proxies / Azure / Claude / OpenRouter keep working |

If **all four** fail, the caption falls back to the message text and the image
still renders. **⚡ test LLM** in the panel runs the chain and prints one row per
path (green = answered, red = why not) — useful on a phone, where there is no console.

### Card seeding + JSON repair (v1.5.3)

* **The sheet fills itself from the character card.** An empty sheet is seeded
  with the card's `description` + `personality` (macros stripped, ~700 chars), so
  age, hair, eyes, scars and marks are in the prompt without retyping anything.
  The text stays editable, and **↧ card** re-pulls it after you edit the card.
* **Prose answers are converted.** If the first reply is not JSON (provider
  ignoring `jsonSchema`, model ignoring the instruction), the extension runs one
  repair call — "convert this description into this JSON" with the same schema —
  and uses the result. The panel reports `via … + repair`, so you can see when it
  happened. Only when even that fails does it use the text as tags.

### Caption path memory + forced JSON (v1.5.2)

Two follow-ups after the phone diagnostics showed `quiet prompt: empty reply`
but `raw generation: 691 chars`:

* **The raw path now asks for the caption JSON explicitly.** `generateRaw` is
  called with a `jsonSchema` (`prompt` required, plus `negative`, `scene`,
  `outfit`), so ST enforces/extracts the shape instead of returning prose. A
  second raw variant using `prefill` covers providers that ignore schemas.
* **Dead paths are remembered.** A path that answers with nothing is stored in
  `llmDead` and skipped on the next caption, so a phone where the quiet prompt
  is broken goes straight to raw instead of burning 1-3 s per image. The order
  itself never changes (best path first), entries expire after 5 minutes, and if
  every non-dead path fails the memory is wiped and everything is retried once.
  The diagnostics line shows `dead=…` so you can see what it learned.

### When the caption LLM keeps failing (v1.5.1)

The panel header now shows the **loaded build** (`v1.5.1`) — if it says anything
else, ST is still running cached code and the fixes are not in.

**⚡ test LLM** runs the whole chain and prints one row per path plus a context
line (`ext v… api=… source=… model=…`). **📋 copy** puts it on the clipboard so it
can be pasted into a chat — no console needed on a phone.

The chain is now five paths: quiet prompt → quiet prompt keeping reasoning →
quiet prompt in **system mode** (`quietToLoud`, a different prompt assembly) →
`generateRaw()` → ST's chat-completions endpoint. Only when all five fail does
the caption fall back to the message text, and the toast tells you to run the
diagnostics.

### Character coherence (v1.5)

Without a LoRA, the only thing that keeps the same person across images is
**state carried into every prompt**. The panel stores one sheet per character
(keyed by the avatar filename, so renaming does not lose it):

| Field | What it is for |
|---|---|
| **Character coherence** (textarea) | age, face, hair, eyes, body type, scars / tattoos / marks. Injected into the system prompt of every caption. |
| **Outfit** | the clothes currently worn. Reused in the next image unless the scene changes clothes. |
| **Keep the same outfit** | off = the outfit is not carried over (free wardrobe). |
| **↧ from last** | takes the outfit the LLM reported in the last caption. |
| **⌫** | erases this character's sheet. |

How it holds: (1) the sheet goes **inside the system prompt**, with the rule that
the canonical traits override anything the model infers; (2) after the caption
comes back, `enforceCanonical()` measures which parts of the sheet the answer
actually kept and **re-appends the missing ones at the END of the prompt** (late
tokens weigh more); (3) the outfit the LLM reports is saved for the next image.
If the caption puts the character naked (nude / naked / topless / undressed …)
the outfit is deliberately **not** forced back. The panel prints
*"coherence re-injected: …"* when step 2 had to act.

### Progress overlay (v1.4)

A small overlay sits at the **top of the chat area** — outside the extension
drawer, so it is visible with the drawer shut. It shows the phase, an honest
percentage, a progress bar, the step counter, and a ✕ that cancels the job.

* Cold start (models loading) maps to 8-25% and says `loading model` instead of
  showing a fake 0%.
* Sampling maps 25-100% of the real progress.
* During the **caption** step the bar sweeps, because no honest percentage exists yet.
* **◉ show overlay** in the panel pins it for a few seconds to check it on your device.

### Short prompt (v1.6.1)

The instruction is 602 characters: illustrate the moment from the chat context,
answer in one JSON object. No rules list, no "never invent", no sermon — the model
is capable of reading the context. The context window and the previous image are
still sent; the JSON schema and the repair pass are unchanged.

### Nothing about looks is hardcoded (v1.6)

The extension does **not** define how anyone looks. No character sheet, no traits,
no outfit stored and re-injected. The model derives everything from two inputs:

1. **CHAT CONTEXT** — the last 10 messages (600 chars each, 5 000 total), oldest
   first, `Name: text`. That is where age, hair, eyes, body, scars and clothes
   come from, because that is where the roleplay wrote them.
2. **PREVIOUS IMAGE OF THIS SAME PERSON** — the prompt of the last image generated
   in this chat, so the next one keeps the identical face and outfit. Cleared when
   the chat changes.

The system prompt only states the job: read the context, interpret the moment
visually, translate it to tags, answer in one JSON object. The words "never
invent" are literal — if the chat never says it, the picture does not get it.

## Settings

## Settings

**Extensions** → *Comfy Studio — Scene Generator*.

| Control | Default | Meaning |
|---|---|---|
| **comfy-studio base URL** | `https://jose.tail7a8ecd.ts.net:10000` | Where the service lives. On the PC use `http://127.0.0.1:8090`. It is called cross-origin, so the service must send CORS headers (it does). |
| **Auto-insert image into the chat** | on | Attach the result to the last message. Off = only show it in the panel. |
| **Style suffix** | `anime illustration, cinematic lighting, highly detailed, 35mm film grain` | Appended to every caption. Duplicated tags are dropped. |
| **Caption model** | *(empty = same as chat)* | Optional model name passed to the quiet-prompt call. |

Everything below lives in the collapsed **Advanced — manual prompt & parameters**
disclosure (closed by default): manual prompt override, negative prompt, model,
LoRA rows, sampler/scheduler, steps, CFG, size, batch, seed. LoRAs whose declared
family does not match the selected model are greyed out with the reason.

All of it is stored in `extensionSettings['comfy_studio_composer']` and persisted
with `saveSettingsDebounced()`, the documented ST mechanism.

---

## Verification harness (`dev/`)

`dev/harness.html` runs the panel **outside SillyTavern** against the **real**
comfy-studio API. It stubs only the SillyTavern surface the extension uses
(`SillyTavern.getContext()`, `extensionSettings`, `saveSettingsDebounced`,
`eventSource`, `event_types`, `chat`, `characters`, `characterId`, `name1`,
`name2`, `generateQuietPrompt`), plus `toastr` and the `#extensions_settings2` /
`#send_textarea` / `.mes` containers. Nothing else is faked: the caption comes
from a stub, but the image is a real render.

```bash
# from this folder (any static server works; CORS is enabled on comfy-studio)
python -m http.server 8094 --bind 127.0.0.1
# then open:
#   http://127.0.0.1:8094/dev/harness.html?base=http://127.0.0.1:8090
#   append &skipGenerate=1 to reuse an image from /api/history (no new render)
```

27 assertions, all printed as `PASS`/`FAIL`: panel mounts, models load, Advanced
starts closed, LoRA catalog populates, the single button runs the caption step with
an **empty** prompt box, `POST /api/generate` carries that caption, the PNG decodes,
the URL is absolute, the image is attached to the last message as media with
`saveChat()` called and **nothing auto-sent**, *regenerate caption* issues no
render, the floating pill exists outside the panel with `role=status`,
`aria-live=polite`, `pointer-events:none`, shows a phase plus a 1-100% number,
maps cold start to 8-25% with `loading model`, and hides when the job ends.

The parent app must be reachable: `curl http://127.0.0.1:8090/api/health`.

---

## Troubleshooting

**The panel says "comfy-studio unreachable" (or the browser console shows a CORS error).**
The browser calls the service from SillyTavern's origin (`http://127.0.0.1:8000`), which is a
*different* origin from `127.0.0.1:8090`. The service must respond with CORS headers. It must send at
minimum:

```
Access-Control-Allow-Origin: *
Access-Control-Allow-Methods: GET, POST, OPTIONS
Access-Control-Allow-Headers: Content-Type
```

and answer the `OPTIONS` preflight for `POST /api/generate` (browsers preflight it because of the
`Content-Type: application/json` header). Add to `app.py`:

```python
from fastapi.middleware.cors import CORSMiddleware
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],           # or ["http://127.0.0.1:8000"]
    allow_methods=["*"],
    allow_headers=["*"],
)
```

Comfy-studio sends CORS headers for localhost/private-LAN/tailnet origins, so a browser page on the
ST origin can call it directly. If you see a CORS error, the origin is outside that list — open
`http://127.0.0.1:8090/api/meta` in the same browser to confirm the service is up, then check the
allow-list in comfy-studio's `app.py`.

**"comfy-studio unreachable" but CORS is fine.**
Check the service is actually up: `curl http://127.0.0.1:8090/api/health` → `{"ok":true,"comfy":true}`.
If you changed the port, update the base URL in the settings. If ST runs in Docker/WSL, `127.0.0.1`
inside the container is *not* your host — use `host.docker.internal:8090` or the LAN IP.

**Status shows "comfy-studio up, ComfyUI offline".**
The service is running but its upstream ComfyUI (`http://127.0.0.1:8188`) is not reachable. Start
ComfyUI; generation will 503 until then. The extension never starts/stops ComfyUI itself.

**"unknown model '…': no family named '…'".**
The model id you picked is no longer in `models.json`. Click **↻ Reload** to re-read `/api/meta`, or
add the family to `models.json` on the service side.

**Generate button does nothing / "Prompt is empty".**
Pick a model (the list must be non-empty — see CORS above) and type a prompt.

**Progress bar stops at 0%.**
The job may be queued behind another job (the service uses a single worker). Use **Interrupt**, or
wait for the queue to drain. If ComfyUI is busy with its own UI work, generation slows down.

---

## Files

```text
manifest.json    ST extension manifest (display_name, loading_order, js, css, author, version, …)
index.js         the extension (no build step; entry point on window.ComfyStudioComposer)
style.css        styles, scoped under .csc-root, using ST theme vars with a warm-dark fallback
README.md        this file
dev/harness.html offline harness (real API, stubbed ST context)
dev/*.png        harness screenshots
```

## SillyTavern API surface used

All via the documented `SillyTavern` global (no relative imports, so the file loads both in
SillyTavern and in the plain-`<script>` harness):

- `SillyTavern.getContext()` → `extensionSettings`, `saveSettingsDebounced`, `eventSource`,
  `event_types`, `chat`, `characters`, `characterId`, `name1`, `name2`
- events: `APP_READY` (build the panel), `CHAT_CHANGED` (refresh history), `MESSAGE_SENT` /
  `MESSAGE_RECEIVED` (lightweight hook)
- settings container: `#extensions_settings2` (right column)
- chat input: `#send_textarea` (markdown insertion)

Sources: <https://docs.sillytavern.app/for-contributors/writing-extensions/> and the manifests of
official extensions ([Prompt Inspector](https://github.com/SillyTavern/Extension-PromptInspector),
[Quick Replies](https://github.com/SillyTavern/SillyTavern/blob/release/public/scripts/extensions/quick-reply/manifest.json),
[city-unit/st-extension-example](https://github.com/city-unit/st-extension-example)).

## License

AGPL-3.0 (matches SillyTavern's extension requirements).