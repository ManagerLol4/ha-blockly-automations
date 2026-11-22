/* Editor-Logik: lädt Automationen über die HA-API, zeigt sie mit HAB als
 * Blöcke an und speichert sie zurück. Gespeichert wird nur, wenn die
 * Darstellung beim Laden nachweislich verlustfrei war.
 * Links: Liste wie im ioBroker-Skripteditor – Ordner = HA-Kategorien. */
(function () {
  "use strict";
  const $ = (id) => document.getElementById(id);
  const S = {
    hass: null, ws: null, id: null, original: null, lossless: true, busy: false, isNew: false,
    cats: [], regCat: {}, pendingCat: null, listKey: "", search: "",
  };
  const NO_CAT = "__none__";

  // ---------- Daten aus HA für Felder und Vorschläge ----------
  const loc = (key) => { try { return (S.hass.localize && S.hass.localize(key)) || ""; } catch (e) { return ""; } };
  const fname = (st) => (st && st.attributes && st.attributes.friendly_name) || "";
  HAB.hooks.entityName = (eid) => {
    const st = S.hass && typeof eid === "string" && S.hass.states[eid.split(",")[0].trim()];
    return st ? "· " + fname(st) : "";
  };
  HAB.hooks.entities = (domains) => {
    if (!S.hass) return [];
    return Object.values(S.hass.states)
      .filter((s) => !domains || !domains.length || domains.includes(s.entity_id.split(".")[0]))
      .map((s) => [s.entity_id, fname(s)])
      .sort((a, b) => (a[1] || a[0]).localeCompare(b[1] || b[0], "de"));
  };
  const DOMAIN_STATES = {
    binary_sensor: ["on", "off"], switch: ["on", "off"], light: ["on", "off"], fan: ["on", "off"],
    input_boolean: ["on", "off"], automation: ["on", "off"], script: ["on", "off"], remote: ["on", "off"],
    person: ["home", "not_home"], device_tracker: ["home", "not_home"],
    cover: ["open", "closed", "opening", "closing"], lock: ["locked", "unlocked", "jammed", "open"],
    media_player: ["playing", "paused", "idle", "on", "off", "standby"],
    vacuum: ["cleaning", "docked", "returning", "idle", "paused", "error"],
    alarm_control_panel: ["disarmed", "armed_home", "armed_away", "armed_night", "triggered"],
    sun: ["above_horizon", "below_horizon"], climate: ["heat", "cool", "auto", "off"],
  };
  HAB.hooks.states = (eid) => {
    if (!S.hass) return [];
    const st = S.hass.states[eid];
    const dom = (eid || "").split(".")[0];
    const out = new Set();
    if (st) out.add(st.state);
    for (const v of DOMAIN_STATES[dom] || []) out.add(v);
    if (st && Array.isArray(st.attributes.options)) st.attributes.options.forEach((o) => out.add(String(o)));
    if (st && Array.isArray(st.attributes.hvac_modes)) st.attributes.hvac_modes.forEach((o) => out.add(String(o)));
    out.add("unavailable"); out.add("unknown");
    return [...out].map((s) => [s, loc(`component.${dom}.entity_component._.state.${s}`)]);
  };
  HAB.hooks.services = () => {
    if (!S.hass) return [];
    const out = [];
    for (const [d, svcs] of Object.entries(S.hass.services))
      for (const s of Object.keys(svcs)) out.push([`${d}.${s}`, loc(`component.${d}.services.${s}.name`)]);
    return out.sort((a, b) => a[0].localeCompare(b[0]));
  };
  const svcDef = (svc) => {
    if (!S.hass || typeof svc !== "string" || !svc.includes(".")) return null;
    const [d, s] = svc.split(".");
    return (S.hass.services[d] && S.hass.services[d][s]) || null;
  };
  HAB.hooks.serviceFields = (svc) => {
    const def = svcDef(svc);
    if (!def) return null;
    const [d, s] = svc.split(".");
    const named = (fields) => {
      const o = {};
      for (const [k, f] of Object.entries(fields || {})) {
        o[k] = f && f.fields ? { ...f, fields: named(f.fields) } : { ...f, name: loc(`component.${d}.services.${s}.fields.${k}.name`) || (f && f.name) || k };
      }
      return o;
    };
    return named(def.fields);
  };
  HAB.hooks.serviceName = (svc) => {
    if (!svcDef(svc)) return "";
    const [d, s] = svc.split(".");
    const n = loc(`component.${d}.services.${s}.name`);
    return n ? "· " + n : "";
  };
  HAB.hooks.serviceTarget = (svc) => { const def = svcDef(svc); return def ? !!def.target : null; };

  // Eigenschaften im nativen HA-Dialog bearbeiten (stellt das Panel bereit).
  HAB.hooks.openEditor = async (block) => {
    if (!block || block.isInFlyout || block.isDisposed()) return;
    const fn = parent.__haBlocklyEditItem;
    const item = HAB.blockToItem(block);
    const title = String(block.spec_ && block.spec_.title || "Eigenschaften").replace(/\s*\(deaktiviert\)$/, "");
    if (!fn) { block.select(); showSide(); return; }
    Blockly.hideChaff();
    const res = await fn(block.haKind_, item, title);
    if (res === undefined) {
      status("HA-Dialog nicht verfügbar – Bearbeitung über das JSON-Feld rechts.", "warn");
      block.select(); showSide(); return;
    }
    if (res && !block.isDisposed() && !HAB.deepEqual(res, item)) replaceBlock(block, res);
  };

  HAB.defineBlocks(Blockly);

  function status(text, cls = "") {
    const el = $("status");
    el.textContent = text;
    el.className = cls;
  }
  const errText = (e) => (e && ((e.body && e.body.message) || e.message)) || String(e);

  function api(method, id, body) {
    return S.hass.callApi(method, `config/automation/config/${encodeURIComponent(id)}`, body);
  }

  function store(key, val) {
    try { if (val === undefined) return localStorage.getItem(key); localStorage.setItem(key, val); } catch (e) { return null; }
    return null;
  }

  // ---------- Workspace ----------
  function initWorkspace() {
    const dark = !!(S.hass.themes && S.hass.themes.darkMode);
    document.documentElement.dataset.theme = dark ? "dark" : "light";
    const theme = dark
      ? Blockly.Theme.defineTheme("haDark", {
          base: Blockly.Themes.Classic,
          componentStyles: {
            workspaceBackgroundColour: "#111111", toolboxBackgroundColour: "#1c1c1c",
            toolboxForegroundColour: "#e1e1e1", flyoutBackgroundColour: "#222222",
            flyoutForegroundColour: "#dddddd", flyoutOpacity: 1, scrollbarColour: "#555555",
            insertionMarkerColour: "#ffffff", insertionMarkerOpacity: 0.3, cursorColour: "#d0d0d0",
          },
        })
      : Blockly.Themes.Classic;
    S.ws = Blockly.inject($("ws"), {
      toolbox: HAB.buildToolbox(),
      media: "vendor/media/",
      renderer: "zelos",
      theme,
      trashcan: true,
      sounds: false,
      grid: { spacing: 24, length: 2, colour: dark ? "#2a2a2a" : "#e6e6e6", snap: false },
      zoom: { controls: true, wheel: false, startScale: 0.8, maxScale: 2, minScale: 0.3 },
      move: { scrollbars: true, drag: true, wheel: true },
    });
    S.ws.addChangeListener((e) => {
      if (e.type === Blockly.Events.SELECTED) updateSide();
      if (!e.isUiEvent && !S.busy) { updateStatus(); updateSide(); }
      // Dienst gewechselt: Block mit den Feldern des neuen Dienstes neu aufbauen.
      if (e.type === Blockly.Events.BLOCK_CHANGE && e.element === "field" && !S.busy) {
        const b = S.ws.getBlockById(e.blockId);
        if (b && b.serviceField_ === e.name && HAB.hooks.serviceFields(e.newValue)) {
          setTimeout(() => { if (!b.isDisposed()) replaceBlock(b, HAB.blockToItem(b)); }, 0);
        }
      }
      // Name in der Kopfzeile mitführen.
      if (e.type === Blockly.Events.BLOCK_CHANGE && !S.busy) updateTitle();
    });
  }

  function rootBlock(ws = S.ws) {
    return ws.getBlocksByType("ha_root", false)[0] || null;
  }

  function currentConfig(ws = S.ws) {
    const r = rootBlock(ws);
    return r ? HAB.blockToItem(r) : null;
  }

  function loadIntoWorkspace(ws, cfg) {
    const json = HAB.itemToBlockJson("root", cfg);
    json.x = 20; json.y = 20;
    Blockly.Events.disable();
    try {
      ws.clear();
      Blockly.serialization.workspaces.load({ blocks: { languageVersion: 0, blocks: [json] } }, ws);
    } finally {
      Blockly.Events.enable();
    }
  }

  function showRoot() {
    const r = rootBlock();
    if (r) S.ws.scrollBoundsIntoView(r.getBoundingRectangleWithoutChildren());
  }

  // ---------- Status ----------
  function looseCount() {
    return S.ws.getTopBlocks(false).filter((b) => b.type !== "ha_root").length;
  }
  function updateTitle() {
    const c = S.ws && currentConfig();
    $("title").textContent = c ? (c.alias || "(ohne Namen)") : "–";
  }
  function updateStatus() {
    if (!S.original) { status(""); return; }
    updateTitle();
    if (!S.lossless) {
      status("⚠ Diese Automation lässt sich noch nicht verlustfrei darstellen – Speichern gesperrt.", "warn");
      $("save").disabled = true;
      return;
    }
    const changed = S.isNew || !HAB.deepEqual(currentConfig(), S.original);
    const loose = looseCount();
    $("save").disabled = false;
    $("save").classList.toggle("primary", changed);
    let txt = S.isNew ? "✚ Neu – noch nicht in HA gespeichert"
      : changed ? "● Geändert – noch nicht gespeichert" : "Keine Änderungen";
    if (loose) txt += ` · ${loose} lose Blöcke werden nicht gespeichert`;
    status(txt, changed || loose ? "warn" : "");
  }

  // ---------- JSON-Seitenleiste ----------
  function selectedBlock() {
    const sel = Blockly.getSelected && Blockly.getSelected();
    return sel && sel.type && sel.type.startsWith("ha_") ? sel : null;
  }
  function showSide() {
    $("side").classList.remove("hidden");
    Blockly.svgResize(S.ws);
    updateSide();
  }
  function updateSide() {
    if (!S.ws || $("side").classList.contains("hidden")) return;
    if (document.activeElement === $("json")) return;
    const b = selectedBlock();
    const val = b && b.type !== "ha_root" ? HAB.blockToItem(b) : currentConfig();
    $("sideTitle").textContent = b && b.type !== "ha_root" ? "Ausgewählter Block" : "Gesamte Automation";
    $("json").value = val === null ? "" : JSON.stringify(val, null, 2);
  }
  function applyJson() {
    let item;
    try { item = JSON.parse($("json").value); } catch (e) { alert("Ungültiges JSON: " + e.message); return; }
    const b = selectedBlock();
    if (!b || b.type === "ha_root") {
      loadIntoWorkspace(S.ws, item);
      updateStatus(); updateSide();
      return;
    }
    replaceBlock(b, item);
  }

  // Ersetzt einen Block (samt Kindern) durch einen neu aufgebauten aus item.
  function replaceBlock(b, item) {
    let kind = b.type.slice(3);
    if (kind === "action" && HAB.isObj(item) && "condition" in item) kind = "condition";
    if (kind === "condition" && b.previousConnection && b.previousConnection.targetConnection &&
        !(HAB.isObj(item) && "condition" in item)) {
      const chk = b.previousConnection.targetConnection.getCheck() || [];
      if (chk.includes("ha_action")) kind = "action";
    }
    const prev = b.previousConnection && b.previousConnection.targetConnection;
    const next = b.getNextBlock();
    const xy = b.getRelativeToSurfaceXY();
    Blockly.Events.setGroup(true);
    try {
      if (next) next.unplug(false);
      b.unplug(false);
      b.dispose(false);
      const nb = Blockly.serialization.blocks.append(HAB.itemToBlockJson(kind, item), S.ws);
      if (prev && nb.previousConnection) prev.connect(nb.previousConnection);
      else nb.moveTo(xy);
      if (next && nb.nextConnection) nb.nextConnection.connect(next.previousConnection);
      nb.select();
    } finally {
      Blockly.Events.setGroup(false);
    }
  }

  // ---------- Automationen, Kategorien, Liste ----------
  function automationList() {
    return Object.values(S.hass.states)
      .filter((s) => s.entity_id.startsWith("automation.") && s.attributes.id)
      .map((s) => ({ id: String(s.attributes.id), entity_id: s.entity_id, name: s.attributes.friendly_name || s.entity_id, on: s.state === "on" }))
      .sort((a, b) => a.name.localeCompare(b.name, "de"));
  }
  const entityOf = (id) => { const a = automationList().find((x) => x.id === id); return a ? a.entity_id : null; };

  async function refreshMeta() {
    try {
      const cats = await S.hass.callWS({ type: "config/category_registry/list", scope: "automation" });
      S.cats = cats.sort((a, b) => a.name.localeCompare(b.name, "de"));
      const ids = automationList().map((a) => a.entity_id);
      const entries = ids.length ? await S.hass.callWS({ type: "config/entity_registry/get_entries", entity_ids: ids }) : {};
      S.regCat = {};
      for (const [eid, e] of Object.entries(entries || {})) S.regCat[eid] = (e && e.categories && e.categories.automation) || null;
    } catch (e) {
      console.warn("[Blockly Automations] Kategorien nicht lesbar", e);
    }
    S.listKey = "";
    renderList();
    renderCategorySelect();
  }

  function catOfCurrent() {
    if (S.isNew) return S.pendingCat;
    const eid = S.id && entityOf(S.id);
    return eid ? S.regCat[eid] || null : null;
  }

  function renderCategorySelect() {
    const sel = $("category");
    sel.innerHTML = "";
    sel.appendChild(new Option("– keine –", NO_CAT));
    for (const c of S.cats) sel.appendChild(new Option(c.name, c.category_id));
    sel.appendChild(new Option("＋ Neue Kategorie …", "__new__"));
    sel.value = catOfCurrent() || NO_CAT;
    sel.disabled = !S.id;
  }

  async function createCategory() {
    const name = (prompt("Name der neuen Kategorie:") || "").trim();
    if (!name) return null;
    try {
      const c = await S.hass.callWS({ type: "config/category_registry/create", scope: "automation", name });
      await refreshMeta();
      return c.category_id;
    } catch (e) {
      alert("Kategorie konnte nicht angelegt werden: " + errText(e));
      return null;
    }
  }

  async function setCategory(entityId, catId) {
    try {
      await S.hass.callWS({ type: "config/entity_registry/update", entity_id: entityId, categories: { automation: catId || null } });
      S.regCat[entityId] = catId || null;
      S.listKey = "";
      renderList();
      renderCategorySelect();
      return true;
    } catch (e) {
      status("Kategorie nicht gespeichert: " + errText(e), "warn");
      return false;
    }
  }

  function collapsed() { try { return JSON.parse(store("haBlockly.collapsed") || "{}"); } catch (e) { return {}; } }

  function renderList() {
    if (!S.hass) return;
    const autos = automationList();
    const key = JSON.stringify([autos, S.regCat, S.cats, S.search, S.id, S.isNew]);
    if (key === S.listKey) return;
    S.listKey = key;
    const q = S.search.toLowerCase();
    const shown = autos.filter((a) => !q || a.name.toLowerCase().includes(q) || a.entity_id.includes(q));
    const groups = [...S.cats.map((c) => ({ id: c.category_id, name: c.name })), { id: NO_CAT, name: "Ohne Kategorie" }];
    const closed = collapsed();
    const tree = $("tree");
    tree.innerHTML = "";
    for (const g of groups) {
      const items = shown.filter((a) => (S.regCat[a.entity_id] || NO_CAT) === g.id);
      if (q && !items.length) continue;
      const folder = document.createElement("div");
      folder.className = "folder" + (closed[g.id] && !q ? " closed" : "");
      const head = document.createElement("div");
      head.className = "fhead";
      head.innerHTML = `<span class="arrow">${closed[g.id] && !q ? "▶" : "▼"}</span><span>📁</span><span class="fname"></span><span class="count">${items.length}</span>`;
      head.querySelector(".fname").textContent = g.name;
      head.addEventListener("click", () => {
        const c = collapsed();
        c[g.id] = !c[g.id];
        store("haBlockly.collapsed", JSON.stringify(c));
        S.listKey = "";
        renderList();
      });
      folder.appendChild(head);
      // Ablegen: Kategorie ändern
      folder.addEventListener("dragover", (e) => { e.preventDefault(); folder.classList.add("drop"); });
      folder.addEventListener("dragleave", (e) => { if (!folder.contains(e.relatedTarget)) folder.classList.remove("drop"); });
      folder.addEventListener("drop", async (e) => {
        e.preventDefault();
        folder.classList.remove("drop");
        const eid = e.dataTransfer.getData("text/plain");
        if (eid && (S.regCat[eid] || NO_CAT) !== g.id) {
          if (await setCategory(eid, g.id === NO_CAT ? null : g.id)) status(`In „${g.name}“ verschoben`, "ok");
        }
      });
      const list = document.createElement("div");
      list.className = "items";
      for (const a of items) {
        const it = document.createElement("div");
        it.className = "item" + (a.id === S.id && !S.isNew ? " sel" : "") + (a.on ? "" : " off");
        it.draggable = true;
        it.title = a.entity_id;
        it.innerHTML = `<span class="name"></span><label class="switch" title="Automation ein/aus"><input type="checkbox"${a.on ? " checked" : ""}><span></span></label>`;
        it.querySelector(".name").textContent = a.name;
        it.addEventListener("click", (e) => {
          if (e.target.closest(".switch")) return;
          if (a.id !== S.id || S.isNew) { if (confirmDiscard()) load(a.id); }
          if (window.innerWidth < 800) $("list").classList.add("hidden");
        });
        it.querySelector("input").addEventListener("change", (e) => {
          S.hass.callService("automation", e.target.checked ? "turn_on" : "turn_off", { entity_id: a.entity_id });
        });
        it.addEventListener("dragstart", (e) => { e.dataTransfer.setData("text/plain", a.entity_id); it.classList.add("dragging"); });
        it.addEventListener("dragend", () => it.classList.remove("dragging"));
        list.appendChild(it);
      }
      if (S.isNew && (S.pendingCat || NO_CAT) === g.id) {
        const it = document.createElement("div");
        it.className = "item sel";
        it.innerHTML = `<span class="name">✚ (neu, ungespeichert)</span>`;
        list.appendChild(it);
      }
      folder.appendChild(list);
      tree.appendChild(folder);
    }
  }

  // ---------- Laden / Speichern ----------
  function newAutomation() {
    if (!confirmDiscard()) return;
    const cfg = HAB.NEW_AUTOMATION();
    S.pendingCat = catOfCurrent();
    S.id = String(Date.now());
    S.isNew = true;
    S.lossless = true;
    S.original = cfg;
    S.busy = true;
    loadIntoWorkspace(S.ws, cfg);
    S.busy = false;
    S.listKey = "";
    renderList();
    renderCategorySelect();
    showRoot();
    const r = rootBlock();
    if (r) r.select();
    updateStatus(); updateSide();
  }

  async function load(id) {
    if (!id) return;
    status("Lade …");
    try {
      const cfg = await api("GET", id);
      S.isNew = false;
      S.pendingCat = null;
      S.id = id;
      S.original = cfg;
      S.busy = true;
      loadIntoWorkspace(S.ws, cfg);
      S.busy = false;
      S.lossless = HAB.deepEqual(currentConfig(), cfg);
      if (!S.lossless) console.warn("[Blockly Automations] Rundlauf nicht identisch", { original: cfg, blocks: currentConfig() });
      store("haBlockly.last", id);
      showRoot();
      S.listKey = "";
      renderList();
      renderCategorySelect();
      updateStatus(); updateSide();
    } catch (e) {
      S.busy = false;
      status("Fehler beim Laden: " + errText(e), "warn");
    }
  }

  async function waitForEntity(id, ms = 10000) {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      const eid = entityOf(id);
      if (eid) return eid;
      await new Promise((r) => setTimeout(r, 300));
    }
    return null;
  }

  async function save() {
    if (!S.id || !S.lossless) return;
    // Offenen Feld-Editor schließen, damit sein Wert sicher übernommen ist.
    Blockly.hideChaff();
    await new Promise((r) => setTimeout(r, 30));
    const cfg = currentConfig();
    if (!S.isNew && HAB.deepEqual(cfg, S.original)) { updateStatus(); return; }
    if (looseCount() && !confirm(`${looseCount()} Blöcke hängen nicht an der Automation und werden nicht gespeichert. Trotzdem speichern?`)) return;
    $("save").disabled = true;
    status("Speichere …");
    try {
      await api("POST", S.id, cfg);
      const back = await api("GET", S.id);
      S.original = back;
      if (S.isNew) {
        S.isNew = false;
        store("haBlockly.last", S.id);
        const eid = await waitForEntity(S.id);
        if (eid && S.pendingCat) await setCategory(eid, S.pendingCat);
        S.pendingCat = null;
        await refreshMeta();
      }
      $("save").classList.remove("primary");
      $("save").disabled = false;
      if (HAB.deepEqual(back, cfg)) status("✓ In Home Assistant gespeichert", "ok");
      else { status("Gespeichert – HA hat die Daten angepasst, neu geladen.", "warn"); await load(S.id); }
    } catch (e) {
      status("Fehler beim Speichern: " + errText(e), "warn");
      $("save").disabled = false;
    }
  }

  function confirmDiscard() {
    if (!S.ws) return true;
    if (S.isNew && !HAB.deepEqual(currentConfig(), S.original)) return confirm("Neue, ungespeicherte Automation verwerfen?");
    if (!S.original || !S.lossless) return true;
    if (HAB.deepEqual(currentConfig(), S.original)) return true;
    return confirm("Ungespeicherte Änderungen verwerfen?");
  }

  // Prüft alle Automationen: laden -> Blöcke -> zurück, muss identisch sein.
  async function selfTest() {
    const ws = new Blockly.Workspace();
    const res = [];
    for (const a of automationList()) {
      try {
        const cfg = await api("GET", a.id);
        loadIntoWorkspace(ws, cfg);
        res.push({ name: a.name, ok: HAB.deepEqual(currentConfig(ws), cfg) });
      } catch (e) {
        res.push({ name: a.name, ok: false, error: errText(e) });
      }
    }
    ws.dispose();
    return { total: res.length, ok: res.filter((r) => r.ok).length, failed: res.filter((r) => !r.ok) };
  }

  // ---------- Anbindung ----------
  window.haBlockly = {
    setHass(hass) {
      const first = !S.hass;
      S.hass = hass;
      if (first) {
        initWorkspace();
        renderCategorySelect();
        S.metaCount = automationList().length;
        refreshMeta().then(() => {
          const last = store("haBlockly.last");
          if (last && automationList().some((a) => a.id === last)) load(last);
        });
        // Native HA-Dialoge vorbereiten, deutsche Dienstnamen nachladen.
        try { parent.__haBlocklyPrepare && parent.__haBlocklyPrepare(); } catch (e) { /* optional */ }
        try {
          Promise.resolve(hass.loadBackendTranslation && hass.loadBackendTranslation("services"))
            .then(() => setTimeout(() => S.ws.updateToolbox(HAB.buildToolbox()), 300))
            .catch(() => {});
        } catch (e) { /* optional */ }
        return;
      }
      // Neue, umbenannte oder ein-/ausgeschaltete Automationen nachziehen.
      const count = automationList().length;
      if (count !== S.metaCount) { S.metaCount = count; refreshMeta(); } else renderList();
    },
    selfTest,
    currentConfig: () => currentConfig(),
    load,
  };

  $("search").addEventListener("input", (e) => { S.search = e.target.value; renderList(); });
  $("new").addEventListener("click", newAutomation);
  $("newCat").addEventListener("click", createCategory);
  $("category").addEventListener("change", async (e) => {
    let v = e.target.value;
    if (v === "__new__") {
      v = await createCategory();
      if (!v) { renderCategorySelect(); return; }
    }
    const cat = v === NO_CAT ? null : v;
    if (S.isNew) { S.pendingCat = cat; S.listKey = ""; renderList(); renderCategorySelect(); status("Kategorie wird beim Speichern gesetzt", "ok"); return; }
    const eid = S.id && entityOf(S.id);
    if (eid && (await setCategory(eid, cat))) status("✓ Kategorie gespeichert", "ok");
  });
  $("reload").addEventListener("click", () => { if (S.id && !S.isNew && confirmDiscard()) load(S.id); });
  // pointerdown schließt einen offenen Feld-Editor, bevor ein Knopf greift.
  $("bar").addEventListener("pointerdown", () => { Blockly.hideChaff(); setTimeout(updateStatus, 0); });
  $("save").addEventListener("click", save);
  $("applyJson").addEventListener("click", applyJson);
  $("menu").addEventListener("click", () => parent.__haBlocklyToggleMenu && parent.__haBlocklyToggleMenu());
  $("toggleList").addEventListener("click", () => {
    $("list").classList.toggle("hidden");
    store("haBlockly.list", $("list").classList.contains("hidden") ? "0" : "1");
    if (S.ws) Blockly.svgResize(S.ws);
  });
  $("toggleSide").addEventListener("click", () => {
    $("side").classList.toggle("hidden");
    store("haBlockly.side", $("side").classList.contains("hidden") ? "0" : "1");
    Blockly.svgResize(S.ws);
    updateSide();
  });
  const narrow = window.innerWidth < 800;
  const sidePref = store("haBlockly.side");
  // JSON-Seitenleiste ist ein Expertenwerkzeug: standardmäßig zu.
  if (sidePref !== "1") $("side").classList.add("hidden");
  const listPref = store("haBlockly.list");
  if (listPref === "0" || (listPref === null && narrow)) $("list").classList.add("hidden");
  window.addEventListener("beforeunload", (e) => {
    if (S.original && S.lossless && S.ws && !HAB.deepEqual(currentConfig(), S.original)) e.preventDefault();
  });
})();
