// Rundlauf-Test ohne Browser: node tests/roundtrip.test.js
// Benötigt einmalig: npm install (installiert blockly als Dev-Abhängigkeit)
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const Blockly = require("blockly/core");
const HAB = require("../custom_components/blockly_automations/www/ha_blocks.js");

HAB.defineBlocks(Blockly);

function toBlocks(cfg) {
  const ws = new Blockly.Workspace();
  Blockly.serialization.workspaces.load(
    { blocks: { languageVersion: 0, blocks: [HAB.itemToBlockJson("root", cfg)] } },
    ws
  );
  return ws;
}
const root = (ws) => ws.getBlocksByType("ha_root", false)[0];

const dir = path.join(__dirname, "fixtures");
let n = 0;
for (const f of fs.readdirSync(dir).filter((x) => x.endsWith(".json"))) {
  const cfg = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
  const ws = toBlocks(cfg);
  const back = HAB.blockToItem(root(ws));
  assert.deepStrictEqual(back, cfg, `Rundlauf nicht identisch: ${f}`);
  assert.deepStrictEqual(Object.keys(back), Object.keys(cfg), `Schlüsselreihenfolge: ${f}`);
  n++;
}

// Bearbeiten: Uhrzeit eines Zeit-Auslösers ändern, sonst nichts.
{
  const cfg = JSON.parse(fs.readFileSync(path.join(dir, "zeitplan.json"), "utf8"));
  const ws = toBlocks(cfg);
  const trig = root(ws).getInputTargetBlock("L0");
  const name = trig.fieldMap_.find((x) => x.path === "at").name;
  trig.setFieldValue("07:30:00", name);
  const back = HAB.blockToItem(root(ws));
  const expected = JSON.parse(JSON.stringify(cfg));
  expected.triggers[0].at = "07:30:00";
  assert.deepStrictEqual(back, expected);
  n++;
}

// Bearbeiten: Entität einer Aktion ändern, Zahlentyp bleibt erhalten.
{
  const cfg = { alias: "x", triggers: [{ trigger: "numeric_state", entity_id: "sensor.a", above: 30 }],
    actions: [{ action: "light.turn_on", target: { entity_id: "light.a" }, data: { brightness_pct: 50 } }] };
  const ws = toBlocks(cfg);
  const act = root(ws).getInputTargetBlock("L2");
  const f = act.fieldMap_.find((x) => x.path === "target.entity_id");
  act.setFieldValue("light.b", f.name);
  const t = root(ws).getInputTargetBlock("L0");
  t.setFieldValue("31", t.fieldMap_.find((x) => x.path === "above").name);
  const back = HAB.blockToItem(root(ws));
  assert.strictEqual(back.actions[0].target.entity_id, "light.b");
  assert.strictEqual(back.actions[0].data.brightness_pct, 50);
  assert.strictEqual(back.triggers[0].above, 31);
  assert.ok(!("conditions" in back), "nicht vorhandene Liste darf nicht entstehen");
  n++;
}

console.log(`OK – ${n} Prüfungen bestanden`);
