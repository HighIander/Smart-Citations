/* SPDX-License-Identifier: CC-BY-NC-SA-4.0 */

(() => {
  "use strict";

  const extensionApi = globalThis.browser ?? globalThis.chrome;
  const DOI_PATTERN = /^10\.\d{4,9}\/\S+$/i;
  const activeDoiRequests = new Map();
  const PDF_DB_NAME = "ctca-pdf-attachments-v2";
  const PDF_STORE_NAME = "files";
  const sessionPdfFiles = new Map();
  const webPdfDownloads = new Map();
  const pendingBrowserDownloadNames = [];
  const humanCheckReturnTabs = new Map();
  const humanCheckNotificationTabs = new Map();
  const humanCheckInitialUrls = new Map();
  const humanCheckReturnTimers = new Map();
  const standaloneManagerPorts = new Map();
  const pendingWebPdfAutoContinue = new Map();
  let standalonePendingCreationCommand = null;
  const DEFAULT_ACTION_TITLE = "Open Smart Citations bibliography manager";
  const HUMAN_CHECK_ACTION_TITLE = "Complete the human check. Smart Citations will return you automatically when the page changes.";
  const HUMAN_CHECK_NOTIFICATION_MESSAGE = "This site requires a human check. Complete it in the journal tab. When that page changes URL, Smart Citations will switch back and continue looking for PDFs automatically. If it does not, return here and click Continue looking for PDFs.";
  const HUMAN_CHECK_NOTIFICATION_PREFIX = "ctca-human-check:";
  const WEB_PAGE_LOAD_TIMEOUT_MS = 45000;
  const WEB_PAGE_SETTLE_MS = 1200;
  const MAX_WEB_PDF_CANDIDATES = 4;
  const AUTHOR_OPTIONS_KEY = "collabtex-citation-assistant:manuscript-links:v1";
  const EDITOR_SITES_KEY = "collabtex-citation-assistant:editor-sites:v1";
  const EDITOR_BRIDGE_SCRIPT_ID = "smart-citations-configured-editor-bridge";
  const EDITOR_CONTENT_SCRIPT_ID = "smart-citations-configured-editor-content";
  const BUILTIN_EDITOR_DOMAINS = new Set([
    "collabtex.helmholtz.cloud",
    "overleaf.com",
    "*.overleaf.com"
  ]);
  const DEFAULT_EDITOR_DOMAINS = [...BUILTIN_EDITOR_DOMAINS];
  let editorContentScriptRegistrationQueue = Promise.resolve();
  const ORCID_OAUTH_CLIENT_ID = "APP-RXI3XG6S7KUHH9C5";
  const ORCID_AUTOMATIC_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
  const ORCID_IGNORED_DOIS_LIMIT = 2000;
  const GLOBAL_DATABASE_KEY = "collabtex-citation-assistant:global-bibliography:v1";
  const OPENALEX_CACHE_KEY = "collabtex-citation-assistant:openalex-cache:v2";
  const OPENALEX_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
  const OPENALEX_MISS_TTL_MS = 24 * 60 * 60 * 1000;
  const OPENALEX_MAX_CACHE_WORKS = 1500;
  const OFFSCREEN_DOCUMENT_PATH = "offscreen.html";
  let openAlexCachePromise = null;
  let openAlexSaveQueue = Promise.resolve();
  const openAlexImpactPromises = new Map();
  let orcidAutomaticCheckPromise = null;
  let creatingOffscreenDocument = null;

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

  function editorSiteDomainMatches(hostnameValue, domainValue) {
    const hostname = String(hostnameValue || "").toLowerCase();
    const domain = normalizeEditorSiteDomain(domainValue);
    if (!hostname || !domain) return false;
    if (!domain.startsWith("*.")) return hostname === domain;
    const suffix = domain.slice(2);
    return hostname === suffix || hostname.endsWith(`.${suffix}`);
  }

  function editorSiteMatchPattern(domain) {
    return `https://${domain}/*`;
  }

  async function configuredEditorDomains() {
    const stored = (await extensionApi.storage.local.get(EDITOR_SITES_KEY))?.[EDITOR_SITES_KEY];
    const values = Array.isArray(stored?.sites) ? stored.sites : DEFAULT_EDITOR_DOMAINS;
    return [...new Set(values.map(normalizeEditorSiteDomain).filter(Boolean))];
  }

  async function synchronizeConfiguredEditorContentScripts() {
    if (
      !extensionApi.scripting?.registerContentScripts ||
      !extensionApi.scripting?.unregisterContentScripts
    ) {
      return { supported: false, matches: [] };
    }

    const domains = await configuredEditorDomains();
    const matches = domains
      .map(editorSiteMatchPattern);
    const ids = [EDITOR_BRIDGE_SCRIPT_ID, EDITOR_CONTENT_SCRIPT_ID];
    await extensionApi.scripting.unregisterContentScripts({ ids }).catch(() => {});
    if (!matches.length) return { supported: true, matches };

    await extensionApi.scripting.registerContentScripts([
      {
        id: EDITOR_BRIDGE_SCRIPT_ID,
        matches,
        js: ["page-bridge.js"],
        runAt: "document_idle",
        allFrames: false,
        persistAcrossSessions: true,
        world: "MAIN"
      },
      {
        id: EDITOR_CONTENT_SCRIPT_ID,
        matches,
        css: ["content.css", "privacy-consent.css"],
        js: [
          "latex-renderer.js",
          "bibtex-parser.js",
          "search-tools.js",
          "attachments.js",
          "pdf-import.js",
          "privacy-consent.js",
          "openalex.js",
          "content.js"
        ],
        runAt: "document_idle",
        allFrames: false,
        persistAcrossSessions: true,
        world: "ISOLATED"
      }
    ]);
    return { supported: true, matches };
  }

  function queueConfiguredEditorContentScriptSync() {
    editorContentScriptRegistrationQueue = editorContentScriptRegistrationQueue
      .catch(() => {})
      .then(() => synchronizeConfiguredEditorContentScripts());
    return editorContentScriptRegistrationQueue;
  }

  async function openLocalFileAccessSettings() {
    const userAgent = globalThis.navigator?.userAgent || "";
    const extensionId = extensionApi.runtime.id;
    const url = /\bFirefox\//i.test(userAgent)
      ? "about:addons"
      : (/\bEdg\//i.test(userAgent)
          ? `edge://extensions/?id=${extensionId}`
          : `chrome://extensions/?id=${extensionId}`);
    await extensionApi.tabs.create({ url, active: true });
    return url;
  }

  function wildcardPatternRegex(value) {
    return new RegExp(`^${String(value).replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")}$`, "i");
  }

  function journalSitePatternMatches(urlValue, pattern) {
    const raw = String(pattern || "").trim();
    if (!raw || raw.startsWith("#")) return false;
    let url;
    try {
      url = new URL(String(urlValue || ""));
    } catch (_error) {
      return false;
    }
    if (!/^https?:$/.test(url.protocol)) return false;
    if (raw.startsWith("*.")) {
      const suffix = raw.slice(2).replace(/\/.*$/, "").toLowerCase();
      return url.hostname.toLowerCase() === suffix
        || url.hostname.toLowerCase().endsWith(`.${suffix}`);
    }
    if (!raw.includes("/") && !raw.includes(":")) {
      return wildcardPatternRegex(raw).test(url.hostname);
    }
    const candidate = raw.includes("://") ? raw : `*://${raw}`;
    return wildcardPatternRegex(candidate).test(url.href);
  }

  async function updateJournalSiteActionBadge(tabId, urlValue = "") {
    if (!Number.isInteger(tabId) || !extensionApi.action?.setBadgeText) return;
    if (humanCheckReturnTabs.has(tabId)) return;
    let currentUrl = String(urlValue || "");
    if (!currentUrl) {
      try {
        currentUrl = String((await extensionApi.tabs.get(tabId))?.url || "");
      } catch (_error) {
        return;
      }
    }
    const stored = await extensionApi.storage.local.get(AUTHOR_OPTIONS_KEY).catch(() => ({}));
    const patterns = Array.isArray(stored?.[AUTHOR_OPTIONS_KEY]?.pagePatterns)
      ? stored[AUTHOR_OPTIONS_KEY].pagePatterns
      : ["*.nature.com"];
    const isJournalSite = patterns.some((pattern) => journalSitePatternMatches(currentUrl, pattern));
    const calls = [
      extensionApi.action.setBadgeText({ tabId, text: isJournalSite ? "✓" : "" }),
      extensionApi.action.setTitle({
        tabId,
        title: isJournalSite
          ? "Open Smart Citations bibliography manager — journal site detected"
          : DEFAULT_ACTION_TITLE
      })
    ];
    if (isJournalSite) {
      calls.push(extensionApi.action.setBadgeBackgroundColor({ tabId, color: "#1a7f37" }));
      if (extensionApi.action.setBadgeTextColor) {
        calls.push(extensionApi.action.setBadgeTextColor({ tabId, color: "#ffffff" }));
      }
    }
    await Promise.allSettled(calls);
  }

  async function refreshActiveJournalSiteBadges() {
    const tabs = await extensionApi.tabs.query({ active: true }).catch(() => []);
    await Promise.allSettled(
      tabs.filter((tab) => Number.isInteger(tab?.id))
        .map((tab) => updateJournalSiteActionBadge(tab.id, tab.url))
    );
  }

  async function actionIsPinned() {
    const actionApi = extensionApi.action || extensionApi.browserAction;
    if (!actionApi?.getUserSettings) return false;
    try {
      return Boolean((await actionApi.getUserSettings())?.isOnToolbar);
    } catch (_error) {
      return false;
    }
  }

  async function showInstallWelcome() {
    if (await actionIsPinned()) return;
    const url = extensionApi.runtime.getURL("welcome.html");
    if (extensionApi.windows?.create) {
      try {
        await extensionApi.windows.create({
          url,
          type: "popup",
          width: 460,
          height: 620,
          focused: true
        });
        return;
      } catch (_error) {}
    }
    await extensionApi.tabs.create({ url, active: true });
  }

  extensionApi.downloads?.onDeterminingFilename?.addListener((item, suggest) => {
    let index = pendingBrowserDownloadNames.findIndex((pending) =>
      pending.downloadId === item?.id
      || pending.url === item?.url
      || pending.url === item?.finalUrl
    );
    if (index < 0) {
      const cutoff = Date.now() - 30000;
      index = pendingBrowserDownloadNames.findIndex((pending) =>
        !Number.isInteger(pending.downloadId) && pending.createdAt >= cutoff
      );
    }
    if (index < 0) {
      suggest();
      return;
    }
    const pending = pendingBrowserDownloadNames[index];
    pending.downloadId = item.id;
    suggest({ filename: pending.fileName, conflictAction: "uniquify" });
  });

  async function installNeutralDownloadHeaderRule(url, fileName) {
    if (!extensionApi.declarativeNetRequest?.updateSessionRules) return null;
    const firstRuleId = 700000000 + Math.floor(Math.random() * 100000000) * 2;
    const ruleIds = [firstRuleId, firstRuleId + 1];
    const escapedUrl = String(url || "")
      .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
      .replace(/#.*$/, "");
    const responseHeaders = [
      { header: "content-type", operation: "set", value: "application/octet-stream" },
      { header: "content-disposition", operation: "set", value: `attachment; filename="${fileName}"` },
      { header: "x-content-type-options", operation: "set", value: "nosniff" }
    ];
    try {
      await extensionApi.declarativeNetRequest.updateSessionRules({
        removeRuleIds: ruleIds,
        addRules: [
          {
            id: ruleIds[0],
            priority: 10001,
            action: { type: "modifyHeaders", responseHeaders },
            condition: {
              regexFilter: `^${escapedUrl}(?:#.*)?$`,
              resourceTypes: ["other"]
            }
          },
          {
            id: ruleIds[1],
            priority: 10000,
            action: { type: "modifyHeaders", responseHeaders },
            condition: {
              regexFilter: "^https?://",
              initiatorDomains: [extensionApi.runtime.id],
              resourceTypes: ["other"]
            }
          }
        ]
      });
      return ruleIds;
    } catch (_error) {
      return null;
    }
  }

  async function removeNeutralDownloadHeaderRule(ruleIds) {
    const ids = (Array.isArray(ruleIds) ? ruleIds : [ruleIds]).filter(Number.isInteger);
    if (!ids.length || !extensionApi.declarativeNetRequest?.updateSessionRules) return;
    try {
      await extensionApi.declarativeNetRequest.updateSessionRules({ removeRuleIds: ids });
    } catch (_error) {}
  }

  async function ensureOffscreenDocument() {
    if (!extensionApi.offscreen?.createDocument) return false;
    const documentUrl = extensionApi.runtime.getURL(OFFSCREEN_DOCUMENT_PATH);
    if (extensionApi.runtime.getContexts) {
      const contexts = await extensionApi.runtime.getContexts({
        contextTypes: ["OFFSCREEN_DOCUMENT"],
        documentUrls: [documentUrl]
      });
      if (contexts.length) return true;
    } else if (globalThis.clients?.matchAll) {
      const contexts = await globalThis.clients.matchAll();
      if (contexts.some((context) => context.url === documentUrl)) return true;
    }
    if (!creatingOffscreenDocument) {
      creatingOffscreenDocument = extensionApi.offscreen.createDocument({
        url: OFFSCREEN_DOCUMENT_PATH,
        reasons: ["BLOBS"],
        justification: "Read a completed browser PDF download so it can be attached."
      }).finally(() => {
        creatingOffscreenDocument = null;
      });
    }
    await creatingOffscreenDocument;
    return true;
  }

  async function readLocalFileBytes(fileUrl) {
    if (await ensureOffscreenDocument()) {
      const storageId = `local-download-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      try {
        const response = await extensionApi.runtime.sendMessage({
          target: "ctca-offscreen",
          type: "ctca-read-local-file",
          url: fileUrl,
          storageId
        });
        if (!response?.ok) {
          throw new Error(response?.error || "Chrome could not read the downloaded local file.");
        }
        const blob = await getPdfBlob(storageId);
        if (!blob) throw new Error("Chrome did not make the downloaded file available to Smart Citations.");
        return new Uint8Array(await blob.arrayBuffer());
      } finally {
        await deletePdfBlob(storageId).catch(() => {});
      }
    }

    const response = await fetch(fileUrl, { cache: "no-store" });
    if (!response.ok && response.status !== 0) {
      throw new Error(`Local-file access returned ${response.status}.`);
    }
    return new Uint8Array(await response.arrayBuffer());
  }

  extensionApi.runtime.onConnect?.addListener((port) => {
    if (port?.name !== "ctca-standalone-manager") return;
    const tabId = port.sender?.tab?.id;
    if (!Number.isInteger(tabId)) return;
    standaloneManagerPorts.set(tabId, port);
    if (standalonePendingCreationCommand) {
      const command = standalonePendingCreationCommand;
      standalonePendingCreationCommand = null;
      globalThis.setTimeout(() => {
        try {
          port.postMessage(command);
        } catch (_error) {
          // The manager will still perform its normal startup checks.
        }
      }, 0);
    }
    port.onDisconnect.addListener(() => {
      if (standaloneManagerPorts.get(tabId) === port) standaloneManagerPorts.delete(tabId);
    });
  });

  function openPdfDb() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(PDF_DB_NAME, 1);
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains(PDF_STORE_NAME)) {
          request.result.createObjectStore(PDF_STORE_NAME);
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  async function putPdfBlob(id, bytes, mimeType = "application/pdf") {
    const blob = bytes instanceof Blob
      ? bytes
      : new Blob([bytes instanceof ArrayBuffer ? bytes : new Uint8Array(bytes || [])], { type: mimeType });
    const db = await openPdfDb();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(PDF_STORE_NAME, "readwrite");
      tx.objectStore(PDF_STORE_NAME).put(blob, String(id));
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error || new Error("PDF storage transaction was aborted."));
    });
    db.close();
  }

  async function getPdfBlob(id) {
    const db = await openPdfDb();
    const blob = await new Promise((resolve, reject) => {
      const tx = db.transaction(PDF_STORE_NAME, "readonly");
      const request = tx.objectStore(PDF_STORE_NAME).get(String(id));
      request.onsuccess = () => resolve(request.result || null);
      request.onerror = () => reject(request.error);
    });
    db.close();
    return blob;
  }

  async function deletePdfBlob(id) {
    const db = await openPdfDb();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(PDF_STORE_NAME, "readwrite");
      tx.objectStore(PDF_STORE_NAME).delete(String(id));
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  }

  async function pdfBlobResponse(blob) {
    if (!blob) return { ok: true, found: false };
    return {
      ok: true,
      found: true,
      mimeType: blob.type || "application/pdf",
      bytes: await blob.arrayBuffer()
    };
  }

  async function showHumanCheckActionNotice(tabId, returnTabId, humanCheckUrl = "") {
    const notificationId = `${HUMAN_CHECK_NOTIFICATION_PREFIX}${tabId}`;
    if (Number.isInteger(returnTabId)) {
      humanCheckReturnTabs.set(tabId, returnTabId);
      humanCheckNotificationTabs.set(notificationId, returnTabId);
      try {
        const tab = await extensionApi.tabs.get(tabId);
        humanCheckInitialUrls.set(tabId, String(humanCheckUrl || tab?.url || ""));
      } catch (_error) {
        humanCheckInitialUrls.set(tabId, String(humanCheckUrl || ""));
      }
    }
    await Promise.allSettled([
      extensionApi.action?.setBadgeText?.({ tabId, text: "BACK" }),
      extensionApi.action?.setBadgeBackgroundColor?.({ tabId, color: "#0969da" }),
      extensionApi.action?.setTitle?.({ tabId, title: HUMAN_CHECK_ACTION_TITLE }),
      extensionApi.notifications?.create?.(notificationId, {
        type: "basic",
        iconUrl: extensionApi.runtime.getURL("icons/icon128.png"),
        title: "Human check in progress",
        message: HUMAN_CHECK_NOTIFICATION_MESSAGE
      })
    ].filter(Boolean));
  }

  async function clearHumanCheckActionNotice(tabId) {
    const notificationId = `${HUMAN_CHECK_NOTIFICATION_PREFIX}${tabId}`;
    const returnTimer = humanCheckReturnTimers.get(tabId);
    if (returnTimer) globalThis.clearTimeout(returnTimer);
    humanCheckReturnTimers.delete(tabId);
    humanCheckReturnTabs.delete(tabId);
    humanCheckNotificationTabs.delete(notificationId);
    humanCheckInitialUrls.delete(tabId);
    await Promise.allSettled([
      extensionApi.notifications?.clear?.(notificationId)
    ].filter(Boolean));
    await updateJournalSiteActionBadge(tabId);
  }

  function clearPendingWebPdfAutoContinue(humanCheckTabId) {
    const pending = pendingWebPdfAutoContinue.get(humanCheckTabId);
    if (pending?.timer) globalThis.clearTimeout(pending.timer);
    pendingWebPdfAutoContinue.delete(humanCheckTabId);
  }

  function deliverWebPdfAutoContinue(humanCheckTabId, returnTabId) {
    clearPendingWebPdfAutoContinue(humanCheckTabId);
    const pending = {
      returnTabId,
      expiresAt: Date.now() + 20000,
      timer: null
    };
    pendingWebPdfAutoContinue.set(humanCheckTabId, pending);

    const deliver = async () => {
      if (pendingWebPdfAutoContinue.get(humanCheckTabId) !== pending) return;
      if (Date.now() >= pending.expiresAt) {
        clearPendingWebPdfAutoContinue(humanCheckTabId);
        console.error("[Smart Citations] PDF discovery did not resume after the human check.", {
          humanCheckTabId,
          returnTabId
        });
        return;
      }

      const command = {
        type: "ctca-auto-continue-web-pdf",
        tabId: humanCheckTabId
      };
      const port = standaloneManagerPorts.get(returnTabId);
      if (port) {
        try {
          port.postMessage(command);
        } catch (_error) {
          standaloneManagerPorts.delete(returnTabId);
        }
      }
      try {
        await extensionApi.tabs.sendMessage(returnTabId, command);
      } catch (_error) {
        // Standalone extension pages receive the command through their port.
      }
      if (pendingWebPdfAutoContinue.get(humanCheckTabId) === pending) {
        pending.timer = globalThis.setTimeout(deliver, 400);
      }
    };

    deliver();
  }

  async function returnToSmartCitationsAndContinue(humanCheckTabId, returnTabId) {
    await clearHumanCheckActionNotice(humanCheckTabId);
    await extensionApi.tabs.update(returnTabId, { active: true });
    deliverWebPdfAutoContinue(humanCheckTabId, returnTabId);
  }

  function normalizeDoi(value) {
    return String(value ?? "")
      .trim()
      .replace(/^doi\s*:\s*/i, "")
      .replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, "")
      .replace(/[\s<>]+/g, "")
      .replace(/[),.;]+$/, "");
  }

  function normalizeOrcid(value) {
    const match = String(value || "").trim()
      .match(/(?:orcid\.org\/)?(\d{4}-\d{4}-\d{4}-[\dX]{4})/i);
    if (!match) return "";
    const orcid = match[1].toUpperCase();
    const compact = orcid.replace(/-/g, "");
    let total = 0;
    for (const character of compact.slice(0, 15)) total = (total + Number(character)) * 2;
    const remainder = (12 - (total % 11)) % 11;
    const check = remainder === 10 ? "X" : String(remainder);
    return compact.slice(-1) === check ? orcid : "";
  }

  function decodeEntities(value) {
    const named = {
      amp: "&",
      lt: "<",
      gt: ">",
      quot: '"',
      apos: "'",
      nbsp: " ",
      ndash: "–",
      mdash: "—",
      hellip: "…"
    };

    return String(value ?? "")
      .replace(/&#x([0-9a-f]+);/gi, (_match, code) =>
        String.fromCodePoint(Number.parseInt(code, 16))
      )
      .replace(/&#(\d+);/g, (_match, code) =>
        String.fromCodePoint(Number.parseInt(code, 10))
      )
      .replace(/&([a-z]+);/gi, (match, name) => named[name.toLowerCase()] ?? match);
  }

  function cleanText(value) {
    return decodeEntities(
      String(value ?? "")
        .replace(/<\/?(?:jats:)?[^>]+>/gi, " ")
        .replace(/<[^>]*>/g, " ")
    )
      .replace(/\s+/g, " ")
      .replace(/\s+([,.;:!?])/g, "$1")
      .trim();
  }

  function cleanAbstract(value) {
    return cleanText(value)
      .replace(/^\s*abstract\b\s*[:.\-–—]?\s*/i, "")
      .trim();
  }

  function firstValue(value) {
    if (Array.isArray(value)) {
      return value.find((item) => item !== undefined && item !== null && String(item).trim()) ?? "";
    }
    return value ?? "";
  }

  function yearFromDateParts(...values) {
    for (const value of values) {
      const year = value?.["date-parts"]?.[0]?.[0];
      if (Number.isInteger(year) || /^\d{4}$/.test(String(year ?? ""))) {
        return String(year);
      }
    }
    return "";
  }

  function normalizeAuthor(author) {
    const given = cleanText(author?.given || author?.givenName || "");
    const family = cleanText(author?.family || author?.familyName || "");
    const name = cleanText(
      author?.name || author?.literal || author?.creatorName || [given, family].filter(Boolean).join(" ")
    );

    return {
      given,
      family,
      name: name || [given, family].filter(Boolean).join(" ")
    };
  }

  function mapEntryType(type) {
    const normalized = String(type ?? "").toLowerCase();
    if (["journal-article", "article", "journalarticle"].includes(normalized)) return "article";
    if (["proceedings-article", "paper-conference", "conference-paper", "conferencepaper"].includes(normalized)) return "inproceedings";
    if (["book-chapter", "chapter", "bookchapter"].includes(normalized)) return "incollection";
    if (["book", "monograph", "edited-book", "reference-book"].includes(normalized)) return "book";
    if (["dissertation", "thesis", "doctoral-dissertation"].includes(normalized)) return "phdthesis";
    if (["report", "report-series", "standard"].includes(normalized)) return "techreport";
    return "misc";
  }

  function normalizeCrossref(message, doi) {
    const authors = (message.author || message.editor || []).map(normalizeAuthor).filter((author) => author.name);
    const titleParts = [firstValue(message.title), firstValue(message.subtitle)]
      .map(cleanText)
      .filter(Boolean);

    return {
      doi,
      source: "Crossref",
      entryType: mapEntryType(message.type),
      title: titleParts.join(": "),
      authors,
      journal: cleanText(firstValue(message["container-title"])),
      volume: cleanText(message.volume),
      number: cleanText(message.issue),
      pages: cleanText(message.page || message["article-number"]),
      year: yearFromDateParts(
        message["published-print"],
        message["published-online"],
        message.published,
        message.issued,
        message.created
      ),
      publisher: cleanText(message.publisher),
      abstract: cleanAbstract(message.abstract),
      keywords: (message.subject || []).map(cleanText).filter(Boolean).join(", "),
      url: cleanText(message.URL || firstValue(message.link)?.URL || `https://doi.org/${doi}`)
    };
  }

  function normalizeDataCite(data, doi) {
    const attributes = data?.attributes || {};
    const creators = attributes.creators || [];
    const authors = creators.map((creator) =>
      normalizeAuthor({
        given: creator.givenName,
        family: creator.familyName,
        name: creator.name
      })
    ).filter((author) => author.name);
    const descriptions = attributes.descriptions || [];
    const abstract = descriptions.find((description) =>
      /abstract/i.test(description.descriptionType || "")
    )?.description || descriptions[0]?.description || "";
    const container = attributes.container || {};
    const pages = [container.firstPage, container.lastPage].filter(Boolean).join("--") || attributes.page || "";
    const subjects = (attributes.subjects || [])
      .map((subject) => cleanText(subject.subject || subject))
      .filter(Boolean);

    return {
      doi,
      source: "DataCite",
      entryType: mapEntryType(
        attributes.types?.bibtex ||
        attributes.types?.resourceTypeGeneral ||
        attributes.types?.citeproc
      ),
      title: cleanText(attributes.titles?.[0]?.title || ""),
      authors,
      journal: cleanText(container.title || attributes.publisher || ""),
      volume: cleanText(container.volume || attributes.volume || ""),
      number: cleanText(container.issue || attributes.issue || ""),
      pages: cleanText(pages),
      year: String(attributes.publicationYear || ""),
      publisher: cleanText(attributes.publisher || ""),
      abstract: cleanAbstract(abstract),
      keywords: subjects.join(", "),
      url: cleanText(attributes.url || `https://doi.org/${doi}`)
    };
  }

  function normalizeCsl(csl, doi) {
    const authors = (csl.author || csl.editor || []).map(normalizeAuthor).filter((author) => author.name);
    return {
      doi,
      source: "DOI content negotiation",
      entryType: mapEntryType(csl.type),
      title: cleanText(csl.title),
      authors,
      journal: cleanText(csl["container-title"] || csl.publisher || ""),
      volume: cleanText(csl.volume),
      number: cleanText(csl.issue),
      pages: cleanText(csl.page || csl["article-number"]),
      year: yearFromDateParts(csl.issued, csl.published, csl.created),
      publisher: cleanText(csl.publisher),
      abstract: cleanAbstract(csl.abstract),
      keywords: Array.isArray(csl.keyword)
        ? csl.keyword.map(cleanText).filter(Boolean).join(", ")
        : cleanText(csl.keyword),
      url: cleanText(csl.URL || `https://doi.org/${doi}`)
    };
  }

  async function fetchJson(url, options = {}) {
    const response = await fetch(url, {
      cache: "no-store",
      redirect: "follow",
      ...options
    });

    if (!response.ok) {
      const error = new Error(`${response.status} ${response.statusText}`.trim());
      error.status = response.status;
      throw error;
    }

    return response.json();
  }

  async function fetchDoiMetadata(input, signal) {
    const doi = normalizeDoi(input);
    if (!DOI_PATTERN.test(doi)) {
      throw new Error("The entered text is not a valid DOI.");
    }

    const errors = [];

    try {
      const crossref = await fetchJson(
        `https://api.crossref.org/works/${encodeURIComponent(doi)}`,
        { signal }
      );
      if (crossref?.message) {
        return normalizeCrossref(crossref.message, doi);
      }
    } catch (error) {
      if (signal?.aborted || error?.name === "AbortError") {
        throw new Error("DOI request aborted.");
      }
      errors.push(`Crossref: ${error.message}`);
    }

    try {
      const datacite = await fetchJson(
        `https://api.datacite.org/dois/${encodeURIComponent(doi)}`,
        { headers: { Accept: "application/vnd.api+json" }, signal }
      );
      if (datacite?.data) {
        return normalizeDataCite(datacite.data, doi);
      }
    } catch (error) {
      if (signal?.aborted || error?.name === "AbortError") {
        throw new Error("DOI request aborted.");
      }
      errors.push(`DataCite: ${error.message}`);
    }

    try {
      const csl = await fetchJson(`https://doi.org/${encodeURI(doi)}`, {
        headers: { Accept: "application/vnd.citationstyles.csl+json" },
        signal
      });
      if (csl) {
        return normalizeCsl(csl, doi);
      }
    } catch (error) {
      if (signal?.aborted || error?.name === "AbortError") {
        throw new Error("DOI request aborted.");
      }
      errors.push(`DOI resolver: ${error.message}`);
    }

    throw new Error(`No metadata could be retrieved for ${doi}. ${errors.join("; ")}`);
  }

  function openAlexConfigurationError() {
    const error = new Error("Add a free OpenAlex API key in Smart Citations options.");
    error.configurationRequired = true;
    return error;
  }

  function normalizeOpenAlexTitle(value) {
    return cleanText(value)
      .replace(/\\[a-z]+\*?(?:\[[^\]]*\])?\{([^{}]*)\}/gi, "$1")
      .replace(/[{}\\]/g, " ")
      .normalize("NFKD")
      .replace(/\p{M}/gu, "")
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  function normalizeOpenAlexIdentity(value) {
    return String(value || "").trim();
  }

  async function loadOpenAlexCache() {
    if (!openAlexCachePromise) {
      openAlexCachePromise = extensionApi.storage.local.get(OPENALEX_CACHE_KEY)
        .then((stored) => {
          const cache = stored?.[OPENALEX_CACHE_KEY] || {};
          return {
            version: 2,
            works: cache.works && typeof cache.works === "object" ? cache.works : {},
            authors: cache.authors && typeof cache.authors === "object" ? cache.authors : {},
            impacts: cache.impacts && typeof cache.impacts === "object" ? cache.impacts : {}
          };
        })
        .catch(() => ({ version: 2, works: {}, authors: {}, impacts: {} }));
    }
    return openAlexCachePromise;
  }

  function openAlexCacheFresh(record) {
    const age = Date.now() - Number(record?.cachedAt || 0);
    const ttl = record?.value ? OPENALEX_CACHE_TTL_MS : OPENALEX_MISS_TTL_MS;
    return age >= 0 && age < ttl;
  }

  async function saveOpenAlexCache(cache) {
    const workEntries = Object.entries(cache.works || {});
    if (workEntries.length > OPENALEX_MAX_CACHE_WORKS) {
      workEntries
        .sort((left, right) => Number(right[1]?.cachedAt || 0) - Number(left[1]?.cachedAt || 0))
        .slice(OPENALEX_MAX_CACHE_WORKS)
        .forEach(([identity]) => delete cache.works[identity]);
    }
    openAlexSaveQueue = openAlexSaveQueue
      .catch(() => {})
      .then(() => extensionApi.storage.local.set({ [OPENALEX_CACHE_KEY]: cache }));
    await openAlexSaveQueue;
  }

  async function openAlexSettings() {
    const stored = (await extensionApi.storage.local.get(AUTHOR_OPTIONS_KEY))?.[AUTHOR_OPTIONS_KEY] || {};
    return {
      apiKey: String(stored.openAlexApiKey || "").trim(),
      authorId: String(stored.orcidId || stored.openAlexAuthorId || "").trim(),
      institutions: (Array.isArray(stored.authorInstitutions)
        ? stored.authorInstitutions
        : String(stored.authorInstitutions || "").split(/\r?\n/))
        .map((value) => cleanText(value))
        .filter(Boolean)
    };
  }

  async function openAlexFetch(path, parameters = {}) {
    const settings = await openAlexSettings();
    if (!settings.apiKey) throw openAlexConfigurationError();
    const url = new URL(path, "https://api.openalex.org/");
    Object.entries(parameters).forEach(([name, value]) => {
      if (value !== undefined && value !== null && String(value) !== "") {
        url.searchParams.set(name, String(value));
      }
    });
    url.searchParams.set("api_key", settings.apiKey);
    try {
      return await fetchJson(url.href);
    } catch (error) {
      if (error?.status === 401 || error?.status === 403) {
        throw new Error("The OpenAlex API key was rejected or its request limit was reached.");
      }
      if (error?.status === 429) {
        throw new Error("The OpenAlex request limit was reached. Cached citation data will remain available.");
      }
      throw error;
    }
  }

  function normalizeOpenAlexWork(work) {
    const doi = normalizeDoi(work?.doi || work?.ids?.doi || "");
    return {
      id: String(work?.id || ""),
      doi,
      displayName: cleanText(work?.display_name || work?.title || ""),
      publicationYear: Number(work?.publication_year) || null,
      citedByCount: Number(work?.cited_by_count) || 0,
      countsByYear: (work?.counts_by_year || []).map((item) => ({
        year: Number(item?.year),
        citedByCount: Number(item?.cited_by_count) || 0
      })).filter((item) => Number.isInteger(item.year)),
      authorships: (work?.authorships || []).map((authorship) => ({
        id: String(authorship?.author?.id || ""),
        displayName: cleanText(authorship?.author?.display_name || ""),
        orcid: String(authorship?.author?.orcid || ""),
        rawName: cleanText(authorship?.raw_author_name || ""),
        position: String(authorship?.author_position || ""),
        institutions: (authorship?.institutions || [])
          .flatMap((institution) => [
            cleanText(institution?.display_name || ""),
            cleanText(institution?.ror || "")
          ])
          .filter(Boolean)
      })).filter((authorship) => authorship.id),
      fetchedDate: new Date().toISOString().slice(0, 10)
    };
  }

  function openAlexFirstAuthorSurname(value) {
    const first = String(value || "").split(/\s+and\s+|;/i)[0].trim();
    if (!first) return "";
    const commaParts = first.split(",").map((part) => part.trim()).filter(Boolean);
    const surname = commaParts.length > 1
      ? commaParts[0]
      : first.split(/\s+/).filter(Boolean).slice(-1)[0] || "";
    return surname
      .normalize("NFKD")
      .replace(/\p{M}/gu, "")
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]/gu, "");
  }

  function openAlexCandidateMatches(item, candidate) {
    const wantedTitle = normalizeOpenAlexTitle(item.title);
    const candidateTitle = normalizeOpenAlexTitle(candidate?.display_name || candidate?.title || "");
    if (!wantedTitle || wantedTitle !== candidateTitle) return false;
    if (item.year && Number(item.year) && Number(candidate?.publication_year) !== Number(item.year)) return false;
    const wantedSurname = openAlexFirstAuthorSurname(item.authors);
    if (!wantedSurname) return true;
    const candidateSurnames = (candidate?.authorships || []).slice(0, 1).flatMap((authorship) => [
      authorship?.raw_author_name,
      authorship?.author?.display_name
    ]).map(openAlexFirstAuthorSurname).filter(Boolean);
    return !candidateSurnames.length || candidateSurnames.includes(wantedSurname);
  }

  async function openAlexLookupTitle(item) {
    const parameters = {
      search: item.title,
      per_page: 5,
      select: "id,doi,display_name,title,publication_year,cited_by_count,counts_by_year,authorships"
    };
    if (item.year) parameters.filter = `publication_year:${item.year}`;
    const response = await openAlexFetch("works", parameters);
    const match = (response?.results || []).find((candidate) => openAlexCandidateMatches(item, candidate));
    return match ? normalizeOpenAlexWork(match) : null;
  }

  async function openAlexLookupDoi(item) {
    try {
      const work = await openAlexFetch(
        `works/${encodeURIComponent(`https://doi.org/${item.doi}`)}`,
        { select: "id,doi,display_name,title,publication_year,cited_by_count,counts_by_year,authorships" }
      );
      return work?.id ? normalizeOpenAlexWork(work) : null;
    } catch (error) {
      if (error?.status === 404) return null;
      throw error;
    }
  }

  async function openAlexMapWithConcurrency(items, concurrency, task) {
    const results = new Array(items.length);
    let nextIndex = 0;
    const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
      while (nextIndex < items.length) {
        const index = nextIndex;
        nextIndex += 1;
        results[index] = await task(items[index], index);
      }
    });
    await Promise.all(workers);
    return results;
  }

  async function openAlexFetchWorks(rawItems) {
    const items = (Array.isArray(rawItems) ? rawItems : []).map((item) => ({
      identity: normalizeOpenAlexIdentity(item?.identity),
      doi: normalizeDoi(item?.doi || ""),
      title: cleanText(item?.title || ""),
      year: String(item?.year || "").match(/\d{4}/)?.[0] || "",
      authors: cleanText(item?.authors || "")
    })).filter((item) => item.identity && (item.doi || item.title));
    if (!items.length) return [];

    const cache = await loadOpenAlexCache();
    const resultByIdentity = new Map();
    const misses = [];
    for (const item of items) {
      const cached = cache.works[item.identity];
      if (openAlexCacheFresh(cached)) resultByIdentity.set(item.identity, cached.value || null);
      else misses.push(item);
    }

    const doiMisses = misses.filter((item) => item.doi);
    for (let offset = 0; offset < doiMisses.length; offset += 50) {
      const batch = doiMisses.slice(offset, offset + 50);
      const filter = `doi:${batch.map((item) => `https://doi.org/${item.doi}`).join("|")}`;
      const response = await openAlexFetch("works", {
        filter,
        per_page: 100,
        select: "id,doi,display_name,title,publication_year,cited_by_count,counts_by_year,authorships"
      });
      const byDoi = new Map((response?.results || []).map((work) => [
        normalizeDoi(work?.doi || work?.ids?.doi || ""),
        normalizeOpenAlexWork(work)
      ]));
      for (const item of batch) {
        const work = byDoi.get(item.doi) || null;
        resultByIdentity.set(item.identity, work);
      }
    }

    const unresolvedDoiMisses = doiMisses.filter((item) => !resultByIdentity.get(item.identity));
    const directDoiResults = await openAlexMapWithConcurrency(unresolvedDoiMisses, 3, openAlexLookupDoi);
    unresolvedDoiMisses.forEach((item, index) => {
      resultByIdentity.set(item.identity, directDoiResults[index] || null);
    });
    doiMisses.forEach((item) => {
      cache.works[item.identity] = {
        cachedAt: Date.now(),
        value: resultByIdentity.get(item.identity) || null
      };
    });

    const titleMisses = misses.filter((item) => !item.doi && item.title);
    const titleResults = await openAlexMapWithConcurrency(titleMisses, 3, openAlexLookupTitle);
    titleMisses.forEach((item, index) => {
      const work = titleResults[index] || null;
      resultByIdentity.set(item.identity, work);
      cache.works[item.identity] = { cachedAt: Date.now(), value: work };
    });

    if (misses.length) await saveOpenAlexCache(cache);
    return items.map((item) => ({
      identity: item.identity,
      work: resultByIdentity.get(item.identity) || null
    }));
  }

  function openAlexPersonParts(value) {
    const text = cleanText(value)
      .normalize("NFKD")
      .replace(/\p{M}/gu, "")
      .toLowerCase()
      .replace(/[^\p{L}\p{N}, ]/gu, " ")
      .replace(/\s+/g, " ")
      .trim();
    if (!text) return { surname: "", given: "", initial: "" };
    const comma = text.split(",").map((part) => part.trim()).filter(Boolean);
    const tokens = text.replace(/,/g, " ").split(/\s+/).filter(Boolean);
    const surname = comma.length > 1 ? comma[0] : tokens[tokens.length - 1] || "";
    const given = comma.length > 1 ? comma.slice(1).join(" ") : tokens.slice(0, -1).join(" ");
    return { surname, given, initial: given.charAt(0) };
  }

  function openAlexPersonNamesMatch(left, right) {
    const first = openAlexPersonParts(left);
    const second = openAlexPersonParts(right);
    if (!first.surname || first.surname !== second.surname) return false;
    if (!first.given || !second.given) return true;
    return first.given === second.given || !first.initial || !second.initial || first.initial === second.initial;
  }

  function normalizeOpenAlexAuthorIdentifier(value) {
    const raw = String(value || "").trim();
    const openAlexId = raw.match(/(?:openalex\.org\/)?(A\d+)/i)?.[1];
    if (openAlexId) return openAlexId.toUpperCase();
    const orcid = raw.match(/(?:orcid\.org\/)?(\d{4}-\d{4}-\d{4}-[\dX]{4})/i)?.[1];
    if (orcid) return `https://orcid.org/${orcid.toUpperCase()}`;
    return "";
  }

  function normalizeOpenAlexAuthor(author) {
    return {
      id: String(author?.id || ""),
      orcid: String(author?.orcid || ""),
      displayName: cleanText(author?.display_name || ""),
      worksCount: Number(author?.works_count) || 0,
      citedByCount: Number(author?.cited_by_count) || 0,
      institutions: [
        ...(author?.last_known_institutions || []),
        ...(author?.affiliations || []).map((item) => item?.institution)
      ].flatMap((institution) => [
        cleanText(institution?.display_name || ""),
        cleanText(institution?.ror || "")
      ]).filter(Boolean),
      summaryStats: {
        hIndex: Number(author?.summary_stats?.h_index) || 0,
        i10Index: Number(author?.summary_stats?.i10_index) || 0,
        twoYearMeanCitedness: Number(author?.summary_stats?.["2yr_mean_citedness"])
      },
      countsByYear: (author?.counts_by_year || []).map((item) => ({
        year: Number(item?.year),
        worksCount: Number(item?.works_count) || 0,
        citedByCount: Number(item?.cited_by_count) || 0
      })).filter((item) => Number.isInteger(item.year)),
      fetchedDate: new Date().toISOString().slice(0, 10)
    };
  }

  async function openAlexFetchAuthor(identifier) {
    const normalized = normalizeOpenAlexAuthorIdentifier(identifier);
    if (!normalized) return null;
    const cache = await loadOpenAlexCache();
    const cached = cache.authors[normalized];
    if (openAlexCacheFresh(cached)) return cached.value || null;
    const author = await openAlexFetch(`authors/${normalized}`);
    const value = author?.id ? normalizeOpenAlexAuthor(author) : null;
    cache.authors[normalized] = { cachedAt: Date.now(), value };
    await saveOpenAlexCache(cache);
    return value;
  }

  function normalizedInstitution(value) {
    return cleanText(value)
      .normalize("NFKD")
      .replace(/\p{M}/gu, "")
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  function openAlexInstitutionMatches(candidateInstitutions, configuredInstitutions) {
    if (!configuredInstitutions?.length) return true;
    const candidates = (candidateInstitutions || []).map(normalizedInstitution).filter(Boolean);
    return configuredInstitutions.some((wantedValue) => {
      const wanted = normalizedInstitution(wantedValue);
      return wanted && candidates.some((candidate) =>
        candidate === wanted || candidate.includes(wanted) || wanted.includes(candidate)
      );
    });
  }

  function openAlexResolveAuthorFromWorks(workResults, userName, institutions = []) {
    const candidates = new Map();
    for (const result of workResults || []) {
      for (const authorship of result?.work?.authorships || []) {
        if (
          !openAlexPersonNamesMatch(authorship.displayName, userName) &&
          !openAlexPersonNamesMatch(authorship.rawName, userName)
        ) continue;
        const previous = candidates.get(authorship.id) || {
          id: authorship.id,
          count: 0,
          name: authorship.displayName || authorship.rawName,
          institutions: []
        };
        previous.count += 1;
        previous.institutions.push(...(authorship.institutions || []));
        candidates.set(authorship.id, previous);
      }
    }
    return [...candidates.values()]
      .filter((candidate) => openAlexInstitutionMatches(candidate.institutions, institutions))
      .sort((left, right) =>
      right.count - left.count || left.name.localeCompare(right.name)
    )[0] || null;
  }

  async function openAlexAuthorWorks(authorId) {
    const normalizedId = String(authorId || "").replace(/^https?:\/\/openalex\.org\//i, "");
    const works = [];
    let cursor = "*";
    for (let page = 0; page < 50 && cursor; page += 1) {
      const response = await openAlexFetch("works", {
        filter: `author.id:${normalizedId}`,
        per_page: 100,
        cursor,
        select: "id,cited_by_count,counts_by_year,authorships"
      });
      works.push(...(response?.results || []).map(normalizeOpenAlexWork));
      const next = String(response?.meta?.next_cursor || "");
      if (!next || next === cursor) break;
      cursor = next;
    }
    return works;
  }

  async function openAlexApplyAffiliationFilter(author, configuredInstitutions) {
    if (!author?.id || !configuredInstitutions?.length) return author;
    const authorId = author.id.replace(/^https?:\/\/openalex\.org\//i, "");
    const works = await openAlexAuthorWorks(author.id);
    const filteredWorks = works.filter((work) => {
      const authorship = (work.authorships || []).find((item) =>
        item.id.replace(/^https?:\/\/openalex\.org\//i, "") === authorId
      );
      return authorship && openAlexInstitutionMatches(authorship.institutions, configuredInstitutions);
    });
    const citationCounts = filteredWorks
      .map((work) => Number(work.citedByCount) || 0)
      .sort((left, right) => right - left);
    let hIndex = 0;
    citationCounts.forEach((count, index) => {
      if (count >= index + 1) hIndex = index + 1;
    });
    const countsByYear = new Map();
    for (const work of filteredWorks) {
      for (const item of work.countsByYear || []) {
        const year = Number(item.year);
        if (!Number.isInteger(year)) continue;
        countsByYear.set(year, (countsByYear.get(year) || 0) + (Number(item.citedByCount) || 0));
      }
    }
    return {
      ...author,
      worksCount: filteredWorks.length,
      citedByCount: citationCounts.reduce((sum, count) => sum + count, 0),
      summaryStats: {
        hIndex,
        i10Index: citationCounts.filter((count) => count >= 10).length
      },
      countsByYear: [...countsByYear.entries()]
        .map(([year, citedByCount]) => ({ year, citedByCount }))
        .sort((left, right) => right.year - left.year),
      affiliationFiltered: true,
      filterInstitutions: [...configuredInstitutions]
    };
  }

  async function openAlexAuthorImpact(message) {
    const settings = await openAlexSettings();
    const configuredIdentifier = normalizeOpenAlexAuthorIdentifier(settings.authorId);
    const userName = cleanText(message?.userName || "");
    const institutionKey = settings.institutions.map(normalizedInstitution).sort().join("|");
    const requestKey = `${configuredIdentifier || `name:${normalizedInstitution(userName)}`}::${institutionKey}`;
    if (!configuredIdentifier && !userName) return null;

    const cache = await loadOpenAlexCache();
    const cached = cache.impacts?.[requestKey];
    if (openAlexCacheFresh(cached) && cached?.error) {
      throw new Error(`${cached.error} OpenAlex will not be queried again until the daily cache expires.`);
    }
    if (openAlexCacheFresh(cached) && cached && Object.prototype.hasOwnProperty.call(cached, "value") && cached.value === null) {
      return null;
    }
    if (openAlexCacheFresh(cached) && cached?.value) {
      const cachedAt = Number(cached.cachedAt);
      return {
        ...cached.value,
        cacheStatus: "cached",
        cacheUpdatedAt: new Date(cachedAt).toISOString(),
        cacheRefreshAfter: new Date(cachedAt + OPENALEX_CACHE_TTL_MS).toISOString()
      };
    }
    if (openAlexImpactPromises.has(requestKey)) return openAlexImpactPromises.get(requestKey);

    const request = (async () => {
      if (!settings.apiKey) throw openAlexConfigurationError();
      let identifier = configuredIdentifier;
      let matchSource = "configured";
      let matchCount = 0;
      if (!identifier) {
        const works = await openAlexFetchWorks(message?.items || []);
        const candidate = openAlexResolveAuthorFromWorks(works, userName, settings.institutions);
        if (!candidate) {
          cache.impacts[requestKey] = { cachedAt: Date.now(), value: null };
          await saveOpenAlexCache(cache);
          return null;
        }
        identifier = candidate.id;
        matchSource = "references";
        matchCount = candidate.count;
      }
      const author = await openAlexFetchAuthor(identifier);
      if (!author) {
        cache.impacts[requestKey] = { cachedAt: Date.now(), value: null };
        await saveOpenAlexCache(cache);
        return null;
      }
      const filteredAuthor = await openAlexApplyAffiliationFilter(author, settings.institutions);
      const cachedAt = Date.now();
      const value = { ...filteredAuthor, matchSource, matchCount };
      cache.impacts[requestKey] = { cachedAt, value };
      await saveOpenAlexCache(cache);
      return {
        ...value,
        cacheStatus: "refreshed",
        cacheUpdatedAt: new Date(cachedAt).toISOString(),
        cacheRefreshAfter: new Date(cachedAt + OPENALEX_CACHE_TTL_MS).toISOString()
      };
    })().catch(async (error) => {
      if (error?.configurationRequired !== true) {
        cache.impacts[requestKey] = {
          cachedAt: Date.now(),
          value: null,
          error: error?.message || String(error)
        };
        await saveOpenAlexCache(cache).catch(() => {});
      }
      throw error;
    }).finally(() => openAlexImpactPromises.delete(requestKey));
    openAlexImpactPromises.set(requestKey, request);
    return request;
  }

  function orcidValue(value) {
    if (value && typeof value === "object" && "value" in value) return cleanText(value.value);
    return cleanText(value);
  }

  function orcidAffiliationNames(record) {
    const summary = record?.["activities-summary"] || {};
    const sectionNames = [
      "employments", "educations", "qualifications", "invited-positions",
      "distinctions", "memberships", "services"
    ];
    const names = [];
    for (const sectionName of sectionNames) {
      const section = summary[sectionName] || {};
      const groups = section["affiliation-group"] || section.group || [];
      for (const group of groups) {
        for (const item of group.summaries || []) {
          const affiliation = Object.values(item || {}).find((value) =>
            value && typeof value === "object" && value.organization
          );
          const name = orcidValue(affiliation?.organization?.name);
          if (name) names.push(name);
        }
      }
    }
    return [...new Set(names)];
  }

  function orcidWorkItems(record) {
    const groups = record?.["activities-summary"]?.works?.group || [];
    const byDoi = new Map();
    for (const group of groups) {
      for (const summary of group?.["work-summary"] || []) {
        const externalIds = summary?.["external-ids"]?.["external-id"] || [];
        const doiEntry = externalIds.find((item) =>
          String(item?.["external-id-type"] || "").toLowerCase() === "doi"
        );
        const doi = normalizeDoi(doiEntry?.["external-id-value"] || "").toLowerCase();
        if (!doi || byDoi.has(doi)) continue;
        const date = summary?.["publication-date"] || {};
        const year = orcidValue(date.year);
        byDoi.set(doi, {
          doi,
          title: orcidValue(summary?.title?.title) || "Untitled ORCID work",
          subtitle: orcidValue(summary?.title?.subtitle),
          year: String(year || "").match(/\d{4}/)?.[0] || "",
          type: cleanText(summary?.type || ""),
          url: orcidValue(summary?.url)
        });
      }
    }
    return [...byDoi.values()].sort((left, right) =>
      String(right.year).localeCompare(String(left.year)) || left.title.localeCompare(right.title)
    );
  }

  async function orcidFetchRecord(orcid) {
    const response = await fetch(`https://pub.orcid.org/v3.0/${encodeURIComponent(orcid)}/record`, {
      headers: { Accept: "application/vnd.orcid+json" },
      cache: "no-store"
    });
    if (!response.ok) {
      const error = new Error(`ORCID returned ${response.status} while reading the public record.`);
      error.status = response.status;
      throw error;
    }
    return response.json();
  }

  async function orcidProfile(identifier) {
    const orcid = normalizeOrcid(identifier);
    if (!orcid) throw new Error("Enter a valid ORCID iD or ORCID account link.");
    let record = null;
    try {
      record = await orcidFetchRecord(orcid);
    } catch (orcidError) {
      try {
        const author = await openAlexFetchAuthor(`https://orcid.org/${orcid}`);
        if (!author) throw orcidError;
        return {
          orcid,
          url: `https://orcid.org/${orcid}`,
          displayName: author.displayName,
          institutions: author.institutions || [],
          works: [],
          source: "OpenAlex ORCID index"
        };
      } catch (_openAlexError) {
        throw orcidError;
      }
    }
    const person = record?.person || {};
    const name = person.name || {};
    const displayName = orcidValue(name["credit-name"]) || [
      orcidValue(name["given-names"]),
      orcidValue(name["family-name"])
    ].filter(Boolean).join(" ");
    return {
      orcid,
      url: `https://orcid.org/${orcid}`,
      displayName,
      institutions: orcidAffiliationNames(record),
      works: orcidWorkItems(record),
      source: "ORCID public record"
    };
  }

  function randomOAuthValue() {
    const bytes = new Uint8Array(24);
    crypto.getRandomValues(bytes);
    return [...bytes].map((value) => value.toString(16).padStart(2, "0")).join("");
  }

  function orcidOAuthRedirectUri() {
    if (!extensionApi.identity?.getRedirectURL) return "";
    return extensionApi.identity.getRedirectURL("orcid");
  }

  async function launchOrcidOAuthInTab(authorizationUrl, redirectUri, returnTabId = null) {
    let sourceTabId = Number.isInteger(returnTabId) ? returnTabId : null;
    if (!Number.isInteger(sourceTabId)) {
      const activeTabs = await extensionApi.tabs.query({ active: true, currentWindow: true });
      sourceTabId = activeTabs.find((tab) => Number.isInteger(tab.id))?.id ?? null;
    }

    // Create a blank tab first so the callback listeners are installed before
    // ORCID can perform a fast redirect for an already signed-in user.
    const authTab = await extensionApi.tabs.create({ url: "about:blank", active: true });
    if (!Number.isInteger(authTab?.id)) throw new Error("The browser could not open an ORCID sign-in tab.");
    const authTabId = authTab.id;

    return new Promise((resolve, reject) => {
      let settled = false;
      const cleanup = () => {
        extensionApi.tabs.onUpdated.removeListener(onUpdated);
        extensionApi.tabs.onRemoved.removeListener(onRemoved);
        globalThis.clearTimeout(timeout);
      };
      const restoreSourceTab = async () => {
        if (!Number.isInteger(sourceTabId)) return;
        try {
          await extensionApi.tabs.update(sourceTabId, { active: true });
        } catch (_error) {}
      };
      const finish = async ({ callbackUrl = "", error = null, tabAlreadyClosed = false } = {}) => {
        if (settled) return;
        settled = true;
        cleanup();
        if (!tabAlreadyClosed) {
          try { await extensionApi.tabs.remove(authTabId); } catch (_error) {}
        }
        await restoreSourceTab();
        if (error) reject(error);
        else resolve(callbackUrl);
      };
      const onUpdated = (tabId, changeInfo, tab) => {
        if (tabId !== authTabId) return;
        const nextUrl = String(changeInfo?.url || tab?.url || "");
        if (nextUrl.startsWith(redirectUri)) finish({ callbackUrl: nextUrl });
      };
      const onRemoved = (tabId) => {
        if (tabId === authTabId) {
          finish({
            error: new Error("ORCID sign-in was cancelled."),
            tabAlreadyClosed: true
          });
        }
      };
      const timeout = globalThis.setTimeout(() => {
        finish({ error: new Error("ORCID sign-in timed out.") });
      }, 10 * 60 * 1000);

      extensionApi.tabs.onUpdated.addListener(onUpdated);
      extensionApi.tabs.onRemoved.addListener(onRemoved);
      extensionApi.tabs.update(authTabId, { url: authorizationUrl }).catch((error) => {
        finish({ error });
      });
    });
  }

  async function linkOrcidWithOAuth(returnTabId = null) {
    const storedPromise = extensionApi.storage.local.get(AUTHOR_OPTIONS_KEY);
    const redirectUri = orcidOAuthRedirectUri();
    if (!redirectUri) throw new Error("The browser could not create an OAuth redirect URI.");
    const state = randomOAuthValue();
    const nonce = randomOAuthValue();
    const authorizationUrl = new URL("https://orcid.org/oauth/authorize");
    authorizationUrl.searchParams.set("client_id", ORCID_OAUTH_CLIENT_ID);
    authorizationUrl.searchParams.set("response_type", "token id_token");
    authorizationUrl.searchParams.set("scope", "openid");
    authorizationUrl.searchParams.set("redirect_uri", redirectUri);
    authorizationUrl.searchParams.set("state", state);
    authorizationUrl.searchParams.set("nonce", nonce);

    const callbackPromise = launchOrcidOAuthInTab(
      authorizationUrl.href,
      redirectUri,
      returnTabId
    );
    const stored = (await storedPromise)?.[AUTHOR_OPTIONS_KEY] || {};
    const callbackUrl = await callbackPromise;
    if (!callbackUrl) throw new Error("ORCID sign-in was cancelled.");
    const callback = new URL(callbackUrl);
    const values = new URLSearchParams(callback.hash.replace(/^#/, ""));
    if (values.get("error")) {
      throw new Error(values.get("error_description") || values.get("error"));
    }
    if (values.get("state") !== state) throw new Error("ORCID returned an invalid OAuth state.");
    const accessToken = values.get("access_token") || "";
    if (!accessToken) throw new Error("ORCID did not return an authentication token.");

    const userInfoResponse = await fetch("https://orcid.org/oauth/userinfo", {
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${accessToken}`
      },
      cache: "no-store"
    });
    if (!userInfoResponse.ok) {
      throw new Error(`ORCID user information could not be verified (${userInfoResponse.status}).`);
    }
    const userInfo = await userInfoResponse.json();
    const orcid = normalizeOrcid(userInfo.sub || userInfo.orcid || "");
    if (!orcid) throw new Error("ORCID did not return a valid authenticated iD.");
    const authenticatedDisplayName = cleanText(userInfo.name || [
      userInfo.given_name,
      userInfo.family_name
    ].filter(Boolean).join(" "));
    let profile;
    try {
      profile = await orcidProfile(orcid);
      if (authenticatedDisplayName) {
        profile = { ...profile, displayName: authenticatedDisplayName };
      }
    } catch (_error) {
      profile = {
        orcid,
        url: `https://orcid.org/${orcid}`,
        displayName: authenticatedDisplayName,
        institutions: [],
        works: [],
        source: "ORCID OpenID Connect"
      };
    }
    const authenticatedAt = new Date().toISOString();
    await extensionApi.storage.local.set({
      [AUTHOR_OPTIONS_KEY]: {
        ...stored,
        identitySetupSeen: true,
        orcidId: profile.url,
        orcidOAuthAuthenticatedOrcid: orcid,
        orcidOAuthAuthenticatedAt: authenticatedAt,
        userName: profile.displayName || stored.userName || "",
        authorInstitutions: profile.institutions?.length
          ? profile.institutions
          : stored.authorInstitutions || [],
        orcidLastCheckedAt: "",
        orcidLastAutomaticCheckAt: ""
      }
    });
    return { ...profile, authenticatedAt };
  }

  async function openAlexWorksForOrcid(orcid) {
    const author = await openAlexFetchAuthor(`https://orcid.org/${orcid}`);
    if (!author?.id) throw new Error("OpenAlex has no author profile linked to this ORCID iD.");
    const response = await openAlexFetch("works", {
      filter: `author.id:${author.id.replace(/^https?:\/\/openalex\.org\//i, "")}`,
      per_page: 100,
      select: "doi,display_name,title,publication_year,type"
    });
    return (response?.results || []).map((work) => ({
      doi: normalizeDoi(work?.doi || "").toLowerCase(),
      title: cleanText(work?.display_name || work?.title || "Untitled work"),
      subtitle: "",
      year: String(work?.publication_year || ""),
      type: cleanText(work?.type || ""),
      url: String(work?.doi || "")
    })).filter((work) => work.doi);
  }

  function ignoredOrcidDois(stored, orcid) {
    const byOrcid = stored?.orcidIgnoredWorkDois;
    const values = byOrcid && typeof byOrcid === "object" && !Array.isArray(byOrcid)
      ? byOrcid[orcid]
      : [];
    return new Set((Array.isArray(values) ? values : [])
      .map((doi) => normalizeDoi(doi).toLowerCase())
      .filter(Boolean));
  }

  function hasAuthenticatedOrcidLink(stored, orcid) {
    if (!orcid) return false;
    const authenticatedOrcid = normalizeOrcid(stored?.orcidOAuthAuthenticatedOrcid || "");
    // orcidId has only ever been written after the OAuth flow. Accounts linked
    // before the explicit authentication marker was introduced are therefore
    // valid and can be migrated on their next check.
    return !authenticatedOrcid || authenticatedOrcid === orcid;
  }

  async function enrichOrcidWorks(items, onProgress = null) {
    const sourceItems = Array.isArray(items) ? items : [];
    const enriched = new Array(sourceItems.length);
    let failedLookupCount = 0;
    let completed = 0;
    let nextIndex = 0;
    if (onProgress) onProgress({ completed, total: sourceItems.length });
    const workers = Array.from({ length: Math.min(3, sourceItems.length) }, async () => {
      while (nextIndex < sourceItems.length) {
        const index = nextIndex;
        nextIndex += 1;
        const item = sourceItems[index];
        try {
          const metadata = await fetchDoiMetadata(item.doi);
          enriched[index] = { ...item, metadata };
        } catch (_error) {
          failedLookupCount += 1;
        } finally {
          completed += 1;
          if (onProgress) onProgress({ completed, total: sourceItems.length });
        }
      }
    });
    await Promise.all(workers);
    return {
      items: enriched.filter(Boolean),
      failedLookupCount
    };
  }

  function filterOrcidDiscoveryResult(result, existingDois = []) {
    const existing = new Set((existingDois || [])
      .map((doi) => normalizeDoi(doi).toLowerCase())
      .filter(Boolean));
    const items = (result.items || []).filter((item) =>
      !existing.has(normalizeDoi(item?.doi || "").toLowerCase())
    );
    return {
      ...result,
      items,
      newItemCount: items.filter((item) => !item.previouslyIgnored).length
    };
  }

  async function recordOrcidWorkReview({ ignoredDois = [], reconsideredDois = [] } = {}) {
    const stored = (await extensionApi.storage.local.get(AUTHOR_OPTIONS_KEY))?.[AUTHOR_OPTIONS_KEY] || {};
    const orcid = normalizeOrcid(stored.orcidId || "");
    if (!hasAuthenticatedOrcidLink(stored, orcid)) return { recorded: false };
    const ignored = ignoredOrcidDois(stored, orcid);
    for (const doi of ignoredDois) {
      const normalized = normalizeDoi(doi).toLowerCase();
      if (normalized) ignored.add(normalized);
    }
    for (const doi of reconsideredDois) {
      const normalized = normalizeDoi(doi).toLowerCase();
      if (normalized) ignored.delete(normalized);
    }
    const byOrcid = stored.orcidIgnoredWorkDois
      && typeof stored.orcidIgnoredWorkDois === "object"
      && !Array.isArray(stored.orcidIgnoredWorkDois)
      ? { ...stored.orcidIgnoredWorkDois }
      : {};
    byOrcid[orcid] = [...ignored].slice(-ORCID_IGNORED_DOIS_LIMIT);
    await extensionApi.storage.local.set({
      [AUTHOR_OPTIONS_KEY]: { ...stored, orcidIgnoredWorkDois: byOrcid }
    });
    return { recorded: true };
  }

  async function discoverOrcidWorksUncoalesced({
    force = false,
    existingDois = [],
    onDoiProgress = null
  } = {}) {
    let stored = (await extensionApi.storage.local.get(AUTHOR_OPTIONS_KEY))?.[AUTHOR_OPTIONS_KEY] || {};
    const orcid = normalizeOrcid(stored.orcidId || "");
    const authenticated = hasAuthenticatedOrcidLink(stored, orcid);
    if (!authenticated) {
      return { linked: Boolean(orcid), authenticated: false, skipped: true, items: [] };
    }
    if (!stored.orcidOAuthAuthenticatedOrcid || !stored.orcidOAuthAuthenticatedAt) {
      stored = {
        ...stored,
        orcidOAuthAuthenticatedOrcid: orcid,
        orcidOAuthAuthenticatedAt: stored.orcidOAuthAuthenticatedAt || new Date().toISOString()
      };
      await extensionApi.storage.local.set({ [AUTHOR_OPTIONS_KEY]: stored });
    }
    const lastAutomaticCheck = stored.orcidLastAutomaticCheckAt || stored.orcidLastCheckedAt || "";
    const lastCheckedAt = new Date(lastAutomaticCheck).getTime();
    if (!force && Number.isFinite(lastCheckedAt)
      && Date.now() - lastCheckedAt < ORCID_AUTOMATIC_CHECK_INTERVAL_MS) {
      return {
        linked: true,
        authenticated: true,
        skipped: true,
        items: [],
        lastCheckedAt: lastAutomaticCheck
      };
    }

    const checkedAt = new Date().toISOString();
    if (!force) {
      // Reserve the daily automatic check before making network requests. This
      // prevents repeated checks after failures or from multiple open tabs.
      await extensionApi.storage.local.set({
        [AUTHOR_OPTIONS_KEY]: {
          ...stored,
          orcidLastCheckedAt: checkedAt,
          orcidLastAutomaticCheckAt: checkedAt
        }
      });
    }

    let profile;
    let items;
    try {
      profile = await orcidProfile(orcid);
      items = profile.works;
      if (!items.length) items = await openAlexWorksForOrcid(orcid);
    } catch (orcidError) {
      try {
        items = await openAlexWorksForOrcid(orcid);
        profile = {
          orcid,
          url: `https://orcid.org/${orcid}`,
          displayName: String(stored.userName || ""),
          institutions: stored.authorInstitutions || [],
          source: "OpenAlex ORCID index"
        };
      } catch (_openAlexError) {
        throw orcidError;
      }
    }

    const existing = new Set((existingDois || []).map((doi) => normalizeDoi(doi).toLowerCase()).filter(Boolean));
    const unique = new Map();
    for (const item of items || []) {
      const doi = normalizeDoi(item?.doi || "").toLowerCase();
      if (!doi || existing.has(doi) || unique.has(doi)) continue;
      unique.set(doi, { ...item, doi });
    }
    const enriched = await enrichOrcidWorks([...unique.values()], onDoiProgress);
    const ignored = ignoredOrcidDois(stored, orcid);
    const enrichedItems = enriched.items.map((item) => ({
      ...item,
      previouslyIgnored: ignored.has(item.doi)
    }));
    return {
      linked: true,
      authenticated: true,
      skipped: false,
      items: enrichedItems,
      newItemCount: enrichedItems.filter((item) => !item.previouslyIgnored).length,
      failedLookupCount: enriched.failedLookupCount,
      checkedAt,
      profile: {
        orcid,
        url: `https://orcid.org/${orcid}`,
        displayName: profile?.displayName || String(stored.userName || ""),
        institutions: profile?.institutions || [],
        source: profile?.source || "ORCID"
      }
    };
  }

  async function discoverOrcidWorks(options = {}) {
    if (options.force === true) return discoverOrcidWorksUncoalesced(options);
    if (!orcidAutomaticCheckPromise) {
      orcidAutomaticCheckPromise = discoverOrcidWorksUncoalesced({ ...options, existingDois: [] })
        .finally(() => { orcidAutomaticCheckPromise = null; });
    }
    const result = await orcidAutomaticCheckPromise;
    return filterOrcidDiscoveryResult(result, options.existingDois);
  }

  async function globalDatabaseDois() {
    const database = (await extensionApi.storage.local.get(GLOBAL_DATABASE_KEY))?.[GLOBAL_DATABASE_KEY] || {};
    return (database.entries || []).map((entry) => entry?.fields?.doi || "").filter(Boolean);
  }


  async function nextcloudFetchResponse(message) {
    const url = new URL(String(message.url || ""));
    if (!/^https?:$/.test(url.protocol)) throw new Error("Only HTTP or HTTPS Nextcloud requests are allowed.");
    const headers = new Headers(message.headers || {});
    let body;
    if (typeof message.bodyBase64 === "string") {
      const binary = atob(message.bodyBase64);
      const bytes = new Uint8Array(binary.length);
      for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
      body = bytes;
    } else if (message.bodyBytes) body = message.bodyBytes instanceof ArrayBuffer ? message.bodyBytes : new Uint8Array(message.bodyBytes);
    else if (typeof message.bodyText === "string") body = message.bodyText;
    const response = await fetch(url.href, {
      method: message.method || "GET",
      headers,
      body,
      cache: "no-store",
      credentials: "omit"
    });
    const responseHeaders = {};
    response.headers.forEach((value, key) => { responseHeaders[key] = value; });
    const responseBytes = new Uint8Array(await response.arrayBuffer());
    const chunkSize = 0x8000;
    let binary = "";
    for (let offset = 0; offset < responseBytes.length; offset += chunkSize) {
      binary += String.fromCharCode(...responseBytes.subarray(offset, offset + chunkSize));
    }
    return {
      ok: true,
      status: response.status,
      statusText: response.statusText,
      headers: responseHeaders,
      bodyBase64: btoa(binary)
    };
  }

  function webPdfUrl(value, baseUrl) {
    const decoded = decodeEntities(String(value || ""))
      .replace(/\\u0026/gi, "&")
      .replace(/\\\//g, "/")
      .trim();
    if (!decoded || /^(?:javascript|data|blob):/i.test(decoded)) return "";
    try {
      const url = new URL(decoded, baseUrl);
      return /^https?:$/.test(url.protocol) ? url.href : "";
    } catch (_error) {
      return "";
    }
  }

  function webPdfFileName(url, contentDisposition = "") {
    const encoded = /filename\*\s*=\s*UTF-8''([^;]+)/i.exec(contentDisposition)?.[1];
    const plain = /filename\s*=\s*"?([^";]+)"?/i.exec(contentDisposition)?.[1];
    let value = encoded || plain || "";
    if (encoded) {
      try { value = decodeURIComponent(encoded); } catch (_error) {}
    }
    if (!value) {
      try {
        value = new URL(url).pathname.split("/").filter(Boolean).pop() || "document.pdf";
        value = decodeURIComponent(value);
      } catch (_error) {
        value = "document.pdf";
      }
    }
    value = value.replace(/[\\/:*?"<>|]+/g, "_").trim() || "document.pdf";
    return /\.pdf$/i.test(value) ? value : `${value}.pdf`;
  }

  function friendlyWebPdfName(_url, _context = "", index = 0) {
    return index === 0 ? "Manuscript file" : `Supplement file ${index}`;
  }

  function extractWebPdfCandidates(html, baseUrl) {
    const candidates = [];
    const add = (rawUrl, context = "") => {
      const url = webPdfUrl(rawUrl, baseUrl);
      if (!url) return;
      const strongContext = /(?:citation_pdf_url|eprints\.document_url|pdf_?url|full.?text|supplement|supporting|\bpdf\b|application\/pdf)/i.test(context);
      let parsed;
      try { parsed = new URL(url); } catch (_error) { return; }
      const looksLikePdf = /\.pdf(?:$|[?#])/i.test(url)
        || /(?:^|[?&])(?:format|type|download|file)=?[^&]*pdf/i.test(parsed.search)
        || /\/(?:pdf|download|fulltext)(?:\/|$)/i.test(parsed.pathname)
        || strongContext;
      if (looksLikePdf) candidates.push({ url, context: cleanText(context) });
    };

    for (const match of html.matchAll(/<meta\b[^>]*(?:name|property)\s*=\s*["']([^"']+)["'][^>]*content\s*=\s*["']([^"']+)["'][^>]*>/gi)) {
      add(match[2], match[1]);
    }
    for (const match of html.matchAll(/<meta\b[^>]*content\s*=\s*["']([^"']+)["'][^>]*(?:name|property)\s*=\s*["']([^"']+)["'][^>]*>/gi)) {
      add(match[1], match[2]);
    }
    for (const match of html.matchAll(/<a\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
      add(match[1], match[2]);
    }
    for (const match of html.matchAll(/<(?:link|iframe|embed|object)\b[^>]*(?:href|src|data)\s*=\s*["']([^"']+)["'][^>]*>/gi)) {
      add(match[1], match[0]);
    }
    for (const match of html.matchAll(/["'](?:pdf_?url|fulltext_?url|supplement_?url)["']\s*:\s*["']([^"']+)["']/gi)) {
      add(match[1], match[0]);
    }
    for (const match of html.matchAll(/["']((?:https?:)?(?:\\\/|\/)[^"'<>\\s]+?\.pdf(?:[?#][^"'<>\\s]*)?)["']/gi)) {
      add(match[1], "PDF link");
    }

    const seen = new Set();
    return candidates.filter((candidate) => {
      const key = candidate.url.replace(/#.*$/, "");
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    }).slice(0, MAX_WEB_PDF_CANDIDATES).map((candidate, index) => ({
      ...candidate,
      id: `web-pdf-${index + 1}`,
      sourceUrl: baseUrl,
      fileName: webPdfFileName(candidate.url),
      name: friendlyWebPdfName(candidate.url, candidate.context, index)
    }));
  }

  function htmlForwardUrl(html, baseUrl) {
    const refresh = /<meta\b[^>]*http-equiv\s*=\s*["']?refresh["']?[^>]*content\s*=\s*["'][^"']*url\s*=\s*([^"';>]+)[^"']*["'][^>]*>/i.exec(html);
    const location = /(?:window\.)?location(?:\.href)?\s*=\s*["']([^"']+)["']/i.exec(html);
    return webPdfUrl(refresh?.[1] || location?.[1] || "", baseUrl);
  }

  function visibleTextFromHtml(html) {
    return decodeEntities(
      String(html || "")
        .slice(0, 750000)
        .replace(/<(?:script|style|noscript|template|svg)\b[\s\S]*?<\/(?:script|style|noscript|template|svg)>/gi, " ")
        .replace(/<!--[\s\S]*?-->/g, " ")
        .replace(/<[^>]+>/g, " ")
    ).replace(/\s+/g, " ").trim();
  }

  function isHumanCheckPage(visibleText = "", title = "", html = "") {
    const pageTitle = String(title || "").trim();
    const visible = `${pageTitle}\n${String(visibleText || "").slice(0, 200000)}`;
    const explicitChallenge = /(?:verify (?:that )?you are (?:a )?human|are you (?:a )?human|human verification|confirm (?:that )?you are not a robot|checking (?:if the site connection is secure|your browser)|performing security verification|complete the security check|press and hold|prove (?:that )?you are human|enable javascript and cookies to continue)/i.test(visible);
    const challengeTitle = /\b(?:just a moment|einen moment)\b/i.test(pageTitle)
      || /^(?:security check|attention required|human verification|verify (?:that )?you are human|checking your browser)(?:\b|[.!…])/i.test(pageTitle);
    const visibleCaptcha = /\b(?:captcha|hcaptcha|recaptcha)\b/i.test(visible)
      && String(visibleText || "").trim().length < 10000;
    return explicitChallenge || challengeTitle || visibleCaptcha;
  }

  async function discoverWebPdfsByFetch(inputUrl) {
    let currentUrl = webPdfUrl(inputUrl, inputUrl);
    if (!currentUrl) throw new Error("Enter a valid HTTP or HTTPS webpage URL.");

    for (let hop = 0; hop < 4; hop += 1) {
      const response = await fetch(currentUrl, {
        cache: "no-store",
        credentials: "include",
        redirect: "follow",
        headers: { Accept: "text/html,application/xhtml+xml,application/pdf;q=0.9,*/*;q=0.5" }
      });
      const finalUrl = response.url || currentUrl;
      const contentType = String(response.headers.get("content-type") || "").toLowerCase();
      if (contentType.includes("application/pdf") || /\.pdf(?:$|[?#])/i.test(finalUrl)) {
        if (!response.ok) throw new Error(`The webpage returned ${response.status} ${response.statusText}.`);
        return {
          finalUrl,
          candidates: [{
            id: "web-pdf-1",
            url: finalUrl,
            sourceUrl: finalUrl,
            fileName: webPdfFileName(finalUrl, response.headers.get("content-disposition") || ""),
            name: friendlyWebPdfName(finalUrl, "manuscript full text")
          }]
        };
      }
      const html = await response.text();
      const title = decodeEntities(/<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] || "");
      if (isHumanCheckPage(visibleTextFromHtml(html), title, html)) {
        return { finalUrl, candidates: [], humanCheckRequired: true };
      }
      if (!response.ok) throw new Error(`The webpage returned ${response.status} ${response.statusText}.`);
      const candidates = extractWebPdfCandidates(html, finalUrl);
      if (candidates.length) return { finalUrl, candidates };
      const forwarded = htmlForwardUrl(html, finalUrl);
      if (!forwarded || forwarded === finalUrl) return { finalUrl, candidates: [] };
      currentUrl = forwarded;
    }
    return { finalUrl: currentUrl, candidates: [] };
  }

  async function waitForWebPageTab(tab) {
    if (!Number.isInteger(tab?.id)) throw new Error("The background webpage could not be opened.");
    return new Promise((resolve) => {
      let settled = false;
      let settleTimer = null;
      const finish = async (timedOut = false) => {
        if (settled) return;
        settled = true;
        globalThis.clearTimeout(timer);
        globalThis.clearTimeout(settleTimer);
        extensionApi.tabs.onUpdated.removeListener(onUpdated);
        try { resolve({ ...(await extensionApi.tabs.get(tab.id)), ctcaTimedOut: timedOut }); }
        catch (_error) { resolve({ ...tab, ctcaTimedOut: timedOut }); }
      };
      const scheduleSettledFinish = () => {
        if (settled || settleTimer) return;
        settleTimer = globalThis.setTimeout(() => finish(false), WEB_PAGE_SETTLE_MS);
      };
      const onUpdated = (tabId, changeInfo) => {
        if (tabId !== tab.id) return;
        if (changeInfo?.title && isHumanCheckPage("", changeInfo.title, "")) {
          finish(false);
          return;
        }
        if (changeInfo.status === "complete") scheduleSettledFinish();
      };
      const timer = globalThis.setTimeout(() => finish(true), WEB_PAGE_LOAD_TIMEOUT_MS);
      extensionApi.tabs.onUpdated.addListener(onUpdated);
      extensionApi.tabs.get(tab.id)
        .then((current) => {
          if (isHumanCheckPage("", current?.title, "")) finish(false);
          else if (current?.status === "complete") scheduleSettledFinish();
        })
        .catch(() => finish(false));
    });
  }

  async function openWebPageInBackground(url) {
    const tab = await extensionApi.tabs.create({ url, active: false });
    return waitForWebPageTab(tab);
  }

  async function discoverWebPdfs(inputUrl, existingTabId = null, preserveExistingTab = false) {
    const startUrl = webPdfUrl(inputUrl, inputUrl);
    if (!startUrl) throw new Error("Enter a valid HTTP or HTTPS webpage URL.");
    let tab = null;
    let keepTabOpen = false;
    let preserveHumanCheckTab = false;
    try {
      tab = Number.isInteger(existingTabId)
        ? await waitForWebPageTab(await extensionApi.tabs.get(existingTabId))
        : await openWebPageInBackground(startUrl);
      preserveHumanCheckTab = Number.isInteger(existingTabId)
        && (preserveExistingTab === true || humanCheckReturnTabs.has(existingTabId));
      if (preserveHumanCheckTab) keepTabOpen = true;
      const finishSuccessfulDiscovery = async (result) => {
        const hasCandidates = Array.isArray(result?.candidates) && result.candidates.length > 0;
        if (!preserveHumanCheckTab && !hasCandidates) return result;
        keepTabOpen = true;
        await clearHumanCheckActionNotice(tab.id);
        return {
          ...result,
          tabId: tab.id,
          candidates: (result.candidates || []).map((candidate) => ({
            ...candidate,
            tabId: tab.id
          }))
        };
      };
      const pageLoadTimedOut = tab?.ctcaTimedOut === true;
      const finalUrl = webPdfUrl(tab?.url || startUrl, startUrl) || startUrl;
      if (isHumanCheckPage("", tab?.title, "")) {
        keepTabOpen = true;
        return {
          finalUrl,
          candidates: [],
          humanCheckRequired: true,
          tabId: tab.id
        };
      }
      if (extensionApi.scripting?.executeScript && Number.isInteger(tab?.id)) {
        try {
          const results = await extensionApi.scripting.executeScript({
            target: { tabId: tab.id },
            func: () => ({
              url: location.href,
              title: document.title || "",
              contentType: document.contentType || "",
              readyState: document.readyState || "",
              visibleText: (document.body?.innerText || "").slice(0, 200000),
              html: (document.documentElement?.outerHTML || "").slice(0, 4_000_000)
            })
          });
          const page = results?.[0]?.result;
          const pageUrl = webPdfUrl(page?.url || finalUrl, finalUrl) || finalUrl;
          if (isHumanCheckPage(page?.visibleText, page?.title, page?.html)) {
            keepTabOpen = true;
            return {
              finalUrl: pageUrl,
              candidates: [],
              humanCheckRequired: true,
              tabId: tab.id
            };
          }
          if (String(page?.contentType || "").toLowerCase().includes("application/pdf")) {
            return finishSuccessfulDiscovery({
              finalUrl: pageUrl,
              candidates: [{
                id: "web-pdf-1",
                url: pageUrl,
                sourceUrl: finalUrl,
                fileName: webPdfFileName(pageUrl),
                name: friendlyWebPdfName(pageUrl, "manuscript full text")
              }]
            });
          }
          const candidates = extractWebPdfCandidates(String(page?.html || ""), pageUrl);
          if (candidates.length) {
            return finishSuccessfulDiscovery({ finalUrl: pageUrl, candidates });
          }
          if (pageLoadTimedOut || page?.readyState !== "complete") {
            keepTabOpen = true;
            return {
              finalUrl: pageUrl,
              candidates: [],
              pageStillLoading: true,
              tabId: tab.id
            };
          }
        } catch (_error) {
          // Some browser-internal PDF viewers and redirected hosts do not
          // permit script injection. The authenticated background fetch below
          // still handles ordinary HTML pages and direct PDF responses.
          if (pageLoadTimedOut) {
            keepTabOpen = true;
            return {
              finalUrl,
              candidates: [],
              pageStillLoading: true,
              tabId: tab.id
            };
          }
        }
      }
      try {
        const fetched = await discoverWebPdfsByFetch(finalUrl);
        if (fetched.humanCheckRequired) {
          keepTabOpen = true;
          return { ...fetched, tabId: tab.id };
        }
        return finishSuccessfulDiscovery(fetched);
      } catch (error) {
        let redirected = false;
        try { redirected = new URL(finalUrl).origin !== new URL(startUrl).origin; } catch (_error) {}
        if (redirected) {
          return {
            finalUrl,
            candidates: [],
            permissionRequired: true,
            permissionError: error?.message || String(error)
          };
        }
        throw error;
      }
    } finally {
      if (!keepTabOpen && Number.isInteger(tab?.id)) {
        await clearHumanCheckActionNotice(tab.id);
        try { await extensionApi.tabs.remove(tab.id); } catch (_error) {}
      }
    }
  }

  function webPdfBytesToBase64(bytes) {
    const chunkSize = 0x8000;
    let binary = "";
    for (let offset = 0; offset < bytes.length; offset += chunkSize) {
      binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
    }
    return btoa(binary);
  }

  async function downloadWebPdfThroughPageTab(tabId, inputUrl, inputSourceUrl = "") {
    if (!Number.isInteger(tabId) || !extensionApi.scripting?.executeScript) {
      throw new Error("The journal page tab is no longer available.");
    }
    const downloadKey = `ctca-page-pdf-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    let initialized = false;
    try {
      const results = await extensionApi.scripting.executeScript({
        target: { tabId },
        world: "MAIN",
        func: async (url, sourceUrl, key) => {
          try {
            const options = {
              cache: "no-store",
              credentials: "include",
              redirect: "follow",
              headers: {
                Accept: "application/pdf,application/octet-stream;q=0.9,text/html;q=0.4,*/*;q=0.2"
              }
            };
            try {
              if (sourceUrl && new URL(sourceUrl).origin === location.origin) {
                options.referrer = sourceUrl;
                options.referrerPolicy = "strict-origin-when-cross-origin";
              }
            } catch (_error) {}
            const response = await fetch(url, options);
            if (!response.ok) {
              return {
                ok: false,
                error: `PDF download returned ${response.status} ${response.statusText}.`
              };
            }
            const bytes = new Uint8Array(await response.arrayBuffer());
            if (!bytes.byteLength) {
              return { ok: false, error: "The web server returned an empty PDF response." };
            }
            const prefix = new TextDecoder("ascii").decode(bytes.subarray(0, Math.min(bytes.length, 1024)));
            if (!prefix.includes("%PDF-")) {
              const contentType = String(response.headers.get("content-type") || "").toLowerCase();
              return {
                ok: false,
                error: `The selected web file is not a PDF${contentType ? ` (${contentType.split(";")[0]})` : ""}.`
              };
            }
            const storeName = "__ctcaPagePdfDownloads";
            const store = globalThis[storeName] instanceof Map
              ? globalThis[storeName]
              : (globalThis[storeName] = new Map());
            store.set(key, bytes);
            globalThis.setTimeout(() => store.delete(key), 5 * 60 * 1000);
            return {
              ok: true,
              byteLength: bytes.byteLength,
              finalUrl: response.url || url,
              contentDisposition: response.headers.get("content-disposition") || ""
            };
          } catch (error) {
            return {
              ok: false,
              error: error?.message || String(error)
            };
          }
        },
        args: [inputUrl, inputSourceUrl, downloadKey]
      });
      const info = results?.[0]?.result;
      if (!info?.ok) {
        throw new Error(info?.error || "The journal page tab could not download the PDF.");
      }
      initialized = true;
      const bytes = new Uint8Array(Number(info.byteLength) || 0);
      if (!bytes.byteLength) throw new Error("The journal page tab returned an empty PDF response.");
      const transferSize = 512 * 1024;
      for (let offset = 0; offset < bytes.length; offset += transferSize) {
        const chunkResults = await extensionApi.scripting.executeScript({
          target: { tabId },
          world: "MAIN",
          func: (key, start, length) => {
            const bytes = globalThis.__ctcaPagePdfDownloads?.get(key);
            if (!(bytes instanceof Uint8Array)) {
              return { ok: false, error: "The temporary page-context PDF download expired." };
            }
            const chunk = bytes.subarray(start, Math.min(bytes.length, start + length));
            const encodeSize = 0x8000;
            let binary = "";
            for (let index = 0; index < chunk.length; index += encodeSize) {
              binary += String.fromCharCode(...chunk.subarray(index, index + encodeSize));
            }
            return { ok: true, bodyBase64: btoa(binary), byteLength: chunk.byteLength };
          },
          args: [downloadKey, offset, Math.min(transferSize, bytes.length - offset)]
        });
        const chunk = chunkResults?.[0]?.result;
        if (!chunk?.ok) throw new Error(chunk?.error || "The page-context PDF data could not be transferred.");
        const binary = atob(String(chunk.bodyBase64 || ""));
        if (!binary.length || binary.length !== Number(chunk.byteLength)) {
          throw new Error("The page-context PDF data was not transferred completely.");
        }
        for (let index = 0; index < binary.length; index += 1) {
          bytes[offset + index] = binary.charCodeAt(index);
        }
      }
      return {
        bytes,
        finalUrl: info.finalUrl || inputUrl,
        contentDisposition: info.contentDisposition || ""
      };
    } finally {
      if (initialized) {
        extensionApi.scripting.executeScript({
          target: { tabId },
          world: "MAIN",
          func: (key) => globalThis.__ctcaPagePdfDownloads?.delete(key),
          args: [downloadKey]
        }).catch(() => {});
      }
    }
  }

  function fileUrlFromDownloadPath(value) {
    const path = String(value || "").trim().replace(/\\/g, "/");
    if (!path) throw new Error("The browser did not report where it saved the PDF.");
    const encodeParts = (parts) => parts.map((part) => encodeURIComponent(part)).join("/");
    if (/^\/\//.test(path)) {
      const parts = path.replace(/^\/+/, "").split("/").filter(Boolean);
      const host = parts.shift();
      if (!host || !parts.length) throw new Error("The downloaded PDF path is incomplete.");
      return `file://${host}/${encodeParts(parts)}`;
    }
    if (/^[A-Za-z]:\//.test(path)) {
      const drive = path.slice(0, 2);
      const parts = path.slice(3).split("/").filter(Boolean);
      if (!parts.length) throw new Error("The downloaded PDF path is incomplete.");
      return `file:///${drive}/${encodeParts(parts)}`;
    }
    if (path.startsWith("/")) {
      const parts = path.split("/").filter(Boolean);
      if (!parts.length) throw new Error("The downloaded PDF path is incomplete.");
      return `file:///${encodeParts(parts)}`;
    }
    throw new Error("The browser returned a non-absolute PDF download path.");
  }

  async function waitForBrowserDownload(downloadId, timeoutMs = 120000) {
    const current = (await extensionApi.downloads.search({ id: downloadId }))?.[0];
    if (current?.state === "complete") return current;
    if (current?.state === "interrupted") {
      throw new Error(`The browser download was interrupted${current.error ? ` (${current.error})` : ""}.`);
    }
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = async (error = null) => {
        if (settled) return;
        settled = true;
        globalThis.clearTimeout(timer);
        extensionApi.downloads.onChanged.removeListener(onChanged);
        if (error) {
          reject(error);
          return;
        }
        try {
          const item = (await extensionApi.downloads.search({ id: downloadId }))?.[0];
          if (!item) throw new Error("The completed browser download could not be found.");
          resolve(item);
        } catch (lookupError) {
          reject(lookupError);
        }
      };
      const onChanged = (delta) => {
        if (delta?.id !== downloadId) return;
        if (delta.state?.current === "complete") finish();
        else if (delta.state?.current === "interrupted") {
          finish(new Error(`The browser download was interrupted${delta.error?.current ? ` (${delta.error.current})` : ""}.`));
        }
      };
      const timer = globalThis.setTimeout(
        () => finish(new Error("The journal link did not finish downloading within two minutes.")),
        timeoutMs
      );
      extensionApi.downloads.onChanged.addListener(onChanged);
    });
  }

  async function downloadWebPdfAsBrowserDownload(_tabId, inputUrl, inputSourceUrl = "") {
    if (!extensionApi.downloads?.download || !extensionApi.downloads?.onChanged || !extensionApi.downloads?.search) {
      throw new Error("This browser cannot save the journal link through its download manager.");
    }
    const originalFileName = webPdfFileName(inputUrl);
    const temporaryFileName = `smart-citations-${Date.now()}-${Math.random().toString(36).slice(2)}.download`;
    const headerRuleId = await installNeutralDownloadHeaderRule(inputUrl, temporaryFileName);
    const filenameRequest = {
      url: inputUrl,
      fileName: temporaryFileName,
      downloadId: null,
      createdAt: Date.now()
    };
    pendingBrowserDownloadNames.push(filenameRequest);
    const removeFilenameRequest = () => {
      const pendingIndex = pendingBrowserDownloadNames.indexOf(filenameRequest);
      if (pendingIndex >= 0) pendingBrowserDownloadNames.splice(pendingIndex, 1);
    };
    const options = {
      url: inputUrl,
      method: "GET",
      saveAs: false,
      conflictAction: "uniquify",
      // Browsers can remember “always open PDFs” and launch Acrobat as soon
      // as a .pdf download finishes. This is only a short-lived transport
      // file, so give it a neutral extension and restore the real PDF name
      // after its bytes have been read.
      filename: temporaryFileName
    };
    if (inputSourceUrl) {
      options.headers = [{ name: "Referer", value: inputSourceUrl }];
    }

    let downloadId;
    try {
      downloadId = await extensionApi.downloads.download(options);
    } catch (error) {
      if (!options.headers) {
        removeFilenameRequest();
        await removeNeutralDownloadHeaderRule(headerRuleId);
        throw error;
      }
      // Chromium does not allow Referer in DownloadOptions. Retry there
      // without it; Firefox accepts it and uses the article-page referrer.
      const { headers: _headers, ...withoutHeaders } = options;
      try {
        downloadId = await extensionApi.downloads.download(withoutHeaders);
      } catch (retryError) {
        removeFilenameRequest();
        await removeNeutralDownloadHeaderRule(headerRuleId);
        throw new Error(retryError?.message || error?.message || String(retryError || error));
      }
    }
    if (!Number.isInteger(downloadId)) {
      removeFilenameRequest();
      await removeNeutralDownloadHeaderRule(headerRuleId);
      throw new Error("The browser did not start the journal-link download.");
    }
    filenameRequest.downloadId = downloadId;

    let completed;
    try {
      completed = await waitForBrowserDownload(downloadId);
    } catch (error) {
      await Promise.allSettled([
        extensionApi.downloads.cancel?.(downloadId),
        extensionApi.downloads.removeFile?.(downloadId),
        extensionApi.downloads.erase?.({ id: downloadId })
      ].filter(Boolean));
      throw error;
    } finally {
      removeFilenameRequest();
      await removeNeutralDownloadHeaderRule(headerRuleId);
    }
    try {
      const fileUrl = fileUrlFromDownloadPath(completed.filename);
      let bytes;
      try {
        bytes = await readLocalFileBytes(fileUrl);
      } catch (error) {
        throw new Error(
          `The browser downloaded the PDF to ${completed.filename}, but Smart Citations could not read it back. `
          + `Enable local-file access for the extension or attach that downloaded file manually. ${error?.message || String(error)}`
        );
      }
      if (!bytes.byteLength) {
        throw new Error(`The browser downloaded an empty file to ${completed.filename}.`);
      }
      const prefix = new TextDecoder("ascii").decode(bytes.subarray(0, Math.min(bytes.length, 1024)));
      if (!prefix.includes("%PDF-")) {
        throw new Error(`The browser download at ${completed.filename} is not a PDF.`);
      }
      return {
        bytes,
        finalUrl: completed.finalUrl || completed.url || inputUrl,
        fileName: originalFileName
      };
    } finally {
      await Promise.allSettled([
        extensionApi.downloads.removeFile?.(completed.id),
        extensionApi.downloads.erase?.({ id: completed.id })
      ].filter(Boolean));
    }
  }

  function storeWebPdfDownload(bytes, finalUrl, contentDisposition = "", explicitFileName = "") {
    const downloadId = `web-pdf-download-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    webPdfDownloads.set(downloadId, { bytes, createdAt: Date.now() });
    for (const [id, item] of webPdfDownloads) {
      if (Date.now() - item.createdAt > 5 * 60 * 1000) webPdfDownloads.delete(id);
    }
    return {
      ok: true,
      downloadId,
      byteLength: bytes.byteLength,
      mimeType: "application/pdf",
      finalUrl,
      fileName: explicitFileName || webPdfFileName(finalUrl, contentDisposition)
    };
  }

  async function downloadWebPdfWithAlternatives(inputUrl, sourceUrl, inputTabId, status) {
    let pageTabId = Number.isInteger(inputTabId) ? inputTabId : null;
    let temporaryTabId = null;
    let pageError = null;
    try {
      if (!Number.isInteger(pageTabId) && sourceUrl && sourceUrl !== inputUrl) {
        try {
          const tab = await openWebPageInBackground(sourceUrl);
          if (Number.isInteger(tab?.id)) {
            pageTabId = tab.id;
            temporaryTabId = tab.id;
          }
        } catch (error) {
          pageError = error;
        }
      }

      if (Number.isInteger(pageTabId)) {
        try {
          const pageDownload = await downloadWebPdfThroughPageTab(
            pageTabId,
            inputUrl,
            sourceUrl
          );
          return storeWebPdfDownload(
            pageDownload.bytes,
            pageDownload.finalUrl,
            pageDownload.contentDisposition
          );
        } catch (error) {
          pageError = error;
        }
      }

      try {
        const browserDownload = await downloadWebPdfAsBrowserDownload(
          pageTabId,
          inputUrl,
          sourceUrl
        );
        return storeWebPdfDownload(
          browserDownload.bytes,
          browserDownload.finalUrl,
          "",
          browserDownload.fileName
        );
      } catch (browserError) {
        const pageFailure = pageError
          ? `The journal page could not read it directly (${pageError?.message || String(pageError)}). `
          : "";
        const error = new Error(
          `The journal blocked the background PDF request (${status}). `
          + pageFailure
          + `Saving the journal link through the browser also failed: ${browserError?.message || String(browserError)}`
        );
        if (browserError?.code) error.code = String(browserError.code);
        throw error;
      }
    } finally {
      if (Number.isInteger(temporaryTabId)) {
        try { await extensionApi.tabs.remove(temporaryTabId); } catch (_error) {}
      }
    }
  }

  async function downloadWebPdf(inputUrl, inputSourceUrl = "", inputTabId = null) {
    const initialUrl = webPdfUrl(inputUrl, inputUrl);
    if (!initialUrl) throw new Error("The selected PDF URL is invalid.");
    const sourceUrl = webPdfUrl(inputSourceUrl, initialUrl) || initialUrl;
    const visited = new Set();
    let currentUrl = initialUrl;

    for (let attempt = 0; attempt < 3 && currentUrl && !visited.has(currentUrl); attempt += 1) {
      visited.add(currentUrl);
      const response = await fetch(currentUrl, {
        cache: "no-store",
        credentials: "include",
        redirect: "follow",
        referrer: sourceUrl,
        referrerPolicy: "strict-origin-when-cross-origin",
        headers: { Accept: "application/pdf,application/octet-stream;q=0.9,text/html;q=0.4,*/*;q=0.2" }
      });
      if (!response.ok) {
        if (response.status === 401 || response.status === 403) {
          return downloadWebPdfWithAlternatives(
            currentUrl,
            sourceUrl,
            inputTabId,
            response.status
          );
        }
        throw new Error(`PDF download returned ${response.status} ${response.statusText}.`);
      }
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (!bytes.byteLength) throw new Error("The web server returned an empty PDF response.");
      const prefix = new TextDecoder("ascii").decode(bytes.subarray(0, Math.min(bytes.length, 1024)));
      const finalUrl = response.url || currentUrl;
      if (prefix.includes("%PDF-")) {
        return storeWebPdfDownload(
          bytes,
          finalUrl,
          response.headers.get("content-disposition") || ""
        );
      }

      const contentType = String(response.headers.get("content-type") || "").toLowerCase();
      if (contentType.includes("html") || prefix.trimStart().startsWith("<")) {
        const html = new TextDecoder("utf-8").decode(bytes);
        const candidates = extractWebPdfCandidates(html, finalUrl);
        const inputName = webPdfFileName(currentUrl).toLowerCase();
        const inputIsSupplement = /(?:supp|moesm|esm|supporting|appendix)/i.test(inputName);
        const next = candidates.find((candidate) =>
          !visited.has(candidate.url) && webPdfFileName(candidate.url).toLowerCase() === inputName
        ) || candidates.find((candidate) => {
          if (visited.has(candidate.url)) return false;
          const candidateIsSupplement = /(?:supp|moesm|esm|supporting|appendix)/i.test(candidate.fileName);
          return candidateIsSupplement === inputIsSupplement;
        });
        if (next) {
          currentUrl = next.url;
          continue;
        }
      }
      throw new Error(`The selected web file is not a PDF${contentType ? ` (${contentType.split(";")[0]})` : ""}.`);
    }
    throw new Error("The webpage did not resolve to a downloadable PDF.");
  }

  extensionApi.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message?.type === "ctca-sync-editor-sites") {
      queueConfiguredEditorContentScriptSync()
        .then((result) => sendResponse({
          ok: result.supported,
          ...result,
          error: result.supported ? "" : "This browser does not support configurable content scripts."
        }))
        .catch((error) => sendResponse({ ok: false, error: error?.message || String(error) }));
      return true;
    }

    if (message?.type === "ctca-orcid-oauth-info") {
      sendResponse({ ok: true, redirectUri: orcidOAuthRedirectUri() });
      return false;
    }

    if (message?.type === "ctca-orcid-oauth-link") {
      linkOrcidWithOAuth(sender?.tab?.id)
        .then((profile) => sendResponse({ ok: true, profile }))
        .catch((error) => sendResponse({
          ok: false,
          error: error?.message || String(error),
          code: error?.code || ""
        }));
      return true;
    }

    if (message?.type === "ctca-orcid-profile") {
      orcidProfile(message.orcid)
        .then((profile) => sendResponse({ ok: true, profile }))
        .catch((error) => sendResponse({ ok: false, error: error?.message || String(error) }));
      return true;
    }

    if (message?.type === "ctca-orcid-discover") {
      const progressRequestId = String(message.progressRequestId || "");
      const onDoiProgress = progressRequestId
        ? ({ completed, total }) => {
            try {
              const sent = extensionApi.runtime.sendMessage({
                type: "ctca-orcid-discover-progress",
                progressRequestId,
                completed,
                total
              });
              if (sent?.catch) sent.catch(() => {});
            } catch (_error) {}
          }
        : null;
      discoverOrcidWorks({
        force: message.force === true,
        existingDois: Array.isArray(message.existingDois) ? message.existingDois : [],
        onDoiProgress
      })
        .then((result) => sendResponse({ ok: true, ...result }))
        .catch((error) => sendResponse({ ok: false, error: error?.message || String(error) }));
      return true;
    }

    if (message?.type === "ctca-orcid-record-review") {
      recordOrcidWorkReview({
        ignoredDois: Array.isArray(message.ignoredDois) ? message.ignoredDois : [],
        reconsideredDois: Array.isArray(message.reconsideredDois) ? message.reconsideredDois : []
      })
        .then((result) => sendResponse({ ok: true, ...result }))
        .catch((error) => sendResponse({ ok: false, error: error?.message || String(error) }));
      return true;
    }

    if (message?.type === "ctca-open-orcid-check") {
      openOrReuseStandaloneManager({
        url: `${extensionApi.runtime.getURL("manager.html")}?orcidCheck=1`,
        command: { type: "ctca-check-orcid-now" }
      })
        .then((result) => sendResponse({ ok: true, tabId: result.tabId, reused: result.reused }))
        .catch((error) => sendResponse({ ok: false, error: error?.message || String(error) }));
      return true;
    }

    if (message?.type === "ctca-check-orcid-and-open") {
      globalDatabaseDois()
        .then((existingDois) => discoverOrcidWorks({ existingDois }))
        .then(async (result) => {
          if (!result.newItemCount) return { opened: false, result };
          const opened = await openOrReuseStandaloneManager({
            command: { type: "ctca-offer-orcid-works", result }
          });
          return { opened: true, result, ...opened };
        })
        .then((result) => sendResponse({ ok: true, ...result }))
        .catch((error) => sendResponse({ ok: false, error: error?.message || String(error) }));
      return true;
    }

    if (message?.type === "ctca-openalex-fetch-works") {
      openAlexFetchWorks(message.items)
        .then((results) => sendResponse({ ok: true, results }))
        .catch((error) => sendResponse({
          ok: false,
          error: error?.message || String(error),
          configurationRequired: error?.configurationRequired === true
        }));
      return true;
    }

    if (message?.type === "ctca-openalex-author-impact") {
      openAlexAuthorImpact(message)
        .then((profile) => sendResponse({ ok: true, profile }))
        .catch((error) => sendResponse({
          ok: false,
          error: error?.message || String(error),
          configurationRequired: error?.configurationRequired === true
        }));
      return true;
    }

    if (message?.type === "ctca-close-standalone-manager") {
      const tabId = sender?.tab?.id;
      if (!Number.isInteger(tabId)) {
        sendResponse({ ok: false, error: "The standalone manager tab could not be identified." });
        return false;
      }
      extensionApi.tabs.remove(tabId)
        .then(() => sendResponse({ ok: true }))
        .catch((error) => sendResponse({ ok: false, error: error?.message || String(error) }));
      return true;
    }

    if (message?.type === "ctca-open-external-tab") {
      try {
        const url = new URL(String(message.url || ""));
        if (!/^https?:$/.test(url.protocol)) throw new Error("Only HTTP or HTTPS URLs can be opened.");
        extensionApi.tabs.create({ url: url.href, active: message.active !== false })
          .then((tab) => sendResponse({ ok: true, tabId: tab?.id ?? null }))
          .catch((error) => sendResponse({ ok: false, error: error?.message || String(error) }));
      } catch (error) {
        sendResponse({ ok: false, error: error?.message || String(error) });
        return false;
      }
      return true;
    }

    if (message?.type === "ctca-request-origin-permission") {
      try {
        const origin = new URL(String(message.server || "")).origin;
        const pattern = `${origin}/*`;
        extensionApi.permissions.contains({ origins: [pattern] })
          .then((contains) => contains ? true : extensionApi.permissions.request({ origins: [pattern] }))
          .then((granted) => sendResponse({ ok: true, granted: Boolean(granted) }))
          .catch((error) => sendResponse({ ok: false, error: error?.message || String(error) }));
      } catch (error) {
        sendResponse({ ok: false, error: error?.message || String(error) });
        return false;
      }
      return true;
    }

    if (message?.type === "ctca-nextcloud-fetch") {
      nextcloudFetchResponse(message)
        .then(sendResponse)
        .catch((error) => sendResponse({ ok: false, error: error?.message || String(error) }));
      return true;
    }

    if (message?.type === "ctca-discover-web-pdfs") {
      discoverWebPdfs(
        message.url,
        Number.isInteger(message.tabId) ? message.tabId : null,
        message.preserveTab === true
      )
        .then((result) => sendResponse({ ok: true, ...result }))
        .catch((error) => {
          console.error("[Smart Citations] Web PDF discovery failed.", {
            url: message.url,
            tabId: message.tabId,
            preserveTab: message.preserveTab,
            error,
            message: error?.message || String(error),
            stack: error?.stack || ""
          });
          sendResponse({ ok: false, error: error?.message || String(error) });
        });
      return true;
    }

    if (message?.type === "ctca-show-web-human-check") {
      const tabId = Number(message.tabId);
      if (!Number.isInteger(tabId)) {
        sendResponse({ ok: false, error: "The human-check tab is no longer available." });
        return false;
      }
      showHumanCheckActionNotice(tabId, sender?.tab?.id, message.url)
        .then(() => extensionApi.tabs.update(tabId, { active: true }))
        .then(() => sendResponse({ ok: true }))
        .catch((error) => sendResponse({ ok: false, error: error?.message || String(error) }));
      return true;
    }

    if (message?.type === "ctca-auto-continue-web-pdf-ack") {
      const humanCheckTabId = Number(message.tabId);
      const pending = pendingWebPdfAutoContinue.get(humanCheckTabId);
      if (pending && (!Number.isInteger(sender?.tab?.id) || sender.tab.id === pending.returnTabId)) {
        clearPendingWebPdfAutoContinue(humanCheckTabId);
      }
      sendResponse({ ok: Boolean(pending) });
      return false;
    }

    if (message?.type === "ctca-download-web-pdf") {
      downloadWebPdf(
        message.url,
        message.sourceUrl,
        Number.isInteger(message.tabId) ? message.tabId : null
      )
        .then(sendResponse)
        .catch((error) => {
          console.error("[Smart Citations] Web PDF download failed.", {
            url: message.url,
            sourceUrl: message.sourceUrl,
            tabId: message.tabId,
            error,
            message: error?.message || String(error),
            stack: error?.stack || ""
          });
          sendResponse({
            ok: false,
            error: error?.message || String(error),
            code: error?.code || ""
          });
        });
      return true;
    }

    if (message?.type === "ctca-read-web-pdf-chunk") {
      const item = webPdfDownloads.get(String(message.downloadId || ""));
      if (!item) {
        sendResponse({ ok: false, error: "The temporary web PDF download expired. Try Get from web again." });
        return false;
      }
      const offset = Math.max(0, Number(message.offset) || 0);
      const length = Math.min(512 * 1024, Math.max(1, Number(message.length) || 512 * 1024));
      const chunk = item.bytes.subarray(offset, Math.min(item.bytes.length, offset + length));
      sendResponse({
        ok: true,
        bodyBase64: webPdfBytesToBase64(chunk),
        byteLength: chunk.byteLength,
        eof: offset + chunk.byteLength >= item.bytes.length
      });
      return false;
    }

    if (message?.type === "ctca-release-web-pdf-download") {
      webPdfDownloads.delete(String(message.downloadId || ""));
      sendResponse({ ok: true });
      return false;
    }

    if (message?.type === "ctca-close-web-tab") {
      const tabId = Number(message.tabId);
      if (!Number.isInteger(tabId)) {
        sendResponse({ ok: false, error: "The journal tab could not be identified." });
        return false;
      }
      clearHumanCheckActionNotice(tabId)
        .then(() => extensionApi.tabs.remove(tabId))
        .then(() => sendResponse({ ok: true }))
        .catch((error) => sendResponse({ ok: false, error: error?.message || String(error) }));
      return true;
    }

    if (message?.type === "ctca-cancel-doi-metadata") {
      const controller = activeDoiRequests.get(String(message.requestId || ""));
      if (controller) controller.abort();
      sendResponse({ ok: true, aborted: Boolean(controller) });
      return false;
    }

    if (message?.type === "ctca-pdf-store-browser") {
      putPdfBlob(message.id, message.bytes, message.mimeType)
        .then(() => sendResponse({ ok: true }))
        .catch((error) => sendResponse({ ok: false, error: error?.message || String(error) }));
      return true;
    }

    if (message?.type === "ctca-pdf-get-browser") {
      getPdfBlob(message.id)
        .then(pdfBlobResponse)
        .then(sendResponse)
        .catch((error) => sendResponse({ ok: false, error: error?.message || String(error) }));
      return true;
    }

    if (message?.type === "ctca-pdf-delete-browser") {
      deletePdfBlob(message.id)
        .then(() => sendResponse({ ok: true }))
        .catch((error) => sendResponse({ ok: false, error: error?.message || String(error) }));
      return true;
    }

    if (message?.type === "ctca-pdf-store-session") {
      try {
        const blob = new Blob([
          message.bytes instanceof ArrayBuffer ? message.bytes : new Uint8Array(message.bytes || [])
        ], { type: message.mimeType || "application/pdf" });
        sessionPdfFiles.set(String(message.id), blob);
        sendResponse({ ok: true });
      } catch (error) {
        sendResponse({ ok: false, error: error?.message || String(error) });
      }
      return false;
    }

    if (message?.type === "ctca-pdf-get-session") {
      pdfBlobResponse(sessionPdfFiles.get(String(message.id)) || null)
        .then(sendResponse)
        .catch((error) => sendResponse({ ok: false, error: error?.message || String(error) }));
      return true;
    }

    if (message?.type === "ctca-pdf-delete-session") {
      sessionPdfFiles.delete(String(message.id));
      sendResponse({ ok: true });
      return false;
    }

    if (message?.type === "ctca-open-local-file-permission-settings") {
      openLocalFileAccessSettings()
        .then((url) => sendResponse({ ok: true, url }))
        .catch((error) => sendResponse({ ok: false, error: error?.message || String(error) }));
      return true;
    }

    if (message?.type === "ctca-pdf-get-local-url") {
      const url = String(message.url || "");
      if (!/^file:\/\//i.test(url)) {
        sendResponse({ ok: false, error: "Only file:// URLs can be loaded through the local-file bridge." });
        return false;
      }
      readLocalFileBytes(url)
        .then((bytes) => {
          if (!bytes.byteLength) throw new Error("The linked PDF is empty or could not be read.");
          return pdfBlobResponse(new Blob([bytes], { type: "application/pdf" }));
        })
        .then(sendResponse)
        .catch((error) => sendResponse({ ok: false, error: error?.message || String(error) }));
      return true;
    }

    if (message?.type === "ctca-open-standalone-manager-entry") {
      const rawKey = String(message.key || "");
      const key = encodeURIComponent(rawKey);
      openOrReuseStandaloneManager({
        url: `${extensionApi.runtime.getURL("manager.html")}#entry=${key}`,
        command: { type: "ctca-select-standalone-entry", key: rawKey }
      })
        .then((result) => sendResponse({ ok: true, tabId: result.tabId, reused: result.reused }))
        .catch((error) => sendResponse({ ok: false, error: error?.message || String(error) }));
      return true;
    }

    if (message?.type === "ctca-open-standalone-manager") {
      openStandaloneManager()
        .then(() => sendResponse({ ok: true }))
        .catch((error) => sendResponse({ ok: false, error: error?.message || String(error) }));
      return true;
    }

    if (message?.type === "ctca-open-manuscript-pdf-workflow") {
      try {
        const doi = normalizeDoi(message.doi);
        if (!DOI_PATTERN.test(doi)) throw new Error("The manuscript DOI is invalid.");
        const pdfUrl = new URL(String(message.pdfUrl || ""));
        const sourceUrl = new URL(String(message.sourceUrl || ""));
        if (!/^https?:$/.test(pdfUrl.protocol) || !/^https?:$/.test(sourceUrl.protocol)) {
          throw new Error("Only HTTP or HTTPS manuscript links can be opened.");
        }
        const parameters = new URLSearchParams({
          manuscriptDoi: doi,
          manuscriptPdfUrl: pdfUrl.href,
          manuscriptSourceUrl: sourceUrl.href,
          manuscriptSourceTabId: Number.isInteger(sender?.tab?.id) ? String(sender.tab.id) : ""
        });
        const workflow = {
          doi,
          pdfUrl: pdfUrl.href,
          sourceUrl: sourceUrl.href,
          sourceTabId: Number.isInteger(sender?.tab?.id) ? sender.tab.id : null
        };
        openOrReuseStandaloneManager({
          url: `${extensionApi.runtime.getURL("manager.html")}?${parameters.toString()}`,
          command: { type: "ctca-run-manuscript-pdf-workflow", workflow }
        })
          .then((result) => sendResponse({ ok: true, tabId: result.tabId, reused: result.reused }))
          .catch((error) => sendResponse({ ok: false, error: error?.message || String(error) }));
      } catch (error) {
        sendResponse({ ok: false, error: error?.message || String(error) });
        return false;
      }
      return true;
    }

    if (message?.type !== "ctca-fetch-doi-metadata") {
      return undefined;
    }

    const requestId = String(
      message.requestId || `ctca-doi-${Date.now()}-${Math.random().toString(36).slice(2)}`
    );
    const controller = new AbortController();
    activeDoiRequests.set(requestId, controller);

    fetchDoiMetadata(message.doi, controller.signal)
      .then((metadata) => sendResponse({ ok: true, metadata }))
      .catch((error) => sendResponse({ ok: false, error: error?.message || String(error) }))
      .finally(() => activeDoiRequests.delete(requestId));

    return true;
  });

  async function isSupportedEditorUrl(urlValue) {
    let url;
    try {
      url = new URL(String(urlValue || ""));
    } catch (_error) {
      return false;
    }
    if (url.protocol !== "https:") return false;
    const domains = await configuredEditorDomains();
    return domains.some((domain) => editorSiteDomainMatches(url.hostname, domain));
  }

  function isStandaloneManagerUrl(value) {
    const managerUrl = extensionApi.runtime.getURL("manager.html");
    const url = String(value || "");
    return url === managerUrl || url.startsWith(`${managerUrl}?`) || url.startsWith(`${managerUrl}#`);
  }

  async function focusStandaloneManagerTab(tab) {
    const updated = await extensionApi.tabs.update(tab.id, { active: true });
    if (Number.isInteger(tab.windowId) && extensionApi.windows?.update) {
      await extensionApi.windows.update(tab.windowId, { focused: true }).catch(() => {});
    }
    return updated || tab;
  }

  async function openOrReuseStandaloneManager({ url = extensionApi.runtime.getURL("manager.html"), command = null } = {}) {
    const tabs = await extensionApi.tabs.query({});
    const existing = tabs
      .filter((tab) => Number.isInteger(tab.id) && isStandaloneManagerUrl(tab.url))
      .sort((left, right) => Number(Boolean(right.active)) - Number(Boolean(left.active)))[0];

    if (!existing) {
      standalonePendingCreationCommand = command?.type === "ctca-offer-orcid-works" ? command : null;
      try {
        const created = await extensionApi.tabs.create({ url, active: true });
        return { tabId: created?.id ?? null, reused: false };
      } catch (error) {
        standalonePendingCreationCommand = null;
        throw error;
      }
    }

    await focusStandaloneManagerTab(existing);
    if (command) {
      const port = standaloneManagerPorts.get(existing.id);
      if (port) {
        try {
          port.postMessage(command);
          return { tabId: existing.id, reused: true };
        } catch (_error) {
          standaloneManagerPorts.delete(existing.id);
        }
      }
      await extensionApi.tabs.update(existing.id, { url, active: true });
    }
    return { tabId: existing.id, reused: true };
  }

  async function openStandaloneManager() {
    await openOrReuseStandaloneManager();
  }

  async function openManagerFromAction(clickedTab) {
    const activeEditorTab = clickedTab?.active && await isSupportedEditorUrl(clickedTab.url)
      ? clickedTab
      : null;

    if (!activeEditorTab?.id) {
      await openStandaloneManager();
      return;
    }

    try {
      const response = await extensionApi.tabs.sendMessage(
        activeEditorTab.id,
        { type: "ctca-open-bib-manager" }
      );
      if (response?.ok === false) {
        throw new Error(response.error || "Could not open bibliography manager.");
      }
    } catch (_error) {
      // Never activate, reload, or switch to another editor tab. If the
      // active tab cannot open the in-page manager, use the standalone one.
      await openStandaloneManager();
    }
  }

  extensionApi.tabs.onRemoved?.addListener((tabId) => {
    standaloneManagerPorts.delete(tabId);
    clearPendingWebPdfAutoContinue(tabId);
    for (const [humanCheckTabId, pending] of pendingWebPdfAutoContinue) {
      if (pending.returnTabId === tabId) clearPendingWebPdfAutoContinue(humanCheckTabId);
    }
    const returnTimer = humanCheckReturnTimers.get(tabId);
    if (returnTimer) globalThis.clearTimeout(returnTimer);
    humanCheckReturnTimers.delete(tabId);
    humanCheckReturnTabs.delete(tabId);
    humanCheckInitialUrls.delete(tabId);
    const notificationId = `${HUMAN_CHECK_NOTIFICATION_PREFIX}${tabId}`;
    humanCheckNotificationTabs.delete(notificationId);
    extensionApi.notifications?.clear?.(notificationId).catch?.(() => {});
  });

  extensionApi.tabs.onUpdated?.addListener((tabId, changeInfo) => {
    const returnTabId = humanCheckReturnTabs.get(tabId);
    if (!Number.isInteger(returnTabId) || !changeInfo?.url) return;
    const previousTimer = humanCheckReturnTimers.get(tabId);
    if (previousTimer) globalThis.clearTimeout(previousTimer);
    humanCheckReturnTimers.delete(tabId);
    const initialUrl = humanCheckInitialUrls.get(tabId) || "";
    if (!initialUrl) {
      humanCheckInitialUrls.set(tabId, String(changeInfo.url));
      return;
    }
    if (String(changeInfo.url) === initialUrl) return;
    const timer = globalThis.setTimeout(() => {
      humanCheckReturnTimers.delete(tabId);
      extensionApi.tabs.get(tabId)
        .then((tab) => {
          const currentInitialUrl = humanCheckInitialUrls.get(tabId) || "";
          if (!currentInitialUrl || String(tab?.url || "") === currentInitialUrl) return;
          return returnToSmartCitationsAndContinue(tabId, returnTabId);
        })
        .catch(() => {});
    }, WEB_PAGE_SETTLE_MS);
    humanCheckReturnTimers.set(tabId, timer);
  });

  extensionApi.tabs.onActivated?.addListener(({ tabId }) => {
    updateJournalSiteActionBadge(tabId).catch(() => {});
  });

  extensionApi.tabs.onUpdated?.addListener((tabId, changeInfo, tab) => {
    if (!tab?.active || (!changeInfo?.url && changeInfo?.status !== "complete")) return;
    updateJournalSiteActionBadge(tabId, changeInfo.url || tab.url).catch(() => {});
  });

  extensionApi.storage.onChanged?.addListener((changes, areaName) => {
    if (areaName !== "local") return;
    if (AUTHOR_OPTIONS_KEY in changes) refreshActiveJournalSiteBadges().catch(() => {});
    if (EDITOR_SITES_KEY in changes) {
      queueConfiguredEditorContentScriptSync().catch((error) => {
        console.error("[Smart Citations] Could not activate configured document editor sites.", error);
      });
    }
  });

  extensionApi.runtime.onInstalled?.addListener((details) => {
    refreshActiveJournalSiteBadges().catch(() => {});
    queueConfiguredEditorContentScriptSync().catch(() => {});
    if (details?.reason === "install") showInstallWelcome().catch(() => {});
  });

  extensionApi.runtime.onStartup?.addListener(() => {
    refreshActiveJournalSiteBadges().catch(() => {});
    queueConfiguredEditorContentScriptSync().catch(() => {});
  });

  extensionApi.notifications?.onClicked?.addListener((notificationId) => {
    if (!humanCheckNotificationTabs.has(notificationId)) return;
    const humanCheckTabId = Number(String(notificationId).slice(HUMAN_CHECK_NOTIFICATION_PREFIX.length));
    if (!Number.isInteger(humanCheckTabId)) return;
    extensionApi.notifications?.clear?.(notificationId).catch?.(() => {});
    extensionApi.tabs.update(humanCheckTabId, { active: true }).catch(() => {});
  });

  extensionApi.notifications?.onClosed?.addListener((notificationId) => {
    humanCheckNotificationTabs.delete(notificationId);
  });

  extensionApi.action?.onClicked?.addListener((tab) => {
    const returnTabId = humanCheckReturnTabs.get(tab?.id);
    if (Number.isInteger(returnTabId)) {
      extensionApi.tabs.update(returnTabId, { active: true }).catch(() => openStandaloneManager());
      return;
    }
    openManagerFromAction(tab).catch(() => openStandaloneManager());
  });

  refreshActiveJournalSiteBadges().catch(() => {});
  queueConfiguredEditorContentScriptSync().catch((error) => {
    console.error("[Smart Citations] Could not activate configured document editor sites.", error);
  });
})();
