/* Wert- und Logik-Bausteine (Blockly-Modus).
 *
 * Bausteine wie „Zustand von …“, Vergleiche, Rechnen, Text verbinden werden beim
 * Speichern zu einem Jinja-Template. Damit die Bausteine beim nächsten Laden
 * wieder entstehen, hängt am Template ein Jinja-Kommentar mit dem Baum:
 *
 *   {{ (states('sensor.t') | float(0)) > (20) }}{#hab:eyJrIjoi…#}
 *
 * Home Assistant ignoriert den Kommentar. Beim Laden wird geprüft, ob der Baum
 * genau dieses Template ergibt – nur dann werden Bausteine daraus, sonst bleibt
 * es ein normales Textfeld (von Hand geänderte Templates gehen nie verloren).
 */
(function (root) {
  "use strict";

  const q = (s) => "'" + String(s === undefined || s === null ? "" : s).replace(/\\/g, "\\\\").replace(/'/g, "\\'") + "'";
  const P = (x) => `(${x})`;
  const IDENT = /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)*$/;

  /* Bausteine: parts = Reihenfolge der Anzeige.
   *   ["t", "Text"]             Beschriftung
   *   ["f", name, art, vorgabe, optionen]  Feld (art: num | text | entity | state | attribute | variable | dd)
   *   ["i", name]               Steckplatz für einen weiteren Wert
   * j(f, a) erzeugt den Jinja-Ausdruck (a = Ausdrücke der Steckplätze, "none" wenn leer). */
  const CMP = [["=", "=="], ["≠", "!="], ["<", "<"], ["≤", "<="], [">", ">"], ["≥", ">="]];
  const VB = {
    num: { c: 230, parts: [["f", "n", "num", 0]], j: (f) => String(Number(f.n) || 0) },
    txt: { c: 160, parts: [["t", "„"], ["f", "s", "text", ""], ["t", "“"]], j: (f) => q(f.s) },
    bool: { c: 210, parts: [["f", "b", "dd", "true", [["wahr", "true"], ["falsch", "false"]]]], j: (f) => (f.b === "false" ? "false" : "true") },
    state: { c: 30, parts: [["t", "Zustand von"], ["f", "e", "entity", ""]], j: (f) => `states(${q(f.e)})` },
    statenum: { c: 30, parts: [["t", "Zahl von"], ["f", "e", "entity", ""]], j: (f) => `states(${q(f.e)}) | float(0)` },
    attr: { c: 30, parts: [["t", "Attribut"], ["f", "a", "attribute", ""], ["t", "von"], ["f", "e", "entity", ""]], j: (f) => `state_attr(${q(f.e)}, ${q(f.a)})` },
    isstate: { c: 210, parts: [["f", "e", "entity", ""], ["t", "ist"], ["f", "s", "state", ""]], j: (f) => `is_state(${q(f.e)}, ${q(f.s)})` },
    trig: { c: 30, parts: [["t", "Auslöser:"], ["f", "w", "dd", "trigger.id", [["ID", "trigger.id"], ["neuer Zustand", "trigger.to_state.state"],
      ["alter Zustand", "trigger.from_state.state"], ["Entität", "trigger.entity_id"], ["Name", "trigger.to_state.name"]]]], j: (f) => f.w },
    var: { c: 330, parts: [["t", "Variable"], ["f", "v", "variable", ""]], j: (f) => (IDENT.test(f.v || "") ? f.v : "none") },
    now: { c: 30, parts: [["t", "jetzt:"], ["f", "w", "dd", "now().strftime('%H:%M')", [["Uhrzeit", "now().strftime('%H:%M')"], ["Stunde", "now().hour"],
      ["Minute", "now().minute"], ["Wochentag (0 = Mo)", "now().weekday()"], ["Datum", "now().strftime('%d.%m.%Y')"]]]], j: (f) => f.w },
    cmp: { c: 210, parts: [["i", "A"], ["f", "op", "dd", "==", CMP], ["i", "B"]], j: (f, a) => `${P(a[0])} ${f.op} ${P(a[1])}` },
    logic: { c: 210, parts: [["i", "A"], ["f", "op", "dd", "and", [["und", "and"], ["oder", "or"]]], ["i", "B"]], j: (f, a) => `${P(a[0])} ${f.op} ${P(a[1])}` },
    not: { c: 210, parts: [["t", "nicht"], ["i", "A"]], j: (f, a) => `not ${P(a[0])}` },
    math: { c: 230, parts: [["i", "A"], ["f", "op", "dd", "+", [["+", "+"], ["−", "-"], ["×", "*"], ["÷", "/"], ["Rest", "%"], ["hoch", "**"]]], ["i", "B"]],
      j: (f, a) => `${P(a[0])} ${f.op} ${P(a[1])}` },
    round: { c: 230, parts: [["t", "runde"], ["i", "A"], ["t", "auf"], ["f", "n", "num", 0], ["t", "Stellen"]], j: (f, a) => `${P(a[0])} | round(${Math.max(0, Math.round(Number(f.n) || 0))})` },
    join: { c: 160, parts: [["t", "verbinde"], ["i", "A"], ["t", "+"], ["i", "B"]], j: (f, a) => `${P(a[0])} ~ ${P(a[1])}` },
    tonum: { c: 230, parts: [["t", "als Zahl"], ["i", "A"]], j: (f, a) => `${P(a[0])} | float(0)` },
    totext: { c: 160, parts: [["t", "als Text"], ["i", "A"]], j: (f, a) => `${P(a[0])} | string` },
    ifelse: { c: 210, parts: [["t", "wenn"], ["i", "A"], ["t", "dann"], ["i", "B"], ["t", "sonst"], ["i", "C"]], j: (f, a) => `${P(a[1])} if ${P(a[0])} else ${P(a[2])}` },
  };
  const fieldsOf = (k) => VB[k].parts.filter((p) => p[0] === "f");
  const inputsOf = (k) => VB[k].parts.filter((p) => p[0] === "i").map((p) => p[1]);

  // ---------- Baum <-> Jinja ----------
  function expr(tree) {
    if (!tree || !VB[tree.k]) return "none";
    const f = {};
    for (const [, name, , def] of fieldsOf(tree.k)) f[name] = tree.f && tree.f[name] !== undefined ? tree.f[name] : def;
    const a = inputsOf(tree.k).map((_, i) => expr(tree.a && tree.a[i]));
    return VB[tree.k].j(f, a);
  }
  const b64e = (s) => btoa(String.fromCharCode(...new TextEncoder().encode(s)));
  const b64d = (s) => new TextDecoder().decode(Uint8Array.from(atob(s), (c) => c.charCodeAt(0)));
  function compile(tree) {
    return `{{ ${expr(tree)} }}{#hab:${b64e(JSON.stringify(tree))}#}`;
  }
  const MARK = /^\{\{ [\s\S]* \}\}\{#hab:([A-Za-z0-9+/=]+)#\}$/;
  // Template -> Baum (nur wenn es genau so erzeugt wurde), sonst null.
  function decode(str) {
    if (typeof str !== "string") return null;
    const m = MARK.exec(str);
    if (!m) return null;
    try {
      const tree = JSON.parse(b64d(m[1]));
      return compile(tree) === str ? tree : null;
    } catch (e) {
      return null;
    }
  }

  // ---------- Blöcke <-> Baum ----------
  function blockToTree(b) {
    if (!b || !b.type || !b.type.startsWith("ha_v_")) return null;
    const k = b.type.slice(5);
    if (!VB[k]) return null;
    const tree = { k };
    const fs = fieldsOf(k);
    if (fs.length) {
      tree.f = {};
      for (const [, name, kind] of fs) {
        const v = b.getFieldValue(name);
        tree.f[name] = kind === "num" ? Number(v) || 0 : v === null || v === undefined ? "" : String(v);
      }
    }
    const ins = inputsOf(k);
    if (ins.length) tree.a = ins.map((n) => blockToTree(b.getInputTargetBlock(n)));
    return tree;
  }
  function treeToBlockJson(tree) {
    if (!tree || !VB[tree.k]) return null;
    const json = { type: "ha_v_" + tree.k };
    if (tree.f) json.fields = { ...tree.f };
    const ins = inputsOf(tree.k);
    ins.forEach((n, i) => {
      const c = tree.a && tree.a[i] ? treeToBlockJson(tree.a[i]) : null;
      if (c) (json.inputs = json.inputs || {})[n] = { block: c };
    });
    return json;
  }
  const compileBlock = (b) => compile(blockToTree(b));

  // ---------- Blockly-Definitionen ----------
  function defineValueBlocks(Blockly, makePicker) {
    for (const [k, spec] of Object.entries(VB)) {
      Blockly.Blocks["ha_v_" + k] = {
        init() {
          this.setOutput(true, "HAValue");
          this.setColour(spec.c);
          this.setInputsInline(true);
          let inp = this.appendDummyInput("D0");
          let n = 0;
          for (const part of spec.parts) {
            if (part[0] === "t") inp.appendField(part[1]);
            else if (part[0] === "i") { inp = this.appendValueInput(part[1]).setCheck("HAValue"); n++; }
            else {
              const [, name, kind, def, opts] = part;
              let fld;
              if (kind === "num") fld = new Blockly.FieldNumber(def);
              else if (kind === "dd") fld = new Blockly.FieldDropdown(opts);
              else if (kind === "text") fld = new Blockly.FieldTextInput(def);
              else fld = makePicker(kind, def, name);
              inp.appendField(fld, name);
            }
            if (part[0] === "i") inp = this.appendDummyInput("D" + n);
          }
          this.setTooltip("Wert-Baustein: wird beim Speichern zu einem Home-Assistant-Template.");
        },
      };
    }
  }

  // Werkzeugkasten-Kategorie „Werte & Logik“.
  const bj = (k, fields, inputs) => ({ kind: "block", type: "ha_v_" + k, ...(fields ? { fields } : {}), ...(inputs ? { inputs } : {}) });
  const sh = (k, fields) => ({ shadow: { type: "ha_v_" + k, ...(fields ? { fields } : {}) } });
  function toolboxContents() {
    return [
      { kind: "label", text: "Werte aus Home Assistant" },
      bj("state"), bj("statenum"), bj("attr"), bj("isstate"), bj("trig"), bj("now"), bj("var"),
      { kind: "label", text: "Vergleichen und verknüpfen" },
      bj("cmp", { op: ">" }, { A: sh("statenum"), B: sh("num", { n: 20 }) }),
      bj("logic", { op: "and" }), bj("not"), bj("ifelse"),
      { kind: "label", text: "Zahlen und Text" },
      bj("num"), bj("txt"), bj("bool"),
      bj("math", { op: "+" }, { A: sh("num", { n: 1 }), B: sh("num", { n: 1 }) }),
      bj("round", { n: 1 }), bj("tonum"),
      bj("join", null, { A: sh("txt", { s: "Hallo " }), B: sh("state") }), bj("totext"),
    ];
  }

  const api = { tbBlock: bj, tbShadow: sh, VB, expr, compile, decode, blockToTree, treeToBlockJson, compileBlock, defineValueBlocks, toolboxContents };
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.HAV = api;
})(typeof window !== "undefined" ? window : globalThis);
