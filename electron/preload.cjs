// Preload keeps contextIsolation on; expose nothing unless needed later.
const { contextBridge } = require("electron");

contextBridge.exposeInMainWorld("auraDesktop", {
  isDesktop: true,
});
