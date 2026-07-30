/* SPDX-License-Identifier: CC-BY-NC-SA-4.0 */

(() => {
  "use strict";

  const extensionApi = globalThis.browser ?? globalThis.chrome;
  const status = document.querySelector("#desktop-launcher-status");

  async function launch() {
    const availableWidth = Math.max(900, Number(screen.availWidth) || 1440);
    const availableHeight = Math.max(700, Number(screen.availHeight) || 900);
    const width = Math.min(1500, availableWidth);
    const height = Math.min(1000, availableHeight);
    const left = Math.max(0, Math.round((Number(screen.availLeft) || 0) + (availableWidth - width) / 2));
    const top = Math.max(0, Math.round((Number(screen.availTop) || 0) + (availableHeight - height) / 2));

    await extensionApi.windows.create({
      url: extensionApi.runtime.getURL("manager.html"),
      type: "popup",
      width,
      height,
      left,
      top,
      focused: true
    });

    const currentTab = await extensionApi.tabs.getCurrent?.();
    if (currentTab?.id != null) {
      await extensionApi.tabs.remove(currentTab.id);
    } else {
      window.close();
    }
  }

  launch().catch((error) => {
    status.textContent = `Smart Citations could not open: ${error?.message || String(error)}`;
  });
})();
