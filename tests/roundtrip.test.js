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

console.log(`OK – ${n} Prüfungen bestanden`);
