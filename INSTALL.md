# Install: comfy-studio prompt composer for SillyTavern (phone)

The extension lives in this repo and talks to your PC over the Tailscale funnel.
Two ways to get the repo up. Option A needs no git at all.

---

## Option A — web upload (no git, ~3 minutes)

1. Create the throwaway GitHub account, verify the email.
2. **New repository**:
   - Name: `paper-lantern-composer-7q3f`  (or another random name you keep to yourself)
   - **Public** (ST cannot clone private repos without a token, and a token in the URL
     ends up in ST's server log)
   - Do **not** add a README/gitignore/license; keep it empty.
   - Leave description empty, add **no topics**. After creating it, in Settings turn
     **off** Issues / Discussions / Wiki / Projects, and disable "Allow forking".
3. On the new repo page: **Add file → Upload files**, drag these four files
   (`manifest.json`, `index.js`, `style.css`, `README.md`), then **Commit changes**.
   The files must be at the repo root, not inside a folder.
4. In SillyTavern (phone) → **Extensions → Install extension** and paste:

   ```
   https://github.com/mandybbuwu-coder/paper-lantern-composer-7q3f
   ```

   Confirm the third-party warning. The panel appears under
   **Extensions settings → Comfy Studio — Prompt Composer**.

> A public repo is indexed by GitHub and searchable by its exact name, and it shows
> on the account profile. That is obscurity, not privacy: the random name is what keeps
> it unlisted, so do not reuse it or mention it in a public post.

---

## Option B — git on the PC (you already have `gh` logged in)

```bash
cd C:/Users/jarco/st-comfy-composer
gh repo create paper-lantern-composer-7q3f --public --source=. --remote=origin --push
```

Then install in ST with the same URL as above.
To use a different account: `gh auth login` and repeat.

---

## After installing (both options)

1. Extensions settings → **Comfy Studio — Prompt Composer** → **COMFY-STUDIO BASE URL**.
   The default is already your funnel:

   ```
   https://jose.tail7a8ecd.ts.net:10000
   ```

   On a PC you can switch it to `http://127.0.0.1:8090`.
2. Press **Test** — it must say the service is online and list your models.
3. Pick the model: `MOSS-Image · pornmasterMoss_v1`.
4. Write the prompt, press **Generate**. The image appears in RESULT; use
   **Insert into chat** to put it in the chat box.

## Requirements on the PC

- ComfyUI running (`http://127.0.0.1:8188/system_stats` answers).
- comfy-studio running: `C:\Users\jarco\comfy-studio\start-hidden.cmd`
- Both served by the funnel: `tailscale funnel status` must list `:10000 → 127.0.0.1:8090`.

## If it fails

| Symptom | Cause | Fix |
|---|---|---|
| "Cannot reach comfy-studio" | funnel off or app down | `tailscale funnel status`; run `start-hidden.cmd` |
| Empty model list | `/api/meta` returned no models | open `https://jose.tail7a8ecd.ts.net:10000/api/meta` in the phone browser |
| 400 "unknown lora" | a stale LoRA is still in the stack | remove the LoRA row and re-add it |
| Image generates but Insert does nothing | ST input selector changed | use **Copy image URL** and paste it |
| Blocked by CORS (console) | ST served from an origin the API doesn't allow | tell the PC side; the allowlist lives in `app.py` |

## Updates

`manifest.json` has `auto_update: false`. To update, re-upload the changed files to
GitHub and press **Update** on the extension in ST (ST does a `git pull`).
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
