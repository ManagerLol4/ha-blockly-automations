// Lader für das Panel. HA lädt diese Datei nur einmal pro Neustart; die
// eigentliche Logik (panel-main.js) und der Editor werden mit der aktuellen
// Versionsnummer aus version.json geladen. So greifen Updates ohne Neustart.
const base = new URL(".", import.meta.url).pathname.replace(/\/$/, "");
let version = String(Date.now());
try {
  const r = await fetch(`${base}/version.json`, { cache: "no-store" });
  if (r.ok) version = (await r.json()).version || version;
} catch (e) {
  /* ohne Versionsdatei: immer frisch laden */
}
window.__haBlocklyVersion = version;
await import(`${base}/panel-main.js?v=${encodeURIComponent(version)}`);
