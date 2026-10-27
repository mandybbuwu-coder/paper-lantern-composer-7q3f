/*
 * Comfy Studio Prompt Composer
 * -----------------------------------------------------------------------
 * SillyTavern third-party UI extension (classic layout, no build step).
 *
 * Adds a robust image-prompt composer inside SillyTavern's Extensions
 * drawer. The composer talks to a local "comfy-studio" service (FastAPI in
 * front of ComfyUI, default https://jose.tail7a8ecd.ts.net:10000) and offers:
 *   - explicit model / LoRA / sampler / scheduler / steps / cfg / size control
 *   - prompt history pulled from the backend
 *   - one-click insert of a generated image into the chat
 *   - "Pull character/scene context" to ground the prompt in the scene
 *
 * SillyTavern public API used (all via the documented `SillyTavern` global):
 *   SillyTavern.getContext() -> {
 *     extensionSettings, saveSettingsDebounced,
 *     eventSource, event_types, chat, characters, characterId, name2
 *   }
 *   - settings drawer container: #extensions_settings2   (right column, UI-related)
 *   - events: APP_READY, CHAT_CHANGED, MESSAGE_SENT, MESSAGE_RECEIVED
 * Source: https://docs.sillytavern.app/for-contributors/writing-extensions/
 *
 * The file intentionally contains NO import/export statements so that it can
 * be loaded both by SillyTavern (dynamic import) and by the offline harness
 * (plain <script>) without a bundler. Entry point is exposed on
 * window.ComfyStudioComposer.
 */

(function () {
    'use strict';

    const MODULE_NAME = 'comfy_studio_composer';
    const LOG = '[ComfyStudioComposer]';
    const DEFAULT_BASE_URL = 'https://jose.tail7a8ecd.ts.net:10000';
    const POLL_INTERVAL_MS = 800;
    const ROOT_ID = 'csc_root';

    const defaultSettings = Object.freeze({
        baseUrl: DEFAULT_BASE_URL,
        contextMessages: 3,
        model: '',
        negative: 'blurry, worst quality, bad anatomy, watermark, jpeg artifacts',
        sampler: '',
        scheduler: '',
        steps: 25,
        cfg: 2.5,
        width: 1024,
        height: 1024,
        batch: 1,
        loras: [], // [{ name, weight, enabled }]
    });

    const SIZE_PRESETS = [
        { label: '512²', w: 512, h: 512 },
        { label: '768²', w: 768, h: 768 },
        { label: '832×1216', w: 832, h: 1216 },
        { label: '1216×832', w: 1216, h: 832 },
        { label: '1024²', w: 1024, h: 1024 },
    ];

    // Runtime UI state (never persisted).
    const ui = {
        meta: null,
        metaForModel: null,
        jobId: null,
        timer: null,
        imageRel: null,
        busy: false,
        built: false,
    };

    /* ------------------------------------------------------------------ */
    /* Context + settings                                                  */
    /* ------------------------------------------------------------------ */

    function getST() {
        const g = (typeof SillyTavern !== 'undefined') ? SillyTavern : (window.SillyTavern || null);
        if (!g || typeof g.getContext !== 'function') return null;
        try {
            return g.getContext();
        } catch (err) {
            console.error(LOG, 'getContext() failed', err);
            return null;
        }
    }

    function clone(value) {
        try {
            return (typeof structuredClone === 'function') ? structuredClone(value) : JSON.parse(JSON.stringify(value));
        } catch (err) {
            return JSON.parse(JSON.stringify(value));
        }
    }

    /**
     * Settings live in ST's extensionSettings (persisted with the rest of the
     * user settings). Falls back to an in-memory object so the panel still
     * works inside the offline harness.
     */
    function settingsStore() {
        const ctx = getST();
        if (ctx && ctx.extensionSettings && typeof ctx.extensionSettings === 'object') {
            if (!ctx.extensionSettings[MODULE_NAME]) ctx.extensionSettings[MODULE_NAME] = {};
            return ctx.extensionSettings[MODULE_NAME];
        }
        if (!window.__csc_settings) window.__csc_settings = {};
        return window.__csc_settings;
    }

    function getSettings() {
        const s = settingsStore();
        for (const key of Object.keys(defaultSettings)) {
            if (s[key] === undefined) s[key] = clone(defaultSettings[key]);
        }
        if (!Array.isArray(s.loras)) s.loras = [];
        return s;
    }

    function saveSettings() {
        const ctx = getST();
        if (ctx && typeof ctx.saveSettingsDebounced === 'function') {
            try {
                ctx.saveSettingsDebounced();
            } catch (err) {
                console.warn(LOG, 'saveSettingsDebounced failed', err);
            }
        }
    }

    function toast(kind, message) {
        try {
            if (window.toastr && typeof window.toastr[kind] === 'function') {
                window.toastr[kind](message);
                return;
            }
            if (window.toastr && typeof window.toastr.info === 'function') {
                window.toastr.info(message);
                return;
            }
        } catch (err) {
            /* ignore */
        }
        console.log(LOG, `[${kind}]`, message);
    }

    /* ------------------------------------------------------------------ */
    /* HTTP layer against comfy-studio                                     */
    /* ------------------------------------------------------------------ */

    function baseUrl() {
        const raw = String(getSettings().baseUrl || DEFAULT_BASE_URL);
        return raw.replace(/\/+$/, '');
    }

    function apiUrl(path) {
        return baseUrl() + path;
    }

    function absoluteUrl(rel) {
        if (!rel) return '';
        return /^https?:\/\//i.test(rel) ? rel : baseUrl() + (rel.startsWith('/') ? rel : '/' + rel);
    }

    /**
     * Fetch JSON from comfy-studio. On a non-2xx response the backend's JSON
     * `error` string is raised verbatim as the Error message.
     */
    async function apiFetch(path, options) {
        let res;
        try {
            res = await fetch(apiUrl(path), options);
        } catch (err) {
            const e = new Error(`Cannot reach comfy-studio at ${baseUrl()} — ${err && err.message ? err.message : 'network error'}`);
            e.offline = true;
            throw e;
        }

        const text = await res.text();
        let data = null;
        try {
            data = text ? JSON.parse(text) : null;
        } catch (err) {
            data = null;
        }

        if (!res.ok) {
            let msg = null;
            if (data && data.error) {
                msg = (typeof data.error === 'string') ? data.error : JSON.stringify(data.error);
            } else if (data && data.detail) {
                msg = (typeof data.detail === 'string') ? data.detail : JSON.stringify(data.detail);
            }
            const e = new Error(msg || text || `HTTP ${res.status}`);
            e.status = res.status;
            e.data = data;
            throw e;
        }

        if (data === null) {
            throw new Error(`Invalid JSON response from ${apiUrl(path)}`);
        }
        return data;
    }

    function normalizeLoras(list) {
        return (Array.isArray(list) ? list : []).map((item) => {
            if (typeof item === 'string') {
                return { name: item, compatible: true, note: '' };
            }
            if (item && typeof item === 'object') {
                const name = item.name || item.file || '';
                if (!name) return null;
                return {
                    name,
                    compatible: item.compatible !== false,
                    note: item.note || '',
                    trigger_words: item.trigger_words || '',
                };
            }
            return null;
        }).filter(Boolean);
    }

    /* ------------------------------------------------------------------ */
    /* Panel markup                                                        */
    /* ------------------------------------------------------------------ */

    function panelHtml() {
        const presetButtons = SIZE_PRESETS
            .map((p) => `<button class="csc-chip csc-size" data-w="${p.w}" data-h="${p.h}">${p.label}</button>`)
            .join('');

        return `
<div id="${ROOT_ID}" class="csc-root">
  <div class="inline-drawer">
    <div class="inline-drawer-toggle inline-drawer-header">
      <b>Comfy Studio — Prompt Composer</b>
      <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
    </div>
    <div class="inline-drawer-content">

      <div class="csc-section">
        <div class="csc-row csc-row-between">
          <span class="csc-status"><i id="csc_dot" class="csc-dot csc-dot-off"></i><span id="csc_status">connecting…</span></span>
          <button id="csc_reload" class="menu_button csc-btn-sm" title="Reload models / LoRAs from comfy-studio">↻ Reload</button>
        </div>
        <label class="csc-label" for="csc_baseurl">comfy-studio base URL</label>
        <input id="csc_baseurl" class="text_pole csc-input" type="text" value="${DEFAULT_BASE_URL}" placeholder="${DEFAULT_BASE_URL}">
        <div id="csc_warn" class="csc-warn" hidden></div>
      </div>

      <div class="csc-section">
        <div class="csc-row csc-row-between">
          <label class="csc-label" for="csc_prompt">Prompt</label>
          <button id="csc_pull" class="menu_button csc-btn-sm" title="Prefill from the last chat messages and character card">⤓ Pull character/scene context</button>
        </div>
        <textarea id="csc_prompt" class="text_pole csc-textarea csc-autogrow" rows="3" placeholder="Describe the image…"></textarea>

        <label class="csc-label" for="csc_negative">Negative prompt</label>
        <textarea id="csc_negative" class="text_pole csc-textarea csc-autogrow" rows="2" placeholder="What to avoid…"></textarea>
      </div>

      <div class="csc-section">
        <label class="csc-label" for="csc_model">Model</label>
        <select id="csc_model" class="text_pole csc-input"></select>

        <div class="csc-row csc-row-between csc-mt">
          <label class="csc-label">LoRAs</label>
          <button id="csc_add_lora" class="menu_button csc-btn-sm">+ Add LoRA</button>
        </div>
        <div id="csc_loras" class="csc-loras"></div>
      </div>

      <div class="csc-section csc-grid2">
        <div>
          <label class="csc-label" for="csc_sampler">Sampler</label>
          <select id="csc_sampler" class="text_pole csc-input"></select>
        </div>
        <div>
          <label class="csc-label" for="csc_scheduler">Scheduler</label>
          <select id="csc_scheduler" class="text_pole csc-input"></select>
        </div>
      </div>

      <div class="csc-section">
        <div class="csc-slider-row">
          <label class="csc-label" for="csc_steps">Steps</label>
          <input id="csc_steps" class="csc-range" type="range" min="1" max="60" step="1">
          <span id="csc_steps_val" class="csc-val">25</span>
        </div>
        <div class="csc-slider-row">
          <label class="csc-label" for="csc_cfg">CFG</label>
          <input id="csc_cfg" class="csc-range" type="range" min="0" max="20" step="0.1">
          <span id="csc_cfg_val" class="csc-val">2.5</span>
        </div>
      </div>

      <div class="csc-section">
        <label class="csc-label">Size</label>
        <div class="csc-chips">${presetButtons}</div>
        <div class="csc-grid2 csc-mt-sm">
          <div>
            <label class="csc-label csc-label-sm" for="csc_width">Width</label>
            <input id="csc_width" class="text_pole csc-input" type="number" min="64" max="2048" step="8">
          </div>
          <div>
            <label class="csc-label csc-label-sm" for="csc_height">Height</label>
            <input id="csc_height" class="text_pole csc-input" type="number" min="64" max="2048" step="8">
          </div>
        </div>
      </div>

      <div class="csc-section csc-grid2">
        <div>
          <label class="csc-label" for="csc_batch">Batch</label>
          <input id="csc_batch" class="text_pole csc-input" type="number" min="1" max="8" step="1">
        </div>
        <div>
          <label class="csc-label" for="csc_seed">Seed</label>
          <div class="csc-row csc-seed-row">
            <input id="csc_seed" class="text_pole csc-input" type="number" step="1" title="-1 = random">
            <button id="csc_seed_rand" class="menu_button csc-btn-sm" title="Randomize seed">🎲</button>
          </div>
        </div>
      </div>

      <div class="csc-section">
        <div class="csc-row csc-actions">
          <button id="csc_generate" class="menu_button csc-btn-primary">✦ Generate</button>
          <button id="csc_interrupt" class="menu_button" disabled>■ Interrupt</button>
        </div>
        <div class="csc-progress"><div id="csc_progress_fill" class="csc-progress-fill"></div></div>
        <div class="csc-row csc-row-between csc-progress-meta">
          <span id="csc_status_line" class="csc-status-line">idle</span>
          <span id="csc_progress_pct" class="csc-val">0%</span>
        </div>
        <div id="csc_error" class="csc-error" hidden></div>
      </div>

      <div class="csc-section">
        <label class="csc-label">Result</label>
        <div id="csc_result" class="csc-result" hidden>
          <img id="csc_result_img" class="csc-img" alt="generated image">
          <div class="csc-row csc-actions csc-mt-sm">
            <button id="csc_insert" class="menu_button csc-btn-primary">↧ Insert into chat</button>
            <button id="csc_copy" class="menu_button">⧉ Copy image URL</button>
          </div>
          <div id="csc_result_meta" class="csc-meta"></div>
        </div>
        <div id="csc_result_empty" class="csc-muted">No image yet.</div>
      </div>

      <div class="csc-section">
        <div class="csc-row csc-row-between">
          <label class="csc-label">History</label>
          <button id="csc_history_reload" class="menu_button csc-btn-sm">↻ Refresh</button>
        </div>
        <div id="csc_history" class="csc-history"><div class="csc-muted">—</div></div>
      </div>

    </div>
  </div>
</div>`;
    }

    /* ------------------------------------------------------------------ */
    /* Small DOM helpers                                                   */
    /* ------------------------------------------------------------------ */

    const $ = (id) => document.getElementById(id);

    function setError(message) {
        const el = $('csc_error');
        if (!el) return;
        if (!message) {
            el.hidden = true;
            el.textContent = '';
            return;
        }
        el.hidden = false;
        el.textContent = String(message);
    }

    function setStatusLine(text) {
        const el = $('csc_status_line');
        if (el) el.textContent = text;
    }

    function setProgress(fraction, statusText) {
        const pct = Math.max(0, Math.min(1, Number(fraction) || 0));
        const fill = $('csc_progress_fill');
        if (fill) fill.style.width = (pct * 100).toFixed(1) + '%';
        const label = $('csc_progress_pct');
        if (label) label.textContent = Math.round(pct * 100) + '%';
        if (statusText) setStatusLine(statusText);
    }

    function setBusy(busy) {
        ui.busy = busy;
        const gen = $('csc_generate');
        const intr = $('csc_interrupt');
        if (gen) {
            gen.disabled = busy;
            gen.textContent = busy ? '… Generating' : '✦ Generate';
        }
        if (intr) intr.disabled = !busy;
    }

    function autoGrow(el) {
        if (!el) return;
        el.style.height = 'auto';
        el.style.height = Math.min(el.scrollHeight, 320) + 'px';
    }

    /* ------------------------------------------------------------------ */
    /* Meta loading (models / samplers / schedulers / loras)               */
    /* ------------------------------------------------------------------ */

    function fillSelect(select, values, current, placeholder) {
        if (!select) return;
        select.innerHTML = '';
        if (placeholder) {
            const o = document.createElement('option');
            o.value = '';
            o.textContent = placeholder;
            select.appendChild(o);
        }
        (values || []).forEach((v) => {
            const o = document.createElement('option');
            o.value = typeof v === 'string' ? v : v.id;
            o.textContent = typeof v === 'string' ? v : (v.label || v.id);
            select.appendChild(o);
        });
        if (current != null && current !== '') select.value = String(current);
        if (!select.value && select.options.length) select.selectedIndex = 0;
    }

    async function refreshMeta(modelOverride) {
        const s = getSettings();
        const modelId = modelOverride || s.model || '';
        const dot = $('csc_dot');
        const status = $('csc_status');
        const warn = $('csc_warn');
        setError('');

        let meta;
        try {
            const path = modelId ? `/api/meta?model=${encodeURIComponent(modelId)}` : '/api/meta';
            meta = await apiFetch(path);
        } catch (err) {
            if (status) status.textContent = 'comfy-studio unreachable';
            if (dot) dot.className = 'csc-dot csc-dot-off';
            if (warn) {
                warn.hidden = false;
                warn.textContent = err.message;
            }
            return null;
        }

        ui.meta = meta;
        if (modelId) ui.metaForModel = meta;

        if (status) {
            status.textContent = meta.comfy_online ? 'ComfyUI online' : 'comfy-studio up, ComfyUI offline';
        }
        if (dot) dot.className = 'csc-dot ' + (meta.comfy_online ? 'csc-dot-on' : 'csc-dot-warn');

        if (warn) {
            const warnings = Array.isArray(meta.warnings) ? meta.warnings : [];
            if (warnings.length) {
                warn.hidden = false;
                warn.textContent = warnings.join(' · ');
            } else {
                warn.hidden = true;
                warn.textContent = '';
            }
        }

        // Models
        const models = Array.isArray(meta.models) ? meta.models : [];
        if (models.length && !models.some((m) => m.id === s.model)) {
            s.model = models[0].id;
            saveSettings();
        }
        const modelSelect = $('csc_model');
        if (modelSelect && !modelSelect.options.length) {
            fillSelect(modelSelect, models.map((m) => ({
                id: m.id,
                label: m.label ? `${m.label}${m.experimental ? ' (experimental)' : ''}` : m.id,
            })), s.model);
        }
        if (modelSelect && s.model) modelSelect.value = s.model;

        // Samplers / schedulers
        const samplerSelect = $('csc_sampler');
        const schedulerSelect = $('csc_scheduler');
        if (samplerSelect && !samplerSelect.options.length) {
            fillSelect(samplerSelect, meta.samplers || [], s.sampler || (meta.defaults && meta.defaults.sampler));
        }
        if (schedulerSelect && !schedulerSelect.options.length) {
            fillSelect(schedulerSelect, meta.schedulers || [], s.scheduler || (meta.defaults && meta.defaults.scheduler));
        }

        renderLoraRows(meta.loras);
        return meta;
    }

    async function applyModelDefaults(modelId, meta) {
        const s = getSettings();
        const model = (meta.models || []).find((m) => m.id === modelId) ||
            ((ui.meta && ui.meta.models) || []).find((m) => m.id === modelId);
        const defaults = (model && model.defaults) || {};
        if (typeof defaults.steps === 'number') s.steps = defaults.steps;
        if (typeof defaults.cfg === 'number') s.cfg = defaults.cfg;
        if (defaults.sampler) s.sampler = defaults.sampler;
        if (defaults.scheduler) s.scheduler = defaults.scheduler;
        if (typeof defaults.width === 'number') s.width = defaults.width;
        if (typeof defaults.height === 'number') s.height = defaults.height;
        saveSettings();
        syncFormFromSettings();
    }

    /* ------------------------------------------------------------------ */
    /* LoRA rows                                                           */
    /* ------------------------------------------------------------------ */

    function loraCatalog() {
        const source = (ui.metaForModel && ui.metaForModel.loras) || (ui.meta && ui.meta.loras) || [];
        return normalizeLoras(source);
    }

    function renderLoraRows(loraListOverride) {
        const container = $('csc_loras');
        if (!container) return;
        const s = getSettings();
        const catalog = loraListOverride ? normalizeLoras(loraListOverride) : loraCatalog();
        container.innerHTML = '';

        if (!s.loras.length) {
            const empty = document.createElement('div');
            empty.className = 'csc-muted';
            empty.textContent = 'No LoRAs added.';
            container.appendChild(empty);
            return;
        }

        s.loras.forEach((entry, index) => {
            const info = catalog.find((c) => c.name === entry.name);
            const compatible = info ? info.compatible !== false : true;

            const row = document.createElement('div');
            row.className = 'csc-lora-row' + (compatible ? '' : ' csc-lora-incompatible');
            row.dataset.index = String(index);

            const select = document.createElement('select');
            select.className = 'text_pole csc-input csc-lora-name';
            catalog.forEach((c) => {
                const o = document.createElement('option');
                o.value = c.name;
                o.textContent = c.compatible === false ? `${c.name} (incompatible)` : c.name;
                if (c.compatible === false) o.disabled = true;
                if (c.name === entry.name) o.selected = true;
                select.appendChild(o);
            });

            const weight = document.createElement('input');
            weight.type = 'number';
            weight.className = 'text_pole csc-input csc-lora-weight';
            weight.min = '0';
            weight.max = '2';
            weight.step = '0.05';
            weight.value = String(typeof entry.weight === 'number' ? entry.weight : 0.8);
            weight.title = 'LoRA weight';

            const remove = document.createElement('button');
            remove.className = 'menu_button csc-btn-sm csc-lora-remove';
            remove.textContent = '✕';
            remove.title = 'Remove LoRA';

            row.appendChild(select);
            row.appendChild(weight);
            row.appendChild(remove);
            container.appendChild(row);
        });
    }

    /* ------------------------------------------------------------------ */
    /* Form <-> settings sync                                              */
    /* ------------------------------------------------------------------ */

    function syncSettingsFromForm() {
        const s = getSettings();
        const v = (id) => { const el = $(id); return el ? el.value : undefined; };
        const n = (id, fallback) => { const x = Number(v(id)); return Number.isFinite(x) ? x : fallback; };

        s.baseUrl = String(v('csc_baseurl') || DEFAULT_BASE_URL).trim().replace(/\/+$/, '') || DEFAULT_BASE_URL;
        s.model = v('csc_model') || s.model;
        s.negative = v('csc_negative') || '';
        s.sampler = v('csc_sampler') || '';
        s.scheduler = v('csc_scheduler') || '';
        s.steps = n('csc_steps', s.steps);
        s.cfg = n('csc_cfg', s.cfg);
        s.width = n('csc_width', s.width);
        s.height = n('csc_height', s.height);
        s.batch = n('csc_batch', s.batch);
        saveSettings();
    }

    function syncFormFromSettings() {
        const s = getSettings();
        const set = (id, val) => { const el = $(id); if (el != null && val != null) el.value = String(val); };
        set('csc_baseurl', s.baseUrl);
        set('csc_negative', s.negative);
        if ($('csc_model')) $('csc_model').value = s.model;
        set('csc_sampler', s.sampler);
        set('csc_scheduler', s.scheduler);
        set('csc_steps', s.steps);
        set('csc_cfg', s.cfg);
        set('csc_width', s.width);
        set('csc_height', s.height);
        set('csc_batch', s.batch);
        const stepsVal = $('csc_steps_val'); if (stepsVal) stepsVal.textContent = String(s.steps);
        const cfgVal = $('csc_cfg_val'); if (cfgVal) cfgVal.textContent = String(s.cfg);
        renderLoraRows();
    }

    /* ------------------------------------------------------------------ */
    /* Generate + poll                                                      */
    /* ------------------------------------------------------------------ */

    function collectPayload() {
        const s = getSettings();
        const seedRaw = $('csc_seed') ? $('csc_seed').value : '';
        const seed = seedRaw === '' ? -1 : Number(seedRaw);
        const loras = s.loras
            .filter((l) => l && l.name && l.enabled !== false)
            .map((l) => ({ name: l.name, weight: Number.isFinite(Number(l.weight)) ? Number(l.weight) : 0.8 }));

        return {
            mode: 'txt2img',
            prompt: ($('csc_prompt') ? $('csc_prompt').value : '') || '',
            negative: s.negative || '',
            model: s.model || '',
            sampler: s.sampler || '',
            scheduler: s.scheduler || '',
            steps: s.steps,
            cfg: s.cfg,
            width: s.width,
            height: s.height,
            seed: Number.isFinite(seed) ? seed : -1,
            batch: s.batch,
            loras,
        };
    }

    async function generate() {
        if (ui.busy) return;
        syncSettingsFromForm();
        const payload = collectPayload();

        if (!payload.model) {
            setError('Pick a model first (comfy-studio returned no models).');
            return;
        }
        if (!payload.prompt.trim()) {
            setError('Prompt is empty.');
            return;
        }

        setError('');
        setProgress(0, 'queued');
        setBusy(true);
        clearResult();

        let res;
        try {
            res = await apiFetch('/api/generate', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload),
            });
        } catch (err) {
            // `err.message` is the backend's JSON `error` string, verbatim.
            setError(err.message);
            setStatusLine('error');
            setBusy(false);
            toast('error', err.message);
            return;
        }

        if (!res || !res.job_id) {
            setError('comfy-studio did not return a job_id.');
            setBusy(false);
            return;
        }

        toast('success', 'Job queued: ' + res.job_id);
        pollJob(res.job_id);
    }

    function pollJob(jobId) {
        ui.jobId = jobId;
        const tick = async () => {
            if (ui.jobId !== jobId) return; // superseded
            let job;
            try {
                job = await apiFetch('/api/job/' + encodeURIComponent(jobId));
            } catch (err) {
                setError(err.message);
                setStatusLine('polling failed');
                setBusy(false);
                return;
            }

            setProgress(job.progress || 0, job.status || 'running');

            if (job.status === 'done') {
                onJobDone(job);
                return;
            }
            if (job.status === 'error') {
                setProgress(1, 'error');
                setError(job.error ? String(job.error) : 'Generation failed.');
                setBusy(false);
                refreshHistory();
                return;
            }
            ui.timer = setTimeout(tick, POLL_INTERVAL_MS);
        };
        ui.timer = setTimeout(tick, POLL_INTERVAL_MS);
    }

    function onJobDone(job) {
        setBusy(false);
        setProgress(1, 'done');
        const images = Array.isArray(job.images) ? job.images : [];
        if (!images.length) {
            setError('Job finished but returned no images.');
            return;
        }
        const rel = images[0];
        ui.imageRel = rel;
        const abs = absoluteUrl(rel);
        const result = $('csc_result');
        const empty = $('csc_result_empty');
        const img = $('csc_result_img');
        if (img) img.src = abs + (abs.includes('?') ? '&' : '?') + 't=' + Date.now();
        if (result) result.hidden = false;
        if (empty) empty.hidden = true;
        const metaEl = $('csc_result_meta');
        if (metaEl) metaEl.textContent = `seed ${job.seed != null ? job.seed : '?'}${job.item_id ? ' · item ' + job.item_id : ''}`;
        toast('success', 'Image ready.');
        refreshHistory();
    }

    function clearResult() {
        const result = $('csc_result');
        if (result) result.hidden = true;
        const empty = $('csc_result_empty');
        if (empty) empty.hidden = false;
        ui.imageRel = null;
    }

    async function interrupt() {
        try {
            await apiFetch('/api/interrupt', { method: 'POST' });
            toast('warning', 'Interrupt requested.');
        } catch (err) {
            setError(err.message);
        }
    }

    /* ------------------------------------------------------------------ */
    /* Insert into chat / copy                                             */
    /* ------------------------------------------------------------------ */

    function insertIntoChat() {
        if (!ui.imageRel) return;
        const abs = absoluteUrl(ui.imageRel);
        const markdown = `![generated image](${abs})`;
        // Documented ST chat input element. Append as markdown, then let ST
        // pick up the change like a normal edit.
        const textarea = document.getElementById('send_textarea');
        if (textarea) {
            const current = textarea.value || '';
            textarea.value = current.length ? current.replace(/\s*$/, '') + '\n' + markdown : markdown;
            textarea.dispatchEvent(new Event('input', { bubbles: true }));
            try {
                textarea.focus();
            } catch (err) { /* ignore */ }
            toast('success', 'Inserted into the chat input.');
        } else {
            copyUrl();
            toast('warning', 'No chat input found — image URL copied instead.');
        }
    }

    async function copyUrl() {
        if (!ui.imageRel) return;
        const abs = absoluteUrl(ui.imageRel);
        try {
            if (navigator.clipboard && navigator.clipboard.writeText) {
                await navigator.clipboard.writeText(abs);
            } else {
                const tmp = document.createElement('textarea');
                tmp.value = abs;
                document.body.appendChild(tmp);
                tmp.select();
                document.execCommand('copy');
                document.body.removeChild(tmp);
            }
            toast('success', 'Image URL copied.');
        } catch (err) {
            setError('Copy failed: ' + err.message);
        }
    }

    /* ------------------------------------------------------------------ */
    /* Pull character / scene context                                      */
    /* ------------------------------------------------------------------ */

    function pullContext() {
        const ctx = getST();
        const promptEl = $('csc_prompt');
        if (!promptEl) return;

        const n = Math.max(1, Math.min(10, Number(getSettings().contextMessages) || 3));
        const name2 = (ctx && ctx.name2) ? ctx.name2 : 'the character';
        const chat = (ctx && Array.isArray(ctx.chat)) ? ctx.chat : [];

        const parts = [];
        parts.push(`${name2} — portrait, cinematic lighting, highly detailed`);

        if (ctx && typeof ctx.characterId === 'number' && Array.isArray(ctx.characters)) {
            const character = ctx.characters[ctx.characterId];
            const desc = character && character.description ? String(character.description) : '';
            if (desc.trim()) {
                parts.push('Appearance: ' + desc.replace(/\s+/g, ' ').trim().slice(0, 240));
            }
        }

        const recent = chat.slice(-n);
        if (!recent.length) {
            parts.push('Scene: (no chat messages yet)');
        }
        recent.forEach((msg) => {
            const text = msg && msg.mes ? String(msg.mes).replace(/\s+/g, ' ').trim() : '';
            if (!text) return;
            const who = msg.is_user ? (ctx && ctx.name1 ? ctx.name1 : 'User') : name2;
            parts.push(`${who}: ${text.slice(0, 220)}`);
        });

        const composed = parts.join('\n');
        promptEl.value = composed;
        window.__csc_prompt_value = composed;
        autoGrow(promptEl);
        saveSettings();
        toast('success', 'Scene context pulled into the prompt.');
    }

    /* ------------------------------------------------------------------ */
    /* History                                                             */
    /* ------------------------------------------------------------------ */

    async function refreshHistory() {
        const container = $('csc_history');
        if (!container) return;
        let data;
        try {
            data = await apiFetch('/api/history?limit=8');
        } catch (err) {
            container.innerHTML = '';
            const d = document.createElement('div');
            d.className = 'csc-muted';
            d.textContent = 'History unavailable: ' + err.message;
            container.appendChild(d);
            return;
        }

        const items = (data && Array.isArray(data.items)) ? data.items : [];
        container.innerHTML = '';
        if (!items.length) {
            const d = document.createElement('div');
            d.className = 'csc-muted';
            d.textContent = 'No history yet.';
            container.appendChild(d);
            return;
        }

        items.forEach((item) => {
            const row = document.createElement('div');
            row.className = 'csc-history-item';
            row.title = 'Click to load this prompt back into the composer';

            const thumb = document.createElement('img');
            thumb.className = 'csc-history-thumb';
            thumb.loading = 'lazy';
            thumb.alt = '';
            if (item.images && item.images[0]) thumb.src = absoluteUrl(item.images[0]);

            const body = document.createElement('div');
            body.className = 'csc-history-body';
            const p = document.createElement('div');
            p.className = 'csc-history-prompt';
            p.textContent = item.prompt || '(no prompt)';
            const meta = document.createElement('div');
            meta.className = 'csc-muted csc-history-meta';
            const params = item.params || {};
            meta.textContent = `${item.family || '?'} · ${params.width || '?'}×${params.height || '?'} · ${params.steps || '?'} steps · seed ${params.seed != null ? params.seed : '?'}`;
            body.appendChild(p);
            body.appendChild(meta);

            row.appendChild(thumb);
            row.appendChild(body);

            row.addEventListener('click', () => loadHistoryItem(item));

            const useBtn = document.createElement('button');
            useBtn.className = 'menu_button csc-btn-sm';
            useBtn.textContent = '↧ Use';
            useBtn.addEventListener('click', (ev) => {
                ev.stopPropagation();
                loadHistoryItem(item);
            });
            row.appendChild(useBtn);

            container.appendChild(row);
        });
    }

    function loadHistoryItem(item) {
        const s = getSettings();
        const params = item.params || {};
        const promptEl = $('csc_prompt');
        if (promptEl) {
            promptEl.value = item.prompt || '';
            autoGrow(promptEl);
        }
        if ($('csc_negative')) $('csc_negative').value = item.negative || '';
        if (params.model && $('csc_model')) {
            s.model = params.model;
            $('csc_model').value = params.model;
        }
        if (params.sampler && $('csc_sampler')) { s.sampler = params.sampler; $('csc_sampler').value = params.sampler; }
        if (params.scheduler && $('csc_scheduler')) { s.scheduler = params.scheduler; $('csc_scheduler').value = params.scheduler; }
        if (typeof params.steps === 'number' && $('csc_steps')) { s.steps = params.steps; $('csc_steps').value = params.steps; $('csc_steps_val').textContent = params.steps; }
        if (typeof params.cfg === 'number' && $('csc_cfg')) { s.cfg = params.cfg; $('csc_cfg').value = params.cfg; $('csc_cfg_val').textContent = params.cfg; }
        if (typeof params.width === 'number' && $('csc_width')) { s.width = params.width; $('csc_width').value = params.width; }
        if (typeof params.height === 'number' && $('csc_height')) { s.height = params.height; $('csc_height').value = params.height; }
        if (params.seed != null && $('csc_seed')) $('csc_seed').value = params.seed;
        if (Array.isArray(params.loras)) {
            s.loras = params.loras.map((l) => ({ name: l.name, weight: l.weight, enabled: true }));
            renderLoraRows();
        }
        if (item.images && item.images[0]) {
            ui.imageRel = item.images[0];
            const abs = absoluteUrl(ui.imageRel);
            if ($('csc_result_img')) $('csc_result_img').src = abs;
            if ($('csc_result')) $('csc_result').hidden = false;
            if ($('csc_result_empty')) $('csc_result_empty').hidden = true;
        }
        saveSettings();
        toast('success', 'Loaded prompt from history.');
    }

    /* ------------------------------------------------------------------ */
    /* Wiring                                                              */
    /* ------------------------------------------------------------------ */

    function bindEvents() {
        const s = getSettings();

        // Base URL
        const baseEl = $('csc_baseurl');
        if (baseEl) {
            baseEl.value = s.baseUrl;
            baseEl.addEventListener('change', async () => {
                syncSettingsFromForm();
                await refreshMeta();
            });
        }

        // Model
        const modelSelect = $('csc_model');
        if (modelSelect) {
            modelSelect.addEventListener('change', async () => {
                s.model = modelSelect.value;
                saveSettings();
                const meta = await refreshMeta(s.model);
                const model = ((meta && meta.models) || (ui.meta && ui.meta.models) || []).find((m) => m.id === s.model);
                if (model && model.defaults) await applyModelDefaults(s.model, meta || ui.meta);
                renderLoraRows(meta ? meta.loras : undefined);
            });
        }

        // Sliders
        const steps = $('csc_steps');
        const cfg = $('csc_cfg');
        if (steps) {
            steps.value = String(s.steps);
            const v = $('csc_steps_val'); if (v) v.textContent = String(s.steps);
            steps.addEventListener('input', () => {
                if (v) v.textContent = steps.value;
                s.steps = Number(steps.value);
                saveSettings();
            });
        }
        if (cfg) {
            cfg.value = String(s.cfg);
            const v = $('csc_cfg_val'); if (v) v.textContent = String(s.cfg);
            cfg.addEventListener('input', () => {
                if (v) v.textContent = cfg.value;
                s.cfg = Number(cfg.value);
                saveSettings();
            });
        }

        // Auto-grow textareas
        document.querySelectorAll('.csc-autogrow').forEach((el) => {
            el.addEventListener('input', () => autoGrow(el));
            autoGrow(el);
        });

        // Size presets + numeric fields
        document.querySelectorAll('.csc-size').forEach((btn) => {
            btn.addEventListener('click', () => {
                const w = Number(btn.dataset.w);
                const h = Number(btn.dataset.h);
                if ($('csc_width')) $('csc_width').value = w;
                if ($('csc_height')) $('csc_height').value = h;
                s.width = w; s.height = h; saveSettings();
                document.querySelectorAll('.csc-size').forEach((b) => b.classList.toggle('csc-chip-active', b === btn));
            });
        });

        // Seed
        const seedRand = $('csc_seed_rand');
        if (seedRand) {
            seedRand.addEventListener('click', () => {
                const val = Math.floor(Math.random() * 2147483647);
                if ($('csc_seed')) $('csc_seed').value = val;
            });
        }

        // LoRA add / remove / edit (delegated)
        const addLora = $('csc_add_lora');
        if (addLora) {
            addLora.addEventListener('click', () => {
                const catalog = loraCatalog();
                const first = catalog.find((c) => c.compatible !== false) || catalog[0];
                s.loras.push({ name: first ? first.name : '', weight: 0.8, enabled: true });
                saveSettings();
                renderLoraRows();
            });
        }
        const lorasContainer = $('csc_loras');
        if (lorasContainer) {
            lorasContainer.addEventListener('change', (ev) => {
                const row = ev.target.closest('.csc-lora-row');
                if (!row) return;
                const index = Number(row.dataset.index);
                if (ev.target.classList.contains('csc-lora-name')) s.loras[index].name = ev.target.value;
                if (ev.target.classList.contains('csc-lora-weight')) s.loras[index].weight = Number(ev.target.value);
                saveSettings();
                renderLoraRows();
            });
            lorasContainer.addEventListener('click', (ev) => {
                const row = ev.target.closest('.csc-lora-row');
                if (!row || !ev.target.classList.contains('csc-lora-remove')) return;
                s.loras.splice(Number(row.dataset.index), 1);
                saveSettings();
                renderLoraRows();
            });
        }

        // Actions
        const gen = $('csc_generate');
        if (gen) gen.addEventListener('click', generate);
        const intr = $('csc_interrupt');
        if (intr) intr.addEventListener('click', interrupt);
        const pull = $('csc_pull');
        if (pull) pull.addEventListener('click', pullContext);
        const insert = $('csc_insert');
        if (insert) insert.addEventListener('click', insertIntoChat);
        const copy = $('csc_copy');
        if (copy) copy.addEventListener('click', copyUrl);
        const reload = $('csc_reload');
        if (reload) reload.addEventListener('click', () => refreshMeta());
        const histReload = $('csc_history_reload');
        if (histReload) histReload.addEventListener('click', refreshHistory);
    }

    function bindSTEvents() {
        const ctx = getST();
        if (!ctx || !ctx.eventSource || !ctx.event_types) return;
        const { eventSource, event_types } = ctx;

        const onChatChanged = () => {
            // Chat switched: refresh history is cheap and keeps the panel honest.
            refreshHistory().catch(() => {});
        };
        const onMessage = () => {
            // Keep a lightweight hook so the panel can be refreshed on demand;
            // no automatic generation is triggered here.
            window.__csc_last_message_ts = Date.now();
        };

        try {
            eventSource.on(event_types.CHAT_CHANGED, onChatChanged);
            eventSource.on(event_types.MESSAGE_RECEIVED, onMessage);
            eventSource.on(event_types.MESSAGE_SENT, onMessage);
            if (event_types.APP_READY) eventSource.on(event_types.APP_READY, () => {
                buildPanel();
                refreshHistory().catch(() => {});
            });
        } catch (err) {
            console.warn(LOG, 'could not bind ST events', err);
        }
    }

    async function buildPanel() {
        if (ui.built && document.getElementById(ROOT_ID)) return;
        const container = document.getElementById('extensions_settings2') || document.getElementById('extensions_settings');
        if (!container) {
            console.warn(LOG, 'settings container not found; waiting.');
            return;
        }
        container.insertAdjacentHTML('beforeend', panelHtml());
        ui.built = true;
        bindEvents();
        autoGrow($('csc_prompt'));
        autoGrow($('csc_negative'));
        const meta = await refreshMeta();
        if (meta) syncFormFromSettings();
        refreshHistory().catch(() => {});
    }

    function init() {
        const ctx = getST();
        if (ctx) {
            getSettings();
            bindSTEvents();
        }
        // If ST already rendered its settings drawer, build immediately;
        // otherwise APP_READY builds it later.
        if (document.getElementById('extensions_settings2') || document.getElementById('extensions_settings')) {
            buildPanel();
        }
        console.log(LOG, 'extension loaded');
    }

    // Expose for the offline harness and for console debugging.
    window.ComfyStudioComposer = {
        init,
        buildPanel,
        refreshMeta,
        refreshHistory,
        generate,
        collectPayload,
        syncSettingsFromForm,
        syncFormFromSettings,
        pullContext,
        insertIntoChat,
        absoluteUrl,
        getSettings,
        _ui: ui,
    };

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();