/**
 * Renderer bridge for the desktop window.
 *
 * The web UI is the same page in a browser and in the packaged app; this
 * preload adds only the things a browser cannot do. Keep it a CommonJS file —
 * a sandboxed Electron preload is loaded as plain JavaScript, not as an ES
 * module.
 */
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("agentfabric", {
  /** Opens the native macOS folder chooser; resolves to null when cancelled. */
  pickDirectory: (defaultPath) => ipcRenderer.invoke("agentfabric:pick-directory", defaultPath),
});
