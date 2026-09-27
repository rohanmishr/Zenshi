const {
  contextBridge,
  ipcRenderer
} = require("electron");

contextBridge.exposeInMainWorld("desktopAPI", {
  fetchYouTubeInfo: (url) =>
    ipcRenderer.invoke("fetch-youtube-info", url),

  downloadQueue: (options) =>
    ipcRenderer.invoke(
      "download-youtube-queue",
      options
    )
});