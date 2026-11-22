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

  // ---------- Klartext-Sätze für den Einfach-Modus ----------
  const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
  const arr = (v) => (v === undefined || v === null || v === "" ? [] : [].concat(v));
  const MISSING = "⚠ bitte wählen";
  const ename = (eid) => {
    if (typeof eid !== "string" || !eid) return MISSING;
    const st = S.hass && S.hass.states[eid];
    return (st && fname(st)) || eid;
  };
  const enames = (v) => (arr(v).length ? arr(v).map(ename).join(", ") : MISSING);
  const stateText = (eid, val) => {
    const vals = arr(val);
    if (!vals.length) return "";
    const first = typeof eid === "string" ? eid : arr(eid)[0];
    const st = S.hass && first && S.hass.states[first];
    return vals.map((v) => {
      if (typeof v !== "string") return String(v);
      try { if (st && S.hass.formatEntityState) return S.hass.formatEntityState(st, v); } catch (e) { /* weiter */ }
      return v;
    }).join(" oder ");
  };
  const UNITS = { days: "Tg", hours: "Std", minutes: "Min", seconds: "Sek", milliseconds: "ms" };
  const durText = (d) => {
    if (d === undefined || d === null || d === "") return "";
    if (isObj(d)) return Object.entries(d).filter(([, v]) => v !== 0 && v !== "0").map(([k, v]) => `${v} ${UNITS[k] || k}`).join(" ") || "0 Sek";
    if (typeof d === "number") return `${d} Sek`;
    const m = /^(\d+):(\d+):(\d+)$/.exec(d);
    if (m) return durText({ hours: +m[1], minutes: +m[2], seconds: +m[3] });
    return String(d);
  };
  const timeText = (t) => (typeof t === "string" && /^\d\d:\d\d:00$/.test(t) ? t.slice(0, 5) : typeof t === "string" && t.includes(".") ? ename(t) : arr(t).join(", "));
  const targetText = (tg, legacyEntity) => {
    const parts = [];
    if (legacyEntity !== undefined) parts.push(enames(legacyEntity));
    if (isObj(tg)) {
      if (tg.entity_id !== undefined) parts.push(enames(tg.entity_id));
      const reg = (ids, table, key = "name") => arr(ids).map((id) => (S.hass[table] && S.hass[table][id] && (S.hass[table][id].name_by_user || S.hass[table][id][key])) || id);
      if (tg.area_id) parts.push(...reg(tg.area_id, "areas"));
      if (tg.floor_id) parts.push(...reg(tg.floor_id, "floors"));
      if (tg.device_id) parts.push(...reg(tg.device_id, "devices"));
      if (tg.label_id) parts.push(...arr(tg.label_id));
    }
    return parts.filter(Boolean).join(", ");
  };
  const deviceName = (id) => { const d = S.hass && S.hass.devices && S.hass.devices[id]; return d ? d.name_by_user || d.name : "Gerät"; };
  const pretty = (s) => String(s || "").replace(/_/g, " ");
  const forText = (x) => (x.for ? ` für ${durText(x.for)}` : "");
  const newStyle = (kindKey, key, item) => {
    // Neue HA-Auslöser/-Bedingungen wie "button.pressed" mit Ziel.
    const [d, n] = key.split(".");
    const name = loc(`component.${d}.${kindKey}.${n}.name`) || pretty(n);
    const t = targetText(item.target);
    return t ? `${name} · ${t}` : name;
  };

  HAB.hooks.describe = (kind, x) => {
    if (!S.hass) return "";
    if (kind === "trigger") {
      const p = x.trigger !== undefined ? x.trigger : x.platform;
      switch (p) {
        case "state": {
          const from = x.from !== undefined && x.from !== null ? ` von ${stateText(x.entity_id, x.from)}` : "";
          const to = x.to !== undefined && x.to !== null ? ` auf ${stateText(x.entity_id, x.to)}` : "";
          return `${enames(x.entity_id)} wechselt${from}${to || " (beliebig)"}${forText(x)}`;
        }
        case "numeric_state":
          return `${enames(x.entity_id)}${x.attribute ? " (" + pretty(x.attribute) + ")" : ""}${x.above !== undefined ? " über " + (typeof x.above === "string" ? ename(x.above) : x.above) : ""}${x.below !== undefined ? " unter " + (typeof x.below === "string" ? ename(x.below) : x.below) : ""}${forText(x)}`;
        case "time": return `Um ${timeText(x.at)} Uhr${x.weekday ? " (" + arr(x.weekday).join(", ") + ")" : ""}`;
        case "time_pattern": return `Zeitmuster ${[x.hours !== undefined ? "Std " + x.hours : "", x.minutes !== undefined ? "Min " + x.minutes : "", x.seconds !== undefined ? "Sek " + x.seconds : ""].filter(Boolean).join(", ")}`;
        case "sun": return `Bei ${x.event === "sunrise" ? "Sonnenaufgang" : "Sonnenuntergang"}${x.offset && !/^-?0+:0+:0+$/.test(x.offset) ? " (" + x.offset + ")" : ""}`;
        case "zone": return `${enames(x.entity_id)} ${x.event === "leave" ? "verlässt" : "betritt"} ${ename(x.zone)}`;
        case "template": return `Template wird wahr${forText(x)}`;
        case "homeassistant": return x.event === "shutdown" ? "Beim Herunterfahren von Home Assistant" : "Beim Start von Home Assistant";
        case "event": return `Ereignis „${x.event_type || "?"}“`;
        case "mqtt": return `MQTT-Nachricht auf ${x.topic || "?"}`;
        case "webhook": return "Webhook wird aufgerufen";
        case "tag": return "NFC-Tag wird gescannt";
        case "calendar": return `${ename(x.entity_id)}: Termin ${x.event === "end" ? "endet" : "beginnt"}`;
        case "conversation": return `Sprachbefehl „${arr(x.command).join(" / ")}“`;
        case "persistent_notification": return "Benachrichtigung ändert sich";
        case "device": return `${deviceName(x.device_id)}: ${pretty(x.type)}${x.subtype !== undefined ? " " + pretty(x.subtype) : ""}`;
        default: return typeof p === "string" && p.includes(".") ? newStyle("triggers", p, x) : `Auslöser „${p}“`;
      }
    }
    if (kind === "condition") {
      if (!isObj(x)) return "Template ist wahr";
      switch (x.condition) {
        case "state": return `${enames(x.entity_id)} ist ${stateText(x.entity_id, x.state) || MISSING}${forText(x)}`;
        case "numeric_state": return `${enames(x.entity_id)}${x.above !== undefined ? " über " + x.above : ""}${x.below !== undefined ? " unter " + x.below : ""}`;
        case "time": {
          const parts = [];
          if (x.after) parts.push("nach " + timeText(x.after));
          if (x.before) parts.push("vor " + timeText(x.before));
          if (x.weekday) parts.push("an " + arr(x.weekday).join(", "));
          return "Zeit: " + (parts.join(", ") || "beliebig");
        }
        case "sun": return `Sonne: ${[x.after ? "nach " + (x.after === "sunrise" ? "Aufgang" : "Untergang") : "", x.before ? "vor " + (x.before === "sunrise" ? "Aufgang" : "Untergang") : ""].filter(Boolean).join(", ")}`;
        case "zone": return `${enames(x.entity_id)} ist in ${ename(x.zone)}`;
        case "trigger": return `Ausgelöst durch „${arr(x.id).join(" / ") || MISSING}“`;
        case "template": return "Template ist wahr";
        case "device": return `${deviceName(x.device_id)}: ${pretty(x.type)}`;
        default: return typeof x.condition === "string" && x.condition.includes(".") ? newStyle("conditions", x.condition, x) : `Bedingung „${x.condition}“`;
      }
    }
    if (kind === "action") {
      if ("action" in x || "service" in x) {
        const svc = x.action !== undefined ? x.action : x.service;
        if (!svc) return "Aktion: " + MISSING;
        const [d, s] = String(svc).split(".");
        const name = loc(`component.${d}.services.${s}.name`) || pretty(svc);
        const tg = targetText(x.target, x.entity_id);
        const data = isObj(x.data) ? Object.entries(x.data).filter(([, v]) => v !== "" && typeof v !== "object").slice(0, 2)
          .map(([k, v]) => `${loc(`component.${d}.services.${s}.fields.${k}.name`) || pretty(k)} ${String(v).length > 24 ? String(v).slice(0, 23) + "…" : v}`) : [];
        return [name, tg, data.join(", ")].filter(Boolean).join(" · ");
      }
      if ("delay" in x) return `Warte ${durText(x.delay)}`;
      if ("wait_template" in x) return `Warte, bis Template wahr ist${x.timeout ? " (höchstens " + durText(x.timeout) + ")" : ""}`;
      if ("event" in x) return `Ereignis „${x.event || "?"}“ senden`;
      if ("scene" in x) return `Szene ${ename(x.scene)} aktivieren`;
      if ("stop" in x) return `Stopp${x.stop ? ": " + x.stop : ""}`;
      if ("variables" in x) return `Variablen setzen: ${Object.keys(x.variables || {}).join(", ")}`;
      if ("device_id" in x) return `${deviceName(x.device_id)}: ${pretty(x.type)}`;
    }
    return "";
  };

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

  // „＋ … hinzufügen“: originalen HA-Dialog öffnen und das Ergebnis als Block anhängen.
  function appendToInput(block, inputName, kind, item) {
    const input = block.getInput(inputName);
    if (!input || !input.connection) return null;
    Blockly.Events.setGroup(true);
    try {
      const nb = Blockly.serialization.blocks.append(HAB.itemToBlockJson(kind, item), S.ws);
      let last = input.connection.targetBlock();
      if (!last) input.connection.connect(nb.previousConnection);
      else {
        while (last.getNextBlock()) last = last.getNextBlock();
        last.nextConnection.connect(nb.previousConnection);
      }
      nb.select();
      return nb;
    } finally {
      Blockly.Events.setGroup(false);
    }
  }
  async function addFromHA(block, inputName, kind) {
    if (!block || block.isDisposed() || block.isInFlyout) return;
    Blockly.hideChaff();
    if (kind === "option") { appendToInput(block, inputName, "option", { conditions: [], sequence: [] }); return; }
    const fn = parent.__haBlocklyAddItem;
    const res = fn ? await fn(kind) : undefined;
    if (res === undefined) { status("Die HA-Auswahl ist gerade nicht verfügbar – zieh einen Baustein aus dem Werkzeugkasten in die Lücke.", "warn"); return; }
    if (!res.length || block.isDisposed()) return;
    let last = null, lastItem = null;
    for (const item of res) { last = appendToInput(block, inputName, HAB.classify(kind, item), item); lastItem = item; }
    // Wie in HA: danach gleich die Einstellungen öffnen (außer das Ziel wurde schon gewählt).
    if (last && HAB.nativeEditable(last.haKind_, last.raw_) && !(HAB.isObj(lastItem) && lastItem.target && !HAB.missingInfo(lastItem))) {
      await HAB.hooks.openEditor(last);
    }
  }
  HAB.hooks.addItem = (block, inputName, kind) => addFromHA(block, inputName, kind);

  // Einfach- oder Expertenmodus (Experte: Eingabefelder, alle Bausteine, JSON).
  const isExpert = () => store("haBlockly.expert") === "1";
  HAB.hooks.simple = !isExpert();
  document.body.classList.toggle("expert", isExpert());

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
    const rootAdd = (i, kind) => () => { const r = rootBlock(); if (r) addFromHA(r, "L" + i, kind); };
    S.ws.registerButtonCallback("addTrigger", rootAdd(0, "trigger"));
    S.ws.registerButtonCallback("addCondition", rootAdd(1, "condition"));
    S.ws.registerButtonCallback("addAction", rootAdd(2, "action"));
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
    const missing = markMissing();
    $("save").disabled = false;
    $("save").classList.toggle("primary", changed);
    let txt = S.isNew ? "✚ Neu – noch nicht gespeichert"
      : changed ? "● Geändert – noch nicht gespeichert" : "Alles gespeichert";
    if (missing) txt += ` · ${missing}× fehlt noch eine Auswahl (⚠ am Baustein)`;
    if (loose) txt += ` · ${loose} Baustein(e) hängen nirgends dran`;
    status(txt, changed || loose || missing ? "warn" : "");
  }

  // Gelbes Warnzeichen an Bausteinen, bei denen noch etwas ausgewählt werden muss.
  function markMissing() {
    let n = 0;
    for (const b of S.ws.getAllBlocks(false)) {
      if (b.type === "ha_root" || b.isInFlyout) continue;
      let msg = null;
      try { msg = HAB.missingInfo(HAB.blockToItem(b)); } catch (e) { msg = null; }
      if (msg) n++;
      if ((b.__habWarn || null) !== msg) {
        b.__habWarn = msg;
        try { b.setWarningText(msg ? msg + " – zum Ändern anklicken" : null); } catch (e) { /* optional */ }
      }
    }
    return n;
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
  function newAutomation(factory = HAB.NEW_AUTOMATION) {
    if (!confirmDiscard()) return;
    const cfg = factory();
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
    if (looseCount() && !confirm(`${looseCount()} Baustein(e) hängen nicht an der Automation und werden nicht gespeichert. Trotzdem speichern?`)) return;
    const missing = markMissing();
    if (missing && !confirm(`Bei ${missing} Baustein(en) fehlt noch eine Auswahl (⚠). Home Assistant lehnt das evtl. ab. Trotzdem speichern?`)) return;
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
      status("Nicht gespeichert – Home Assistant meldet: " + errText(e), "warn");
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
  // „＋ Neu“: Menü mit leerer Automation und Vorlagen.
  const menu = $("newMenu");
  menu.innerHTML = '<div class="mh">Neue Automation</div>';
  for (const t of HAB.TEMPLATES) {
    const b = document.createElement("button");
    b.textContent = t === HAB.TEMPLATES[0] ? "Leer beginnen" : "Vorlage: " + t.name;
    b.addEventListener("click", () => { menu.classList.add("hidden"); newAutomation(t.cfg); });
    menu.appendChild(b);
  }
  $("new").addEventListener("click", (e) => { e.stopPropagation(); menu.classList.toggle("hidden"); });
  document.addEventListener("click", (e) => { if (!menu.contains(e.target)) menu.classList.add("hidden"); });
  $("undo").addEventListener("click", () => S.ws && S.ws.undo(false));
  $("redo").addEventListener("click", () => S.ws && S.ws.undo(true));
  $("expert").addEventListener("click", () => {
    const on = !isExpert();
    store("haBlockly.expert", on ? "1" : "0");
    document.body.classList.toggle("expert", on);
    HAB.hooks.simple = !on;
    if (!on) $("side").classList.add("hidden");
    if (!S.ws) return;
    S.ws.updateToolbox(HAB.buildToolbox());
    const cfg = currentConfig();
    if (cfg) { S.busy = true; loadIntoWorkspace(S.ws, cfg); S.busy = false; showRoot(); updateStatus(); updateSide(); }
    Blockly.svgResize(S.ws);
    status(on ? "Expertenmodus: Eingabefelder und alle Bausteine" : "Einfacher Modus", "ok");
  });
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
