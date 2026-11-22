// Setzt die Versionsnummer überall gleich: node scripts/bump.js 0.4.1
// (manifest.json, package.json, www/version.json)
const fs = require("fs");
const path = require("path");

const v = process.argv[2];
if (!/^\d+\.\d+\.\d+$/.test(v || "")) {
  console.error("Aufruf: node scripts/bump.js <x.y.z>");
  process.exit(1);
}
const root = path.join(__dirname, "..");
const files = [
  path.join(root, "custom_components", "blockly_automations", "manifest.json"),
  path.join(root, "package.json"),
  path.join(root, "custom_components", "blockly_automations", "www", "version.json"),
];
for (const f of files) {
  const text = fs.readFileSync(f, "utf8");
  if (!text.trim()) throw new Error(`Datei ist leer: ${f}`);
  const data = JSON.parse(text);
  data.version = v;
  fs.writeFileSync(f, JSON.stringify(data, null, 2) + "\n");
  console.log(`${path.relative(root, f)} -> ${v}`);
}
