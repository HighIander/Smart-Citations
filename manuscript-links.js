/* SPDX-License-Identifier: CC-BY-NC-SA-4.0 */

(() => {
  "use strict";

  const extensionApi = globalThis.browser ?? globalThis.chrome;
  const PREFIX = "collabtex-citation-assistant:";
  const SETTINGS_KEY = `${PREFIX}manuscript-links:v1`;
  const DB_KEY = `${PREFIX}global-bibliography:v1`;
  const DEFAULT_SETTINGS = {
    pagePatterns: ["*.nature.com"],
    preferredAction: "ask",
    userName: ""
  };
  const DOI_PATTERN = /10\.\d{4,9}\/[-._;()/:A-Z0-9]+/ig;
  let settingsPromise = null;
  let activeDialog = null;
  let pageEnabled = false;

  function normalizeDoi(value) {
    let doi = String(value || "")
      .trim()
      .replace(/^doi\s*:\s*/i, "")
      .replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, "")
      .replace(/[\s<>]+/g, "")
      .replace(/[),.;\]}]+$/, "");
    try { doi = decodeURIComponent(doi); } catch (_error) {}
    return /^10\.\d{4,9}\/\S+$/i.test(doi) ? doi : "";
  }

  function settingsFrom(value) {
    const source = value && typeof value === "object" ? value : {};
    const pagePatterns = Array.isArray(source.pagePatterns)
      ? source.pagePatterns.map((item) => String(item || "").trim()).filter(Boolean)
      : DEFAULT_SETTINGS.pagePatterns;
    const preferredAction = ["ask", "journal", "smart-citations"].includes(source.preferredAction)
      ? source.preferredAction
      : "ask";
    return { pagePatterns, preferredAction, userName: String(source.userName || "").trim() };
  }

  async function getSettings() {
    if (!settingsPromise) {
      settingsPromise = extensionApi.storage.local.get(SETTINGS_KEY)
        .then((stored) => settingsFrom(stored?.[SETTINGS_KEY]))
        .catch(() => ({ ...DEFAULT_SETTINGS, pagePatterns: [...DEFAULT_SETTINGS.pagePatterns] }));
    }
    return settingsPromise;
  }

  function wildcardRegex(value) {
    return new RegExp(`^${String(value).replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")}$`, "i");
  }

  function pageMatchesPattern(pattern) {
    const raw = String(pattern || "").trim();
    if (!raw || raw.startsWith("#")) return false;
    if (raw.startsWith("*.")) {
      const suffix = raw.slice(2).replace(/\/.*$/, "").toLowerCase();
      return location.hostname.toLowerCase() === suffix
        || location.hostname.toLowerCase().endsWith(`.${suffix}`);
    }
    if (!raw.includes("/") && !raw.includes(":")) {
      return wildcardRegex(raw).test(location.hostname);
    }
    const candidate = raw.includes("://") ? raw : `*://${raw}`;
    return wildcardRegex(candidate).test(location.href);
  }

  async function isEnabledOnPage() {
    const settings = await getSettings();
    return settings.pagePatterns.some(pageMatchesPattern);
  }

  function firstDoi(value) {
    let text = String(value || "");
    try { text = decodeURIComponent(text); } catch (_error) {}
    DOI_PATTERN.lastIndex = 0;
    const match = DOI_PATTERN.exec(text);
    return normalizeDoi(match?.[0] || "");
  }

  function extractDoiFromPage() {
    const doiMetaNames = new Set([
      "citation_doi",
      "dc.identifier",
      "dc.identifier.doi",
      "prism.doi",
      "eprints.id_number"
    ]);
    for (const meta of document.querySelectorAll("meta[name], meta[property]")) {
      const name = String(meta.getAttribute("name") || meta.getAttribute("property") || "").toLowerCase();
      if (!doiMetaNames.has(name)) continue;
      const doi = firstDoi(meta.content);
      if (doi) return doi;
    }

    for (const link of document.querySelectorAll('link[href*="doi.org/"], a[href*="doi.org/"]')) {
      const doi = firstDoi(link.href);
      if (doi) return doi;
    }

    for (const script of document.querySelectorAll('script[type="application/ld+json"]')) {
      const doi = firstDoi(script.textContent);
      if (doi) return doi;
    }

    const likelyDoiNode = document.querySelector(
      '[data-doi], [class*="doi" i], [id*="doi" i], [aria-label*="doi" i]'
    );
    const likelyDoi = firstDoi(
      likelyDoiNode?.getAttribute("data-doi")
      || likelyDoiNode?.textContent
      || ""
    );
    if (likelyDoi) return likelyDoi;

    return firstDoi(document.body?.innerText?.slice(0, 500000) || "");
  }

  function looksLikePdfLink(anchor) {
    if (!anchor?.href || !/^https?:/i.test(anchor.href)) return false;
    const type = String(anchor.type || anchor.getAttribute("type") || "").toLowerCase();
    const href = anchor.href;
    const text = String(anchor.textContent || anchor.getAttribute("aria-label") || anchor.title || "").trim();
    return type.includes("pdf")
      || /\.pdf(?:$|[?#])/i.test(href)
      || /\/(?:pdf|download|fulltext)(?:\/|$|[?#])/i.test(href)
      || /(?:[?&](?:format|type|download|file)=)[^&#]*pdf/i.test(href)
      || /^(?:view|open|download|get)?\s*(?:full[- ]?text\s*)?pdf\b/i.test(text);
  }

  function entryForDoi(database, doi) {
    const target = normalizeDoi(doi).toLowerCase();
    return (database?.entries || []).find((entry) =>
      normalizeDoi(entry?.fields?.doi || entry?.doi || "").toLowerCase() === target
    ) || null;
  }

  function openJournalLink(anchor, event) {
    const newTab = event.ctrlKey || event.metaKey || event.shiftKey
      || anchor.target === "_blank"
      || (anchor.target && anchor.target !== "_self");
    if (!newTab) {
      location.assign(anchor.href);
      return;
    }
    extensionApi.runtime.sendMessage({
      type: "ctca-open-external-tab",
      url: anchor.href,
      active: true
    }).catch(() => window.open(anchor.href, anchor.target || "_blank", "noopener"));
  }

  async function rememberChoice(action) {
    const current = await getSettings();
    const next = { ...current, preferredAction: action };
    await extensionApi.storage.local.set({ [SETTINGS_KEY]: next });
    settingsPromise = Promise.resolve(next);
  }

  function closeDialog(result) {
    if (!activeDialog) return;
    const { host, resolve, onKeyDown } = activeDialog;
    activeDialog = null;
    document.removeEventListener("keydown", onKeyDown, true);
    host.remove();
    resolve(result);
  }

  function askChoice(existing) {
    if (activeDialog) closeDialog({ action: "journal", remember: false });
    return new Promise((resolve) => {
      const host = document.createElement("div");
      host.id = "ctca-manuscript-choice-host";
      const shadow = host.attachShadow({ mode: "closed" });
      const onKeyDown = (event) => {
        if (event.key !== "Escape") return;
        event.preventDefault();
        event.stopPropagation();
        closeDialog({ action: "journal", remember: false });
      };
      activeDialog = { host, resolve, onKeyDown };
      shadow.innerHTML = `
        <style>
          :host { all: initial; }
          .backdrop {
            position: fixed; inset: 0; z-index: 2147483647; display: grid; place-items: center;
            padding: 24px; box-sizing: border-box; background: rgba(27,31,36,.48);
            font-family: -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; color: #24292f;
          }
          .dialog {
            width: min(560px, calc(100vw - 32px)); box-sizing: border-box; padding: 24px;
            border: 1px solid #d0d7de; border-radius: 12px; background: #fff;
            box-shadow: 0 18px 50px rgba(27,31,36,.26);
          }
          h2 { margin: 0 0 10px; font-size: 20px; line-height: 1.3; }
          p { margin: 0 0 18px; font-size: 15px; line-height: 1.55; }
          label { display: flex; gap: 8px; align-items: center; margin: 0 0 22px; font-size: 14px; }
          input { width: 16px; height: 16px; margin: 0; }
          .actions { display: flex; justify-content: flex-end; gap: 10px; flex-wrap: wrap; }
          button {
            min-height: 38px; padding: 7px 14px; border: 1px solid #8c959f; border-radius: 7px;
            background: #f6f8fa; color: #24292f; font: 600 14px/1.2 inherit; cursor: pointer;
          }
          button.primary { border-color: #1f6feb; background: #1f6feb; color: #fff; }
          button:hover { filter: brightness(.97); }
          button:focus-visible { outline: 3px solid rgba(9,105,218,.35); outline-offset: 2px; }
        </style>
        <div class="backdrop">
          <section class="dialog" role="dialog" aria-modal="true" aria-labelledby="ctca-choice-title">
            <h2 id="ctca-choice-title">Open PDF</h2>
            <p>${existing
              ? "Open the document on the journal site or in Smart Citations?"
              : "Open the document on the journal site or attach it to a new entry in Smart Citations?"}</p>
            <label><input class="remember" type="checkbox"> <span>Remember my choice</span></label>
            <div class="actions">
              <button type="button" data-action="journal">Open on journal site</button>
              <button type="button" class="primary" data-action="smart-citations">${existing ? "Open in Smart Citations" : "Attach in Smart Citations"}</button>
            </div>
          </section>
        </div>`;
      const finish = (action) => closeDialog({
        action,
        remember: shadow.querySelector(".remember").checked
      });
      shadow.querySelectorAll("button[data-action]").forEach((button) => {
        button.addEventListener("click", () => finish(button.dataset.action));
      });
      shadow.querySelector(".backdrop").addEventListener("click", (event) => {
        if (event.target === event.currentTarget) finish("journal");
      });
      document.addEventListener("keydown", onKeyDown, true);
      (document.documentElement || document.body).appendChild(host);
      shadow.querySelector(".primary").focus();
    });
  }

  async function handOffToSmartCitations(doi, anchor) {
    const response = await extensionApi.runtime.sendMessage({
      type: "ctca-open-manuscript-pdf-workflow",
      doi,
      pdfUrl: anchor.href,
      sourceUrl: location.href
    });
    if (!response?.ok) throw new Error(response?.error || "Smart Citations could not be opened.");
  }

  document.addEventListener("click", async (event) => {
    if (event.defaultPrevented || event.button !== 0) return;
    const anchor = event.target?.closest?.("a[href]");
    if (!pageEnabled || !looksLikePdfLink(anchor)) return;

    event.preventDefault();
    event.stopImmediatePropagation();

    const doi = extractDoiFromPage();
    if (!doi) {
      openJournalLink(anchor, event);
      return;
    }

    try {
      const [settings, stored] = await Promise.all([
        getSettings(),
        extensionApi.storage.local.get(DB_KEY)
      ]);
      const existing = entryForDoi(stored?.[DB_KEY], doi);
      let action = settings.preferredAction;
      if (action === "ask") {
        const choice = await askChoice(Boolean(existing));
        action = choice.action;
        if (choice.remember) await rememberChoice(action);
      }
      if (action === "journal") {
        openJournalLink(anchor, event);
        return;
      }
      await handOffToSmartCitations(doi, anchor);
    } catch (error) {
      console.warn("Smart Citations PDF handoff failed:", error);
      openJournalLink(anchor, event);
    }
  }, true);

  extensionApi.storage.onChanged?.addListener((changes, areaName) => {
    if (areaName !== "local" || !(SETTINGS_KEY in changes)) return;
    settingsPromise = null;
    isEnabledOnPage().then((enabled) => { pageEnabled = enabled; }).catch(() => {
      pageEnabled = false;
    });
  });

  isEnabledOnPage().then((enabled) => { pageEnabled = enabled; }).catch(() => {
    pageEnabled = false;
  });
})();
