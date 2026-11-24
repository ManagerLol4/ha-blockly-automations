// Kopiert Blockly aus node_modules nach www/vendor (nach "npm install").
const fs = require("fs");
const path = require("path");

// Direkt aus node_modules (neuere Pakete erlauben require("x/package.json") nicht mehr).
const mod = (name) => path.join(__dirname, "..", "node_modules", ...name.split("/"));
const pkg = (name) => JSON.parse(fs.readFileSync(path.join(mod(name), "package.json"), "utf8"));
const src = mod("blockly");
const dst = path.join(__dirname, "..", "custom_components", "blockly_automations", "www", "vendor");
fs.mkdirSync(dst, { recursive: true });
fs.copyFileSync(path.join(src, "blockly_compressed.js"), path.join(dst, "blockly_compressed.js"));
fs.copyFileSync(path.join(src, "msg", "de.js"), path.join(dst, "msg_de.js"));
fs.copyFileSync(path.join(src, "msg", "en.js"), path.join(dst, "msg_en.js"));
fs.copyFileSync(path.join(src, "LICENSE"), path.join(dst, "BLOCKLY_LICENSE.txt"));
fs.cpSync(path.join(src, "media"), path.join(dst, "media"), { recursive: true });
// Plugins (Apache-2.0): Suche im Werkzeugkasten, Kopieren zwischen Automationen, Rucksack.
const PLUGINS = ["toolbox-search", "plugin-cross-tab-copy-paste", "workspace-backpack"];
fs.mkdirSync(path.join(dst, "plugins"), { recursive: true });
for (const p of PLUGINS) {
  const dir = mod(`@blockly/${p}`);
  fs.copyFileSync(path.join(dir, "dist", "index.js"), path.join(dst, "plugins", `${p}.js`));
  console.log(`@blockly/${p}`, pkg(`@blockly/${p}`).version);
}
console.log("Blockly", pkg("blockly").version, "->", dst);
