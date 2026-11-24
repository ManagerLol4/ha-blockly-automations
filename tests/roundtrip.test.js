// Rundlauf-Tests ohne Browser: npm test
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const Blockly = require("blockly/core");
const HAB = require("../custom_components/blockly_automations/www/ha_blocks.js");

HAB.defineBlocks(Blockly);

const ws = new Blockly.Workspace();
function toBlocks(cfg, kind = "root") {
  ws.clear();
  return Blockly.serialization.blocks.append(HAB.itemToBlockJson(kind, cfg), ws);
}
const field = (b, p) => {
  const f = b.fieldMap_.find((x) => x.path === p);
  assert.ok(f, `Feld ${p} fehlt in ${b.type}`);
  return f.name;
};
const child = (b, input) => b.getInputTargetBlock(input);
let n = 0;
const ok = (name, fn) => { fn(); n++; };

// 1) Alle Beispiel-Automationen überstehen den Rundlauf unverändert.
const dir = path.join(__dirname, "fixtures");
for (const f of fs.readdirSync(dir).filter((x) => x.endsWith(".json"))) {
  ok(f, () => {
    const cfg = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
    const back = HAB.blockToItem(toBlocks(cfg));
    assert.deepStrictEqual(back, cfg, `Rundlauf nicht identisch: ${f}`);
    assert.deepStrictEqual(Object.keys(back), Object.keys(cfg), `Schlüsselreihenfolge: ${f}`);
  });
}

// 2) Jeder Block aus dem Werkzeugkasten übersteht den Rundlauf unverändert.
for (const cat of HAB.buildToolbox().contents) {
  for (const item of cat.contents.filter((x) => x.kind === "block")) {
    ok(item.type, () => {
      const raw = item.extraState.raw;
      const b = toBlocks(raw, item.type.slice(3));
      assert.deepStrictEqual(HAB.blockToItem(b), raw, `Werkzeugkasten ${JSON.stringify(raw)}`);
    });
  }
}

// 3) Uhrzeit ändern, sonst nichts.
ok("uhrzeit", () => {
  const cfg = JSON.parse(fs.readFileSync(path.join(dir, "zeitplan.json"), "utf8"));
  const r = toBlocks(cfg);
  const trig = child(r, "L0");
  trig.setFieldValue("07:30:00", field(trig, "at"));
  const expected = JSON.parse(JSON.stringify(cfg));
  expected.triggers[0].at = "07:30:00";
  assert.deepStrictEqual(HAB.blockToItem(r), expected);
});

// 4) Entität und Zahl ändern; nicht vorhandene Listen entstehen nicht.
ok("entitaet+zahl", () => {
  const cfg = { alias: "x", triggers: [{ trigger: "numeric_state", entity_id: "sensor.a", above: 30 }],
    actions: [{ action: "light.turn_on", target: { entity_id: "light.a" }, data: { brightness_pct: 50 } }] };
  const r = toBlocks(cfg);
  const act = child(r, "L2");
  act.setFieldValue("light.b", field(act, "target.entity_id"));
  const t = child(r, "L0");
  t.setFieldValue("31", field(t, "above"));
  const back = HAB.blockToItem(r);
  assert.strictEqual(back.actions[0].target.entity_id, "light.b");
  assert.strictEqual(back.actions[0].data.brightness_pct, 50);
  assert.strictEqual(back.triggers[0].above, 31);
  assert.ok(!("conditions" in back));
});

// 5) Neue Automation aus Werkzeugkasten-Blöcken zusammenstecken.
ok("neu", () => {
  const r = toBlocks(HAB.NEW_AUTOMATION());
  r.setFieldValue("Flurlicht", field(r, "alias"));
  const trig = Blockly.serialization.blocks.append(HAB.itemToBlockJson("trigger", { trigger: "state" }), ws);
  trig.setFieldValue("binary_sensor.flur", field(trig, "entity_id"));
  trig.setFieldValue("on", field(trig, "to"));
  trig.setFieldValue("2", field(trig, "for.minutes"));
  r.getInput("L0").connection.connect(trig.previousConnection);
  const cond = Blockly.serialization.blocks.append(HAB.itemToBlockJson("condition", { condition: "time" }), ws);
  cond.setFieldValue("TRUE", "F" + cond.spec_.fields.findIndex((f) => f.path === "weekday") + "_0");
  cond.setFieldValue("TRUE", "F" + cond.spec_.fields.findIndex((f) => f.path === "weekday") + "_4");
  cond.setFieldValue("18:00:00", field(cond, "after"));
  r.getInput("L1").connection.connect(cond.previousConnection);
  const act = Blockly.serialization.blocks.append(HAB.itemToBlockJson("action", { action: "light.turn_on" }), ws);
  act.setFieldValue("light.flur", field(act, "target.entity_id"));
  r.getInput("L2").connection.connect(act.previousConnection);
  const delay = Blockly.serialization.blocks.append(HAB.itemToBlockJson("action", { delay: { minutes: 1 } }), ws);
  delay.setFieldValue("5", field(delay, "delay.minutes"));
  act.nextConnection.connect(delay.previousConnection);
  assert.deepStrictEqual(HAB.blockToItem(r), {
    alias: "Flurlicht", description: "",
    triggers: [{ trigger: "state", entity_id: "binary_sensor.flur", to: "on", for: { minutes: 2 } }],
    conditions: [{ condition: "time", after: "18:00:00", weekday: ["mon", "fri"] }],
    actions: [{ action: "light.turn_on", target: { entity_id: "light.flur" } }, { delay: { minutes: 5 } }],
    mode: "single",
  });
});

// 6) Block deaktivieren -> enabled: false; wieder aktivieren -> Schlüssel weg.
ok("deaktivieren", () => {
  const b = toBlocks({ action: "light.toggle", target: { entity_id: "light.a" } }, "action");
  b.setDisabledReason(true, "MANUALLY_DISABLED");
  assert.strictEqual(HAB.blockToItem(b).enabled, false);
  const b2 = toBlocks({ delay: "00:00:10", enabled: false }, "action");
  assert.ok(!b2.isEnabled());
  b2.setDisabledReason(false, "MANUALLY_DISABLED");
  assert.deepStrictEqual(HAB.blockToItem(b2), { delay: "00:00:10" });
});

// 7) Zeitraum leeren entfernt das ganze "for"; Listen bleiben Listen.
ok("for-leeren", () => {
  const b = toBlocks({ trigger: "state", entity_id: ["light.a", "light.b"], to: "on", for: { minutes: 1 } }, "trigger");
  b.setFieldValue("", field(b, "for.minutes"));
  b.setFieldValue("light.a, light.c", field(b, "entity_id"));
  assert.deepStrictEqual(HAB.blockToItem(b), { trigger: "state", entity_id: ["light.a", "light.c"], to: "on" });
});

// 8) JSON- und Ja/Nein-Felder.
ok("json+bool", () => {
  const b = toBlocks({ event: "mein_event", event_data: { a: 1 } }, "action");
  b.setFieldValue('{"a":2,"b":[1,2]}', field(b, "event_data"));
  assert.deepStrictEqual(HAB.blockToItem(b), { event: "mein_event", event_data: { a: 2, b: [1, 2] } });
  const w = toBlocks({ wait_template: "{{ true }}" }, "action");
  w.setFieldValue("false", field(w, "continue_on_timeout"));
  assert.strictEqual(HAB.blockToItem(w).continue_on_timeout, false);
});

// 9) Template-Kurzform als Bedingung bearbeiten.
ok("kurzform", () => {
  const b = toBlocks("{{ is_state('sun.sun','above_horizon') }}", "condition");
  b.setFieldValue("{{ true }}", field(b, ""));
  assert.strictEqual(HAB.blockToItem(b), "{{ true }}");
});

// 10) Dienst-Schema liefert Felder; leere Schema-Felder werden nicht geschrieben.
ok("schema", () => {
  HAB.hooks.serviceFields = (s) => (s === "light.turn_on"
    ? { brightness_pct: { selector: { number: {} }, name: "Helligkeit" }, flash: { selector: { select: { options: ["long", "short"] } } },
        extra: { fields: { color_name: { selector: { text: {} } } } } }
    : null);
  const b = toBlocks({ action: "light.turn_on", target: { entity_id: "light.a" } }, "action");
  assert.deepStrictEqual(HAB.blockToItem(b), { action: "light.turn_on", target: { entity_id: "light.a" } });
  b.setFieldValue("40", field(b, "data.brightness_pct"));
  b.setFieldValue("short", field(b, "data.flash"));
  assert.deepStrictEqual(HAB.blockToItem(b).data, { brightness_pct: 40, flash: "short" });
  assert.ok(!b.fieldMap_.some((f) => f.path === "data.color_name"), "Abschnittsfelder nur wenn befüllt");
  HAB.hooks.serviceFields = () => null;
});

// 11) Einfach-Modus: Werkzeugkasten und Vorlagen überstehen den Rundlauf; Root zeigt nur den Namen.
ok("einfach", () => {
  HAB.hooks.simple = true;
  HAB.hooks.openEditor = () => {};
  HAB.hooks.pickField = () => {};
  HAB.hooks.chipText = (c, v) => (v === undefined ? "" : JSON.stringify(v));
  HAB.hooks.describe = () => "Satz";
  // Chips: Zeitraum zusammengefasst, Profi-Felder nur wenn gesetzt, Ziel als Ganzes.
  const st = { trigger: "state", entity_id: "binary_sensor.tuer", to: "on", for: { minutes: 1 } };
  assert.deepStrictEqual(HAB.simpleChips(HAB.specFor("trigger", st), st).map((c) => `${c.path}:${c.type}`),
    ["entity_id:entity", "from:state", "to:state", "for:duration"]);
  const act = { action: "light.turn_on", target: { entity_id: "light.a" } };
  assert.deepStrictEqual(HAB.simpleChips(HAB.specFor("action", act), act).map((c) => `${c.path}:${c.type}`),
    ["action:service", "target:target"]);
  for (const cat of HAB.buildToolbox().contents) {
    for (const item of cat.contents.filter((x) => x.kind === "block")) {
      const b = toBlocks(item.extraState.raw, item.type.slice(3));
      assert.deepStrictEqual(HAB.blockToItem(b), item.extraState.raw);
    }
  }
  for (const t of HAB.TEMPLATES) {
    const cfg = t.cfg();
    const r = toBlocks(cfg);
    assert.deepStrictEqual(HAB.blockToItem(r), cfg, `Vorlage ${t.name}`);
    assert.deepStrictEqual(r.fieldMap_.map((f) => f.path), ["alias"]);
  }
  // Einfache Blöcke haben keine Eingabefelder, bleiben aber verlustfrei.
  const cfg = JSON.parse(fs.readFileSync(path.join(dir, "licht_choose.json"), "utf8"));
  const r = toBlocks(cfg);
  assert.deepStrictEqual(HAB.blockToItem(r), cfg);
  assert.strictEqual(child(r, "L0").fieldMap_.length, 0);
  HAB.hooks.simple = false;
  HAB.hooks.openEditor = null;
  HAB.hooks.pickField = null;
  HAB.hooks.describe = () => "";
});

// 12) Fehlende Auswahl wird erkannt.
ok("fehlt", () => {
  assert.ok(HAB.missingInfo({ trigger: "state", entity_id: "" }));
  assert.ok(HAB.missingInfo({ action: "light.turn_on", target: { entity_id: "" } }));
  assert.ok(!HAB.missingInfo({ action: "light.turn_on", target: { entity_id: "", area_id: "kueche" } }));
  assert.ok(!HAB.missingInfo({ trigger: "button.pressed", target: { area_id: "badezimmer" } }));
});

// 14) Skripte (Funktionen) überstehen den Rundlauf; Werkzeugkasten für Skripte ohne Auslöser.
ok("skript", () => {
  const sdir = path.join(dir, "script");
  for (const f of fs.readdirSync(sdir).filter((x) => x.endsWith(".json"))) {
    const cfg = JSON.parse(fs.readFileSync(path.join(sdir, f), "utf8"));
    const r = toBlocks(cfg, "script");
    assert.strictEqual(r.type, "ha_script");
    assert.deepStrictEqual(HAB.blockToItem(r), cfg, `Skript ${f}`);
    // Name ändern, Rest bleibt
    r.setFieldValue("Neu", field(r, "alias"));
    assert.deepStrictEqual(HAB.blockToItem(r), { ...cfg, alias: "Neu" });
  }
  const neu = HAB.NEW_SCRIPT("Test");
  assert.deepStrictEqual(HAB.blockToItem(toBlocks(neu, "script")), neu);
  const names = HAB.buildToolbox("script").contents.map((c) => c.name);
  assert.ok(!names.includes("Auslöser") && names.includes("Skripte (Funktionen)"));
  HAB.hooks.scripts = () => [["script.licht", "Licht"], ["light.x", "kein Skript"]];
  const cat = HAB.buildToolbox("root").contents.find((c) => c.name === "Skripte (Funktionen)");
  const blocks = cat.contents.filter((x) => x.kind === "block");
  assert.deepStrictEqual(blocks.map((b) => b.extraState.raw), [{ action: "script.licht" }]);
  assert.deepStrictEqual(HAB.blockToItem(toBlocks(blocks[0].extraState.raw, "action")), { action: "script.licht" });
  HAB.hooks.scripts = () => [];
});

// 15) Blueprint-Automation: Eingaben als Felder (mit und ohne Metadaten), verlustfrei.
ok("blueprint", () => {
  const cfg = JSON.parse(fs.readFileSync(path.join(dir, "blueprint.json"), "utf8"));
  let r = toBlocks(cfg);
  assert.deepStrictEqual(HAB.blockToItem(r), cfg);
  r.setFieldValue("light.diele", field(r, "use_blueprint.input.motion_entity"));
  assert.strictEqual(HAB.blockToItem(r).use_blueprint.input.motion_entity, "light.diele");
  HAB.hooks.blueprintInputs = () => ({
    motion_entity: { name: "Bewegungsmelder", selector: { entity: { domain: "binary_sensor" } } },
    sec: { name: "Abschnitt", input: { no_motion_wait: { name: "Wartezeit", selector: { number: {} } }, extra: { name: "Neu", selector: { text: {} } } } },
  });
  r = toBlocks(cfg);
  assert.deepStrictEqual(HAB.blockToItem(r), cfg, "Blueprint mit Metadaten");
  assert.ok(r.fieldMap_.some((f) => f.path === "use_blueprint.input.extra"));
  r.setFieldValue("90", field(r, "use_blueprint.input.no_motion_wait"));
  assert.strictEqual(HAB.blockToItem(r).use_blueprint.input.no_motion_wait, 90);
  HAB.hooks.blueprintInputs = () => null;
  assert.deepStrictEqual(HAB.lint(cfg), []);
  assert.deepStrictEqual(HAB.references(cfg).map((x) => x.entity).sort(), ["binary_sensor.flur_bewegung", "light.flur"]);
});

// 16) Pfade wie in HA-Traces – aus der Konfiguration und aus den Blöcken identisch.
ok("pfade", () => {
  const cfg = JSON.parse(fs.readFileSync(path.join(dir, "licht_choose.json"), "utf8"));
  const fromCfg = [];
  HAB.walkConfig(cfg, "root", (item, kind, p) => fromCfg.push(p));
  const fromBlocks = [...HAB.collectPaths(toBlocks(cfg)).keys()];
  assert.deepStrictEqual(fromBlocks, fromCfg);
  assert.ok(fromCfg.includes("trigger/0") && fromCfg.includes("action/0"));
  const deep = { triggers: [{ trigger: "state", entity_id: "a.b" }], actions: [
    { choose: [{ conditions: [{ condition: "state", entity_id: "a.b", state: "on" }], sequence: [{ delay: 1 }] }], default: [{ delay: 2 }] },
    { if: [{ condition: "template", value_template: "{{ true }}" }], then: [{ delay: 3 }] },
    { repeat: { while: [{ condition: "state", entity_id: "a.b", state: "on" }], sequence: [{ delay: 4 }] } },
  ] };
  const ps = [...HAB.collectPaths(toBlocks(deep)).keys()];
  for (const p of ["action/0/choose/0", "action/0/choose/0/conditions/0", "action/0/choose/0/sequence/0", "action/0/default/0",
    "action/1/if/0", "action/1/then/0", "action/2/repeat/while/0", "action/2/repeat/sequence/0"]) assert.ok(ps.includes(p), p);
  const sp = [...HAB.collectPaths(toBlocks({ sequence: [{ delay: 1 }, { if: [], then: [{ delay: 2 }] }] }, "script")).keys()];
  assert.deepStrictEqual(sp, ["", "sequence/0", "sequence/1", "sequence/1/then/0"]);
});

// 17) Trigger-IDs und Prüfregeln.
ok("pruefregeln", () => {
  const cfg = {
    triggers: [{ trigger: "state", entity_id: "binary_sensor.b", to: "on", id: "an" }, { trigger: "state", entity_id: "binary_sensor.b", to: "off", for: { hours: 2 }, id: "aus" }],
    actions: [
      { choose: [{ conditions: [{ condition: "trigger", id: ["an", "tippfehler"] }], sequence: [{ delay: { minutes: 3 } }] }] },
      { if: [{ condition: "state", entity_id: "a.b", state: "on" }], then: [], else: [] },
    ],
  };
  assert.deepStrictEqual(HAB.triggerIds(cfg), ["an", "aus"]);
  const h = HAB.lint(cfg);
  const at = (p) => h.filter((x) => x.path === p).map((x) => x.msg).join(" | ");
  assert.match(at("action/0/choose/0/conditions/0"), /tippfehler/);
  assert.doesNotMatch(at("action/0/choose/0/conditions/0"), /„an“/);
  assert.match(at("trigger/1"), /Neustart/);
  assert.match(at("action/0/choose/0/sequence/0"), /single/);
  assert.match(at("action/1"), /keine Wirkung|ohne Aktionen/);
  assert.match(HAB.lint({ actions: [] }).map((x) => x.msg).join(), /keinen Auslöser/);
  // restart: kein single-Hinweis; kurze Wartezeit: kein Timer-Hinweis
  const ok2 = HAB.lint({ mode: "restart", triggers: [{ trigger: "time", at: "07:00:00" }], actions: [{ delay: { minutes: 3 } }] });
  assert.deepStrictEqual(ok2, []);
  assert.deepStrictEqual(HAB.lint({ sequence: [{ delay: "02:00:00" }] }, "script").map((x) => x.path), ["sequence/0"]);
  assert.strictEqual(HAB.durationSeconds("01:30:00"), 5400);
  assert.strictEqual(HAB.durationSeconds({ minutes: 2, seconds: 5 }), 125);
  assert.strictEqual(HAB.durationSeconds("{{ x }}"), null);
});

// 18) Trigger-ID-Feld bleibt verlustfrei (Text und Liste).
ok("trigger-id-feld", () => {
  for (const id of ["an", ["an", "aus"]]) {
    const c = { condition: "trigger", id };
    const b = toBlocks(c, "condition");
    assert.deepStrictEqual(HAB.blockToItem(b), c);
  }
  const b = toBlocks({ condition: "trigger", id: ["an"] }, "condition");
  b.setFieldValue("an, aus", field(b, "id"));
  assert.deepStrictEqual(HAB.blockToItem(b).id, ["an", "aus"]);
});

// 19) Querverweise: Rollen, Templates, Skript-Aufrufe.
ok("querverweise", () => {
  const cfg = {
    triggers: [{ trigger: "state", entity_id: ["binary_sensor.tuer", "binary_sensor.fenster"] }, { trigger: "numeric_state", entity_id: "sensor.t", above: "input_number.grenze" }],
    conditions: [{ condition: "template", value_template: "{{ is_state('person.anna', 'home') and states.sun.sun.state == 'below_horizon' }}" }],
    actions: [
      { action: "light.turn_on", target: { entity_id: "light.flur" }, data: { brightness: "{{ states('sensor.hell') | int }}" } },
      { action: "script.licht_szene", data: { raum: "flur" } },
      { action: "script.turn_on", target: { entity_id: "script.andere" } },
      { if: [{ condition: "state", entity_id: "input_boolean.x", state: "on" }], then: [{ scene: "scene.abend" }] },
    ],
  };
  const r = HAB.references(cfg);
  const has = (e, role) => r.some((x) => x.entity === e && x.role === role);
  assert.ok(has("binary_sensor.tuer", "trigger") && has("binary_sensor.fenster", "trigger"));
  assert.ok(has("input_number.grenze", "trigger"));
  assert.ok(has("person.anna", "condition") && has("sun.sun", "condition"));
  assert.ok(has("light.flur", "action") && has("sensor.hell", "action"));
  assert.ok(has("script.licht_szene", "call") && has("script.andere", "action"));
  assert.ok(has("input_boolean.x", "condition") && has("scene.abend", "action"));
  assert.ok(r.find((x) => x.entity === "scene.abend").path === "action/3/then/0");
  // Template-Bedingung in Kurzform (String)
  const s = HAB.references({ triggers: [], conditions: ["{{ is_state('light.a','on') }}"], actions: [] });
  assert.deepStrictEqual(s.map((x) => [x.entity, x.role, x.path]), [["light.a", "condition", "condition/0"]]);
});

// 20) Blockly-Modus: alles verlustfrei, alle Bausteine aus dem Werkzeugkasten, Geräte-Bausteine.
ok("blockly-modus", () => {
  HAB.hooks.blockly = true;
  HAB.hooks.services = () => [["light.turn_on", "Licht an"], ["light.turn_off", ""], ["notify.mobile_app_x", ""], ["script.abc", ""]];
  HAB.hooks.serviceTarget = (s) => s.startsWith("light.");
  try {
    for (const f of fs.readdirSync(dir).filter((x) => x.endsWith(".json"))) {
      const cfg = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
      assert.deepStrictEqual(HAB.blockToItem(toBlocks(cfg)), cfg, `Blockly-Modus: ${f}`);
    }
    const box = HAB.buildToolbox("root");
    const names = box.contents.map((c) => c.name);
    assert.ok(names.includes("Alle Dienste") && !names.includes("Roh-JSON"));
    const all = box.contents.find((c) => c.name === "Alle Dienste");
    assert.deepStrictEqual(all.contents.map((c) => c.contents.length).reduce((a, b) => a + b, 0), 4);
    const walk = (c) => (c.contents || []).flatMap((x) => (x.kind === "category" ? walk(x) : [x]));
    for (const item of walk(box).filter((x) => x.kind === "block" && x.extraState)) {
      const raw = item.extraState.raw;
      assert.deepStrictEqual(HAB.blockToItem(toBlocks(raw, item.type.slice(3))), raw, `Werkzeugkasten Blockly ${JSON.stringify(raw)}`);
    }
    // Ziel: Bereich wählbar, auch wenn noch nicht gesetzt
    const act = { action: "light.turn_on", target: { entity_id: "light.a" } };
    let b = toBlocks(act, "action");
    b.setFieldValue("wohnzimmer", field(b, "target.area_id"));
    assert.deepStrictEqual(HAB.blockToItem(b), { action: "light.turn_on", target: { entity_id: "light.a", area_id: "wohnzimmer" } });
    // Bereichsliste bleibt Liste
    const act2 = { action: "light.turn_on", target: { area_id: ["a", "b"] } };
    assert.deepStrictEqual(HAB.blockToItem(toBlocks(act2, "action")), act2);
    // Geräte-Auslöser: neue Art wählen ersetzt den Inhalt, ID/alias bleiben
    const dt = { trigger: "device", device_id: "dev1", domain: "zha", type: "remote_button_short_press", subtype: "turn_on", id: "knopf" };
    b = toBlocks(dt, "trigger");
    assert.deepStrictEqual(HAB.blockToItem(b), dt);
    const entry = { platform: "device", device_id: "dev1", domain: "zha", type: "remote_button_long_press", subtype: "turn_off", metadata: {} };
    HAB.hooks.deviceEntry = (k) => (k === HAB.devKey(entry) ? entry : null);
    b.setFieldValue(HAB.devKey(entry), field(b, "__devauto"));
    assert.deepStrictEqual(HAB.blockToItem(b), { id: "knopf", trigger: "device", device_id: "dev1", domain: "zha", type: "remote_button_long_press", subtype: "turn_off" });
    // Geräte-Aktion aus dem Werkzeugkasten: zunächst unvollständig (Hinweis), dann gefüllt
    assert.ok(HAB.missingInfo({ device_id: "" }));
    assert.ok(HAB.missingInfo({ trigger: "device", device_id: "dev1" }));
    assert.ok(!HAB.missingInfo(dt));
    // Skript: Eingaben im Blockly-Modus immer bearbeitbar
    const sc = toBlocks(HAB.NEW_SCRIPT("x"), "script");
    assert.ok(sc.fieldMap_.some((f) => f.path === "fields"));
  } finally {
    HAB.hooks.blockly = false;
    HAB.hooks.services = () => [];
    HAB.hooks.serviceTarget = () => null;
    HAB.hooks.deviceEntry = () => null;
  }
});

// 21) Wert-Bausteine: Template erzeugen, wieder einlesen, ändern, entfernen.
ok("wert-bausteine", () => {
  const HAV = HAB.HAV;
  const tree = { k: "cmp", f: { op: ">" }, a: [{ k: "statenum", f: { e: "sensor.t" } }, { k: "num", f: { n: 20 } }] };
  const tpl = HAV.compile(tree);
  assert.ok(tpl.startsWith("{{ (states('sensor.t') | float(0)) > (20) }}{#hab:"), tpl);
  assert.deepStrictEqual(HAV.decode(tpl), tree);
  assert.strictEqual(HAV.decode("{{ states('x') }}"), null, "fremdes Template bleibt Text");
  assert.strictEqual(HAV.decode(tpl.replace("20", "21")), null, "von Hand geändert -> Text");
  assert.strictEqual(HAV.expr({ k: "txt", f: { s: "it's \\ ok" } }), "'it\\'s \\\\ ok'");
  assert.strictEqual(HAV.expr({ k: "join", a: [{ k: "txt", f: { s: "Temp: " } }, null] }), "('Temp: ') ~ (none)");
  assert.strictEqual(HAV.expr({ k: "var", f: { v: "x; drop" } }), "none");
  HAB.hooks.blockly = true;
  try {
    const cfg = {
      triggers: [{ trigger: "state", entity_id: "sensor.t" }],
      conditions: [{ condition: "template", value_template: tpl }],
      actions: [{ action: "notify.notify", data: { message: HAV.compile({ k: "join", a: [{ k: "txt", f: { s: "Temp: " } }, { k: "state", f: { e: "sensor.t" } }] }), title: "{{ handgeschrieben }}" } }],
    };
    const r = toBlocks(cfg);
    assert.deepStrictEqual(HAB.blockToItem(r), cfg, "verlustfrei mit Wert-Bausteinen");
    const cond = child(r, "L1");
    const vin = cond.fieldMap_.find((x) => x.path === "value_template").vin;
    const vb = cond.getInputTargetBlock(vin);
    assert.ok(vb && vb.type === "ha_v_cmp", "Bedingung als Bausteine");
    assert.strictEqual(cond.getField(cond.fieldMap_.find((x) => x.path === "value_template").name).isVisible(), false);
    // Zahl ändern -> neues Template
    vb.getInputTargetBlock("B").setFieldValue(25, "n");
    assert.match(HAB.blockToItem(r).conditions[0].value_template, /^\{\{ \(states\('sensor\.t'\) \| float\(0\)\) > \(25\) \}\}/);
    // handgeschriebenes Template bleibt Textfeld
    const act = child(r, "L2");
    const tm = act.fieldMap_.find((x) => x.path === "data.title");
    assert.ok(tm.vin && !act.getInputTargetBlock(tm.vin));
    // Baustein entfernen -> Feld wird leer -> Wert entfällt
    vb.unplug(false);
    cond.onchange();
    assert.ok(!("value_template" in HAB.blockToItem(r).conditions[0]) || HAB.blockToItem(r).conditions[0].value_template === undefined);
    // Neuer Wert-Baustein in ein leeres Datenfeld
    const act2 = toBlocks({ action: "light.turn_on", data: { brightness_pct: 50 } }, "action");
    const bm = act2.fieldMap_.find((x) => x.path === "data.brightness_pct");
    const nb = Blockly.serialization.blocks.append(HAV.treeToBlockJson({ k: "statenum", f: { e: "input_number.h" } }), ws);
    act2.getInput(bm.vin).connection.connect(nb.outputConnection);
    const out = HAB.blockToItem(act2).data.brightness_pct;
    assert.ok(out.startsWith("{{ states('input_number.h') | float(0) }}") && HAV.decode(out));
    // Ohne Blockly-Modus: Templates bleiben einfach Text (verlustfrei)
    HAB.hooks.blockly = false;
    assert.deepStrictEqual(HAB.blockToItem(toBlocks(cfg)), cfg);
  } finally {
    HAB.hooks.blockly = false;
  }
});

// 22) YAML-Ansicht.
ok("yaml", () => {
  const y = HAB.toYaml({ alias: "Test", triggers: [{ trigger: "state", entity_id: ["a.b", "c.d"], to: "on" }], conditions: [], data: { message: "Hallo: Welt", n: 3, on: true, t: "{{ x }}" } });
  assert.strictEqual(y, [
    "alias: Test",
    "triggers:",
    "  - trigger: state",
    "    entity_id:",
    "      - a.b",
    "      - c.d",
    '    to: "on"',
    "conditions: []",
    "data:",
    '  message: "Hallo: Welt"',
    "  n: 3",
    "  \"on\": true",
    '  t: "{{ x }}"',
  ].join("\n"));
});

// 23) Als Skript auslagern: Auslöser-Daten und Variablen werden übergeben, Verhalten bleibt gleich.
ok("skript-auslagern", () => {
  const HAV = HAB.HAV;
  const tplTree = { k: "join", a: [{ k: "txt", f: { s: "Neu: " } }, { k: "trig", f: { w: "trigger.to_state.state" } }] };
  const items = [
    { action: "notify.notify", data: { message: "{{ trigger.to_state.name }} ist {{ trigger.to_state.state }} ({{ grenze }})", title: HAV.compile(tplTree) } },
    { choose: [{ conditions: [{ condition: "trigger", id: ["an", "1"], alias: "an?" }], sequence: [{ delay: 1 }] }] },
    { variables: { intern: 5 } },
    { action: "light.turn_on", data: { brightness_pct: "{{ intern }}" } },
    { repeat: { count: 2, sequence: [{ action: "logbook.log", data: { message: "{{ repeat.index }}" } }] } },
    { action: "logbook.log", data: { message: "'trigger.id' bleibt Text, {{ unbekannt }} bleibt" } },
  ];
  const plan = HAB.planExtract(items, ["grenze", "intern", "nicht_genutzt"]);
  // Übergabe: genau die genutzten Werte
  assert.deepStrictEqual(Object.keys(plan.data).sort(), ["grenze", "trigger_id", "trigger_to_state_name", "trigger_to_state_state"]);
  assert.strictEqual(plan.data.trigger_to_state_state, "{{ trigger.to_state.state }}");
  assert.strictEqual(plan.data.grenze, "{{ grenze }}");
  assert.deepStrictEqual(Object.keys(plan.fields).sort(), Object.keys(plan.data).sort());
  // Umschreiben im Skript
  assert.strictEqual(plan.sequence[0].data.message, "{{ trigger_to_state_name }} ist {{ trigger_to_state_state }} ({{ grenze }})");
  const t = HAV.decode(plan.sequence[0].data.title);
  assert.ok(t, "Wert-Bausteine bleiben Bausteine");
  assert.deepStrictEqual(t.a[1], { k: "var", f: { v: "trigger_to_state_state" } });
  assert.deepStrictEqual(plan.sequence[1].choose[0].conditions[0], { condition: "template", value_template: "{{ (trigger_id | string) in ['an', '1'] }}", alias: "an?" });
  // Eigene Variablen und repeat innerhalb der Schritte bleiben intern
  assert.strictEqual(plan.sequence[3].data.brightness_pct, "{{ intern }}");
  assert.strictEqual(plan.sequence[4].repeat.sequence[0].data.message, "{{ repeat.index }}");
  assert.strictEqual(plan.sequence[5].data.message, "'trigger.id' bleibt Text, {{ unbekannt }} bleibt");
  assert.ok(plan.notes.some((n) => /intern/.test(n)));
  // Ohne Bezüge: nichts zu übergeben
  const p2 = HAB.planExtract([{ action: "light.turn_on", target: { entity_id: "light.a" } }], ["x"]);
  assert.deepStrictEqual([p2.fields, p2.data, p2.notes], [{}, {}, []]);
  // repeat.index außerhalb der Schritte wird übergeben
  const p3 = HAB.planExtract([{ action: "logbook.log", data: { message: "{{ repeat.index }}" } }]);
  assert.deepStrictEqual(p3.data, { repeat_index: "{{ repeat.index }}" });
  assert.strictEqual(p3.sequence[0].data.message, "{{ repeat_index }}");
});

// 24) Prüfregel „Entität gibt es nicht“ mit Korrekturen per Klick.
ok("korrekturen", () => {
  const HAV = HAB.HAV;
  HAB.hooks.entityExists = (e) => ["light.flur", "binary_sensor.flur_bewegung"].includes(e);
  HAB.hooks.entityIds = () => ["light.flur", "binary_sensor.flur_bewegung", "light.bad"];
  try {
    const tpl = HAV.compile({ k: "state", f: { e: "light.flr" } });
    const cfg = {
      triggers: [{ trigger: "state", entity_id: "binary_sensor.flur_bewegng", to: "on", id: "ruhe" }],
      actions: [
        { delay: { minutes: 1 } },
        { if: [{ condition: "trigger", id: "ruh" }], then: [{ action: "light.turn_on", target: { entity_id: "light.flr" }, data: { a: "{{ is_state('light.flr', 'on') }}", b: tpl } }] },
        { action: "light.turn_on", target: { entity_id: "light.gibtsnicht_ganz_anders" } },
      ],
    };
    const hints = HAB.lint(cfg);
    const msgs = hints.map((h) => h.msg).join(" | ");
    assert.match(msgs, /binary_sensor\.flur_bewegng/);
    assert.match(msgs, /light\.flr/);
    assert.match(msgs, /gibtsnicht_ganz_anders/);
    const noFix = hints.find((h) => /gibtsnicht/.test(h.msg));
    assert.ok(!noFix.fix, "kein Vorschlag, wenn nichts Ähnliches existiert");
    let c = cfg;
    for (const h of hints) if (h.fix) c = h.fix.apply(c);
    assert.strictEqual(c.triggers[0].entity_id, "binary_sensor.flur_bewegung");
    assert.strictEqual(c.actions[1].if[0].id, "ruhe");
    assert.strictEqual(c.actions[1].then[0].target.entity_id, "light.flur");
    assert.strictEqual(c.actions[1].then[0].data.a, "{{ is_state('light.flur', 'on') }}");
    assert.deepStrictEqual(HAV.decode(c.actions[1].then[0].data.b), { k: "state", f: { e: "light.flur" } });
    assert.strictEqual(c.mode, "restart");
    assert.deepStrictEqual(cfg.triggers[0].entity_id, "binary_sensor.flur_bewegng", "Original unverändert");
    assert.deepStrictEqual(HAB.lint(c).map((h) => h.msg), [hints.find((h) => /gibtsnicht/.test(h.msg)).msg]);
    // unbekannt (keine HA-Daten) -> keine Warnung
    HAB.hooks.entityExists = () => null;
    assert.ok(!HAB.lint(cfg).some((h) => /gibt es in Home Assistant nicht/.test(h.msg)));
  } finally {
    HAB.hooks.entityExists = () => null;
    HAB.hooks.entityIds = () => [];
  }
});

// 25) Trockenlauf: richtiger Weg, nicht prüfbare Bedingungen, Stopp bei NUR WENN.
const dry = (async () => {
  const cfg = {
    triggers: [{ trigger: "state", entity_id: "a.b", id: "an" }, { trigger: "state", entity_id: "a.b", id: "aus" }],
    conditions: [{ condition: "state", entity_id: "x.y", state: "on" }],
    actions: [
      { choose: [
        { conditions: [{ condition: "trigger", id: "an" }], sequence: [{ action: "light.turn_on" }] },
        { conditions: [{ condition: "trigger", id: "aus" }], sequence: [{ action: "light.turn_off" }, { delay: 5 }] },
      ], default: [{ action: "x.y" }] },
      { if: [{ condition: "template", value_template: "{{ x }}" }], then: [{ action: "a.a" }], else: [{ action: "b.b" }] },
      { condition: "state", entity_id: "z.z", state: "off" },
      { action: "nie.erreicht" },
    ],
  };
  const test = async (c) => (c.condition === "template" ? null : c.entity_id !== "z.z");
  let r = await HAB.dryRun(cfg, "root", test, { index: 1, id: "aus" });
  const k = Object.keys(r.steps);
  assert.ok(k.includes("trigger/1") && !k.includes("trigger/0"));
  assert.ok(k.includes("action/0/choose/1/sequence/1") && !k.includes("action/0/choose/0/sequence/0") && !k.includes("action/0/default/0"));
  assert.deepStrictEqual(r.steps["action/1/if/0"], [{ unknown: true }]);
  assert.ok(k.includes("action/1/then/0") && !k.includes("action/1/else/0"));
  assert.deepStrictEqual(r.steps["action/2"], [{ result: { result: false } }]);
  assert.ok(!k.includes("action/3"), "nach falscher Bedingung ist Schluss");
  assert.ok(r.log.some((x) => /warten/.test(x)));
  // NUR WENN nicht erfüllt -> keine Aktionen
  r = await HAB.dryRun(cfg, "root", async () => false, { index: 0, id: "an" });
  assert.ok(!Object.keys(r.steps).some((p) => p.startsWith("action/")));
  // Pfade passen zu den Blöcken
  const paths = new Set(HAB.collectPaths(toBlocks(cfg)).keys());
  r = await HAB.dryRun(cfg, "root", async () => true, { index: 0, id: "an" });
  for (const p of Object.keys(r.steps)) assert.ok(paths.has(p), `Pfad ${p} gibt es als Baustein`);
  // Skript
  r = await HAB.dryRun({ sequence: [{ action: "a.a" }, { stop: "fertig" }, { action: "b.b" }] }, "script", async () => true);
  assert.deepStrictEqual(Object.keys(r.steps), ["sequence/0", "sequence/1"]);
  n++;
})();

// 13) Versionsnummern stimmen überein (manifest, package.json, version.json).
ok("version", () => {
  const read = (...p) => JSON.parse(fs.readFileSync(path.join(__dirname, "..", ...p), "utf8")).version;
  const m = read("custom_components", "blockly_automations", "manifest.json");
  assert.strictEqual(read("package.json"), m);
  assert.strictEqual(read("custom_components", "blockly_automations", "www", "version.json"), m);
});

dry.then(() => console.log(`OK – ${n} Prüfungen bestanden`)).catch((e) => { console.error(e); process.exit(1); });
