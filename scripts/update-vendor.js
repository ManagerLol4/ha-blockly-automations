// Kopiert Blockly aus node_modules nach www/vendor (nach "npm install").
const fs = require("fs");
const path = require("path");

const src = path.dirname(require.resolve("blockly/package.json"));
const dst = path.join(__dirname, "..", "custom_components", "blockly_automations", "www", "vendor");
fs.mkdirSync(dst, { recursive: true });
fs.copyFileSync(path.join(src, "blockly_compressed.js"), path.join(dst, "blockly_compressed.js"));
fs.copyFileSync(path.join(src, "msg", "de.js"), path.join(dst, "msg_de.js"));
fs.copyFileSync(path.join(src, "msg", "en.js"), path.join(dst, "msg_en.js"));
fs.copyFileSync(path.join(src, "LICENSE"), path.join(dst, "BLOCKLY_LICENSE.txt"));
fs.cpSync(path.join(src, "media"), path.join(dst, "media"), { recursive: true });
console.log("Blockly", require("blockly/package.json").version, "->", dst);
