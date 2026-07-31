/* SPDX-License-Identifier: CC-BY-NC-SA-4.0 */

(() => {
  "use strict";

  const extensionApi = globalThis.browser ?? globalThis.chrome;
  const browserHeading = document.querySelector("#ctca-browser-heading");
  const instruction = document.querySelector("#ctca-pin-instruction");
  const statusSymbol = document.querySelector(".status-symbol");
  const statusCopy = document.querySelector(".status-copy");
  const checkButton = document.querySelector("#ctca-check-pin");
  const dismissButton = document.querySelector("#ctca-dismiss");
  const openManagerButton = document.querySelector("#ctca-open-manager");
  let pinned = false;

  async function browserFamily() {
    if (extensionApi.runtime.getBrowserInfo) {
      try {
        const info = await extensionApi.runtime.getBrowserInfo();
        if (/firefox/i.test(info?.name || "")) return "firefox";
      } catch (_error) {}
    }
    if (/\bEdg\//i.test(navigator.userAgent)) return "edge";
    if (/\bFirefox\//i.test(navigator.userAgent)) return "firefox";
    return "chrome";
  }

  async function configureInstructions() {
    const family = await browserFamily();
    if (family === "firefox") {
      browserHeading.textContent = "Open Firefox’s Extensions menu";
      instruction.textContent = "Select the gear beside Smart Citations, then choose “Pin to Toolbar”.";
      return;
    }
    if (family === "edge") {
      browserHeading.textContent = "Open Edge’s Extensions menu";
      instruction.textContent = "Click the eye beside Smart Citations so it is shown in the toolbar.";
      return;
    }
    browserHeading.textContent = "Open Chrome’s Extensions menu";
    instruction.textContent = "Click the pin beside Smart Citations so it stays visible in the toolbar.";
  }

  async function getPinnedState() {
    const actionApi = extensionApi.action || extensionApi.browserAction;
    if (!actionApi?.getUserSettings) return false;
    try {
      return Boolean((await actionApi.getUserSettings())?.isOnToolbar);
    } catch (_error) {
      return false;
    }
  }

  async function refreshPinnedState({ userRequested = false } = {}) {
    pinned = await getPinnedState();
    document.body.classList.toggle("ctca-pinned", pinned);
    statusSymbol.textContent = pinned ? "✓" : "○";
    statusCopy.textContent = pinned
      ? "Pinned — your reference manager is now one click away."
      : "Waiting for Smart Citations to be pinned…";
    checkButton.textContent = pinned ? "Done" : "Check again";
    if (!pinned && userRequested) {
      document.body.classList.remove("ctca-check-failed");
      void document.body.offsetWidth;
      document.body.classList.add("ctca-check-failed");
    }
    return pinned;
  }

  checkButton.addEventListener("click", async () => {
    if (pinned) {
      window.close();
      return;
    }
    checkButton.disabled = true;
    await refreshPinnedState({ userRequested: true });
    checkButton.disabled = false;
  });

  dismissButton.addEventListener("click", () => window.close());

  openManagerButton.addEventListener("click", async () => {
    openManagerButton.disabled = true;
    try {
      await extensionApi.runtime.sendMessage({ type: "ctca-open-standalone-manager" });
      window.close();
    } catch (_error) {
      openManagerButton.disabled = false;
    }
  });

  const actionApi = extensionApi.action || extensionApi.browserAction;
  actionApi?.onUserSettingsChanged?.addListener?.(() => {
    refreshPinnedState().catch(() => {});
  });

  const pollTimer = window.setInterval(() => {
    refreshPinnedState().catch(() => {});
  }, 1200);
  window.addEventListener("pagehide", () => window.clearInterval(pollTimer), { once: true });

  Promise.all([configureInstructions(), refreshPinnedState()]).catch(() => {});
})();
