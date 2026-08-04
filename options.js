/* SPDX-License-Identifier: CC-BY-NC-SA-4.0 */

(() => {
  "use strict";

  const extensionApi = globalThis.browser ?? globalThis.chrome;
  const SETTINGS_KEY = "collabtex-citation-assistant:manuscript-links:v1";
  const EDITOR_SITES_KEY = "collabtex-citation-assistant:editor-sites:v1";
  const defaults = {
    pagePatterns: ["*.nature.com"],
    preferredAction: "ask",
    editorSites: [
      "collabtex.helmholtz.cloud",
      "overleaf.com",
      "*.overleaf.com"
    ]
  };
  const builtInEditorSites = new Set(defaults.editorSites);
  const form = document.querySelector("#ctca-options-form");
  const userName = document.querySelector("#ctca-user-name");
  const authorNameSettings = document.querySelector("#ctca-author-name-settings");
  const orcidLinkState = document.querySelector("#ctca-orcid-link-state");
  const orcidCheckRow = document.querySelector("#ctca-orcid-check-row");
  const authorInstitutions = document.querySelector("#ctca-author-institutions");
  const linkOrcid = document.querySelector("#ctca-link-orcid");
  const unlinkOrcid = document.querySelector("#ctca-unlink-orcid");
  const checkOrcid = document.querySelector("#ctca-check-orcid");
  const openAlexApiKey = document.querySelector("#ctca-openalex-api-key");
  const openAlexAuthorId = document.querySelector("#ctca-openalex-author-id");
  const patterns = document.querySelector("#ctca-page-patterns");
  const editorSites = document.querySelector("#ctca-editor-sites");
  const preferredAction = document.querySelector("#ctca-preferred-action");
  const showBibWriteSuccessBanner = document.querySelector("#ctca-show-bib-write-success-banner");
  const status = document.querySelector("#ctca-options-status");
  const desktopLauncherContent = document.querySelector("#ctca-desktop-launcher-content");
  let loadedSettings = {};

  function showLinkedOrcidControls(linked) {
    authorNameSettings.hidden = linked;
    linkOrcid.hidden = linked;
    unlinkOrcid.hidden = !linked;
    orcidCheckRow.hidden = !linked;
  }

  function institutionLines() {
    return authorInstitutions.value
      .split(/\r?\n/)
      .map((value) => value.trim())
      .filter(Boolean);
  }

  function normalizeJournalSitePattern(value) {
    return String(value || "").trim().replace(/\/+$/, "");
  }

  function journalSitePatternsFromForm() {
    return [...new Set(
      patterns.value
        .split(/\r?\n/)
        .map(normalizeJournalSitePattern)
        .filter((value) => value && !value.startsWith("#"))
    )];
  }

  function normalizeEditorSiteDomain(value) {
    let domain = String(value || "").trim().replace(/\/+$/, "");
    if (!domain || domain.startsWith("#")) return "";
    domain = domain.replace(/^[a-z][a-z\d+.-]*:\/\//i, "");
    domain = domain.split(/[/?#]/, 1)[0].replace(/\.$/, "").toLowerCase();
    if (domain.startsWith("*.")) {
      const suffix = domain.slice(2);
      return /^[a-z\d](?:[a-z\d.-]*[a-z\d])?$/i.test(suffix) ? `*.${suffix}` : "";
    }
    return /^[a-z\d](?:[a-z\d.-]*[a-z\d])?$/i.test(domain) ? domain : "";
  }

  function editorSiteDomainsFromForm() {
    return [...new Set(
      editorSites.value
        .split(/\r?\n/)
        .map(normalizeEditorSiteDomain)
        .filter(Boolean)
    )];
  }

  function editorSiteOriginPatterns(domains) {
    return domains.map((domain) => `https://${domain}/*`);
  }

  function settingsFromForm() {
    return {
      ...loadedSettings,
      pagePatterns: journalSitePatternsFromForm(),
      preferredAction: preferredAction.value,
      userName: userName.value.trim(),
      authorInstitutions: institutionLines(),
      openAlexApiKey: openAlexApiKey.value.trim(),
      openAlexAuthorId: openAlexAuthorId.value.trim(),
      showBibWriteSuccessBanner: showBibWriteSuccessBanner.checked,
      identitySetupSeen: true
    };
  }

  async function saveCurrentSettings() {
    loadedSettings = settingsFromForm();
    const configuredEditorSites = editorSiteDomainsFromForm();
    const editorOrigins = editorSiteOriginPatterns(
      configuredEditorSites.filter((domain) => !builtInEditorSites.has(domain))
    );
    if (editorOrigins.length && extensionApi.permissions?.request) {
      const granted = await extensionApi.permissions.request({ origins: editorOrigins });
      if (!granted) {
        throw new Error("Access to the configured document editor sites was not granted.");
      }
    }
    await extensionApi.storage.local.set({
      [SETTINGS_KEY]: loadedSettings,
      [EDITOR_SITES_KEY]: { sites: configuredEditorSites }
    });
    const response = await extensionApi.runtime.sendMessage({ type: "ctca-sync-editor-sites" });
    if (response?.ok === false) {
      throw new Error(response.error || "The document editor sites could not be activated.");
    }
  }

  async function load() {
    await globalThis.SmartCitationsPrivacy.ensureAccepted();
    desktopLauncherContent.appendChild(globalThis.SmartCitationsDesktopLauncher.createMenuContent());
    const storedValues = await extensionApi.storage.local.get([SETTINGS_KEY, EDITOR_SITES_KEY]);
    const rawStored = storedValues?.[SETTINGS_KEY] || {};
    const { orcidOAuthClientId: _legacyOrcidClientId, ...stored } = rawStored;
    loadedSettings = stored;
    userName.value = String(stored.userName || "");
    const linkedOrcid = String(stored.orcidId || "");
    orcidLinkState.textContent = linkedOrcid
      ? `Linked: ${stored.userName || linkedOrcid} · ${linkedOrcid}`
      : "No ORCID account linked.";
    showLinkedOrcidControls(Boolean(linkedOrcid));
    authorInstitutions.value = (Array.isArray(stored.authorInstitutions)
      ? stored.authorInstitutions
      : String(stored.authorInstitutions || "").split(/\r?\n/))
      .filter(Boolean)
      .join("\n");
    openAlexApiKey.value = String(stored.openAlexApiKey || "");
    openAlexAuthorId.value = String(stored.openAlexAuthorId || "");
    patterns.value = (Array.isArray(stored.pagePatterns) ? stored.pagePatterns : defaults.pagePatterns)
      .map(normalizeJournalSitePattern)
      .filter(Boolean)
      .join("\n");
    const storedEditorSites = storedValues?.[EDITOR_SITES_KEY]?.sites;
    editorSites.value = (Array.isArray(storedEditorSites) ? storedEditorSites : defaults.editorSites)
      .map(normalizeEditorSiteDomain)
      .filter(Boolean)
      .join("\n");
    preferredAction.value = ["ask", "journal", "smart-citations"].includes(stored.preferredAction)
      ? stored.preferredAction
      : defaults.preferredAction;
    showBibWriteSuccessBanner.checked = stored.showBibWriteSuccessBanner !== false;
  }

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    try {
      await saveCurrentSettings();
      status.textContent = "Options saved. Reload open document editor tabs to activate changes.";
      window.setTimeout(() => { status.textContent = ""; }, 4500);
    } catch (error) {
      status.textContent = error?.message || String(error);
    }
  });

  linkOrcid.addEventListener("click", async () => {
    linkOrcid.disabled = true;
    const previousLinkState = orcidLinkState.textContent;
    orcidLinkState.textContent = "Waiting for ORCID sign-in and profile…";
    orcidLinkState.classList.add("ctca-orcid-linking");
    orcidLinkState.setAttribute("aria-busy", "true");
    status.textContent = "";
    try {
      // Dispatch OAuth immediately. Awaiting the settings write first can make
      // the browser discard the user activation required for an auth window.
      const savePromise = saveCurrentSettings();
      const responsePromise = extensionApi.runtime.sendMessage({
        type: "ctca-orcid-oauth-link"
      });
      const [, response] = await Promise.all([savePromise, responsePromise]);
      if (!response?.ok) throw new Error(response?.error || "The ORCID account could not be linked.");
      const profile = response.profile || {};
      if (profile.displayName) userName.value = profile.displayName;
      if (profile.institutions?.length) authorInstitutions.value = profile.institutions.join("\n");
      loadedSettings.orcidId = profile.url || profile.orcid || "";
      loadedSettings.orcidOAuthAuthenticatedOrcid = profile.orcid || "";
      loadedSettings.orcidOAuthAuthenticatedAt = profile.authenticatedAt || new Date().toISOString();
      loadedSettings.orcidLastAutomaticCheckAt = "";
      await saveCurrentSettings();
      orcidLinkState.textContent = `Linked: ${profile.displayName || profile.orcid} · ${profile.url || profile.orcid}`;
      showLinkedOrcidControls(true);
      status.textContent = `ORCID linked${profile.displayName ? ` to ${profile.displayName}` : ""}.`;
    } catch (error) {
      const message = error?.message || String(error);
      orcidLinkState.textContent = previousLinkState === "No ORCID account linked."
        ? `ORCID sign-in failed: ${message}`
        : previousLinkState;
      status.textContent = message;
    } finally {
      orcidLinkState.classList.remove("ctca-orcid-linking");
      orcidLinkState.removeAttribute("aria-busy");
      linkOrcid.disabled = false;
    }
  });

  unlinkOrcid.addEventListener("click", async () => {
    loadedSettings = {
      ...loadedSettings,
      orcidId: "",
      orcidOAuthAuthenticatedOrcid: "",
      orcidOAuthAuthenticatedAt: "",
      orcidLastCheckedAt: "",
      orcidLastAutomaticCheckAt: ""
    };
    await saveCurrentSettings();
    orcidLinkState.textContent = "No ORCID account linked.";
    showLinkedOrcidControls(false);
    status.textContent = "ORCID account unlinked.";
  });

  checkOrcid.addEventListener("click", async () => {
    checkOrcid.disabled = true;
    status.textContent = "Opening the ORCID manuscript check…";
    try {
      await saveCurrentSettings();
      const response = await extensionApi.runtime.sendMessage({ type: "ctca-open-orcid-check" });
      if (!response?.ok) throw new Error(response?.error || "The manuscript check could not be opened.");
      status.textContent = "ORCID manuscript check opened in Smart Citations.";
    } catch (error) {
      status.textContent = error?.message || String(error);
    } finally {
      checkOrcid.disabled = false;
    }
  });

  load().catch((error) => {
    status.textContent = error?.message || String(error);
  });
})();
