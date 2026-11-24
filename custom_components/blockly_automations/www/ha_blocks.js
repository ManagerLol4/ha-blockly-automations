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
  const HAV = typeof module === "object" && module.exports ? require("./ha_values.js") : root.HAV;

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
    serviceName: () => "",
    entities: () => [],          // (domains[]) -> [[entity_id, name], ...]
    states: () => [],            // (entity_id) -> ["on", "off", ...]
    services: () => [],          // () -> [["light.turn_on", "Licht einschalten"], ...]
    serviceFields: () => null,   // ("light.turn_on") -> {key: {selector, name}}
    serviceTarget: () => null,   // ("light.turn_on") -> true/false (hat ein Ziel), null = unbekannt
    openEditor: null,            // (block) -> öffnet den nativen HA-Eigenschaften-Dialog
    addItem: null,               // (block, inputName, kind) -> HA-Dialog „… hinzufügen“
    describe: () => "",          // (kind, item) -> Klartext-Satz für den Einfach-Modus
    simple: false,               // Einfach-Modus: Klartext statt Eingabefelder
    pickField: null,             // (block, chip) -> Auswahlfenster für eine Option
    chipText: () => "",          // (chip, value, raw) -> Anzeige des Werts
    triggerIds: () => [],        // () -> ["bewegung", ...] Trigger-IDs der offenen Automation
    blueprintInputs: () => null, // (path, kind) -> {key: {name, selector}} Eingaben eines Blueprints
    scripts: () => [],           // () -> [["script.x", "Name"], ...] für den Werkzeugkasten
    renameBlock: null,           // (block) -> Name (alias) eines Schritts setzen
    editScriptFields: null,      // (block) -> Eingaben eines Skripts bearbeiten
    blockly: false,              // Blockly-Modus: alles im Baustein, eigene Auswahllisten statt HA-Dialoge
    expert: false,               // Expertenmodus (JSON-Seitenleiste, Roh-JSON-Bausteine)
    options: () => [],           // (type, ctx) -> [[wert, anzeige, gruppe?, hinweis?]] oder Promise davon
    optionLabel: () => "",       // (type, wert, ctx) -> Anzeige eines gewählten Werts
    deviceEntry: () => null,     // (schlüssel) -> vollständiger Eintrag einer Geräte-Automation
    domainName: (d) => d,        // ("light") -> "Licht"
    toolboxSearch: false,        // Suche im Werkzeugkasten (Plugin geladen)
    addVariable: null,           // (block) -> neue Variable in „Variablen setzen“
    ifToChoose: null,            // (block) -> „Wenn“ um „sonst wenn“ erweitern (wird zur Auswahl)
    extractScript: null,         // (block, alle folgenden?) -> Schritte als neues Skript auslagern
    entityExists: () => null,    // (entity_id) -> true/false, null = unbekannt (Prüfregel „gibt es nicht“)
    entityIds: () => [],         // () -> alle entity_ids (für Korrekturvorschläge)
    changeType: null,            // (block) -> Typ eines Bausteins ändern (Auswahl nach Typ)
    captureScene: null,          // (block) -> Szene: Zustand von jetzt übernehmen (eine Entität oder alle)
  };

  // Felder, in die im Blockly-Modus ein Wert-Baustein gesteckt werden kann (dort sind Templates erlaubt).
  const VALUE_PATH = /^(data\.|variables\.|event_data\.)|^(value_template|wait_template|repeat\.count)$/;
  const valuesOn = () => !!(hooks.blockly || hooks.expert);
  const valueSlot = (f) => valuesOn() && !f.row && !f.dur && ["text", "template", "number"].includes(f.type) && VALUE_PATH.test(f.path);

  // Einfach-Modus: welche Optionen eines Bausteins als anklickbare Werte erscheinen.
  // Zeiträume (Std/Min/Sek) werden zu einem Wert zusammengefasst, Profi-Optionen
  // und leere Dienst-Felder nur gezeigt, wenn sie gesetzt sind.
  function simpleChips(spec, raw) {
    const out = [];
    const seenDur = new Set();
    for (const f of spec.fields) {
      if (f.dur) {
        if (seenDur.has(f.durPath)) continue;
        seenDur.add(f.durPath);
        if (getPath(raw, f.durPath) === undefined && f.show === "present") continue;
        out.push({ path: f.durPath, label: f.dur, type: "duration", row: f.row && f.row !== f.durPath ? f.row : undefined });
        continue;
      }
      const v = getPath(raw, f.path);
      if (v === undefined && (f.show === "present" || f.adv || f.path.startsWith("data."))) continue;
      if (f.type === "service") { out.push({ ...f, label: "Aktion", type: "service" }); continue; }
      if (f.path === "target.entity_id") { out.push({ ...f, path: "target", label: "Ziel", type: "target", required: true }); continue; }
      if (f.path.startsWith("target.")) continue;
      const required = ["entity_id", "zone", "at", "state", "event"].includes(f.path);
      out.push({ ...f, required });
    }
    return out;
  }

  // Blöcke ohne verschachtelte Listen können im nativen HA-Dialog bearbeitet werden.
  const STRUCTURAL = ["choose", "if", "repeat", "parallel", "sequence", "wait_for_trigger"];
  function nativeEditable(kind, item) {
    if (!isObj(item)) return false;
    if (kind === "trigger") return true;
    if (kind === "condition") return !["and", "or", "not"].includes(item.condition);
    if (kind === "action") return !STRUCTURAL.some((k) => k in item);
    return false;
  }

  // ---------- Farben ----------
  const C = { trigger: 30, condition: 210, action: 140, flow: 260, generic: "#8a8a8a", root: 50, script: 290, scene: 330 };
  const NONE = "__ha_none__";
  const ADD_LABEL = { trigger: "＋ Auslöser hinzufügen", condition: "＋ Bedingung hinzufügen", action: "＋ Aktion hinzufügen", option: "＋ Option hinzufügen", sceneent: "＋ Entität hinzufügen" };
  const GEAR = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path fill="#fff" d="M12 15.5A3.5 3.5 0 0 1 8.5 12 3.5 3.5 0 0 1 12 8.5a3.5 3.5 0 0 1 3.5 3.5 3.5 3.5 0 0 1-3.5 3.5m7.43-2.53c.04-.32.07-.64.07-.97s-.03-.66-.07-1l2.11-1.63c.19-.15.24-.42.12-.64l-2-3.46c-.12-.22-.39-.31-.61-.22l-2.49 1c-.52-.39-1.06-.73-1.69-.98l-.37-2.65A.506.506 0 0 0 14 2h-4c-.25 0-.46.18-.5.42l-.37 2.65c-.63.25-1.17.59-1.69.98l-2.49-1c-.22-.09-.49 0-.61.22l-2 3.46c-.13.22-.07.49.12.64L4.57 11c-.04.34-.07.67-.07 1s.03.65.07.97l-2.11 1.66c-.19.15-.25.42-.12.64l2 3.46c.12.22.39.3.61.22l2.49-1.01c.52.4 1.06.74 1.69.99l.37 2.65c.04.24.25.42.5.42h4c.25 0 .46-.18.5-.42l.37-2.65c.63-.26 1.17-.59 1.69-.99l2.49 1.01c.22.08.49 0 .61-.22l2-3.46c.12-.22.07-.49-.12-.64z"/></svg>');
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
  const L = (path, label, kind, o = {}) => ({ path, label, kind, ...o });
  // Listen aus einem Objekt (Szene: entities = {entity_id: zustand}) als Liste von {__e, __v}.
  const listArr = (l, v) => (l.dict ? (isObj(v) ? Object.entries(v).map(([k, x]) => ({ __e: k, __v: x })) : []) : Array.isArray(v) ? v : [v]);
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
      return units.map((u, i) => F(`${path}.${u}`, (i === 0 ? label + " " : "") + (UNIT[u] || u), { row: path, numeric: true, type: "number", dur: label, durPath: path }));
    }
    return [F(path, label, { dur: label, durPath: path })];
  }

  // ---------- Spezifikationen ----------
  function triggerSpec(t) {
    const key = t.trigger !== undefined ? "trigger" : "platform";
    const p = t[key];
    const mk = (title, fields, colour = C.trigger, extra = {}) => ({
      title, colour, fields: [...fields, F("id", "ID", { adv: true })], lists: [], ...extra,
    });
    switch (p) {
      case "state":
        return mk("🔁 Zustand ändert sich", [
          F("entity_id", "Entität", { type: "entity" }),
          F("attribute", "Attribut", { adv: true }),
          F("from", "von", { type: "state", of: "entity_id", row: "ft" }),
          F("to", "zu", { type: "state", of: "entity_id", row: "ft" }),
          P("not_from", "nicht von", { type: "state", of: "entity_id", row: "nft" }),
          P("not_to", "nicht zu", { type: "state", of: "entity_id", row: "nft" }),
          ...duration(t, "for", "für"),
        ]);
      case "numeric_state":
        return mk("📈 Zahlenwert", [
          F("entity_id", "Entität", { type: "entity", domains: ["sensor", "number", "input_number", "climate", "weather"] }),
          F("attribute", "Attribut", { adv: true }),
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
        return mk(deviceTitle(t), deviceFields("trigger"), C.trigger, { summaryLine: false });
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
          F("attribute", "Attribut", { adv: true }),
          F("state", "Zustand", { type: "state", of: "entity_id" }),
          ...duration(c, "for", "seit"),
          P("match", "Treffer", { type: "select", options: [["alle", "all"], ["einer", "any"]] }),
        ]);
      case "numeric_state":
        return mk("📏 Zahlenwert", [
          F("entity_id", "Entität", { type: "entity", domains: ["sensor", "number", "input_number", "climate", "weather"] }),
          F("attribute", "Attribut", { adv: true }),
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
        return mk("🏷️ Ausgelöst durch ID", [F("id", "", { type: "triggerid" })]);
      case "and":
        return mk("UND – alle erfüllt", [], [L("conditions", "", "condition")], C.flow);
      case "or":
        return mk("ODER – eine erfüllt", [], [L("conditions", "", "condition")], C.flow);
      case "not":
        return mk("NICHT – keine erfüllt", [], [L("conditions", "", "condition")], C.flow);
      case "device":
        return mk(deviceTitle(c), deviceFields("condition"));
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
    else if (t === "area" || t === "device" || t === "floor") o.type = t;
    else if (["object", "color_rgb", "media"].includes(t)) o.type = "json";
    else if (t === "time") o.type = "time";
    return F(path, label, { ...o, sel });
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

  const hasTargetFor = (a, key) => (typeof a[key] === "string" && a[key] ? hooks.serviceTarget(a[key]) : null);
  // Geräte-Auslöser/-Bedingungen/-Aktionen: im Blockly-Modus Gerät und Art direkt wählbar.
  const deviceFields = (kind) => (hooks.blockly
    ? [F("device_id", "Gerät", { type: "device" }), F("__devauto", kind === "trigger" ? "Auslöser" : kind === "condition" ? "Bedingung" : "Aktion", { type: "devauto", kind })]
    : []);
  const deviceTitle = (x) => (hooks.blockly ? "📟 Gerät" : `📟 Gerät: ${x.type || ""}${x.subtype !== undefined ? " " + x.subtype : ""} (${x.domain || ""})`);

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
      else if (typeof a.target === "string") fields.push(F("target", "Ziel", { type: "entity" })); // z. B. Blueprint-Eingabe
      else {
        const hasTarget = typeof svc === "string" ? hooks.serviceTarget(svc) : null;
        fields.push(F("target.entity_id", "Entität", { type: "entity", domains, show: hasTarget === false ? "present" : "always" }));
      }
      // Im Blockly-Modus sind Bereich und Gerät immer wählbar; sonst nur, wenn gesetzt.
      const tShow = hooks.blockly && typeof a.target !== "string" && (hasTargetFor(a, key) !== false) ? "always" : "present";
      fields.push(F("target.area_id", "Bereich", { type: "area", show: tShow }));
      fields.push(F("target.device_id", "Gerät", { type: "device", show: tShow }));
      fields.push(P("target.floor_id", "Etage", { type: "floor" }));
      fields.push(P("target.label_id", "Label", { type: "list" }));
      if (typeof svc === "string") fields.push(...serviceDataFields(a, svc));
      else if (isObj(a.data)) fields.push(F("data", "Daten (JSON)", { type: "json" }));
      fields.push(P("data_template", "Daten (alt)", { type: "json" }));
      fields.push(P("response_variable", "Antwort in Variable"));
      return mk(serviceTitle(svc), fields);
    }
    if ("event" in a) return mk("📣 Ereignis senden", [F("event", "Typ"), F("event_data", "Daten (JSON)", { type: "json" })]);
    if ("scene" in a) return mk("🎬 Szene aktivieren", [F("scene", "", { type: "entity", domains: ["scene"] })]);
    if ("stop" in a) return mk("⛔ Stopp", [F("stop", "Grund"), F("error", "als Fehler", { type: "bool" })], [], C.flow);
    if ("variables" in a && isObj(a.variables))
      return mk("📦 Variablen setzen", Object.keys(a.variables).map((k) => F(`variables.${k}`, k, { type: isPrim(a.variables[k]) ? "text" : "json" })), [], C.flow);
    if ("device_id" in a) return mk(deviceTitle(a), deviceFields("action"));
    return { ...mk("Aktion (unbekannt)", []), colour: C.generic, generic: true };
  }

  // Kopfzeile eines Dienst-Bausteins: Symbol des Bereichs + Name des Dienstes („💡 Leuchte einschalten“).
  const DOMAIN_ICON = {
    light: "💡", switch: "🔌", fan: "🌀", climate: "🌡️", water_heater: "🚿", humidifier: "💧", cover: "🪟", lock: "🔒",
    media_player: "🔈", remote: "📺", camera: "📷", vacuum: "🧹", lawn_mower: "🌱", alarm_control_panel: "🚨", siren: "🚨",
    notify: "📱", persistent_notification: "🔔", tts: "🗣️", logbook: "📓", system_log: "📓",
    script: "📜", automation: "🤖", scene: "🎬", homeassistant: "🏠",
    input_boolean: "🎚️", input_number: "🎚️", input_select: "🎚️", input_text: "🎚️", input_datetime: "🎚️", input_button: "🎚️",
    counter: "🔢", timer: "⏲️", number: "🔢", select: "📋", button: "🔘", todo: "✅", calendar: "📅", weather: "🌦️",
    valve: "🚰", event: "📣", update: "⬆️", zone: "📍", person: "🧑", device_tracker: "📍",
  };
  const SVC_WORDS = { turn_on: "einschalten", turn_off: "ausschalten", toggle: "umschalten", open_cover: "öffnen", close_cover: "schließen",
    stop_cover: "stoppen", set_value: "Wert setzen", select_option: "Option wählen", press: "drücken", reload: "neu laden", trigger: "auslösen",
    lock: "abschließen", unlock: "aufschließen", set_temperature: "Temperatur setzen", set_hvac_mode: "Modus setzen" };
  const DOMAIN_DE = { light: "Licht", switch: "Schalter", fan: "Ventilator", climate: "Heizung", cover: "Rollladen", lock: "Schloss",
    media_player: "Medienplayer", notify: "Nachricht", scene: "Szene", script: "Skript", automation: "Automation", homeassistant: "Gerät",
    input_boolean: "Schalter-Helfer", input_number: "Zahlen-Helfer", input_select: "Auswahl-Helfer", input_text: "Text-Helfer",
    input_button: "Taster-Helfer", counter: "Zähler", timer: "Timer", vacuum: "Staubsauger", persistent_notification: "Hinweis" };
  function serviceTitle(svc) {
    if (typeof svc !== "string" || !svc.includes(".")) return "▶️ Dienst aufrufen";
    const [d, s] = svc.split(".");
    const icon = DOMAIN_ICON[d] || "▶️";
    let n = "";
    try { n = String(hooks.serviceName(svc) || "").replace(/^·\s*/, ""); } catch (e) { n = ""; }
    if (!n && d === "script") { try { n = String(hooks.entityName(svc) || ""); } catch (e) { n = ""; } }
    if (!n) n = `${DOMAIN_DE[d] || hooks.domainName(d) || d} ${SVC_WORDS[s] || s.replace(/_/g, " ")}`;
    return `${icon} ${n}`;
  }

  const MODE_FIELDS = (cfg) => [
    F("mode", "Modus", {
      type: "select", row: "mode",
      options: [["(Standard: single)", ""], ["single – nicht erneut starten", "single"], ["restart – neu starten", "restart"],
        ["queued – nacheinander", "queued"], ["parallel – gleichzeitig", "parallel"]],
    }),
    ...(cfg.mode === "queued" || cfg.mode === "parallel" || cfg.max !== undefined ? [F("max", "max.", { numeric: true, row: "mode" })] : []),
  ];

  // Automation oder Skript aus einem Blueprint: nur Name und Eingaben.
  function blueprintSpec(cfg, kind) {
    const bp = cfg.use_blueprint;
    const meta = (typeof bp.path === "string" && hooks.blueprintInputs(bp.path, kind)) || {};
    const fields = [F("alias", "Name"), P("description", "Beschreibung")];
    const seen = new Set();
    const walk = (o) => {
      for (const [k, f] of Object.entries(o || {})) {
        if (f && isObj(f.input)) { walk(f.input); continue; }
        if (k.includes(".")) continue;
        seen.add(k);
        fields.push(selectorField(`use_blueprint.input.${k}`, (f && f.name) || k, f && f.selector, "always"));
      }
    };
    walk(meta);
    const inp = isObj(bp.input) ? bp.input : {};
    for (const k of Object.keys(inp)) {
      if (seen.has(k) || k.includes(".")) continue;
      fields.push(F(`use_blueprint.input.${k}`, k, { type: isPrim(inp[k]) ? "text" : "json" }));
    }
    const name = String(bp.path || "").replace(/\.yaml$/, "").split("/").pop();
    return { title: `🧩 Blueprint: ${name}`, colour: kind === "script" ? C.script : C.root, fields, lists: [], blueprint: true };
  }

  function rootSpec(cfg) {
    if (isObj(cfg.use_blueprint)) return blueprintSpec(cfg, "automation");
    const pick = (a, b) => (a in cfg ? a : b in cfg ? b : a);
    return {
      title: "🤖 Automation",
      colour: C.root,
      fields: [F("alias", "Name"), F("description", "Beschreibung"), ...MODE_FIELDS(cfg)],
      lists: [L(pick("triggers", "trigger"), "WENN", "trigger"), L(pick("conditions", "condition"), "NUR WENN", "condition"), L(pick("actions", "action"), "DANN", "action")],
    };
  }

  // Skript = wiederverwendbare Funktion mit Eingaben (fields) und Ablauf (sequence).
  function scriptSpec(cfg) {
    if (isObj(cfg.use_blueprint)) return blueprintSpec(cfg, "script");
    return {
      title: "📜 Skript (Funktion)",
      colour: C.script,
      fields: [F("alias", "Name"), F("description", "Beschreibung"), ...MODE_FIELDS(cfg), P("icon", "Symbol"), F("fields", "Eingaben (JSON)", { type: "json", show: hooks.blockly ? "always" : "present" })],
      lists: [L("sequence", "ABLAUF", "action")],
    };
  }

  // Szene: Name, Symbol und Entitäten mit ihrem Zielzustand.
  function sceneSpec(cfg) {
    return { title: "🎬 Szene", colour: C.scene, fields: [F("name", "Name"), P("icon", "Symbol")], lists: [L("entities", "ENTITÄTEN", "sceneent", { dict: true })] };
  }
  const SCENE_ATTRS = ["brightness", "color_temp_kelvin", "color_temp", "hs_color", "rgb_color", "xy_color", "color_mode", "effect",
    "position", "current_position", "tilt_position", "current_tilt_position", "temperature", "target_temp_low", "target_temp_high",
    "hvac_mode", "preset_mode", "fan_mode", "percentage", "oscillating", "direction", "volume_level", "is_volume_muted", "source", "value", "option"];
  function sceneEntSpec(it) {
    const v = isObj(it) ? it.__v : undefined;
    const fields = [F("__e", "Entität", { type: "entity" })];
    if (isObj(v)) {
      fields.push(F("__v.state", "Zustand", { type: "state", of: "__e" }));
      for (const k of Object.keys(v)) if (k !== "state") fields.push(F(`__v.${k}`, k, { type: isPrim(v[k]) ? "text" : "json" }));
    } else fields.push(F("__v", "Zustand", { type: "state", of: "__e" }));
    return { title: "💡 Entität", colour: C.scene, fields, lists: [] };
  }

  function specFor(kind, item) {
    let spec;
    if (kind === "scene") return sceneSpec(isObj(item) ? item : {});
    if (kind === "sceneent") return sceneEntSpec(item);
    if (kind === "root") spec = rootSpec(isObj(item) ? item : {});
    else if (kind === "script") spec = scriptSpec(isObj(item) ? item : {});
    else if (kind === "trigger") spec = isObj(item) ? triggerSpec(item) : { title: "Auslöser", colour: C.generic, fields: [], lists: [], generic: true };
    else if (kind === "condition") spec = conditionSpec(item);
    else if (kind === "option") spec = { title: "Option", colour: C.flow, fields: [], lists: [L("conditions", "wenn", "condition"), L("sequence", "dann", "action")] };
    else spec = actionSpec(item);
    if (isObj(item) && kind !== "root" && kind !== "script") {
      const extra = [];
      if (item.alias !== undefined && isPrim(item.alias)) extra.push(F("alias", "Name"));
      spec.fields = [...extra, ...spec.fields];
      if (kind === "action" && item.continue_on_error !== undefined) spec.fields.push(F("continue_on_error", "bei Fehler weiter", { type: "bool" }));
    }
    return spec;
  }

  const ROOTS = new Set(["root", "script", "scene"]);
  // Schlüssel einer Geräte-Automation (welche Art bei welchem Gerät).
  const devKey = (x) => (isObj(x) && (x.domain || x.type) ? JSON.stringify([x.domain || "", x.type || "", x.subtype === undefined ? "" : x.subtype, x.entity_id || ""]) : "");
  const classify = (listKind, el) => (listKind === "action" && isObj(el) && "condition" in el ? "condition" : listKind);
  const CHECK_PREV = { trigger: "ha_trigger", condition: "ha_condition", action: "ha_action", option: "ha_option", sceneent: "ha_sceneent" };
  const CHECK_LIST = { trigger: ["ha_trigger"], condition: ["ha_condition"], action: ["ha_action", "ha_condition"], option: ["ha_option"], sceneent: ["ha_sceneent"] };

  // ---------- HA-Objekt -> Blockly-JSON ----------
  function itemToBlockJson(kind, item) {
    const spec = specFor(kind, item);
    const json = { type: "ha_" + kind, extraState: { raw: clone(item) } };
    if (isObj(item) && item.enabled === false && !ROOTS.has(kind)) json.enabled = false;
    // Templates aus Wert-Bausteinen wieder als Bausteine einstecken.
    if (valuesOn() && isObj(item)) {
      spec.fields.forEach((f, i) => {
        if (!valueSlot(f)) return;
        const tree = HAV.decode(getPath(item, f.path));
        const vb = tree && HAV.treeToBlockJson(tree);
        if (vb) (json.inputs = json.inputs || {})["V" + i] = { block: vb };
      });
    }
    spec.lists.forEach((l, i) => {
      const v = getPath(item, l.path);
      if (v === undefined || v === null) return;
      const arr = listArr(l, v);
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
  const LISTY = new Set(["entity", "state", "list", "triggerid", "area", "device", "floor"]);
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
      if (f.type === "devauto") {
        const val = b.getFieldValue(f.name);
        if (!val || val === f.origStr || !isObj(out)) continue;
        const e = hooks.deviceEntry(val);
        if (!isObj(e)) continue;
        const keep = {};
        for (const k of ["alias", "id", "enabled", "continue_on_error"]) if (out[k] !== undefined) keep[k] = out[k];
        const dev = out.device_id;
        const ent = clone(e);
        delete ent.metadata;
        if (ent.platform !== undefined && ent.trigger === undefined && isObj(b.raw_) && "trigger" in b.raw_) { ent.trigger = ent.platform; delete ent.platform; }
        out = { ...keep, ...ent };
        if (dev) out.device_id = dev;
        continue;
      }
      if (f.type === "weekdays") {
        const sel = WEEKDAYS.map(([d]) => d).filter((d, i) => b.getFieldValue(`${f.name}_${i}`) === "TRUE");
        const origArr = f.orig === undefined ? [] : [].concat(f.orig);
        const same = sel.length === origArr.length && sel.every((d) => origArr.includes(d));
        if (same) continue;
        if (!sel.length) delPath(out, f.path);
        else setPath(out, f.path, typeof f.orig === "string" && sel.length === 1 ? sel[0] : sel);
        continue;
      }
      if (f.vin) {
        const vb = b.getInputTargetBlock(f.vin);
        if (vb && vb.isEnabled()) {
          const val = HAV.compileBlock(vb);
          if (val !== f.origStr) setPath(out, f.path, val);
          continue;
        }
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
        if (l.dict) {
          const o = {};
          for (const it of items) if (isObj(it) && typeof it.__e === "string" && it.__e) o[it.__e] = it.__v === undefined ? "" : it.__v;
          setPath(out, l.path, o);
          return;
        }
        if (l.single && items.length === 1) setPath(out, l.path, items[0]);
        else setPath(out, l.path, items);
      });
      if (!ROOTS.has(b.haKind_)) {
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
    // Anklickbarer Text (z. B. „＋ Auslöser hinzufügen“ oder der Klartext-Satz eines Blocks).
    class FieldButton extends Blockly.FieldLabel {
      constructor(text, onClick, cls) {
        super(text, cls);
        this.onClick_ = onClick;
        this.EDITABLE = true;
        this.SERIALIZABLE = true; // nur Anzeige; der Wert wird beim Laden neu berechnet
      }
      showEditor_() {
        const b = this.getSourceBlock();
        if (this.onClick_ && b && !b.isInFlyout) this.onClick_();
      }
    }

    let dlCount = 0;
    class FieldSuggest extends Blockly.FieldTextInput {
      constructor(value, provider) {
        super(value);
        this.provider_ = provider;
      }
      // Auswahl-Felder öffnen den nativen HA-Dialog statt einer Textliste.
      showEditor_(e, quiet) {
        const b = this.getSourceBlock();
        if (hooks.openEditor && b && nativeEditable(b.haKind_, b.raw_)) { hooks.openEditor(b); return; }
        super.showEditor_(e, quiet);
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

    /* Auswahlfeld mit Suche (Blockly-Modus): zeigt den Namen, speichert den Wert.
     * Liste im Blockly-Dropdown: Suchfeld, gruppierte Einträge, bei Listen Mehrfachauswahl.
     * Freitext (z. B. Templates) mit Enter übernehmen. */
    class FieldPicker extends Blockly.FieldTextInput {
      constructor(value, def) {
        super(value);
        this.def_ = def;
      }
      getText_() {
        const v = this.getValue();
        if (v === null || v === undefined || v === "") return this.def_.placeholder || "⚠ wählen …";
        const parts = this.def_.multi ? String(v).split(",").map((x) => x.trim()).filter(Boolean) : [String(v)];
        const names = parts.map((x) => { try { return hooks.optionLabel(this.def_.type, x, this) || x; } catch (e) { return x; } });
        const txt = names.join(", ");
        return txt.length > 48 ? txt.slice(0, 47) + "…" : txt;
      }
      showEditor_() {
        const b = this.getSourceBlock();
        if (!b || b.isInFlyout) return;
        const field = this;
        const def = this.def_;
        // Ein noch offenes (oder gerade ausblendendes) Auswahlfenster sofort schließen.
        try { Blockly.DropDownDiv.hideWithoutAnimation(); } catch (e) { /* nichts offen */ }
        const closePicker = () => { try { Blockly.DropDownDiv.hideWithoutAnimation(); } catch (e) { Blockly.DropDownDiv.hideIfOwner(field); } };
        Blockly.DropDownDiv.clearContent();
        const div = Blockly.DropDownDiv.getContentDiv();
        const box = document.createElement("div");
        box.className = "hab-picker";
        const input = document.createElement("input");
        input.type = "search";
        input.placeholder = def.free ? "Suchen oder eigenen Wert eingeben + Enter" : "Suchen …";
        const list = document.createElement("div");
        list.className = "hab-plist";
        const foot = document.createElement("div");
        foot.className = "hab-pfoot";
        const clear = document.createElement("button");
        clear.textContent = "Leeren";
        foot.appendChild(clear);
        const info = document.createElement("span");
        foot.appendChild(info);
        if (def.multi) {
          const done = document.createElement("button");
          done.textContent = "Fertig";
          done.className = "primary";
          done.addEventListener("click", () => closePicker());
          foot.appendChild(done);
        }
        box.append(input, list, foot);
        div.appendChild(box);
        let items = [];
        const selected = () => (def.multi ? String(field.getValue() || "").split(",").map((x) => x.trim()).filter(Boolean) : [String(field.getValue() || "")]);
        const setVal = (v) => field.setValue(v);
        const pick = (val) => {
          if (!def.multi) { setVal(val); closePicker(); return; }
          const cur = selected();
          const i = cur.indexOf(val);
          if (i >= 0) cur.splice(i, 1); else cur.push(val);
          setVal(cur.join(", "));
          render();
        };
        const render = () => {
          const q = input.value.trim().toLowerCase();
          const sel = selected();
          list.innerHTML = "";
          const shown = items.filter((o) => !q || String(o[0]).toLowerCase().includes(q) || String(o[1] || "").toLowerCase().includes(q) || String(o[2] || "").toLowerCase().includes(q));
          let lastGroup = null;
          for (const o of shown.slice(0, 300)) {
            if (o[2] && o[2] !== lastGroup) {
              lastGroup = o[2];
              const g = document.createElement("div");
              g.className = "hab-pgroup";
              g.textContent = o[2];
              list.appendChild(g);
            }
            const it = document.createElement("div");
            it.className = "hab-pitem" + (sel.includes(String(o[0])) ? " sel" : "");
            const n = document.createElement("span");
            n.textContent = (def.multi ? (sel.includes(String(o[0])) ? "☑ " : "☐ ") : "") + (o[1] || o[0]);
            it.appendChild(n);
            const hint = o.length > 3 ? o[3] : o[0];
            if (hint && o[1] && hint !== o[1]) {
              const h = document.createElement("small");
              h.textContent = hint;
              it.appendChild(h);
            }
            it.addEventListener("mousedown", (e) => e.preventDefault());
            it.addEventListener("click", () => pick(String(o[0])));
            list.appendChild(it);
          }
          info.textContent = shown.length > 300 ? `300 von ${shown.length} – weiter eingrenzen` : shown.length ? "" : (q && def.free ? "Enter übernimmt den eigenen Wert" : "Keine Treffer");
        };
        input.addEventListener("input", render);
        input.addEventListener("keydown", (e) => {
          if (e.key === "Escape") { closePicker(); return; }
          if (e.key !== "Enter") return;
          e.preventDefault();
          const q = input.value.trim();
          const first = list.querySelector(".hab-pitem");
          const exact = items.find((o) => String(o[0]) === q);
          if (exact) pick(String(exact[0]));
          else if (q && def.free) { if (def.multi) pick(q); else { setVal(q); closePicker(); } }
          else if (first) first.click();
        });
        clear.addEventListener("click", () => { setVal(""); if (def.multi) render(); else closePicker(); });
        Blockly.DropDownDiv.setColour("#ffffff", "#cccccc");
        Blockly.DropDownDiv.showPositionedByField(this, () => {});
        list.innerHTML = '<div class="hab-pgroup">lädt …</div>';
        Promise.resolve().then(() => hooks.options(def.type, field)).then((opts) => {
          items = Array.isArray(opts) ? opts.map((o) => (Array.isArray(o) ? o : [o, ""])) : [];
          const cur = selected().filter(Boolean);
          for (const c of cur) if (!items.some((o) => String(o[0]) === c)) items.unshift([c, "", "Aktuell"]);
          render();
        }).catch((e) => { list.innerHTML = ""; info.textContent = "Liste nicht verfügbar: " + (e && e.message ? e.message : e); });
        setTimeout(() => input.focus(), 0);
      }
    }
    const PICKER = {
      entity: { free: true }, state: { free: true }, service: { free: true }, area: { free: true }, device: { free: false },
      floor: { free: true }, time: { free: true }, triggerid: { free: true, multi: true }, devauto: { free: false },
      attribute: { free: true }, variable: { free: true },
    };
    // Wert-Bausteine: Entität, Zustand, Attribut, Variable mit Auswahlliste.
    HAV.defineValueBlocks(Blockly, (kind, def) => new FieldPicker(def, { ...PICKER[kind], type: kind, of: "e", placeholder: kind === "variable" ? "⚠ Name" : undefined }));

    const TIME_HINTS = () => [
      ...["06:00:00", "07:00:00", "08:00:00", "12:00:00", "18:00:00", "20:00:00", "22:00:00"],
      ...hooks.entities(["input_datetime", "sensor"]).filter(([id]) => id.startsWith("input_datetime.") || /time|zeit|alarm/i.test(id)),
    ];

    function fieldValueByPath(block, path) {
      const m = (block.fieldMap_ || []).find((x) => x.path === path);
      return m ? block.getFieldValue(m.name) : getPath(block.raw_, path);
    }

    function makeField(block, f, str) {
      if (hooks.blockly && PICKER[f.type]) {
        const multi = PICKER[f.type].multi || (LISTY.has(f.type) && Array.isArray(f.orig));
        return new FieldPicker(str, { ...PICKER[f.type], multi, type: f.type, domains: f.domains, of: f.of, kind: f.kind,
          placeholder: f.show === "present" || /^(from|to|attribute|target\.(area_id|device_id))$/.test(f.path) ? "–" : undefined });
      }
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
        case "triggerid":
          return new FieldSuggest(str, () => hooks.triggerIds());
        default:
          return new Blockly.FieldTextInput(str);
      }
    }

    const mixin = {
      saveExtraState() { return { raw: this.raw_ }; },
      onchange() {
        if (this.isInFlyout || !this.fieldMap_ || this.isDeadOrDying && this.isDeadOrDying()) return;
        for (const m of this.fieldMap_) {
          if (!m.vin) continue;
          const fld = this.getField(m.name);
          if (!fld) continue;
          const plugged = !!this.getInputTargetBlock(m.vin);
          if (plugged === fld.isVisible()) {
            fld.setVisible(!plugged);
            // Baustein entfernt: Feld leer (sonst stünde dort das alte Template).
            if (!plugged && HAV.decode(fld.getValue())) fld.setValue("");
            if (this.rendered) this.render();
          }
        }
      },
      customContextMenu(options) {
        if (this.isInFlyout || ROOTS.has(this.haKind_) || !hooks.renameBlock || !isObj(this.raw_)) return;
        const block = this;
        if (this.haKind_ === "sceneent") return;
        options.unshift({ text: "✏️ Name / Kommentar …", enabled: true, callback: () => hooks.renameBlock(block) });
        if (hooks.changeType && ["trigger", "condition", "action"].includes(this.haKind_))
          options.unshift({ text: "🔁 Typ ändern …", enabled: true, callback: () => hooks.changeType(block) });
        if (hooks.extractScript && (this.haKind_ === "action" || this.haKind_ === "condition") && this.previousConnection &&
            this.previousConnection.targetConnection && (this.previousConnection.getCheck() || []).includes("ha_action")) {
          options.push({ text: "📜 Als neues Skript auslagern (dieser Schritt)", enabled: true, callback: () => hooks.extractScript(block, false) });
          if (this.getNextBlock()) options.push({ text: "📜 Als neues Skript auslagern (ab hier bis zum Ende)", enabled: true, callback: () => hooks.extractScript(block, true) });
        }
      },
      loadExtraState(state) { this.build_(state && state.raw !== undefined ? state.raw : {}); },
      build_(raw) {
        this.raw_ = raw;
        const spec = specFor(this.haKind_, raw);
        // Einfach-Modus: statt Eingabefeldern anklickbare Werte („Chips“), die ein
        // Auswahlfenster im HA-Stil öffnen. Gespeichert wird über replaceBlock (verlustfrei).
        const simpleBlock = hooks.simple && hooks.openEditor && nativeEditable(this.haKind_, raw);
        if (hooks.simple && ROOTS.has(this.haKind_) && !spec.blueprint) spec.fields = spec.fields.filter((f) => f.path === "alias" || f.path === "name");
        const chips = simpleBlock && hooks.pickField ? simpleChips(spec, raw) : [];
        if (simpleBlock) spec.fields = [];
        this.spec_ = spec;
        this.chips_ = chips;
        this.setColour(spec.colour);
        const head = this.appendDummyInput("HEAD");
        head.appendField(spec.title, "TITLE");
        if (hooks.openEditor && nativeEditable(this.haKind_, raw)) {
          const block = this;
          head.appendField(new Blockly.FieldImage(GEAR, 16, 16, "Eigenschaften", () => hooks.openEditor(block)), "GEAR");
          if (!spec.generic) this.setTooltip("Zahnrad oder Auswahlfeld anklicken: Eigenschaften im HA-Dialog bearbeiten");
        }
        // Name eines Schritts (alias) sichtbar im Kopf – auch wenn der Block eingeklappt ist.
        if (!ROOTS.has(this.haKind_) && isObj(raw) && isPrim(raw.alias) && raw.alias !== "" && (hooks.simple || simpleBlock)) {
          head.appendField(new Blockly.FieldLabel("„" + short(raw.alias, 40) + "“", "ha-alias"), "ALIAS");
        }
        if (simpleBlock && chips.length) {
          const block = this;
          const rowsC = {};
          chips.forEach((c, i) => {
            let inp = c.row && rowsC[c.row];
            if (!inp) {
              inp = this.appendDummyInput("C" + i);
              if (c.row) rowsC[c.row] = inp;
            }
            if (c.label) inp.appendField(c.label);
            let txt = "";
            try { txt = hooks.chipText(c, getPath(raw, c.path), raw) || ""; } catch (e) { txt = ""; }
            if (!txt) txt = c.required ? "⚠ wählen …" : "–";
            if (txt.length > 46) txt = txt.slice(0, 45) + "…";
            inp.appendField(new FieldButton(txt, () => hooks.pickField(block, c), "ha-chip"), "CH" + i);
          });
          let full = "";
          try { full = hooks.describe(this.haKind_, raw) || ""; } catch (e) { full = ""; }
          this.setTooltip((full ? full + "\n\n" : "") + "Werte anklicken zum Auswählen · ⚙ für alle Einstellungen");
        } else if (simpleBlock) {
          const block = this;
          let text = "";
          try { text = hooks.describe(this.haKind_, raw) || ""; } catch (e) { text = ""; }
          if (!text) text = spec.generic ? short(raw, 60) : "Einstellungen öffnen";
          const full = text;
          if (text.length > 70) text = text.slice(0, 69) + "…";
          this.appendDummyInput("SUM").appendField(new FieldButton(text, () => hooks.openEditor(block), "ha-sentence"), "SUM");
          this.setTooltip(full + "\n\nKlicken, um es im Home-Assistant-Dialog zu ändern.");
        } else if (spec.generic) {
          this.appendDummyInput("SUM").appendField(new Blockly.FieldLabel(short(raw, 60), "ha-summary"));
          this.setTooltip("Wird unverändert übernommen. Bearbeiten über das Zahnrad oder das JSON-Feld.");
        }
        this.fieldMap_ = [];
        const rows = {};
        spec.fields.forEach((f, i) => {
          const v = getPath(raw, f.path);
          if (v === undefined && f.show === "present") return;
          let inp;
          const slot = valueSlot(f) && !this.isInFlyout;
          if (slot) inp = this.appendValueInput("V" + i).setCheck("HAValue");
          else if (f.row && rows[f.row]) inp = rows[f.row];
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
          const str = f.type === "devauto" ? devKey(raw) : toFieldString(v, f);
          const fld = makeField(this, { ...f, orig: v }, str);
          inp.appendField(fld, name);
          this.fieldMap_.push({ name, path: f.path, orig: v, origStr: str, type: f.type, numeric: f.numeric, vin: slot ? "V" + i : undefined });
          // Wert kommt aus Bausteinen: Textfeld ausblenden (Inhalt bleibt das Original).
          if (slot && HAV.decode(v)) fld.setVisible(false);
          if (hooks.blockly && PICKER[f.type]) {
            if (f.type === "entity" || f.type === "service") fld.setTooltip && fld.setTooltip(str);
            if (f.type === "service") this.serviceField_ = name;
            return;
          }
          if (f.type === "entity") {
            const lbl = new Blockly.FieldLabel(hooks.entityName(str), "ha-entity-name");
            inp.appendField(lbl, "N" + i);
            fld.setValidator((nv) => { lbl.setValue(hooks.entityName(nv)); return nv; });
          }
          if (f.type === "service") {
            this.serviceField_ = name;
            const block = this;
            const dn = (x) => (typeof x === "string" && x.includes(".") ? "· " + (hooks.domainName(x.split(".")[0]) || "") : "");
            const lbl = new Blockly.FieldLabel(dn(str), "ha-entity-name");
            inp.appendField(lbl, "N" + i);
            fld.setValidator((nv) => { lbl.setValue(dn(nv)); if (block.getField("TITLE")) block.setFieldValue(serviceTitle(nv), "TITLE"); return nv; });
          }
        });
        // Skript-Eingaben (fields) im einfachen Modus als anklickbarer Wert.
        if (this.haKind_ === "script" && hooks.simple && !spec.blueprint && hooks.editScriptFields && !this.isInFlyout) {
          const block = this;
          const keys = isObj(raw.fields) ? Object.keys(raw.fields) : [];
          this.appendDummyInput("SFIELDS").appendField("Eingaben").appendField(
            new FieldButton(keys.length ? keys.join(", ") : "keine – hinzufügen …", () => hooks.editScriptFields(block), "ha-chip"), "SFB");
        }
        // Szene: Zustand von jetzt übernehmen (eine Entität bzw. alle).
        if (hooks.captureScene && !this.isInFlyout && (this.haKind_ === "sceneent" || this.haKind_ === "scene")) {
          const block = this;
          this.appendDummyInput("CAP").appendField(new FieldButton(this.haKind_ === "scene" ? "📸 Alle Zustände von jetzt übernehmen" : "📸 Zustand von jetzt übernehmen",
            () => hooks.captureScene(block), "ha-add"), "CAPB");
        }
        if (hooks.blockly && !this.isInFlyout && this.haKind_ === "action" && isObj(raw)) {
          const block = this;
          if (isObj(raw.variables) && hooks.addVariable)
            this.appendDummyInput("ADDVAR").appendField(new FieldButton("＋ Variable", () => hooks.addVariable(block), "ha-add"), "ADDVARB");
        }
        this.listMap_ = [];
        spec.lists.forEach((l, i) => {
          const name = "L" + i;
          const orig = getPath(raw, l.path);
          this.appendStatementInput(name).setCheck(CHECK_LIST[l.kind]).appendField(l.label);
          this.listMap_.push({ name, path: l.path, orig, dict: !!l.dict, single: !l.dict && orig !== undefined && orig !== null && !Array.isArray(orig) });
          if (hooks.addItem && !this.isInFlyout) {
            const block = this;
            this.appendDummyInput("ADD" + i).appendField(
              new FieldButton(ADD_LABEL[l.kind] || "＋ hinzufügen", () => hooks.addItem(block, name, l.kind), "ha-add"), "ADDB" + i);
          }
          // „Wenn … dann“: weitere Zweige („sonst wenn“) – der Baustein wird dann zur Auswahl.
          if (hooks.ifToChoose && !this.isInFlyout && this.haKind_ === "action" && l.path === "then") {
            const block = this;
            this.appendDummyInput("ELIF").appendField(new FieldButton("＋ sonst wenn …", () => hooks.ifToChoose(block), "ha-add"), "ELIFB");
          }
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
    def("script", function () { this.setDeletable(false); });
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
    def("scene", function () { this.setDeletable(false); });
    def("sceneent", function () {
      this.setPreviousStatement(true, CHECK_PREV.sceneent);
      this.setNextStatement(true, CHECK_PREV.sceneent);
    });
  }

  // ---------- Werkzeugkasten ----------
  // Leere Vorgaben weglassen: Felder werden trotzdem angezeigt, aber nur geschrieben, wenn man sie ausfüllt.
  // Diese Schlüssel bestimmen die Blockart und bleiben deshalb auch leer erhalten.
  const KIND_KEYS = new Set(["action", "event", "stop", "scene", "wait_template", "variables", "device_id"]);
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

  function buildToolbox(kind = "root") {
    if (kind === "scene") {
      return {
        kind: "categoryToolbox",
        contents: [{ kind: "category", name: "Szene", colour: String(C.scene), contents: [
          label("Entität in die Lücke ENTITÄTEN ziehen, dann „📸 Zustand von jetzt übernehmen“:"),
          tb("sceneent", { __e: "", __v: "on" }),
          tb("sceneent", { __e: "", __v: { state: "on", brightness: 255 } }),
          tb("sceneent", { __e: "", __v: "off" }),
        ] }],
      };
    }
    const services = hooks.services().map((s) => (Array.isArray(s) ? s[0] : s));
    const has = (s) => services.includes(s);
    const svc = (s, extra = {}) => tb("action", { action: s, target: { entity_id: "" }, ...extra });
    const notifyServices = services.filter((s) => s.startsWith("notify.") && s !== "notify.send_message");


    const btn = (text, callbackKey) => ({ kind: "button", text, callbackKey });
    // Skripte = eigene Funktionen: als Aufruf-Baustein; ihre Eingaben kommen aus dem Dienst-Schema.
    const scriptCat = { kind: "category", name: "Skripte (Funktionen)", colour: String(C.script), contents: [
      btn("＋ Neues Skript anlegen …", "newScript"),
      label("Ein Skript bündelt Schritte, die mehrere Automationen nutzen:"),
      ...hooks.scripts().filter(([id]) => typeof id === "string" && id.startsWith("script.")).map(([id]) => tb("action", { action: id })),
    ] };
    const forKind = (box) => {
      if (kind === "script") box.contents = box.contents.filter((c) => c.colour !== String(C.trigger));
      box.contents.push(scriptCat);
      if (hooks.toolboxSearch) box.contents.unshift({ kind: "search", name: "🔎 Suche", contents: [] });
      return box;
    };

    // Einfach-Modus: wenige, verständliche Bausteine; alles andere über den HA-Dialog.
    if (hooks.simple) {
      return forKind({
        kind: "categoryToolbox",
        contents: [
          { kind: "category", name: "Wenn …", colour: String(C.trigger), contents: [
            btn("＋ Auslöser aus Home Assistant wählen …", "addTrigger"),
            btn("＋ Auslöser nach Typ wählen …", "type_trigger"),
            label("oder einen Baustein in die WENN-Lücke ziehen:"),
            tb("trigger", { trigger: "state", entity_id: "" }),
            tb("trigger", { trigger: "time", at: "07:00:00" }),
            tb("trigger", { trigger: "sun", event: "sunset" }),
          ] },
          { kind: "category", name: "Nur wenn …", colour: String(C.condition), contents: [
            btn("＋ Bedingung aus Home Assistant wählen …", "addCondition"),
            btn("＋ Bedingung nach Typ wählen …", "type_condition"),
            label("oder einen Baustein in die NUR-WENN-Lücke ziehen:"),
            tb("condition", { condition: "state", entity_id: "", state: "" }),
            tb("condition", { condition: "time", after: "08:00:00", before: "22:00:00" }),
            tb("condition", { condition: "or", conditions: [] }),
          ] },
          { kind: "category", name: "Dann …", colour: String(C.action), contents: [
            btn("＋ Aktion aus Home Assistant wählen …", "addAction"),
            btn("＋ Aktion nach Typ wählen …", "type_action"),
            label("oder einen Baustein in die DANN-Lücke ziehen:"),
            svc("light.turn_on"), svc("light.turn_off"),
            tb("action", { action: "persistent_notification.create", data: { title: "", message: "" } }),
            tb("action", { delay: { hours: 0, minutes: 1, seconds: 0 } }),
          ] },
          { kind: "category", name: "Ablauf", colour: String(C.flow), contents: [
            label("Verzweigen und wiederholen:"),
            tb("action", { if: [], then: [], else: [] }),
            tb("action", { choose: [{ conditions: [], sequence: [] }], default: [] }),
            tb("action", { repeat: { count: 2, sequence: [] } }),
          ] },
        ],
      });
    }

    // Wie ioBroker: viele kleine Kategorien. Manche Bausteine stehen an mehreren Stellen.
    const V = HAV.tbBlock;
    const sh = HAV.tbShadow;
    const cat = (name, colour, contents) => ({ kind: "category", name, colour: String(colour), contents });
    const svcCat = (name, list) => {
      const items = list.filter((x) => x.kind !== "block" || !x.extraState.raw.action || !services.length || has(x.extraState.raw.action));
      return items.some((x) => x.kind === "block") ? cat(name, C.action, items) : null;
    };
    const dom = (d) => services.filter((x) => typeof x === "string" && x.startsWith(d + "."));
    const svcsOf = (d, first, extra = {}) => {
      const rest = dom(d).filter((x) => !first.includes(x)).sort();
      return [...first.map((x) => svc(x, extra[x])), ...(rest.length ? [label("weitere"), ...rest.map((x) => svc(x))] : [])];
    };
    const actionCats = [
      cat("Allgemein", C.action, [
        btn("＋ Aktion nach Typ wählen …", "type_action"),
        label("Beliebigen Dienst aufrufen (Dienst im Feld wählen):"),
        tb("action", { action: "", target: { entity_id: "" }, data: {} }),
        tb("action", { scene: "" }),
        tb("action", { event: "", event_data: {} }),
        ...(hooks.blockly ? [label("Gerät"), tb("action", { device_id: "" })] : []),
      ]),
      svcCat("Licht", svcsOf("light", ["light.turn_on", "light.turn_off", "light.toggle"])),
      svcCat("Schalter & Steckdosen", [...svcsOf("switch", ["switch.turn_on", "switch.turn_off", "switch.toggle"]),
        label("Alles, was sich schalten lässt"), svc("homeassistant.turn_on"), svc("homeassistant.turn_off"), svc("homeassistant.toggle")]),
      svcCat("Heizung & Klima", [...svcsOf("climate", ["climate.set_temperature", "climate.set_hvac_mode"],
        { "climate.set_temperature": { data: { temperature: 20 } }, "climate.set_hvac_mode": { data: { hvac_mode: "heat" } } }),
        ...(dom("fan").length ? [label("Ventilator"), ...dom("fan").sort().map((x) => svc(x))] : [])]),
      svcCat("Rollläden & Tore", svcsOf("cover", ["cover.open_cover", "cover.close_cover", "cover.stop_cover"])),
      svcCat("Schlösser", svcsOf("lock", ["lock.lock", "lock.unlock"])),
      svcCat("Medien", svcsOf("media_player", ["media_player.media_play", "media_player.media_pause", "media_player.volume_set"],
        { "media_player.volume_set": { data: { volume_level: 0.3 } } })),
      svcCat("Benachrichtigen", [
        ...notifyServices.map((x) => tb("action", { action: x, data: { title: "", message: "" } })),
        tb("action", { action: "persistent_notification.create", data: { title: "", message: "" } }),
        ...(has("tts.speak") ? [tb("action", { action: "tts.speak", target: { entity_id: "" }, data: { media_player_entity_id: "", message: "" } })] : []),
        ...(has("logbook.log") ? [tb("action", { action: "logbook.log", data: { name: "", message: "" } })] : []),
      ]),
      svcCat("Helfer", [
        svc("input_boolean.turn_on"), svc("input_boolean.turn_off"), svc("input_boolean.toggle"),
        svc("input_number.set_value", { data: { value: 0 } }),
        svc("input_select.select_option", { data: { option: "" } }),
        svc("input_text.set_value", { data: { value: "" } }),
        svc("input_button.press"),
        svc("counter.increment"), svc("counter.reset"),
        svc("timer.start"), svc("timer.cancel"),
      ]),
      svcCat("Automationen & Skripte", [svc("automation.trigger"), svc("automation.turn_on"), svc("automation.turn_off"), svc("script.turn_on")]),
    ].filter(Boolean);

    return forKind({
      kind: "categoryToolbox",
      contents: [
        cat("Auslöser", C.trigger, [
          btn("＋ Auslöser nach Typ wählen …", "type_trigger"),
          label("Zustand"),
          tb("trigger", { trigger: "state", entity_id: "", to: "" }),
          tb("trigger", { trigger: "numeric_state", entity_id: "", above: 20 }),
          label("Zeit"),
          tb("trigger", { trigger: "time", at: "07:00:00" }),
          tb("trigger", { trigger: "time_pattern", minutes: "/5" }),
          tb("trigger", { trigger: "sun", event: "sunset", offset: "00:00:00" }),
          tb("trigger", { trigger: "calendar", entity_id: "", event: "start", offset: "0:0:0" }),
          label("Ort"),
          tb("trigger", { trigger: "zone", entity_id: "", zone: "zone.home", event: "enter" }),
          label("Ereignisse"),
          tb("trigger", { trigger: "homeassistant", event: "start" }),
          tb("trigger", { trigger: "event", event_type: "" }),
          tb("trigger", { trigger: "mqtt", topic: "" }),
          tb("trigger", { trigger: "webhook", webhook_id: "", local_only: true }),
          tb("trigger", { trigger: "tag", tag_id: "" }),
          tb("trigger", { trigger: "conversation", command: "" }),
          tb("trigger", { trigger: "persistent_notification", notification_id: "" }),
          tb("trigger", { trigger: "template", value_template: "" }),
          ...(hooks.blockly ? [label("Gerät"), tb("trigger", { trigger: "device", device_id: "" })] : []),
        ]),
        cat("Bedingungen", C.condition, [
          btn("＋ Bedingung nach Typ wählen …", "type_condition"),
          label("Zustand"),
          tb("condition", { condition: "state", entity_id: "", state: "" }),
          tb("condition", { condition: "numeric_state", entity_id: "", below: 20 }),
          tb("condition", { condition: "trigger", id: "" }),
          label("Zeit und Ort"),
          tb("condition", { condition: "time", after: "08:00:00", before: "22:00:00" }),
          tb("condition", { condition: "sun", after: "sunset" }),
          tb("condition", { condition: "zone", entity_id: "", zone: "zone.home" }),
          label("Verknüpfen"),
          tb("condition", { condition: "and", conditions: [] }),
          tb("condition", { condition: "or", conditions: [] }),
          tb("condition", { condition: "not", conditions: [] }),
          label("Eigene Logik (Bausteine aus „Logik“ in die Lücke stecken)"),
          tb("condition", { condition: "template", value_template: "" }),
          ...(hooks.blockly ? [label("Gerät"), tb("condition", { condition: "device", device_id: "" })] : []),
        ]),
        { kind: "category", name: "Aktionen", colour: String(C.action), contents: [...actionCats, ...(services.length ? [allServicesCat()] : [])] },
        cat("Logik", C.condition, [
          label("Verzweigen"),
          tb("action", { if: [], then: [], else: [] }),
          tb("action", { choose: [{ conditions: [], sequence: [] }], default: [] }),
          tb("option", { conditions: [], sequence: [] }),
          label("Vergleichen und verknüpfen (in Lücken von Bedingungen und Feldern stecken)"),
          V("cmp", { op: "==" }, { A: sh("state"), B: sh("txt", { s: "on" }) }),
          V("cmp", { op: ">" }, { A: sh("statenum"), B: sh("num", { n: 20 }) }),
          V("logic", { op: "and" }), V("logic", { op: "or" }), V("not"), V("isstate"), V("bool"), V("ifelse"),
        ]),
        cat("Schleifen", C.flow, [
          tb("action", { repeat: { count: 2, sequence: [] } }),
          tb("action", { repeat: { while: [], sequence: [] } }),
          tb("action", { repeat: { until: [], sequence: [] } }),
          tb("action", { repeat: { for_each: [], sequence: [] } }),
          label("Wert in der Schleife"),
          V("var", { v: "repeat.index" }), V("var", { v: "repeat.item" }),
        ]),
        cat("Zeit", C.flow, [
          label("Warten"),
          tb("action", { delay: { hours: 0, minutes: 1, seconds: 0 } }),
          tb("action", { wait_template: "", timeout: { minutes: 5 }, continue_on_timeout: true }),
          tb("action", { wait_for_trigger: [], timeout: { minutes: 5 } }),
          label("Zeitpunkt als Auslöser"),
          tb("trigger", { trigger: "time", at: "07:00:00" }),
          tb("trigger", { trigger: "time_pattern", minutes: "/5" }),
          tb("trigger", { trigger: "sun", event: "sunset", offset: "00:00:00" }),
          label("Nur zu bestimmten Zeiten"),
          tb("condition", { condition: "time", after: "08:00:00", before: "22:00:00" }),
          tb("condition", { condition: "time", weekday: ["sat", "sun"] }),
          tb("condition", { condition: "sun", after: "sunset" }),
          label("Aktuelle Zeit als Wert"),
          V("now"), V("now", { w: "now().hour" }), V("now", { w: "now().weekday()" }),
        ]),
        cat("Mathematik", 230, [
          V("num"),
          V("math", { op: "+" }, { A: sh("num", { n: 1 }), B: sh("num", { n: 1 }) }),
          V("math", { op: "*" }, { A: sh("statenum"), B: sh("num", { n: 2 }) }),
          V("round", { n: 1 }), V("tonum"), V("statenum"),
          V("cmp", { op: ">" }, { A: sh("statenum"), B: sh("num", { n: 20 }) }),
        ]),
        cat("Text", 160, [
          V("txt"),
          V("join", null, { A: sh("txt", { s: "Temperatur: " }), B: sh("state") }),
          V("totext"),
          label("Text verschicken"),
          tb("action", { action: "persistent_notification.create", data: { title: "", message: "" } }),
          ...notifyServices.slice(0, 3).map((x) => tb("action", { action: x, data: { message: "" } })),
        ]),
        cat("Werte aus HA", 30, [
          V("state"), V("statenum"), V("attr"), V("isstate"),
          label("Was die Automation ausgelöst hat"),
          V("trig"), V("trig", { w: "trigger.to_state.state" }), V("trig", { w: "trigger.entity_id" }),
        ]),
        cat("Variablen", 330, [
          tb("action", { variables: { name: "wert" } }),
          V("var"),
          label("Antwort eines Dienstes: im Dienst-Baustein „Antwort in Variable“ eintragen."),
        ]),
        cat("Ablauf", C.flow, [
          tb("action", { parallel: [] }),
          tb("action", { sequence: [] }),
          tb("action", { stop: "" }),
          tb("action", { stop: "Fehler", error: true }),
        ]),
        ...(hooks.blockly && !hooks.expert ? [] : [cat("Roh-JSON", C.generic, [
          label("Für alles ohne eigenen Block – rechts im JSON-Feld bearbeiten"),
          tb("action", {}),
        ])]),
      ],
    });
  }

  // Blockly-Modus: alle Dienste aus HA, nach Bereich (Domain) sortiert.
  function allServicesCat() {
    const byDom = new Map();
    for (const s of hooks.services()) {
      const id = Array.isArray(s) ? s[0] : s;
      if (typeof id !== "string" || !id.includes(".")) continue;
      const d = id.split(".")[0];
      if (!byDom.has(d)) byDom.set(d, []);
      byDom.get(d).push(id);
    }
    const doms = [...byDom.keys()].sort((a, b) => String(hooks.domainName(a) || a).localeCompare(String(hooks.domainName(b) || b), "de"));
    return {
      kind: "category", name: "Alle Dienste", colour: String(C.action),
      contents: doms.length ? doms.map((d) => ({
        kind: "category", name: `${hooks.domainName(d) || d} (${byDom.get(d).length})`, colour: String(C.action),
        contents: byDom.get(d).map((id) => tb("action", { action: id })),
      })) : [label("Dienste werden geladen …")],
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

  // Vorlagen für typische Automationen (leere Felder werden im HA-Dialog ergänzt).
  const TEMPLATES = [
    { name: "Leere Automation", cfg: NEW_AUTOMATION },
    { name: "Licht bei Bewegung", cfg: () => ({
      alias: "Licht bei Bewegung", description: "Licht an bei Bewegung, nach 2 Minuten ohne Bewegung wieder aus.",
      triggers: [
        { trigger: "state", entity_id: "", to: "on", id: "bewegung" },
        { trigger: "state", entity_id: "", to: "off", for: { minutes: 2 }, id: "ruhe" },
      ],
      conditions: [],
      actions: [{ choose: [
        { conditions: [{ condition: "trigger", id: "bewegung" }], sequence: [{ action: "light.turn_on", target: { entity_id: "" } }] },
        { conditions: [{ condition: "trigger", id: "ruhe" }], sequence: [{ action: "light.turn_off", target: { entity_id: "" } }] },
      ] }],
      mode: "restart",
    }) },
    { name: "Meldung, wenn Fenster lange offen", cfg: () => ({
      alias: "Fenster lange offen", description: "Meldet, wenn ein Fenster 15 Minuten offen ist.",
      triggers: [{ trigger: "state", entity_id: "", to: "on", for: { minutes: 15 } }],
      conditions: [],
      actions: [{ action: "persistent_notification.create", data: { title: "Fenster offen", message: "Das Fenster ist seit 15 Minuten offen." } }],
      mode: "single",
    }) },
    { name: "Jeden Tag zu einer Uhrzeit", cfg: () => ({
      alias: "Täglich um 7 Uhr", description: "",
      triggers: [{ trigger: "time", at: "07:00:00" }], conditions: [], actions: [], mode: "single",
    }) },
    { name: "Licht bei Sonnenuntergang", cfg: () => ({
      alias: "Licht bei Sonnenuntergang", description: "",
      triggers: [{ trigger: "sun", event: "sunset" }], conditions: [],
      actions: [{ action: "light.turn_on", target: { entity_id: "" } }], mode: "single",
    }) },
  ];


  // ---------- Pfade (wie in HA-Traces: "action/0/choose/1/sequence/0") ----------
  const ROOT_SEG = { triggers: "trigger", trigger: "trigger", conditions: "condition", condition: "condition", actions: "action", action: "action", sequence: "sequence", entities: "entities" };
  const segOf = (kind, listPath) => (ROOTS.has(kind) ? ROOT_SEG[listPath] || listPath : listPath.replace(/\./g, "/"));
  const join = (base, seg, i) => (base ? `${base}/${seg}/${i}` : `${seg}/${i}`);

  // Ruft fn(item, kind, path) für jedes Element einer Konfiguration auf (gleiche Struktur wie die Blöcke).
  function walkConfig(cfg, kind, fn) {
    const rec = (item, k, path, parents) => {
      fn(item, k, path, parents);
      if (!isObj(item)) return;
      const spec = specFor(k, item);
      for (const l of spec.lists) {
        const v = getPath(item, l.path);
        if (v === undefined || v === null) continue;
        const seg = segOf(k, l.path);
        listArr(l, v).forEach((el, i) => rec(el, classify(l.kind, el), join(path, seg, i), [...parents, item]));
      }
    };
    rec(cfg, kind, "", []);
  }

  // Ordnet jedem Block seinen Pfad zu. Ergebnis: Map(pfad -> block); "" ist die Wurzel.
  function collectPaths(rootBlock) {
    const map = new Map();
    const walk = (b, base) => {
      b.habPath_ = base;
      map.set(base, b);
      for (const l of b.listMap_ || []) {
        const seg = segOf(b.haKind_, l.path);
        let i = 0;
        for (let c = b.getInputTargetBlock(l.name); c; c = c.getNextBlock(), i++) walk(c, join(base, seg, i));
      }
    };
    if (rootBlock) walk(rootBlock, "");
    return map;
  }

  const triggersOf = (cfg) => (isObj(cfg) ? [].concat(cfg.triggers !== undefined ? cfg.triggers : cfg.trigger !== undefined ? cfg.trigger : []) : []);
  function triggerIds(cfg) {
    const out = [];
    for (const t of triggersOf(cfg)) if (isObj(t) && isPrim(t.id) && t.id !== "" && !out.includes(String(t.id))) out.push(String(t.id));
    return out;
  }

  // Zeitraum in Sekunden (null = unbekannt, z. B. Template).
  function durationSeconds(d) {
    if (typeof d === "number") return d;
    if (isObj(d)) {
      const f = { days: 86400, hours: 3600, minutes: 60, seconds: 1, milliseconds: 0.001 };
      let sum = 0;
      for (const [k, v] of Object.entries(d)) {
        const n = Number(v);
        if (!(k in f) || !isFinite(n)) return null;
        sum += n * f[k];
      }
      return sum;
    }
    if (typeof d === "string") {
      const m = /^(-)?(?:(\d+):)?(\d+):(\d+)(?:\.\d+)?$/.exec(d.trim());
      if (m) return (m[2] ? +m[2] * 3600 + +m[3] * 60 + +m[4] : +m[3] * 60 + +m[4]);
      if (/^\d+(\.\d+)?$/.test(d.trim())) return Number(d);
    }
    return null;
  }
  const fmtDur = (sec) => (sec >= 3600 ? `${Math.round((sec / 3600) * 10) / 10} Std` : sec >= 60 ? `${Math.round(sec / 60)} Min` : `${sec} Sek`);

  /* Prüfregeln: typische Stolperfallen als Hinweis am Block.
   * Ergebnis: [{ path, level: "warn" | "info", msg }] */
  const LONG_WAIT = 3600;
  function lint(cfg, kind = "root") {
    const out = [];
    if (!isObj(cfg) || isObj(cfg.use_blueprint)) return out;
    const add = (path, level, msg, fix) => out.push(fix ? { path, level, msg, fix } : { path, level, msg });
    const ids = triggerIds(cfg);
    const mode = cfg.mode || "single";
    if (kind === "root" && !triggersOf(cfg).length) add("", "warn", "Diese Automation hat keinen Auslöser – sie startet nie von selbst.");
    let singleWarned = false;
    walkConfig(cfg, kind, (item, k, path) => {
      if (!isObj(item) || !path) return;
      if (k === "condition" && item.condition === "trigger" && kind === "root") {
        const missing = [].concat(item.id === undefined ? [] : item.id).filter((x) => isPrim(x) && x !== "" && !ids.includes(String(x)));
        if (missing.length) {
          const fixes = missing.map((m) => [m, closest(String(m), ids)]).filter(([, c]) => c);
          const fix = fixes.length ? {
            label: fixes.map(([m, c]) => `„${m}“ → „${c}“`).join(", ") + " ändern",
            apply: (c) => atPath(c, kind, path, (it) => { it.id = Array.isArray(it.id) ? it.id.map((x) => (fixes.find(([m]) => m === x) || [0, x])[1]) : (fixes[0] || [0, it.id])[1]; }),
          } : null;
          add(path, "warn", `Trigger-ID „${missing.join("“, „")}“ gibt es bei den Auslösern dieser Automation nicht.`, fix);
        }
      }
      const waits = [];
      if (k === "action") {
        if ("delay" in item) waits.push(["delay", "Warten"]);
        if ("wait_template" in item || "wait_for_trigger" in item) waits.push(["timeout", "Warten (höchstens)"]);
      }
      if (k === "trigger" && item.for !== undefined) waits.push(["for", "„für“-Dauer"]);
      if (k === "condition" && item.for !== undefined) waits.push(["for", "„seit“-Dauer"]);
      for (const [key, label] of waits) {
        const sec = durationSeconds(item[key]);
        if (sec !== null && sec >= LONG_WAIT)
          add(path, "info", `${label} von ${fmtDur(sec)}: übersteht keinen Neustart von Home Assistant. Besser einen Timer-Helfer (timer.*) verwenden.`);
      }
      if (kind === "root" && mode === "single" && !singleWarned && k === "action" &&
          ("delay" in item || "wait_template" in item || "wait_for_trigger" in item)) {
        const sec = "delay" in item ? durationSeconds(item.delay) : null;
        if (sec === null || sec >= 5) {
          singleWarned = true;
          add(path, "info", "Modus „single“: Solange hier gewartet wird, werden neue Auslösungen ignoriert. Für Bewegungslicht o. Ä. passt meist „restart“.",
            { label: "Modus auf „restart“ setzen", apply: (c) => { const n = clone(c); n.mode = "restart"; delete n.max; return n; } });
        }
      }
      if (k === "action" && "if" in item && [].concat(item.then || []).length === 0 && [].concat(item.else || []).length === 0)
        add(path, "info", "„Wenn“ ohne Aktionen in „dann“ und „sonst“ hat keine Wirkung.");
    });
    // Entitäten, die es in Home Assistant nicht (mehr) gibt – häufigster echter Fehler.
    const seen = new Set();
    for (const r of references(cfg, kind)) {
      const key = r.path + "|" + r.entity;
      if (seen.has(key) || hooks.entityExists(r.entity) !== false) continue;
      seen.add(key);
      const dom = r.entity.split(".")[0];
      const cand = closest(r.entity.slice(dom.length + 1), hooks.entityIds().filter((e) => e.startsWith(dom + ".")).map((e) => e.slice(dom.length + 1)), 0.34);
      const repl = cand ? `${dom}.${cand}` : null;
      add(r.path, "warn", `Entität „${r.entity}“ gibt es in Home Assistant nicht (mehr) oder sie ist deaktiviert.`,
        repl ? { label: `Durch „${repl}“ ersetzen (überall)`, apply: (c) => replaceEntity(c, r.entity, repl) } : null);
    }
    return out;
  }

  /* ---------- Trockenlauf: was würde jetzt passieren? ----------
   * Geht die Automation durch, ohne etwas auszuführen. Bedingungen prüft test(cond, vars)
   * (in HA: test_condition) – true/false oder null (nicht prüfbar, dann als erfüllt angenommen).
   * trigger: { index, id, vars } – welcher Auslöser angenommen wird.
   * Ergebnis: { steps: { pfad: [ {result:{result}} | {} | {unknown:true} ] }, log: [] } – wie ein Trace. */
  async function dryRun(cfg, kind, test, trigger = {}) {
    const steps = {};
    const log = [];
    const vars = trigger.vars || {};
    const mark = (p, v) => (steps[p] = steps[p] || []).push(v);
    const evalCond = async (c, p) => {
      if (isObj(c) && c.enabled === false) return true;
      let r;
      if (isObj(c) && c.condition === "trigger") r = [].concat(c.id === undefined ? [] : c.id).map(String).includes(String(trigger.id));
      else { try { r = await test(c, vars); } catch (e) { r = null; } }
      mark(p, r === null || r === undefined ? { unknown: true } : { result: { result: !!r } });
      return r !== false;
    };
    const allConds = async (list, base, seg) => {
      const arr = [].concat(list === undefined || list === null ? [] : list);
      for (let i = 0; i < arr.length; i++) if (!(await evalCond(arr[i], join(base, seg, i)))) return false;
      return true;
    };
    const runSeq = async (list, base, seg) => {
      const arr = [].concat(list === undefined || list === null ? [] : list);
      for (let i = 0; i < arr.length; i++) if (!(await runStep(arr[i], join(base, seg, i)))) return false;
      return true;
    };
    async function runStep(it, p) {
      if (isObj(it) && it.enabled === false) return true;
      if (typeof it === "string" || (isObj(it) && "condition" in it)) return evalCond(it, p);
      if (!isObj(it)) { mark(p, {}); return true; }
      if ("if" in it) {
        mark(p, {});
        if (await allConds(it.if, p, "if")) return runSeq(it.then, p, "then");
        return it.else !== undefined ? runSeq(it.else, p, "else") : true;
      }
      if ("choose" in it) {
        mark(p, {});
        const opts = [].concat(it.choose || []);
        for (let j = 0; j < opts.length; j++) {
          const op = isObj(opts[j]) ? opts[j] : {};
          const opPath = join(p, "choose", j);
          if (op.enabled === false) continue;
          if (await allConds(op.conditions, opPath, "conditions")) { mark(opPath, {}); return runSeq(op.sequence, opPath, "sequence"); }
        }
        return it.default !== undefined ? runSeq(it.default, p, "default") : true;
      }
      if ("repeat" in it) {
        mark(p, {});
        const r = isObj(it.repeat) ? it.repeat : {};
        if ("while" in r && !(await allConds(r.while, p, "repeat/while"))) return true;
        log.push(`${p}: Wiederholung – nur ein Durchlauf betrachtet.`);
        return runSeq(r.sequence, p, "repeat/sequence");
      }
      if ("parallel" in it) {
        mark(p, {});
        const arr = [].concat(it.parallel || []);
        for (let j = 0; j < arr.length; j++) await runStep(arr[j], join(p, "parallel", j));
        return true;
      }
      if ("sequence" in it) { mark(p, {}); return runSeq(it.sequence, p, "sequence"); }
      if ("stop" in it) { mark(p, {}); log.push(`${p}: Stopp${it.stop ? " – " + it.stop : ""}.`); return false; }
      if ("delay" in it || "wait_template" in it || "wait_for_trigger" in it) log.push(`${p}: würde hier warten.`);
      mark(p, {});
      return true;
    }
    if (!isObj(cfg)) return { steps, log };
    if (kind === "script") { await runSeq(cfg.sequence, "", "sequence"); return { steps, log }; }
    const ti = Number.isInteger(trigger.index) ? trigger.index : 0;
    if (triggersOf(cfg).length) mark(`trigger/${ti}`, {});
    const condKey = "conditions" in cfg ? "conditions" : "condition";
    if (!(await allConds(cfg[condKey], "", "condition"))) { log.push("Die Bedingungen unter NUR WENN sind jetzt nicht erfüllt – es würde nichts passieren."); return { steps, log }; }
    await runSeq("actions" in cfg ? cfg.actions : cfg.action, "", "action");
    return { steps, log };
  }

  // Ähnlichster Name (Tippfehler), sonst null. maxRel: erlaubter Anteil an Änderungen.
  function closest(word, list, maxRel = 0.4) {
    let best = null, bestD = Infinity;
    for (const c of list) {
      if (c === word) continue;
      const d = levenshtein(word.toLowerCase(), String(c).toLowerCase());
      if (d < bestD) { bestD = d; best = c; }
    }
    return best !== null && bestD <= Math.max(2, Math.round(word.length * maxRel)) ? best : null;
  }
  function levenshtein(a, b) {
    if (Math.abs(a.length - b.length) > 12) return 99;
    const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
    for (let i = 1; i <= a.length; i++) {
      let diag = prev[0];
      prev[0] = i;
      for (let j = 1; j <= b.length; j++) {
        const tmp = prev[j];
        prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
        diag = tmp;
      }
    }
    return prev[b.length];
  }
  // Element an einem Pfad in einer Kopie ändern.
  function atPath(cfg, kind, path, fn) {
    const c = clone(cfg);
    walkConfig(c, kind, (item, k, p) => { if (p === path && isObj(item)) fn(item); });
    return c;
  }
  // Entität überall ersetzen: als Wert und in Templates.
  function replaceEntity(cfg, from, to) {
    const re = new RegExp(`(?<![\\w.])${from.replace(/\./g, "\\.")}(?![\\w])`, "g");
    const map = (v) => {
      if (typeof v === "string") return v === from ? to : v.includes("{") ? v.replace(re, to) : v;
      if (Array.isArray(v)) return v.map(map);
      if (isObj(v)) { const o = {}; for (const [k, x] of Object.entries(v)) o[k] = map(x); return o; }
      return v;
    };
    // Wert-Bausteine: Baum mit ersetzter Entität neu erzeugen (sonst würde der Kommentar ungültig).
    const mapTpl = (v) => {
      if (typeof v === "string") {
        const t = HAV.decode(v);
        if (t) {
          const walk = (n) => { if (!n) return n; const m = clone(n); if (m.f && m.f.e === from) m.f.e = to; if (m.a) m.a = m.a.map(walk); return m; };
          return HAV.compile(walk(t));
        }
        return map(v);
      }
      if (Array.isArray(v)) return v.map(mapTpl);
      if (isObj(v)) { const o = {}; for (const [k, x] of Object.entries(v)) o[k] = mapTpl(x); return o; }
      return v;
    };
    return mapTpl(cfg);
  }

  /* Querverweise: welche Entitäten eine Konfiguration auslöst, prüft oder schaltet.
   * Ergebnis: [{ entity, role: "trigger" | "condition" | "action" | "call" | "blueprint", path }] */
  const ENTITY_RE = /^[a-z_]+\.[a-z0-9_]+$/;
  const TPL_RE = /(?:states|is_state|state_attr|is_state_attr|has_value|expand)\(\s*['"]([a-z_]+\.[a-z0-9_]+)['"]|states\.([a-z_]+\.[a-z0-9_]+)/g;
  function references(cfg, kind = "root") {
    const out = [];
    const seen = new Set();
    const add = (entity, role, path) => {
      if (typeof entity !== "string" || !ENTITY_RE.test(entity)) return;
      const key = `${entity}|${role}|${path}`;
      if (seen.has(key)) return;
      seen.add(key);
      out.push({ entity, role, path });
    };
    const fromTemplates = (v, role, path) => {
      if (typeof v === "string") { if (v.includes("{")) for (const m of v.matchAll(TPL_RE)) add(m[1] || m[2], role, path); }
      else if (Array.isArray(v)) v.forEach((x) => fromTemplates(x, role, path));
      else if (isObj(v)) Object.values(v).forEach((x) => fromTemplates(x, role, path));
    };
    if (!isObj(cfg)) return out;
    if (isObj(cfg.use_blueprint)) {
      const scan = (v) => {
        if (typeof v === "string") add(v, "blueprint", "");
        else if (Array.isArray(v)) v.forEach(scan);
        else if (isObj(v)) Object.values(v).forEach(scan);
      };
      scan(cfg.use_blueprint.input);
      return out;
    }
    walkConfig(cfg, kind, (item, k, path) => {
      if (!isObj(item)) { if (typeof item === "string") fromTemplates(item, k, path); return; }
      if (!path && ROOTS.has(k)) return;
      if (k === "option") return;
      if (k === "sceneent") { add(item.__e, "action", path); return; }
      const role = k === "trigger" ? "trigger" : k === "condition" ? "condition" : "action";
      const ents = [];
      if (item.entity_id !== undefined) ents.push(...[].concat(item.entity_id));
      if (isObj(item.target) && item.target.entity_id !== undefined) ents.push(...[].concat(item.target.entity_id));
      if (typeof item.zone === "string") ents.push(item.zone);
      if (typeof item.scene === "string") ents.push(item.scene);
      for (const key of ["above", "below", "after", "before"]) if (typeof item[key] === "string" && ENTITY_RE.test(item[key]) && !/^(sun|sunrise|sunset)$/.test(item[key])) ents.push(item[key]);
      ents.forEach((e) => add(e, role, path));
      const svc = item.action !== undefined ? item.action : item.service;
      if (k === "action" && typeof svc === "string" && /^script\.[a-z0-9_]+$/.test(svc) && !/^script\.(turn_on|turn_off|toggle|reload)$/.test(svc)) add(svc, "call", path);
      // Templates nur im eigenen Element durchsuchen, nicht in verschachtelten Listen.
      const own = {};
      for (const [key, v] of Object.entries(item)) if (!specFor(k, item).lists.some((l) => l.path.split(".")[0] === key)) own[key] = v;
      fromTemplates(own, role, path);
    });
    return out;
  }

  // Findet Stellen, an denen noch eine Auswahl fehlt (für Warnhinweise am Block).
  function missingInfo(item) {
    if (!isObj(item)) return null;
    if ("__e" in item && !item.__e) return "Bitte noch eine Entität auswählen";
    const empty = (v) => v === "" || (Array.isArray(v) && v.length === 0);
    if ((item.trigger === "device" || item.platform === "device" || item.condition === "device" || "device_id" in item) &&
        !("action" in item) && (empty(item.device_id) || item.device_id === undefined)) return "Bitte noch ein Gerät auswählen";
    if ((item.trigger === "device" || item.platform === "device" || item.condition === "device" || ("device_id" in item && !("action" in item))) && !item.type)
      return "Bitte noch auswählen, was das Gerät tun / melden soll";
    if ("entity_id" in item && empty(item.entity_id)) return "Bitte noch eine Entität auswählen";
    if (isObj(item.target) && "entity_id" in item.target && empty(item.target.entity_id) &&
        !item.target.area_id && !item.target.device_id && !item.target.floor_id && !item.target.label_id) return "Bitte noch ein Ziel auswählen";
    if ("action" in item && item.action === "") return "Bitte noch eine Aktion auswählen";
    if ("state" in item && item.condition === "state" && empty(item.state)) return "Bitte noch einen Zustand auswählen";
    return null;
  }

  // ---------- YAML-Ansicht (nur zum Lesen) ----------
  const YAML_PLAIN = /^[A-Za-z_À-ɏ][A-Za-z0-9_ .\-\/À-ɏ]*$/;
  const YAML_RESERVED = /^(true|false|yes|no|on|off|null|~)$/i;
  const INPUT_RE = /^@@input:([^@]+)@@$/;
  const inputPlaceholder = (name) => `@@input:${name}@@`;
  function yScalar(v) {
    if (v === null || v === undefined) return "null";
    if (typeof v === "string" && INPUT_RE.test(v)) return "!input " + INPUT_RE.exec(v)[1];
    if (typeof v === "number" || typeof v === "boolean") return String(v);
    const s = String(v);
    if (s === "") return '""';
    if (YAML_PLAIN.test(s) && !YAML_RESERVED.test(s) && !/\s$/.test(s) && !/: /.test(s)) return s;
    return JSON.stringify(s);
  }
  function toYaml(v, ind = "") {
    if (Array.isArray(v)) {
      if (!v.length) return "[]";
      return v.map((x) => {
        if (isObj(x) && Object.keys(x).length) {
          const inner = toYaml(x, ind + "  ");
          return `${ind}- ${inner.slice(ind.length + 2)}`;
        }
        if (Array.isArray(x) && x.length) return `${ind}-\n${toYaml(x, ind + "  ")}`;
        return `${ind}- ${isObj(x) ? "{}" : yScalar(x)}`;
      }).join("\n");
    }
    if (isObj(v)) {
      const keys = Object.keys(v);
      if (!keys.length) return "{}";
      return keys.map((k) => {
        const x = v[k];
        const key = yScalar(k);
        if (isObj(x) && Object.keys(x).length) return `${ind}${key}:\n${toYaml(x, ind + "  ")}`;
        if (Array.isArray(x) && x.length) return `${ind}${key}:\n${toYaml(x, ind + "  ")}`;
        if (typeof x === "string" && x.includes("\n")) return `${ind}${key}: |-\n${x.split("\n").map((l) => ind + "  " + l).join("\n")}`;
        return `${ind}${key}: ${isObj(x) ? "{}" : Array.isArray(x) ? "[]" : yScalar(x)}`;
      }).join("\n");
    }
    return ind + yScalar(v);
  }

  /* ---------- Schritte als Skript auslagern ----------
   * Ein Skript sieht die Variablen der Automation nicht (trigger, repeat, wait, eigene
   * Variablen). Deshalb: genutzte Werte als Eingaben (fields) anlegen, beim Aufruf
   * übergeben und im Skript auf die Eingaben umschreiben.
   *   items: die ausgelagerten Schritte; known: Variablennamen der Automation.
   * Ergebnis: { fields, data, sequence, notes } */
  const CTX_ROOTS = ["trigger", "repeat", "wait", "this"];
  const TPL_SPLIT = /(\{\{[\s\S]*?\}\}|\{%[\s\S]*?%\})/;
  const stripStrings = (t) => t.replace(/'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*"/g, "''");
  const dottedRe = () => /(?<![\w.])(trigger|repeat|wait|this)((?:\.[A-Za-z_]\w*)+)/g;
  const fieldNameOf = (expr) => expr.replace(/\./g, "_");
  function deepStrings(v, fn) {
    if (typeof v === "string") fn(v);
    else if (Array.isArray(v)) v.forEach((x) => deepStrings(x, fn));
    else if (isObj(v)) Object.values(v).forEach((x) => deepStrings(x, fn));
  }
  function deepMap(v, fn) {
    if (typeof v === "string") return fn(v);
    if (Array.isArray(v)) return v.map((x) => deepMap(x, fn));
    if (isObj(v)) { const o = {}; for (const [k, x] of Object.entries(v)) o[k] = deepMap(x, fn); return o; }
    return v;
  }
  function deepWalk(v, fn) {
    if (Array.isArray(v)) v.forEach((x) => deepWalk(x, fn));
    else if (isObj(v)) { fn(v); Object.values(v).forEach((x) => deepWalk(x, fn)); }
  }
  // Variablen-Bezüge in einem Template: { dotted: Set("trigger.to_state.state"), plain: Set("helligkeit"), bare: Set("trigger") }
  function templateRefs(str, known) {
    const out = { dotted: new Set(), plain: new Set(), bare: new Set() };
    for (const part of String(str).split(TPL_SPLIT)) {
      if (!TPL_SPLIT.test(part)) continue;
      const code = stripStrings(part.replace(/\{#[\s\S]*?#\}/g, ""));
      for (const m of code.matchAll(dottedRe())) out.dotted.add(m[1] + m[2]);
      for (const m of code.matchAll(/(?<![\w.])([A-Za-z_]\w*)(?![\w(])/g)) {
        const n = m[1];
        if (CTX_ROOTS.includes(n)) { if (!new RegExp(`(?<![\\w.])${n}\\.`).test(code)) out.bare.add(n); continue; }
        if (known.has(n)) out.plain.add(n);
      }
    }
    return out;
  }
  function planExtract(items, known = []) {
    const knownSet = new Set(known);
    // Was die Schritte selbst festlegen, muss nicht übergeben werden.
    const defined = new Set();
    let hasRepeat = false, hasWait = false;
    deepWalk(items, (o) => {
      if (isObj(o.variables)) Object.keys(o.variables).forEach((k) => defined.add(k));
      if (typeof o.response_variable === "string") defined.add(o.response_variable);
      if ("repeat" in o) hasRepeat = true;
      if ("wait_for_trigger" in o || "wait_template" in o) hasWait = true;
    });
    const internal = (expr) => (expr.startsWith("repeat.") && hasRepeat) || (expr.startsWith("wait.") && hasWait);
    const dotted = new Set(), plain = new Set(), bare = new Set();
    let triggerCond = false;
    deepWalk(items, (o) => { if (o.condition === "trigger") { triggerCond = true; dotted.add("trigger.id"); } });
    deepStrings(items, (str) => {
      const tree = HAV.decode(str);
      const r = templateRefs(str, knownSet);
      r.dotted.forEach((x) => dotted.add(x));
      r.plain.forEach((x) => plain.add(x));
      r.bare.forEach((x) => bare.add(x));
      if (tree) (function walk(t) {
        if (!t) return;
        if (t.k === "trig" && t.f) dotted.add(t.f.w);
        if (t.k === "var" && t.f && /^(trigger|repeat|wait|this)\./.test(t.f.v)) dotted.add(t.f.v);
        (t.a || []).forEach(walk);
      })(tree);
    });
    const pass = [...dotted].filter((d) => !internal(d)).sort((a, b) => b.length - a.length);
    const plainPass = [...plain].filter((n) => !defined.has(n));
    const map = {};
    for (const d of pass) map[d] = fieldNameOf(d);
    // Umschreiben: Templates (auch Wert-Bausteine) und „Ausgelöst durch ID“.
    const rewriteText = (str) => str.split(TPL_SPLIT).map((part) => {
      if (!TPL_SPLIT.test(part)) return part;
      let out = part;
      for (const d of pass) out = out.replace(new RegExp(`(?<![\\w.])${d.replace(/\./g, "\\.")}(?![\\w])`, "g"), map[d]);
      return out;
    }).join("");
    const rewriteTree = (t) => {
      if (!t) return t;
      const n = clone(t);
      if (n.k === "trig" && n.f && map[n.f.w]) { n.k = "var"; n.f = { v: map[n.f.w] }; }
      else if (n.k === "var" && n.f && map[n.f.v]) n.f = { v: map[n.f.v] };
      if (n.a) n.a = n.a.map(rewriteTree);
      return n;
    };
    let sequence = deepMap(items, (str) => {
      const tree = HAV.decode(str);
      return tree ? HAV.compile(rewriteTree(tree)) : rewriteText(str);
    });
    if (triggerCond) {
      const fix = (v) => {
        if (Array.isArray(v)) return v.map(fix);
        if (!isObj(v)) return v;
        const o = {};
        for (const [k, x] of Object.entries(v)) o[k] = fix(x);
        if (o.condition === "trigger") {
          const ids = [].concat(o.id === undefined ? [] : o.id).map((x) => "'" + String(x).replace(/\\/g, "\\\\").replace(/'/g, "\\'") + "'");
          const n = { condition: "template", value_template: `{{ (${map["trigger.id"]} | string) in [${ids.join(", ")}] }}` };
          for (const k of ["alias", "enabled"]) if (o[k] !== undefined) n[k] = o[k];
          return n;
        }
        return o;
      };
      sequence = fix(sequence);
    }
    const fields = {}, data = {};
    for (const d of pass) {
      fields[map[d]] = { name: d, description: "Wird von der aufrufenden Automation übergeben.", selector: { text: {} } };
      data[map[d]] = `{{ ${d} }}`;
    }
    for (const n of plainPass) {
      fields[n] = { name: n, description: "Variable der aufrufenden Automation.", selector: { object: {} } };
      data[n] = `{{ ${n} }}`;
    }
    const notes = [];
    if (bare.size) notes.push(`Die Schritte nutzen „${[...bare].join(", ")}“ als Ganzes – das lässt sich nicht übergeben. Bitte im Skript prüfen.`);
    const leaking = [...defined];
    if (leaking.length) notes.push(`Variablen aus den ausgelagerten Schritten (${leaking.join(", ")}) stehen danach in der Automation nicht mehr zur Verfügung.`);
    return { fields, data, sequence, notes };
  }

  /* ---------- Auswahl nach Typ ----------
   * Katalog je Art: [{ group, items: [{ label, hint, item, blockly? }] }]. item = Vorlage (leere Werte werden
   * beim Einfügen weggelassen). services: [[id, name]] für die Aktionen nach Integration. */
  function typeCatalog(kind, services = [], domainName = (d) => d) {
    const it = (label, item, hint = "", o = {}) => ({ label, item, hint, ...o });
    if (kind === "trigger") return [
      { group: "Entität", items: [it("🔁 Zustand ändert sich", { trigger: "state", entity_id: "" }, "z. B. Tür auf, Licht an"),
        it("📈 Zahlenwert über/unter", { trigger: "numeric_state", entity_id: "", above: 0 }, "z. B. Temperatur über 25")] },
      { group: "Zeit & Ort", items: [it("⏰ Uhrzeit", { trigger: "time", at: "07:00:00" }), it("🕑 Zeitmuster", { trigger: "time_pattern", minutes: "/5" }, "alle 5 Minuten …"),
        it("☀️ Sonne", { trigger: "sun", event: "sunset" }, "Sonnenauf-/-untergang"), it("📍 Zone betreten/verlassen", { trigger: "zone", entity_id: "", zone: "zone.home", event: "enter" }),
        it("📅 Kalender-Termin", { trigger: "calendar", entity_id: "", event: "start" })] },
      { group: "Gerät", items: [it("📟 Gerät (Taster, Sensor …)", { trigger: "device", device_id: "" }, "erst Gerät, dann Art wählen")] },
      { group: "Andere", items: [it("🧩 Template wird wahr", { trigger: "template", value_template: "" }), it("🏠 Home Assistant startet", { trigger: "homeassistant", event: "start" }),
        it("📣 Ereignis", { trigger: "event", event_type: "" }), it("💬 Sprachbefehl", { trigger: "conversation", command: "" }),
        it("📡 MQTT", { trigger: "mqtt", topic: "" }), it("🌐 Webhook", { trigger: "webhook", webhook_id: "", local_only: true }),
        it("🏷️ NFC-Tag", { trigger: "tag", tag_id: "" }), it("🔔 Benachrichtigung", { trigger: "persistent_notification", notification_id: "" })] },
    ];
    if (kind === "condition") return [
      { group: "Entität", items: [it("🔎 Zustand ist", { condition: "state", entity_id: "", state: "" }), it("📏 Zahlenwert über/unter", { condition: "numeric_state", entity_id: "", below: 20 })] },
      { group: "Zeit & Ort", items: [it("⏰ Uhrzeit / Wochentag", { condition: "time", after: "08:00:00", before: "22:00:00" }), it("☀️ Sonne", { condition: "sun", after: "sunset" }),
        it("📍 In Zone", { condition: "zone", entity_id: "", zone: "zone.home" })] },
      { group: "Auslöser", items: [it("🏷️ Ausgelöst durch ID", { condition: "trigger", id: "" }, "welcher Auslöser es war")] },
      { group: "Logik", items: [it("UND – alle erfüllt", { condition: "and", conditions: [] }), it("ODER – eine erfüllt", { condition: "or", conditions: [] }),
        it("NICHT – keine erfüllt", { condition: "not", conditions: [] }),
        it("🧮 Bedingung aus Logik-Bausteinen", { condition: "template", value_template: "" }, "Werte & Logik hineinstecken", { blockly: true }),
        it("🧩 Template", { condition: "template", value_template: "" }, "Jinja-Text", { blockly: false })] },
      { group: "Gerät", items: [it("📟 Gerät", { condition: "device", device_id: "" })] },
    ];
    // Aktionen
    const doms = new Map();
    for (const s of services) {
      const id = Array.isArray(s) ? s[0] : s;
      if (typeof id !== "string" || !id.includes(".")) continue;
      const d = id.split(".")[0];
      if (!doms.has(d)) doms.set(d, []);
      doms.get(d).push(it((Array.isArray(s) && s[1]) || id, { action: id }, id));
    }
    const byDomain = [...doms.entries()].sort((a, b) => String(domainName(a[0])).localeCompare(String(domainName(b[0])), "de"))
      .map(([d, items]) => ({ group: `Dienste: ${domainName(d) || d}`, items }));
    return [
      { group: "Häufig", items: [it("▶️ Dienst aufrufen …", { action: "" }, "beliebiger Dienst"), it("🎬 Szene aktivieren", { scene: "" }),
        it("📜 Skript ausführen", { action: "script.turn_on", target: { entity_id: "" } }), it("🔔 Benachrichtigung", { action: "persistent_notification.create", data: { message: "" } })] },
      { group: "Ablauf", items: [it("❓ Wenn … dann … sonst", { if: [], then: [], else: [] }), it("🔀 Auswahl (mehrere Fälle)", { choose: [{ conditions: [], sequence: [] }] }),
        it("⏱️ Warten", { delay: { hours: 0, minutes: 1, seconds: 0 } }), it("⏳ Warten bis (Template)", { wait_template: "", timeout: { minutes: 5 }, continue_on_timeout: true }),
        it("⏳ Warten auf Auslöser", { wait_for_trigger: [], timeout: { minutes: 5 } }), it("🔁 Wiederholen (Anzahl)", { repeat: { count: 2, sequence: [] } }),
        it("🔁 Wiederholen solange", { repeat: { while: [], sequence: [] } }), it("🔁 Wiederholen bis", { repeat: { until: [], sequence: [] } }),
        it("⏸ Parallel ausführen", { parallel: [] }), it("📦 Variablen setzen", { variables: { name: "wert" } }), it("⛔ Stopp", { stop: "" })] },
      { group: "Bedingung als Schritt", items: [it("🔎 Weiter nur wenn Zustand …", { condition: "state", entity_id: "", state: "" }),
        it("🧮 Weiter nur wenn (Logik-Bausteine)", { condition: "template", value_template: "" }, "", { blockly: true })] },
      { group: "Gerät & Ereignis", items: [it("📟 Gerät", { device_id: "" }), it("📣 Ereignis senden", { event: "", event_data: {} })] },
      ...byDomain,
    ];
  }

  // Typ eines Elements wechseln: Vorlage nehmen, Passendes (Entität, Ziel, Name, ID …) übernehmen.
  function convertType(old, template) {
    const n = stripEmpty(clone(template));
    if (!isObj(old) || !isObj(n)) return n;
    for (const k of ["alias", "enabled", "id", "continue_on_error"]) if (old[k] !== undefined && !(k === "id" && "condition" in n && n.condition === "trigger")) n[k] = old[k];
    if (old.entity_id !== undefined && ("entity_id" in template || ["state", "numeric_state", "zone", "calendar"].includes(n.trigger || n.condition)))
      n.entity_id = old.entity_id;
    if (isObj(old.target) && "action" in n && n.action !== "") n.target = clone(old.target);
    return n;
  }

  const NEW_SCRIPT = (alias = "Neues Skript") => ({ alias, description: "", fields: {}, sequence: [], mode: "single" });

  const api = { serviceTitle, SCENE_ATTRS, typeCatalog, convertType, stripEmpty, inputPlaceholder, INPUT_RE, sceneSpec, dryRun, replaceEntity, closest, atPath, planExtract, templateRefs, HAV, toYaml, devKey, NEW_SCRIPT, walkConfig, collectPaths, triggerIds, durationSeconds, lint, references, ROOTS, TEMPLATES, missingInfo, simpleChips, setPath, delPath, isObj, clone, deepEqual, getPath, specFor, nativeEditable, itemToBlockJson, blockToItem, defineBlocks, buildToolbox, hooks, classify, NEW_AUTOMATION };
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.HAB = api;
})(typeof window !== "undefined" ? window : globalThis);
