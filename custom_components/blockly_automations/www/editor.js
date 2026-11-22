/* Editor-Logik: lädt Automationen über die HA-API, zeigt sie mit HAB als
 * Blöcke an und speichert sie zurück. Gespeichert wird nur, wenn die
 * Darstellung beim Laden nachweislich verlustfrei war. */
(function () {
  "use strict";
  const $ = (id) => document.getElementById(id);
  const S = {
    hass: null, ws: null, id: null, original: null, lossless: true, busy: false,
  };

  HAB.defineBlocks(Blockly);

  // ---------- Daten aus HA für Vorschlagslisten ----------
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
    if (dom === "person" || dom === "device_tracker")
      Object.values(S.hass.states).filter((s) => s.entity_id.startsWith("zone.") && s.entity_id !== "zone.home").forEach((z) => out.add(fname(z)));
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
  HAB.hooks.serviceFields = (svc) => {
    if (!S.hass || typeof svc !== "string" || !svc.includes(".")) return null;
    const [d, s] = svc.split(".");
    const def = S.hass.services[d] && S.hass.services[d][s];
    if (!def) return null;
    const named = (fields) => {
      const o = {};
      for (const [k, f] of Object.entries(fields || {})) {
        o[k] = f && f.fields ? { ...f, fields: named(f.fields) } : { ...f, name: loc(`component.${d}.services.${s}.fields.${k}.name`) || (f && f.name) || k };
      }
      return o;
    };
    return named(def.fields);
  };

  function status(text, cls = "") {
    const el = $("status");
    el.textContent = text;
    el.className = cls;
  }

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

  // ---------- Status ----------
  function looseCount() {
    return S.ws.getTopBlocks(false).filter((b) => b.type !== "ha_root").length;
  }
  function updateStatus() {
    if (!S.original) return;
    if (!S.lossless) {
      status("⚠ Diese Automation lässt sich noch nicht verlustfrei darstellen – Speichern gesperrt.", "warn");
      $("save").disabled = true;
      return;
    }
    const changed = S.isNew || !HAB.deepEqual(currentConfig(), S.original);
    const loose = looseCount();
    $("save").disabled = false;
    $("save").classList.toggle("primary", changed);
    let txt = S.isNew ? "✚ Neue Automation – noch nicht in HA gespeichert"
      : changed ? "● Geändert – noch nicht gespeichert" : "Keine Änderungen";
    if (loose) txt += ` · ${loose} lose Blöcke werden nicht gespeichert`;
    status(txt, changed || loose ? "warn" : "");
  }

  // ---------- JSON-Seitenleiste ----------
  function selectedBlock() {
    const sel = Blockly.getSelected && Blockly.getSelected();
    return sel && sel.type && sel.type.startsWith("ha_") ? sel : null;
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

  // ---------- Laden / Speichern ----------
  function automationList() {
    return Object.values(S.hass.states)
      .filter((s) => s.entity_id.startsWith("automation.") && s.attributes.id)
      .map((s) => ({ id: String(s.attributes.id), name: s.attributes.friendly_name || s.entity_id }))
      .sort((a, b) => a.name.localeCompare(b.name, "de"));
  }
  function fillPicker(initial) {
    const sel = $("picker");
    const list = automationList();
    S.pickerKey = list.map((a) => a.id + a.name).join("|");
    sel.innerHTML = "";
    sel.appendChild(new Option("– Automation wählen –", ""));
    if (S.isNew) sel.appendChild(new Option("✚ (neu, ungespeichert)", "__new__"));
    for (const a of list) sel.appendChild(new Option(a.name, a.id));
    if (initial) {
      const last = store("haBlockly.last");
      if (last && list.some((a) => a.id === last)) { sel.value = last; load(last); }
    } else {
      sel.value = S.isNew ? "__new__" : S.id || "";
    }
  }

  function newAutomation() {
    if (!confirmDiscard()) return;
    const cfg = HAB.NEW_AUTOMATION();
    S.id = String(Date.now());
    S.isNew = true;
    S.lossless = true;
    S.original = cfg;
    S.busy = true;
    loadIntoWorkspace(S.ws, cfg);
    S.busy = false;
    fillPicker(false);
    const r = rootBlock();
    if (r) { S.ws.scrollBoundsIntoView(r.getBoundingRectangleWithoutChildren()); r.select(); }
    updateStatus(); updateSide();
  }

  async function load(id) {
    if (!id || id === "__new__") return;
    status("Lade …");
    try {
      const cfg = await api("GET", id);
      S.isNew = false;
      fillPicker(false);
      $("picker").value = id;
      S.id = id;
      S.original = cfg;
      S.busy = true;
      loadIntoWorkspace(S.ws, cfg);
      S.busy = false;
      S.lossless = HAB.deepEqual(currentConfig(), cfg);
      if (!S.lossless) console.warn("[Blockly Automations] Rundlauf nicht identisch", { original: cfg, blocks: currentConfig() });
      store("haBlockly.last", id);
      const r = rootBlock();
      if (r) S.ws.scrollBoundsIntoView(r.getBoundingRectangleWithoutChildren());
      updateStatus(); updateSide();
    } catch (e) {
      S.busy = false;
      status("Fehler beim Laden: " + (e.body && e.body.message || e.message || e), "warn");
    }
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
        fillPicker(false);
      }
      $("save").classList.remove("primary");
      if (HAB.deepEqual(back, cfg)) status("✓ In Home Assistant gespeichert", "ok");
      else { status("Gespeichert – HA hat die Daten angepasst, neu geladen.", "warn"); await load(S.id); }
    } catch (e) {
      status("Fehler beim Speichern: " + (e.body && e.body.message || e.message || e), "warn");
      $("save").disabled = false;
    }
  }

  function confirmDiscard() {
    if (S.isNew && S.ws && !HAB.deepEqual(currentConfig(), S.original)) return confirm("Neue, ungespeicherte Automation verwerfen?");
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
        res.push({ name: a.name, ok: false, error: String(e && e.message || e) });
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
        fillPicker(true);
        return;
      }
      // Neue/umbenannte Automationen in der Auswahl nachziehen.
      const key = automationList().map((a) => a.id + a.name).join("|");
      if (key !== S.pickerKey) fillPicker(false);
    },
    selfTest,
    currentConfig: () => currentConfig(),
    load,
  };

  $("picker").addEventListener("change", (e) => {
    if (!confirmDiscard()) { e.target.value = S.id || ""; return; }
    load(e.target.value);
  });
  $("reload").addEventListener("click", () => { if (S.id && !S.isNew && confirmDiscard()) load(S.id); });
  $("new").addEventListener("click", newAutomation);
  // Speichern ist nie per disabled blockiert, solange ein Feld-Editor offen ist:
  // pointerdown schließt ihn vor dem Klick.
  $("bar").addEventListener("pointerdown", () => { Blockly.hideChaff(); setTimeout(updateStatus, 0); });
  $("save").addEventListener("click", save);
  $("applyJson").addEventListener("click", applyJson);
  $("menu").addEventListener("click", () => parent.__haBlocklyToggleMenu && parent.__haBlocklyToggleMenu());
  $("toggleSide").addEventListener("click", () => {
    $("side").classList.toggle("hidden");
    store("haBlockly.side", $("side").classList.contains("hidden") ? "0" : "1");
    Blockly.svgResize(S.ws);
    updateSide();
  });
  const sidePref = store("haBlockly.side");
  if (sidePref === "0" || (sidePref === null && window.innerWidth < 800)) $("side").classList.add("hidden");
  window.addEventListener("beforeunload", (e) => {
    if (S.original && S.lossless && !HAB.deepEqual(currentConfig(), S.original)) e.preventDefault();
  });
})();
