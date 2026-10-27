# Comfy Studio Prompt Composer — SillyTavern extension

A SillyTavern **third-party UI extension** (classic layout, **no build step**, no npm) that adds a
robust image-prompt composer inside SillyTavern's Extensions drawer. It talks to your local
**comfy-studio** service (FastAPI in front of ComfyUI, default `http://127.0.0.1:8090`) and gives you:

- explicit **model / LoRA / sampler / scheduler / steps / cfg / size / batch / seed** control
- **LoRA rows** with weights; LoRAs the backend marks incompatible for the current model are greyed out
- an auto-growing **prompt** and **negative prompt** composer
- **"Pull character/scene context"** — one click prefills the prompt from the last N chat messages and
  the character card's appearance text (no LLM call, purely local)
- a **progress bar** polled from `/api/job/{id}` every ~800 ms, with the backend's error shown verbatim
- a **result thumbnail** with **Insert into chat** (appends `![generated image](url)` markdown to the
  chat input) and **Copy image URL**
- **prompt history** from `/api/history`, click a row to load its prompt + parameters back into the composer

---

## Install

The extension folder must live under SillyTavern's `data/<user-handle>/extensions/` (per-user) or
`public/scripts/extensions/third-party/` (all users).

### Option A — via SillyTavern's UI (recommended)

1. SillyTavern → **Extensions** → **Install extension**.
2. Paste the repository URL:

   ```
   https://github.com/mandybbuwu-coder/paper-lantern-composer-7q3f
   ```

   *(placeholder — replace with your real repo URL once you push this folder).*
3. Reload SillyTavern. The panel appears under **Extensions** → *Comfy Studio — Prompt Composer*.

### Option B — manual copy

Copy this whole folder into SillyTavern, keeping the folder name:

```text
<SillyTavern>/data/<your-handle>/extensions/st-comfy-studio-composer/
    manifest.json
    index.js
    style.css
    README.md
    dev/            (harness + relay — not needed at runtime)
```

Reload the page (F5).

---

## Settings

Open **Extensions** → *Comfy Studio — Prompt Composer*.

| Control | Meaning |
|---|---|
| **comfy-studio base URL** | Absolute base of the service. Default `http://127.0.0.1:8090`. **Change this here** — the browser calls it cross-origin from the SillyTavern origin, so the service must send CORS headers (see Troubleshooting). If ST runs in Docker/WSL, use `http://host.docker.internal:8090` or your LAN IP. |
| **Model** | Populated from `GET /api/meta`. Selecting a model re-fetches `GET /api/meta?model=<id>` (to recompute LoRA compatibility) and applies that model's defaults to steps/cfg/sampler/scheduler/size. |
| **LoRAs** | `+ Add LoRA` adds a row (name + weight). Incompatible entries are disabled/greyed. |
| **Sampler / Scheduler** | From `/api/meta` `samplers` / `schedulers`. |
| **Steps / CFG** | Sliders; persisted with the rest of your settings. |
| **Size** | Presets plus free width/height (multiples of 8). |
| **Batch / Seed** | `-1` = random; the dice button fills a concrete random seed. |
| **Generate / Interrupt** | Queues a job (`POST /api/generate`) and polls it; Interrupt calls `POST /api/interrupt`. |
| **Pull character/scene context** | Prefills the prompt from the last messages + character description. |

Everything is stored in `extensionSettings['comfy_studio_composer']` (persisted via
`saveSettingsDebounced()`), the documented persistent-settings mechanism.

`contextMessages` (default `3`) controls how many recent chat messages the context-pull uses. It is
in the settings object but has no UI control yet — edit it in `defaultSettings` in `index.js` if you
want a different default.

---

## Verification harness (`dev/`)

`dev/harness.html` runs the panel **outside SillyTavern** against the **real** comfy-studio API — it
does not fake any response. It stubs exactly the SillyTavern surface the extension uses
(`SillyTavern.getContext()` with `extensionSettings`, `saveSettingsDebounced`, `eventSource`,
`event_types`, `chat`, `characters`, `characterId`, `name1`, `name2`) plus `toastr` and the
`#extensions_settings2` / `#send_textarea` containers.

```bash
# From this folder. dev/relay.mjs serves the folder and relays /api/* to 127.0.0.1:8090.
node dev/relay.mjs 8091
# then open:
#   http://127.0.0.1:8091/dev/harness.html                 # full run (queues ONE real 512x512 / 8-step job)
#   http://127.0.0.1:8091/dev/harness.html?skipGenerate=1  # replay a real image from /api/history (no new job)
```

The harness asserts: panel renders; models load from `/api/meta`; the status line reports ComfyUI
online; a LoRA row populates from the catalog; context-pull prefills from chat; the payload targets
MOSS-Image at 512×512 / 8 steps; a **real generation** returns an image whose PNG decodes
(`naturalWidth > 0`); the result URL is absolute against the base; *Insert into chat* writes markdown
into `#send_textarea`; history loads from `/api/history`.

> **`dev/relay.mjs` is a DEV-ONLY verification shim.** It exists *only* because comfy-studio does not
> yet send CORS headers, so a page on a different origin cannot call it directly. The relay puts the
> harness and the API on the same origin and forwards **real** bytes/JSON from the live service — it
> never invents a response. Once comfy-studio enables CORS you can drop the relay and point the
> harness (or the panel) straight at `http://127.0.0.1:8090`.

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

While CORS is missing, only the `dev/relay.mjs` harness can reach the service from a browser page (it
serves the page and the API on the same origin).

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
dev/relay.mjs    dev-only same-origin relay for the harness
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
---

## Repo de este proyecto

- **Repo (público, cuenta desechable):** https://github.com/mandybbuwu-coder/paper-lantern-composer-7q3f
- **URL para SillyTavern (Install extension):**

  ```
  https://github.com/mandybbuwu-coder/paper-lantern-composer-7q3f
  ```

- **Actualizar:** editar los archivos aquí y ejecutar `~/st-push.sh "mensaje"`.
  El token del repo está en `~/.config/comfy-studio/github_token_mandybbuwu`
  (cuenta desechable, solo escribe en el repo de la extensión).
- **No pongas nada privado en este repo**: es público y el nombre es lo único
  que lo mantiene poco visible.
