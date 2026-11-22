/* Blockly-Darstellung nativer HA-Automationen.
 *
 * Grundprinzip (verlustfrei): Jeder Block merkt sich sein komplettes
 * Original-Objekt (raw). Beim Zurückschreiben wird raw geklont und nur die
 * sichtbaren, bearbeitbaren Felder sowie die verschachtelten Listen werden
 * überschrieben. Alles, was der Editor nicht kennt, bleibt Byte für Byte so,
 * wie HA es geliefert hat.
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
    let cur = obj;
    for (let i = 0; i < keys.length - 1; i++) {
      if (!isObj(cur[keys[i]])) return;
      cur = cur[keys[i]];
    }
    delete cur[keys[keys.length - 1]];
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

  // ---------- Farben ----------
  const C = { trigger: 30, condition: 210, action: 140, flow: 260, generic: "#8a8a8a", root: 50 };

  const NONE = "__ha_none__";
  const UNIT = { hours: "Std", minutes: "Min", seconds: "Sek", milliseconds: "ms", days: "Tage" };

  // Feld-Helfer. show: "always" | "present"
  const F = (path, label, show = "always", extra = {}) => ({ path, label, show, ...extra });
  const L = (path, label, kind, show = "always") => ({ path, label, kind, show });

  // Ein Zeitraum-Feld (for/delay/timeout) kann String oder Objekt sein.
  function durationFields(item, path, label) {
    const v = getPath(item, path);
    if (v === undefined) return [];
    if (isObj(v) && Object.values(v).every(isPrim)) {
      return Object.keys(v).map((k, i) =>
        F(`${path}.${k}`, (i === 0 ? label + " " : "") + (UNIT[k] || k), "present", { numeric: true })
      );
    }
    return [F(path, label, "present")];
  }

  // ---------- Spezifikationen ----------
  function triggerSpec(t) {
    const kind = t.trigger !== undefined ? "trigger" : "platform";
    const p = t[kind];
    const common = (title, fields, colour = C.trigger) => ({
      title, colour,
      fields: [...fields, F("id", "ID", "present")],
      lists: [],
    });
    switch (p) {
      case "time":
        return common("⏰ Zeit", [F("at", "um")]);
      case "state":
        return common("🔁 Zustand", [
          F("entity_id", "Entität", "always", { entity: true }),
          F("from", "von", "present"),
          F("to", "zu"),
          ...durationFields(t, "for", "für"),
        ]);
      case "numeric_state":
        return common("📈 Zahlenwert", [
          F("entity_id", "Entität", "always", { entity: true }),
          F("attribute", "Attribut", "present"),
          F("above", "über", "always", { numeric: true }),
          F("below", "unter", "always", { numeric: true }),
          ...durationFields(t, "for", "für"),
        ]);
      case "sun":
        return common("☀️ Sonne", [
          F("event", "Ereignis", "always", { options: [["Aufgang", "sunrise"], ["Untergang", "sunset"]] }),
          F("offset", "Versatz", "present"),
        ]);
      case "time_pattern":
        return common("🕑 Zeitmuster", [F("hours", "Std", "present"), F("minutes", "Min"), F("seconds", "Sek", "present")]);
      case "template":
        return common("🧩 Template", [F("value_template", "wenn wahr"), ...durationFields(t, "for", "für")]);
      case "homeassistant":
        return common("🏠 Home Assistant", [
          F("event", "Ereignis", "always", { options: [["Start", "start"], ["Stopp", "shutdown"]] }),
        ]);
      case "event":
        return common("📣 Ereignis", [F("event_type", "Typ")]);
      case "device":
        return common(`📟 Gerät: ${t.type || ""}${t.subtype !== undefined ? " " + t.subtype : ""} (${t.domain || ""})`, []);
      default:
        return { ...common(`Auslöser: ${p}`, []), colour: C.generic, generic: true };
    }
  }

  function conditionSpec(c) {
    if (!isObj(c)) {
      return { title: "🧩 Template (Kurzform)", colour: C.generic, fields: [], lists: [], generic: true, summary: true };
    }
    const common = (title, fields, lists = [], colour = C.condition) => ({ title, colour, fields, lists });
    switch (c.condition) {
      case "state":
        return common("🔎 Zustand", [
          F("entity_id", "Entität", "always", { entity: true }),
          F("attribute", "Attribut", "present"),
          F("state", "ist"),
          ...durationFields(c, "for", "seit"),
        ]);
      case "numeric_state":
        return common("📏 Zahlenwert", [
          F("entity_id", "Entität", "always", { entity: true }),
          F("attribute", "Attribut", "present"),
          F("above", "über", "always", { numeric: true }),
          F("below", "unter", "always", { numeric: true }),
        ]);
      case "time":
        return common("⏰ Zeit", [F("after", "nach"), F("before", "vor"), F("weekday", "Wochentag", "present")]);
      case "sun":
        return common("☀️ Sonne", [F("after", "nach", "present"), F("before", "vor", "present")]);
      case "trigger":
        return common("🏷️ Auslöser-ID", [F("id", "ist")]);
      case "template":
        return common("🧩 Template", [F("value_template", "wahr")]);
      case "zone":
        return common("📍 Zone", [F("entity_id", "Entität", "always", { entity: true }), F("zone", "in", "always", { entity: true })]);
      case "and":
        return common("UND – alle erfüllt", [], [L("conditions", "", "condition")], C.flow);
      case "or":
        return common("ODER – eine erfüllt", [], [L("conditions", "", "condition")], C.flow);
      case "not":
        return common("NICHT – keine erfüllt", [], [L("conditions", "", "condition")], C.flow);
      case "device":
        return { ...common(`📟 Gerät: ${c.type || ""} (${c.domain || ""})`, []), colour: C.generic, generic: true };
      default:
        return { ...common(`Bedingung: ${c.condition}`, []), colour: C.generic, generic: true };
    }
  }

  function actionSpec(a) {
    const common = (title, fields, lists = [], colour = C.action) => ({ title, colour, fields, lists });
    if (!isObj(a)) return { ...common("Aktion", []), colour: C.generic, generic: true, summary: true };
    if ("choose" in a)
      return common("🔀 Auswahl", [], [L("choose", "Optionen", "option"), L("default", "sonst", "action")], C.flow);
    if ("if" in a)
      return common("❓ Wenn", [], [L("if", "wenn", "condition"), L("then", "dann", "action"), L("else", "sonst", "action")], C.flow);
    if ("repeat" in a) {
      const r = isObj(a.repeat) ? a.repeat : {};
      const lists = [];
      if ("while" in r) lists.push(L("repeat.while", "solange", "condition"));
      if ("until" in r) lists.push(L("repeat.until", "bis", "condition"));
      lists.push(L("repeat.sequence", "mache", "action"));
      return common("🔁 Wiederholen", [F("repeat.count", "Anzahl", "present", { numeric: true }), F("repeat.for_each", "für jedes", "present")], lists, C.flow);
    }
    if ("parallel" in a) return common("⏸ Parallel", [], [L("parallel", "", "action")], C.flow);
    if ("sequence" in a) return common("📜 Folge", [], [L("sequence", "", "action")], C.flow);
    if ("wait_for_trigger" in a)
      return common("⏳ Warten auf Auslöser", durationFields(a, "timeout", "max."), [L("wait_for_trigger", "", "trigger")], C.flow);
    if ("wait_template" in a)
      return common("⏳ Warten bis", [F("wait_template", "Template"), ...durationFields(a, "timeout", "max.")], [], C.flow);
    if ("delay" in a) {
      const d = a.delay;
      if (isObj(d)) return common("⏱️ Verzögerung", durationFields(a, "delay", ""));
      return common("⏱️ Verzögerung", [F("delay", "", "always", { numeric: typeof d === "number" })]);
    }
    if ("action" in a || "service" in a) {
      const key = "action" in a ? "action" : "service";
      const fields = [F(key, "")];
      if (getPath(a, "target.entity_id") !== undefined) fields.push(F("target.entity_id", "Entität", "present", { entity: true }));
      if (getPath(a, "target.area_id") !== undefined) fields.push(F("target.area_id", "Bereich", "present"));
      if (a.entity_id !== undefined) fields.push(F("entity_id", "Entität", "present", { entity: true }));
      if (isObj(a.data)) for (const k of Object.keys(a.data)) fields.push(F(`data.${k}`, k, "present"));
      return common("▶️ Aktion", fields);
    }
    if ("event" in a) return common("📣 Ereignis senden", [F("event", "Typ")]);
    if ("scene" in a) return common("🎬 Szene", [F("scene", "", "always", { entity: true })]);
    if ("stop" in a) return common("⛔ Stopp", [F("stop", "Grund")], [], C.flow);
    if ("variables" in a && isObj(a.variables))
      return common("📦 Variablen", Object.keys(a.variables).map((k) => F(`variables.${k}`, k, "present")), [], C.flow);
    if ("device_id" in a)
      return { ...common(`📟 Gerät: ${a.type || ""} (${a.domain || ""})`, []), colour: C.generic, generic: true };
    return { ...common("Aktion (unbekannt)", []), colour: C.generic, generic: true };
  }

  function rootSpec(cfg) {
    const tKey = "triggers" in cfg ? "triggers" : "trigger" in cfg ? "trigger" : "triggers";
    const cKey = "conditions" in cfg ? "conditions" : "condition" in cfg ? "condition" : "conditions";
    const aKey = "actions" in cfg ? "actions" : "action" in cfg ? "action" : "actions";
    return {
      title: "🤖 Automation",
      colour: C.root,
      fields: [
        F("alias", "Name"),
        F("mode", "Modus", "always", {
          options: [["(Standard)", ""], ["single", "single"], ["restart", "restart"], ["queued", "queued"], ["parallel", "parallel"]],
        }),
      ],
      lists: [L(tKey, "Auslöser", "trigger"), L(cKey, "Bedingungen", "condition"), L(aKey, "Aktionen", "action")],
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
      if (item.alias !== undefined && isPrim(item.alias)) spec.fields = [F("alias", "Name", "present"), ...spec.fields];
      if (item.enabled === false) spec.title += "  (deaktiviert)";
    }
    return spec;
  }

  // In Aktionslisten dürfen auch Bedingungen stehen.
  const classify = (listKind, el) => (listKind === "action" && isObj(el) && "condition" in el ? "condition" : listKind);

  const CHECK_PREV = { trigger: "ha_trigger", condition: "ha_condition", action: "ha_action", option: "ha_option" };
  const CHECK_LIST = { trigger: ["ha_trigger"], condition: ["ha_condition"], action: ["ha_action", "ha_condition"], option: ["ha_option"] };

  // ---------- HA-Objekt -> Blockly-JSON ----------
  function itemToBlockJson(kind, item) {
    const spec = specFor(kind, item);
    const json = { type: "ha_" + kind, extraState: { raw: clone(item) } };
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

  // ---------- Block -> HA-Objekt ----------
  function convert(val, f) {
    if ((typeof f.orig === "number" || (f.orig === undefined && f.numeric)) && val.trim() !== "" && isFinite(Number(val))) return Number(val);
    if (typeof f.orig === "boolean" && (val === "true" || val === "false")) return val === "true";
    return val;
  }
  function blockToItem(b) {
    const out = clone(b.raw_);
    if (!isObj(out)) return out;
    for (const f of b.fieldMap_ || []) {
      let val = b.getFieldValue(f.name);
      if (val === NONE) val = "";
      if (val === f.origStr) continue;
      if (val === "") { if (f.orig !== undefined) delPath(out, f.path); continue; }
      setPath(out, f.path, convert(val, f));
    }
    (b.listMap_ || []).forEach((l) => {
      const items = [];
      let c = b.getInputTargetBlock(l.name);
      while (c) {
        items.push(blockToItem(c));
        c = c.getNextBlock();
      }
      if ((l.orig === undefined || l.orig === null) && items.length === 0) return;
      if (l.single && items.length === 1) setPath(out, l.path, items[0]);
      else setPath(out, l.path, items);
    });
    return out;
  }

  // ---------- Blockly-Blöcke ----------
  const hooks = { entityName: () => "" };

  function defineBlocks(Blockly) {
    const mixin = {
      saveExtraState() { return { raw: this.raw_ }; },
      loadExtraState(state) { this.build_(state && state.raw !== undefined ? state.raw : {}); },
      build_(raw) {
        const block = this;
        this.raw_ = raw;
        const spec = specFor(this.haKind_, raw);
        this.setColour(spec.colour);
        this.appendDummyInput("HEAD").appendField(spec.title);
        if (spec.summary || spec.generic) {
          const txt = spec.summary ? short(raw, 60) : short(raw, 60);
          this.appendDummyInput("SUM").appendField(new Blockly.FieldLabel(txt, "ha-summary"));
          this.setTooltip("Wird unverändert übernommen. Bearbeiten über das JSON-Feld rechts.");
        }
        this.fieldMap_ = [];
        spec.fields.forEach((f, i) => {
          const v = getPath(raw, f.path);
          if (v === undefined && f.show === "present") return;
          const inp = this.appendDummyInput("FI" + i);
          if (f.label) inp.appendField(f.label);
          const name = "F" + i;
          if (f.options) {
            const opts = f.options.map((o) => [o[0], o[1] === "" ? NONE : o[1]]);
            const cur = v === undefined ? "" : String(v);
            const curVal = cur === "" ? NONE : cur;
            if (!opts.some((o) => o[1] === curVal)) opts.push([cur || "(leer)", curVal]);
            inp.appendField(new Blockly.FieldDropdown(opts), name);
            this.setFieldValue(curVal, name);
            this.fieldMap_.push({ name, path: f.path, orig: v, origStr: cur, numeric: f.numeric });
          } else if (v === undefined || isPrim(v)) {
            const str = v === undefined ? "" : String(v);
            const tf = new Blockly.FieldTextInput(str);
            inp.appendField(tf, name);
            this.fieldMap_.push({ name, path: f.path, orig: v, origStr: str, numeric: f.numeric });
            if (f.entity) {
              const lbl = new Blockly.FieldLabel(hooks.entityName(str), "ha-entity-name");
              inp.appendField(lbl, "N" + i);
              tf.setValidator((nv) => { lbl.setValue(hooks.entityName(nv)); return nv; });
            }
          } else {
            inp.appendField(new Blockly.FieldLabel(short(v), "ha-readonly"));
          }
        });
        this.listMap_ = [];
        spec.lists.forEach((l, i) => {
          const name = "L" + i;
          const orig = getPath(raw, l.path);
          this.appendStatementInput(name).setCheck(CHECK_LIST[l.kind]).appendField(l.label);
          this.listMap_.push({ name, path: l.path, orig, single: orig !== undefined && orig !== null && !Array.isArray(orig) });
        });
        return block;
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
  const tb = (kind, raw) => ({ kind: "block", type: "ha_" + kind, extraState: { raw } });
  const TOOLBOX = {
    kind: "categoryToolbox",
    contents: [
      { kind: "category", name: "Auslöser", colour: String(C.trigger), contents: [
        tb("trigger", { trigger: "time", at: "07:00:00" }),
        tb("trigger", { trigger: "state", entity_id: "", to: "on" }),
        tb("trigger", { trigger: "numeric_state", entity_id: "", above: 25 }),
        tb("trigger", { trigger: "sun", event: "sunset" }),
        tb("trigger", { trigger: "time_pattern", minutes: "/5" }),
        tb("trigger", { trigger: "template", value_template: "{{ }}" }),
        tb("trigger", { trigger: "homeassistant", event: "start" }),
      ] },
      { kind: "category", name: "Bedingungen", colour: String(C.condition), contents: [
        tb("condition", { condition: "state", entity_id: "", state: "on" }),
        tb("condition", { condition: "numeric_state", entity_id: "", below: 20 }),
        tb("condition", { condition: "time", after: "08:00:00", before: "22:00:00" }),
        tb("condition", { condition: "trigger", id: "" }),
        tb("condition", { condition: "template", value_template: "{{ }}" }),
        tb("condition", { condition: "and", conditions: [] }),
        tb("condition", { condition: "or", conditions: [] }),
        tb("condition", { condition: "not", conditions: [] }),
      ] },
      { kind: "category", name: "Aktionen", colour: String(C.action), contents: [
        tb("action", { action: "light.turn_on", target: { entity_id: "" } }),
        tb("action", { action: "light.turn_off", target: { entity_id: "" } }),
        tb("action", { action: "notify.mobile_app_s24_ultra", data: { message: "", data: { priority: "high" } } }),
        tb("action", { delay: { minutes: 1 } }),
        tb("action", { wait_template: "{{ }}" }),
      ] },
      { kind: "category", name: "Ablauf", colour: String(C.flow), contents: [
        tb("action", { if: [], then: [] }),
        tb("action", { choose: [], default: [] }),
        tb("option", { conditions: [], sequence: [] }),
        tb("action", { repeat: { count: 2, sequence: [] } }),
        tb("action", { parallel: [] }),
        tb("action", { stop: "" }),
      ] },
      { kind: "category", name: "Roh-JSON", colour: C.generic, contents: [
        tb("action", {}),
        tb("condition", { condition: "device" }),
        tb("trigger", { trigger: "device" }),
      ] },
    ],
  };

  const api = { isObj, clone, deepEqual, getPath, specFor, itemToBlockJson, blockToItem, defineBlocks, TOOLBOX, hooks, classify };
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.HAB = api;
})(typeof window !== "undefined" ? window : globalThis);
