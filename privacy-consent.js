/* SPDX-License-Identifier: CC-BY-NC-SA-4.0 */

(() => {
  "use strict";

  const extensionApi = globalThis.browser ?? globalThis.chrome;
  const CONSENT_KEY = "collabtex-citation-assistant:privacy-consent:v1";
  let acceptancePromise = null;

  async function hasAccepted() {
    const stored = await extensionApi.storage.local.get(CONSENT_KEY);
    return stored?.[CONSENT_KEY]?.accepted === true;
  }

  function createOverlay() {
    const overlay = document.createElement("div");
    overlay.id = "ctca-privacy-consent";
    overlay.innerHTML = `
      <section class="ctca-privacy-consent-card" role="dialog" aria-modal="true" aria-labelledby="ctca-privacy-consent-title" aria-describedby="ctca-privacy-consent-description">
        <h2 id="ctca-privacy-consent-title">Privacy and data protection</h2>
        <div id="ctca-privacy-consent-description">
          <p>Smart Citations does not transfer your data beyond this computer or a synchronization destination you choose.</p>
          <p>Please review and accept the <a href="https://www.smartioz.com/smartcitations/dataprotection.php" target="_blank" rel="noopener noreferrer">Datenschutzerklärung</a> to continue.</p>
          <p>The Impressum and Data protection/Datenschutzerklärung links are always available on the <a class="ctca-privacy-options-link" href="#">extension’s options page</a>.</p>
        </div>
        <label class="ctca-privacy-consent-check">
          <input type="checkbox">
          <span>I have read and accept the Datenschutzerklärung.</span>
        </label>
        <div class="ctca-privacy-consent-actions">
          <button type="button" class="ctca-privacy-consent-accept" disabled>Accept and continue</button>
        </div>
        <div class="ctca-privacy-consent-error" role="alert"></div>
      </section>
    `;
    return overlay;
  }

  function requestAcceptance() {
    return new Promise((resolve) => {
      const overlay = createOverlay();
      const card = overlay.querySelector(".ctca-privacy-consent-card");
      const checkbox = overlay.querySelector("input[type='checkbox']");
      const acceptButton = overlay.querySelector(".ctca-privacy-consent-accept");
      const optionsLink = overlay.querySelector(".ctca-privacy-options-link");
      const errorElement = overlay.querySelector(".ctca-privacy-consent-error");

      optionsLink.href = extensionApi.runtime.getURL("options.html");
      checkbox.addEventListener("change", () => {
        acceptButton.disabled = !checkbox.checked;
      });
      acceptButton.addEventListener("click", async () => {
        if (!checkbox.checked) return;
        acceptButton.disabled = true;
        errorElement.textContent = "";
        try {
          await extensionApi.storage.local.set({
            [CONSENT_KEY]: {
              accepted: true,
              acceptedAt: new Date().toISOString()
            }
          });
          overlay.remove();
          resolve();
        } catch (error) {
          errorElement.textContent = `Your acceptance could not be saved: ${error?.message || String(error)}`;
          acceptButton.disabled = false;
        }
      });

      overlay.addEventListener("keydown", (event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          return;
        }
        if (event.key !== "Tab") return;
        const focusable = [...card.querySelectorAll("a[href], input:not(:disabled), button:not(:disabled)")];
        if (!focusable.length) return;
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first.focus();
        }
      });

      (document.body || document.documentElement).appendChild(overlay);
      checkbox.focus();
    });
  }

  async function ensureAccepted() {
    if (!acceptancePromise) {
      acceptancePromise = (async () => {
        if (await hasAccepted()) return;
        await requestAcceptance();
      })().catch((error) => {
        acceptancePromise = null;
        throw error;
      });
    }
    return acceptancePromise;
  }

  globalThis.SmartCitationsPrivacy = Object.freeze({
    CONSENT_KEY,
    ensureAccepted
  });
})();
