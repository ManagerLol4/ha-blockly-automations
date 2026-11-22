/* Blockly-Darstellung nativer HA-Automationen.
 *
 * Grundprinzip (verlustfrei): Jeder Block merkt sich sein komplettes
 * Original-Objekt (raw). Beim Zurückschreiben wird raw geklont und nur
 * geänderte Felder sowie die verschachtelten Listen werden überschrieben.
 * Leere Felder, die es im Original nicht gab, werden nicht geschrieben.
 * Alles, was der Editor nicht kennt, bleibt unverändert.
 */
(function (root) {
  "use strict";

  // ---------- Hilfsfunktionen ----------
  const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
  const isPrim = (v) => typeof v === "string" || typeof v === "number" || typeof v === "boolean";
  const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));

  function getPath(obj, path) {
    if (!path) return obj;
    let cur = obj;
    for (const k of path.split(".")) {
      if (!isObj(cur)) return undefined;
      cur = cur[k];
    }
    return cur;
  }
  function setPath(obj, path, val) {
    const keys = path.split(".");
    let cur = obj;
    for (let i = 0; i < keys.length - 1; i++) {
      if (!isObj(cur[keys[i]])) cur[keys[i]] = {};
      cur = cur[keys[i]];
    }
    cur[keys[keys.length - 1]] = val;
  }
  function delPath(obj, path) {
    const keys = path.split(".");
    const parents = [];
    let cur = obj;
    for (let i = 0; i < keys.length - 1; i++) {
      if (!isObj(cur[keys[i]])) return;
      parents.push([cur, keys[i]]);
      cur = cur[keys[i]];
    }
    delete cur[keys[keys.length - 1]];
    // Leer gewordene Zwischenobjekte (z. B. "for": {}) entfernen.
    for (let i = parents.length - 1; i >= 0; i--) {
      const [p, k] = parents[i];
      if (isObj(p[k]) && Object.keys(p[k]).length === 0) delete p[k];
      else break;
    }
  }
  function deepEqual(a, b) {
    if (a === b) return true;
    if (typeof a !== typeof b || a === null || b === null) return false;
    if (Array.isArray(a) !== Array.isArray(b)) return false;
    if (Array.isArray(a)) return a.length === b.length && a.every((x, i) => deepEqual(x, b[i]));
    if (typeof a !== "object") return false;
    const ka = Object.keys(a), kb = Object.keys(b);
    return ka.length === kb.length && ka.every((k) => Object.prototype.hasOwnProperty.call(b, k) && deepEqual(a[k], b[k]));
  }
  function short(v, n = 48) {
    let s = typeof v === "string" ? v : JSON.stringify(v);
    if (s === undefined) s = "";
    s = s.replace(/\s+/g, " ");
    return s.length > n ? s.slice(0, n - 1) + "…" : s;
  }

  // ---------- Anbindung an HA (setzt der Editor) ----------
  const hooks = {
    entityName: () => "",
    entities: () => [],          // (domains[]) -> [[entity_id, name], ...]
    states: () => [],            // (entity_id) -> ["on", "off", ...]
    services: () => [],          // () -> [["light.turn_on", "Licht einschalten"], ...]
    serviceFields: () => null,   // ("light.turn_on") -> {key: {selector, name}}
  };

  // ---------- Farben ----------
  const C = { trigger: 30, condition: 210, action: 140, flow: 260, generic: "#8a8a8a", root: 50 };
  const NONE = "__ha_none__";
  const UNIT = { days: "Tg", hours: "Std", minutes: "Min", seconds: "Sek", milliseconds: "ms" };
  const WEEKDAYS = [["mon", "Mo"], ["tue", "Di"], ["wed", "Mi"], ["thu", "Do"], ["fri", "Fr"], ["sat", "Sa"], ["sun", "So"]];
  const BOOL_OPTS = [["–", ""], ["ja", "true"], ["nein", "false"]];

  /* Feldbeschreibung:
   *   F(pfad, label, {show, type, row, domains, of, options, numeric})
   *   show: "always" (Standard) | "present" (nur wenn im Original vorhanden)
   *   type: text | entity | state | number | select | bool | weekdays | service | template
   *   row:  Felder mit gleichem row-Wert stehen in einer Zeile
   */
  const F = (path, label, o = {}) => ({ path, label, show: "always", type: "text", ...o });
  const L = (path, label, kind) => ({ path, label, kind });
  const P = (path, label, o = {}) => F(path, label, { show: "present", ...o });

  // Zeitraum (for/delay/timeout/offset): Objekt -> eine Zeile Std/Min/Sek, String -> Textfeld.
  function duration(item, path, label, show = "always") {
    const v = getPath(item, path);
    if (v === undefined && show === "present") return [];
    if (v === undefined || isObj(v)) {
      const keys = isObj(v) ? Object.keys(v) : [];
      const units = ["hours", "minutes", "seconds"];
      for (const k of keys) if (!units.includes(k)) units.push(k);
      if (keys.includes("days")) units.splice(units.indexOf("days"), 1), units.unshift("days");
      return units.map((u, i) => F(`${path}.${u}`, (i === 0 ? label + " " : "") + (UNIT[u] || u), { row: path, numeric: true, type: "number" }));
    }
    return [F(path, label)];
  }

  // ---------- Spezifikationen ----------
  function triggerSpec(t) {
    const key = t.trigger !== undefined ? "trigger" : "platform";
    const p = t[key];
    const mk = (title, fields, colour = C.trigger, extra = {}) => ({
      title, colour, fields: [...fields, F("id", "ID")], lists: [], ...extra,
    });
    switch (p) {
      case "state":
        return mk("🔁 Zustand ändert sich", [
          F("entity_id", "Entität", { type: "entity" }),
          F("attribute", "Attribut"),
          F("from", "von", { type: "state", of: "entity_id", row: "ft" }),
          F("to", "zu", { type: "state", of: "entity_id", row: "ft" }),
          P("not_from", "nicht von", { type: "state", of: "entity_id", row: "nft" }),
          P("not_to", "nicht zu", { type: "state", of: "entity_id", row: "nft" }),
          ...duration(t, "for", "für"),
        ]);
      case "numeric_state":
        return mk("📈 Zahlenwert", [
          F("entity_id", "Entität", { type: "entity", domains: ["sensor", "number", "input_number", "climate", "weather"] }),
          F("attribute", "Attribut"),
          F("above", "über", { numeric: true, row: "ab" }),
          F("below", "unter", { numeric: true, row: "ab" }),
          P("value_template", "Wert-Template", { type: "template" }),
          ...duration(t, "for", "für"),
        ]);
      case "time":
        return mk("⏰ Uhrzeit", [
          F("at", "um", { type: "time" }),
          ...(t.weekday !== undefined ? [F("weekday", "an", { type: "weekdays" })] : []),
        ]);
      case "time_pattern":
        return mk("🕑 Zeitmuster", [F("hours", "Std", { row: "tp" }), F("minutes", "Min", { row: "tp" }), F("seconds", "Sek", { row: "tp" })]);
      case "sun":
        return mk("☀️ Sonne", [
          F("event", "bei", { type: "select", options: [["Sonnenaufgang", "sunrise"], ["Sonnenuntergang", "sunset"]] }),
          F("offset", "Versatz (±HH:MM:SS)"),
        ]);
      case "zone":
        return mk("📍 Zone", [
          F("entity_id", "Person/Tracker", { type: "entity", domains: ["person", "device_tracker"] }),
          F("zone", "Zone", { type: "entity", domains: ["zone"] }),
          F("event", "beim", { type: "select", options: [["Betreten", "enter"], ["Verlassen", "leave"]] }),
        ]);
      case "template":
        return mk("🧩 Template wird wahr", [F("value_template", "", { type: "template" }), ...duration(t, "for", "für")]);
      case "homeassistant":
        return mk("🏠 Home Assistant", [F("event", "beim", { type: "select", options: [["Start", "start"], ["Herunterfahren", "shutdown"]] })]);
      case "event":
        return mk("📣 Ereignis", [F("event_type", "Typ"), F("event_data", "Daten (JSON)", { type: "json" })]);
      case "mqtt":
        return mk("📡 MQTT", [F("topic", "Topic"), F("payload", "Payload"), P("value_template", "Wert-Template", { type: "template" })]);
      case "webhook":
        return mk("🌐 Webhook", [F("webhook_id", "Webhook-ID"), F("local_only", "nur lokal", { type: "bool" }), P("allowed_methods", "Methoden", { type: "json" })]);
      case "tag":
        return mk("🏷️ NFC-Tag", [F("tag_id", "Tag-ID"), P("device_id", "Gerät")]);
      case "calendar":
        return mk("📅 Kalender", [
          F("entity_id", "Kalender", { type: "entity", domains: ["calendar"] }),
          F("event", "bei", { type: "select", options: [["Beginn", "start"], ["Ende", "end"]] }),
          F("offset", "Versatz (±HH:MM:SS)"),
        ]);
      case "conversation":
        return mk("💬 Sprachbefehl", [F("command", "Satz", { type: "list" })]);
      case "persistent_notification":
        return mk("🔔 Benachrichtigung", [F("notification_id", "ID"), P("update_type", "Art", { type: "json" })]);
      case "device":
        return mk(`📟 Gerät: ${t.type || ""}${t.subtype !== undefined ? " " + t.subtype : ""} (${t.domain || ""})`, [], C.trigger, { summaryLine: false });
      default:
        return mk(`Auslöser: ${p}`, [], C.generic, { generic: true });
    }
  }

  function conditionSpec(c) {
    if (!isObj(c)) {
      return { title: "🧩 Template (Kurzform)", colour: C.condition, fields: [F("", "", { type: "template" })], lists: [] };
    }
    const mk = (title, fields, lists = [], colour = C.condition) => ({ title, colour, fields, lists });
    switch (c.condition) {
      case "state":
        return mk("🔎 Zustand ist", [
          F("entity_id", "Entität", { type: "entity" }),
          F("attribute", "Attribut"),
          F("state", "Zustand", { type: "state", of: "entity_id" }),
          ...duration(c, "for", "seit"),
          P("match", "Treffer", { type: "select", options: [["alle", "all"], ["einer", "any"]] }),
        ]);
      case "numeric_state":
        return mk("📏 Zahlenwert", [
          F("entity_id", "Entität", { type: "entity", domains: ["sensor", "number", "input_number", "climate", "weather"] }),
          F("attribute", "Attribut"),
          F("above", "über", { numeric: true, row: "ab" }),
          F("below", "unter", { numeric: true, row: "ab" }),
          P("value_template", "Wert-Template", { type: "template" }),
        ]);
      case "time":
        return mk("⏰ Uhrzeit", [
          F("after", "nach", { type: "time", row: "t" }),
          F("before", "vor", { type: "time", row: "t" }),
          F("weekday", "an", { type: "weekdays" }),
        ]);
      case "sun":
        return mk("☀️ Sonne", [
          F("after", "nach", { type: "select", options: [["–", ""], ["Sonnenaufgang", "sunrise"], ["Sonnenuntergang", "sunset"]], row: "a" }),
          F("after_offset", "±", { row: "a" }),
          F("before", "vor", { type: "select", options: [["–", ""], ["Sonnenaufgang", "sunrise"], ["Sonnenuntergang", "sunset"]], row: "b" }),
          F("before_offset", "±", { row: "b" }),
        ]);
      case "zone":
        return mk("📍 In Zone", [
          F("entity_id", "Person/Tracker", { type: "entity", domains: ["person", "device_tracker"] }),
          F("zone", "Zone", { type: "entity", domains: ["zone"] }),
        ]);
      case "template":
        return mk("🧩 Template ist wahr", [F("value_template", "", { type: "template" })]);
      case "trigger":
        return mk("🏷️ Ausgelöst durch ID", [F("id", "", { type: "list" })]);
      case "and":
        return mk("UND – alle erfüllt", [], [L("conditions", "", "condition")], C.flow);
      case "or":
        return mk("ODER – eine erfüllt", [], [L("conditions", "", "condition")], C.flow);
      case "not":
        return mk("NICHT – keine erfüllt", [], [L("conditions", "", "condition")], C.flow);
      case "device":
        return mk(`📟 Gerät: ${c.type || ""} (${c.domain || ""})`, []);
      default:
        return { ...mk(`Bedingung: ${c.condition}`, []), colour: C.generic, generic: true };
    }
  }

  // Felder einer Dienst-Aktion aus dem HA-Dienst-Schema.
  function selectorField(path, label, sel, show) {
    const t = sel ? Object.keys(sel)[0] : "text";
    const o = { show };
    if (t === "number" || t === "color_temp") Object.assign(o, { type: "number", numeric: true });
    else if (t === "boolean" || t === "constant") o.type = "bool";
    else if (t === "select" && sel.select && Array.isArray(sel.select.options) && !sel.select.multiple && !sel.select.custom_value) {
      o.type = "select";
      o.options = [["–", ""], ...sel.select.options.map((x) => (isObj(x) ? [String(x.label), String(x.value)] : [String(x), String(x)]))];
    } else if (t === "entity") { o.type = "entity"; if (sel.entity && sel.entity.domain) o.domains = [].concat(sel.entity.domain); }
    else if (t === "template") o.type = "template";
    else if (t === "duration") o.type = "json";
    else if (["object", "color_rgb", "area", "device", "media"].includes(t)) o.type = "json";
    else if (t === "time") o.type = "time";
    return F(path, label, o);
  }
  function serviceDataFields(a, svc) {
    const fields = [];
    const seen = new Set();
    const schema = hooks.serviceFields(svc) || {};
    const walk = (obj, show) => {
      for (const [k, f] of Object.entries(obj)) {
        if (f && f.fields) { walk(f.fields, "present"); continue; }
        if (k === "entity_id") continue;
        seen.add(k);
        fields.push(selectorField(`data.${k}`, (f && f.name) || k, f && f.selector, show));
      }
    };
    walk(schema, "always");
    if (isObj(a.data)) for (const k of Object.keys(a.data)) if (!seen.has(k)) fields.push(F(`data.${k}`, k, { type: isPrim(a.data[k]) ? "text" : "json" }));
    // Bereits befüllte Felder immer anzeigen, auch wenn sie im Schema in einem Abschnitt stecken.
    return fields.map((f) => (getPath(a, f.path) !== undefined ? { ...f, show: "always" } : f));
  }

  function actionSpec(a) {
    const mk = (title, fields, lists = [], colour = C.action) => ({ title, colour, fields, lists });
    if (!isObj(a)) return { ...mk("Aktion", []), colour: C.generic, generic: true };
    if ("choose" in a)
      return mk("🔀 Auswahl (erste passende Option)", [], [L("choose", "Optionen", "option"), L("default", "sonst", "action")], C.flow);
    if ("if" in a)
      return mk("❓ Wenn", [], [L("if", "wenn", "condition"), L("then", "dann", "action"), L("else", "sonst", "action")], C.flow);
    if ("repeat" in a) {
      const r = isObj(a.repeat) ? a.repeat : {};
      const lists = [];
      if ("while" in r) lists.push(L("repeat.while", "solange", "condition"));
      if ("until" in r) lists.push(L("repeat.until", "bis", "condition"));
      lists.push(L("repeat.sequence", "mache", "action"));
      const fields = [];
      if ("count" in r || (!("while" in r) && !("until" in r) && !("for_each" in r))) fields.push(F("repeat.count", "Anzahl", { numeric: true, type: "number" }));
      if ("for_each" in r) fields.push(F("repeat.for_each", "für jedes", { type: "json" }));
      return mk("🔁 Wiederholen", fields, lists, C.flow);
    }
    if ("parallel" in a) return mk("⏸ Parallel ausführen", [], [L("parallel", "", "action")], C.flow);
    if ("sequence" in a) return mk("📜 Folge", [], [L("sequence", "", "action")], C.flow);
    if ("wait_for_trigger" in a)
      return mk("⏳ Warten auf Auslöser", [...duration(a, "timeout", "höchstens", "present"), P("continue_on_timeout", "danach weiter", { type: "bool" })],
        [L("wait_for_trigger", "", "trigger")], C.flow);
    if ("wait_template" in a)
      return mk("⏳ Warten bis", [F("wait_template", "", { type: "template" }), ...duration(a, "timeout", "höchstens"), F("continue_on_timeout", "danach weiter", { type: "bool" })], [], C.flow);
    if ("delay" in a) {
      const d = a.delay;
      if (isObj(d)) return mk("⏱️ Warten", duration(a, "delay", ""), [], C.flow);
      return mk("⏱️ Warten", [F("delay", "", { numeric: typeof d === "number" })], [], C.flow);
    }
    if ("action" in a || "service" in a) {
      const key = "action" in a ? "action" : "service";
      const svc = a[key];
      const dom = typeof svc === "string" ? svc.split(".")[0] : "";
      const anyDomain = ["homeassistant", "notify", "script", "scene", "automation", "persistent_notification", "tts", "logbook", "system_log", "input_button"].includes(dom);
      const fields = [F(key, "Dienst", { type: "service" })];
      const domains = anyDomain || !dom ? undefined : [dom];
      if (a.entity_id !== undefined) fields.push(F("entity_id", "Entität", { type: "entity", domains }));
      else fields.push(F("target.entity_id", "Entität", { type: "entity", domains, show: !a.target && dom === "notify" ? "present" : "always" }));
      fields.push(P("target.area_id", "Bereich", { type: "list" }));
      fields.push(P("target.device_id", "Gerät", { type: "list" }));
      if (typeof svc === "string") fields.push(...serviceDataFields(a, svc));
      else if (isObj(a.data)) fields.push(F("data", "Daten (JSON)", { type: "json" }));
      fields.push(P("data_template", "Daten (alt)", { type: "json" }));
      fields.push(P("response_variable", "Antwort in Variable"));
      return mk("▶️ Dienst aufrufen", fields);
    }
    if ("event" in a) return mk("📣 Ereignis senden", [F("event", "Typ"), F("event_data", "Daten (JSON)", { type: "json" })]);
    if ("scene" in a) return mk("🎬 Szene aktivieren", [F("scene", "", { type: "entity", domains: ["scene"] })]);
    if ("stop" in a) return mk("⛔ Stopp", [F("stop", "Grund"), F("error", "als Fehler", { type: "bool" })], [], C.flow);
    if ("variables" in a && isObj(a.variables))
      return mk("📦 Variablen setzen", Object.keys(a.variables).map((k) => F(`variables.${k}`, k, { type: isPrim(a.variables[k]) ? "text" : "json" })), [], C.flow);
    if ("device_id" in a) return mk(`📟 Gerät: ${a.type || ""} (${a.domain || ""})`, []);
    return { ...mk("Aktion (unbekannt)", []), colour: C.generic, generic: true };
  }

  function rootSpec(cfg) {
    const pick = (a, b) => (a in cfg ? a : b in cfg ? b : a);
    return {
      title: "🤖 Automation",
      colour: C.root,
      fields: [
        F("alias", "Name"),
        F("description", "Beschreibung"),
        F("mode", "Modus", {
          type: "select", row: "mode",
          options: [["(Standard: single)", ""], ["single – nicht erneut starten", "single"], ["restart – neu starten", "restart"],
            ["queued – nacheinander", "queued"], ["parallel – gleichzeitig", "parallel"]],
        }),
        ...(cfg.mode === "queued" || cfg.mode === "parallel" || cfg.max !== undefined ? [F("max", "max.", { numeric: true, row: "mode" })] : []),
      ],
      lists: [L(pick("triggers", "trigger"), "Auslöser", "trigger"), L(pick("conditions", "condition"), "Bedingungen", "condition"), L(pick("actions", "action"), "Aktionen", "action")],
    };
  }

  function specFor(kind, item) {
    let spec;
    if (kind === "root") spec = rootSpec(item);
    else if (kind === "trigger") spec = isObj(item) ? triggerSpec(item) : { title: "Auslöser", colour: C.generic, fields: [], lists: [], generic: true };
    else if (kind === "condition") spec = conditionSpec(item);
    else if (kind === "option") spec = { title: "Option", colour: C.flow, fields: [], lists: [L("conditions", "wenn", "condition"), L("sequence", "dann", "action")] };
    else spec = actionSpec(item);
    if (isObj(item) && kind !== "root") {
      const extra = [];
      if (item.alias !== undefined && isPrim(item.alias)) extra.push(F("alias", "Name"));
      spec.fields = [...extra, ...spec.fields];
      if (kind === "action" && item.continue_on_error !== undefined) spec.fields.push(F("continue_on_error", "bei Fehler weiter", { type: "bool" }));
    }
    return spec;
  }

  const classify = (listKind, el) => (listKind === "action" && isObj(el) && "condition" in el ? "condition" : listKind);
  const CHECK_PREV = { trigger: "ha_trigger", condition: "ha_condition", action: "ha_action", option: "ha_option" };
  const CHECK_LIST = { trigger: ["ha_trigger"], condition: ["ha_condition"], action: ["ha_action", "ha_condition"], option: ["ha_option"] };

  // ---------- HA-Objekt -> Blockly-JSON ----------
  function itemToBlockJson(kind, item) {
    const spec = specFor(kind, item);
    const json = { type: "ha_" + kind, extraState: { raw: clone(item) } };
    if (isObj(item) && item.enabled === false && kind !== "root") json.enabled = false;
    spec.lists.forEach((l, i) => {
      const v = getPath(item, l.path);
      if (v === undefined || v === null) return;
      const arr = Array.isArray(v) ? v : [v];
      const chain = chainJson(l.kind, arr);
      if (chain) (json.inputs = json.inputs || {})["L" + i] = { block: chain };
    });
    return json;
  }
  function chainJson(listKind, arr) {
    let first = null, last = null;
    for (const el of arr) {
      const j = itemToBlockJson(classify(listKind, el), el);
      if (!first) first = j; else last.next = { block: j };
      last = j;
    }
    return first;
  }

  // ---------- Feldwerte <-> HA-Werte ----------
  const LISTY = new Set(["entity", "state", "list"]);
  function toFieldString(v, f) {
    if (v === undefined) return "";
    if (Array.isArray(v) && LISTY.has(f.type) && v.every(isPrim)) return v.join(", ");
    if (isPrim(v)) return String(v);
    return JSON.stringify(v);
  }
  function fromFieldString(val, f) {
    const orig = f.orig;
    if (f.type === "bool") return val === "true";
    if (LISTY.has(f.type) && (Array.isArray(orig) || (orig === undefined && val.includes(",") && f.type !== "state"))) {
      return val.split(",").map((s) => s.trim()).filter(Boolean);
    }
    if (f.type === "json" || (!isPrim(orig) && orig !== undefined && !Array.isArray(orig))) {
      try { return JSON.parse(val); } catch (e) { return val; }
    }
    if (Array.isArray(orig)) { try { return JSON.parse(val); } catch (e) { return val; } }
    if ((typeof orig === "number" || (orig === undefined && f.numeric)) && val.trim() !== "" && isFinite(Number(val))) return Number(val);
    if (typeof orig === "boolean" && (val === "true" || val === "false")) return val === "true";
    return val;
  }

  // ---------- Block -> HA-Objekt ----------
  function blockToItem(b) {
    let out = clone(b.raw_);
    for (const f of b.fieldMap_ || []) {
      if (f.type === "weekdays") {
        const sel = WEEKDAYS.map(([d]) => d).filter((d, i) => b.getFieldValue(`${f.name}_${i}`) === "TRUE");
        const origArr = f.orig === undefined ? [] : [].concat(f.orig);
        const same = sel.length === origArr.length && sel.every((d) => origArr.includes(d));
        if (same) continue;
        if (!sel.length) delPath(out, f.path);
        else setPath(out, f.path, typeof f.orig === "string" && sel.length === 1 ? sel[0] : sel);
        continue;
      }
      let val = b.getFieldValue(f.name);
      if (val === NONE) val = "";
      if (val === f.origStr) continue;
      if (f.path === "") { out = val; continue; }
      if (val === "") { if (f.orig !== undefined) delPath(out, f.path); continue; }
      setPath(out, f.path, fromFieldString(val, f));
    }
    if (isObj(out)) {
      (b.listMap_ || []).forEach((l) => {
        const items = [];
        for (let c = b.getInputTargetBlock(l.name); c; c = c.getNextBlock()) items.push(blockToItem(c));
        if ((l.orig === undefined || l.orig === null) && items.length === 0) return;
        if (l.single && items.length === 1) setPath(out, l.path, items[0]);
        else setPath(out, l.path, items);
      });
      if (b.type !== "ha_root") {
        const disabled = !b.isEnabled();
        const wasDisabled = b.raw_ && b.raw_.enabled === false;
        if (disabled && !wasDisabled) out.enabled = false;
        if (!disabled && wasDisabled) delete out.enabled;
      }
    }
    return out;
  }

  // ---------- Blockly-Blöcke ----------
  function defineBlocks(Blockly) {
    // Textfeld mit Vorschlagsliste (<datalist>): Entitäten, Zustände, Dienste.
    let dlCount = 0;
    class FieldSuggest extends Blockly.FieldTextInput {
      constructor(value, provider) {
        super(value);
        this.provider_ = provider;
      }
      widgetCreate_() {
        const input = super.widgetCreate_();
        try {
          const opts = this.provider_ ? this.provider_(this) : [];
          if (opts && opts.length) {
            const id = "ha-dl-" + ++dlCount;
            const dl = document.createElement("datalist");
            dl.id = id;
            for (const o of opts.slice(0, 3000)) {
              const op = document.createElement("option");
              op.value = Array.isArray(o) ? o[0] : o;
              if (Array.isArray(o) && o[1]) op.label = o[1];
              dl.appendChild(op);
            }
            document.body.appendChild(dl);
            input.setAttribute("list", id);
            input.setAttribute("autocomplete", "off");
            this.datalist_ = dl;
          }
        } catch (e) { /* Vorschläge sind optional */ }
        return input;
      }
      widgetDispose_() {
        if (this.datalist_) { this.datalist_.remove(); this.datalist_ = null; }
        super.widgetDispose_();
      }
    }

    const TIME_HINTS = () => [
      ...["06:00:00", "07:00:00", "08:00:00", "12:00:00", "18:00:00", "20:00:00", "22:00:00"],
      ...hooks.entities(["input_datetime", "sensor"]).filter(([id]) => id.startsWith("input_datetime.") || /time|zeit|alarm/i.test(id)),
    ];

    function fieldValueByPath(block, path) {
      const m = (block.fieldMap_ || []).find((x) => x.path === path);
      return m ? block.getFieldValue(m.name) : getPath(block.raw_, path);
    }

    function makeField(block, f, str) {
      switch (f.type) {
        case "entity":
          return new FieldSuggest(str, () => hooks.entities(f.domains));
        case "state":
          return new FieldSuggest(str, (fld) => {
            const ent = fieldValueByPath(fld.getSourceBlock(), f.of);
            const first = typeof ent === "string" ? ent.split(",")[0].trim() : "";
            return hooks.states(first);
          });
        case "service":
          return new FieldSuggest(str, () => hooks.services());
        case "time":
          return new FieldSuggest(str, TIME_HINTS);
        default:
          return new Blockly.FieldTextInput(str);
      }
    }

    const mixin = {
      saveExtraState() { return { raw: this.raw_ }; },
      loadExtraState(state) { this.build_(state && state.raw !== undefined ? state.raw : {}); },
      build_(raw) {
        this.raw_ = raw;
        const spec = specFor(this.haKind_, raw);
        this.spec_ = spec;
        this.setColour(spec.colour);
        this.appendDummyInput("HEAD").appendField(spec.title, "TITLE");
        if (spec.generic) {
          this.appendDummyInput("SUM").appendField(new Blockly.FieldLabel(short(raw, 60), "ha-summary"));
          this.setTooltip("Wird unverändert übernommen. Bearbeiten über das JSON-Feld rechts.");
        }
        this.fieldMap_ = [];
        const rows = {};
        spec.fields.forEach((f, i) => {
          const v = getPath(raw, f.path);
          if (v === undefined && f.show === "present") return;
          let inp;
          if (f.row && rows[f.row]) inp = rows[f.row];
          else {
            inp = this.appendDummyInput("FI" + i);
            if (f.row) rows[f.row] = inp;
          }
          if (f.label) inp.appendField(f.label);
          const name = "F" + i;
          if (f.type === "weekdays") {
            const cur = v === undefined ? [] : [].concat(v);
            WEEKDAYS.forEach(([d, lbl], j) => {
              inp.appendField(new Blockly.FieldCheckbox(cur.includes(d) ? "TRUE" : "FALSE"), `${name}_${j}`);
              inp.appendField(lbl);
            });
            this.fieldMap_.push({ name, path: f.path, orig: v, type: "weekdays" });
            return;
          }
          if (f.type === "select" || f.type === "bool") {
            const base = f.type === "bool" ? BOOL_OPTS : f.options;
            const opts = base.map((o) => [o[0], o[1] === "" ? NONE : o[1]]);
            const cur = v === undefined ? "" : String(v);
            const curVal = cur === "" ? NONE : cur;
            if (!opts.some((o) => o[1] === curVal)) opts.push([cur || "–", curVal]);
            if (isPrim(v) || v === undefined) {
              inp.appendField(new Blockly.FieldDropdown(opts), name);
              this.setFieldValue(curVal, name);
              this.fieldMap_.push({ name, path: f.path, orig: v, origStr: cur, type: f.type, numeric: f.numeric });
              return;
            }
          }
          const str = toFieldString(v, f);
          const fld = makeField(this, f, str);
          inp.appendField(fld, name);
          this.fieldMap_.push({ name, path: f.path, orig: v, origStr: str, type: f.type, numeric: f.numeric });
          if (f.type === "entity") {
            const lbl = new Blockly.FieldLabel(hooks.entityName(str), "ha-entity-name");
            inp.appendField(lbl, "N" + i);
            fld.setValidator((nv) => { lbl.setValue(hooks.entityName(nv)); return nv; });
          }
          if (f.type === "service") this.serviceField_ = name;
        });
        this.listMap_ = [];
        spec.lists.forEach((l, i) => {
          const name = "L" + i;
          const orig = getPath(raw, l.path);
          this.appendStatementInput(name).setCheck(CHECK_LIST[l.kind]).appendField(l.label);
          this.listMap_.push({ name, path: l.path, orig, single: orig !== undefined && orig !== null && !Array.isArray(orig) });
        });
      },
    };

    const def = (kind, init) => {
      Blockly.Blocks["ha_" + kind] = {
        ...mixin,
        haKind_: kind,
        init() {
          this.raw_ = {};
          this.fieldMap_ = [];
          this.listMap_ = [];
          init.call(this);
        },
      };
    };
    def("root", function () { this.setDeletable(false); });
    def("trigger", function () {
      this.setPreviousStatement(true, CHECK_PREV.trigger);
      this.setNextStatement(true, CHECK_PREV.trigger);
    });
    def("condition", function () {
      this.setPreviousStatement(true, CHECK_PREV.condition);
      this.setNextStatement(true, ["ha_condition", "ha_action"]);
    });
    def("action", function () {
      this.setPreviousStatement(true, CHECK_PREV.action);
      this.setNextStatement(true, ["ha_action", "ha_condition"]);
    });
    def("option", function () {
      this.setPreviousStatement(true, CHECK_PREV.option);
      this.setNextStatement(true, CHECK_PREV.option);
    });
  }

  // ---------- Werkzeugkasten ----------
  // Leere Vorgaben weglassen: Felder werden trotzdem angezeigt, aber nur geschrieben, wenn man sie ausfüllt.
  // Diese Schlüssel bestimmen die Blockart und bleiben deshalb auch leer erhalten.
  const KIND_KEYS = new Set(["action", "event", "stop", "scene", "wait_template", "variables"]);
  function stripEmpty(v, top = true) {
    if (Array.isArray(v)) return v.map((x) => stripEmpty(x, true));
    if (!isObj(v)) return v;
    const o = {};
    for (const [k, x] of Object.entries(v)) {
      const y = stripEmpty(x, false);
      if (!(top && KIND_KEYS.has(k)) && (y === "" || (isObj(y) && !Object.keys(y).length))) continue;
      o[k] = y;
    }
    return o;
  }
  const tb = (kind, raw) => ({ kind: "block", type: "ha_" + kind, extraState: { raw: stripEmpty(raw) } });
  const label = (text) => ({ kind: "label", text });

  function buildToolbox() {
    const services = hooks.services().map((s) => (Array.isArray(s) ? s[0] : s));
    const has = (s) => services.includes(s);
    const svc = (s, extra = {}) => tb("action", { action: s, target: { entity_id: "" }, ...extra });
    const notifyServices = services.filter((s) => s.startsWith("notify.") && s !== "notify.send_message");

    const actionBlocks = [
      label("Allgemein"),
      tb("action", { action: "", target: { entity_id: "" }, data: {} }),
      label("Licht & Schalter"),
      svc("light.turn_on"), svc("light.turn_off"), svc("light.toggle"),
      svc("switch.turn_on"), svc("switch.turn_off"),
      svc("homeassistant.turn_on"), svc("homeassistant.turn_off"), svc("homeassistant.toggle"),
      label("Klima & Cover"),
      svc("climate.set_temperature", { data: { temperature: 20 } }),
      svc("climate.set_hvac_mode", { data: { hvac_mode: "heat" } }),
      svc("cover.open_cover"), svc("cover.close_cover"),
      label("Helfer & Szenen"),
      svc("input_boolean.turn_on"), svc("input_boolean.turn_off"),
      svc("input_number.set_value", { data: { value: 0 } }),
      svc("input_select.select_option", { data: { option: "" } }),
      tb("action", { scene: "" }),
      svc("script.turn_on"),
      svc("automation.trigger"),
      label("Medien"),
      svc("media_player.media_pause"), svc("media_player.volume_set", { data: { volume_level: 0.3 } }),
      label("Benachrichtigen"),
      ...notifyServices.slice(0, 8).map((s) => tb("action", { action: s, data: { message: "" } })),
      tb("action", { action: "persistent_notification.create", data: { title: "", message: "" } }),
      ...(has("tts.speak") ? [tb("action", { action: "tts.speak", target: { entity_id: "" }, data: { media_player_entity_id: "", message: "" } })] : []),
      label("Ereignis & Variablen"),
      tb("action", { event: "", event_data: {} }),
      tb("action", { variables: { name: "wert" } }),
    ].filter((x) => x.kind === "label" || !x.extraState.raw.action || x.extraState.raw.action === "" || !services.length || has(x.extraState.raw.action));

    return {
      kind: "categoryToolbox",
      contents: [
        { kind: "category", name: "Auslöser", colour: String(C.trigger), contents: [
          tb("trigger", { trigger: "state", entity_id: "", to: "" }),
          tb("trigger", { trigger: "numeric_state", entity_id: "", above: 20 }),
          tb("trigger", { trigger: "time", at: "07:00:00" }),
          tb("trigger", { trigger: "time_pattern", minutes: "/5" }),
          tb("trigger", { trigger: "sun", event: "sunset", offset: "00:00:00" }),
          tb("trigger", { trigger: "zone", entity_id: "", zone: "zone.home", event: "enter" }),
          tb("trigger", { trigger: "template", value_template: "" }),
          tb("trigger", { trigger: "homeassistant", event: "start" }),
          tb("trigger", { trigger: "event", event_type: "" }),
          tb("trigger", { trigger: "calendar", entity_id: "", event: "start", offset: "0:0:0" }),
          tb("trigger", { trigger: "conversation", command: "" }),
          tb("trigger", { trigger: "mqtt", topic: "" }),
          tb("trigger", { trigger: "webhook", webhook_id: "", local_only: true }),
          tb("trigger", { trigger: "tag", tag_id: "" }),
          tb("trigger", { trigger: "persistent_notification", notification_id: "" }),
        ] },
        { kind: "category", name: "Bedingungen", colour: String(C.condition), contents: [
          tb("condition", { condition: "state", entity_id: "", state: "" }),
          tb("condition", { condition: "numeric_state", entity_id: "", below: 20 }),
          tb("condition", { condition: "time", after: "08:00:00", before: "22:00:00" }),
          tb("condition", { condition: "sun", after: "sunset" }),
          tb("condition", { condition: "zone", entity_id: "", zone: "zone.home" }),
          tb("condition", { condition: "trigger", id: "" }),
          tb("condition", { condition: "template", value_template: "" }),
          label("Logik"),
          tb("condition", { condition: "and", conditions: [] }),
          tb("condition", { condition: "or", conditions: [] }),
          tb("condition", { condition: "not", conditions: [] }),
        ] },
        { kind: "category", name: "Aktionen", colour: String(C.action), contents: actionBlocks },
        { kind: "category", name: "Ablauf", colour: String(C.flow), contents: [
          tb("action", { if: [], then: [], else: [] }),
          tb("action", { choose: [{ conditions: [], sequence: [] }], default: [] }),
          tb("option", { conditions: [], sequence: [] }),
          tb("action", { delay: { hours: 0, minutes: 1, seconds: 0 } }),
          tb("action", { wait_template: "", timeout: { minutes: 5 }, continue_on_timeout: true }),
          tb("action", { wait_for_trigger: [], timeout: { minutes: 5 } }),
          tb("action", { repeat: { count: 2, sequence: [] } }),
          tb("action", { repeat: { while: [], sequence: [] } }),
          tb("action", { repeat: { until: [], sequence: [] } }),
          tb("action", { parallel: [] }),
          tb("action", { sequence: [] }),
          tb("action", { stop: "" }),
        ] },
        { kind: "category", name: "Roh-JSON", colour: C.generic, contents: [
          label("Für alles ohne eigenen Block – rechts im JSON-Feld bearbeiten"),
          tb("action", {}),
        ] },
      ],
    };
  }

  const NEW_AUTOMATION = () => ({
    alias: "Neue Automation",
    description: "",
    triggers: [],
    conditions: [],
    actions: [],
    mode: "single",
  });

  const api = { isObj, clone, deepEqual, getPath, specFor, itemToBlockJson, blockToItem, defineBlocks, buildToolbox, hooks, classify, NEW_AUTOMATION };
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.HAB = api;
})(typeof window !== "undefined" ? window : globalThis);
