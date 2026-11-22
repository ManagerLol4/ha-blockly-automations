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
  HAB.hooks.entityName = (eid) => {
    const st = S.hass && typeof eid === "string" && S.hass.states[eid];
    return st ? "· " + (st.attributes.friendly_name || "") : "";
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
      toolbox: HAB.TOOLBOX,
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
    const changed = !HAB.deepEqual(currentConfig(), S.original);
    const loose = looseCount();
    $("save").disabled = !changed;
    let txt = changed ? "● Geändert – noch nicht gespeichert" : "Keine Änderungen";
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
    let kind = b.type.slice(3);
    if (kind === "action" && HAB.isObj(item) && "condition" in item) kind = "condition";
    if (kind === "condition" && b.previousConnection && b.previousConnection.targetConnection &&
        !(HAB.isObj(item) && "condition" in item)) {
      const chk = b.previousConnection.targetConnection.getCheck() || [];
      if (chk.includes("ha_action")) kind = "action";
    }
    const prev = b.previousConnection && b.previousConnection.targetConnection;
    const xy = b.getRelativeToSurfaceXY();
    Blockly.Events.setGroup(true);
    b.unplug(true);
    b.dispose(false);
    const nb = Blockly.serialization.blocks.append(HAB.itemToBlockJson(kind, item), S.ws);
    if (prev && nb.previousConnection) prev.connect(nb.previousConnection);
    else nb.moveBy(xy.x, xy.y);
    Blockly.Events.setGroup(false);
    nb.select();
  }

  // ---------- Laden / Speichern ----------
  function automationList() {
    return Object.values(S.hass.states)
      .filter((s) => s.entity_id.startsWith("automation.") && s.attributes.id)
      .map((s) => ({ id: String(s.attributes.id), name: s.attributes.friendly_name || s.entity_id }))
      .sort((a, b) => a.name.localeCompare(b.name, "de"));
  }
  function fillPicker() {
    const sel = $("picker");
    const list = automationList();
    sel.innerHTML = "";
    sel.appendChild(new Option("– Automation wählen –", ""));
    for (const a of list) sel.appendChild(new Option(a.name, a.id));
    const last = store("haBlockly.last");
    if (last && list.some((a) => a.id === last)) { sel.value = last; load(last); }
  }

  async function load(id) {
    if (!id) return;
    status("Lade …");
    try {
      const cfg = await api("GET", id);
      S.id = id;
      S.original = cfg;
      S.busy = true;
      loadIntoWorkspace(S.ws, cfg);
      S.busy = false;
      S.lossless = HAB.deepEqual(currentConfig(), cfg);
      if (!S.lossless) console.warn("[Blockly Automations] Rundlauf nicht identisch", { original: cfg, blocks: currentConfig() });
      store("haBlockly.last", id);
      S.ws.scrollCenter();
      updateStatus(); updateSide();
    } catch (e) {
      S.busy = false;
      status("Fehler beim Laden: " + (e.body && e.body.message || e.message || e), "warn");
    }
  }

  async function save() {
    if (!S.id || !S.lossless) return;
    const cfg = currentConfig();
    $("save").disabled = true;
    status("Speichere …");
    try {
      await api("POST", S.id, cfg);
      const back = await api("GET", S.id);
      S.original = back;
      if (HAB.deepEqual(back, cfg)) status("✓ In Home Assistant gespeichert", "ok");
      else { status("Gespeichert – HA hat die Daten angepasst, neu geladen.", "warn"); await load(S.id); }
    } catch (e) {
      status("Fehler beim Speichern: " + (e.body && e.body.message || e.message || e), "warn");
      $("save").disabled = false;
    }
  }

  function confirmDiscard() {
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
        fillPicker();
      }
    },
    selfTest,
    currentConfig: () => currentConfig(),
    load,
  };

  $("picker").addEventListener("change", (e) => {
    if (!confirmDiscard()) { e.target.value = S.id || ""; return; }
    load(e.target.value);
  });
  $("reload").addEventListener("click", () => { if (S.id && confirmDiscard()) load(S.id); });
  $("save").addEventListener("click", save);
  $("applyJson").addEventListener("click", applyJson);
  $("menu").addEventListener("click", () => parent.__haBlocklyToggleMenu && parent.__haBlocklyToggleMenu());
  $("toggleSide").addEventListener("click", () => {
    $("side").classList.toggle("hidden");
    store("haBlockly.side", $("side").classList.contains("hidden") ? "0" : "1");
    Blockly.svgResize(S.ws);
    updateSide();
  });
  if (store("haBlockly.side") === "0") $("side").classList.add("hidden");
  window.addEventListener("beforeunload", (e) => {
    if (S.original && S.lossless && !HAB.deepEqual(currentConfig(), S.original)) e.preventDefault();
  });
})();
