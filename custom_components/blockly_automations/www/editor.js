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
    kind: "automation", catsBy: { automation: [], script: [] }, uid: {}, blueprints: {},
    paths: null, hints: [], trace: null, runs: [], live: false, liveRes: {}, tplUnsubs: [], xref: null,
  };
  // Was gerade bearbeitet wird: Automation (Block ha_root) oder Skript (Block ha_script).
  // Arten: automation, script, scene, blueprint (Blueprint: Automation oder Skript mit !input-Platzhaltern).
  const KINDS = ["automation", "script", "scene", "blueprint"];
  const rootKind = (k = S.kind) => (k === "script" ? "script" : k === "scene" ? "scene"
    : k === "blueprint" ? (S.bp && S.bp.domain === "script" ? "script" : "root") : "root");
  const hasRuns = (k = S.kind) => k === "automation" || k === "script";
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

  // ---------- Werte im Baustein (Chips) und ihre Auswahlfenster ----------
  const WD = { mon: "Mo", tue: "Di", wed: "Mi", thu: "Do", fri: "Fr", sat: "Sa", sun: "So" };
  const firstEntity = (raw) => (typeof raw.entity_id === "string" ? raw.entity_id : Array.isArray(raw.entity_id) ? raw.entity_id[0] : "");
  HAB.hooks.chipText = (c, v, raw) => {
    if (v === undefined || v === "") return "";
    switch (c.type) {
      case "triggerid": return arr(v).join(", ");
      case "entity": return enames(v);
      case "target": return targetText(v) || "";
      case "state": return v === null ? "beliebig" : stateText(firstEntity(raw), v);
      case "duration": return durText(v);
      case "time": return timeText(v);
      case "bool": return v === true ? "ja" : v === false ? "nein" : String(v);
      case "select": { const o = (c.options || []).find((x) => x[1] === String(v)); return o ? o[0] : String(v); }
      case "weekdays": return arr(v).map((d) => WD[d] || d).join(", ");
      case "service": { const n = HAB.hooks.serviceName(v); return n ? n.replace(/^·\s*/, "") : String(v); }
      default: return typeof v === "object" ? JSON.stringify(v) : String(v);
    }
  };
  function selectorFor(c, item) {
    if (c.sel) return c.sel;
    switch (c.type) {
      case "triggerid": {
        const cur = arr(c.path ? HAB.getPath(item, c.path) : undefined).map(String);
        const options = [...new Set([...HAB.triggerIds(currentConfig()), ...cur])];
        return { select: { multiple: true, custom_value: true, mode: "list", options } };
      }
      case "state": { const e = firstEntity(item); return e ? { state: { entity_id: e } } : { text: {} }; }
      case "time": return { time: {} };
      case "duration": return { duration: {} };
      case "number": return { number: { mode: "box", step: "any" } };
      case "select": return { select: { mode: "list", options: (c.options || []).filter((o) => o[1] !== "").map(([label, value]) => ({ label, value })) } };
      case "bool": return { boolean: {} };
      case "weekdays": return { select: { multiple: true, mode: "list", options: Object.entries(WD).map(([value, label]) => ({ value, label })) } };
      case "template": return { template: {} };
      case "json": return { object: {} };
      default: return c.numeric ? { number: { mode: "box", step: "any" } } : { text: {} };
    }
  }
  const pad = (n) => String(n || 0).padStart(2, "0");
  function toSelectorValue(c, cur) {
    if (cur === undefined || cur === null) return undefined;
    if (c.type === "duration" && typeof cur === "string") {
      const m = /^(-?)(\d+):(\d+):(\d+)$/.exec(cur);
      return m ? { hours: +m[2], minutes: +m[3], seconds: +m[4] } : cur;
    }
    if (c.type === "duration" && typeof cur === "number") return { seconds: cur };
    if (c.type === "weekdays") return arr(cur);
    if (c.type === "triggerid") return arr(cur).map(String);
    if (Array.isArray(cur) && c.type !== "json") return cur.join(", ");
    return cur;
  }
  function fromSelectorValue(c, v, cur) {
    if (v === "" || v === undefined || v === null) return "";
    if (c.type === "duration") {
      if (!isObj(v)) return v;
      const clean = Object.fromEntries(Object.entries(v).filter(([, x]) => x !== 0 && x !== "0" && x !== undefined && x !== null));
      if (!Object.keys(clean).length) return "";
      if (typeof cur === "string") return `${pad(v.hours)}:${pad(v.minutes)}:${pad(v.seconds)}`;
      return clean;
    }
    if (c.type === "weekdays") return typeof cur === "string" && arr(v).length === 1 ? arr(v)[0] : arr(v);
    if (c.type === "triggerid") { const a = arr(v); return !Array.isArray(cur) && a.length === 1 ? a[0] : a; }
    if (typeof v === "string" && (Array.isArray(cur) || (c.type === "list" && v.includes(",")))) return v.split(",").map((s) => s.trim()).filter(Boolean);
    if (typeof v === "string" && c.numeric && v.trim() !== "" && isFinite(Number(v))) return Number(v);
    return v;
  }
  HAB.hooks.pickField = async (block, c) => {
    if (!block || block.isDisposed() || block.isInFlyout) return;
    Blockly.hideChaff();
    if (c.type === "service") return HAB.hooks.openEditor(block);
    const fn = parent.__haBlocklyPick;
    if (!fn) return HAB.hooks.openEditor(block);
    let item = HAB.blockToItem(block);
    const cur = c.path ? HAB.getPath(item, c.path) : item;
    const title = `${String(block.spec_ && block.spec_.title || "").replace(/^\S+\s/, "")} – ${c.label || "Auswahl"}`;
    let res;
    if (c.type === "entity") {
      res = await fn({ mode: "entity", title, value: typeof cur === "string" ? cur : Array.isArray(cur) ? cur[0] || "" : "", domains: c.domains });
    } else if (c.type === "target") {
      const e = isObj(cur) ? cur.entity_id : undefined;
      res = await fn({ mode: "target", title, value: typeof e === "string" ? e : Array.isArray(e) ? e[0] || "" : "", domains: c.domains });
    } else {
      res = await fn({ mode: "selector", title, value: toSelectorValue(c, cur), selector: selectorFor(c, item), label: c.label });
    }
    if (res === undefined) return HAB.hooks.openEditor(block); // Auswahlfenster nicht verfügbar
    if (!res || block.isDisposed()) return;
    const v = fromSelectorValue(c, res.value, cur);
    if (!c.path) item = v;
    else if (v === "" || (Array.isArray(v) && !v.length)) { if (cur !== undefined) HAB.delPath(item, c.path); }
    else HAB.setPath(item, c.path, v);
    if (!HAB.deepEqual(item, HAB.blockToItem(block))) replaceBlock(block, item);
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
    const unavailable = () => {
      block.select();
      if (isExpert()) { showSide(); status("HA-Fenster nicht verfügbar – Bearbeitung über das JSON-Feld rechts.", "warn"); }
      else status("Das Auswahlfenster von Home Assistant ließ sich nicht öffnen. Bitte die Seite neu laden (F5) und noch einmal klicken.", "warn");
    };
    if (!fn) { unavailable(); return; }
    Blockly.hideChaff();
    const res = await fn(block.haKind_, item, title);
    if (res === undefined) { unavailable(); return; }
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
    if (kind === "sceneent") { appendToInput(block, inputName, "sceneent", { __e: "", __v: "on" }); return; }
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

  // Trigger-IDs der offenen Automation (für „Ausgelöst durch ID“).
  HAB.hooks.triggerIds = () => { try { return HAB.triggerIds(currentConfig()); } catch (e) { return []; } };
  HAB.hooks.scripts = () => (S.hass ? itemList("script").map((a) => [a.entity_id, a.name]) : []);
  HAB.hooks.blueprintInputs = (path, kind) => {
    const d = S.blueprints[kind === "script" ? "script" : "automation"] || {};
    const bp = d[path];
    return (bp && bp.metadata && bp.metadata.input) || null;
  };

  // Rechtsklick „Name / Kommentar“: setzt alias – steht dann im Baustein und im Ablauf-Protokoll.
  HAB.hooks.renameBlock = async (block) => {
    if (!block || block.isDisposed() || block.isInFlyout) return;
    const item = HAB.blockToItem(block);
    if (!isObj(item)) return;
    const cur = typeof item.alias === "string" ? item.alias : "";
    const v = await askText("Name / Kommentar für diesen Schritt", cur, "Erscheint im Baustein und im Ablauf-Protokoll von HA. Leer = entfernen.");
    if (v === null || v.trim() === cur || block.isDisposed()) return;
    if (v.trim()) item.alias = v.trim(); else delete item.alias;
    replaceBlock(block, item);
  };

  // Eingaben (fields) eines Skripts im HA-Objekt-Editor (YAML) bearbeiten.
  HAB.hooks.editScriptFields = async () => {
    const fn = parent.__haBlocklyPick;
    const cfg = currentConfig();
    if (!cfg) return;
    if (!fn) { status("Das Auswahlfenster von Home Assistant ist nicht verfügbar – Eingaben im Expertenmodus (JSON) bearbeiten.", "warn"); return; }
    const cur = isObj(cfg.fields) ? cfg.fields : {};
    const res = await fn({ mode: "selector", title: "Eingaben des Skripts", value: cur, selector: { object: {} },
      label: "Beispiel: raum: {name: Raum, selector: {area: {}}}" });
    if (res === undefined || !res) return;
    const v = res.value === "" || res.value === null ? {} : res.value;
    if (!isObj(v)) { status("Die Eingaben müssen eine Liste von Namen mit Einstellungen sein (YAML-Objekt).", "warn"); return; }
    if (HAB.deepEqual(v, cur)) return;
    const next = HAB.clone(cfg);
    next.fields = v;
    reloadKeepingLayout(next);
  };

  // Einfach- oder Expertenmodus (Experte: Eingabefelder, alle Bausteine, JSON).
  const isExpert = () => store("haBlockly.expert") === "1";
  // Bedienung aus den Einstellungen der Integration: HA-Auswahlfenster oder Blockly-Bausteine.
  const CFG = (() => { try { return parent.__haBlocklyConfig || {}; } catch (e) { return {}; } })();
  const UI = new URLSearchParams(location.search).get("ui") || CFG.ui_mode || "ha";
  const BLOCKLY = UI === "blockly";
  // Version B: zusätzlich Bausteine wie bei ioBroker (globale Variablen …). Braucht die ausführliche Ansicht.
  const EXTENDED = (new URLSearchParams(location.search).get("bs") || CFG.block_set) === "extended";
  HAB.hooks.blockly = BLOCKLY;
  HAB.hooks.extended = EXTENDED;
  HAB.hooks.expert = isExpert();
  HAB.hooks.simple = !isExpert() && !BLOCKLY && !EXTENDED;
  document.body.classList.toggle("expert", isExpert());
  document.body.classList.toggle("blocklyMode", BLOCKLY);

  // ---------- Blockly-Modus: Auswahllisten im Baustein statt HA-Fenster ----------
  S.devEntries = {};
  HAB.hooks.domainName = (d) => loc(`component.${d}.title`) || pretty(d);
  const areaName = (id) => { const a = id && S.hass.areas && S.hass.areas[id]; return a ? a.name : ""; };
  const entityArea = (eid) => {
    const e = S.hass.entities && S.hass.entities[eid];
    if (!e) return "";
    if (e.area_id) return areaName(e.area_id);
    const d = e.device_id && S.hass.devices && S.hass.devices[e.device_id];
    return d ? areaName(d.area_id) : "";
  };
  const siblingValue = (field, path) => {
    const b = field.getSourceBlock();
    if (!b) return "";
    const m = (b.fieldMap_ || []).find((x) => x.path === path);
    const v = m ? b.getFieldValue(m.name) : b.getField && b.getField(path) ? b.getFieldValue(path) : HAB.getPath(b.raw_, path);
    return typeof v === "string" ? v.split(",")[0].trim() : Array.isArray(v) ? v[0] : "";
  };
  const devTypeKey = { trigger: "trigger_type", condition: "condition_type", action: "action_type" };
  function devLabel(kind, e) {
    if (!isObj(e)) return "";
    let t = loc(`component.${e.domain}.device_automation.${devTypeKey[kind] || "trigger_type"}.${e.type}`) || pretty(e.type);
    const sub = e.subtype !== undefined && e.subtype !== "" ? loc(`component.${e.domain}.device_automation.trigger_subtype.${e.subtype}`) || pretty(e.subtype) : "";
    const ent = e.entity_id ? (S.hass.states[e.entity_id] ? ename(e.entity_id) : (S.hass.entities && Object.values(S.hass.entities).find((x) => x.id === e.entity_id) || {}).entity_id || "") : "";
    t = t.replace("{entity_name}", ent ? ename(ent) : "").replace("{subtype}", sub);
    if (sub && !t.includes(sub)) t += " · " + sub;
    return t.replace(/\s+/g, " ").trim();
  }
  const TIMES = ["06:00:00", "06:30:00", "07:00:00", "08:00:00", "12:00:00", "17:00:00", "18:00:00", "20:00:00", "22:00:00", "23:00:00"];
  const bpInputsList = () => {
    if (S.kind !== "blueprint" || !S.bp) return [];
    const out = [];
    (function walk(o) { for (const [k, v] of Object.entries(o || {})) { if (v && isObj(v.input)) walk(v.input); else out.push([k, (v && v.name) || k]); } })(S.bp.meta.input);
    return out;
  };
  HAB.hooks.options = (type, field) => {
    const base = optionsBase(type, field);
    const ins = bpInputsList();
    if (!ins.length || ["devauto", "triggerid", "attribute", "variable"].includes(type)) return base;
    const pre = ins.map(([k, n]) => [HAB.inputPlaceholder(k), "🧩 Eingabe: " + n, "Blueprint-Eingaben", k]);
    return Promise.resolve(base).then((b) => [...pre, ...(b || [])]);
  };
  const optionsBase = (type, field) => {
    if (!S.hass) return [];
    const def = field.def_ || {};
    const byGroup = (a, b) => String(a[2] || "").localeCompare(String(b[2] || ""), "de") || String(a[1] || a[0]).localeCompare(String(b[1] || b[0]), "de");
    switch (type) {
      case "entity":
        return Object.values(S.hass.states)
          .filter((s) => !def.domains || !def.domains.length || def.domains.includes(s.entity_id.split(".")[0]))
          .map((s) => { const d = s.entity_id.split(".")[0]; const ar = entityArea(s.entity_id); return [s.entity_id, fname(s) || s.entity_id, HAB.hooks.domainName(d), (ar ? ar + " · " : "") + s.entity_id]; })
          .sort(byGroup);
      case "state":
        return HAB.hooks.states(siblingValue(field, def.of || "entity_id")).map(([v, l]) => [v, l || v]);
      case "service":
        return HAB.hooks.services().map(([id, name]) => [id, name || id, HAB.hooks.domainName(id.split(".")[0]), id]).sort(byGroup);
      case "area":
        return Object.values(S.hass.areas || {}).map((a) => [a.area_id, a.name, (a.floor_id && S.hass.floors && S.hass.floors[a.floor_id] && S.hass.floors[a.floor_id].name) || "Bereiche"]).sort(byGroup);
      case "floor":
        return Object.values(S.hass.floors || {}).map((f) => [f.floor_id, f.name]);
      case "device":
        return Object.values(S.hass.devices || {}).filter((d) => !d.disabled_by)
          .map((d) => [d.id, d.name_by_user || d.name || d.id, areaName(d.area_id) || "Ohne Bereich", [d.manufacturer, d.model].filter(Boolean).join(" ")]).sort(byGroup);
      case "time":
        return [...TIMES.map((t) => [t, t.slice(0, 5), "Uhrzeit"]),
          ...Object.values(S.hass.states).filter((s) => s.entity_id.startsWith("input_datetime.") || (s.entity_id.startsWith("sensor.") && s.attributes.device_class === "timestamp"))
            .map((s) => [s.entity_id, fname(s) || s.entity_id, "Helfer / Sensor"])];
      case "triggerid":
        return HAB.triggerIds(currentConfig()).map((x) => [x, x]);
      case "attribute": {
        const st = S.hass.states[siblingValue(field, def.of || "entity_id")];
        return st ? Object.keys(st.attributes).map((a) => [a, pretty(a), "", String(st.attributes[a]).slice(0, 40)]) : [];
      }
      case "variable":
        return variableNames().map((v) => [v, v]);
      case "devauto": {
        const dev = siblingValue(field, "device_id");
        if (!dev) return Promise.reject(new Error("Bitte zuerst ein Gerät wählen"));
        return S.hass.callWS({ type: `device_automation/${def.kind}/list`, device_id: dev }).then((list) =>
          (Array.isArray(list) ? list : []).map((e) => {
            const key = HAB.devKey(e);
            S.devEntries[key] = e;
            return [key, devLabel(def.kind, e), "", e.entity_id && S.hass.states[e.entity_id] ? e.entity_id : ""];
          }).filter((o) => o[0]));
      }
      default:
        return [];
    }
  };
  HAB.hooks.optionLabel = (type, v, field) => {
    if (!S.hass || v === "") return "";
    const pm = HAB.INPUT_RE.exec(v);
    if (pm) { const f = bpInputsList().find(([k]) => k === pm[1]); return "🧩 " + (f ? f[1] : pm[1]); }
    const def = (field && field.def_) || {};
    switch (type) {
      case "entity": { const st = S.hass.states[v]; return st ? fname(st) || v : v; }
      case "service": { const n = HAB.hooks.serviceName(v); return n ? n.replace(/^·\s*/, "") : v; }
      case "area": return areaName(v) || v;
      case "floor": return (S.hass.floors && S.hass.floors[v] && S.hass.floors[v].name) || v;
      case "device": return deviceName(v) === "Gerät" ? v : deviceName(v);
      case "state": return stateText(siblingValue(field, def.of || "entity_id"), v) || v;
      case "time": return timeText(v);
      case "devauto": {
        if (S.devEntries[v]) return devLabel(def.kind, S.devEntries[v]);
        try { const [domain, t, subtype, entity_id] = JSON.parse(v); return devLabel(def.kind, { domain, type: t, subtype, entity_id }); } catch (e) { return v; }
      }
      default: return v;
    }
  };
  HAB.hooks.deviceEntry = (key) => S.devEntries[key] || null;
  // Prüfregel „Entität gibt es nicht“: nur entscheiden, wenn HA-Zustände da sind.
  HAB.hooks.entityExists = (eid) => (S.hass && Object.keys(S.hass.states).length ? !!S.hass.states[eid] : null);
  HAB.hooks.entityIds = () => (S.hass ? Object.keys(S.hass.states) : []);
  // „＋ … hinzufügen“ öffnet im Blockly-Modus die passende Kategorie im Werkzeugkasten.
  const TOOLBOX_CAT = { trigger: "Auslöser", condition: "Bedingungen", action: "Aktionen", option: "Ablauf" };
  function openToolboxFor(kind) {
    try {
      const tbx = S.ws.getToolbox();
      const item = tbx.getToolboxItems().find((x) => x.getName && x.getName() === TOOLBOX_CAT[kind]);
      if (item) tbx.setSelectedItem(item);
      status(`Baustein aus „${TOOLBOX_CAT[kind]}“ in die Lücke ziehen`, "ok");
    } catch (e) { /* optional */ }
  }
  // Namen von Variablen, die in der offenen Automation/im Skript vorkommen.
  function variableNames() {
    const out = new Set();
    const cfg = currentConfig();
    if (!cfg) return [];
    if (isObj(cfg.variables)) Object.keys(cfg.variables).forEach((k) => out.add(k));
    if (isObj(cfg.trigger_variables)) Object.keys(cfg.trigger_variables).forEach((k) => out.add(k));
    if (isObj(cfg.fields)) Object.keys(cfg.fields).forEach((k) => out.add(k));
    HAB.walkConfig(cfg, rootKind(), (item) => {
      if (isObj(item) && isObj(item.variables)) Object.keys(item.variables).forEach((k) => out.add(k));
      if (isObj(item) && typeof item.response_variable === "string") out.add(item.response_variable);
      if (isObj(item) && isObj(item.repeat)) { out.add("repeat.index"); if ("for_each" in item.repeat) out.add("repeat.item"); }
    });
    return [...out];
  }

  // Version B: globale Variable = Helfer in HA (Zahl, Text, Wahr/Falsch). Danach liegt ein „setze“-Baustein bereit.
  async function newGlobalVar() {
    const type = await askChoice("Neue globale Variable",
      "Was soll die Variable speichern? Blockly legt dafür einen Helfer in Home Assistant an. Er behält seinen Wert auch nach einem Neustart.",
      [["Zahl", "input_number", true], ["Text", "input_text"], ["Wahr/Falsch", "input_boolean"], ["Abbrechen", null]]);
    if (!type) return;
    const name = await askText("Name der Variable", "", "z. B. „Helligkeit Wohnzimmer“ – so heißt auch der Helfer in Home Assistant.");
    if (!name || !name.trim()) return;
    const msg = { type: `${type}/create`, name: name.trim(), icon: "mdi:variable" };
    if (type === "input_number") Object.assign(msg, { min: -1000000, max: 1000000, step: 0.01, mode: "box" });
    if (type === "input_text") Object.assign(msg, { min: 0, max: 255 });
    let res;
    try { res = await S.hass.callWS(msg); } catch (e) { status("Variable konnte nicht angelegt werden: " + errText(e), "err"); return; }
    const eid = `${type}.${(res && res.id) || name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_")}`;
    const raw = type === "input_boolean" ? { action: "input_boolean.turn_on", target: { entity_id: eid } }
      : { action: `${type}.set_value`, target: { entity_id: eid }, data: { value: type === "input_number" ? 0 : "" } };
    try {
      const json = HAB.itemToBlockJson("action", raw);
      const m = S.ws.getMetricsManager().getViewMetrics(true);
      json.x = m.left + 40; json.y = m.top + 40;
      const b = Blockly.serialization.blocks.append(json, S.ws);
      b.select && b.select();
    } catch (e) { /* Baustein ist optional */ }
    setTimeout(() => S.ws && S.ws.updateToolbox(HAB.buildToolbox(rootKind())), 500);
    status(`Variable „${name.trim()}“ angelegt (${eid}). Den Baustein oben links einstecken.`, "ok");
  }

  // Eigenes Eingabefenster (statt prompt(), das in der HA-App oft nicht erscheint).
  function askText(title, value = "", hint = "") {
    return new Promise((resolve) => {
      const box = $("ask");
      $("askTitle").textContent = title;
      $("askHint").textContent = hint;
      const inp = $("askInput");
      inp.value = value;
      box.classList.remove("hidden");
      setTimeout(() => { inp.focus(); inp.select(); }, 0);
      const done = (v) => {
        box.classList.add("hidden");
        $("askOk").onclick = $("askCancel").onclick = inp.onkeydown = null;
        resolve(v);
      };
      $("askOk").onclick = () => done(inp.value);
      $("askCancel").onclick = () => done(null);
      inp.onkeydown = (e) => { if (e.key === "Enter") done(inp.value); if (e.key === "Escape") done(null); };
    });
  }

  // Eigenes Auswahlfenster mit Knöpfen (statt confirm()). Ergebnis: Wert des Knopfs oder null.
  function askChoice(title, text, buttons) {
    return new Promise((resolve) => {
      const box = $("ask");
      $("askTitle").textContent = title;
      $("askHint").textContent = text;
      $("askInput").style.display = "none";
      const foot = box.querySelector(".askFoot");
      const old = foot.innerHTML;
      foot.innerHTML = "";
      const done = (v) => {
        box.classList.add("hidden");
        foot.innerHTML = old;
        $("askInput").style.display = "";
        document.removeEventListener("keydown", onKey, true);
        resolve(v);
      };
      const onKey = (e) => { if (e.key === "Escape") { e.stopPropagation(); done(null); } };
      document.addEventListener("keydown", onKey, true);
      for (const [label, value, primary] of buttons) {
        const b = document.createElement("button");
        b.textContent = label;
        if (primary) b.className = "primary";
        b.addEventListener("click", () => done(value));
        foot.appendChild(b);
      }
      box.classList.remove("hidden");
    });
  }

  // „Variablen setzen“: weitere Variable hinzufügen.
  HAB.hooks.addVariable = async (block) => {
    const name = ((await askText("Name der neuen Variable", "", "Nur Buchstaben, Ziffern und _ – z. B. helligkeit")) || "").trim();
    if (!name || block.isDisposed()) return;
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) { status("Ungültiger Name – bitte nur Buchstaben, Ziffern und _ verwenden.", "warn"); return; }
    const item = HAB.blockToItem(block);
    if (!isObj(item.variables)) item.variables = {};
    if (name in item.variables) return;
    item.variables[name] = "";
    replaceBlock(block, item);
  };

  // „Wenn“ um „sonst wenn“ erweitern: wird zur Auswahl (choose) mit gleichem Verhalten.
  HAB.hooks.ifToChoose = (block) => {
    if (!block || block.isDisposed()) return;
    const item = HAB.blockToItem(block);
    const opt = { conditions: [].concat(item.if || []), sequence: [].concat(item.then || []) };
    const next = { choose: [opt, { conditions: [], sequence: [] }] };
    if (item.else !== undefined && [].concat(item.else).length) next.default = [].concat(item.else);
    for (const k of ["alias", "enabled", "continue_on_error"]) if (item[k] !== undefined) next[k] = item[k];
    replaceBlock(block, next);
    status("Aus „Wenn“ wurde eine Auswahl – die neue Option „sonst wenn“ ist angehängt.", "ok");
  };

  // Schritte als neues Skript auslagern; an ihrer Stelle steht dann der Aufruf.
  HAB.hooks.extractScript = async (block, rest) => {
    if (!block || block.isDisposed()) return;
    const blocks = [block];
    if (rest) for (let n = block.getNextBlock(); n; n = n.getNextBlock()) blocks.push(n);
    const name = ((await askText("Name des neuen Skripts", "", `${blocks.length} Schritt(e) werden in das Skript verschoben.`)) || "").trim();
    if (!name || block.isDisposed()) return;
    const base = slugify(name);
    const taken = new Set(itemList("script").map((a) => a.id));
    let id = base;
    for (let i = 2; taken.has(id) || S.hass.states["script." + id]; i++) id = `${base}_${i}`;
    // Genutzte Auslöser-Daten und Variablen als Eingaben übergeben (ein Skript sieht sie sonst nicht).
    const plan = HAB.planExtract(blocks.map((b) => HAB.blockToItem(b)), variableNames());
    const from = (currentConfig() || {}).alias || "";
    const script = { alias: name, description: from ? `Ausgelagert aus „${from}“` : "" };
    if (Object.keys(plan.fields).length) script.fields = plan.fields;
    // parallel: mehrere Automationen dürfen das Skript gleichzeitig aufrufen (wie vorher die eingebauten Schritte).
    Object.assign(script, { sequence: plan.sequence, mode: "parallel", max: 10 });
    try {
      await apiFor("script", "POST", id, script);
    } catch (e) { status("Skript nicht angelegt: " + errText(e), "warn"); return; }
    const call = { action: "script." + id };
    if (Object.keys(plan.data).length) call.data = plan.data;
    const prev = block.previousConnection && block.previousConnection.targetConnection;
    const after = blocks[blocks.length - 1].getNextBlock();
    Blockly.Events.setGroup(true);
    try {
      if (after) after.unplug(false);
      block.unplug(false);
      blocks.forEach((b) => b.dispose(false));
      const nb = Blockly.serialization.blocks.append(HAB.itemToBlockJson("action", call), S.ws);
      if (prev) prev.connect(nb.previousConnection);
      if (after && nb.nextConnection) nb.nextConnection.connect(after.previousConnection);
      nb.select();
    } finally { Blockly.Events.setGroup(false); }
    S.xref = null;
    const passed = Object.keys(plan.data);
    const msg = `📜 Skript „${name}“ (script.${id}) angelegt${passed.length ? ` – übergibt ${passed.join(", ")}` : ""}. Automation noch speichern.`;
    // Nach der normalen Statuszeile anzeigen (die kommt mit den Änderungs-Ereignissen).
    setTimeout(() => status(plan.notes.length ? msg + " ⚠ " + plan.notes.join(" ") : msg, plan.notes.length ? "warn" : "ok"), 100);
  };

  if (BLOCKLY) {
    HAB.hooks.openEditor = null;
    HAB.hooks.pickField = null;
    HAB.hooks.addItem = async (block, inputName, kind) => {
      if (kind === "option") { appendToInput(block, inputName, "option", { conditions: [], sequence: [] }); return; }
      if (kind === "sceneent") { appendToInput(block, inputName, "sceneent", { __e: "", __v: "on" }); return; }
      const item = await pickType(kind);
      if (item && !block.isDisposed()) appendToInput(block, inputName, HAB.classify(kind, item), item);
    };
  }

  // Version B: Falls-Klammern
  {
    const base = HAB.hooks.addItem;
    HAB.hooks.addItem = (block, inputName, kind) => (kind === "when" ? appendToInput(block, inputName, "when", HAB.NEW_WHEN()) : base(block, inputName, kind));
  }
  HAB.hooks.convertToWhen = () => {
    const cfg = currentConfig();
    if (!cfg) return;
    const n = HAB.toWhenView(cfg);
    reloadKeepingLayout(n);
    showRoot && showRoot();
    status("⚡ In eine Falls-Klammer umgewandelt – Auslöser lassen sich in eigene Klammern aufteilen. Hinweis: „Ausführen“ von Hand startet keine Klammer (es fehlt der Auslöser). Speichern nicht vergessen.", "ok");
  };

  HAB.defineBlocks(Blockly);

  function status(text, cls = "") {
    const el = $("status");
    el.textContent = text;
    el.className = cls;
  }
  const errText = (e) => (e && ((e.body && e.body.message) || e.message)) || String(e);

  function apiFor(kind, method, id, body) {
    const k = kind === "script" ? "script" : kind === "scene" ? "scene" : "automation";
    return S.hass.callApi(method, `config/${k}/config/${encodeURIComponent(id)}`, body);
  }
  const api = (method, id, body) => apiFor(S.kind, method, id, body);

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
    HAB.hooks.toolboxSearch = !HAB.hooks.simple && hasSearch();
    S.ws = Blockly.inject($("ws"), {
      comments: true,
      toolbox: HAB.buildToolbox(rootKind()),
      media: "vendor/media/",
      renderer: "zelos",
      theme,
      trashcan: true,
      sounds: false,
      grid: { spacing: 24, length: 2, colour: dark ? "#2a2a2a" : "#e6e6e6", snap: false },
      zoom: { controls: true, wheel: false, startScale: 0.8, maxScale: 2, minScale: 0.3 },
      move: { scrollbars: true, drag: true, wheel: true },
    });
    // Bei Skripten gibt es nur eine Lücke (ABLAUF); Bedingungen sind dort Schritte.
    initPlugins();
    S.ws_buttons();
    const rootAdd = (i, kind) => () => {
      const r = rootBlock();
      if (!r) return;
      if (S.kind === "script") { if (kind !== "trigger") addFromHA(r, "L0", kind); return; }
      addFromHA(r, "L" + i, kind);
    };
    S.ws.registerButtonCallback("newScript", () => newScript());
    S.ws.registerButtonCallback("newGlobalVar", () => newGlobalVar());
    S.ws.registerButtonCallback("newFunction", () => newFunction());
    S.ws.registerButtonCallback("newTimer", () => newTimer());
    S.ws.registerButtonCallback("addTrigger", rootAdd(0, "trigger"));
    S.ws.registerButtonCallback("addCondition", rootAdd(1, "condition"));
    S.ws.registerButtonCallback("addAction", rootAdd(2, "action"));
    S.ws.addChangeListener((e) => {
      if (e.type === Blockly.Events.SELECTED) { updateSide(); renderDetail(); }
      if (e.type === Blockly.Events.BLOCK_CHANGE && e.element === "collapsed" && !S.busy) saveLayoutSoon();
      if (String(e.type).startsWith("comment_") && !S.busy && !e.blockId) saveLayoutSoon();
      if (e.type === "backpack_change") saveBackpackSoon();
      if (e.type === Blockly.Events.SELECTED) multiSelect(e);
      if (!e.isUiEvent && !S.busy) { updateStatus(); updateSide(); }
      // Dienst gewechselt: Block mit den Feldern des neuen Dienstes neu aufbauen.
      if (e.type === Blockly.Events.BLOCK_CHANGE && e.element === "field" && !S.busy) {
        const b = S.ws.getBlockById(e.blockId);
        if (b && b.serviceField_ === e.name && (HAB.hooks.serviceFields(e.newValue) || b.getField("SVCSEL"))) {
          setTimeout(() => { if (!b.isDisposed()) replaceBlock(b, HAB.blockToItem(b)); }, 0);
        }
      }
      // Version B: Auswahl, die den Baustein umbaut (z. B. „Falls … wird zu“ braucht ein Wertfeld).
      if (e.type === Blockly.Events.BLOCK_CHANGE && e.element === "field" && !S.busy) {
        const b = S.ws.getBlockById(e.blockId);
        if (b && (b.fieldMap_ || []).some((x) => x.name === e.name && x.rebuild)) setTimeout(() => { if (!b.isDisposed()) replaceBlock(b, HAB.blockToItem(b)); }, 0);
      }
      // Name in der Kopfzeile mitführen.
      if (e.type === Blockly.Events.BLOCK_CHANGE && !S.busy) updateTitle();
    });
  }

  function rootBlock(ws = S.ws) {
    return ws.getBlocksByType("ha_root", false)[0] || ws.getBlocksByType("ha_script", false)[0] || ws.getBlocksByType("ha_scene", false)[0] || null;
  }

  function currentConfig(ws = S.ws) {
    const r = rootBlock(ws);
    return r ? HAB.blockToItem(r) : null;
  }

  function loadIntoWorkspace(ws, cfg, kind = S.kind) {
    const json = HAB.itemToBlockJson(rootKind(kind), cfg);
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
    return S.ws.getTopBlocks(false).filter((b) => !HAB.ROOTS.has(b.haKind_)).length;
  }
  function updateTitle() {
    const c = S.ws && currentConfig();
    $("title").textContent = S.kind === "blueprint" && S.bp ? "🧩 " + (S.bp.meta.name || S.bp.path) : c ? (c.alias || c.name || "(ohne Namen)") : "–";
  }
  function updateStatus() {
    if (!S.original) { status(""); return; }
    updateTitle();
    if (!S.lossless) {
      status("⚠ Diese Automation lässt sich noch nicht verlustfrei darstellen – Speichern gesperrt.", "warn");
      $("save").disabled = true;
      return;
    }
    const changed = S.isNew || !HAB.deepEqual(currentConfig(), S.original) || bpDirty();
    const loose = looseCount();
    const missing = markMissing();
    $("save").disabled = false;
    $("save").classList.toggle("primary", changed);
    let txt = S.isNew ? "✚ Neu – noch nicht gespeichert"
      : changed ? "● Geändert – noch nicht gespeichert" : "Alles gespeichert";
    if (missing) txt += ` · ${missing}× fehlt noch eine Auswahl (⚠ am Baustein)`;
    if (loose) txt += ` · ${loose} Baustein(e) hängen nirgends dran`;
    if (S.hints.length) txt += ` · 💡 ${S.hints.length} Hinweis(e)`;
    status(txt, changed || loose || missing ? "warn" : "");
    applyOverlay();
    renderHints();
  }

  // Warnzeichen an Bausteinen: fehlende Auswahl (⚠) und Hinweise der Prüfregeln (💡).
  function markMissing() {
    const r = rootBlock();
    S.paths = r ? HAB.collectPaths(r) : new Map();
    let hints = [];
    try { hints = r ? HAB.lint(currentConfig(), rootKind()) : []; } catch (e) { hints = []; }
    S.hints = hints;
    const byPath = {};
    for (const h of hints) (byPath[h.path] = byPath[h.path] || []).push(h.msg);
    let n = 0;
    for (const b of S.ws.getAllBlocks(false)) {
      if (b.isInFlyout) continue;
      let msg = null;
      if (!HAB.ROOTS.has(b.haKind_)) { try { msg = HAB.missingInfo(HAB.blockToItem(b)); } catch (e) { msg = null; } }
      if (msg) n++;
      const attached = b.habPath_ !== undefined && S.paths.get(b.habPath_) === b;
      const lintMsgs = attached ? byPath[b.habPath_] || [] : [];
      const text = [msg ? msg + " – zum Ändern anklicken" : "", ...lintMsgs.map((m) => "💡 " + m)].filter(Boolean).join("\n\n") || null;
      if ((b.__habWarn || null) !== text) {
        b.__habWarn = text;
        try { b.setWarningText(text); } catch (e) { /* optional */ }
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
    if (!isExpert()) return;
    $("side").classList.remove("hidden");
    Blockly.svgResize(S.ws);
    updateSide();
  }
  function updateSide() {
    if (!S.ws || $("side").classList.contains("hidden")) return;
    if (document.activeElement === $("json")) return;
    const b = selectedBlock();
    const isRoot = !b || HAB.ROOTS.has(b.haKind_);
    const val = !isRoot ? HAB.blockToItem(b) : currentConfig();
    $("sideTitle").textContent = !isRoot ? "Ausgewählter Block" : S.kind === "script" ? "Gesamtes Skript" : "Gesamte Automation";
    $("json").value = val === null ? "" : JSON.stringify(val, null, 2);
  }
  function applyJson() {
    let item;
    try { item = JSON.parse($("json").value); } catch (e) { alert("Ungültiges JSON: " + e.message); return; }
    const b = selectedBlock();
    if (!b || HAB.ROOTS.has(b.haKind_)) {
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
    const wasCollapsed = b.isCollapsed();
    Blockly.Events.setGroup(true);
    try {
      if (next) next.unplug(false);
      b.unplug(false);
      b.dispose(false);
      const nb = Blockly.serialization.blocks.append(HAB.itemToBlockJson(kind, item), S.ws);
      if (prev && nb.previousConnection) prev.connect(nb.previousConnection);
      else nb.moveTo(xy);
      if (next && nb.nextConnection) nb.nextConnection.connect(next.previousConnection);
      if (wasCollapsed) nb.setCollapsed(true);
      nb.select();
    } finally {
      Blockly.Events.setGroup(false);
    }
  }

  // ---------- Automationen, Kategorien, Liste ----------
  // Automationen: ID steht im Attribut „id“. Skripte: ID = unique_id aus dem Register (sonst object_id).
  function itemList(kind = S.kind) {
    if (!S.hass) return [];
    if (kind === "blueprint") {
      const out = [];
      for (const domain of ["automation", "script"]) {
        for (const [path, bp] of Object.entries(S.blueprints[domain] || {})) {
          if (!bp || !bp.metadata) continue;
          out.push({ id: `${domain}:${path}`, entity_id: `${domain}:${path}`, name: bp.metadata.name || path, on: true, kind, domain, path, meta: bp.metadata });
        }
      }
      return out.sort((a, b) => a.name.localeCompare(b.name, "de"));
    }
    const pre = kind + ".";
    return Object.values(S.hass.states)
      .filter((s) => s.entity_id.startsWith(pre) && (kind === "script" || s.attributes.id))
      .map((s) => ({
        id: kind === "script" ? S.uid[s.entity_id] || s.entity_id.slice(pre.length) : String(s.attributes.id),
        entity_id: s.entity_id, name: s.attributes.friendly_name || s.entity_id, on: s.state === "on", kind,
      }))
      .sort((a, b) => a.name.localeCompare(b.name, "de"));
  }
  const entityOf = (id, kind = S.kind) => { const a = itemList(kind).find((x) => x.id === id); return a ? a.entity_id : null; };
  const lastKey = (kind = S.kind) => (kind === "automation" ? "haBlockly.last" : "haBlockly.last." + kind);

  async function refreshMeta() {
    try {
      const byName = (l) => (Array.isArray(l) ? l : []).sort((a, b) => a.name.localeCompare(b.name, "de"));
      const [ca, cs, cz] = await Promise.all(["automation", "script", "scene"].map((scope) =>
        S.hass.callWS({ type: "config/category_registry/list", scope }).catch(() => [])));
      S.catsBy = { automation: byName(ca), script: byName(cs), scene: byName(cz), blueprint: [] };
      const ids = Object.keys(S.hass.states).filter((e) => e.startsWith("automation.") || e.startsWith("script.") || e.startsWith("scene."));
      const entries = ids.length ? await S.hass.callWS({ type: "config/entity_registry/get_entries", entity_ids: ids }) : {};
      S.regCat = {};
      S.uid = {};
      for (const [eid, e] of Object.entries(entries || {})) {
        const dom = eid.split(".")[0];
        S.regCat[eid] = (e && e.categories && e.categories[dom]) || null;
        if (dom === "script" && e && e.unique_id) S.uid[eid] = String(e.unique_id);
      }
    } catch (e) {
      console.warn("[Blockly Automations] Kategorien nicht lesbar", e);
    }
    for (const domain of ["automation", "script"]) {
      try { S.blueprints[domain] = (await S.hass.callWS({ type: "blueprint/list", domain })) || {}; } catch (e) { S.blueprints[domain] = {}; }
    }
    S.cats = S.catsBy[S.kind] || [];
    if (S.ws) S.ws.updateToolbox(HAB.buildToolbox(rootKind()));
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
    sel.disabled = !S.id || S.kind === "blueprint";
  }

  async function createCategory() {
    const name = ((await askText("Name der neuen Kategorie (Ordner)")) || "").trim();
    if (!name) return null;
    try {
      const c = await S.hass.callWS({ type: "config/category_registry/create", scope: S.kind, name });
      await refreshMeta();
      return c.category_id;
    } catch (e) {
      alert("Kategorie konnte nicht angelegt werden: " + errText(e));
      return null;
    }
  }

  async function setCategory(entityId, catId) {
    try {
      await S.hass.callWS({ type: "config/entity_registry/update", entity_id: entityId, categories: { [entityId.split(".")[0]]: catId || null } });
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
    const autos = itemList();
    S.cats = S.catsBy[S.kind] || [];
    const key = JSON.stringify([S.kind, autos, S.regCat, S.cats, S.search, S.id, S.isNew]);
    if (key === S.listKey) return;
    S.listKey = key;
    const q = S.search.toLowerCase();
    const shown = autos.filter((a) => !q || a.name.toLowerCase().includes(q) || a.entity_id.includes(q));
    const isBp = S.kind === "blueprint";
    const groups = isBp ? [{ id: "automation", name: "Blueprints für Automationen" }, { id: "script", name: "Blueprints für Skripte" }]
      : [...S.cats.map((c) => ({ id: c.category_id, name: c.name })), { id: NO_CAT, name: "Ohne Kategorie" }];
    const groupOf = (a) => (isBp ? a.domain : S.regCat[a.entity_id] || NO_CAT);
    const closed = collapsed();
    const tree = $("tree");
    tree.innerHTML = "";
    for (const g of groups) {
      const items = shown.filter((a) => groupOf(a) === g.id);
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
      if (!isBp) folder.addEventListener("dragover", (e) => { e.preventDefault(); folder.classList.add("drop"); });
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
        it.draggable = !isBp;
        it.title = isBp ? a.path : a.entity_id;
        it.innerHTML = S.kind === "script"
          ? `<span class="name"></span>${a.on ? '<span class="running" title="läuft gerade">●</span>' : ""}<button class="run icon" title="Skript jetzt ausführen">▶</button>`
          : S.kind === "scene" ? `<span class="name"></span><button class="run icon" title="Szene jetzt aktivieren">▶</button>`
          : isBp ? `<span class="name"></span><button class="use icon" title="Neue ${a.domain === "script" ? "Skript" : "Automation"} aus diesem Blueprint">＋</button><button class="del icon" title="Blueprint löschen">🗑</button>`
          : `<span class="name"></span><label class="switch" title="Automation ein/aus"><input type="checkbox"${a.on ? " checked" : ""}><span></span></label>`;
        it.querySelector(".name").textContent = a.name;
        if (S.kind !== "automation") it.classList.remove("off");
        const use = it.querySelector(".use");
        if (use) use.addEventListener("click", () => useBlueprint(a));
        const del = it.querySelector(".del");
        if (del) del.addEventListener("click", () => deleteBlueprint(a));
        it.addEventListener("click", (e) => {
          if (e.target.closest(".switch") || e.target.closest(".run") || e.target.closest(".use") || e.target.closest(".del")) return;
          if (a.id !== S.id || S.isNew) { if (confirmDiscard()) load(a.id); }
          if (window.innerWidth < 800) $("list").classList.add("hidden");
        });
        const sw = it.querySelector("input");
        if (sw) sw.addEventListener("change", (e) => {
          S.hass.callService("automation", e.target.checked ? "turn_on" : "turn_off", { entity_id: a.entity_id });
        });
        const run = it.querySelector(".run");
        if (run) run.addEventListener("click", () => {
          Promise.resolve(S.hass.callService(S.kind === "scene" ? "scene" : "script", "turn_on", { entity_id: a.entity_id }))
            .then(() => status(`▶ ${a.name} ${S.kind === "scene" ? "aktiviert" : "gestartet"}`, "ok"))
            .catch((err) => status("Nicht gestartet: " + errText(err), "warn"));
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
    if (S.kind !== "automation") { if (!switchKind("automation", false)) return; }
    else if (!confirmDiscard()) return;
    newItem(factory, String(Date.now()));
  }
  function newItem(factory, id) {
    const cfg = factory();
    S.pendingCat = catOfCurrent();
    clearTrace();
    S.id = id;
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
      const cfg = S.kind === "blueprint" ? await loadBlueprint(id) : await api("GET", id);
      S.isNew = false;
      S.pendingCat = null;
      S.id = id;
      S.original = cfg;
      S.busy = true;
      loadIntoWorkspace(S.ws, cfg);
      S.busy = false;
      S.lossless = HAB.deepEqual(currentConfig(), cfg);
      if (!S.lossless) console.warn("[Blockly Automations] Rundlauf nicht identisch", { original: cfg, blocks: currentConfig() });
      store(lastKey(), id);
      clearTrace();
      await applyLayout();
      showRoot();
      S.listKey = "";
      renderList();
      renderCategorySelect();
      updateStatus(); updateSide();
      if (inspOpen()) loadRuns();
      renderDetail();
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

  const KIND_NAME = () => ({ script: "Skript", scene: "Szene", blueprint: "Blueprint" }[S.kind] || "Automation");
  async function save() {
    if (!S.id || !S.lossless) return;
    // Offenen Feld-Editor schließen, damit sein Wert sicher übernommen ist.
    Blockly.hideChaff();
    await new Promise((r) => setTimeout(r, 30));
    const cfg = currentConfig();
    if (!S.isNew && HAB.deepEqual(cfg, S.original) && !bpDirty()) { updateStatus(); return; }
    if (S.kind === "blueprint") { await saveBlueprint(cfg); return; }
    const yesNo = (title, text) => askChoice(title, text, [["Abbrechen", false], ["Trotzdem speichern", true, true]]);
    if (looseCount() && !(await yesNo("Lose Bausteine", `${looseCount()} Baustein(e) hängen nicht an der ${KIND_NAME()} und werden nicht gespeichert.`))) return;
    const missing = markMissing();
    if (missing && !(await yesNo("Auswahl fehlt", `Bei ${missing} Baustein(en) fehlt noch eine Auswahl (⚠). Home Assistant lehnt das evtl. ab.`))) return;
    // Wurde sie inzwischen woanders geändert (z. B. im HA-Editor)? Dann nicht still überschreiben.
    if (!S.isNew) {
      let now = null;
      try { now = await api("GET", S.id); } catch (e) { now = null; }
      if (now && !HAB.deepEqual(now, S.original)) {
        const what = await askChoice("Inzwischen woanders geändert",
          `Diese ${KIND_NAME()} wurde geändert, seit du sie hier geöffnet hast (z. B. im Home-Assistant-Editor oder in einem anderen Fenster). Speichern würde diese Änderungen überschreiben.`,
          [["Abbrechen", null], ["Neu laden (meine Änderungen verwerfen)", "reload"], ["Trotzdem überschreiben", "overwrite", true]]);
        if (what === "reload") { await load(S.id); status("Neu geladen – der aktuelle Stand aus Home Assistant.", "ok"); return; }
        if (what !== "overwrite") return;
      }
    }
    $("save").disabled = true;
    status("Speichere …");
    try {
      await api("POST", S.id, cfg);
      const back = await api("GET", S.id);
      S.original = back;
      S.xref = null;
      if (S.isNew) {
        S.isNew = false;
        store(lastKey(), S.id);
        const eid = await waitForEntity(S.id);
        if (eid && S.pendingCat) await setCategory(eid, S.pendingCat);
        S.pendingCat = null;
        await refreshMeta();
      }
      $("save").classList.remove("primary");
      $("save").disabled = false;
      saveLayout();
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
    if (HAB.deepEqual(currentConfig(), S.original) && !bpDirty()) return true;
    return confirm("Ungespeicherte Änderungen verwerfen?");
  }

  // Prüft alle Automationen: laden -> Blöcke -> zurück, muss identisch sein.
  async function selfTest(kind = S.kind, onProgress) {
    const ws = new Blockly.Workspace();
    const res = [];
    const list = itemList(kind);
    for (const a of list) {
      try {
        const cfg = await apiFor(kind, "GET", a.id);
        loadIntoWorkspace(ws, cfg, kind);
        res.push({ id: a.id, name: a.name, ok: HAB.deepEqual(currentConfig(ws), cfg) });
      } catch (e) {
        res.push({ id: a.id, name: a.name, ok: false, error: errText(e) });
      }
      if (onProgress) onProgress(res.length, list.length);
    }
    ws.dispose();
    return { total: res.length, ok: res.filter((r) => r.ok).length, failed: res.filter((r) => !r.ok) };
  }

  // ---------- Automationen / Skripte umschalten ----------
  const metaCount = () => `${itemList("automation").length}/${itemList("script").length}/${itemList("scene").length}`;
  function renderTabs() {
    for (const [k, id] of [["automation", "tabAuto"], ["script", "tabScript"], ["scene", "tabScene"], ["blueprint", "tabBp"]]) $(id).classList.toggle("sel", S.kind === k);
    $("search").placeholder = `${KIND_NAME()} suchen …`;
    document.body.dataset.kind = S.kind;
  }
  function switchKind(kind, autoload = true) {
    if (kind === S.kind) return true;
    if (!confirmDiscard()) return false;
    S.kind = kind;
    store("haBlockly.kind", kind);
    clearTrace();
    S.id = null; S.original = null; S.isNew = false; S.pendingCat = null; S.bp = null;
    S.busy = true;
    Blockly.Events.disable();
    try { S.ws.clear(); } finally { Blockly.Events.enable(); S.busy = false; }
    S.ws.updateToolbox(HAB.buildToolbox(rootKind()));
    renderTabs();
    S.listKey = "";
    renderList();
    renderCategorySelect();
    updateTitle();
    updateStatus();
    renderInsp();
    renderDetail();
    if (autoload) {
      const last = store(lastKey());
      if (last && itemList().some((a) => a.id === last)) load(last);
    }
    return true;
  }
  const slugify = (name) => name.toLowerCase().replace(/ä/g, "ae").replace(/ö/g, "oe").replace(/ü/g, "ue").replace(/ß/g, "ss")
    .replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "") || "skript";
  // Version B: „＋“ am Baustein – ausgeblendete Angaben (Helligkeit, Übergang, Bereich, für …) hinzufügen.
  HAB.hooks.addOptional = async (block, opts) => {
    const choice = await askChoice("Angabe hinzufügen", "Welche Angabe soll der Baustein bekommen? Leer gelassene Angaben werden nicht gespeichert.",
      [...opts.map((o, i) => [o.label, String(i), i === 0]), ["Abbrechen", null]]);
    if (choice === null || block.isDisposed()) return;
    const o = opts[Number(choice)];
    const item = HAB.blockToItem(block);
    HAB.setPath(item, o.path, o.dur ? { hours: 0, minutes: 0, seconds: 0 } : "");
    replaceBlock(block, item);
  };

  // Version B: Timer = Helfer „timer“. Danach liegen „Timer starten“ und „Timer abgelaufen“ bereit.
  async function newTimer() {
    const name = ((await askText("Name des neuen Timers", "", "z. B. „Licht Flur aus“")) || "").trim();
    if (!name) return;
    let dur = await askText("Dauer", "00:05:00", "Stunden:Minuten:Sekunden – beim Starten lässt sie sich auch einzeln angeben.");
    if (dur === null) return;
    dur = dur.trim() || "00:05:00";
    if (!/^\d{1,2}:\d{2}(:\d{2})?$/.test(dur)) { status("Dauer bitte als HH:MM:SS angeben, z. B. 00:05:00", "warn"); return; }
    let res;
    try { res = await S.hass.callWS({ type: "timer/create", name, duration: dur, restore: true, icon: "mdi:timer-outline" }); }
    catch (e) { status("Timer konnte nicht angelegt werden: " + errText(e), "err"); return; }
    const eid = `timer.${(res && res.id) || slugify(name)}`;
    try {
      const m = S.ws.getMetricsManager().getViewMetrics(true);
      const a = HAB.itemToBlockJson("action", { action: "timer.start", target: { entity_id: eid } });
      a.x = m.left + 40; a.y = m.top + 40;
      Blockly.serialization.blocks.append(a, S.ws);
      if (S.kind === "automation") {
        const t = HAB.itemToBlockJson("trigger", HAB.TIMER_FINISHED(eid));
        t.x = m.left + 40; t.y = m.top + 200;
        Blockly.serialization.blocks.append(t, S.ws);
      }
    } catch (e) { /* Bausteine sind optional */ }
    setTimeout(() => S.ws && S.ws.updateToolbox(HAB.buildToolbox(rootKind())), 500);
    status(`Timer „${name}“ angelegt (${eid}). „Timer starten“ und „Timer abgelaufen“ liegen oben links bereit.`, "ok");
  }

  // Version B: Funktion = Skript mit Parametern (fields) und „gib zurück“. Läuft parallel, damit mehrere Aufrufe gleichzeitig gehen.
  async function newFunction() {
    const name = ((await askText("Name der neuen Funktion", "", "z. B. „Helligkeit berechnen“")) || "").trim();
    if (!name) return;
    const ps = await askText("Parameter (Eingaben)", "", "Namen mit Komma trennen, z. B. „raum, stufe“. Leer lassen für keine.");
    if (ps === null) return;
    const params = [...new Set(ps.split(",").map((p) => slugify(p.trim())).filter(Boolean))];
    if (S.kind !== "script") { if (!switchKind("script", false)) return; }
    else if (!confirmDiscard()) return;
    const base = slugify(name);
    const taken = new Set(itemList("script").map((a) => a.id));
    let id = base;
    for (let i = 2; taken.has(id) || S.hass.states["script." + id]; i++) id = `${base}_${i}`;
    newItem(() => HAB.NEW_FUNCTION(name, params), id);
    status(`ƒ Neue Funktion „${name}“ (script.${id}) – Schritte vor „gib zurück“ einfügen, dann speichern`, "ok");
  }

  async function newScript() {
    const name = ((await askText("Name des neuen Skripts (Funktion)", "Neues Skript")) || "").trim();
    if (!name) return;
    if (S.kind !== "script") { if (!switchKind("script", false)) return; }
    else if (!confirmDiscard()) return;
    const base = slugify(name);
    const taken = new Set(itemList("script").map((a) => a.id));
    let id = base;
    for (let i = 2; taken.has(id) || S.hass.states["script." + id]; i++) id = `${base}_${i}`;
    newItem(() => HAB.NEW_SCRIPT(name), id);
    status(`✚ Neues Skript „${name}“ (script.${id}) – nach dem Speichern als Baustein unter „Skripte“ nutzbar`, "ok");
  }

  // ---------- Darstellung (eingeklappte Bausteine) – getrennt von der HA-Konfiguration ----------
  const layoutKey = () => `${S.kind}:${S.id}`;
  const collapsedPaths = () => {
    const r = rootBlock();
    if (!r) return [];
    return [...HAB.collectPaths(r)].filter(([p, b]) => p && b.isCollapsed()).map(([p]) => p);
  };
  function collapseAll(paths) {
    const r = rootBlock();
    if (!r || !paths || !paths.length) return;
    const map = HAB.collectPaths(r);
    S.busy = true;
    Blockly.Events.disable();
    try { for (const p of paths) { const b = map.get(p); if (b && p) b.setCollapsed(true); } } finally { Blockly.Events.enable(); S.busy = false; }
  }
  async function applyLayout() {
    if (!S.id || S.isNew) return;
    const id = S.id, kind = S.kind;
    let lay = null;
    try { lay = await S.hass.callWS({ type: "blockly_automations/layout/get", key: layoutKey() }); } catch (e) { return; }
    if (!lay || id !== S.id || kind !== S.kind) return;
    collapseAll(lay.collapsed);
    loadNotes(lay.notes);
  }
  function saveLayoutSoon() { clearTimeout(S.layoutT); S.layoutT = setTimeout(saveLayout, 800); }
  async function saveLayout() {
    if (!S.id || S.isNew || !rootBlock()) return;
    const collapsed = collapsedPaths();
    const notes = saveNotes();
    const layout = {};
    if (collapsed.length) layout.collapsed = collapsed;
    if (notes.length) layout.notes = notes;
    try {
      await S.hass.callWS({ type: "blockly_automations/layout/set", key: layoutKey(), layout: Object.keys(layout).length ? layout : null });
    } catch (e) {
      if (!S.layoutWarned) { S.layoutWarned = true; console.warn("[Blockly Automations] Darstellung nicht gespeichert (HA-Neustart nach Update nötig?)", e); }
    }
  }
  // Neu aufbauen, ohne dass eingeklappte Bausteine wieder aufgehen.
  function reloadKeepingLayout(cfg) {
    const keep = collapsedPaths();
    S.busy = true;
    loadIntoWorkspace(S.ws, cfg);
    S.busy = false;
    collapseAll(keep);
    updateStatus(); updateSide(); renderDetail();
  }

  // ---------- Markierungen im Arbeitsbereich (Trace und Live) ----------
  const OVERLAY = ["hab-run", "hab-skip", "hab-false", "hab-err", "hab-unknown", "hab-ltrue", "hab-lfalse"];
  function setCls(b, cls) {
    const g = b.getSvgRoot && b.getSvgRoot();
    if (!g) return;
    for (const c of OVERLAY) g.classList.toggle(c, cls.includes(c));
  }
  function stepClass(steps) {
    if (!steps || !steps.length) return "hab-skip";
    if (steps.some((x) => x && x.error)) return "hab-err";
    if (steps.some((x) => x && x.unknown)) return "hab-unknown";
    const last = steps[steps.length - 1];
    if (last && isObj(last.result) && last.result.result === false) return "hab-false";
    return "hab-run";
  }
  function applyOverlay() {
    if (!S.ws || !S.paths) return;
    const steps = S.trace && S.trace.steps;
    // Elemente ohne eigenen Trace-Eintrag (z. B. Optionen einer Auswahl) gelten als
    // ausgeführt, wenn darunter etwas lief.
    const keys = steps ? Object.keys(steps) : [];
    for (const [p, b] of S.paths) {
      if (!p || b.isDisposed()) continue;
      const cls = [];
      if (steps) cls.push(!steps[p] && keys.some((k) => k.startsWith(p + "/")) ? "hab-run" : stepClass(steps[p]));
      const lv = S.live ? S.liveRes[p] : undefined;
      if (lv === true) cls.push("hab-ltrue");
      else if (lv === false) cls.push("hab-lfalse");
      setCls(b, cls);
    }
  }
  function focusPath(path) {
    const map = rootBlock() ? HAB.collectPaths(rootBlock()) : null;
    const b = map && map.get(path);
    if (!b) return false;
    for (let p = b; p; p = p.getParent()) if (p !== b && p.isCollapsed()) p.setCollapsed(false);
    b.select();
    try { S.ws.centerOnBlock(b.id); } catch (e) { /* optional */ }
    return true;
  }

  // ---------- Inspektor: Abläufe (Traces), Live-Werte, Hinweise, Details ----------
  const inspOpen = () => !$("insp").classList.contains("hidden");
  const esc = (t) => String(t === undefined ? "" : t).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
  const fmtTime = (ts) => { try { return new Date(ts).toLocaleString("de-DE", { dateStyle: "short", timeStyle: "medium" }); } catch (e) { return String(ts || ""); } };
  const EXEC = {
    finished: "✓ fertig", running: "▶ läuft", failed_conditions: "✗ Bedingung nicht erfüllt", failed_single: "✗ lief schon (single)",
    failed_max_runs: "✗ zu viele Läufe", error: "⚠ Fehler", aborted: "⛔ abgebrochen", cancelled: "⛔ abgebrochen", timeout: "⏱ Zeitüberschreitung",
  };
  const runLabel = (r) => `${fmtTime(r.timestamp && r.timestamp.start)} · ${EXEC[r.script_execution] || r.script_execution || r.state || ""}`;
  function clearTrace() {
    S.trace = null; S.runs = []; S.runsErr = null;
    if (S.paths) applyOverlay();
  }
  async function loadRuns() {
    S.runs = []; S.runsErr = null;
    if (!S.id || S.isNew || !hasRuns()) { renderInsp(); return; }
    const id = S.id;
    try {
      const list = await S.hass.callWS({ type: "trace/list", domain: S.kind, item_id: S.id });
      if (id !== S.id) return;
      S.runs = (Array.isArray(list) ? list : []).sort((a, b) =>
        String((b.timestamp && b.timestamp.start) || "").localeCompare(String((a.timestamp && a.timestamp.start) || "")));
    } catch (e) { S.runsErr = errText(e); }
    renderInsp();
  }
  async function showRun(runId) {
    if (!runId) { S.trace = null; applyOverlay(); renderInsp(); renderDetail(); return; }
    try {
      const t = await S.hass.callWS({ type: "trace/get", domain: S.kind, item_id: S.id, run_id: runId });
      const cur = currentConfig();
      const cfgNoId = (c) => { if (!isObj(c)) return c; const o = HAB.clone(c); delete o.id; return o; };
      S.trace = { runId, run: t, steps: (t && t.trace) || {}, mismatch: !!(t && t.config && !HAB.deepEqual(cfgNoId(t.config), cfgNoId(cur))) };
    } catch (e) {
      S.trace = null;
      status("Ablauf nicht lesbar: " + errText(e), "warn");
    }
    applyOverlay(); renderInsp(); renderDetail();
  }
  function renderInsp() {
    if (!inspOpen()) return;
    const sel = $("runs");
    sel.innerHTML = "";
    sel.appendChild(new Option(S.runs.length ? "– keine Markierung –" : !S.id ? "– nichts geöffnet –" : S.isNew ? "– erst speichern –" : "– noch kein Ablauf –", ""));
    for (const r of S.runs) sel.appendChild(new Option(runLabel(r), r.run_id));
    sel.value = (S.trace && S.trace.runId) || "";
    renderDryOptions();
    const info = $("runInfo");
    if (S.runsErr) info.textContent = "Abläufe nicht lesbar: " + S.runsErr;
    else if (S.trace && S.trace.dry) {
      info.innerHTML = `<div><b>🧪 Trockenlauf</b> – ${esc(S.trace.label)}. Es wurde nichts ausgeführt.</div>` +
        S.trace.log.map((x) => `<div>${esc(x)}</div>`).join("") +
        '<div class="legend"><span class="lg run">würde laufen</span><span class="lg false">Bedingung jetzt nicht erfüllt</span><span class="lg unk">nicht prüfbar</span><span class="lg skip">nicht erreicht</span></div>';
    }
    else if (S.trace && S.trace.run) {
      const r = S.trace.run;
      const parts = [];
      if (r.trigger) parts.push(`Auslöser: ${r.trigger}`);
      if (r.script_execution) parts.push(EXEC[r.script_execution] || r.script_execution);
      if (r.error) parts.push(`Fehler: ${r.error}`);
      if (S.trace.mismatch) parts.push("⚠ Die Konfiguration wurde seit diesem Ablauf geändert – Markierungen können verrutscht sein.");
      info.innerHTML = parts.map((x) => `<div>${esc(x)}</div>`).join("") +
        '<div class="legend"><span class="lg run">ausgeführt</span><span class="lg false">Bedingung falsch</span><span class="lg err">Fehler</span><span class="lg skip">nicht erreicht</span></div>';
    } else info.textContent = S.runs.length ? `${S.runs.length} gespeicherte Abläufe – einen wählen, um ihn im Baustein-Bild zu sehen.` : "";
    renderHints();
  }
  // Trockenlauf: Auslöser zur Auswahl (bei Skripten keiner).
  function renderDryOptions() {
    const dsel = $("dryTrigger");
    const cfg = rootBlock() ? currentConfig() : null;
    const trigs = cfg && rootKind() === "root" ? [].concat(cfg.triggers || cfg.trigger || []) : [];
    const keep = dsel.value;
    dsel.innerHTML = "";
    trigs.forEach((t, i) => {
      let txt = "";
      try { txt = HAB.hooks.describe("trigger", t) || ""; } catch (e) { txt = ""; }
      dsel.appendChild(new Option(`${i + 1}. ${(isObj(t) && t.id ? "[" + t.id + "] " : "")}${txt || "Auslöser"}`.slice(0, 80), String(i)));
    });
    if (keep && [...dsel.options].some((o) => o.value === keep)) dsel.value = keep;
    dsel.style.display = trigs.length ? "" : "none";
    $("dryRun").disabled = !cfg || !hasRuns();
  }
  const stateObj = (st) => (st ? { entity_id: st.entity_id, state: st.state, attributes: st.attributes, name: fname(st) || st.entity_id, last_changed: st.last_changed } : null);
  async function runDry() {
    const cfg = currentConfig();
    if (!cfg) return;
    const idx = Number($("dryTrigger").value || 0);
    const t = S.kind === "script" ? null : [].concat(cfg.triggers || cfg.trigger || [])[idx];
    const ent = t && (typeof t.entity_id === "string" ? t.entity_id : Array.isArray(t.entity_id) ? t.entity_id[0] : "");
    const st = ent ? S.hass.states[ent] : null;
    const trig = t ? { id: t.id !== undefined ? String(t.id) : String(idx), idx: String(idx), platform: t.trigger || t.platform, entity_id: ent || undefined,
      to_state: stateObj(st), from_state: stateObj(st) } : undefined;
    const vars = trig ? { trigger: trig } : {};
    $("dryRun").disabled = true;
    status("🧪 Trockenlauf läuft …");
    try {
      const res = await HAB.dryRun(cfg, rootKind(), async (c, v) => {
        const r = await S.hass.callWS({ type: "test_condition", condition: c, variables: v });
        return r && typeof r.result === "boolean" ? r.result : null;
      }, { index: idx, id: trig ? trig.id : "", vars });
      const label = t ? `angenommen: Auslöser ${idx + 1}${t.id ? " [" + t.id + "]" : ""}, Zustände von jetzt` : "mit den Zuständen von jetzt";
      S.trace = { dry: true, steps: res.steps, log: res.log, label };
      markMissing();
      applyOverlay(); renderInsp(); renderDetail();
      updateStatus();
    } catch (e) { status("Trockenlauf fehlgeschlagen: " + errText(e), "warn"); }
    $("dryRun").disabled = false;
  }
  function renderHints() {
    const box = $("hints");
    if (!box || !inspOpen()) return;
    box.innerHTML = "";
    if (!S.hints.length) { box.innerHTML = '<div class="hint">Keine Hinweise 👍</div>'; return; }
    for (const h of S.hints) {
      const d = document.createElement("div");
      d.className = "hintItem " + h.level;
      d.textContent = (h.level === "warn" ? "⚠ " : "💡 ") + h.msg;
      d.title = h.path ? "Zum Baustein springen" : "";
      d.addEventListener("click", () => { if (h.path) focusPath(h.path); });
      if (h.fix) {
        // Korrektur mit einem Klick (lässt sich mit ↶ rückgängig machen; gespeichert wird erst mit „Speichern“).
        const b = document.createElement("button");
        b.className = "fixBtn";
        b.textContent = "🔧 " + h.fix.label;
        b.addEventListener("click", (e) => {
          e.stopPropagation();
          const cfg = currentConfig();
          if (!cfg) return;
          try { reloadKeepingLayout(h.fix.apply(cfg)); status("Korrigiert: " + h.fix.label + " – noch nicht gespeichert", "ok"); }
          catch (err) { status("Korrektur fehlgeschlagen: " + errText(err), "warn"); }
        });
        d.appendChild(b);
      }
      box.appendChild(d);
    }
  }

  // Details zum ausgewählten Baustein: Ablauf-Schritte, Live-Zustände, Template-Vorschau.
  function stopTemplates() {
    for (const p of S.tplUnsubs) Promise.resolve(p).then((f) => typeof f === "function" && f()).catch(() => {});
    S.tplUnsubs = [];
  }
  function ownTemplates(item, kind) {
    const out = [];
    if (typeof item === "string") return item.includes("{") ? [item] : out;
    if (!isObj(item)) return out;
    const lists = HAB.specFor(kind, item).lists.map((l) => l.path.split(".")[0]);
    const scan = (v) => {
      if (typeof v === "string") { if (/\{\{|\{%/.test(v) && !out.includes(v)) out.push(v); }
      else if (Array.isArray(v)) v.forEach(scan);
      else if (isObj(v)) Object.values(v).forEach(scan);
    };
    for (const [k, v] of Object.entries(item)) if (!lists.includes(k)) scan(v);
    return out.slice(0, 4);
  }
  const shortJson = (v, n = 600) => { let t; try { t = typeof v === "string" ? v : JSON.stringify(v, null, 2); } catch (e) { t = String(v); } return t && t.length > n ? t.slice(0, n - 1) + "…" : t; };
  function renderDetail() {
    if (!inspOpen()) return;
    stopTemplates();
    const box = $("detail");
    const sel = selectedBlock();
    const b = (sel && !sel.isDisposed() ? sel : null) || rootBlock();
    if (!b) { box.innerHTML = '<div class="hint">Nichts geöffnet.</div>'; $("detailLive").innerHTML = ""; return; }
    if (S.paths && !S.paths.has(b.habPath_)) markMissing();
    const path = b.habPath_ || "";
    const isRoot = HAB.ROOTS.has(b.haKind_);
    const html = [];
    html.push(`<div class="dTitle">${esc(String((b.spec_ && b.spec_.title) || ""))}</div>`);
    if (path) html.push(`<div class="hint">Pfad: <code>${esc(path)}</code></div>`);
    if (S.trace && !isRoot) {
      const steps = S.trace.steps[path];
      if (!steps) html.push('<div class="hint">Im gewählten Ablauf nicht erreicht.</div>');
      else steps.slice(0, 10).forEach((st, i) => {
        html.push(`<div class="step"><b>${steps.length > 1 ? `${i + 1}. ` : ""}${esc(fmtTime(st.timestamp))}</b>`);
        if (st.error) html.push(`<div class="err">Fehler: ${esc(st.error)}</div>`);
        if (st.result !== undefined) html.push(`<div>Ergebnis:</div><pre>${esc(shortJson(st.result))}</pre>`);
        if (st.changed_variables && Object.keys(st.changed_variables).length) html.push(`<div>Variablen:</div><pre>${esc(shortJson(st.changed_variables))}</pre>`);
        html.push("</div>");
      });
    } else if (S.trace && isRoot && S.trace.run) {
      const tk = Object.keys(S.trace.steps).find((k) => k.startsWith("trigger/"));
      const st = tk && Array.isArray(S.trace.steps[tk]) ? S.trace.steps[tk][0] || {} : null;
      if (st) html.push(`<div class="hint">Auslöser-Daten:</div><pre>${esc(shortJson(st.changed_variables || st))}</pre>`);
    }
    box.innerHTML = html.join("");
    // YAML des Bausteins (wie im HA-Editor), nur zum Lesen.
    try {
      const yi = isRoot ? currentConfig() : HAB.blockToItem(b);
      const det = document.createElement("details");
      det.className = "yaml";
      det.open = store("haBlockly.yaml") === "1";
      det.innerHTML = "<summary>YAML</summary><pre></pre>";
      det.querySelector("pre").textContent = HAB.toYaml(yi);
      det.addEventListener("toggle", () => store("haBlockly.yaml", det.open ? "1" : "0"));
      box.appendChild(det);
    } catch (e) { /* optional */ }
    // Template-Vorschau (live, über render_template)
    let item = null;
    try { item = HAB.blockToItem(b); } catch (e) { item = null; }
    if (!isRoot && item !== null) {
      for (const tpl of ownTemplates(item, b.haKind_)) {
        const d = document.createElement("div");
        d.className = "tpl";
        d.innerHTML = `<div class="hint">Template:</div><pre>${esc(shortJson(tpl, 300))}</pre><div class="hint">Ergebnis jetzt:</div><pre class="tplRes">…</pre>`;
        box.appendChild(d);
        const out = d.querySelector(".tplRes");
        try {
          const p = S.hass.connection.subscribeMessage((msg) => {
            if (msg && msg.error) { out.textContent = "⚠ " + msg.error; out.classList.add("err"); }
            else if (msg && "result" in msg) { out.textContent = shortJson(msg.result, 400); out.classList.remove("err"); }
          }, { type: "render_template", template: tpl, timeout: 3, strict: false, report_errors: true });
          p.catch((e) => { out.textContent = "⚠ " + errText(e) + (/trigger/.test(tpl) ? " (nutzt Auslöser-Daten, die es nur während eines Ablaufs gibt)" : ""); out.classList.add("err"); });
          S.tplUnsubs.push(p);
        } catch (e) { out.textContent = "Vorschau nicht verfügbar"; }
      }
    }
    renderDetailLive();
  }
  function renderDetailLive() {
    const box = $("detailLive");
    if (!box || !inspOpen()) return;
    const sel = selectedBlock();
    const b = (sel && !sel.isDisposed() ? sel : null) || rootBlock();
    if (!b) { box.innerHTML = ""; return; }
    let refs = [];
    try {
      const all = HAB.references(HAB.blockToItem(b), b.haKind_);
      refs = HAB.ROOTS.has(b.haKind_) ? all : all.filter((r) => r.path === "");
    } catch (e) { refs = []; }
    const ents = [...new Set(refs.map((r) => r.entity))].slice(0, 30);
    if (!ents.length) { box.innerHTML = ""; return; }
    box.innerHTML = '<div class="hint">Zustände jetzt:</div>' + ents.map((e) => {
      const st = S.hass.states[e];
      let val = st ? st.state : "– existiert nicht –";
      try { if (st && S.hass.formatEntityState) val = S.hass.formatEntityState(st); } catch (er) { /* Rohwert */ }
      const since = st && st.last_changed ? ` <span class="hint">seit ${esc(fmtTime(st.last_changed))}</span>` : "";
      return `<div class="ent${st ? "" : " err"}"><span>${esc((st && st.attributes.friendly_name) || e)}</span><b>${esc(val)}</b>${since}</div>`;
    }).join("");
  }

  // Live-Modus: Bedingungen jetzt prüfen (HA test_condition) und Zustände mitführen.
  async function runLive() {
    if (!S.live || !S.paths || S.liveBusy) return;
    S.liveBusy = true;
    const res = {};
    let n = 0;
    try {
      for (const [p, b] of S.paths) {
        if (!p || b.isDisposed() || b.haKind_ !== "condition" || !b.isEnabled() || n >= 60) continue;
        let item;
        try { item = HAB.blockToItem(b); } catch (e) { continue; }
        // Bedingungen mit Auslöser-Daten lassen sich außerhalb eines Ablaufs nicht prüfen.
        if (/"condition":"trigger"|trigger\./.test(JSON.stringify(item))) continue;
        if (HAB.missingInfo(item)) continue;
        n++;
        try { const r = await S.hass.callWS({ type: "test_condition", condition: item }); res[p] = !!(r && r.result); } catch (e) { /* unbekannt */ }
      }
    } finally { S.liveBusy = false; }
    S.liveRes = res;
    applyOverlay();
  }
  function liveTick() {
    if (!inspOpen()) return;
    clearTimeout(S.liveDetailT);
    S.liveDetailT = setTimeout(renderDetailLive, 700);
  }
  function setLive(on) {
    S.live = on;
    clearInterval(S.liveTimer);
    S.liveRes = {};
    if (on) { runLive(); S.liveTimer = setInterval(runLive, 5000); }
    applyOverlay();
  }

  // ---------- Fenster (Querverweise, Selbsttest) ----------
  function openModal(title) {
    $("mTitle").textContent = title;
    $("mStatus").textContent = "";
    $("mBody").innerHTML = "";
    $("modal").classList.remove("hidden");
    return $("mBody");
  }
  const closeModal = () => $("modal").classList.add("hidden");
  async function openItem(kind, id, path) {
    closeModal();
    if (kind !== S.kind) { if (!switchKind(kind, false)) return; }
    else if (id !== S.id || S.isNew) { if (!confirmDiscard()) return; }
    if (id !== S.id || S.isNew) await load(id);
    if (path) setTimeout(() => focusPath(path), 50);
  }

  // Querverweise: wer löst auf eine Entität aus, wer prüft sie, wer schaltet sie, wer ruft ein Skript auf?
  async function buildXref(force) {
    if (S.xref && !force) return S.xref;
    const all = [...itemList("automation"), ...itemList("script"), ...itemList("scene")];
    const rows = [];
    const queue = all.slice();
    let done = 0;
    const worker = async () => {
      while (queue.length) {
        const a = queue.shift();
        try {
          const cfg = await apiFor(a.kind, "GET", a.id);
          for (const r of HAB.references(cfg, rootKind(a.kind))) rows.push({ ...r, kind: a.kind, id: a.id, name: a.name, self: a.entity_id });
        } catch (e) { /* z. B. YAML-Paket ohne Bearbeitung */ }
        done++;
        $("mStatus").textContent = `lese ${done}/${all.length} …`;
      }
    };
    await Promise.all(Array.from({ length: 6 }, worker));
    $("mStatus").textContent = "";
    S.xref = { rows, at: Date.now() };
    return S.xref;
  }
  const ROLE = [["trigger", "Löst aus"], ["condition", "Prüft"], ["action", "Schaltet / nutzt"], ["call", "Ruft auf"], ["blueprint", "Blueprint nutzt"]];
  async function showXref(force) {
    const body = openModal("🔗 Querverweise");
    body.innerHTML = '<div class="xhead"><input id="xq" type="search" placeholder="Entität oder Name filtern …" autocomplete="off">' +
      '<label class="chk"><input type="checkbox" id="xmine"> nur was diese/s hier benutzt</label><button id="xreload">Neu einlesen</button></div><div id="xlist" class="hint">Lese alle Automationen und Skripte …</div>';
    const mine = $("xmine");
    mine.checked = !!(S.id && rootBlock());
    mine.disabled = !rootBlock();
    $("xreload").addEventListener("click", () => showXref(true));
    const x = await buildXref(force);
    const render = () => {
      const q = $("xq").value.trim().toLowerCase();
      let own = null;
      if (mine.checked && rootBlock()) {
        own = new Set(HAB.references(currentConfig(), rootKind()).map((r) => r.entity));
        const selfId = S.id && entityOf(S.id);
        if (selfId) own.add(selfId);
      }
      const byEnt = new Map();
      for (const r of x.rows) {
        if (own && !own.has(r.entity)) continue;
        const st = S.hass.states[r.entity];
        const nm = (st && st.attributes.friendly_name) || "";
        if (q && !r.entity.includes(q) && !nm.toLowerCase().includes(q) && !r.name.toLowerCase().includes(q)) continue;
        if (!byEnt.has(r.entity)) byEnt.set(r.entity, { nm, rows: [] });
        byEnt.get(r.entity).rows.push(r);
      }
      const list = $("xlist");
      list.className = "";
      list.innerHTML = "";
      const ents = [...byEnt.entries()].sort((a, b) => (a[1].nm || a[0]).localeCompare(b[1].nm || b[0], "de")).slice(0, 300);
      if (!ents.length) { list.innerHTML = '<div class="hint">Keine Treffer.</div>'; return; }
      for (const [ent, g] of ents) {
        const card = document.createElement("div");
        card.className = "xcard";
        const st = S.hass.states[ent];
        card.innerHTML = `<div class="xent"><b></b> <code></code> <span class="hint"></span></div>`;
        card.querySelector("b").textContent = g.nm || ent;
        card.querySelector("code").textContent = ent;
        card.querySelector(".hint").textContent = st ? `= ${st.state}` : "(existiert nicht)";
        for (const [role, label] of ROLE) {
          const rs = g.rows.filter((r) => r.role === role);
          if (!rs.length) continue;
          const line = document.createElement("div");
          line.className = "xrole";
          line.innerHTML = `<span class="xr">${label}:</span>`;
          const seen = new Set();
          for (const r of rs) {
            const key = r.kind + r.id;
            if (seen.has(key)) continue;
            seen.add(key);
            const a = document.createElement("a");
            a.href = "#";
            a.textContent = ({ script: "📜 ", scene: "🎬 " }[r.kind] || "🤖 ") + r.name;
            a.title = r.path;
            a.addEventListener("click", (e) => { e.preventDefault(); openItem(r.kind, r.id, r.path); });
            line.appendChild(a);
          }
          card.appendChild(line);
        }
        list.appendChild(card);
      }
    };
    $("xq").addEventListener("input", render);
    mine.addEventListener("change", render);
    render();
  }

  async function showSelfTest() {
    if (S.kind === "blueprint") { status("Der Selbsttest gilt für Automationen, Skripte und Szenen.", "warn"); return; }
    const body = openModal(`🧪 Alle ${{ script: "Skripte", scene: "Szenen" }[S.kind] || "Automationen"} prüfen`);
    body.innerHTML = '<div class="hint">Prüft, ob jede Konfiguration verlustfrei als Bausteine dargestellt werden kann (nur lesen, nichts wird gespeichert).</div><div id="stRes"></div>';
    const res = await selfTest(S.kind, (i, n) => { $("mStatus").textContent = `${i}/${n}`; });
    $("mStatus").textContent = "";
    const box = $("stRes");
    box.innerHTML = `<p><b>${res.ok} von ${res.total}</b> verlustfrei darstellbar.</p>`;
    if (!res.failed.length) { box.innerHTML += "<p>Alles in Ordnung 👍</p>"; return; }
    box.innerHTML += "<p>Diese lassen sich noch nicht verlustfrei darstellen (Speichern dort gesperrt) – gern als Beispiel (ohne echte Namen) melden:</p>";
    for (const f of res.failed) {
      const a = document.createElement("a");
      a.href = "#";
      a.className = "stItem";
      a.textContent = f.name + (f.error ? ` – ${f.error}` : "");
      a.addEventListener("click", (e) => { e.preventDefault(); openItem(S.kind, f.id); });
      box.appendChild(a);
    }
  }

  // ---------- Knöpfe der neuen Bereiche ----------
  $("tabAuto").addEventListener("click", () => switchKind("automation"));
  $("tabScript").addEventListener("click", () => switchKind("script"));
  $("insBtn").addEventListener("click", () => {
    $("insp").classList.toggle("hidden");
    store("haBlockly.insp", inspOpen() ? "1" : "0");
    if (S.ws) Blockly.svgResize(S.ws);
    if (inspOpen()) { loadRuns(); renderDetail(); } else { stopTemplates(); }
  });
  $("inspClose").addEventListener("click", () => $("insBtn").click());
  $("runs").addEventListener("change", (e) => showRun(e.target.value));
  $("runsReload").addEventListener("click", () => loadRuns());
  $("dryRun").addEventListener("click", runDry);
  $("live").addEventListener("change", (e) => setLive(e.target.checked));
  $("xrefBtn").addEventListener("click", () => showXref(false));
  $("selfTestBtn").addEventListener("click", () => showSelfTest());
  $("mClose").addEventListener("click", closeModal);
  $("modal").addEventListener("click", (e) => { if (e.target === $("modal")) closeModal(); });
  if (store("haBlockly.insp") === "1" && window.innerWidth >= 800) $("insp").classList.remove("hidden");

  // ---------- Plugins und Komfort ----------
  // Deutsche Texte für die Suche im Werkzeugkasten.
  Object.assign(Blockly.Msg, {
    TOOLBOX_SEARCH_PLACEHOLDER: "Bausteine suchen …", TOOLBOX_SEARCH_PROMPT: "Suchbegriff eingeben",
    TOOLBOX_SEARCH_NO_RESULTS: "Keine Bausteine gefunden", TOOLBOX_SEARCH_RESULT_COUNT: "%1 Bausteine gefunden", TOOLBOX_SEARCH_RESULT_COUNT_ONE: "1 Baustein gefunden",
  });
  const hasSearch = () => { try { return !!Blockly.registry.getClass(Blockly.registry.Type.TOOLBOX_ITEM, "search"); } catch (e) { return false; } };
  function initPlugins() {
    // Mini-Karte (große Automationen) – nur auf breiten Bildschirmen.
    // Kopieren/Einfügen zwischen Automationen (und Browser-Tabs).
    try { if (window.CrossTabCopyPaste && !window.__habCrossTab) { new window.CrossTabCopyPaste().init({ contextMenu: true, shortcut: true }); window.__habCrossTab = true; } } catch (e) { console.warn("Kopieren", e); }
    // Rucksack: Lieblings-Bausteine für alle Automationen (in HA gespeichert).
    try {
      if (window.Backpack) {
        S.backpack = new window.Backpack(S.ws, {
          allowEmptyBackpackOpen: true, useFilledBackpackImage: true, skipSerializerRegistration: true,
          contextMenu: { emptyBackpack: true, removeFromBackpack: true, copyToBackpack: true, copyAllToBackpack: false, pasteAllToBackpack: false, disablePreconditionChecks: false },
        });
        S.backpack.init();
        S.hass.callWS({ type: "blockly_automations/layout/get", key: "__backpack__" }).then((b) => {
          if (b && Array.isArray(b.contents)) { S.bpLoading = true; S.backpack.setContents(b.contents); S.bpLoading = false; }
        }).catch(() => {});
      }
    } catch (e) { console.warn("Rucksack", e); }
    // Notiz im Arbeitsbereich (Rechtsklick auf freie Fläche).
    try {
      const reg = Blockly.ContextMenuRegistry.registry;
      if (!reg.getItem("habNote")) reg.register({
        id: "habNote", weight: 1, scopeType: Blockly.ContextMenuRegistry.ScopeType.WORKSPACE,
        displayText: () => "🗒 Notiz hier hinzufügen", preconditionFn: () => (S.id ? "enabled" : "hidden"),
        callback: (scope, e) => {
          const ws = scope.workspace;
          const m = ws.getMetricsManager().getViewMetrics(true);
          Blockly.serialization.workspaceComments.append({ text: "Notiz", x: m.left + 40, y: m.top + 40, width: 200, height: 100 }, ws);
          saveLayoutSoon();
        },
      });
      // Mehrfachauswahl: Shift+Klick sammelt Bausteine, Rechtsklick wirkt auf alle.
      const multi = (id, text, fn) => {
        if (reg.getItem(id)) return;
        reg.register({
          id, weight: -10, scopeType: Blockly.ContextMenuRegistry.ScopeType.BLOCK,
          displayText: () => `${text} (${S.multi.size} markiert)`,
          preconditionFn: (scope) => (S.multi.size > 1 && S.multi.has(scope.block.id) ? "enabled" : "hidden"),
          callback: () => { Blockly.Events.setGroup(true); try { fn(multiBlocks()); } finally { Blockly.Events.setGroup(false); } clearMulti(); },
        });
      };
      const MAN = (Blockly.constants && Blockly.constants.MANUALLY_DISABLED) || "MANUALLY_DISABLED";
      multi("habMultiOff", "⏸ Alle deaktivieren", (bs) => bs.forEach((b) => !HAB.ROOTS.has(b.haKind_) && b.setDisabledReason(true, MAN)));
      multi("habMultiOn", "▶ Alle aktivieren", (bs) => bs.forEach((b) => b.setDisabledReason(false, MAN)));
      multi("habMultiCollapse", "▸ Alle einklappen", (bs) => bs.forEach((b) => b.setCollapsed(true)));
      multi("habMultiDelete", "🗑 Alle löschen", (bs) => bs.forEach((b) => !HAB.ROOTS.has(b.haKind_) && !b.isDisposed() && b.dispose(true)));
      multi("habMultiBackpack", "🎒 Alle in den Rucksack", (bs) => { if (S.backpack) bs.forEach((b) => S.backpack.addBlock(b)); });
    } catch (e) { console.warn("Kontextmenü", e); }
  }
  // Rucksack in HA speichern (für alle Geräte).
  function saveBackpackSoon() {
    if (S.bpLoading || !S.backpack) return;
    clearTimeout(S.bpT);
    S.bpT = setTimeout(() => {
      S.hass.callWS({ type: "blockly_automations/layout/set", key: "__backpack__", layout: { contents: S.backpack.getContents() } }).catch(() => {});
    }, 600);
  }
  // Notizen (Workspace-Kommentare) gehören zur Darstellung, nicht zur Automation.
  function saveNotes() {
    try { return S.ws.getTopComments(false).map((c) => Blockly.serialization.workspaceComments.save(c)); } catch (e) { return []; }
  }
  function loadNotes(notes) {
    if (!Array.isArray(notes) || !notes.length) return;
    S.busy = true;
    try { for (const n of notes) Blockly.serialization.workspaceComments.append(n, S.ws); } catch (e) { console.warn("Notizen", e); } finally { S.busy = false; }
  }
  // Mehrfachauswahl
  S.multi = new Set();
  document.addEventListener("pointerdown", (e) => { S.shift = e.shiftKey; }, true);
  const multiBlocks = () => [...S.multi].map((id) => S.ws.getBlockById(id)).filter((b) => b && !b.isDisposed());
  function paintMulti() {
    for (const b of S.ws.getAllBlocks(false)) { const g = b.getSvgRoot && b.getSvgRoot(); if (g) g.classList.toggle("hab-multi", S.multi.has(b.id)); }
  }
  function clearMulti() { S.multi.clear(); paintMulti(); }
  function multiSelect(e) {
    if (!e.newElementId) return;
    const prev = S.lastSel;
    S.lastSel = e.newElementId;
    if (S.shift) {
      if (!S.multi.size && prev && prev !== e.newElementId && S.ws.getBlockById(prev)) S.multi.add(prev);
      if (S.multi.has(e.newElementId) && S.multi.size > 1) S.multi.delete(e.newElementId); else S.multi.add(e.newElementId);
      status(`${S.multi.size} Bausteine markiert – Rechtsklick für Aktionen, Klick ohne Shift hebt auf`, "ok");
    } else if (S.multi.size) S.multi.clear();
    paintMulti();
  }

  // Suche im Arbeitsbereich (Strg+F): findet Bausteine nach ihrem Text.
  function wsFind(q, dir = 1) {
    const box = $("find");
    const qs = q.trim().toLowerCase();
    if (!qs || !S.ws) { $("findInfo").textContent = ""; return; }
    const hits = S.ws.getAllBlocks(true).filter((b) => {
      let t = "";
      try { t = b.toString(); } catch (e) { t = ""; }
      const raw = HAB.isObj(b.raw_) ? JSON.stringify(b.raw_) : "";
      return (t + " " + raw).toLowerCase().includes(qs);
    });
    if (!hits.length) { $("findInfo").textContent = "keine Treffer"; return; }
    S.findIdx = ((S.findIdx || 0) + dir + hits.length) % hits.length;
    if (S.findQ !== qs) { S.findQ = qs; S.findIdx = 0; }
    const b = hits[S.findIdx];
    for (let p = b.getParent(); p; p = p.getParent()) if (p.isCollapsed()) p.setCollapsed(false);
    b.select();
    try { S.ws.centerOnBlock(b.id); } catch (e) { /* optional */ }
    $("findInfo").textContent = `${S.findIdx + 1} / ${hits.length}`;
    box.classList.remove("hidden");
  }
  document.addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "f" && S.ws) {
      e.preventDefault();
      $("find").classList.remove("hidden");
      $("findInput").focus();
      $("findInput").select();
    }
  });
  $("findInput").addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); wsFind($("findInput").value, e.shiftKey ? -1 : 1); }
    if (e.key === "Escape") $("find").classList.add("hidden");
  });
  $("findInput").addEventListener("input", () => { S.findIdx = -1; wsFind($("findInput").value, 1); });
  $("findClose").addEventListener("click", () => $("find").classList.add("hidden"));
  $("fitBtn").addEventListener("click", () => { if (S.ws) S.ws.zoomToFit(); });
  $("findBtn").addEventListener("click", () => { $("find").classList.toggle("hidden"); if (!$("find").classList.contains("hidden")) $("findInput").focus(); });

  // ---------- Auswahl nach Typ ----------
  const TYPE_TITLE = { trigger: "Auslöser", condition: "Bedingung", action: "Aktion" };
  function pickType(kind, title) {
    return new Promise((resolve) => {
      const groups = HAB.typeCatalog(kind, HAB.hooks.services(), HAB.hooks.domainName)
        .map((g) => ({ ...g, items: g.items.filter((x) => x.blockly === undefined || x.blockly === BLOCKLY) }))
        .filter((g) => g.items.length);
      const body = openModal(title || `${TYPE_TITLE[kind] || "Baustein"} hinzufügen – nach Typ`);
      body.innerHTML = '<input id="tq" type="search" placeholder="Typ suchen …" autocomplete="off" class="tq"><div id="tlist" class="tlist"></div>';
      let done = false;
      const finish = (v) => { if (done) return; done = true; closeModal(); resolve(v); };
      const onClose = () => finish(null);
      $("mClose").addEventListener("click", onClose, { once: true });
      const render = () => {
        const q = $("tq").value.trim().toLowerCase();
        const list = $("tlist");
        list.innerHTML = "";
        let n = 0;
        for (const g of groups) {
          const items = g.items.filter((x) => !q || x.label.toLowerCase().includes(q) || (x.hint || "").toLowerCase().includes(q) || g.group.toLowerCase().includes(q));
          if (!items.length) continue;
          const h = document.createElement("div");
          h.className = "tgroup";
          h.textContent = g.group;
          list.appendChild(h);
          for (const x of items.slice(0, q ? 200 : 60)) {
            const b = document.createElement("button");
            b.className = "titem";
            b.innerHTML = "<span></span><small></small>";
            b.querySelector("span").textContent = x.label;
            b.querySelector("small").textContent = x.hint || "";
            b.addEventListener("click", () => finish(HAB.stripEmpty(HAB.clone(x.item))));
            list.appendChild(b);
            n++;
          }
        }
        if (!n) list.innerHTML = '<div class="hint">Kein passender Typ.</div>';
      };
      $("tq").addEventListener("input", render);
      $("tq").addEventListener("keydown", (e) => { if (e.key === "Enter") { const f = $("tlist").querySelector(".titem"); if (f) f.click(); } });
      render();
      setTimeout(() => $("tq").focus(), 0);
    });
  }
  // Rechtsklick „Typ ändern“: passende Werte (Entität, Ziel, Name, ID) bleiben erhalten.
  HAB.hooks.changeType = async (block) => {
    if (!block || block.isDisposed()) return;
    let kind = block.haKind_;
    const prev = block.previousConnection && block.previousConnection.targetConnection;
    if (kind === "condition" && prev && (prev.getCheck() || []).includes("ha_action")) kind = "action";
    const tpl = await pickType(kind, `${TYPE_TITLE[kind]} – Typ ändern`);
    if (!tpl || block.isDisposed()) return;
    replaceBlock(block, HAB.convertType(HAB.blockToItem(block), tpl));
    status("Typ geändert – passende Werte wurden übernommen.", "ok");
  };
  S.ws_buttons = () => {
    for (const k of ["trigger", "condition", "action"]) S.ws.registerButtonCallback("type_" + k, () => {
      const r = rootBlock();
      if (!r) return;
      const input = S.kind === "script" || (S.kind === "blueprint" && rootKind() === "script") ? "L0" : "L" + ["trigger", "condition", "action"].indexOf(k);
      pickType(k).then((item) => { if (item && !r.isDisposed()) appendToInput(r, input, HAB.classify(k, item), item); });
    });
  };

  // ---------- Szenen ----------
  const sceneValue = (eid, old) => {
    const st = S.hass.states[eid];
    if (!st) return old;
    const attrs = {};
    for (const a of HAB.SCENE_ATTRS) if (a in st.attributes && st.attributes[a] !== null && st.attributes[a] !== undefined) attrs[a] = st.attributes[a];
    return st.state === "off" || !Object.keys(attrs).length ? st.state : { state: st.state, ...attrs };
  };
  HAB.hooks.captureScene = (block) => {
    if (!block || block.isDisposed()) return;
    if (block.haKind_ === "scene") {
      const cfg = currentConfig();
      if (!cfg || !isObj(cfg.entities)) return;
      for (const e of Object.keys(cfg.entities)) cfg.entities[e] = sceneValue(e, cfg.entities[e]);
      reloadKeepingLayout(cfg);
      status("📸 Zustände von jetzt übernommen – noch nicht gespeichert.", "ok");
      return;
    }
    const it = HAB.blockToItem(block);
    if (!it.__e) { status("Bitte zuerst eine Entität wählen.", "warn"); return; }
    it.__v = sceneValue(it.__e, it.__v);
    replaceBlock(block, it);
  };
  async function newScene() {
    const name = ((await askText("Name der neuen Szene", "Neue Szene")) || "").trim();
    if (!name) return;
    if (S.kind !== "scene") { if (!switchKind("scene", false)) return; }
    else if (!confirmDiscard()) return;
    newItem(() => ({ name, entities: {} }), String(Date.now()));
    status("✚ Neue Szene – Entitäten aus dem Werkzeugkasten in ENTITÄTEN ziehen, dann „📸 Zustand übernehmen“.", "ok");
  }

  // ---------- Blueprints ----------
  const bpDirty = () => !!(S.kind === "blueprint" && S.bp && !HAB.deepEqual(S.bp.meta, S.bp.metaOrig));
  const bpInputNames = (input) => {
    const out = [];
    (function walk(o) { for (const [k, v] of Object.entries(o || {})) { if (v && isObj(v.input)) walk(v.input); else out.push(k); } })(input);
    return out;
  };
  // Laden: HA setzt für jede Eingabe einen Platzhalter ein – so wird der Blueprint zur bearbeitbaren Automation.
  async function loadBlueprint(id) {
    const i = id.indexOf(":");
    const domain = id.slice(0, i), path = id.slice(i + 1);
    const bp = (S.blueprints[domain] || {})[path];
    if (!bp || !bp.metadata) throw new Error("Blueprint nicht gefunden");
    const input = {};
    for (const n of bpInputNames(bp.metadata.input)) input[n] = HAB.inputPlaceholder(n);
    const res = await S.hass.callWS({ type: "blueprint/substitute", domain, path, input });
    S.bp = { domain, path, meta: HAB.clone(bp.metadata), metaOrig: HAB.clone(bp.metadata) };
    return (res && (res.substituted_config || res.config)) || res;
  }
  async function saveBlueprint(cfg) {
    const { domain, path, meta } = S.bp;
    if (!S.bp.isNew && !S.bp.warned) {
      const ok = await askChoice("Blueprint speichern", `Die Datei blueprints/${domain}/${path} wird neu geschrieben. Kommentare und Formatierung in der YAML-Datei gehen dabei verloren.` +
        (meta.source_url ? " Achtung: Dieser Blueprint wurde importiert – ein erneuter Import überschreibt deine Änderungen." : ""), [["Abbrechen", false], ["Speichern", true, true]]);
      if (!ok) return;
      S.bp.warned = true;
    }
    const doc = { blueprint: meta };
    for (const [k, v] of Object.entries(cfg)) if (k !== "id") doc[k] = v;
    const yaml = HAB.toYaml(doc) + "\n";
    $("save").disabled = true;
    status("Speichere Blueprint …");
    try {
      try { await S.hass.callWS({ type: "blueprint/save", domain, path, yaml, allow_override: true }); }
      catch (e) { if (/allow_override|extra keys/i.test(errText(e))) await S.hass.callWS({ type: "blueprint/save", domain, path, yaml }); else throw e; }
      S.bp.isNew = false;
      S.isNew = false;
      S.bp.metaOrig = HAB.clone(meta);
      S.original = cfg;
      await refreshMeta();
      status("✓ Blueprint gespeichert", "ok");
    } catch (e) { status("Blueprint nicht gespeichert: " + errText(e), "warn"); }
    $("save").disabled = false;
    updateStatus();
  }
  async function newBlueprint(fromCfg, meta) {
    const name = meta ? meta.name : ((await askText("Name des neuen Blueprints", "Neuer Blueprint")) || "").trim();
    if (!name) return;
    if (S.kind !== "blueprint") { if (!switchKind("blueprint", false)) return; }
    else if (!confirmDiscard()) return;
    const domain = meta ? meta.domain : "automation";
    let path = `blockly/${slugify(name)}.yaml`;
    for (let i = 2; (S.blueprints[domain] || {})[path]; i++) path = `blockly/${slugify(name)}_${i}.yaml`;
    const m = meta || { name, description: "", domain, input: {} };
    S.bp = { domain, path, meta: m, metaOrig: HAB.clone(m), isNew: true };
    newItem(() => fromCfg || { triggers: [], conditions: [], actions: [], mode: "single" }, `${domain}:${path}`);
    status(`✚ Neuer Blueprint (blueprints/${domain}/${path}) – Eingaben unter „🧩 Eigenschaften“, in Auswahllisten als „🧩 Eingabe“ wählbar.`, "ok");
  }
  // Aus der offenen Automation: gewählte Entitäten werden zu Eingaben.
  async function blueprintFromCurrent() {
    const cfg = currentConfig();
    if (!cfg || !["automation", "script"].includes(S.kind)) { status("Bitte zuerst eine Automation oder ein Skript öffnen.", "warn"); return; }
    const exact = new Set();
    (function walk(v) { if (typeof v === "string") exact.add(v); else if (Array.isArray(v)) v.forEach(walk); else if (isObj(v)) Object.values(v).forEach(walk); })(cfg);
    const ents = [...new Set(HAB.references(cfg, rootKind()).map((r) => r.entity))].filter((e) => exact.has(e));
    const body = openModal("🧩 Blueprint aus dieser " + KIND_NAME());
    body.innerHTML = `<p class="hint">Gewählte Entitäten werden zu Eingaben, die man beim Verwenden des Blueprints auswählt. (In Templates bleiben sie fest – HA erlaubt dort keine Eingaben.)</p>
      <label>Name <input id="bpName" type="text" style="width:100%"></label><div id="bpEnts" class="bpEnts"></div>
      <div class="askFoot"><button id="bpCancel">Abbrechen</button><button id="bpOk" class="primary">Blueprint anlegen</button></div>`;
    $("bpName").value = (cfg.alias || "Blueprint") + " (Blueprint)";
    for (const e of ents) {
      const l = document.createElement("label");
      l.className = "chk";
      l.innerHTML = '<input type="checkbox" checked> <span></span> <code></code>';
      l.querySelector("input").value = e;
      l.querySelector("span").textContent = ename(e);
      l.querySelector("code").textContent = e;
      $("bpEnts").appendChild(l);
    }
    if (!ents.length) $("bpEnts").innerHTML = '<p class="hint">Keine Entitäten gefunden – der Blueprint bekommt keine Eingaben (später unter „🧩 Eigenschaften“ ergänzbar).</p>';
    $("bpCancel").addEventListener("click", closeModal);
    $("bpOk").addEventListener("click", () => {
      const name = $("bpName").value.trim() || "Blueprint";
      const chosen = [...$("bpEnts").querySelectorAll("input:checked")].map((x) => x.value);
      const input = {}, map = {};
      for (const e of chosen) {
        let key = slugify(fname(S.hass.states[e]) || e.split(".")[1]);
        for (let i = 2; key in input; i++) key = `${slugify(e)}_${i}`;
        input[key] = { name: ename(e), selector: { entity: { filter: [{ domain: e.split(".")[0] }] } } };
        map[e] = HAB.inputPlaceholder(key);
      }
      const sub = (v) => (typeof v === "string" ? (map[v] || v) : Array.isArray(v) ? v.map(sub) : isObj(v) ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, sub(x)])) : v);
      const body2 = sub(HAB.clone(cfg));
      delete body2.id; delete body2.alias;
      const description = body2.description || "";
      delete body2.description;
      closeModal();
      newBlueprint(body2, { name, description, domain: rootKind() === "script" ? "script" : "automation", input });
    });
  }
  function useBlueprint(a) {
    const kind = a.domain === "script" ? "script" : "automation";
    if (S.kind !== kind) { if (!switchKind(kind, false)) return; } else if (!confirmDiscard()) return;
    const name = a.meta.name || "Aus Blueprint";
    let id = String(Date.now());
    if (kind === "script") {
      const base = slugify(name), taken = new Set(itemList("script").map((x) => x.id));
      id = base;
      for (let i = 2; taken.has(id) || S.hass.states["script." + id]; i++) id = `${base}_${i}`;
    }
    newItem(() => ({ alias: name, description: "", use_blueprint: { path: a.path, input: {} } }), id);
    status(`✚ Neue ${kind === "script" ? "Skript" : "Automation"} aus „${name}“ – Eingaben ausfüllen und speichern.`, "ok");
  }
  async function deleteBlueprint(a) {
    const ok = await askChoice("Blueprint löschen", `„${a.name}“ (blueprints/${a.domain}/${a.path}) wird gelöscht. Das lässt sich nicht rückgängig machen. Home Assistant verweigert das, solange Automationen/Skripte ihn nutzen.`,
      [["Abbrechen", false], ["Endgültig löschen", true, true]]);
    if (!ok) return;
    try {
      await S.hass.callWS({ type: "blueprint/delete", domain: a.domain, path: a.path });
      if (S.id === a.id) { S.id = null; S.original = null; S.bp = null; Blockly.Events.disable(); try { S.ws.clear(); } finally { Blockly.Events.enable(); } }
      await refreshMeta();
      status("🗑 Blueprint gelöscht", "ok");
    } catch (e) { status("Nicht gelöscht: " + errText(e), "warn"); }
  }
  // Eigenschaften: Name, Beschreibung, Autor, Eingaben.
  const SEL_TYPES = [["entity", "Entität"], ["target", "Ziel (Entität/Bereich/Gerät)"], ["area", "Bereich"], ["device", "Gerät"], ["number", "Zahl"],
    ["boolean", "Ja/Nein"], ["text", "Text"], ["time", "Uhrzeit"], ["duration", "Dauer"], ["action", "Aktionen"]];
  function bpProps() {
    if (!S.bp) return;
    const m = S.bp.meta;
    const body = openModal("🧩 Blueprint-Eigenschaften");
    body.innerHTML = `<div class="bpForm">
      <label>Name <input id="bpN" type="text"></label>
      <label>Beschreibung <textarea id="bpD" rows="3"></textarea></label>
      <label>Autor <input id="bpA" type="text"></label>
      <div class="hint">Datei: blueprints/${esc(S.bp.domain)}/${esc(S.bp.path)}${m.source_url ? " · importiert von " + esc(m.source_url) : ""}</div>
      <h4>Eingaben</h4>
      <div class="row"><input id="bpKey" type="text" placeholder="schluessel"><input id="bpKName" type="text" placeholder="Anzeigename"><select id="bpKType"></select><button id="bpAdd">＋ Eingabe</button></div>
      <label>Alle Eingaben (JSON, für Einstellungen der Auswahl) <textarea id="bpI" rows="10" spellcheck="false"></textarea></label>
      <div class="askFoot"><button id="bpX">Abbrechen</button><button id="bpSave" class="primary">Übernehmen</button></div></div>`;
    $("bpN").value = m.name || ""; $("bpD").value = m.description || ""; $("bpA").value = m.author || "";
    $("bpI").value = JSON.stringify(m.input || {}, null, 2);
    for (const [v, l] of SEL_TYPES) $("bpKType").appendChild(new Option(l, v));
    $("bpAdd").addEventListener("click", () => {
      let inp; try { inp = JSON.parse($("bpI").value || "{}"); } catch (e) { alert("Eingaben: ungültiges JSON"); return; }
      const key = slugify($("bpKey").value || $("bpKName").value || "eingabe");
      inp[key] = { name: $("bpKName").value || key, selector: { [$("bpKType").value]: {} } };
      $("bpI").value = JSON.stringify(inp, null, 2);
      $("bpKey").value = $("bpKName").value = "";
    });
    $("bpX").addEventListener("click", closeModal);
    $("bpSave").addEventListener("click", () => {
      let inp; try { inp = JSON.parse($("bpI").value || "{}"); } catch (e) { alert("Eingaben: ungültiges JSON – " + e.message); return; }
      const n = HAB.clone(m);
      n.name = $("bpN").value.trim() || n.name;
      if ($("bpD").value.trim() || n.description !== undefined) n.description = $("bpD").value;
      if ($("bpA").value.trim()) n.author = $("bpA").value.trim(); else delete n.author;
      n.input = inp;
      S.bp.meta = n;
      closeModal();
      updateStatus(); updateTitle();
      status("Eigenschaften übernommen – mit „Speichern“ in die Datei schreiben.", "ok");
    });
  }
  $("tabScene").addEventListener("click", () => switchKind("scene"));
  $("tabBp").addEventListener("click", () => switchKind("blueprint"));
  $("bpPropsBtn").addEventListener("click", bpProps);

  // ---------- Anbindung ----------
  window.haBlockly = {
    setHass(hass) {
      const first = !S.hass;
      S.hass = hass;
      if (first) {
        initWorkspace();
        renderCategorySelect();
        S.kind = KINDS.includes(store("haBlockly.kind")) ? store("haBlockly.kind") : "automation";
        renderTabs();
        S.ws.updateToolbox(HAB.buildToolbox(rootKind()));
        S.metaCount = metaCount();
        renderInsp(); renderDetail();
        refreshMeta().then(() => {
          const last = store(lastKey());
          if (last && itemList().some((a) => a.id === last)) load(last);
        });
        // Native HA-Dialoge vorbereiten, deutsche Dienstnamen nachladen.
        try { parent.__haBlocklyPrepare && parent.__haBlocklyPrepare(); } catch (e) { /* optional */ }
        try {
          Promise.resolve(hass.loadBackendTranslation && hass.loadBackendTranslation("services"))
            .then(() => setTimeout(() => S.ws.updateToolbox(HAB.buildToolbox(rootKind())), 300))
            .catch(() => {});
        } catch (e) { /* optional */ }
        return;
      }
      // Neue, umbenannte oder ein-/ausgeschaltete Automationen nachziehen.
      const count = metaCount();
      if (count !== S.metaCount) { S.metaCount = count; refreshMeta(); } else renderList();
      liveTick();
    },
    selfTest,
    get ws() { return S.ws; },
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
  menu.insertAdjacentHTML("beforeend", '<div class="mh">Weitere</div>');
  for (const [txt, fn] of [["📜 Skript (Funktion) anlegen …", () => newScript()], ["🎬 Szene anlegen …", () => newScene()],
    ["🧩 Blueprint anlegen (leer) …", () => newBlueprint()], ["🧩 Blueprint aus dieser Automation / diesem Skript …", () => blueprintFromCurrent()]]) {
    const b = document.createElement("button");
    b.textContent = txt;
    b.addEventListener("click", () => { menu.classList.add("hidden"); fn(); });
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
    HAB.hooks.simple = !on && !BLOCKLY && !EXTENDED;
    HAB.hooks.expert = on;
    HAB.hooks.toolboxSearch = !HAB.hooks.simple && hasSearch();
    if (!on) $("side").classList.add("hidden");
    if (!S.ws) return;
    S.ws.updateToolbox(HAB.buildToolbox(rootKind()));
    const cfg = currentConfig();
    if (cfg) { reloadKeepingLayout(cfg); showRoot(); }
    Blockly.svgResize(S.ws);
    status(on ? (BLOCKLY ? "Expertenmodus: JSON-Seitenleiste und Roh-JSON-Bausteine" : "Expertenmodus: Eingabefelder und alle Bausteine")
      : BLOCKLY ? "Blockly-Modus" : "Einfacher Modus", "ok");
  });
  $("newCat").addEventListener("click", createCategory);
  $("settingsBtn").addEventListener("click", () => {
    if (!confirmDiscard()) return;
    try { parent.__haBlocklyNavigate("/config/integrations/integration/blockly_automations"); } catch (e) { status("Einstellungen: Einstellungen → Geräte & Dienste → Blockly Automations → Konfigurieren", "warn"); }
  });
  $("settingsBtn").title = `Einstellungen – Bedienung: ${BLOCKLY ? "Blockly-Bausteine" : "Home-Assistant-Fenster"}`;
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
  // JSON-Seitenleiste ist ein Expertenwerkzeug: im einfachen Modus nie sichtbar.
  if (sidePref !== "1" || !isExpert()) $("side").classList.add("hidden");
  const listPref = store("haBlockly.list");
  if (listPref === "0" || (listPref === null && narrow)) $("list").classList.add("hidden");
  // Neue Version installiert? Dann die ganze Seite neu laden (nur ohne ungespeicherte Änderungen).
  const myVersion = decodeURIComponent(window.HAB_V || "");
  setInterval(async () => {
    try {
      const r = await fetch("version.json", { cache: "no-store" });
      const v = r.ok ? (await r.json()).version : null;
      if (!v || v === myVersion) return;
      const dirty = S.ws && S.original && (S.isNew || !HAB.deepEqual(currentConfig(), S.original));
      if (dirty) status(`Version ${v} ist installiert – nach dem Speichern die Seite neu laden (F5).`, "warn");
      else parent.location.reload();
    } catch (e) { /* offline – später erneut */ }
  }, 120000);
  window.addEventListener("beforeunload", (e) => {
    if (S.original && S.lossless && S.ws && !HAB.deepEqual(currentConfig(), S.original)) e.preventDefault();
  });
})();
