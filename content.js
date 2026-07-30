/* SPDX-License-Identifier: CC-BY-NC-SA-4.0 */

(() => {
  "use strict";

  const IS_COLLABTEX = /^collabtex\./i.test(window.location.hostname);
  const IS_OVERLEAF = /(^|\.)overleaf\.com$/i.test(window.location.hostname);
  if (!IS_COLLABTEX && !IS_OVERLEAF) {
    return;
  }

  if (window.top !== window) {
    return;
  }

  document.documentElement.classList.add(IS_OVERLEAF ? "ctca-platform-overleaf" : "ctca-platform-collabtex");

  const REQUEST_EVENT = "collabtex-cite-assistant:request";
  const RESPONSE_EVENT = "collabtex-cite-assistant:response";
  const STATE_EVENT = "collabtex-cite-assistant:state";
  const STORAGE_PREFIX = "collabtex-citation-assistant:";
  const CACHE_VERSION = 5;
  const MAX_RESULTS = 30;
  const FILE_OPEN_TIMEOUT_MS = 30000;
  const FILE_CONTENT_STABLE_MS = 650;
  const FILE_POLL_INTERVAL_MS = 125;
  const POPUP_OPEN_DELAY_MS = 500;
  const NAVIGATION_ENTRY_WINDOW_MS = 800;
  const DOI_BULK_DELAY_MS = 150;
  const DOI_PATTERN = /^10\.\d{4,9}\/\S+$/i;
  const GLOBAL_DATABASE_KEY = `${STORAGE_PREFIX}global-bibliography:v1`;
  const GLOBAL_PENDING_KEY = `${STORAGE_PREFIX}global-bibliography-pending:v1`;
  const GLOBAL_PREFERENCES_KEY = `${STORAGE_PREFIX}global-preferences:v1`;
  const AUTHOR_OPTIONS_KEY = `${STORAGE_PREFIX}manuscript-links:v1`;
  const GLOBAL_DOCUMENT_PUSH_STATE_KEY = `${STORAGE_PREFIX}global-document-push-state:v1`;
  const GLOBAL_SYNC_SNAPSHOT_SUFFIX = ":global-sync-snapshot:v1";
  const PROJECT_NEXTCLOUD_LINKS_SUFFIX = ":nextcloud-file-links:v1";
  const PROJECT_NEXTCLOUD_LINKS_FILE = ".collabtex-nextcloud-links.json";
  const GLOBAL_SETUP_BIB_FILE = "bibliography.bib";
  const GLOBAL_DELETION_CONFIRM_THRESHOLD = 5;
  const GLOBAL_CHANGE_CHECK_INTERVAL_MS = 30 * 1000;
  const GLOBAL_DOCUMENT_SYNC_VERSION = 1;
  const CATEGORY_STATE_VERSION = 1;
  const CTCA_META_VERSION = "1";
  const CTCA_META_VERSION_FIELD = "ctca_meta_version";
  const CTCA_DOI_SYNC_FIELD = "ctca_doi_synced";
  const CTCA_CATEGORY_IDS_FIELD = "ctca_categories";
  const CTCA_CATEGORY_TREE_FIELD = "ctca_category_tree";
  const CTCA_TAGS_FIELD = "ctca_tags";
  const CTCA_ADDED_ON_FIELD = "ctca_added_on";
  const CTCA_STARRED_FIELD = "ctca_starred";
  const CENTRAL_PREVIEW_SOURCE = "__ctca_central_preview__";
  const CTCA_INTERNAL_FIELDS = new Set([
    CTCA_META_VERSION_FIELD,
    CTCA_DOI_SYNC_FIELD,
    CTCA_CATEGORY_IDS_FIELD,
    CTCA_CATEGORY_TREE_FIELD,
    CTCA_TAGS_FIELD,
    CTCA_ADDED_ON_FIELD,
    CTCA_STARRED_FIELD
  ]);
  const MANAGER_LIST_COLUMNS = [
    { id: "title", label: "Title / authors", min: 140, defaultWidth: 360, defaultVisible: true },
    { id: "year", label: "Year", min: 58, defaultWidth: 72, defaultVisible: true },
    { id: "key", label: "Citation key", min: 100, defaultWidth: 170, defaultVisible: true },
    { id: "addedOn", label: "Added on", min: 130, defaultWidth: 176, defaultVisible: false }
  ];
  const AVAILABLE_BIB_FIELDS = [
    "address", "annote", "annotation", "archiveprefix", "booktitle", "chapter", "crossref",
    "edition", "editor", "eprint", "howpublished", "institution", "isbn", "issn", "journal",
    "journaltitle", "keywords", "language", "month", "note", "number", "organization", "pages",
    "pmid", "publisher", "school", "series", "title", "type", "url", "urldate", "volume", "year", "ids"
  ];
  const BIB_ENTRY_TYPES = ["article", "book", "booklet", "conference", "inbook", "incollection", "inproceedings", "manual", "mastersthesis", "misc", "phdthesis", "proceedings", "techreport", "unpublished"];
  const extensionApi = globalThis.browser ?? globalThis.chrome;
  const DEFAULT_SETTINGS = Object.freeze({
    caseSensitive: false,
    searchFields: {
      key: true,
      title: true,
      authors: true,
      journal: true,
      year: true,
      keywords: true,
      abstract: true,
      doi: true,
      other: true
    },
    appearance: {
      mode: "full",
      showTitleInCompact: true,
      fontSize: 13
    },
    managerSearchFields: {
      key: true,
      authors: true,
      journal: true,
      year: true,
      abstract: true,
      others: true
    },
    managerColumns: {
      categories: 190,
      details: 420,
      authorImpact: 300,
      title: 360,
      year: 72,
      key: 170,
      addedOn: 176
    },
    managerColumnVisibility: {
      title: true,
      year: true,
      key: true,
      addedOn: false,
      authors: true
    },
    managerSelectedCategoryId: "all",
    managerStarredFirst: false,
    managerAuthorImpactCollapsed: false,
    managerSearchOptions: {
      includeAbstract: true,
      includePdfText: false
    },
    managerFilters: {
      type: "",
      yearFrom: "",
      yearTo: "",
      doi: "any",
      tagged: "any"
    },
    syncGlobalDatabase: false
  });

  const CITE_COMMAND = /\\(?:cite|citep|citet|citealp|citealt|citeauthor|citeyear|parencite|textcite|autocite|footcite|smartcite|supercite|nocite)\*?(?:\s*\[[^\]]*\]){0,2}\s*\{([^{}]*)$/i;

  let currentState = null;
  let currentContext = null;
  let records = [];
  let renderedRecords = [];
  let selectedIndex = 0;
  let refreshInProgress = false;
  let jumpInProgress = false;
  let requestCounter = 0;
  let positionRequestCounter = 0;
  let anchorScreen = null;
  let settings = cloneDefaultSettings();
  let cachedFiles = [];
  let dismissedSelection = null;
  let doiOperationInProgress = false;
  let activeMenu = null;
  let popupOpenTimer = null;
  let pendingContextId = "";
  let popupContextId = "";
  let popupKeyboardActive = true;
  let lastEditorInteraction = "other";
  let lastEditorInteractionAt = 0;
  let managerRecords = [];
  let managerDrafts = new Map();
  let managerDirtyIds = new Set();
  let managerNewEntryKeys = new Set();
  let managerPendingCentralIdentities = new Set();
  let managerFastCentralSyncTimer = null;
  let managerFastCentralSyncInProgress = false;
  let managerFastCentralSyncPromise = Promise.resolve();
  const managerFastCentralSyncDraftIds = new Set();
  let managerSelectedId = "";
  let managerSelectedIds = new Set();
  let managerDetailsCollapsedManually = false;
  let managerLastSelectionAnchorId = "";
  let managerSelectedCategoryId = "all";
  let managerAuthorshipUserName = "";
  let managerCategoryState = { version: CATEGORY_STATE_VERSION, categories: [], memberships: {} };
  let managerCategoryDragId = "";
  let managerQuery = "";
  let globalPromptChecked = false;
  let startupAssistantCheckInProgress = false;
  let projectBibliographySetupInProgress = false;
  let globalBanner = null;
  let globalBannerTimer = null;
  let documentBibliographyUpdateOverlay = null;
  let managerSort = { field: "author", direction: "asc" };
  let managerFiles = [];
  let managerOriginalFile = "";
  let managerReturnTexFile = "";
  let managerBusy = false;
  let managerSessionChanged = false;
  let managerCloseCommitRequested = false;
  let managerListRenderTimer = null;
  let managerCategoryListRenderRevision = 0;
  let managerWorkspaceTab = "bibliography";
  const managerOpenPdfTabs = new Map();
  const managerPdfAttachmentLoadingIds = new Set();
  const managerPendingPdfSaveRequests = new Map();
  let managerPdfNoteSaveTimer = null;
  let managerPdfNotesWidth = 360;
  let managerPdfDetailsWidth = 390;
  let managerPdfFullscreenPaneState = null;
  let managerDeletedDrafts = new Map();
  let managerCentralDeletionChoices = new Map();
  let managerPendingCentralDeletionIdentities = new Set();
  let managerBulkDoiAbortRequested = false;
  let managerBulkDoiActiveRequestId = "";
  let managerBulkDoiStats = null;
  let managerNextcloudSyncTimer = null;
  let managerNextcloudSyncInProgress = false;
  let managerNextcloudConnected = false;
  let globalDatabaseSyncTimer = null;
  let globalDatabaseSyncInProgress = false;
  let globalDatabaseSyncQueued = false;
  let blockedGlobalDeletionSignature = "";
  let suppressGlobalDatabaseStorageSync = false;
  let globalDocumentFlagCheckInProgress = false;
  let globalDocumentPendingCount = 0;
  let globalDocumentPendingRevision = 0;
  let globalDocumentWasPending = false;
  let globalSuggestionRecords = [];
  let globalSuggestionDeletedIdentities = new Set();
  const observedBibTextByFile = new Map();
  let observedEditorFileName = "";
  let deferredProjectGlobalPush = false;
  let doiSyncLedger = {};
  let legacyCachedManagerState = null;
  let legacyCachedDoiSyncLedger = null;
  let doiSuccessToastTimer = null;
  let projectNextcloudLinks = [];
  let projectNextcloudUiObserver = null;
  let projectNextcloudUiTimer = null;
  let projectNextcloudUpdateInProgress = false;
  let projectCloudToastTimer = null;
  let projectNextcloudMetadataTimer = null;
  let projectNextcloudMetadataWriteInProgress = false;

  const pendingRequests = new Map();
  const popup = createPopup();
  const abstractOverlay = createAbstractOverlay();
  const doiSuccessToast = createDoiSuccessToast();
  const appDialog = createAppDialog();
  const bibManager = createBibManagerOverlay();
  const toolbarButton = createToolbarButton();

  function cloneDefaultSettings() {
    return {
      caseSensitive: DEFAULT_SETTINGS.caseSensitive,
      searchFields: { ...DEFAULT_SETTINGS.searchFields },
      appearance: { ...DEFAULT_SETTINGS.appearance },
      managerSearchFields: { ...DEFAULT_SETTINGS.managerSearchFields },
      managerColumns: { ...DEFAULT_SETTINGS.managerColumns },
      managerColumnVisibility: { ...DEFAULT_SETTINGS.managerColumnVisibility },
      managerSelectedCategoryId: DEFAULT_SETTINGS.managerSelectedCategoryId,
      managerStarredFirst: DEFAULT_SETTINGS.managerStarredFirst,
      managerAuthorImpactCollapsed: DEFAULT_SETTINGS.managerAuthorImpactCollapsed,
      managerSearchOptions: { ...DEFAULT_SETTINGS.managerSearchOptions },
      managerFilters: { ...DEFAULT_SETTINGS.managerFilters },
      syncGlobalDatabase: DEFAULT_SETTINGS.syncGlobalDatabase
    };
  }


  function formatFullAuthors(authors) {
    if (!authors?.length) return "Authors not specified";
    return authors.join("; ");
  }

  function normalizeAbstractText(value) {
    return String(value ?? "")
      .replace(/^\s*abstract\b\s*[:.\-–—]?\s*/i, "")
      .trim();
  }

  function createDoiSuccessToast() {
    const root = document.createElement("div");
    root.id = "ctca-doi-success-toast";
    root.setAttribute("role", "status");
    root.setAttribute("aria-live", "polite");
    root.setAttribute("aria-atomic", "true");
    root.innerHTML = `
      <span class="ctca-doi-success-toast-icon" aria-hidden="true">✓</span>
      <span class="ctca-doi-success-toast-text"></span>
      <button type="button" class="ctca-doi-success-toast-close" aria-label="Close notification" title="Close">×</button>
    `;
    root.querySelector(".ctca-doi-success-toast-close")?.addEventListener("click", hideDoiSuccessToast);
    document.documentElement.appendChild(root);
    return root;
  }

  function showDoiSuccessToast(key, source = "") {
    if (!doiSuccessToast) return;
    window.clearTimeout(doiSuccessToastTimer);
    const sourceText = source ? ` from ${source}` : "";
    doiSuccessToast.querySelector(".ctca-doi-success-toast-text").textContent =
      `DOI update successful: ${key}${sourceText}.`;
    doiSuccessToast.classList.add("ctca-doi-success-toast-visible");
    doiSuccessToastTimer = window.setTimeout(hideDoiSuccessToast, 10000);
  }

  function hideDoiSuccessToast() {
    window.clearTimeout(doiSuccessToastTimer);
    doiSuccessToastTimer = null;
    doiSuccessToast?.classList.remove("ctca-doi-success-toast-visible");
  }

  function createAppDialog() {
    const root = document.createElement("div");
    root.id = "ctca-app-dialog";
    root.setAttribute("aria-hidden", "true");
    root.innerHTML = `
      <div class="ctca-app-dialog-backdrop"></div>
      <section class="ctca-app-dialog-card" role="dialog" aria-modal="true" aria-labelledby="ctca-app-dialog-title">
        <button type="button" class="ctca-app-dialog-close" aria-label="Close dialog" title="Close">×</button>
        <h2 id="ctca-app-dialog-title"></h2>
        <div class="ctca-app-dialog-message"></div>
        <div class="ctca-app-dialog-controls"></div>
        <div class="ctca-app-dialog-actions"></div>
      </section>
    `;
    root.addEventListener("mousedown", (event) => event.stopPropagation());
    document.documentElement.appendChild(root);
    return root;
  }

  function showAppDialog({
    title,
    message = "",
    controls = null,
    buttons = [{ label: "Close", value: null }],
    closeValue = null,
    danger = false,
    dialogClass = ""
  }) {
    return new Promise((resolve) => {
      const titleElement = appDialog.querySelector("#ctca-app-dialog-title");
      const messageElement = appDialog.querySelector(".ctca-app-dialog-message");
      const controlsElement = appDialog.querySelector(".ctca-app-dialog-controls");
      const actionsElement = appDialog.querySelector(".ctca-app-dialog-actions");
      const closeButton = appDialog.querySelector(".ctca-app-dialog-close");
      const backdrop = appDialog.querySelector(".ctca-app-dialog-backdrop");
      const card = appDialog.querySelector(".ctca-app-dialog-card");
      let settled = false;

      const finish = (value) => {
        if (settled) return;
        settled = true;
        appDialog.classList.remove("ctca-app-dialog-visible");
        appDialog.setAttribute("aria-hidden", "true");
        if (dialogClass) card.classList.remove(dialogClass);
        document.removeEventListener("keydown", onKeyDown, true);
        closeButton.onclick = null;
        backdrop.onclick = null;
        window.setTimeout(() => {
          if (!appDialog.classList.contains("ctca-app-dialog-visible")) {
            messageElement.replaceChildren();
            controlsElement.replaceChildren();
            actionsElement.replaceChildren();
          }
        }, 160);
        resolve(value);
      };

      const onKeyDown = (event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          finish(closeValue);
          return;
        }
        if (event.key === "Enter" && !event.shiftKey && !event.target.closest("textarea")) {
          const primaryButton = actionsElement.querySelector(".ctca-app-dialog-primary");
          if (!primaryButton) return;
          event.preventDefault();
          event.stopPropagation();
          primaryButton.click();
        }
      };

      document.documentElement.appendChild(appDialog);
      titleElement.textContent = title || "Confirmation";
      messageElement.replaceChildren();
      if (message instanceof Node) {
        messageElement.appendChild(message);
      } else {
        const paragraphs = String(message || "").split(/\n{2,}/);
        for (const paragraph of paragraphs) {
          const node = document.createElement("p");
          node.textContent = paragraph;
          messageElement.appendChild(node);
        }
      }

      controlsElement.replaceChildren();
      if (typeof controls === "function") controls(controlsElement);
      else if (controls instanceof Node) controlsElement.appendChild(controls);
      controlsElement.hidden = !controlsElement.childNodes.length;

      actionsElement.replaceChildren();
      for (const specification of buttons) {
        const button = document.createElement("button");
        button.type = "button";
        button.textContent = specification.label;
        if (specification.primary) button.classList.add("ctca-app-dialog-primary");
        if (specification.danger) button.classList.add("ctca-app-dialog-danger");
        button.addEventListener("click", () => {
          const value = typeof specification.getValue === "function"
            ? specification.getValue()
            : specification.value;
          finish(value);
        });
        actionsElement.appendChild(button);
      }

      card.classList.toggle("ctca-app-dialog-danger-card", Boolean(danger));
      card.classList.remove("ctca-nextcloud-picker-dialog-card");
      if (dialogClass) card.classList.add(dialogClass);
      closeButton.onclick = () => finish(closeValue);
      backdrop.onclick = () => finish(closeValue);
      document.addEventListener("keydown", onKeyDown, true);
      appDialog.classList.add("ctca-app-dialog-visible");
      appDialog.setAttribute("aria-hidden", "false");
      window.setTimeout(() => {
        const focusTarget = controlsElement.querySelector("input, select, textarea, button")
          || actionsElement.querySelector(".ctca-app-dialog-primary")
          || actionsElement.querySelector("button");
        focusTarget?.focus();
      }, 0);
    });
  }

  async function showBatchDoiConfirmation(total, previouslySynchronized) {
    let includePreviouslySynchronized = false;
    const result = await showAppDialog({
      title: "Update bibliography entries from DOI",
      message:
        `${total} entr${total === 1 ? "y contains" : "ies contain"} a DOI. ` +
        `${previouslySynchronized ? `${previouslySynchronized} ${previouslySynchronized === 1 ? "was" : "were"} synchronized before. ` : ""}` +
        "Citation keys and fields not supplied by the DOI service will be preserved.",
      controls: (container) => {
        const label = document.createElement("label");
        label.className = "ctca-app-dialog-check";
        const checkbox = document.createElement("input");
        checkbox.type = "checkbox";
        checkbox.checked = false;
        checkbox.addEventListener("change", () => {
          includePreviouslySynchronized = checkbox.checked;
        });
        label.append(checkbox, document.createTextNode("Also update entries that were updated from DOI before"));
        container.appendChild(label);
      },
      buttons: [
        { label: "Cancel", value: null },
        {
          label: "Start DOI update",
          primary: true,
          getValue: () => ({ includePreviouslySynchronized })
        }
      ],
      closeValue: null
    });
    return result;
  }

  function createAbstractOverlay() {
    const root = document.createElement("div");
    root.id = "ctca-abstract-overlay";
    root.setAttribute("role", "presentation");
    root.innerHTML = `
      <div class="ctca-abstract-backdrop"></div>
      <section
        class="ctca-abstract-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="ctca-abstract-title"
      >
        <button
          type="button"
          class="ctca-abstract-close"
          aria-label="Close abstract"
          title="Close"
        >×</button>
        <h2 id="ctca-abstract-title" class="ctca-abstract-title"></h2>
        <div class="ctca-abstract-full-authors"></div>
        <div class="ctca-abstract-publication"></div>
        <div class="ctca-abstract-body-row">
          <strong>Abstract:</strong>
          <div class="ctca-abstract-body"></div>
        </div>
      </section>
    `;

    const closeButton = root.querySelector(".ctca-abstract-close");
    const backdrop = root.querySelector(".ctca-abstract-backdrop");
    closeButton.addEventListener("click", closeAbstractOverlay);
    backdrop.addEventListener("click", closeAbstractOverlay);
    root.addEventListener("mousedown", (event) => event.stopPropagation());

    initializeManagerResizers(root);
    document.documentElement.appendChild(root);
    applyManagerColumnWidths(root);
    return root;
  }

  function createAbstractPublicationLine(record) {
    const publication = document.createDocumentFragment();
    let hasPart = false;

    const appendTextPart = (text, bold = false) => {
      if (!text) return;
      if (hasPart) publication.appendChild(document.createTextNode(", "));
      const node = bold ? document.createElement("strong") : document.createElement("span");
      node.textContent = text;
      publication.appendChild(node);
      hasPart = true;
    };

    appendTextPart(record.journal || "Journal not specified");
    appendTextPart(record.volume || "", true);
    appendTextPart(record.pages || "");
    appendTextPart(record.year ? `(${record.year})` : "");

    publication.appendChild(document.createTextNode(hasPart ? ", DOI: " : "DOI: "));
    if (record.doi) {
      const doiLink = document.createElement("a");
      doiLink.href = `https://doi.org/${encodeURI(record.doi)}`;
      doiLink.target = "_blank";
      doiLink.rel = "noopener noreferrer";
      doiLink.textContent = record.doi;
      publication.appendChild(doiLink);
    } else {
      publication.appendChild(document.createTextNode("not specified"));
    }
    const openAlexDescriptor = globalThis.SmartCitationsOpenAlex.descriptor(record, `abstract:${record.key || record.doi || "reference"}`);
    if (openAlexDescriptor.identity) {
      const citation = document.createElement("span");
      citation.className = "ctca-openalex-citation";
      citation.dataset.openalexLookupKey = openAlexDescriptor.lookupKey;
      citation.textContent = "Citations: …";
      publication.append(document.createTextNode(" "), citation);
    }

    return publication;
  }

  function openAbstractOverlay(record) {
    if (!record?.abstract) return;

    abstractOverlay.querySelector(".ctca-abstract-title").textContent =
      record.title || record.key || "Untitled reference";
    abstractOverlay.querySelector(".ctca-abstract-full-authors").textContent =
      formatFullAuthors(record.authors);

    const publication = abstractOverlay.querySelector(".ctca-abstract-publication");
    publication.replaceChildren(createAbstractPublicationLine(record));
    abstractOverlay.querySelector(".ctca-abstract-body").textContent = normalizeAbstractText(record.abstract);

    abstractOverlay.classList.add("ctca-abstract-overlay-visible");
    abstractOverlay.setAttribute("aria-hidden", "false");
    globalThis.SmartCitationsOpenAlex.hydrateCitations(abstractOverlay, [
      globalThis.SmartCitationsOpenAlex.descriptor(record, `abstract:${record.key || record.doi || "reference"}`)
    ]).catch(() => {});
    window.requestAnimationFrame(() => {
      abstractOverlay.querySelector(".ctca-abstract-close")?.focus();
    });
  }

  function closeAbstractOverlay(event) {
    event?.preventDefault?.();
    event?.stopPropagation?.();
    if (!abstractOverlay?.classList.contains("ctca-abstract-overlay-visible")) return;

    abstractOverlay.classList.remove("ctca-abstract-overlay-visible");
    abstractOverlay.setAttribute("aria-hidden", "true");
    bridgeRequest("focus").catch(() => {});
  }

  function mergeSettings(value) {
    const merged = cloneDefaultSettings();
    if (!value || typeof value !== "object") return merged;

    merged.caseSensitive = Boolean(value.caseSensitive);
    if (value.searchFields && typeof value.searchFields === "object") {
      const expandedFields = ["title", "journal", "year", "other"];
      const isLegacyFieldSelection = !expandedFields.some((field) => field in value.searchFields);

      // Older releases only knew key/authors/keywords/abstract/DOI. On first load
      // after this upgrade, enable the expanded all-field search instead of
      // silently retaining a citation-key-only legacy configuration.
      if (!isLegacyFieldSelection) {
        for (const field of Object.keys(merged.searchFields)) {
          if (field in value.searchFields) {
            merged.searchFields[field] = Boolean(value.searchFields[field]);
          }
        }
      }
    }
    if (!Object.values(merged.searchFields).some(Boolean)) {
      merged.searchFields.key = true;
    }


    if (value.managerSearchFields && typeof value.managerSearchFields === "object") {
      for (const field of Object.keys(merged.managerSearchFields)) {
        if (field in value.managerSearchFields) {
          merged.managerSearchFields[field] = Boolean(value.managerSearchFields[field]);
        }
      }
    }
    if (!Object.values(merged.managerSearchFields).some(Boolean)) {
      merged.managerSearchFields.key = true;
    }

    if (value.managerColumns && typeof value.managerColumns === "object") {
      const categories = Number(value.managerColumns.categories);
      const details = Number(value.managerColumns.details);
      const authorImpact = Number(value.managerColumns.authorImpact);
      if (Number.isFinite(categories)) merged.managerColumns.categories = Math.max(130, Math.min(420, categories));
      if (Number.isFinite(details)) merged.managerColumns.details = Math.max(280, Math.min(900, details));
      if (Number.isFinite(authorImpact)) merged.managerColumns.authorImpact = Math.max(120, Math.min(720, authorImpact));
      for (const column of MANAGER_LIST_COLUMNS) {
        const width = Number(value.managerColumns[column.id]);
        if (Number.isFinite(width)) merged.managerColumns[column.id] = Math.max(column.min, Math.min(700, width));
      }
    }
    if (value.managerColumnVisibility && typeof value.managerColumnVisibility === "object") {
      for (const key of Object.keys(merged.managerColumnVisibility)) {
        if (key in value.managerColumnVisibility) merged.managerColumnVisibility[key] = value.managerColumnVisibility[key] !== false;
      }
    }
    merged.managerStarredFirst = value.managerStarredFirst === true;
    merged.managerAuthorImpactCollapsed = value.managerAuthorImpactCollapsed === true;
    if (typeof value.managerSelectedCategoryId === "string" && value.managerSelectedCategoryId) {
      merged.managerSelectedCategoryId = value.managerSelectedCategoryId;
    }
    if (value.managerSearchOptions && typeof value.managerSearchOptions === "object") {
      merged.managerSearchOptions.includeAbstract = value.managerSearchOptions.includeAbstract !== false;
      merged.managerSearchOptions.includePdfText = value.managerSearchOptions.includePdfText === true;
    }
    merged.managerFilters = globalThis.CollabTeXSearchTools.normalizeFilterState(value.managerFilters || merged.managerFilters);
    merged.syncGlobalDatabase = value.syncGlobalDatabase === true || (value.rememberGlobalPushChoice === true && value.globalPushChoice === "push");

    if (value.appearance && typeof value.appearance === "object") {
      merged.appearance.mode = value.appearance.mode === "compact" ? "compact" : "full";
      merged.appearance.showTitleInCompact = value.appearance.showTitleInCompact !== false;
      const fontSize = Number(value.appearance.fontSize);
      if ([10, 11, 12, 13, 14, 16, 18].includes(fontSize)) {
        merged.appearance.fontSize = fontSize;
      }
    }

    return merged;
  }

  function closeMenus(except = null) {
    popup.querySelectorAll(".ctca-menu.ctca-menu-open").forEach((menu) => {
      if (menu !== except) {
        menu.classList.remove("ctca-menu-open");
        menu.closest(".ctca-menu-wrap")?.querySelector(".ctca-menu-button")
          ?.setAttribute("aria-expanded", "false");
      }
    });
    activeMenu = except;
    popup.classList.toggle("ctca-menu-active", Boolean(except));
  }

  function toggleMenu(menu, button) {
    const shouldOpen = !menu.classList.contains("ctca-menu-open");
    closeMenus(shouldOpen ? menu : null);
    menu.classList.toggle("ctca-menu-open", shouldOpen);
    button.setAttribute("aria-expanded", shouldOpen ? "true" : "false");
    activeMenu = shouldOpen ? menu : null;
    positionPopup();
  }

  function createPopup() {
    const root = document.createElement("div");
    root.id = "ctca-popup";
    root.setAttribute("role", "listbox");
    root.setAttribute("aria-label", "Citation suggestions");
    root.innerHTML = `
      <div class="ctca-header">
        <div class="ctca-filter" title="Current citation search text"></div>
        <button
          type="button"
          class="ctca-case-button"
          aria-pressed="false"
          aria-label="Toggle case-sensitive matching"
          title="Case-sensitive matching"
        >a→A</button>
        <div class="ctca-menu-wrap">
          <button
            type="button"
            class="ctca-menu-button ctca-config-button"
            aria-expanded="false"
            aria-label="Citation assistant settings"
            title="Settings"
          >⚙</button>
          <div class="ctca-menu ctca-config-menu" role="menu" aria-label="Citation assistant settings">
            <div class="ctca-menu-title">Search in fields</div>
            <label><input type="checkbox" data-search-field="key"> Citation keys</label>
            <label><input type="checkbox" data-search-field="title"> Title</label>
            <label><input type="checkbox" data-search-field="authors"> Authors and editors</label>
            <label><input type="checkbox" data-search-field="journal"> Journal, book, or proceedings title</label>
            <label><input type="checkbox" data-search-field="year"> Year and date</label>
            <label><input type="checkbox" data-search-field="keywords"> Keywords</label>
            <label><input type="checkbox" data-search-field="abstract"> Abstract</label>
            <label><input type="checkbox" data-search-field="doi"> DOI</label>
            <label><input type="checkbox" data-search-field="other"> All remaining BibTeX fields</label>

            <div class="ctca-menu-title ctca-menu-section-title">Appearance</div>
            <label><input type="radio" name="ctca-view-mode" value="full"> Full cards</label>
            <label><input type="radio" name="ctca-view-mode" value="compact"> Compact cards</label>
            <label class="ctca-compact-title-option"><input type="checkbox" class="ctca-show-compact-title"> Show title in compact view</label>
            <label class="ctca-font-size-row">Font size
              <select class="ctca-font-size">
                <option value="10">10 px</option>
                <option value="11">11 px</option>
                <option value="12">12 px</option>
                <option value="13">13 px</option>
                <option value="14">14 px</option>
                <option value="16">16 px</option>
                <option value="18">18 px</option>
              </select>
            </label>

            <div class="ctca-menu-title ctca-menu-section-title">Bibliography</div>
            <button type="button" class="ctca-update" title="Open and parse the bibliography file(s) used by this TeX document">↻ Update bibliography</button>
            <button type="button" class="ctca-update-all-doi" title="Update every parsed BibTeX entry that contains a DOI">🌐 Update all entries from DOI</button>
          </div>
        </div>
      </div>
      <div class="ctca-status" aria-live="polite"></div>
      <div class="ctca-list"></div>
    `;

    const configButton = root.querySelector(".ctca-config-button");
    const configMenu = root.querySelector(".ctca-config-menu");
    configButton.addEventListener("mousedown", (event) => {
      event.preventDefault();
      event.stopPropagation();
    });
    configButton.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      toggleMenu(configMenu, configButton);
    });

    const caseButton = root.querySelector(".ctca-case-button");
    caseButton.addEventListener("mousedown", (event) => {
      event.preventDefault();
      event.stopPropagation();
    });
    caseButton.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      settings.caseSensitive = !settings.caseSensitive;
      selectedIndex = 0;
      applySettingsToPopup(root);
      renderSuggestions();
      saveCachedState(cachedFiles).catch(() => {});
    });

    root.querySelector(".ctca-update").addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      closeMenus();
      refreshBibliography();
    });

    root.querySelector(".ctca-update-all-doi").addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      closeMenus();
      updateAllRecordsFromDoi();
    });

    root.querySelectorAll("[data-search-field]").forEach((checkbox) => {
      checkbox.addEventListener("change", (event) => {
        const field = event.target.dataset.searchField;
        settings.searchFields[field] = Boolean(event.target.checked);
        if (!Object.values(settings.searchFields).some(Boolean)) {
          settings.searchFields.key = true;
          root.querySelector('[data-search-field="key"]').checked = true;
        }
        selectedIndex = 0;
        renderSuggestions();
        saveCachedState(cachedFiles).catch(() => {});
      });
    });

    root.querySelectorAll('input[name="ctca-view-mode"]').forEach((radio) => {
      radio.addEventListener("change", (event) => {
        if (!event.target.checked) return;
        settings.appearance.mode = event.target.value === "compact" ? "compact" : "full";
        applySettingsToPopup();
        renderSuggestions();
        positionPopup();
        saveCachedState(cachedFiles).catch(() => {});
      });
    });

    root.querySelector(".ctca-show-compact-title").addEventListener("change", (event) => {
      settings.appearance.showTitleInCompact = Boolean(event.target.checked);
      renderSuggestions();
      positionPopup();
      saveCachedState(cachedFiles).catch(() => {});
    });

    root.querySelector(".ctca-font-size").addEventListener("change", (event) => {
      settings.appearance.fontSize = Number(event.target.value) || DEFAULT_SETTINGS.appearance.fontSize;
      applySettingsToPopup();
      renderSuggestions();
      positionPopup();
      saveCachedState(cachedFiles).catch(() => {});
    });

    root.addEventListener("mousedown", (event) => {
      event.stopPropagation();
    });

    document.documentElement.appendChild(root);
    applySettingsToPopup(root);
    return root;
  }

  function applySettingsToPopup(target = popup) {
    if (!target) return;
    target.classList.toggle("ctca-compact-view", settings.appearance.mode === "compact");
    target.style.setProperty("--ctca-base-font-size", `${settings.appearance.fontSize}px`);

    const caseButton = target.querySelector(".ctca-case-button");
    caseButton?.classList.toggle("ctca-case-active", settings.caseSensitive);
    caseButton?.setAttribute("aria-pressed", settings.caseSensitive ? "true" : "false");
    if (caseButton) {
      caseButton.title = settings.caseSensitive
        ? "Case-sensitive matching enabled"
        : "Case-sensitive matching disabled";
    }

    target.querySelectorAll("[data-search-field]").forEach((checkbox) => {
      checkbox.checked = Boolean(settings.searchFields[checkbox.dataset.searchField]);
    });
    target.querySelectorAll('input[name="ctca-view-mode"]').forEach((radio) => {
      radio.checked = radio.value === settings.appearance.mode;
    });
    target.querySelector(".ctca-show-compact-title").checked = settings.appearance.showTitleInCompact;
    target.querySelector(".ctca-font-size").value = String(settings.appearance.fontSize);
    target.querySelector(".ctca-compact-title-option")?.classList.toggle(
      "ctca-option-disabled",
      settings.appearance.mode !== "compact"
    );
  }

  function createBibManagerOverlay() {
    const root = document.createElement("div");
    root.id = "ctca-bib-manager";
    root.setAttribute("aria-hidden", "true");
    root.innerHTML = `
      <div class="ctca-manager-backdrop"></div>
      <section class="ctca-manager-dialog" role="dialog" aria-modal="true" aria-labelledby="ctca-manager-title">
        <header class="ctca-manager-header">
          <div>
            <h2 id="ctca-manager-title">Smart Citations: TeX-document bibliography</h2>
            <div class="ctca-manager-subtitle">Browse, edit, read, comment, annotate, synchronize, and reuse BibTeX entries in Overleaf and CollabTeX</div>
          </div>
          <div class="ctca-manager-header-actions">
            <label class="ctca-manager-global-sync" title="Keep this project's bibliography synchronized with the Smart Citations database. Global data wins only when both sides changed the same entry.">
              <input type="checkbox" class="ctca-manager-global-sync-checkbox" role="switch">
              <span class="ctca-manager-global-sync-track" aria-hidden="true"><span></span></span>
              <span class="ctca-manager-global-sync-label">Sync with Smart Citations central database</span>
            </label>
            <label class="ctca-manager-global-sync ctca-manager-nextcloud-sync ctca-nextcloud-disconnected" title="Connect to Nextcloud first to enable database synchronization.">
              <input type="checkbox" class="ctca-manager-nextcloud-sync-checkbox" role="switch" disabled>
              <span class="ctca-manager-global-sync-track" aria-hidden="true"><span></span></span>
              <span class="ctca-manager-global-sync-label">Sync central database with Nextcloud</span>
            </label>
            <button type="button" class="ctca-manager-cloud-settings" aria-label="Configure Nextcloud and PDF storage" title="Configure Nextcloud and PDF storage">☁</button>
            <button type="button" class="ctca-manager-options" aria-label="Open Smart Citations options" title="Options">
              <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M4 12h16M4 17h16"></path></svg>
            </button>
          </div>
        </header>
        <nav class="ctca-manager-tabs ctca-manager-inline-tabs" role="tablist" aria-label="Bibliography and PDF tabs" hidden>
          <button type="button" class="ctca-manager-tab ctca-manager-tab-active" data-tab-id="bibliography" role="tab" aria-selected="true">Bibliography</button>
          <span class="ctca-manager-tab-spacer"></span>
        </nav>
        <div class="ctca-manager-body">
          <aside class="ctca-manager-categories" aria-label="Bibliography categories">
            <div class="ctca-manager-categories-head">
              <strong>Categories</strong>
              <button type="button" class="ctca-manager-add-category" title="Create category" aria-label="Create category">+</button>
            </div>
            <div class="ctca-manager-category-tree"></div>
          </aside>
          <div class="ctca-manager-resizer ctca-manager-resizer-categories" role="separator" aria-orientation="vertical" tabindex="0" title="Drag to resize the category pane"></div>
          <div class="ctca-manager-workspace">
            <div class="ctca-manager-topline">
            <div class="ctca-manager-searchbar">
              <div class="ctca-manager-add-menu-wrap">
              <button type="button" class="ctca-manager-add-entry" title="Add or import bibliography entries" aria-label="Add or import bibliography entries" aria-haspopup="menu" aria-expanded="false">+</button>
              <div class="ctca-manager-add-menu" role="menu" aria-label="Add bibliography content">
                <button type="button" class="ctca-manager-add-new-entry" role="menuitem">Add new entry</button>
                <button type="button" class="ctca-manager-add-from-pdf" role="menuitem">Add new entry from PDF</button>
                <button type="button" class="ctca-manager-import-bib" role="menuitem">Import BibTeX file</button>
              </div>
            </div>
              <div class="ctca-manager-search-wrap">
  <label for="ctca-manager-search-input">Search</label>
  <span class="ctca-manager-search-composite">
    <span class="ctca-manager-search-input-wrap">
      <input id="ctca-manager-search-input" type="search" class="ctca-manager-search" placeholder="Search text or use operators. Press ‘/’ for assistance." autocomplete="off">
      <button type="button" class="ctca-manager-search-details" aria-expanded="false" aria-label="Open search and filter menu" title="Search operators and filters">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h10M18 7h2M4 17h2M10 17h10M8 4v6M16 14v6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><circle cx="16" cy="7" r="2" fill="none" stroke="currentColor" stroke-width="2"/><circle cx="8" cy="17" r="2" fill="none" stroke="currentColor" stroke-width="2"/></svg>
      </button>
      <button type="button" class="ctca-manager-search-clear" aria-label="Clear search" title="Clear search" hidden>×</button>
    </span>
    <span class="ctca-manager-search-menu-wrap">
      <span class="ctca-manager-search-menu" hidden role="dialog" aria-label="Search operators and filters">
        <span class="ctca-search-tip"><strong>TIP:</strong> Type an operator in the search field or select it below.</span>
        <span class="ctca-search-section">
          <strong>Search operators</strong>
          <em>Operators can be combined with field operators.</em>
          <span class="ctca-search-chip-grid">
            <button type="button" data-search-insert='""' data-search-cursor-back="1"><b>“</b><span>Exact phrase</span></button>
            <button type="button" data-search-insert="!"><b>!</b><span>Exclude</span></button>
          </span>
        </span>
        <span class="ctca-search-section">
          <strong>Field search</strong>
          <span class="ctca-search-field-chips">
            <button type="button" data-search-insert="title:">title:</button>
            <button type="button" data-search-insert="author:">author:</button>
            <button type="button" data-search-insert="year:">year:</button>
            <button type="button" data-search-insert="abstract:">abstract:</button>
            <button type="button" data-search-insert="pdf:">pdf:</button>
            <button type="button" data-search-insert="tag:">tag:</button>
            <button type="button" data-search-insert="citekey:">citekey:</button>
            <button type="button" data-search-insert="journal:">journal:</button>
            <button type="button" data-search-insert="doi:">doi:</button>
            <button type="button" data-search-insert="type:">type:</button>
            <button type="button" data-search-insert="category:">category:</button>
          </span>
        </span>
        <span class="ctca-search-section ctca-search-includes">
          <strong>Include/exclude from unqualified search</strong>
          <label><span>Abstract</span><input type="checkbox" class="ctca-search-include-abstract" checked></label>
          <label><span>PDF text / PDF-related fields</span><input type="checkbox" class="ctca-search-include-pdf"></label>
        </span>
        <span class="ctca-search-section ctca-search-filters">
          <span class="ctca-search-filter-heading"><strong>Filters</strong><button type="button" class="ctca-search-clear-filters">Clear filters</button></span>
          <span class="ctca-search-filter-grid">
            <label><span>Entry type</span><select class="ctca-search-filter-type"><option value="">Any type</option></select></label>
            <label><span>Year from</span><input class="ctca-search-filter-year-from" inputmode="numeric" maxlength="4" placeholder="Any"></label>
            <label><span>Year to</span><input class="ctca-search-filter-year-to" inputmode="numeric" maxlength="4" placeholder="Any"></label>
            <label><span>DOI</span><select class="ctca-search-filter-doi"><option value="any">Any</option><option value="with">With DOI</option><option value="without">Without DOI</option></select></label>
            <label><span>Tags</span><select class="ctca-search-filter-tagged"><option value="any">Any</option><option value="tagged">Tagged</option><option value="untagged">Untagged</option></select></label>
          </span>
        </span>
        <span class="ctca-search-help"><kbd>↑</kbd><kbd>↓</kbd> Navigate <kbd>Enter</kbd> Use <kbd>Esc</kbd> Close</span>
      </span>
    </span>
  </span>
</div>
            </div>
            <div class="ctca-manager-details-actionbar ctca-manager-top-actions">
              <button type="button" class="ctca-manager-update-all-doi" title="Update every bibliography entry that contains a DOI">🌐 Update all from DOI</button>
              <button type="button" class="ctca-manager-update" title="Write edited entries to the BibTeX files and read the current files again">
                <span class="ctca-manager-update-main">↻ Update Bib</span>
                <span class="ctca-manager-update-files"></span>
              </button>
              <button type="button" class="ctca-manager-collapse-details" title="Collapse detail pane" aria-label="Collapse detail pane">▶</button>
            </div>
            </div>
            <div class="ctca-manager-content">
              <div class="ctca-manager-list-column">
                <div class="ctca-manager-selection-actionbar" hidden>
                  <button type="button" class="ctca-manager-update-selected" title="Update the selected entries from DOI metadata">🌐 Update selected</button>
                  <button type="button" class="ctca-manager-remove-selected" title="Mark the selected bibliography entries for removal">Remove selected</button>
                </div>
                <aside class="ctca-manager-list-pane">
                  <div class="ctca-manager-table-head" role="row">
                    <button type="button" class="ctca-manager-star-sort" title="Show starred entries first" aria-label="Show starred entries first" aria-pressed="false">☆</button>
                    <label class="ctca-manager-select-visible" title="Select or clear all currently visible entries"><input type="checkbox" class="ctca-manager-select-visible-checkbox" aria-label="Select or clear all currently visible entries"></label>
                    <span class="ctca-manager-column-header" data-manager-column="title"><button type="button" data-manager-sort="author" title="Sort by first author">Title / authors <span>↕</span></button><button type="button" class="ctca-manager-column-eye" title="Hide Title / authors" aria-label="Hide Title / authors">👁</button><span class="ctca-manager-column-resizer" role="separator" aria-orientation="vertical" title="Drag to resize Title / authors"></span></span>
                    <span class="ctca-manager-column-header" data-manager-column="year"><button type="button" data-manager-sort="year" title="Sort by year">Year <span>↕</span></button><button type="button" class="ctca-manager-column-eye" title="Hide Year" aria-label="Hide Year">👁</button><span class="ctca-manager-column-resizer" role="separator" aria-orientation="vertical" title="Drag to resize Year"></span></span>
                    <span class="ctca-manager-column-header" data-manager-column="key"><button type="button" data-manager-sort="key" title="Sort by citation key">Citation key <span>↕</span></button><button type="button" class="ctca-manager-column-eye" title="Hide Citation key" aria-label="Hide Citation key">👁</button><span class="ctca-manager-column-resizer" role="separator" aria-orientation="vertical" title="Drag to resize Citation key"></span></span>
                    <span class="ctca-manager-column-header" data-manager-column="addedOn"><button type="button" data-manager-sort="addedOn" title="Sort by date added">Added on <span>↕</span></button><button type="button" class="ctca-manager-column-eye" title="Hide Added on" aria-label="Hide Added on">👁</button><span class="ctca-manager-column-resizer" role="separator" aria-orientation="vertical" title="Drag to resize Added on"></span></span>
                   </div>
                   <div class="ctca-manager-list" role="listbox" aria-label="BibTeX entries" aria-multiselectable="true"></div>
                   <div class="ctca-manager-list-loading-overlay" hidden role="status" aria-live="polite" aria-label="Loading bibliography entries">
                     <span class="ctca-manager-list-loading-spinner" aria-hidden="true"></span>
                   </div>
                   <div class="ctca-manager-central-sync-overlay" hidden role="status" aria-live="polite">
                     <span class="ctca-manager-central-sync-spinner" aria-hidden="true"></span>
                     <span class="ctca-manager-central-sync-label">Syncing central database…</span>
                   </div>
                   <div class="ctca-manager-column-menu" role="menu" hidden></div>
                </aside>
              </div>
              <div class="ctca-manager-resizer ctca-manager-resizer-details" role="separator" aria-orientation="vertical" tabindex="0" title="Drag to resize the list and details panes"></div>
              <div class="ctca-manager-details-column">
                <div class="ctca-openalex-impact-slot" hidden></div>
                <section class="ctca-manager-details" aria-label="BibTeX entry details">
                  <div class="ctca-manager-empty-details">Select a bibliography entry.</div>
                </section>
              </div>
              <button type="button" class="ctca-manager-restore-details" title="Expand detail pane" aria-label="Expand detail pane"><span class="ctca-manager-restore-icon" aria-hidden="true">◀</span><span class="ctca-manager-collapsed-label">Details</span></button>
               <div class="ctca-bibliography-empty-start" hidden role="status">
                <strong>Get started with your bibliography</strong>
                <p>Import a BibTeX file, restore the bibliography from an existing Nextcloud backup, or get started by adding your first entry.</p>
                <div class="ctca-bibliography-empty-actions">
                  <button type="button" class="ctca-bibliography-empty-upload">Upload a .bib file</button>
                  <button type="button" class="ctca-bibliography-empty-nextcloud">Sync with existing Nextcloud backup</button>
                </div>
              </div>
            </div>
          </div>
        </div>
        <section class="ctca-manager-pdf-view ctca-manager-inline-pdf-view" hidden>
          <div class="ctca-pdf-layout">
            <section class="ctca-pdf-viewer-pane">
              <iframe class="ctca-pdf-frame" title="PDF viewer"></iframe>
              <div class="ctca-pdf-unavailable" hidden></div>
            </section>
            <div class="ctca-pdf-resizer ctca-pdf-resizer-notes" role="separator" aria-orientation="vertical" tabindex="0"></div>
            <section class="ctca-pdf-notes-pane">
              <div class="ctca-pdf-pane-head">
                <strong>PDF notes</strong>
                <button type="button" class="ctca-pdf-collapse-notes" title="Collapse PDF notes" aria-label="Collapse PDF notes" aria-expanded="true">▶</button>
              </div>
              <div class="ctca-pdf-notes-content">
                <label class="ctca-pdf-note-label"><span>Note</span><textarea class="ctca-pdf-note" rows="10" placeholder="Notes for this PDF are saved automatically."></textarea></label>
              </div>
            </section>
            <button type="button" class="ctca-pdf-restore-notes" title="Expand notes pane" aria-label="Expand PDF notes pane"><span class="ctca-pdf-restore-icon" aria-hidden="true">◀</span><span class="ctca-pdf-collapsed-label">PDF notes</span></button>
            <div class="ctca-pdf-resizer ctca-pdf-resizer-details" role="separator" aria-orientation="vertical" tabindex="0"></div>
            <aside class="ctca-pdf-entry-pane">
              <div class="ctca-pdf-entry-pane-head"><strong>Entry details</strong><button type="button" class="ctca-pdf-collapse-details" title="Collapse entry details" aria-label="Collapse entry details" aria-expanded="true">▶</button></div>
              <div class="ctca-pdf-entry-details"></div>
            </aside>
            <button type="button" class="ctca-pdf-restore-details" title="Expand entry details" aria-label="Expand entry details"><span class="ctca-pdf-restore-icon" aria-hidden="true">◀</span><span class="ctca-pdf-collapsed-label">Details</span></button>
          </div>
        </section>
        <div class="ctca-category-context-menu" hidden role="menu">
          <button type="button" class="ctca-category-remove" role="menuitem">Remove category…</button>
        </div>
        <div class="ctca-entry-context-menu" hidden role="menu"></div>
        <footer class="ctca-manager-footer">
          <div class="ctca-manager-footer-main">
            <div class="ctca-manager-status" aria-live="polite"></div>
            <div class="ctca-manager-progress" hidden>
              <span class="ctca-manager-progress-label"></span>
              <progress class="ctca-manager-progress-bar" value="0" max="1"></progress>
              <button type="button" class="ctca-manager-abort-doi">Abort</button>
            </div>
          </div>
          <div class="ctca-manager-count"></div>
        </footer>
      </section>
    `;
    root.querySelector(".ctca-manager-backdrop").addEventListener("click", closeBibManager);
    root.querySelector(".ctca-category-remove").textContent = "Delete";
    root.querySelector(".ctca-bibliography-empty-upload")?.addEventListener("click", () => {
      importProjectBibliographyFromFile().then((completed) => {
        if (completed && bibManager.classList.contains("ctca-manager-visible")) managerLoadBibliography({ saveDirty: false }).catch((error) => managerSetStatus(error.message || String(error), true));
      });
    });
    root.querySelector(".ctca-bibliography-empty-nextcloud")?.addEventListener("click", () => {
      syncProjectFromExistingNextcloudBackup().then((completed) => {
        if (completed && bibManager.classList.contains("ctca-manager-visible")) managerLoadBibliography({ saveDirty: false }).catch((error) => managerSetStatus(error.message || String(error), true));
      }).catch((error) => managerSetStatus(error.message || String(error), true));
    });
    root.querySelector(".ctca-manager-update").addEventListener("click", () => managerSaveAndReload());
    root.querySelector(".ctca-manager-update-all-doi").addEventListener("click", () => managerUpdateAllEntriesFromDoi());
    root.querySelector(".ctca-manager-collapse-details").addEventListener("click", () => {
      managerDetailsCollapsedManually = !managerDetailsCollapsedManually;
      managerUpdateDetailsVisibility();
    });
    root.querySelector(".ctca-manager-restore-details").addEventListener("click", () => {
      managerDetailsCollapsedManually = false;
      managerUpdateDetailsVisibility();
    });
    root.querySelector(".ctca-manager-update-selected").addEventListener("click", () => managerUpdateSelectedEntriesFromDoi());
    const managerAddMenuWrap = root.querySelector(".ctca-manager-add-menu-wrap");
    const managerAddMenuButton = root.querySelector(".ctca-manager-add-entry");
    const closeManagerAddMenu = () => {
      managerAddMenuWrap?.classList.remove("ctca-manager-add-menu-open");
      managerAddMenuButton?.setAttribute("aria-expanded", "false");
    };
    const openManagerAddMenu = () => {
      managerAddMenuWrap?.classList.add("ctca-manager-add-menu-open");
      managerAddMenuButton?.setAttribute("aria-expanded", "true");
    };
    managerAddMenuButton.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (managerAddMenuWrap.classList.contains("ctca-manager-add-menu-open")) closeManagerAddMenu();
      else openManagerAddMenu();
    });
    managerAddMenuButton.addEventListener("keydown", (event) => {
      if (event.key === "ArrowDown") {
        event.preventDefault();
        openManagerAddMenu();
        root.querySelector(".ctca-manager-add-new-entry")?.focus();
      }
    });
    root.querySelector(".ctca-manager-add-new-entry").addEventListener("click", (event) => {
      event.stopPropagation();
      closeManagerAddMenu();
      managerOpenAddEntryDialog().catch((error) => managerSetStatus(error.message || String(error), true));
    });
    root.querySelector(".ctca-manager-add-from-pdf").addEventListener("click", (event) => {
      event.stopPropagation();
      closeManagerAddMenu();
      managerAddEntriesFromPdfs().catch((error) => managerSetStatus(error.message || String(error), true));
    });
    root.querySelector(".ctca-manager-import-bib").addEventListener("click", (event) => {
      event.stopPropagation();
      closeManagerAddMenu();
      managerImportBibFile().catch((error) => managerSetStatus(error.message || String(error), true));
    });
    root.querySelector(".ctca-manager-abort-doi").addEventListener("click", () => requestManagerBulkDoiAbort());
    root.querySelector(".ctca-manager-remove-selected").addEventListener("click", () => managerRemoveSelectedEntries());
    root.querySelector(".ctca-manager-add-category").addEventListener("click", () => managerCreateCategory());
    root.querySelector(".ctca-manager-select-visible-checkbox").addEventListener("change", (event) => {
      const visibleIds = sortedFilteredManagerRecords().map((record) => managerRecordId(record));
      if (event.target.checked) visibleIds.forEach((id) => managerSelectedIds.add(id));
      else visibleIds.forEach((id) => managerSelectedIds.delete(id));
      renderManagerList();
      renderManagerDetails();
    });
    root.querySelector(".ctca-category-remove").addEventListener("click", () => {
      const menu = root.querySelector(".ctca-category-context-menu");
      const categoryId = menu.dataset.categoryId || "";
      managerHideCategoryContextMenu();
      managerRemoveCategory(categoryId);
    });
    root.querySelector(".ctca-manager-cloud-settings").addEventListener("click", () => managerOpenCloudSettings());
    root.querySelector(".ctca-manager-options").addEventListener("click", () => managerOpenOptionsPage());
    const globalSyncCheckbox = root.querySelector(".ctca-manager-global-sync-checkbox");
    globalSyncCheckbox.checked = Boolean(settings.syncGlobalDatabase);
    globalSyncCheckbox.addEventListener("change", () => {
      setGlobalDatabaseSyncEnabled(globalSyncCheckbox.checked, { runNow: true }).catch((error) => {
        globalSyncCheckbox.checked = Boolean(settings.syncGlobalDatabase);
        managerSetStatus(error?.message || String(error), true);
      });
    });
    const nextcloudSyncCheckbox = root.querySelector(".ctca-manager-nextcloud-sync-checkbox");
    nextcloudSyncCheckbox?.addEventListener("change", async () => {
      if (!managerNextcloudConnected) {
        nextcloudSyncCheckbox.checked = false;
        await managerUpdateCloudIconState();
        managerSetStatus("Connect to Nextcloud before enabling database synchronization.", true);
        return;
      }
      nextcloudSyncCheckbox.disabled = true;
      try {
        const config = await globalThis.CollabTeXAttachmentStore.getConfig();
        config.nextcloud = {
          ...(config.nextcloud || {}),
          syncBibliography: Boolean(nextcloudSyncCheckbox.checked)
        };
        await globalThis.CollabTeXAttachmentStore.saveConfig(config);
        if (nextcloudSyncCheckbox.checked) {
          managerSetStatus("Nextcloud database synchronization enabled.");
          managerScheduleNextcloudSync(50);
        } else {
          managerSetStatus("Nextcloud database synchronization disabled.");
        }
        await managerUpdateCloudIconState(config);
      } catch (error) {
        managerSetStatus(error?.message || String(error), true);
        await managerUpdateCloudIconState();
      }
    });
    const managerSearchInput = root.querySelector(".ctca-manager-search");
    const managerSearchClear = root.querySelector(".ctca-manager-search-clear");
    const updateManagerSearchClear = () => { managerSearchClear.hidden = !managerSearchInput.value; };
    managerSearchInput.addEventListener("input", (event) => {
      managerQuery = event.target.value || "";
      updateManagerSearchClear();
      renderManagerList();
    });
    managerSearchClear.addEventListener("click", () => {
      managerSearchInput.value = "";
      managerQuery = "";
      updateManagerSearchClear();
      renderManagerList();
      managerSearchInput.focus();
    });

    const managerSearchDetailsButton = root.querySelector(".ctca-manager-search-details");
    const managerSearchMenu = root.querySelector(".ctca-manager-search-menu");
    const setManagerSearchMenuOpen = (open) => {
      managerSearchMenu.hidden = !open;
      managerSearchDetailsButton.setAttribute("aria-expanded", open ? "true" : "false");
      if (open) applyManagerAdvancedSearchUi(root);
    };
    managerSearchDetailsButton.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      setManagerSearchMenuOpen(managerSearchMenu.hidden);
    });
    root.querySelectorAll("[data-search-insert]").forEach((button) => {
      button.addEventListener("click", (event) => {
        event.preventDefault();
        insertIntoManagerSearch(button.dataset.searchInsert || "", Number(button.dataset.searchCursorBack || 0));
      });
    });
    const refreshManagerAdvancedSearch = () => {
      settings.managerSearchOptions.includeAbstract = root.querySelector(".ctca-search-include-abstract").checked;
      settings.managerSearchOptions.includePdfText = root.querySelector(".ctca-search-include-pdf").checked;
      settings.managerFilters = globalThis.CollabTeXSearchTools.normalizeFilterState({
        type: root.querySelector(".ctca-search-filter-type").value,
        yearFrom: root.querySelector(".ctca-search-filter-year-from").value,
        yearTo: root.querySelector(".ctca-search-filter-year-to").value,
        doi: root.querySelector(".ctca-search-filter-doi").value,
        tagged: root.querySelector(".ctca-search-filter-tagged").value
      });
      updateManagerFilterBadge(root);
      renderManagerList();
      saveCachedState(cachedFiles).catch(() => {});
    };
    root.querySelectorAll(".ctca-search-include-abstract, .ctca-search-include-pdf, .ctca-search-filter-type, .ctca-search-filter-year-from, .ctca-search-filter-year-to, .ctca-search-filter-doi, .ctca-search-filter-tagged").forEach((control) => {
      const eventName = control.matches("input[type=checkbox], select") ? "change" : "input";
      control.addEventListener(eventName, refreshManagerAdvancedSearch);
    });
    root.querySelector(".ctca-search-clear-filters").addEventListener("click", () => {
      settings.managerFilters = { type: "", yearFrom: "", yearTo: "", doi: "any", tagged: "any" };
      applyManagerAdvancedSearchUi(root);
      renderManagerList();
      saveCachedState(cachedFiles).catch(() => {});
    });
    root.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && managerAddMenuWrap?.classList.contains("ctca-manager-add-menu-open")) {
        event.preventDefault();
        closeManagerAddMenu();
        managerAddMenuButton?.focus();
      } else if (event.key === "Escape" && root.classList.contains("ctca-pdf-maximized")) {
        event.preventDefault();
        managerSetPdfMaximized(false);
      } else if (event.key === "/" && !event.ctrlKey && !event.metaKey && !event.altKey && !event.target.matches("input, textarea, select")) {
        event.preventDefault();
        managerSearchInput.focus();
        setManagerSearchMenuOpen(true);
      } else if (event.key === "Escape" && !managerSearchMenu.hidden) {
        event.preventDefault();
        setManagerSearchMenuOpen(false);
        managerSearchInput.focus();
      } else if (!managerSearchMenu.hidden && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
        const focusables = [...managerSearchMenu.querySelectorAll("button:not([disabled]), input:not([disabled]), select:not([disabled])")].filter((element) => !element.hidden);
        if (!focusables.length) return;
        const current = focusables.indexOf(document.activeElement);
        const direction = event.key === "ArrowDown" ? 1 : -1;
        const next = current < 0
          ? (direction > 0 ? 0 : focusables.length - 1)
          : (current + direction + focusables.length) % focusables.length;
        event.preventDefault();
        focusables[next].focus();
      }
    });

    root.addEventListener("contextmenu", (event) => event.preventDefault());
    root.addEventListener("click", (event) => {
      if (!event.target.closest(".ctca-manager-search-composite")) {
        setManagerSearchMenuOpen(false);
      }
      if (!event.target.closest(".ctca-manager-add-menu-wrap")) closeManagerAddMenu();
      if (!event.target.closest(".ctca-category-context-menu")) managerHideCategoryContextMenu();
      if (!event.target.closest(".ctca-entry-context-menu")) managerHideEntryContextMenu();
      if (!event.target.closest(".ctca-manager-column-menu")) {
        root.querySelector(".ctca-manager-column-menu").hidden = true;
      }
    });
    applyManagerSearchSettings(root);

    root.querySelectorAll("[data-manager-sort]").forEach((button) => {
      button.addEventListener("click", () => {
        const field = button.dataset.managerSort;
        if (managerSort.field === field) {
          managerSort.direction = managerSort.direction === "asc" ? "desc" : "asc";
        } else {
          managerSort = { field, direction: "asc" };
        }
        renderManagerList();
      });
    });

    const details = root.querySelector(".ctca-manager-details");
    details.addEventListener("input", (event) => {
      if (event.target.matches(".ctca-tag-input")) {
        const draft = managerDrafts.get(managerSelectedId);
        if (draft) managerRenderTagSuggestions(draft, event.target);
        return;
      }
      if (event.target.matches("[data-manager-autocomplete]")) {
        const draft = managerDrafts.get(managerSelectedId);
        if (draft && event.target.dataset.managerAutocomplete === "keywords") managerRenderKeywordSuggestions(draft, event.target);
        else if (draft) managerRenderJournalSuggestions(draft, event.target);
        return;
      }
      managerDetailInputChanged(event);
    });
    details.addEventListener("change", managerDetailInputChanged);
    details.addEventListener("keydown", managerInlineDisplayKeydown);
    details.addEventListener("keydown", managerTagInputKeydown);
    details.addEventListener("keydown", managerFieldAutocompleteKeydown);
    details.addEventListener("mousedown", managerFieldAutocompleteMouseDown);
    details.addEventListener("focusin", (event) => {
      if (event.target.matches(".ctca-tag-input")) {
        const draft = managerDrafts.get(managerSelectedId);
        if (draft) managerRenderTagSuggestions(draft, event.target);
      } else if (event.target.matches("[data-manager-autocomplete]")) {
        const draft = managerDrafts.get(managerSelectedId);
        if (draft && event.target.dataset.managerAutocomplete === "keywords") managerRenderKeywordSuggestions(draft, event.target);
        else if (draft) managerRenderJournalSuggestions(draft, event.target);
      }
    });
    details.addEventListener("focusout", (event) => {
      if (event.target.matches(".ctca-tag-input")) {
        window.setTimeout(() => event.target.closest(".ctca-tag-input-wrap")?.querySelector(".ctca-tag-suggestions")?.setAttribute("hidden", ""), 120);
      } else if (event.target.matches("[data-manager-autocomplete]")) {
        window.setTimeout(() => {
          const container = event.target.closest(".ctca-field-completion-wrap")?.querySelector(".ctca-field-completion");
          if (container) container.hidden = true;
          event.target.setAttribute("aria-expanded", "false");
        }, 120);
      }
    });
    details.addEventListener("click", managerDetailClicked);

    const pdfEntryDetails = root.querySelector(".ctca-pdf-entry-details");
    pdfEntryDetails.addEventListener("input", (event) => {
      if (event.target.matches("[data-manager-autocomplete]")) {
        const draft = managerDrafts.get(managerSelectedId);
        if (draft && event.target.dataset.managerAutocomplete === "keywords") managerRenderKeywordSuggestions(draft, event.target);
        else if (draft) managerRenderJournalSuggestions(draft, event.target);
        return;
      }
      managerDetailInputChanged(event);
    });
    pdfEntryDetails.addEventListener("change", managerDetailInputChanged);
    pdfEntryDetails.addEventListener("keydown", managerInlineDisplayKeydown);
    pdfEntryDetails.addEventListener("keydown", managerFieldAutocompleteKeydown);
    pdfEntryDetails.addEventListener("mousedown", managerFieldAutocompleteMouseDown);
    pdfEntryDetails.addEventListener("focusin", (event) => {
      if (event.target.matches("[data-manager-autocomplete]")) {
        const draft = managerDrafts.get(managerSelectedId);
        if (draft && event.target.dataset.managerAutocomplete === "keywords") managerRenderKeywordSuggestions(draft, event.target);
        else if (draft) managerRenderJournalSuggestions(draft, event.target);
      }
    });
    pdfEntryDetails.addEventListener("focusout", (event) => {
      if (event.target.matches("[data-manager-autocomplete]")) {
        window.setTimeout(() => {
          const container = event.target.closest(".ctca-field-completion-wrap")?.querySelector(".ctca-field-completion");
          if (container) container.hidden = true;
          event.target.setAttribute("aria-expanded", "false");
        }, 120);
      }
    });
    pdfEntryDetails.addEventListener("click", managerDetailClicked);

    root.querySelector(".ctca-manager-inline-tabs").addEventListener("click", (event) => {
      const tab = event.target.closest(".ctca-manager-tab[data-tab-id]");
      if (!tab) return;
      const tabId = tab.dataset.tabId;
      if (event.target.closest(".ctca-manager-tab-close")) managerClosePdfTab(tabId).catch(() => {});
      else managerActivatePdfTab(tabId).catch((error) => managerSetStatus(error.message || String(error), true));
    });
    root.querySelector(".ctca-pdf-collapse-notes").addEventListener("click", () => managerSetPdfPaneCollapsed("notes", true));
    root.querySelector(".ctca-pdf-restore-notes").addEventListener("click", () => managerSetPdfPaneCollapsed("notes", false));
    root.querySelector(".ctca-pdf-collapse-details").addEventListener("click", () => managerSetPdfPaneCollapsed("details", true));
    root.querySelector(".ctca-pdf-restore-details").addEventListener("click", () => managerSetPdfPaneCollapsed("details", false));
    window.addEventListener('message', (event) => {
      const frame = root.querySelector('.ctca-pdf-frame');
      if (!frame || event.source !== frame.contentWindow) return;
      const message = event.data || {};
      const data = managerOpenPdfTabs.get(managerWorkspaceTab);
      const attachment = data?.attachment;
      if (!attachment || (message.attachmentId && message.attachmentId !== attachment.id)) return;

      if (message.type === 'ctca-pdf-viewer-ready') {
        data.viewerReady = true;
        frame.contentWindow.postMessage({
          type: 'ctca-pdf-host-layout',
          attachmentId: attachment.id,
          maximized: root.classList.contains('ctca-pdf-maximized')
        }, '*');
        return;
      }
      if (message.type === 'ctca-pdf-request-data') {
        managerSendPdfDataToFrame(frame, attachment).catch(() => {});
        return;
      }
      if (message.type === 'ctca-pdf-download-request') {
        managerDownloadActivePdf().catch((error) => managerSetStatus(error?.message || String(error), true));
        return;
      }
      if (message.type === 'ctca-pdf-fullscreen-request') {
        managerSetPdfMaximized(!root.classList.contains('ctca-pdf-maximized'));
        return;
      }
      if (message.type === 'ctca-pdf-dirty-state') {
        data.pdfDirty = Boolean(message.dirty);
        data.pdfSaving = Boolean(message.saving);
        return;
      }
      if (message.type === 'ctca-pdf-save-data') {
        managerPersistAnnotatedPdf(frame, message).catch((error) => managerSetStatus(error?.message || String(error), true));
        return;
      }
      if (message.type === 'ctca-pdf-save-request-complete') {
        const pending = managerPendingPdfSaveRequests.get(message.requestId);
        if (!pending) return;
        managerPendingPdfSaveRequests.delete(message.requestId);
        if (message.ok) pending.resolve();
        else pending.reject(new Error(message.error || 'The PDF annotations could not be saved.'));
      }
    });
    root.querySelector(".ctca-pdf-note").addEventListener("input", () => {
      window.clearTimeout(managerPdfNoteSaveTimer);
      managerPdfNoteSaveTimer = window.setTimeout(() => managerSaveActivePdfNotes().catch((error) => managerSetStatus(error.message || String(error), true)), 500);
    });
    managerInitializePdfResizer(root.querySelector(".ctca-pdf-resizer-notes"), "notes");
    managerInitializePdfResizer(root.querySelector(".ctca-pdf-resizer-details"), "details");
    root.addEventListener("mousedown", (event) => event.stopPropagation());

    document.documentElement.appendChild(root);
    initializeManagerTableColumns(root);
    return root;
  }

  function applyManagerSearchSettings(target = bibManager) {
    if (!target) return;
    target.querySelectorAll("[data-manager-search-field]").forEach((checkbox) => {
      checkbox.checked = Boolean(settings.managerSearchFields[checkbox.dataset.managerSearchField]);
    });
    const globalSyncCheckbox = target.querySelector(".ctca-manager-global-sync-checkbox");
    if (globalSyncCheckbox) globalSyncCheckbox.checked = Boolean(settings.syncGlobalDatabase);
    applyManagerAdvancedSearchUi(target);
  }

  function applyManagerAdvancedSearchUi(target = bibManager) {
    if (!target) return;
    const typeSelect = target.querySelector(".ctca-search-filter-type");
    if (typeSelect && typeSelect.options.length <= 1) {
      for (const type of BIB_ENTRY_TYPES) {
        const option = document.createElement("option");
        option.value = type;
        option.textContent = type;
        typeSelect.appendChild(option);
      }
    }
    const abstractToggle = target.querySelector(".ctca-search-include-abstract");
    const pdfToggle = target.querySelector(".ctca-search-include-pdf");
    if (abstractToggle) abstractToggle.checked = settings.managerSearchOptions.includeAbstract !== false;
    if (pdfToggle) pdfToggle.checked = settings.managerSearchOptions.includePdfText === true;
    if (typeSelect) typeSelect.value = settings.managerFilters.type || "";
    const yearFrom = target.querySelector(".ctca-search-filter-year-from");
    const yearTo = target.querySelector(".ctca-search-filter-year-to");
    const doi = target.querySelector(".ctca-search-filter-doi");
    const tagged = target.querySelector(".ctca-search-filter-tagged");
    if (yearFrom) yearFrom.value = settings.managerFilters.yearFrom || "";
    if (yearTo) yearTo.value = settings.managerFilters.yearTo || "";
    if (doi) doi.value = settings.managerFilters.doi || "any";
    if (tagged) tagged.value = settings.managerFilters.tagged || "any";
    updateManagerFilterBadge(target);
  }

  function updateManagerFilterBadge(target = bibManager) {
    const button = target?.querySelector(".ctca-manager-search-details");
    if (!button) return;
    const count = globalThis.CollabTeXSearchTools.activeFilterCount(settings.managerFilters);
    button.dataset.filterCount = count ? String(count) : "";
    button.classList.toggle("ctca-search-has-filters", count > 0);
  }

  function insertIntoManagerSearch(value, cursorBack = 0) {
    const input = bibManager.querySelector(".ctca-manager-search");
    if (!input) return;
    const start = Number.isFinite(input.selectionStart) ? input.selectionStart : input.value.length;
    const end = Number.isFinite(input.selectionEnd) ? input.selectionEnd : input.value.length;
    const needsSpace = start > 0 && !/\s/.test(input.value[start - 1]) && value !== "!";
    const insertion = `${needsSpace ? " " : ""}${value}`;
    input.setRangeText(insertion, start, end, "end");
    const next = Math.max(0, (input.selectionStart || input.value.length) - Number(cursorBack || 0));
    input.setSelectionRange(next, next);
    managerQuery = input.value;
    bibManager.querySelector(".ctca-manager-search-clear").hidden = !managerQuery;
    renderManagerList();
    input.focus();
  }

  function applyManagerColumnWidths(target = bibManager) {
    if (!target || !settings?.managerColumns) return;
    target.style.setProperty("--ctca-category-width", `${settings.managerColumns.categories}px`);
    target.style.setProperty("--ctca-details-width", `${settings.managerColumns.details}px`);
    const visible = MANAGER_LIST_COLUMNS.filter((column) => managerColumnVisible(column.id));
    const widths = [34, 24, ...visible.map((column) => settings.managerColumns[column.id])];
    const flexibleColumnId = visible.some((column) => column.id === "title") ? "title" : visible[0]?.id;
    const template = [
      "34px",
      "24px",
      ...visible.map((column) => column.id === flexibleColumnId
        ? `minmax(${Math.round(settings.managerColumns[column.id])}px,1fr)`
        : `${Math.round(settings.managerColumns[column.id])}px`)
    ];
    target.style.setProperty(
      "--ctca-manager-table-columns",
      template.join(" ")
    );
    target.style.setProperty("--ctca-manager-table-width", `${widths.reduce((sum, width) => sum + width, 0)}px`);
    for (const column of MANAGER_LIST_COLUMNS) {
      const header = target.querySelector(`.ctca-manager-column-header[data-manager-column="${column.id}"]`);
      if (header) header.hidden = !managerColumnVisible(column.id);
    }
  }

  function managerColumnVisible(columnId) {
    return columnId === "addedOn" && managerSelectedCategoryId === "recent"
      ? true
      : settings.managerColumnVisibility[columnId] !== false;
  }

  function managerRenderColumnVisibilityMenu(root, clientX, clientY) {
    const menu = root.querySelector(".ctca-manager-column-menu");
    const choices = [
      ...MANAGER_LIST_COLUMNS.map((column) => ({ id: column.id, label: column.label })),
      { id: "authors", label: "Authors" }
    ];
    menu.innerHTML = choices.map((choice) => `
      <label role="menuitemcheckbox">
        <input type="checkbox" data-manager-visible-column="${choice.id}" ${settings.managerColumnVisibility[choice.id] !== false ? "checked" : ""}>
        <span>${managerEscapeHtml(choice.label)}</span>
      </label>
    `).join("");
    menu.style.left = `${Math.min(clientX, window.innerWidth - 235)}px`;
    menu.style.top = `${Math.min(clientY, window.innerHeight - 235)}px`;
    menu.hidden = false;
  }

  function managerSetColumnVisible(columnId, visible) {
    if (!(columnId in settings.managerColumnVisibility)) return false;
    if (!visible && columnId !== "authors") {
      const visibleColumns = MANAGER_LIST_COLUMNS.filter((column) => settings.managerColumnVisibility[column.id] !== false);
      if (visibleColumns.length <= 1 && visibleColumns[0]?.id === columnId) return false;
    }
    settings.managerColumnVisibility[columnId] = Boolean(visible);
    applyManagerColumnWidths(bibManager);
    renderManagerList();
    saveCachedState(cachedFiles).catch(() => {});
    return true;
  }

  function initializeManagerTableColumns(root) {
    if (!root.querySelector(".ctca-manager-table-head")) return;
    const header = root.querySelector(".ctca-manager-table-head");
    const list = root.querySelector(".ctca-manager-list");
    const menu = root.querySelector(".ctca-manager-column-menu");
    root.appendChild(menu);
    applyManagerColumnWidths(root);
    header.addEventListener("contextmenu", (event) => {
      event.preventDefault();
      managerRenderColumnVisibilityMenu(root, event.clientX, event.clientY);
    });
    header.querySelectorAll(".ctca-manager-column-eye").forEach((button) => {
      button.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        managerSetColumnVisible(button.closest("[data-manager-column]")?.dataset.managerColumn, false);
      });
    });
    header.querySelectorAll(".ctca-manager-column-resizer").forEach((handle) => {
      handle.addEventListener("pointerdown", (event) => {
        if (event.button !== 0) return;
        event.preventDefault();
        event.stopPropagation();
        const column = handle.closest("[data-manager-column]")?.dataset.managerColumn;
        const definition = MANAGER_LIST_COLUMNS.find((item) => item.id === column);
        if (!definition) return;
        const startX = event.clientX;
        const startWidth = handle.closest("[data-manager-column]").getBoundingClientRect().width;
        const visibleColumns = MANAGER_LIST_COLUMNS.filter((item) => settings.managerColumnVisibility[item.id] !== false);
        const flexibleColumnId = visibleColumns.some((item) => item.id === "title") ? "title" : visibleColumns[0]?.id;
        const nextColumn = column === flexibleColumnId
          ? visibleColumns[visibleColumns.findIndex((item) => item.id === column) + 1]
          : null;
        const startNextWidth = nextColumn ? settings.managerColumns[nextColumn.id] : 0;
        root.classList.add("ctca-manager-resizing-columns");
        const move = (moveEvent) => {
          const delta = moveEvent.clientX - startX;
          if (nextColumn) {
            const minimumDelta = Math.max(definition.min - startWidth, startNextWidth - 700);
            const maximumDelta = Math.min(700 - startWidth, startNextWidth - nextColumn.min);
            const effectiveDelta = Math.max(minimumDelta, Math.min(maximumDelta, delta));
            settings.managerColumns[column] = startWidth + effectiveDelta;
            settings.managerColumns[nextColumn.id] = startNextWidth - effectiveDelta;
          } else {
            settings.managerColumns[column] = Math.max(definition.min, Math.min(700, startWidth + delta));
          }
          applyManagerColumnWidths(root);
        };
        const finish = () => {
          document.removeEventListener("pointermove", move, true);
          document.removeEventListener("pointerup", finish, true);
          document.removeEventListener("pointercancel", finish, true);
          root.classList.remove("ctca-manager-resizing-columns");
          saveCachedState(cachedFiles).catch(() => {});
        };
        document.addEventListener("pointermove", move, true);
        document.addEventListener("pointerup", finish, true);
        document.addEventListener("pointercancel", finish, true);
      });
    });
    root.querySelector(".ctca-manager-star-sort").addEventListener("click", () => {
      settings.managerStarredFirst = !settings.managerStarredFirst;
      renderManagerList();
      saveCachedState(cachedFiles).catch(() => {});
    });
    menu.addEventListener("change", (event) => {
      const input = event.target.closest("[data-manager-visible-column]");
      if (input && !managerSetColumnVisible(input.dataset.managerVisibleColumn, input.checked)) {
        input.checked = settings.managerColumnVisibility[input.dataset.managerVisibleColumn] !== false;
      }
    });
    list.addEventListener("scroll", () => { header.scrollLeft = list.scrollLeft; }, { passive: true });
  }

  function initializeManagerResizers(root) {
    const bind = (handle, kind) => {
      if (!handle) return;
      const resizeBy = (delta) => {
        if (kind === "categories") {
          settings.managerColumns.categories = Math.max(130, Math.min(420, settings.managerColumns.categories + delta));
        } else {
          const max = Math.max(320, Math.min(900, root.getBoundingClientRect().width - settings.managerColumns.categories - 360));
          settings.managerColumns.details = Math.max(280, Math.min(max, settings.managerColumns.details - delta));
        }
        applyManagerColumnWidths(root);
      };
      handle.addEventListener("pointerdown", (event) => {
        if (event.button !== 0) return;
        event.preventDefault();
        const startX = event.clientX;
        const startCategories = settings.managerColumns.categories;
        const startDetails = settings.managerColumns.details;
        handle.setPointerCapture?.(event.pointerId);
        root.classList.add("ctca-manager-resizing");
        const move = (moveEvent) => {
          const delta = moveEvent.clientX - startX;
          if (kind === "categories") {
            settings.managerColumns.categories = Math.max(130, Math.min(420, startCategories + delta));
          } else {
            const max = Math.max(320, Math.min(900, root.getBoundingClientRect().width - settings.managerColumns.categories - 360));
            settings.managerColumns.details = Math.max(280, Math.min(max, startDetails - delta));
          }
          applyManagerColumnWidths(root);
        };
        const finish = () => {
          document.removeEventListener("pointermove", move, true);
          document.removeEventListener("pointerup", finish, true);
          document.removeEventListener("pointercancel", finish, true);
          root.classList.remove("ctca-manager-resizing");
          saveCachedState(cachedFiles).catch(() => {});
        };
        document.addEventListener("pointermove", move, true);
        document.addEventListener("pointerup", finish, true);
        document.addEventListener("pointercancel", finish, true);
      });
      handle.addEventListener("keydown", (event) => {
        if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
        event.preventDefault();
        const direction = event.key === "ArrowRight" ? 1 : -1;
        resizeBy(direction * (event.shiftKey ? 40 : 10));
        saveCachedState(cachedFiles).catch(() => {});
      });
    };
    bind(root.querySelector(".ctca-manager-resizer-categories"), "categories");
    bind(root.querySelector(".ctca-manager-resizer-details"), "details");
  }

  function managerRecordId(record) {
    return `${record?.sourceFile || ""}\u241F${record?.key || ""}`;
  }

  function managerEscapeHtml(value) {
    return String(value ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function managerLatexHtml(value) {
    return globalThis.CollabTeXLatex?.toHtml(value) || managerEscapeHtml(value);
  }

  function normalizeManagerCategoryState(value) {
    const categories = Array.isArray(value?.categories)
      ? value.categories
          .filter((category) => category && typeof category.id === "string" && typeof category.name === "string")
          .map((category, index) => ({
            id: category.id,
            name: category.name.trim() || "Untitled category",
            parentId: typeof category.parentId === "string" ? category.parentId : "",
            order: Number.isFinite(Number(category.order)) ? Number(category.order) : index
          }))
      : [];
    const validIds = new Set(categories.map((category) => category.id));
    for (const category of categories) {
      if (!validIds.has(category.parentId) || category.parentId === category.id) category.parentId = "";
    }

    const memberships = {};
    if (value?.memberships && typeof value.memberships === "object") {
      for (const [entryId, categoryIds] of Object.entries(value.memberships)) {
        const normalized = [...new Set((Array.isArray(categoryIds) ? categoryIds : []).filter((id) => validIds.has(id)))];
        if (normalized.length) memberships[entryId] = normalized;
      }
    }
    return { version: CATEGORY_STATE_VERSION, categories, memberships };
  }

  function managerCategoryById(categoryId) {
    return managerCategoryState.categories.find((category) => category.id === categoryId) || null;
  }

  function managerCategoryChildren(parentId = "") {
    return managerCategoryState.categories
      .filter((category) => category.parentId === parentId)
      .sort((left, right) => left.order - right.order || left.name.localeCompare(right.name));
  }

  function managerCategoryDescendantIds(categoryId) {
    const result = new Set([categoryId]);
    const visit = (parentId) => {
      for (const child of managerCategoryChildren(parentId)) {
        if (result.has(child.id)) continue;
        result.add(child.id);
        visit(child.id);
      }
    };
    visit(categoryId);
    return result;
  }

  function managerCategoryPath(categoryId) {
    const parts = [];
    const seen = new Set();
    let current = managerCategoryById(categoryId);
    while (current && !seen.has(current.id)) {
      seen.add(current.id);
      parts.unshift(current.name);
      current = managerCategoryById(current.parentId);
    }
    return parts.join(" / ");
  }

  function managerEntryCategoryIds(entryId) {
    return Array.isArray(managerCategoryState.memberships[entryId])
      ? managerCategoryState.memberships[entryId].filter((id) => Boolean(managerCategoryById(id)))
      : [];
  }

  function managerSetEntryCategoryIds(entryId, categoryIds) {
    const valid = [...new Set((categoryIds || []).filter((id) => Boolean(managerCategoryById(id))))];
    if (valid.length) managerCategoryState.memberships[entryId] = valid;
    else delete managerCategoryState.memberships[entryId];
  }

  function managerAddEntriesToCategory(entryIds, categoryId) {
    if (!managerCategoryById(categoryId)) return;
    for (const entryId of entryIds) {
      const memberships = new Set(managerEntryCategoryIds(entryId));
      memberships.add(categoryId);
      managerSetEntryCategoryIds(entryId, [...memberships]);
    }
    managerMarkEntriesStateDirty(entryIds);
    renderManagerCategories();
    renderManagerList();
    renderManagerDetails();
  }

  function managerClearEntryCategories(entryIds) {
    for (const entryId of entryIds) delete managerCategoryState.memberships[entryId];
    managerMarkEntriesStateDirty(entryIds);
    renderManagerCategories();
    renderManagerList();
    renderManagerDetails();
  }

  function managerRemoveEntryFromCategory(entryId, categoryId) {
    managerSetEntryCategoryIds(entryId, managerEntryCategoryIds(entryId).filter((id) => id !== categoryId));
    managerMarkEntriesStateDirty([entryId]);
    renderManagerCategories();
    renderManagerList();
    renderManagerDetails();
  }

  function managerMigrateCategoryMembership(oldEntryId, newEntryId) {
    if (!oldEntryId || !newEntryId || oldEntryId === newEntryId) return;
    const merged = new Set([
      ...managerEntryCategoryIds(oldEntryId),
      ...managerEntryCategoryIds(newEntryId)
    ]);
    managerSetEntryCategoryIds(newEntryId, [...merged]);
    delete managerCategoryState.memberships[oldEntryId];
    if (managerSelectedIds.delete(oldEntryId)) managerSelectedIds.add(newEntryId);
    if (managerSelectedId === oldEntryId) managerSelectedId = newEntryId;
    if (managerLastSelectionAnchorId === oldEntryId) managerLastSelectionAnchorId = newEntryId;
  }

  function managerEntryMatchesSelectedCategory(entryId) {
    if (managerSelectedCategoryId === "all") return true;
    if (managerSelectedCategoryId === "starred") return managerIsStarred(managerDrafts.get(entryId));
    if (managerSelectedCategoryId === "recent") return true;
    if (managerSelectedCategoryId === "authorships" || managerSelectedCategoryId === "coauthorships") {
      return managerEntryAuthorshipCategory(managerDrafts.get(entryId)) === managerSelectedCategoryId;
    }
    const memberships = managerEntryCategoryIds(entryId);
    if (managerSelectedCategoryId === "uncategorized") {
      return memberships.length === 0 && !managerEntryAuthorshipCategory(managerDrafts.get(entryId));
    }
    const accepted = managerCategoryDescendantIds(managerSelectedCategoryId);
    return memberships.some((categoryId) => accepted.has(categoryId));
  }

  function managerCategoryEntryCount(categoryId) {
    return managerRecords.reduce((count, record) => {
      const entryId = managerRecordId(record);
      if (categoryId === "all") return count + 1;
      if (categoryId === "starred") return count + (managerIsStarred(managerDrafts.get(entryId)) ? 1 : 0);
      if (categoryId === "recent") return count + 1;
      if (categoryId === "authorships" || categoryId === "coauthorships") {
        return count + (managerEntryAuthorshipCategory(managerDrafts.get(entryId)) === categoryId ? 1 : 0);
      }
      const memberships = managerEntryCategoryIds(entryId);
      if (categoryId === "uncategorized") {
        return count + (memberships.length || managerEntryAuthorshipCategory(managerDrafts.get(entryId)) ? 0 : 1);
      }
      const accepted = managerCategoryDescendantIds(categoryId);
      return count + (memberships.some((id) => accepted.has(id)) ? 1 : 0);
    }, 0);
  }

  function managerNormalizeCategoryOrders(parentId = "") {
    managerCategoryChildren(parentId).forEach((category, index) => {
      category.order = index;
    });
  }

  function managerCreateCategoryId() {
    return `category-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
  }

  async function managerCreateCategory() {
    let input = null;
    const result = await showAppDialog({
      title: "Create bibliography category",
      message: "Create a top-level category. You can drag it onto another category later to make it a subcategory.",
      controls: (container) => {
        const label = document.createElement("label");
        label.className = "ctca-app-dialog-field";
        label.textContent = "Category name";
        input = document.createElement("input");
        input.type = "text";
        input.placeholder = "e.g. Plasma instabilities";
        input.maxLength = 120;
        label.appendChild(input);
        container.appendChild(label);
      },
      buttons: [
        { label: "Cancel", value: null },
        { label: "Create category", primary: true, getValue: () => input?.value.trim() || "" }
      ],
      closeValue: null
    });
    if (!result) return;
    const siblings = managerCategoryChildren("");
    const category = {
      id: managerCreateCategoryId(),
      name: result,
      parentId: "",
      order: siblings.length
    };
    managerCategoryState.categories.push(category);
    managerMarkCategoryTreeDirty();
    selectManagerCategory(category.id);
  }

  function managerCanMoveCategory(categoryId, newParentId) {
    if (!categoryId || categoryId === newParentId) return false;
    if (!newParentId) return true;
    return !managerCategoryDescendantIds(categoryId).has(newParentId);
  }

  function managerMoveCategory(categoryId, targetId, mode) {
    const category = managerCategoryById(categoryId);
    if (!category) return;
    const target = managerCategoryById(targetId);
    const oldParentId = category.parentId;
    let newParentId = "";

    if (target) {
      newParentId = mode === "inside" ? target.id : target.parentId;
    }
    if (!managerCanMoveCategory(categoryId, newParentId)) return;

    category.parentId = newParentId;
    const siblings = managerCategoryChildren(newParentId).filter((item) => item.id !== categoryId);
    if (target && mode !== "inside") {
      const targetIndex = siblings.findIndex((item) => item.id === target.id);
      const insertionIndex = targetIndex < 0
        ? siblings.length
        : targetIndex + (mode === "after" ? 1 : 0);
      siblings.splice(insertionIndex, 0, category);
    } else {
      siblings.push(category);
    }
    siblings.forEach((item, index) => { item.order = index; });
    managerNormalizeCategoryOrders(oldParentId);
    if (oldParentId !== newParentId) managerNormalizeCategoryOrders(newParentId);
    managerMarkCategoryTreeDirty();
    renderManagerCategories();
  }

  async function managerRemoveCategory(categoryId) {
    const category = managerCategoryById(categoryId);
    if (!category) return;
    const parent = managerCategoryById(category.parentId);
    const directEntryCount = Object.keys(managerCategoryState.memberships).filter((entryId) =>
      managerEntryCategoryIds(entryId).includes(categoryId)
    ).length;
    const childCount = managerCategoryChildren(categoryId).length;
    const parentLabel = parent ? `the parent category “${parent.name}”` : "Uncategorized";

    const choice = await showAppDialog({
      title: `Remove category “${category.name}”?`,
      message:
        `${directEntryCount} entr${directEntryCount === 1 ? "y is" : "ies are"} assigned directly to this category. ` +
        `${childCount ? `${childCount} direct subcategor${childCount === 1 ? "y will" : "ies will"} be moved to the current parent level. ` : ""}` +
        "The bibliography entries themselves will not be deleted.",
      buttons: parent
        ? [
            { label: "Cancel", value: null },
            { label: "Remove and ungroup entries", value: "ungroup", danger: true },
            { label: `Move entries to ${parent.name}`, value: "parent", primary: true }
          ]
        : [
            { label: "Cancel", value: null },
            { label: "Remove category and ungroup entries", value: "ungroup", danger: true }
          ],
      closeValue: null,
      danger: true
    });
    if (!choice) return;

    const affectedEntryIds = [];
    for (const [entryId, categoryIds] of Object.entries(managerCategoryState.memberships)) {
      if (!categoryIds.includes(categoryId)) continue;
      const next = categoryIds.filter((id) => id !== categoryId);
      if (choice === "parent" && parent && !next.includes(parent.id)) next.push(parent.id);
      managerSetEntryCategoryIds(entryId, next);
      affectedEntryIds.push(entryId);
    }
    const children = managerCategoryChildren(categoryId);
    const parentChildren = managerCategoryChildren(category.parentId).filter((item) => item.id !== categoryId);
    for (const child of children) {
      child.parentId = category.parentId;
      child.order = parentChildren.length;
      parentChildren.push(child);
    }
    managerCategoryState.categories = managerCategoryState.categories.filter((item) => item.id !== categoryId);
    managerNormalizeCategoryOrders(category.parentId);
    if (managerSelectedCategoryId === categoryId) {
      managerSelectedCategoryId = parent?.id || "all";
      settings.managerSelectedCategoryId = managerSelectedCategoryId;
    }
    managerMarkEntriesStateDirty(affectedEntryIds);
    managerMarkCategoryTreeDirty();
    renderManagerCategories();
    renderManagerList();
    renderManagerDetails();
    const destinationLabel = choice === "parent" && parent ? `the parent category “${parent.name}”` : "Uncategorized";
    managerSetStatus(`Removed category ${category.name}; directly assigned entries were moved to ${destinationLabel}.`);
  }

  function managerCategoryDropMode(element, clientY) {
    const rect = element.getBoundingClientRect();
    const relative = (clientY - rect.top) / Math.max(1, rect.height);
    if (relative < 0.25) return "before";
    if (relative > 0.75) return "after";
    return "inside";
  }

  function managerHideCategoryContextMenu() {
    const menu = bibManager?.querySelector(".ctca-category-context-menu");
    if (menu) {
      menu.hidden = true;
      delete menu.dataset.categoryId;
      delete menu.dataset.pointerEntered;
    }
  }

  function renderManagerCategories() {
    if (!bibManager) return;
    const container = bibManager.querySelector(".ctca-manager-category-tree");
    if (!container) return;
    container.replaceChildren();

    const createFixed = (id, label) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "ctca-manager-category-fixed";
      button.classList.toggle("ctca-manager-category-selected", managerSelectedCategoryId === id);
      button.dataset.categoryId = id;
      button.innerHTML = `<span>${managerEscapeHtml(label)}</span><span class="ctca-manager-category-count">${managerCategoryEntryCount(id)}</span>`;
      button.addEventListener("click", () => {
        selectManagerCategory(id);
      });
      if (id === "uncategorized") {
        button.addEventListener("dragover", (event) => {
          if (!Array.from(event.dataTransfer.types || []).includes("application/x-ctca-entry-ids")) return;
          event.preventDefault();
          button.classList.add("ctca-manager-category-drop-target");
        });
        button.addEventListener("dragleave", () => button.classList.remove("ctca-manager-category-drop-target"));
        button.addEventListener("drop", (event) => {
          event.preventDefault();
          button.classList.remove("ctca-manager-category-drop-target");
          try {
            const ids = JSON.parse(event.dataTransfer.getData("application/x-ctca-entry-ids") || "[]");
            managerClearEntryCategories(ids);
          } catch (_error) {}
        });
      }
      container.appendChild(button);
    };

    createFixed("all", "All");
    createFixed("starred", "Starred");
    createFixed("authorships", "My authorships");
    createFixed("coauthorships", "My co-authorships");
    createFixed("recent", "Recently added");
    const addSeparator = () => {
      const separator = document.createElement("div");
      separator.className = "ctca-manager-category-separator";
      separator.setAttribute("aria-hidden", "true");
      container.appendChild(separator);
    };
    addSeparator();

    const renderBranch = (parentId, depth) => {
      for (const category of managerCategoryChildren(parentId)) {
        const row = document.createElement("div");
        row.className = "ctca-manager-category-row";
        row.classList.toggle("ctca-manager-category-selected", managerSelectedCategoryId === category.id);
        row.dataset.categoryId = category.id;
        row.draggable = true;
        row.style.setProperty("--ctca-category-depth", String(depth));
        row.innerHTML = `
          <span class="ctca-manager-category-handle" title="Drag to reorder or nest" aria-hidden="true">⋮⋮</span>
          <button type="button" class="ctca-manager-category-name" title="${managerEscapeHtml(managerCategoryPath(category.id))}">${managerEscapeHtml(category.name)}</button>
          <span class="ctca-manager-category-count">${managerCategoryEntryCount(category.id)}</span>
        `;
        row.querySelector(".ctca-manager-category-name").addEventListener("click", () => {
          selectManagerCategory(category.id);
        });
        row.addEventListener("contextmenu", (event) => {
          event.preventDefault();
          event.stopPropagation();
          managerHideEntryContextMenu();
          const menu = bibManager.querySelector(".ctca-category-context-menu");
          menu.dataset.categoryId = category.id;
          delete menu.dataset.pointerEntered;
          menu.onpointerenter = () => { menu.dataset.pointerEntered = "true"; };
          menu.onpointerleave = () => {
            if (menu.dataset.pointerEntered === "true") managerHideCategoryContextMenu();
          };
          menu.style.left = `${Math.min(event.clientX, window.innerWidth - 220)}px`;
          menu.style.top = `${Math.min(event.clientY, window.innerHeight - 90)}px`;
          menu.hidden = false;
        });
        row.addEventListener("dragstart", (event) => {
          managerCategoryDragId = category.id;
          event.dataTransfer.effectAllowed = "move";
          event.dataTransfer.setData("application/x-ctca-category", category.id);
          row.classList.add("ctca-manager-category-dragging");
        });
        row.addEventListener("dragend", () => {
          managerCategoryDragId = "";
          row.classList.remove("ctca-manager-category-dragging");
          bibManager.querySelectorAll(".ctca-manager-category-drop-before, .ctca-manager-category-drop-after, .ctca-manager-category-drop-inside")
            .forEach((item) => item.classList.remove("ctca-manager-category-drop-before", "ctca-manager-category-drop-after", "ctca-manager-category-drop-inside"));
        });
        row.addEventListener("dragover", (event) => {
          const hasCategory = Array.from(event.dataTransfer.types || []).includes("application/x-ctca-category");
          const hasEntries = Array.from(event.dataTransfer.types || []).includes("application/x-ctca-entry-ids");
          if (!hasCategory && !hasEntries) return;
          event.preventDefault();
          if (hasCategory) {
            const mode = managerCategoryDropMode(row, event.clientY);
            row.classList.remove("ctca-manager-category-drop-before", "ctca-manager-category-drop-after", "ctca-manager-category-drop-inside");
            row.classList.add(`ctca-manager-category-drop-${mode}`);
          } else {
            row.classList.add("ctca-manager-category-drop-inside");
          }
        });
        row.addEventListener("dragleave", (event) => {
          if (row.contains(event.relatedTarget)) return;
          row.classList.remove("ctca-manager-category-drop-before", "ctca-manager-category-drop-after", "ctca-manager-category-drop-inside");
        });
        row.addEventListener("drop", (event) => {
          event.preventDefault();
          event.stopPropagation();
          const categorySource = event.dataTransfer.getData("application/x-ctca-category");
          const entryPayload = event.dataTransfer.getData("application/x-ctca-entry-ids");
          const mode = managerCategoryDropMode(row, event.clientY);
          row.classList.remove("ctca-manager-category-drop-before", "ctca-manager-category-drop-after", "ctca-manager-category-drop-inside");
          if (categorySource) {
            managerMoveCategory(categorySource, category.id, mode);
          } else if (entryPayload) {
            try {
              managerAddEntriesToCategory(JSON.parse(entryPayload), category.id);
            } catch (_error) {}
          }
        });
        container.appendChild(row);
        renderBranch(category.id, depth + 1);
      }
    };
    renderBranch("", 0);
    addSeparator();
    createFixed("uncategorized", "Uncategorized");
  }

  function stripOneBibDelimiter(value) {
    const text = String(value ?? "").trim();
    if (text.length >= 2 && ((text.startsWith("{") && text.endsWith("}")) || (text.startsWith('"') && text.endsWith('"')))) {
      return text.slice(1, -1).trim();
    }
    return text;
  }

  function normalizeFieldMapForEditing(fields = {}) {
    const normalized = {};
    for (const [name, value] of Object.entries(fields || {})) {
      normalized[String(name).toLowerCase()] = stripOneBibDelimiter(value);
    }
    return normalized;
  }

  function draftFromRecord(record) {
    return {
      id: managerRecordId(record),
      originalKey: record.key,
      key: record.key,
      type: record.type || "article",
      sourceFile: record.sourceFile || managerFiles[0] || "",
      fields: normalizeFieldMapForEditing(record.fields || {}),
      existingRecord: record
    };
  }

  function managerGetDraft(recordOrId) {
    const id = typeof recordOrId === "string" ? recordOrId : managerRecordId(recordOrId);
    return managerDrafts.get(id) || null;
  }

  function managerMarkDirty(draft, render = true) {
    if (!draft || draft.centralPreview === true) return;
    managerDirtyIds.add(draft.id);
    managerSessionChanged = true;
    if (render) {
      renderManagerList();
      updateManagerCount();
    } else {
      bibManager.querySelector(`[data-manager-record-id="${CSS.escape(draft.id)}"]`)
        ?.classList.add("ctca-manager-row-dirty");
      updateManagerCount();
    }
    scheduleFastManagerCentralSync(draft);
  }

  function scheduleManagerListRender() {
    if (managerListRenderTimer !== null) window.clearTimeout(managerListRenderTimer);
    managerListRenderTimer = window.setTimeout(() => {
      managerListRenderTimer = null;
      renderManagerList();
    }, 140);
  }

  function managerSetStatus(message, isError = false) {
    const element = bibManager.querySelector(".ctca-manager-status");
    element.textContent = message || "";
    element.classList.toggle("ctca-manager-error", Boolean(isError));
  }

  function managerSetProgress(current = 0, total = 0, label = "", visible = true, options = {}) {
    const container = bibManager.querySelector(".ctca-manager-progress");
    const progress = bibManager.querySelector(".ctca-manager-progress-bar");
    const text = bibManager.querySelector(".ctca-manager-progress-label");
    const abortButton = bibManager.querySelector(".ctca-manager-abort-doi");
    if (!container || !progress || !text || !abortButton) return;

    const final = Boolean(options.final);
    container.hidden = !visible;
    bibManager.classList.toggle("ctca-manager-progress-active", Boolean(visible));
    progress.max = Math.max(1, Number(total) || 1);
    progress.value = Math.min(progress.max, Math.max(0, Number(current) || 0));
    text.textContent = label || `${current}/${total}`;
    text.title = text.textContent;
    abortButton.hidden = final || !visible;
    abortButton.disabled = final || !visible || managerBulkDoiAbortRequested;
    abortButton.textContent = managerBulkDoiAbortRequested ? "Stopping DOI update…" : "Abort DOI update";
  }

  async function requestManagerBulkDoiAbort() {
    const progress = bibManager.querySelector(".ctca-manager-progress");
    if (!managerBusy || progress?.hidden || managerBulkDoiAbortRequested) return;

    managerBulkDoiAbortRequested = true;
    const stats = managerBulkDoiStats || {
      processed: Number(bibManager.querySelector(".ctca-manager-progress-bar")?.value || 0),
      total: Number(bibManager.querySelector(".ctca-manager-progress-bar")?.max || 1),
      updated: 0,
      failed: 0
    };
    managerSetProgress(
      stats.processed,
      stats.total,
      `Abort requested · ${stats.processed}/${stats.total} processed · ${stats.updated} updated · ${stats.failed} failed`,
      true
    );
    managerSetStatus("Abort requested. Completed DOI updates will still be written.");

    if (managerBulkDoiActiveRequestId) {
      try {
        await extensionApi.runtime.sendMessage({
          type: "ctca-cancel-doi-metadata",
          requestId: managerBulkDoiActiveRequestId
        });
      } catch (_error) {
        // The active request may have completed between the click and this message.
      }
    }
  }

  function managerBibFileLabel() {
    const files = managerFiles.length ? managerFiles : [...new Set(managerRecords.map((record) => record.sourceFile).filter(Boolean))];
    if (!files.length) return "No BibTeX file loaded";
    return files.map((fileName) => String(fileName).replace(/\\/g, "/").split("/").pop()).join(", ");
  }

  function updateManagerBibButton(busy = managerBusy, label = "Working…") {
    const updateButton = bibManager?.querySelector(".ctca-manager-update");
    if (!updateButton) return;
    const main = updateButton.querySelector(".ctca-manager-update-main");
    const files = updateButton.querySelector(".ctca-manager-update-files");
    if (main) main.textContent = busy ? label : "↻ Update Bib";
    if (files) {
      files.textContent = managerBibFileLabel();
      files.title = managerFiles.join(", ") || "No BibTeX file loaded";
    }
  }

  function setManagerBusy(busy, label = "Working…") {
    managerBusy = busy;
    bibManager.classList.toggle("ctca-manager-busy", busy);
    bibManager.querySelectorAll(
      ".ctca-manager-update, .ctca-manager-update-all-doi, .ctca-manager-update-selected, .ctca-manager-remove-selected, .ctca-manager-add-entry, .ctca-manager-add-menu button, .ctca-manager-global-sync-checkbox, .ctca-manager-nextcloud-sync-checkbox, .ctca-manager-cloud-settings, .ctca-manager-options, .ctca-manager-add-category, .ctca-manager-select-visible-checkbox, .ctca-manager-star-sort, .ctca-manager-column-eye, [data-manager-sort]"
    ).forEach((element) => {
      element.disabled = busy;
    });
    const nextcloudToggle = bibManager.querySelector(".ctca-manager-nextcloud-sync-checkbox");
    if (nextcloudToggle) nextcloudToggle.disabled = Boolean(busy || !managerNextcloudConnected);
    updateManagerBibButton(busy, label);
    toolbarButton.disabled = busy || refreshInProgress || jumpInProgress || doiOperationInProgress;
    toolbarButton.textContent = busy ? "bib…" : "bib";
    updateManagerSelectionControls(sortedFilteredManagerRecords().map((record) => managerRecordId(record)));
    if (!busy && managerCloseCommitRequested && !bibManager.classList.contains("ctca-manager-visible")) {
      managerCloseCommitRequested = false;
      window.queueMicrotask(() => {
        closeBibManager(null, { continueAfterHidden: true }).catch(() => {});
      });
    }
  }

  function setManagerCentralSyncLoading(visible) {
    const overlay = bibManager?.querySelector(".ctca-manager-central-sync-overlay");
    const list = bibManager?.querySelector(".ctca-manager-list");
    if (!overlay || !list) return;
    overlay.hidden = !visible;
    list.setAttribute("aria-busy", visible ? "true" : "false");
  }

  function setManagerListLoading(visible) {
    const overlay = bibManager?.querySelector(".ctca-manager-list-loading-overlay");
    const list = bibManager?.querySelector(".ctca-manager-list");
    if (!overlay || !list) return;
    overlay.hidden = !visible;
    list.setAttribute("aria-busy", visible ? "true" : "false");
  }

  function selectManagerCategory(categoryId) {
    if (!categoryId || managerSelectedCategoryId === categoryId) return;
    managerSelectedCategoryId = categoryId;
    settings.managerSelectedCategoryId = categoryId;
    setManagerListLoading(true);
    const revision = ++managerCategoryListRenderRevision;
    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => {
        if (revision !== managerCategoryListRenderRevision) return;
        try {
          renderManagerCategories();
          renderManagerList();
        } finally {
          setManagerListLoading(false);
        }
        window.requestAnimationFrame(() => {
          saveCachedState().catch(() => {});
        });
      });
    });
  }

  function updateManagerCount(visibleCount = null) {
    const count = visibleCount ?? managerRecords.length;
    const dirty = managerDirtyIds.size;
    const removed = managerDeletedDrafts.size;
    const selected = managerSelectedIds.size;
    const changes = [
      selected ? `${selected} selected` : "",
      dirty ? `${dirty} edited` : "",
      removed ? `${removed} removed` : ""
    ].filter(Boolean).join(" · ");
    const filterCount = globalThis.CollabTeXSearchTools.activeFilterCount(settings.managerFilters);
    const filterLabel = filterCount ? ` · ${filterCount} filter${filterCount === 1 ? "" : "s"}` : "";
    bibManager.querySelector(".ctca-manager-count").textContent =
      `${count} of ${managerRecords.length} entries${filterLabel}${changes ? ` · ${changes}` : ""}`;
  }

  function managerAuthors(draft) {
    return window.CollabTeXBibTeX.splitAuthors(
      draft?.fields?.author || draft?.fields?.editor || ""
    );
  }

  function managerRawAuthors(draft) {
    return window.CollabTeXBibTeX.splitAuthorsRaw(
      draft?.fields?.author || draft?.fields?.editor || ""
    );
  }

  function managerAllAuthorsLabel(draft) {
    const authors = managerAuthors(draft);
    return authors.length ? authors.join("; ") : "Unknown";
  }

  function managerAllAuthorsHtml(draft) {
    const value = draft?.fields?.author || draft?.fields?.editor || "";
    const authors = window.CollabTeXBibTeX.splitAuthorsDisplayRaw(value);
    return managerLatexHtml(authors.length ? authors.join("\n") : "Unknown");
  }

  function managerAllAuthorsInlineHtml(draft) {
    const value = draft?.fields?.author || draft?.fields?.editor || "";
    const authors = window.CollabTeXBibTeX.splitAuthorsDisplayRaw(value);
    return managerLatexHtml(authors.length ? authors.join("; ") : "Unknown");
  }

  function managerIsStarred(draft) {
    return /^(?:true|1|yes|starred)$/i.test(stripOneBibDelimiter(draft?.fields?.[CTCA_STARRED_FIELD] || ""));
  }

  function managerAddedOn(draft) {
    return stripOneBibDelimiter(draft?.fields?.[CTCA_ADDED_ON_FIELD] || "");
  }

  function managerFormatAddedOn(draft) {
    const value = managerAddedOn(draft);
    const date = new Date(value);
    if (!value || Number.isNaN(date.getTime())) return "Unknown";
    const day = String(date.getDate()).padStart(2, "0");
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const hour = String(date.getHours() % 12 || 12).padStart(2, "0");
    const minute = String(date.getMinutes()).padStart(2, "0");
    return `${day}/${month}/${date.getFullYear()}, ${hour}:${minute} ${date.getHours() < 12 ? "am" : "pm"}`;
  }

  function managerAbbreviatedFirstAuthor(draft) {
    const raw = managerRawAuthors(draft)[0] || "";
    if (!raw) return "Unknown et al.";
    const formatted = window.CollabTeXBibTeX.formatAuthorName(raw);
    const family = window.CollabTeXBibTeX.authorFamilyName(raw);
    const given = formatted.slice(0, Math.max(0, formatted.lastIndexOf(family))).trim();
    const initial = given.match(/\p{L}/u)?.[0] || "";
    return `${initial ? `${initial}. ` : ""}${family || formatted} et al.`;
  }

  function managerPersonIdentity(value) {
    const raw = String(value || "").trim();
    if (!raw) return null;
    const formatted = window.CollabTeXBibTeX.formatAuthorName(raw);
    const family = window.CollabTeXBibTeX.authorFamilyName(raw);
    const given = formatted.slice(0, Math.max(0, formatted.lastIndexOf(family))).trim();
    const normalize = (text) => window.CollabTeXBibTeX.latexToText(text)
      .normalize("NFKD")
      .replace(/\p{M}/gu, "")
      .replace(/[^\p{L}\p{N}]+/gu, "")
      .toLocaleLowerCase();
    return {
      family: normalize(family),
      initial: normalize(given).match(/\p{L}/u)?.[0] || "",
      full: normalize(formatted)
    };
  }

  function managerPersonNamesMatch(left, right) {
    const first = managerPersonIdentity(left);
    const second = managerPersonIdentity(right);
    if (!first || !second || !first.family || first.family !== second.family) return false;
    if (first.full === second.full) return true;
    return !first.initial || !second.initial || first.initial === second.initial;
  }

  function managerEntryAuthorshipCategory(draft) {
    if (!managerAuthorshipUserName) return "";
    const authors = window.CollabTeXBibTeX.splitAuthorsRaw(draft?.fields?.author || "");
    const index = authors.findIndex((author) => managerPersonNamesMatch(author, managerAuthorshipUserName));
    return index === 0 ? "authorships" : index > 0 ? "coauthorships" : "";
  }

  async function managerEnsureAuthorshipUserName() {
    const stored = (await extensionApi.storage.local.get(AUTHOR_OPTIONS_KEY))?.[AUTHOR_OPTIONS_KEY] || {};
    managerAuthorshipUserName = String(stored.userName || "").trim();
    if (managerAuthorshipUserName || stored.identitySetupSeen === true) return;
    let nameInput;
    const result = await showAppDialog({
      title: "Link your author identity",
      message: "Enter your published name, or authenticate through ORCID’s official sign-in flow. This is used for the automatic author categories and exact OpenAlex matching.",
      controls: (container) => {
        const fields = document.createElement("div");
        fields.className = "ctca-global-dialog-form";
        fields.innerHTML = `
          <label class="ctca-app-dialog-field"><span>Your published name</span><input data-author-name type="text" autocomplete="name" placeholder="e.g. Ada Lovelace"></label>
        `;
        nameInput = fields.querySelector("[data-author-name]");
        container.appendChild(fields);
      },
      buttons: [
        { label: "Not now", value: { skipped: true } },
        { label: "Sign in with ORCID", value: { oauth: true } },
        {
          label: "Save name",
          primary: true,
          getValue: () => ({ name: nameInput?.value.trim() || "" })
        }
      ],
      closeValue: { skipped: true }
    });
    const next = { ...stored, identitySetupSeen: true };
    if (result?.oauth) {
      const response = await extensionApi.runtime.sendMessage({
        type: "ctca-orcid-oauth-link"
      });
      if (!response?.ok) {
        next.identitySetupSeen = false;
        managerSetStatus(response?.error || "The ORCID account could not be linked.", true);
      } else {
        const profile = response.profile || {};
        next.orcidId = profile.url || profile.orcid || "";
        next.orcidOAuthAuthenticatedOrcid = profile.orcid || "";
        next.orcidOAuthAuthenticatedAt = profile.authenticatedAt || new Date().toISOString();
        next.orcidLastAutomaticCheckAt = "";
        next.userName = profile.displayName || "";
        next.authorInstitutions = profile.institutions || [];
      }
    } else if (result?.name) {
      next.userName = result.name;
    }
    managerAuthorshipUserName = String(next.userName || "").trim();
    await extensionApi.storage.local.set({
      [AUTHOR_OPTIONS_KEY]: next
    });
  }

  function managerDoiSyncKey(draftOrDoi) {
    const value = typeof draftOrDoi === "string"
      ? draftOrDoi
      : draftOrDoi?.fields?.doi || draftOrDoi?.doi || "";
    const doi = normalizeDoiInput(value);
    return doi ? doi.toLocaleLowerCase() : "";
  }

  function managerDoiSyncedAt(draft) {
    const embedded = stripOneBibDelimiter(draft?.fields?.[CTCA_DOI_SYNC_FIELD] || "");
    if (embedded) return embedded;
    const key = managerDoiSyncKey(draft);
    return key ? String(doiSyncLedger[key] || "") : "";
  }

  function managerWasDoiSynced(draft) {
    return Boolean(managerDoiSyncedAt(draft));
  }

  function managerMarkDoiSynced(draftOrDoi, timestamp = new Date().toISOString()) {
    const key = managerDoiSyncKey(draftOrDoi);
    if (key) doiSyncLedger[key] = timestamp;
    if (draftOrDoi && typeof draftOrDoi === "object") {
      draftOrDoi.fields = draftOrDoi.fields || {};
      const isDraft = "originalKey" in draftOrDoi || "existingRecord" in draftOrDoi;
      draftOrDoi.fields[CTCA_DOI_SYNC_FIELD] = isDraft ? timestamp : `{${timestamp}}`;
    }
    return timestamp;
  }

  function managerDoiSyncLabel(draft) {
    const timestamp = managerDoiSyncedAt(draft);
    if (!timestamp) return "";
    const date = new Date(timestamp);
    const formatted = Number.isNaN(date.getTime()) ? timestamp : [
      String(date.getDate()).padStart(2, "0"),
      String(date.getMonth() + 1).padStart(2, "0"),
      date.getFullYear()
    ].join("/") + `, ${String(date.getHours() % 12 || 12).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")} ${date.getHours() < 12 ? "am" : "pm"}`;
    return `DOI metadata synchronized ${formatted}`;
  }

  function managerAuthorSortValue(draft) {
    const value = draft?.fields?.author || draft?.fields?.editor || "";
    const first = window.CollabTeXBibTeX.splitAuthorsRaw(value)[0] || "";
    return window.CollabTeXBibTeX.authorFamilyName(first);
  }

  function managerSearchCategoryTexts(draft) {
    const fields = draft?.fields || {};
    const keyFields = [draft?.key, draft?.originalKey, fields.ids];
    const authorFields = [fields.author, fields.editor, managerAllAuthorsLabel(draft)];
    const journalFields = [fields.journal, fields.journaltitle, fields.booktitle];
    const yearFields = [fields.year, fields.date];
    const abstractFields = [fields.abstract];
    const categorized = new Set([
      "ids", "author", "editor", "journal", "journaltitle", "booktitle",
      "year", "date", "abstract"
    ]);
    const otherFields = [draft?.type, draft?.sourceFile];
    for (const [name, value] of Object.entries(fields)) {
      if (!categorized.has(String(name).toLowerCase())) {
        otherFields.push(name, stripOneBibDelimiter(value));
      }
    }

    const normalize = (values) => values.filter(Boolean).map((value) => stripOneBibDelimiter(value)).join("\n");
    return {
      key: normalize(keyFields),
      authors: normalize(authorFields),
      journal: normalize(journalFields),
      year: normalize(yearFields),
      abstract: normalize(abstractFields),
      others: normalize(otherFields)
    };
  }

  function managerTextMatchesAllTerms(text, terms) {
    const haystack = String(text || "").toLocaleLowerCase();
    return terms.every((term) => haystack.includes(term.toLocaleLowerCase()));
  }

  function managerSearchEntryModel(draft) {
    return {
      key: draft?.key || "",
      type: draft?.type || "misc",
      fields: draft?.fields || {},
      aliases: splitAliasKeys(draft?.fields?.ids || ""),
      tags: globalThis.CollabTeXSearchTools.splitTags(draft?.fields?.[CTCA_TAGS_FIELD] || ""),
      categoryPaths: managerEntryCategoryIds(draft?.id || "").map(managerCategoryPath).filter(Boolean)
    };
  }

  function managerSearchMatch(draft) {
    return globalThis.CollabTeXSearchTools.matchEntry(managerSearchEntryModel(draft), managerQuery, {
      includeAbstract: settings.managerSearchOptions.includeAbstract,
      includePdfText: settings.managerSearchOptions.includePdfText,
      filters: settings.managerFilters
    });
  }

  function managerCompareDrafts(a, b) {
    const factor = managerSort.direction === "desc" ? -1 : 1;
    let av = "";
    let bv = "";
    if (managerSort.field === "author") {
      av = managerAuthorSortValue(a);
      bv = managerAuthorSortValue(b);
    } else if (managerSort.field === "year") {
      av = a?.fields?.year || "";
      bv = b?.fields?.year || "";
    } else if (managerSort.field === "addedOn") {
      av = managerAddedOn(a);
      bv = managerAddedOn(b);
    } else {
      av = a?.key || "";
      bv = b?.key || "";
    }
    return av.localeCompare(bv, undefined, { numeric: true, sensitivity: "base" }) * factor;
  }

  function sortedFilteredManagerRecords() {
    const ranked = managerRecords.map((record) => {
      const draft = managerGetDraft(record);
      return { record, draft, ...managerSearchMatch(draft) };
    }).filter((item) =>
      item.matched &&
      (item.draft?.centralPreview === true || managerEntryMatchesSelectedCategory(item.draft?.id || managerRecordId(item.record)))
    );

    ranked.sort((left, right) => {
      if (managerSelectedCategoryId === "recent") {
        return (new Date(managerAddedOn(right.draft) || 0).getTime() || 0) -
          (new Date(managerAddedOn(left.draft) || 0).getTime() || 0);
      }
      const leftIsNew = managerNewEntryKeys.has(String(left.draft?.key || "").toLowerCase());
      const rightIsNew = managerNewEntryKeys.has(String(right.draft?.key || "").toLowerCase());
      if (leftIsNew !== rightIsNew) return leftIsNew ? -1 : 1;
      if (settings.managerStarredFirst && managerIsStarred(left.draft) !== managerIsStarred(right.draft)) {
        return managerIsStarred(left.draft) ? -1 : 1;
      }
      if (managerQuery.trim() && left.rank !== right.rank) return left.rank - right.rank;
      return managerCompareDrafts(left.draft, right.draft);
    });
    return ranked.map((item) => item.record);
  }

  function updateManagerSelectionControls(visibleIds = []) {
    const actionBar = bibManager.querySelector(".ctca-manager-selection-actionbar");
    const removeButton = bibManager.querySelector(".ctca-manager-remove-selected");
    const updateButton = bibManager.querySelector(".ctca-manager-update-selected");
    const selectedCount = managerSelectedIds.size;
    const showSelectionActions = selectedCount >= 2;
    const selectedWithDoi = [...managerSelectedIds]
      .map((id) => managerDrafts.get(id))
      .filter((draft) => Boolean(normalizeDoiInput(draft?.fields?.doi || ""))).length;
    if (actionBar) actionBar.hidden = !showSelectionActions;
    if (removeButton) {
      removeButton.hidden = !showSelectionActions;
      removeButton.disabled = managerBusy || !showSelectionActions;
      removeButton.textContent = showSelectionActions ? `Remove selected (${selectedCount})` : "Remove selected";
    }
    if (updateButton) {
      updateButton.hidden = !showSelectionActions;
      updateButton.disabled = managerBusy || !showSelectionActions || selectedWithDoi === 0;
      updateButton.textContent = showSelectionActions
        ? `🌐 Update selected${selectedWithDoi !== selectedCount ? ` (${selectedWithDoi}/${selectedCount} with DOI)` : ` (${selectedCount})`}`
        : "🌐 Update selected";
    }
    const selectVisible = bibManager.querySelector(".ctca-manager-select-visible-checkbox");
    if (selectVisible) {
      const selectedVisible = visibleIds.filter((id) => managerSelectedIds.has(id)).length;
      selectVisible.checked = visibleIds.length > 0 && selectedVisible === visibleIds.length;
      selectVisible.indeterminate = selectedVisible > 0 && selectedVisible < visibleIds.length;
      selectVisible.disabled = managerBusy || visibleIds.length === 0;
    }
  }

  function updateManagerListSelectionState(visibleIds, previousSelectedIds, previousActiveId) {
    const affectedIds = new Set([
      ...(previousSelectedIds || []),
      ...managerSelectedIds,
      previousActiveId,
      managerSelectedId
    ]);
    const list = bibManager.querySelector(".ctca-manager-list");
    affectedIds.forEach((id) => {
      if (!id) return;
      const row = list.querySelector(`.ctca-manager-row[data-manager-record-id="${CSS.escape(id)}"]`);
      if (!row) return;
      const selected = managerSelectedIds.has(id);
      row.classList.toggle("ctca-manager-row-active", managerSelectedIds.has(id) && managerSelectedId === id);
      row.classList.toggle("ctca-manager-row-selected", selected);
      row.setAttribute("aria-selected", selected ? "true" : "false");
      const checkbox = row.querySelector(".ctca-manager-row-checkbox");
      if (checkbox) checkbox.checked = selected;
    });
    updateManagerSelectionControls(visibleIds);
    updateManagerCount(visibleIds.length);
  }

  function managerSelectRange(visibleIds, targetId) {
    const anchorId = managerLastSelectionAnchorId && visibleIds.includes(managerLastSelectionAnchorId)
      ? managerLastSelectionAnchorId
      : targetId;
    const start = visibleIds.indexOf(anchorId);
    const end = visibleIds.indexOf(targetId);
    if (start < 0 || end < 0) return;
    const [low, high] = start <= end ? [start, end] : [end, start];
    for (let index = low; index <= high; index += 1) managerSelectedIds.add(visibleIds[index]);
  }

  async function chooseManagerCentralDeletions(drafts) {
    const choices = new Map();
    if (!settings.syncGlobalDatabase) {
      for (const draft of drafts) choices.set(draft.id, false);
      return choices;
    }

    let choiceForRemaining = null;
    for (let index = 0; index < drafts.length; index += 1) {
      const draft = drafts[index];
      if (choiceForRemaining !== null) {
        choices.set(draft.id, choiceForRemaining);
        continue;
      }

      let useForAll = false;
      const decision = await showAppDialog({
        title: `Delete ${draft.key} from the central database too?`,
        message:
          `${draft.key} will be removed from this ColLabTeX document. ` +
          "Choose whether the synchronized entry should also be deleted from the Smart Citations central database.",
        controls: drafts.length > 1
          ? (container) => {
              const label = document.createElement("label");
              label.className = "ctca-app-dialog-check";
              const checkbox = document.createElement("input");
              checkbox.type = "checkbox";
              checkbox.addEventListener("change", () => {
                useForAll = checkbox.checked;
              });
              label.append(checkbox, document.createTextNode("Use this choice for all entries"));
              container.appendChild(label);
            }
          : null,
        buttons: [
          { label: "Cancel deletion", value: null },
          {
            label: "Keep in central database",
            primary: true,
            getValue: () => ({ deleteCentral: false, useForAll })
          },
          {
            label: "Delete from central database",
            danger: true,
            getValue: () => ({ deleteCentral: true, useForAll })
          }
        ],
        closeValue: null,
        danger: true
      });
      if (!decision) return null;
      choices.set(draft.id, decision.deleteCentral);
      if (decision.useForAll) choiceForRemaining = decision.deleteCentral;
    }
    return choices;
  }

  function managerChosenCentralDeletionIdentities() {
    return new Set([
      ...managerPendingCentralDeletionIdentities,
      ...[...managerDeletedDrafts.entries()]
        .filter(([id]) => managerCentralDeletionChoices.get(id) === true)
        .map(([, draft]) => globalSyncIdentity(globalItemFromDraft(draft)))
        .filter((identity) => identity !== "key:")
    ]);
  }

  async function managerRemoveSelectedEntries() {
    if (managerBusy || !managerSelectedIds.size) return;
    const selectedDrafts = [...managerSelectedIds]
      .map((id) => managerDrafts.get(id))
      .filter(Boolean);
    if (!selectedDrafts.length) return;
    const result = await showAppDialog({
      title: `Remove ${selectedDrafts.length} selected entr${selectedDrafts.length === 1 ? "y" : "ies"}?`,
      message:
        "The selected entries will be marked for removal. When Update Bib writes the changes, their attached PDFs will also be deleted from browser storage or Nextcloud.",
      buttons: [
        { label: "Keep entries", value: false },
        { label: selectedDrafts.length === 1 ? "Remove selected entry" : `Remove ${selectedDrafts.length} selected entries`, value: true, danger: true }
      ],
      closeValue: false,
      danger: true
    });
    if (!result) return;
    const centralChoices = await chooseManagerCentralDeletions(selectedDrafts);
    if (!centralChoices) return;

    for (const draft of selectedDrafts) {
      managerDeletedDrafts.set(draft.id, draft);
      const deleteCentral = centralChoices.get(draft.id) === true;
      managerCentralDeletionChoices.set(draft.id, deleteCentral);
      if (deleteCentral) {
        managerPendingCentralDeletionIdentities.add(globalSyncIdentity(globalItemFromDraft(draft)));
      }
      managerDirtyIds.delete(draft.id);
      managerDrafts.delete(draft.id);
    }
    const removedIds = new Set(selectedDrafts.map((draft) => draft.id));
    managerRecords = managerRecords.filter((record) => !removedIds.has(managerRecordId(record)));
    managerSelectedIds.clear();
    managerSelectedId = managerDrafts.keys().next().value || "";
    managerLastSelectionAnchorId = "";
    renderManagerCategories();
    renderManagerList();
    renderManagerDetails();
    updateManagerCount();
    managerSessionChanged = true;
    managerSetStatus(
      `${selectedDrafts.length} entr${selectedDrafts.length === 1 ? "y is" : "ies are"} marked for removal. ` +
      "Click Update Bib to write the change, or close the window to save it."
    );
  }

  function renderManagerList() {
    applyManagerColumnWidths();
    const list = bibManager.querySelector(".ctca-manager-list");
    const visible = sortedFilteredManagerRecords();
    const openAlexDescriptors = [];
    const visibleIds = visible.map((record) => managerRecordId(record));
    list.replaceChildren();

    bibManager.querySelectorAll("[data-manager-sort]").forEach((button) => {
      const active = button.dataset.managerSort === (managerSelectedCategoryId === "recent" ? "addedOn" : managerSort.field);
      button.classList.toggle("ctca-manager-sort-active", active);
      button.querySelector("span").textContent = active
        ? (managerSort.direction === "asc" ? "↑" : "↓")
        : "↕";
    });
    const starSort = bibManager.querySelector(".ctca-manager-star-sort");
    starSort.setAttribute("aria-pressed", settings.managerStarredFirst ? "true" : "false");
    starSort.textContent = settings.managerStarredFirst ? "★" : "☆";

    const emptyStart = bibManager.querySelector(".ctca-bibliography-empty-start");
    if (emptyStart) emptyStart.hidden = managerRecords.length !== 0;

    if (!visible.length) {
      if (managerRecords.length) {
        const empty = document.createElement("div");
        empty.className = "ctca-manager-empty-list";
        empty.textContent = "No entries match this search or category.";
        list.appendChild(empty);
      }
      updateManagerSelectionControls([]);
      updateManagerCount(0);
      return;
    }

    for (const record of visible) {
      const draft = managerGetDraft(record);
      const row = document.createElement("div");
      row.className = "ctca-manager-row";
      row.dataset.managerRecordId = draft.id;
      row.setAttribute("role", "option");
      row.setAttribute("tabindex", "0");
      row.setAttribute("aria-selected", managerSelectedIds.has(draft.id) ? "true" : "false");
      row.draggable = draft.centralPreview !== true;
      row.classList.toggle("ctca-manager-row-central-preview", draft.centralPreview === true);
      row.classList.toggle("ctca-manager-row-active", managerSelectedIds.has(draft.id) && managerSelectedId === draft.id);
      row.classList.toggle("ctca-manager-row-selected", managerSelectedIds.has(draft.id));
      row.classList.toggle("ctca-manager-row-dirty", managerDirtyIds.has(draft.id));
      row.classList.toggle("ctca-manager-row-authors-hidden", !settings.managerColumnVisibility.authors);
      const isNew = managerNewEntryKeys.has(String(draft.key || "").toLowerCase());
      row.classList.toggle("ctca-manager-row-new", isNew);
      const title = stripOneBibDelimiter(draft.fields.title || "Untitled reference");
      const authors = managerAllAuthorsLabel(draft);
      const journal = stripOneBibDelimiter(
        draft.fields.journal || draft.fields.journaltitle || draft.fields.booktitle || ""
      );
      const volume = stripOneBibDelimiter(draft.fields.volume || "");
      const pages = stripOneBibDelimiter(draft.fields.pages || "");
      const year = stripOneBibDelimiter(draft.fields.year || "");
      const addedOn = managerFormatAddedOn(draft);
      const publicationParts = [];
      if (journal) publicationParts.push(managerEscapeHtml(journal));
      if (volume) publicationParts.push(`<strong>${managerEscapeHtml(volume)}</strong>`);
      if (pages) publicationParts.push(managerEscapeHtml(pages));
      const publicationBaseText = [journal, volume, pages].filter(Boolean).join(", ") || "Publication not specified";
      const publicationText = `${publicationBaseText}${!settings.managerColumnVisibility.year && year ? ` (${year})` : ""}`;
      const publicationBaseHtml = publicationParts.join(", ") || "Publication not specified";
      const openAlexDescriptor = globalThis.SmartCitationsOpenAlex.descriptor(draft, draft.id);
      // Keep citation-count lookup/cache warming active even though the list does not display it.
      if (openAlexDescriptor.identity) openAlexDescriptors.push(openAlexDescriptor);
      const publicationHtml = `<span class="ctca-manager-publication-text">${publicationBaseHtml}${!settings.managerColumnVisibility.year && year ? ` (${managerEscapeHtml(year)})` : ""}</span>`;
      const doiSyncLabel = managerDoiSyncLabel(draft);
      const specifiedUrl = managerSpecifiedHttpUrl(draft);
      const urlGlobe = specifiedUrl
        ? `<button type="button" class="ctca-manager-row-doi-sync${doiSyncLabel ? " ctca-manager-row-doi-synced" : ""}" title="${managerEscapeHtml(`${doiSyncLabel ? `${doiSyncLabel}. ` : ""}Open ${specifiedUrl}`)}" aria-label="${managerEscapeHtml(`Open URL for ${draft.key}`)}">${managerUrlGlobeIconHtml()}</button>`
        : `<span class="ctca-manager-row-doi-sync ctca-manager-row-doi-placeholder" aria-hidden="true">${managerUrlGlobeIconHtml()}</span>`;
      row.classList.toggle("ctca-manager-row-doi-synced", Boolean(doiSyncLabel));
      const cells = [];
      if (settings.managerColumnVisibility.title) cells.push(`<span class="ctca-manager-row-title ctca-manager-row-cell" title="${managerEscapeHtml(title)}">${managerLatexHtml(title)}</span>`);
      if (settings.managerColumnVisibility.year) cells.push(`<span class="ctca-manager-row-year ctca-manager-row-cell"${year ? ` title="${managerEscapeHtml(year)}"` : ""}>${managerEscapeHtml(year)}</span>`);
      if (settings.managerColumnVisibility.key) cells.push(`
        <span class="ctca-manager-row-meta ctca-manager-row-cell">
          <span class="ctca-manager-row-link-actions">
            ${urlGlobe}
            <span class="ctca-manager-row-pdf-slot"></span>
          </span>
          <span class="ctca-manager-row-key" title="${managerEscapeHtml(draft.key)}">${managerEscapeHtml(draft.key)}</span>
        </span>`);
      if (managerColumnVisible("addedOn")) cells.push(`<span class="ctca-manager-row-added ctca-manager-row-cell" title="${managerEscapeHtml(addedOn)}">${managerEscapeHtml(addedOn)}</span>`);
      const starred = managerIsStarred(draft);
      const condensedAuthor = managerAbbreviatedFirstAuthor(draft);
      row.innerHTML = `
        <button type="button" class="ctca-manager-row-star" title="${starred ? "Remove star" : "Star entry"}" aria-label="${starred ? "Remove star from" : "Star"} ${managerEscapeHtml(draft.key)}" aria-pressed="${starred ? "true" : "false"}" ${draft.centralPreview === true ? "disabled" : ""}>${starred ? "★" : "☆"}</button>
        <span class="ctca-manager-row-select"><input type="checkbox" class="ctca-manager-row-checkbox" aria-label="Select ${managerEscapeHtml(draft.key)}" ${managerSelectedIds.has(draft.id) ? "checked" : ""} ${draft.centralPreview === true ? "disabled" : ""}></span>
        ${cells.join("")}
        ${settings.managerColumnVisibility.authors ? `<span class="ctca-manager-row-author" title="${managerEscapeHtml(authors)}"><span class="ctca-manager-row-author-text">${managerAllAuthorsInlineHtml(draft)}</span><button type="button" class="ctca-manager-author-eye" title="Hide authors" aria-label="Hide authors">👁</button></span>` : ""}
        <span class="ctca-manager-row-publication" title="${managerEscapeHtml(publicationText)}">${settings.managerColumnVisibility.authors ? "" : `<button type="button" class="ctca-manager-condensed-author" title="Show full authors">${managerEscapeHtml(condensedAuthor)}</button>, `}${publicationHtml}</span>
      `;

      const activateRow = (event) => {
        const previousSelectedIds = new Set(managerSelectedIds);
        const previousActiveId = managerSelectedId;
        if (draft.centralPreview === true) {
          managerSelectedIds.clear();
          managerSelectedId = draft.id;
          managerLastSelectionAnchorId = "";
          updateManagerListSelectionState(visibleIds, previousSelectedIds, previousActiveId);
          renderManagerDetails();
          return;
        }
        const additive = event.ctrlKey || event.metaKey;
        if (event.shiftKey) {
          managerSelectRange(visibleIds, draft.id);
        } else if (additive) {
          if (managerSelectedIds.has(draft.id)) managerSelectedIds.delete(draft.id);
          else managerSelectedIds.add(draft.id);
          managerLastSelectionAnchorId = draft.id;
        } else {
          managerSelectedIds = new Set([draft.id]);
          managerLastSelectionAnchorId = draft.id;
        }
        managerSelectedId = draft.id;
        updateManagerListSelectionState(visibleIds, previousSelectedIds, previousActiveId);
        renderManagerDetails();
      };

      row.addEventListener("click", (event) => {
        if (event.target.closest(".ctca-manager-row-checkbox, .ctca-manager-row-star, .ctca-manager-row-doi-sync, .ctca-manager-row-pdf-action, .ctca-manager-author-eye, .ctca-manager-condensed-author")) return;
        activateRow(event);
      });
      row.addEventListener("contextmenu", (event) => {
        managerShowEntryContextMenu(event, draft).catch((error) => {
          managerHideEntryContextMenu();
          managerSetStatus(error?.message || String(error), true);
        });
      });
      row.addEventListener("keydown", (event) => {
        if (event.target.closest(".ctca-manager-row-doi-sync, .ctca-manager-row-pdf-action")) return;
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        activateRow(event);
      });
      row.querySelector(".ctca-manager-row-checkbox").addEventListener("click", (event) => {
        event.stopPropagation();
        if (draft.centralPreview === true) return;
        const previousSelectedIds = new Set(managerSelectedIds);
        const previousActiveId = managerSelectedId;
        if (event.target.checked) managerSelectedIds.add(draft.id);
        else managerSelectedIds.delete(draft.id);
        managerSelectedId = draft.id;
        managerLastSelectionAnchorId = draft.id;
        updateManagerListSelectionState(visibleIds, previousSelectedIds, previousActiveId);
        renderManagerDetails();
      });
      row.querySelector("button.ctca-manager-row-doi-sync")?.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        window.open(specifiedUrl, "_blank", "noopener,noreferrer");
      });
      row.querySelector(".ctca-manager-row-star").addEventListener("click", (event) => {
        event.stopPropagation();
        if (draft.centralPreview === true) return;
        draft.fields[CTCA_STARRED_FIELD] = managerIsStarred(draft) ? "false" : "true";
        if (!managerAddedOn(draft)) draft.fields[CTCA_ADDED_ON_FIELD] = new Date().toISOString();
        managerMarkDirty(draft, false);
        renderManagerCategories();
        renderManagerList();
      });
      row.querySelector(".ctca-manager-author-eye")?.addEventListener("click", (event) => {
        event.stopPropagation();
        managerSetColumnVisible("authors", false);
      });
      row.querySelector(".ctca-manager-condensed-author")?.addEventListener("click", (event) => {
        event.stopPropagation();
        managerSetColumnVisible("authors", true);
      });
      row.addEventListener("dragstart", (event) => {
        if (draft.centralPreview === true) {
          event.preventDefault();
          return;
        }
        if (!managerSelectedIds.has(draft.id)) {
          managerSelectedIds = new Set([draft.id]);
          managerSelectedId = draft.id;
          managerLastSelectionAnchorId = draft.id;
          renderManagerDetails();
        }
        const ids = [...managerSelectedIds];
        event.dataTransfer.effectAllowed = "copy";
        event.dataTransfer.setData("application/x-ctca-entry-ids", JSON.stringify(ids));
        event.dataTransfer.setData("text/plain", `${ids.length} bibliography entr${ids.length === 1 ? "y" : "ies"}`);
        row.classList.add("ctca-manager-row-dragging");
      });
      row.addEventListener("dragend", () => row.classList.remove("ctca-manager-row-dragging"));
      managerBindPdfDropTarget(row, draft);
      list.appendChild(row);
      if (draft.centralPreview !== true) managerLoadRowPdfAction(row, draft);
    }
    updateManagerSelectionControls(visibleIds);
    updateManagerCount(visible.length);
    syncManagerPdfAttachmentLoadingIndicators();
    globalThis.SmartCitationsOpenAlex.hydrateCitations(list, openAlexDescriptors).catch(() => {});
  }

  function managerInput(label, field, value, options = {}) {
    const multiline = Boolean(options.multiline);
    const className = options.className || "";
    const autocomplete = options.autocomplete
      ? ` data-manager-autocomplete="${managerEscapeHtml(options.autocomplete)}" autocomplete="off"`
      : "";
    const input = multiline
      ? `<textarea data-manager-field="${managerEscapeHtml(field)}" rows="${options.rows || 3}" class="${className}"${autocomplete}>${managerEscapeHtml(value)}</textarea>`
      : `<input data-manager-field="${managerEscapeHtml(field)}" type="${options.type || "text"}" value="${managerEscapeHtml(value)}" class="${className}"${autocomplete}>`;
    const control = options.autocomplete
      ? `<span class="ctca-field-completion-wrap">${input}<span class="ctca-field-completion" hidden role="listbox"></span></span>`
      : input;
    return `<label class="ctca-manager-field ${options.wide ? "ctca-manager-field-wide" : ""}"><span>${managerEscapeHtml(label)}</span>${control}</label>`;
  }

  function managerBindPdfDropTarget(target, draft) {
    if (!target || !draft || draft.centralPreview === true) return;
    for (const eventName of ["dragenter", "dragover"]) {
      target.addEventListener(eventName, (event) => {
        if (!globalThis.CollabTeXPdfImport.hasPdfFiles(event.dataTransfer)) return;
        event.preventDefault();
        event.stopPropagation();
        event.dataTransfer.dropEffect = "copy";
        target.classList.add("ctca-manager-pdf-drop-active");
      });
    }
    target.addEventListener("dragleave", (event) => {
      if (!target.contains(event.relatedTarget)) target.classList.remove("ctca-manager-pdf-drop-active");
    });
    target.addEventListener("drop", (event) => {
      const files = globalThis.CollabTeXPdfImport.filesFromDataTransfer(event.dataTransfer);
      if (!files.length) return;
      event.preventDefault();
      event.stopPropagation();
      target.classList.remove("ctca-manager-pdf-drop-active");
      managerSelectedId = draft.id;
      managerSelectedIds = new Set([draft.id]);
      managerOpenAddPdfDialog(draft, { files })
        .then(() => managerRenderPdfAttachmentList(draft))
        .catch((error) => managerSetStatus(error?.message || String(error), true));
    });
  }

  function managerAvailableFields(draft) {
    const existing = new Set(Object.keys(draft.fields || {}).filter((field) => !CTCA_INTERNAL_FIELDS.has(field)));
    const fixed = new Set([
      "title", "author", "editor", "journal", "journaltitle", "booktitle", "year", "volume", "pages", "doi", "url",
      "abstract", "keywords", "publisher", "institution", "annotation", "note"
    ]);
    return AVAILABLE_BIB_FIELDS.filter((field) => !existing.has(field) && !fixed.has(field) && !CTCA_INTERNAL_FIELDS.has(field));
  }

  function managerPaperUrlFromDraft(draft) {
    const doi = normalizeDoiInput(draft?.fields?.doi || "");
    if (doi) return `https://doi.org/${encodeURI(doi)}`;
    const url = String(draft?.fields?.url || "").trim();
    return /^https?:\/\//i.test(url) ? url : "";
  }

  function managerSpecifiedHttpUrl(draft) {
    const value = stripOneBibDelimiter(draft?.fields?.url || "");
    if (!value) return "";
    try {
      const url = new URL(value);
      return /^https?:$/.test(url.protocol) ? url.href : "";
    } catch (_error) {
      return "";
    }
  }

  function managerFormattedCitationParts(draft) {
    const authors = window.CollabTeXBibTeX.splitAuthorsRaw(draft?.fields?.author || "");
    const authorText = authors.slice(0, 3).map((author) => {
      const formatted = window.CollabTeXBibTeX.formatAuthorName(author);
      const family = window.CollabTeXBibTeX.authorFamilyName(author);
      const given = formatted.slice(0, Math.max(0, formatted.lastIndexOf(family))).trim();
      const initial = window.CollabTeXBibTeX.latexToText(given).match(/\p{L}/u)?.[0] || "";
      return `${initial ? `${initial}. ` : ""}${family || formatted}`.trim();
    }).filter(Boolean).join(", ") + (authors.length > 3 ? " et al." : "");
    const fields = draft?.fields || {};
    const text = (value) => window.CollabTeXBibTeX.latexToText(stripOneBibDelimiter(value || ""));
    return {
      authors: authorText || "Unknown author",
      title: text(fields.title) || "Untitled",
      journal: text(fields.journal || fields.journaltitle || fields.booktitle),
      number: text(fields.volume || fields.number),
      pages: text(fields.pages),
      year: text(fields.year)
    };
  }

  async function managerCopyTextWithFormatting(plainText, htmlText = "") {
    if (htmlText && navigator.clipboard?.write && globalThis.ClipboardItem) {
      try {
        await navigator.clipboard.write([new ClipboardItem({
          "text/plain": new Blob([plainText], { type: "text/plain" }),
          "text/html": new Blob([htmlText], { type: "text/html" })
        })]);
        return;
      } catch (_error) {}
    }
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(plainText);
      return;
    }
    const textarea = document.createElement("textarea");
    textarea.value = plainText;
    textarea.style.position = "fixed";
    textarea.style.opacity = "0";
    document.body.appendChild(textarea);
    textarea.select();
    document.execCommand("copy");
    textarea.remove();
  }

  function managerFormattedCitationContent(draft) {
    const parts = managerFormattedCitationParts(draft);
    const journalPlain = parts.journal ? `, ${parts.journal}` : "";
    const numberPlain = parts.number ? ` ${parts.number}` : "";
    const pagesPlain = parts.pages ? `, ${parts.pages}` : "";
    const yearPlain = parts.year ? ` (${parts.year})` : "";
    const plain = `${parts.authors}, ${parts.title}${journalPlain}${numberPlain}${pagesPlain}${yearPlain}`;
    const journalHtml = parts.journal ? `, <i>${managerEscapeHtml(parts.journal)}</i>` : "";
    const numberHtml = parts.number ? ` <b>${managerEscapeHtml(parts.number)}</b>` : "";
    const pagesHtml = parts.pages ? `, ${managerEscapeHtml(parts.pages)}` : "";
    const yearHtml = parts.year ? ` (${managerEscapeHtml(parts.year)})` : "";
    const html = `${managerEscapeHtml(parts.authors)}, ${managerEscapeHtml(parts.title)}${journalHtml}${numberHtml}${pagesHtml}${yearHtml}`;
    return { plain, html };
  }

  async function managerCopyFormattedCitation(draft) {
    const citation = managerFormattedCitationContent(draft);
    await managerCopyTextWithFormatting(citation.plain, citation.html);
  }

  function managerDownloadTextFile(text, fileName, type = "text/plain;charset=utf-8") {
    const url = URL.createObjectURL(new Blob([text], { type }));
    const link = document.createElement("a");
    link.href = url;
    link.download = fileName;
    link.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function managerHideEntryContextMenu() {
    const menu = bibManager?.querySelector(".ctca-entry-context-menu");
    if (!menu) return;
    menu.hidden = true;
    menu.replaceChildren();
    delete menu.dataset.entryId;
    delete menu.dataset.pointerEntered;
  }

  async function managerShowEntryContextMenu(event, draft) {
    event.preventDefault();
    event.stopPropagation();
    managerHideCategoryContextMenu();
    const preserveMultiple = managerSelectedIds.size > 1 && managerSelectedIds.has(draft.id);
    if (!preserveMultiple) managerSelectedIds = new Set([draft.id]);
    managerSelectedId = draft.id;
    managerLastSelectionAnchorId = draft.id;
    renderManagerList();
    renderManagerDetails();

    const menu = bibManager.querySelector(".ctca-entry-context-menu");
    menu.dataset.entryId = draft.id;
    delete menu.dataset.pointerEntered;
    menu.onpointerenter = () => { menu.dataset.pointerEntered = "true"; };
    menu.onpointerleave = () => {
      if (menu.dataset.pointerEntered === "true") managerHideEntryContextMenu();
    };
    menu.innerHTML = `<button type="button" disabled>Loading actions…</button>`;
    menu.style.left = `${Math.max(8, Math.min(event.clientX, window.innerWidth - 265))}px`;
    menu.style.top = `${Math.max(8, Math.min(event.clientY, window.innerHeight - 390))}px`;
    menu.hidden = false;

    const contextDrafts = [...managerSelectedIds].map((id) => managerDrafts.get(id)).filter(Boolean);
    const multiple = contextDrafts.length > 1;
    const attachments = multiple
      ? []
      : await globalThis.CollabTeXAttachmentStore.list({ key: draft.key, fields: draft.fields });
    if (menu.dataset.entryId !== draft.id) return;
    const url = managerSpecifiedHttpUrl(draft);
    const actions = multiple ? [
      { action: "update-dois", label: "Update from DOIs" },
      { action: "copy-keys", label: "Copy citation keys" },
      { action: "copy-formatted-many", label: "Copy as formatted citations" },
      { action: "star-many", label: "Star" },
      { action: "download-bib-many", label: "Download BibTeX entries" },
      { action: "delete-many", label: "Delete", danger: true }
    ] : [
      ...(url ? [{ action: "visit-url", label: "Visit URL" }] : []),
      ...(normalizeDoiInput(draft.fields?.doi || "") ? [{ action: "update-doi", label: "Update entry from DOI" }] : []),
      ...(!attachments.length ? [{ action: "get-pdf-from-web", label: "Download attachment from web" }] : []),
      ...(attachments.length ? [{ action: "open-pdf", label: "Open PDF", attachmentId: attachments[0].id }] : []),
      { action: "star", label: managerIsStarred(draft) ? "Unstar" : "Star" },
      { action: "copy-key", label: "Copy citation key" },
      { action: "copy-formatted", label: "Copy as formatted citation" },
      { action: "download-bib", label: "Download BibTeX entry" },
      { action: "delete", label: "Delete", danger: true }
    ];
    menu.innerHTML = actions.map((item) =>
      `<button type="button" role="menuitem" data-entry-context-action="${item.action}"${item.attachmentId ? ` data-attachment-id="${managerEscapeHtml(item.attachmentId)}"` : ""}${item.danger ? ` class="ctca-entry-context-danger"` : ""}>${managerEscapeHtml(item.label)}</button>`
    ).join("");
    menu.onclick = async (clickEvent) => {
      const button = clickEvent.target.closest("[data-entry-context-action]");
      if (!button) return;
      const action = button.dataset.entryContextAction;
      managerHideEntryContextMenu();
      try {
        if (action === "update-dois") {
          await managerRunDoiBatch(contextDrafts, "selected");
        } else if (action === "copy-keys") {
          await managerCopyTextWithFormatting(contextDrafts.map((item) => item.key).join("\n"));
          managerSetStatus(`Copied ${contextDrafts.length} citation keys.`);
        } else if (action === "copy-formatted-many") {
          const citations = contextDrafts.map(managerFormattedCitationContent);
          await managerCopyTextWithFormatting(
            citations.map((citation) => citation.plain).join("\n"),
            citations.map((citation) => `<div>${citation.html}</div>`).join("")
          );
          managerSetStatus(`Copied ${contextDrafts.length} formatted citations.`);
        } else if (action === "star-many") {
          for (const item of contextDrafts) {
            item.fields[CTCA_STARRED_FIELD] = "true";
            managerMarkDirty(item);
          }
          renderManagerCategories();
          renderManagerList();
          renderManagerDetails();
        } else if (action === "download-bib-many") {
          managerDownloadTextFile(
            `${contextDrafts.map((item) => serializeManagerDraft(item)).join("\n\n")}\n`,
            "selected-bibliography-entries.bib",
            "application/x-bibtex;charset=utf-8"
          );
        } else if (action === "delete-many") {
          await managerRemoveSelectedEntries();
        } else if (action === "visit-url") window.open(url, "_blank", "noopener,noreferrer");
        else if (action === "star") {
          draft.fields[CTCA_STARRED_FIELD] = managerIsStarred(draft) ? "" : "true";
          managerMarkDirty(draft);
          renderManagerCategories();
          renderManagerList();
          renderManagerDetails();
        } else if (action === "copy-key") {
          await managerCopyTextWithFormatting(draft.key);
          managerSetStatus(`Copied ${draft.key}.`);
        } else if (action === "copy-formatted") {
          await managerCopyFormattedCitation(draft);
          managerSetStatus(`Copied formatted citation for ${draft.key}.`);
        } else if (action === "download-bib") {
          managerDownloadTextFile(`${serializeManagerDraft(draft)}\n`, `${draft.key}.bib`, "application/x-bibtex;charset=utf-8");
        } else {
          const syntheticButton = document.createElement("button");
          syntheticButton.dataset.managerAction = action === "delete" ? "remove-entry" : action;
          if (button.dataset.attachmentId) syntheticButton.dataset.attachmentId = button.dataset.attachmentId;
          await managerDetailActionClicked({ target: syntheticButton, preventDefault() {} });
        }
      } catch (error) {
        managerSetStatus(error?.message || String(error), true);
      }
    };
    menu.querySelector("button")?.focus();
  }

  function managerUrlGlobeIconHtml() {
    return `<svg class="ctca-manager-row-globe-icon" viewBox="0 0 16 16" aria-hidden="true" focusable="false"><circle cx="8" cy="8" r="6.25" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M1.75 8h12.5M8 1.75C6.15 3.45 5.1 5.55 5.1 8S6.15 12.55 8 14.25M8 1.75c1.85 1.7 2.9 3.8 2.9 6.25S9.85 12.55 8 14.25" fill="none" stroke="currentColor" stroke-linecap="round" stroke-width="1.25"/></svg>`;
  }

  function managerPaperclipIconHtml() {
    return `<svg class="ctca-manager-row-pdf-icon" viewBox="0 0 16 16" aria-hidden="true" focusable="false"><path d="M5.2 8.25 9.45 4a2.15 2.15 0 0 1 3.05 3.05l-5.4 5.4a3.25 3.25 0 0 1-4.6-4.6l5.1-5.1" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="1.45"/></svg>`;
  }

  function managerDownloadIconHtml() {
    return `<svg class="ctca-manager-row-pdf-icon" viewBox="0 0 16 16" aria-hidden="true" focusable="false"><path d="M8 1.75v8.1m-3-3 3 3 3-3M2.25 13.5h11.5" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5"/></svg>`;
  }

  function managerUpdateRowPdfAction(row, draft, attachments) {
    if (!row?.isConnected || row.dataset.managerRecordId !== draft.id) return;
    delete row.dataset.pdfActionRequest;
    const slot = row.querySelector(".ctca-manager-row-pdf-slot");
    if (!slot) return;
    const attachment = attachments[0];
    const sourceUrl = managerSpecifiedHttpUrl(draft);
    if (!attachment && !sourceUrl) {
      slot.replaceChildren();
      return;
    }
    const button = document.createElement("button");
    button.type = "button";
    button.className = "ctca-manager-row-pdf-action";
    if (attachment) {
      button.title = `Open attached PDF: ${attachment.name}`;
      button.setAttribute("aria-label", `Open first PDF attached to ${draft.key}`);
      button.innerHTML = managerPaperclipIconHtml();
      button.addEventListener("click", async (event) => {
        event.preventDefault();
        event.stopPropagation();
        await managerOpenPdfTab(draft, attachment);
      });
    } else {
      button.title = `Get PDF from ${sourceUrl}`;
      button.setAttribute("aria-label", `Get PDF from the web for ${draft.key}`);
      button.innerHTML = managerDownloadIconHtml();
      button.addEventListener("click", async (event) => {
        event.preventDefault();
        event.stopPropagation();
        await managerOpenAddPdfDialog(draft, { getFromWeb: true });
      });
    }
    slot.replaceChildren(button);
  }

  async function managerLoadRowPdfAction(row, draft) {
    const request = `${Date.now()}-${Math.random()}`;
    row.dataset.pdfActionRequest = request;
    try {
      const attachments = await globalThis.CollabTeXAttachmentStore.list({ key: draft.key, fields: draft.fields });
      if (row.dataset.pdfActionRequest !== request) return;
      managerUpdateRowPdfAction(row, draft, attachments);
    } catch (_error) {
      if (row.dataset.pdfActionRequest !== request) return;
      delete row.dataset.pdfActionRequest;
      row.querySelector(".ctca-manager-row-pdf-slot")?.replaceChildren();
    }
  }

  function managerAllKnownTags(exceptId = "") {
    const seen = new Map();
    for (const draft of managerDrafts.values()) {
      if (draft.id === exceptId) continue;
      for (const tag of globalThis.CollabTeXSearchTools.splitTags(draft.fields?.[CTCA_TAGS_FIELD] || "")) {
        const key = tag.toLocaleLowerCase();
        if (!seen.has(key)) seen.set(key, tag);
      }
    }
    return [...seen.values()].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));
  }

  function managerAllKnownJournals(exceptId = "") {
    const seen = new Map();
    for (const item of managerDrafts.values()) {
      if (item.id === exceptId) continue;
      for (const field of ["journal", "journaltitle", "booktitle"]) {
        const value = stripOneBibDelimiter(item?.fields?.[field] || "").replace(/\s+/g, " ").trim();
        const key = value.toLocaleLowerCase();
        if (!value || seen.has(key)) continue;
        seen.set(key, {
          value,
          label: window.CollabTeXBibTeX.latexToText(value)
        });
      }
    }
    return [...seen.values()].sort((left, right) =>
      left.label.localeCompare(right.label, undefined, { sensitivity: "base" })
    );
  }

  function managerAllKnownKeywords(exceptId = "") {
    const seen = new Map();
    for (const item of managerDrafts.values()) {
      if (item.id === exceptId) continue;
      for (const field of ["keywords", "keyword"]) {
        const fieldValue = stripOneBibDelimiter(item?.fields?.[field] || "");
        for (const keyword of fieldValue.split(/[,;\n]+/)) {
          const value = keyword.replace(/\s+/g, " ").trim();
          const key = value.toLocaleLowerCase();
          if (!value || seen.has(key)) continue;
          seen.set(key, {
            value,
            label: window.CollabTeXBibTeX.latexToText(value)
          });
        }
      }
    }
    return [...seen.values()].sort((left, right) =>
      left.label.localeCompare(right.label, undefined, { sensitivity: "base" })
    );
  }

  function managerKeywordCompletionToken(input) {
    const value = String(input?.value || "");
    const caret = Math.max(0, Math.min(value.length, input?.selectionStart ?? value.length));
    const before = value.slice(0, caret);
    const separator = Math.max(before.lastIndexOf(","), before.lastIndexOf(";"), before.lastIndexOf("\n"));
    const nextRelative = value.slice(caret).search(/[,;\n]/);
    const rawStart = separator + 1;
    const rawEnd = nextRelative < 0 ? value.length : caret + nextRelative;
    const segment = value.slice(rawStart, rawEnd);
    const leading = segment.match(/^\s*/)?.[0].length || 0;
    const trailing = segment.match(/\s*$/)?.[0].length || 0;
    return {
      start: rawStart + leading,
      end: Math.max(rawStart + leading, rawEnd - trailing),
      value: segment.trim()
    };
  }

  function managerSetFieldCompletionOptions(container, suggestions) {
    container.replaceChildren(...suggestions.map((candidate, index) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "ctca-completion-option";
      button.dataset.completionValue = candidate.value;
      button.setAttribute("role", "option");
      const name = document.createElement("span");
      name.className = "ctca-completion-option-name";
      name.textContent = candidate.label;
      button.appendChild(name);
      if (index === 0) {
        const hint = document.createElement("span");
        hint.className = "ctca-completion-option-hint";
        hint.textContent = "\u2192";
        hint.title = "Press Right Arrow to complete";
        button.appendChild(hint);
      }
      return button;
    }));
    container.hidden = suggestions.length === 0;
  }

  function managerRenderJournalSuggestions(draft, input) {
    const container = input.closest(".ctca-field-completion-wrap")?.querySelector(".ctca-field-completion");
    if (!container) return;
    const queryText = input.value.replace(/\s+/g, " ").trim().toLocaleLowerCase();
    const suggestions = managerAllKnownJournals(draft.id)
      .filter((candidate) => candidate.value.toLocaleLowerCase() !== queryText)
      .filter((candidate) =>
        !queryText ||
        candidate.value.toLocaleLowerCase().includes(queryText) ||
        candidate.label.toLocaleLowerCase().includes(queryText)
      )
      .sort((left, right) => {
        const leftStarts = left.label.toLocaleLowerCase().startsWith(queryText) ? 0 : 1;
        const rightStarts = right.label.toLocaleLowerCase().startsWith(queryText) ? 0 : 1;
        return leftStarts - rightStarts;
      })
      .slice(0, 8);
    managerSetFieldCompletionOptions(container, suggestions);
    input.setAttribute("aria-expanded", String(suggestions.length > 0));
  }

  function managerRenderKeywordSuggestions(draft, input) {
    const container = input.closest(".ctca-field-completion-wrap")?.querySelector(".ctca-field-completion");
    if (!container) return;
    const token = managerKeywordCompletionToken(input);
    const queryText = token.value.replace(/\s+/g, " ").trim().toLocaleLowerCase();
    const current = new Set(
      String(input.value || "")
        .split(/[,;\n]+/)
        .map((keyword) => keyword.replace(/\s+/g, " ").trim().toLocaleLowerCase())
        .filter(Boolean)
    );
    current.delete(queryText);
    const suggestions = managerAllKnownKeywords(draft.id)
      .filter((candidate) => !current.has(candidate.value.toLocaleLowerCase()))
      .filter((candidate) => candidate.value.toLocaleLowerCase() !== queryText)
      .filter((candidate) =>
        !queryText ||
        candidate.value.toLocaleLowerCase().includes(queryText) ||
        candidate.label.toLocaleLowerCase().includes(queryText)
      )
      .sort((left, right) => {
        const leftStarts = left.label.toLocaleLowerCase().startsWith(queryText) ? 0 : 1;
        const rightStarts = right.label.toLocaleLowerCase().startsWith(queryText) ? 0 : 1;
        return leftStarts - rightStarts;
      })
      .slice(0, 8);
    managerSetFieldCompletionOptions(container, suggestions);
    input.setAttribute("aria-expanded", String(suggestions.length > 0));
  }

  function managerAcceptJournalSuggestion(input, value) {
    if (!input || !value) return false;
    input.value = value;
    const container = input.closest(".ctca-field-completion-wrap")?.querySelector(".ctca-field-completion");
    if (container) container.hidden = true;
    input.setAttribute("aria-expanded", "false");
    input.dispatchEvent(new Event("change", { bubbles: true }));
    return true;
  }

  function managerAcceptKeywordSuggestion(input, value) {
    if (!input || !value) return false;
    const token = managerKeywordCompletionToken(input);
    input.setRangeText(value, token.start, token.end, "end");
    const container = input.closest(".ctca-field-completion-wrap")?.querySelector(".ctca-field-completion");
    if (container) container.hidden = true;
    input.setAttribute("aria-expanded", "false");
    input.dispatchEvent(new Event("change", { bubbles: true }));
    return true;
  }

  function managerFieldAutocompleteKeydown(event) {
    const input = event.target.closest("[data-manager-autocomplete]");
    if (!input) return;
    const container = input.closest(".ctca-field-completion-wrap")?.querySelector(".ctca-field-completion");
    const token = input.dataset.managerAutocomplete === "keywords"
      ? managerKeywordCompletionToken(input)
      : { end: input.value.length };
    if (
      event.key === "ArrowRight" &&
      !container?.hidden &&
      input.selectionStart === input.selectionEnd &&
      input.selectionStart === token.end
    ) {
      const first = container.querySelector(".ctca-completion-option");
      const accepted = input.dataset.managerAutocomplete === "keywords"
        ? managerAcceptKeywordSuggestion(input, first?.dataset.completionValue)
        : managerAcceptJournalSuggestion(input, first?.dataset.completionValue);
      if (first && accepted) {
        event.preventDefault();
      }
    } else if (event.key === "Escape" && container && !container.hidden) {
      event.preventDefault();
      container.hidden = true;
      input.setAttribute("aria-expanded", "false");
    }
  }

  function managerFieldAutocompleteMouseDown(event) {
    const option = event.target.closest(".ctca-field-completion .ctca-completion-option");
    if (!option) return;
    const input = option.closest(".ctca-field-completion-wrap")?.querySelector("[data-manager-autocomplete]");
    event.preventDefault();
    event.stopPropagation();
    const accepted = input?.dataset.managerAutocomplete === "keywords"
      ? managerAcceptKeywordSuggestion(input, option.dataset.completionValue)
      : managerAcceptJournalSuggestion(input, option.dataset.completionValue);
    if (accepted) input.focus();
  }

  function managerTagEditorHtml(draft) {
    const tags = globalThis.CollabTeXSearchTools.splitTags(draft.fields?.[CTCA_TAGS_FIELD] || "");
    return `
      <div class="ctca-manager-tags">
        <h3>Tags</h3>
        <div class="ctca-tag-editor">
          <div class="ctca-tag-chip-list">
            ${tags.map((tag) => `<span class="ctca-tag-chip"><span>${managerEscapeHtml(tag)}</span><button type="button" data-manager-action="remove-tag" data-tag="${managerEscapeHtml(tag)}" aria-label="Remove tag ${managerEscapeHtml(tag)}">×</button></span>`).join("")}
            <span class="ctca-tag-input-wrap">
              <input class="ctca-tag-input" placeholder="Add tag…" autocomplete="off" aria-label="Add tag">
              <span class="ctca-tag-suggestions" hidden role="listbox"></span>
            </span>
          </div>
          <div class="ctca-tag-help">Press Enter or comma to add. Existing tags are suggested automatically.</div>
        </div>
      </div>`;
  }

  function managerRenderTagSuggestions(draft, input) {
    const container = input.closest(".ctca-tag-input-wrap")?.querySelector(".ctca-tag-suggestions");
    if (!container) return;
    const queryText = input.value.trim().toLocaleLowerCase();
    const current = new Set(globalThis.CollabTeXSearchTools.splitTags(draft.fields?.[CTCA_TAGS_FIELD] || "").map((tag) => tag.toLocaleLowerCase()));
    const suggestions = managerAllKnownTags(draft.id)
      .filter((tag) => !current.has(tag.toLocaleLowerCase()))
      .filter((tag) => !queryText || tag.toLocaleLowerCase().includes(queryText))
      .slice(0, 10);
    container.innerHTML = suggestions.map((tag) => `<button type="button" data-manager-action="add-tag" data-tag="${managerEscapeHtml(tag)}" role="option">${managerEscapeHtml(tag)}</button>`).join("");
    container.hidden = suggestions.length === 0;
  }

  function managerAddTag(draft, tagValue) {
    const tag = String(tagValue || "").trim().replace(/^[,;]+|[,;]+$/g, "").replace(/\s+/g, " ");
    if (!tag) return false;
    const tags = globalThis.CollabTeXSearchTools.splitTags(draft.fields?.[CTCA_TAGS_FIELD] || "");
    if (tags.some((item) => item.toLocaleLowerCase() === tag.toLocaleLowerCase())) return false;
    draft.fields[CTCA_TAGS_FIELD] = [...tags, tag].join(", ");
    managerMarkDirty(draft);
    return true;
  }

  function managerTagInputKeydown(event) {
    const input = event.target.closest(".ctca-tag-input");
    if (!input) return;
    const draft = managerDrafts.get(managerSelectedId);
    if (!draft) return;
    if (event.key === "Enter" || event.key === ",") {
      event.preventDefault();
      if (managerAddTag(draft, input.value)) {
        renderManagerDetails();
        requestAnimationFrame(() => bibManager.querySelector(".ctca-tag-input")?.focus());
      }
    } else if (event.key === "Backspace" && !input.value) {
      const tags = globalThis.CollabTeXSearchTools.splitTags(draft.fields?.[CTCA_TAGS_FIELD] || "");
      if (tags.length) {
        event.preventDefault();
        draft.fields[CTCA_TAGS_FIELD] = tags.slice(0, -1).join(", ");
        managerMarkDirty(draft);
        renderManagerDetails();
        requestAnimationFrame(() => bibManager.querySelector(".ctca-tag-input")?.focus());
      }
    } else if (event.key === "Escape") {
      input.closest(".ctca-tag-input-wrap")?.querySelector(".ctca-tag-suggestions")?.setAttribute("hidden", "");
    }
  }

  function managerUpdateDetailsVisibility() {
    const activeDraft = managerDrafts.get(managerSelectedId);
    const hasActiveSelection = managerSelectedIds.size > 0 || activeDraft?.centralPreview === true;
    const hasAuthorImpact = globalThis.SmartCitationsOpenAlex.isAuthorCategory(managerSelectedCategoryId);
    const noSelectionDetailsHidden = !hasActiveSelection && (!hasAuthorImpact || settings.managerAuthorImpactCollapsed);
    const collapsed = managerDetailsCollapsedManually || noSelectionDetailsHidden;
    bibManager.classList.toggle("ctca-details-collapsed", collapsed);
    bibManager.classList.toggle("ctca-details-no-selection", noSelectionDetailsHidden);
    const collapseButton = bibManager.querySelector(".ctca-manager-collapse-details");
    if (collapseButton) {
      collapseButton.title = collapsed ? "Expand detail pane" : "Collapse detail pane";
      collapseButton.setAttribute("aria-expanded", collapsed ? "false" : "true");
    }
  }

  function renderManagerDetails() {
    managerUpdateDetailsVisibility();
    const container = bibManager.querySelector(".ctca-manager-details");
    const activeDraft = managerDrafts.get(managerSelectedId);
    const draft = managerSelectedIds.size || activeDraft?.centralPreview === true ? activeDraft : null;
    managerRenderOpenAlexAuthorImpactSlot();
    if (!draft) {
      container.innerHTML = `<div class="ctca-manager-empty-details">Select a bibliography entry.</div>`;
      return;
    }

    const fields = draft.fields;
    const journalField = fields.journal !== undefined
      ? "journal"
      : fields.journaltitle !== undefined
        ? "journaltitle"
        : fields.booktitle !== undefined
          ? "booktitle"
          : (["inproceedings", "incollection", "conference"].includes(draft.type) ? "booktitle" : "journal");
    const journalLabel = journalField === "booktitle" ? "Book / proceedings title" : "Journal";
    const core = new Set([
      "title", "author", "editor", "journal", "journaltitle", "booktitle", "year", "volume", "pages", "doi", "url",
      "abstract", "keywords", "publisher", "institution", "annotation", "note"
    ]);
    const extraFields = Object.keys(fields).filter((name) => !core.has(name) && !CTCA_INTERNAL_FIELDS.has(name)).sort();
    const available = managerAvailableFields(draft);
    const doiSyncLabel = managerDoiSyncLabel(draft);
    const detailTitle = stripOneBibDelimiter(fields.title || "Untitled paper");
    const detailAuthors = managerAllAuthorsLabel(draft);

    container.innerHTML = `
      <div class="ctca-manager-detail-head">
        <div class="ctca-manager-detail-heading-text">
          <div class="ctca-manager-detail-title" data-manager-inline-field="title" role="button" tabindex="0" title="Click to edit title">${managerLatexHtml(detailTitle)}</div>
          <div class="ctca-manager-detail-authors" data-manager-inline-field="author" role="button" tabindex="0" title="Click to edit authors">${managerAllAuthorsHtml(draft)}</div>
          ${doiSyncLabel ? `<div class="ctca-manager-detail-doi-sync" title="${managerEscapeHtml(doiSyncLabel)}">🌐✓ ${managerEscapeHtml(doiSyncLabel)}</div>` : ""}
        </div>
        <div class="ctca-manager-detail-actions" data-detail-entry-id="${managerEscapeHtml(draft.id)}"></div>
      </div>
      <div class="ctca-manager-form-grid">
        <label class="ctca-manager-field"><span>Entry type</span>
          <select data-manager-property="type">
            ${BIB_ENTRY_TYPES.map((type) => `<option value="${type}" ${draft.type === type ? "selected" : ""}>${type}</option>`).join("")}
          </select>
        </label>
        <label class="ctca-manager-field"><span>Citation key</span><input data-manager-property="key" value="${managerEscapeHtml(draft.key)}"></label>
        ${managerInput("Editors", "editor", fields.editor || "", { multiline: true, rows: 2, wide: true })}
        ${managerInput(journalLabel, journalField, fields[journalField] || "", { wide: true, autocomplete: "journal" })}
        ${managerInput("Year", "year", fields.year || "")}
        ${managerInput("Volume", "volume", fields.volume || "")}
        ${managerInput("Pages / article number", "pages", fields.pages || "")}
        <label class="ctca-manager-field ctca-manager-field-wide"><span>DOI</span>
          <div class="ctca-manager-doi-row">
            <input data-manager-field="doi" value="${managerEscapeHtml(fields.doi || "")}">
            <button type="button" data-manager-action="update-doi" title="Update this entry from DOI metadata" aria-label="Update from DOI">🌐</button>
          </div>
        </label>
        <label class="ctca-manager-field ctca-manager-field-wide"><span>URL</span>
          <div class="ctca-manager-url-row">
            <input data-manager-field="url" type="url" value="${managerEscapeHtml(fields.url || "")}">
            <button type="button" data-manager-action="open-url" title="Open URL" aria-label="Open URL">↗</button>
          </div>
        </label>
        ${managerInput("Abstract", "abstract", normalizeAbstractText(fields.abstract || ""), { multiline: true, rows: 8, wide: true })}
        ${managerInput("Keywords", "keywords", fields.keywords || "", { multiline: true, rows: 3, wide: true, autocomplete: "keywords" })}
        ${managerInput("Publisher", "publisher", fields.publisher || "", { wide: true })}
        ${managerInput("Institution", "institution", fields.institution || "", { wide: true })}
        ${managerInput("BibTeX note", "note", fields.note || "", { multiline: true, rows: 3, wide: true })}
        ${managerInput("Custom note", "annotation", fields.annotation || "", { multiline: true, rows: 4, wide: true })}
      </div>
      ${managerTagEditorHtml(draft)}
      <div class="ctca-manager-entry-categories">
        <h3>Categories</h3>
        <div class="ctca-manager-entry-category-list">
          ${managerEntryCategoryIds(draft.id).map((categoryId) => {
            const path = managerCategoryPath(categoryId);
            return `<span class="ctca-manager-entry-category-chip" title="${managerEscapeHtml(path)}"><span>${managerEscapeHtml(path)}</span><button type="button" data-manager-action="remove-category-membership" data-category-id="${managerEscapeHtml(categoryId)}" title="Remove from this category" aria-label="Remove ${managerEscapeHtml(path)}">🗑</button></span>`;
          }).join("") || `<span class="ctca-manager-no-category">Uncategorized. Drag the selected entry onto a category to assign it.</span>`}
        </div>
      </div>
      <section class="ctca-manager-pdf-attachments" data-entry-id="${managerEscapeHtml(draft.id)}">
        <div class="ctca-manager-pdf-attachments-head"><h3>PDF attachments</h3><button type="button" class="ctca-manager-add-pdf" data-manager-action="add-pdf" ${managerPdfAttachmentLoadingIds.has(draft.id) ? "disabled" : ""}>+ Attach PDF</button></div>
        <div class="ctca-manager-pdf-list"><div class="ctca-manager-no-pdf">Loading attachments…</div></div>
        <div class="ctca-manager-pdf-loading" data-entry-id="${managerEscapeHtml(draft.id)}" role="status" aria-label="Loading PDF attachments" hidden><span class="ctca-manager-pdf-loading-spinner" aria-hidden="true"></span></div>
      </section>
      <div class="ctca-manager-extra-fields">
        <h3>Additional BibTeX fields</h3>
        <div class="ctca-manager-extra-list">
          ${extraFields.map((field) => `
            <label class="ctca-manager-extra-field">
              <span>${managerEscapeHtml(field)}</span>
              <textarea data-manager-field="${managerEscapeHtml(field)}" rows="2">${managerEscapeHtml(fields[field] || "")}</textarea>
              <button type="button" data-manager-action="remove-field" data-field="${managerEscapeHtml(field)}" title="Remove field">×</button>
            </label>
          `).join("") || `<div class="ctca-manager-no-extra">No additional fields.</div>`}
        </div>
        <div class="ctca-manager-add-field-row">
          <select class="ctca-manager-add-field-select" ${available.length ? "" : "disabled"}>
            ${available.map((field) => `<option value="${managerEscapeHtml(field)}">${managerEscapeHtml(field)}</option>`).join("")}
          </select>
          <button type="button" data-manager-action="add-field" ${available.length ? "" : "disabled"}>+ Add field</button>
        </div>
      </div>
      <div class="ctca-manager-unsaved-note">Edits and removals are written by <strong>Update Bib</strong>.</div>
      <div class="ctca-manager-remove-entry-row">
        <button type="button" class="ctca-manager-remove-entry" data-manager-action="remove-entry">Remove entry</button>
      </div>
    `;
    if (draft.centralPreview === true) {
      container.classList.add("ctca-manager-central-preview-details");
      container.querySelectorAll("input, textarea, select, button").forEach((control) => {
        control.disabled = true;
      });
      container.querySelectorAll("[data-manager-inline-field]").forEach((element) => {
        element.removeAttribute("data-manager-inline-field");
        element.removeAttribute("role");
        element.removeAttribute("tabindex");
        element.title = "Central database preview";
      });
      container.querySelector(".ctca-manager-detail-actions")?.replaceChildren();
      const note = container.querySelector(".ctca-manager-unsaved-note");
      if (note) note.textContent = "New or modified entry from the central database. Use Update Bib to choose whether to incorporate it.";
      container.querySelector(".ctca-manager-entry-categories")?.setAttribute("hidden", "");
      container.querySelector(".ctca-manager-pdf-attachments")?.setAttribute("hidden", "");
      container.querySelector(".ctca-manager-extra-fields")?.setAttribute("hidden", "");
      container.querySelector(".ctca-manager-remove-entry-row")?.setAttribute("hidden", "");
      return;
    }
    container.classList.remove("ctca-manager-central-preview-details");
    managerBindPdfDropTarget(container, draft);
    managerRenderPdfAttachmentList(draft).catch(() => {});
    syncManagerPdfAttachmentLoadingIndicators();
    if (managerWorkspaceTab !== "bibliography") {
      const target = bibManager.querySelector(".ctca-pdf-entry-details");
      if (target) {
        target.innerHTML = container.innerHTML;
      }
    }
  }

  function managerRenderOpenAlexAuthorImpactSlot() {
    const column = bibManager.querySelector(".ctca-manager-details-column");
    const slot = column.querySelector(".ctca-openalex-impact-slot");
    const visible = globalThis.SmartCitationsOpenAlex.isAuthorCategory(managerSelectedCategoryId);
    column.classList.toggle("ctca-openalex-impact-visible", visible);
    slot.hidden = !visible;
    if (!visible) {
      slot.replaceChildren();
      return;
    }
    slot.innerHTML = globalThis.SmartCitationsOpenAlex.impactPlaceholderHtml();
    globalThis.SmartCitationsOpenAlex.bindImpactResize(slot, {
      height: settings.managerColumns.authorImpact,
      onChange: (height) => {
        settings.managerColumns.authorImpact = height;
        saveCachedState(cachedFiles).catch(() => {});
      }
    });
    globalThis.SmartCitationsOpenAlex.bindImpactCollapse(slot, {
      collapsed: settings.managerAuthorImpactCollapsed,
      onChange: (collapsed) => {
        settings.managerAuthorImpactCollapsed = collapsed;
        managerUpdateDetailsVisibility();
        saveCachedState(cachedFiles).catch(() => {});
      }
    });
    const authoredDrafts = [...managerDrafts.values()].filter((draft) =>
      draft.centralPreview !== true && Boolean(managerEntryAuthorshipCategory(draft))
    );
    const descriptors = authoredDrafts.map((draft) =>
      globalThis.SmartCitationsOpenAlex.descriptor(draft, draft.id)
    );
    globalThis.SmartCitationsOpenAlex.hydrateAuthorImpact(
      slot.querySelector(".ctca-openalex-impact"),
      descriptors,
      managerAuthorshipUserName
    ).catch(() => {});
  }

  function managerAttachmentProviderLabel(attachment) {
    return attachment?.provider === "nextcloud"
      ? "Nextcloud"
      : attachment?.provider === "local"
        ? (attachment.sessionOnly ? "Local disk · temporary" : "Local disk")
        : "Browser storage";
  }

  async function managerRenderPdfAttachmentList(draft) {
    try {
      const attachments = await globalThis.CollabTeXAttachmentStore.list({ key: draft.key, fields: draft.fields });
      let openTabChanged = false;
      for (const data of managerOpenPdfTabs.values()) {
        if (data.draftId !== draft.id) continue;
        const currentAttachment = attachments.find((attachment) => attachment.id === data.attachment.id);
        if (currentAttachment) data.attachment = currentAttachment;
        data.attachmentCount = attachments.length;
        openTabChanged = true;
      }
      if (openTabChanged) managerRenderPdfTabs();
      const row = bibManager.querySelector(`.ctca-manager-row[data-manager-record-id="${CSS.escape(draft.id)}"]`);
      managerUpdateRowPdfAction(row, draft, attachments);
      if (managerSelectedId !== draft.id) return;

      const detailActionsHtml = attachments.length
        ? `<button type="button" data-manager-action="open-pdf" data-attachment-id="${managerEscapeHtml(attachments[0].id)}">Open PDF ↗</button>`
        : managerSpecifiedHttpUrl(draft)
          ? `<button type="button" class="ctca-manager-detail-get-pdf" data-manager-action="get-pdf-from-web">${managerDownloadIconHtml()}<span>Get PDF from web</span></button>`
          : "";
      bibManager.querySelectorAll(`.ctca-manager-detail-actions[data-detail-entry-id="${CSS.escape(draft.id)}"]`).forEach((detailActions) => {
        detailActions.innerHTML = detailActionsHtml;
      });

      const listHtml = attachments.length ? attachments.map((attachment) => `
        <div class="ctca-manager-pdf-row" data-attachment-id="${managerEscapeHtml(attachment.id)}">
          <button type="button" class="ctca-manager-pdf-reorder" draggable="${attachments.length > 1 ? "true" : "false"}" ${attachments.length > 1 ? "" : "disabled"} title="Drag to reorder PDF" aria-label="Reorder ${managerEscapeHtml(attachment.name)}">⋮⋮</button>
          <div class="ctca-manager-pdf-name" title="${managerEscapeHtml(attachment.name)}">${managerEscapeHtml(attachment.name)}</div>
          <div class="ctca-manager-pdf-meta">${managerEscapeHtml(managerAttachmentProviderLabel(attachment))}${attachment.fileName ? ` · ${managerEscapeHtml(attachment.fileName)}` : ""}${attachment.size ? ` · ${(attachment.size / 1024 / 1024).toFixed(1)} MB` : ""}</div>
          <div class="ctca-manager-pdf-actions">
            <button type="button" data-manager-action="open-pdf" data-attachment-id="${managerEscapeHtml(attachment.id)}">Open</button>
            <button type="button" class="ctca-manager-pdf-download" data-manager-action="download-pdf" data-attachment-id="${managerEscapeHtml(attachment.id)}" title="Download PDF" aria-label="Download ${managerEscapeHtml(attachment.name)}">${managerDownloadIconHtml()}</button>
            <button type="button" data-manager-action="rename-pdf" data-attachment-id="${managerEscapeHtml(attachment.id)}">Rename</button>
            ${attachment.provider !== "local" ? `<button type="button" data-manager-action="replace-pdf" data-attachment-id="${managerEscapeHtml(attachment.id)}">Replace</button>` : ""}
            <button type="button" data-manager-action="remove-pdf" data-attachment-id="${managerEscapeHtml(attachment.id)}">Remove</button>
          </div>
        </div>`).join("") : `<div class="ctca-manager-no-pdf">No PDF attachments. Multiple named PDFs can be attached to each entry.</div>`;

      bibManager.querySelectorAll(`.ctca-manager-pdf-attachments[data-entry-id="${CSS.escape(draft.id)}"] .ctca-manager-pdf-list`).forEach((list) => {
        list.innerHTML = listHtml;
        managerBindAttachmentReordering(list, draft, attachments);
      });
    } catch (error) {
      bibManager.querySelectorAll(`.ctca-manager-detail-actions[data-detail-entry-id="${CSS.escape(draft.id)}"]`).forEach((detailActions) => detailActions.replaceChildren());
      const errorHtml = `<div class="ctca-manager-no-pdf">${managerEscapeHtml(error.message || String(error))}</div>`;
      bibManager.querySelectorAll(`.ctca-manager-pdf-attachments[data-entry-id="${CSS.escape(draft.id)}"] .ctca-manager-pdf-list`).forEach((list) => {
        list.innerHTML = errorHtml;
      });
    }
  }

  function managerReorderedAttachmentIds(attachments, sourceId, targetId, placeAfter) {
    const ids = attachments.map((attachment) => attachment.id);
    if (sourceId === targetId || !ids.includes(sourceId) || !ids.includes(targetId)) return ids;
    ids.splice(ids.indexOf(sourceId), 1);
    const targetIndex = ids.indexOf(targetId);
    ids.splice(targetIndex + (placeAfter ? 1 : 0), 0, sourceId);
    return ids;
  }

  function managerBindAttachmentReordering(list, draft, attachments) {
    if (!list || attachments.length < 2) return;
    let saving = false;
    const entryRef = { key: draft.key, fields: draft.fields };
    const clearDropState = () => {
      list.querySelectorAll(".ctca-manager-pdf-drop-before, .ctca-manager-pdf-drop-after, .ctca-manager-pdf-reordering")
        .forEach((row) => row.classList.remove("ctca-manager-pdf-drop-before", "ctca-manager-pdf-drop-after", "ctca-manager-pdf-reordering"));
    };
    const persistOrder = async (orderedIds) => {
      if (saving || orderedIds.every((id, index) => id === attachments[index]?.id)) return;
      saving = true;
      try {
        await globalThis.CollabTeXAttachmentStore.reorder(entryRef, orderedIds);
        await managerRenderPdfAttachmentList(draft);
        managerSetStatus("PDF attachment order saved.");
      } catch (error) {
        managerSetStatus(error?.message || String(error), true);
        await managerRenderPdfAttachmentList(draft);
      }
    };

    list.querySelectorAll(".ctca-manager-pdf-row[data-attachment-id]").forEach((row) => {
      const handle = row.querySelector(".ctca-manager-pdf-reorder");
      handle?.addEventListener("dragstart", (event) => {
        event.stopPropagation();
        event.dataTransfer.effectAllowed = "move";
        event.dataTransfer.setData("application/x-ctca-pdf-attachment", row.dataset.attachmentId || "");
        row.classList.add("ctca-manager-pdf-reordering");
      });
      handle?.addEventListener("dragend", clearDropState);
      handle?.addEventListener("keydown", (event) => {
        if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
        event.preventDefault();
        const currentIndex = attachments.findIndex((attachment) => attachment.id === row.dataset.attachmentId);
        const targetIndex = event.key === "ArrowUp" ? currentIndex - 1 : currentIndex + 1;
        if (currentIndex < 0 || targetIndex < 0 || targetIndex >= attachments.length) return;
        const ids = attachments.map((attachment) => attachment.id);
        [ids[currentIndex], ids[targetIndex]] = [ids[targetIndex], ids[currentIndex]];
        persistOrder(ids);
      });
      row.addEventListener("dragover", (event) => {
        if (!Array.from(event.dataTransfer?.types || []).includes("application/x-ctca-pdf-attachment")) return;
        event.preventDefault();
        event.stopPropagation();
        event.dataTransfer.dropEffect = "move";
        const rectangle = row.getBoundingClientRect();
        const placeAfter = event.clientY > rectangle.top + rectangle.height / 2;
        row.classList.toggle("ctca-manager-pdf-drop-before", !placeAfter);
        row.classList.toggle("ctca-manager-pdf-drop-after", placeAfter);
      });
      row.addEventListener("dragleave", (event) => {
        if (row.contains(event.relatedTarget)) return;
        row.classList.remove("ctca-manager-pdf-drop-before", "ctca-manager-pdf-drop-after");
      });
      row.addEventListener("drop", (event) => {
        const sourceId = event.dataTransfer?.getData("application/x-ctca-pdf-attachment") || "";
        if (!sourceId) return;
        event.preventDefault();
        event.stopPropagation();
        const rectangle = row.getBoundingClientRect();
        const placeAfter = event.clientY > rectangle.top + rectangle.height / 2;
        const orderedIds = managerReorderedAttachmentIds(attachments, sourceId, row.dataset.attachmentId || "", placeAfter);
        clearDropState();
        persistOrder(orderedIds);
      });
    });
  }

  async function managerDownloadPdfAttachment(attachment) {
    const blob = await globalThis.CollabTeXAttachmentStore.getBlob(attachment);
    if (!blob) throw new Error("PDF data is not available.");
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = attachment.fileName || `${attachment.name || "document"}.pdf`;
    link.style.display = "none";
    document.body.appendChild(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function syncManagerPdfAttachmentLoadingIndicators() {
    bibManager.querySelectorAll(".ctca-manager-row[data-manager-record-id]").forEach((row) => {
      const loading = managerPdfAttachmentLoadingIds.has(row.dataset.managerRecordId || "");
      row.classList.toggle("ctca-manager-row-pdf-loading", loading);
      let indicator = row.querySelector(".ctca-manager-row-pdf-loading-indicator");
      if (loading && !indicator) {
        indicator = document.createElement("span");
        indicator.className = "ctca-manager-row-pdf-loading-indicator";
        indicator.setAttribute("role", "status");
        indicator.setAttribute("aria-label", "Loading PDF attachments");
        indicator.innerHTML = `<span class="ctca-manager-pdf-loading-spinner" aria-hidden="true"></span>`;
        row.prepend(indicator);
      } else if (!loading) {
        indicator?.remove();
      }
    });
    bibManager.querySelectorAll(".ctca-manager-pdf-loading[data-entry-id]").forEach((indicator) => {
      const loading = managerPdfAttachmentLoadingIds.has(indicator.dataset.entryId || "");
      indicator.hidden = !loading;
      const addButton = indicator.closest(".ctca-manager-pdf-attachments")?.querySelector(".ctca-manager-add-pdf");
      if (addButton) addButton.disabled = loading;
    });
  }

  async function managerOpenAddPdfDialog(draft, options = {}) {
    const config = await globalThis.CollabTeXAttachmentStore.getConfig();
    const sourceUrl = managerSpecifiedHttpUrl(draft);
    const initialFiles = globalThis.CollabTeXPdfImport.pdfFiles(options.files || []);
    let selectedProvider = (options.getFromWeb || initialFiles.length) && config.provider === "local" ? "browser" : (config.provider || "browser");
    let selectedFiles = [...initialFiles];
    let fileRows = null;
    let localPathInput = null;
    let localNameRows = null;
    let localPermissionButton = null;
    let localPermissionStatus = null;
    let localNames = [];
    let webCandidates = [];
    let webResultRows = null;
    let webScanUrl = sourceUrl;
    let webResumeTabId = null;
    let webHumanCheckEncountered = false;
    const webOpenTabIds = new Set();

    const result = await showAppDialog({
      title: `Attach PDF to ${draft.key}`,
      message: "Choose where the PDF should be kept. You can attach several PDFs and name each attachment separately.",
      controls: (container) => {
        const wrapper = document.createElement("div");
        wrapper.className = "ctca-pdf-dialog-grid";
        wrapper.innerHTML = `
          <div class="ctca-pdf-provider-choices" role="group" aria-label="PDF storage">
            <button type="button" class="ctca-pdf-provider-choice" data-provider="nextcloud" aria-pressed="false">
              <span class="ctca-pdf-provider-icon">☁</span><span><strong>Nextcloud</strong><small>Upload the PDF, including inline annotations, and synchronize its separate notes.</small></span>
            </button>
            <button type="button" class="ctca-pdf-provider-choice" data-provider="browser" aria-pressed="false">
              <span class="ctca-pdf-provider-icon">▣</span><span><strong>Browser storage</strong><small>Keep a persistent copy in this browser profile.</small></span>
            </button>
            <button type="button" class="ctca-pdf-provider-choice" data-provider="local" aria-pressed="false">
              <span class="ctca-pdf-provider-icon">↗</span><span><strong>Local link</strong><small>Store only the path and read the PDF from its current disk location.</small></span>
            </button>
          </div>
          <div class="ctca-pdf-browse-row">${sourceUrl ? `<button type="button" class="ctca-pdf-get-web">Get from web</button>` : ""}<button type="button" class="ctca-pdf-browse">Browse PDF file(s)…</button><span class="ctca-pdf-browse-summary">No PDF selected</span><input type="file" accept=".pdf,application/pdf,application/x-pdf" multiple hidden></div>
          ${sourceUrl ? `
          <div class="ctca-web-pdf-panel" hidden>
            <div class="ctca-web-pdf-status" aria-live="polite">Ready to inspect ${managerEscapeHtml(sourceUrl)}</div>
            <div class="ctca-web-file-permission">Protected-site downloads require <strong>Allow access to file URLs</strong> on Smart Citations’ extension Details page. <a href="#" class="ctca-web-file-permission-link">Open extension details</a></div>
            <button type="button" class="ctca-web-pdf-continue" hidden>Continue looking for PDFs</button>
            <div class="ctca-web-pdf-results"></div>
          </div>` : ""}
          <div class="ctca-pdf-file-name-list"></div>
          <div class="ctca-local-path-panel" hidden>
            <label class="ctca-app-dialog-field ctca-local-path-field">
              <span>Local PDF path(s)</span>
              <textarea class="ctca-local-path-input" rows="4" wrap="soft" spellcheck="false" placeholder="C:\\Users\\Name\\Documents\\paper.pdf&#10;/home/name/Documents/paper.pdf"></textarea>
            </label>
            <p class="ctca-local-path-instruction"><strong>How to get the path:</strong> On Windows, browse to the PDF in File Explorer, right-click it, choose <em>Properties</em>, copy the file location, paste it here, and append the PDF filename. You can also use <em>Shift + right-click → Copy as path</em>. Paste one complete PDF path per line. Backslashes are accepted; do not add <code>file://</code>.</p>
            <p class="ctca-local-link-warning">Only the path is stored; the PDF is not copied. In Chrome or Edge, enable <strong>Allow access to file URLs</strong> on the extension’s Details page. In Firefox 153 and newer, enable <strong>Access local files on your computer</strong>. In older Firefox versions there is no separate local-files row; the relevant permission is <strong>Access your data for all websites</strong>.</p>
            <div class="ctca-local-permission-row"><button type="button" class="ctca-local-permission-button">Open extension settings</button><span class="ctca-local-permission-status" aria-live="polite"></span></div>
            <div class="ctca-local-path-name-list"></div>
          </div>`;
        container.appendChild(wrapper);
        const input = wrapper.querySelector('input[type="file"]');
        const summary = wrapper.querySelector('.ctca-pdf-browse-summary');
        const providerButtons = [...wrapper.querySelectorAll('.ctca-pdf-provider-choice')];
        const browseRow = wrapper.querySelector('.ctca-pdf-browse-row');
        const localPanel = wrapper.querySelector('.ctca-local-path-panel');
        fileRows = wrapper.querySelector('.ctca-pdf-file-name-list');
        localPathInput = wrapper.querySelector('.ctca-local-path-input');
        localNameRows = wrapper.querySelector('.ctca-local-path-name-list');
        localPermissionButton = wrapper.querySelector('.ctca-local-permission-button');
        localPermissionStatus = wrapper.querySelector('.ctca-local-permission-status');
        const getWebButton = wrapper.querySelector('.ctca-pdf-get-web');
        const webPanel = wrapper.querySelector('.ctca-web-pdf-panel');
        const webStatus = wrapper.querySelector('.ctca-web-pdf-status');
        const webPermissionLink = wrapper.querySelector('.ctca-web-file-permission-link');
        const continueWebButton = wrapper.querySelector('.ctca-web-pdf-continue');
        const webResults = wrapper.querySelector('.ctca-web-pdf-results');
        webResultRows = webResults;

        const refreshLocalPermissionStatus = async () => {
          try {
            const granted = await globalThis.CollabTeXAttachmentStore.isLocalFilePermissionGranted();
            localPermissionStatus.textContent = granted ? 'Local-file access is granted.' : 'Local-file access is not currently granted.';
            localPermissionStatus.classList.toggle('ctca-local-permission-granted', granted);
          } catch (_error) {
            localPermissionStatus.textContent = 'Local-file access status could not be determined.';
          }
        };
        localPermissionButton.addEventListener('click', async () => {
          localPermissionButton.disabled = true;
          localPermissionStatus.textContent = 'Enable local-file access on the extension page.';
          try {
            await globalThis.CollabTeXAttachmentStore.openLocalFilePermissionSettings();
          } catch (error) {
            localPermissionStatus.textContent = error?.message || String(error);
          } finally {
            localPermissionButton.disabled = false;
          }
        });
        webPermissionLink?.addEventListener('click', (event) => {
          event.preventDefault();
          globalThis.CollabTeXAttachmentStore.openLocalFilePermissionSettings().catch(() => null);
        });
        refreshLocalPermissionStatus();

        const localPaths = () => String(localPathInput.value || "").split(/\r?\n/).map((value) => value.trim()).filter(Boolean);
        const pathFileName = (value) => {
          const clean = String(value || "").trim().replace(/^['"]|['"]$/g, "").replace(/\\/g, "/");
          const last = clean.split("/").pop() || "Local PDF";
          try { return decodeURIComponent(last); } catch (_error) { return last; }
        };
        const renderSelected = () => {
          summary.textContent = selectedFiles.length ? `${selectedFiles.length} PDF${selectedFiles.length === 1 ? "" : "s"} selected` : "No PDF selected";
          fileRows.replaceChildren();
          selectedFiles.forEach((file, index) => {
            const label = document.createElement('label');
            label.className = 'ctca-app-dialog-field';
            label.innerHTML = `<span>Name for ${managerEscapeHtml(file.name)}</span><input type="text" data-pdf-name-index="${index}" value="Manuscript">`;
            fileRows.appendChild(label);
          });
        };
        const renderWebCandidates = () => {
          webResults?.replaceChildren();
          webCandidates.forEach((candidate, index) => {
            const row = document.createElement('label');
            row.className = 'ctca-web-pdf-result';
            row.title = candidate.url;
            row.innerHTML = `
              <input type="checkbox" data-web-pdf-index="${index}" ${index === 0 ? 'checked' : ''}>
              <span class="ctca-web-pdf-result-copy">
                <strong>${managerEscapeHtml(candidate.fileName || `PDF ${index + 1}`)}</strong>
                <input type="text" data-web-pdf-name-index="${index}" value="${managerEscapeHtml(candidate.name || `PDF ${index + 1}`)}" aria-label="Attachment name">
              </span>`;
            webResults.appendChild(row);
          });
        };
        const scanWebPage = async (continueExistingTab = false) => {
          webPanel.hidden = false;
          webPanel.dataset.expanded = 'true';
          getWebButton.disabled = true;
          continueWebButton.disabled = true;
          continueWebButton.hidden = true;
          webStatus.textContent = 'Opening the webpage in the background and looking for PDFs…';
          webStatus.classList.remove('ctca-web-pdf-status-error');
          webStatus.classList.add('ctca-web-pdf-status-loading');
          try {
            const found = await globalThis.CollabTeXAttachmentStore.discoverWebPdfs(webScanUrl, {
              tabId: continueExistingTab ? webResumeTabId : null,
              preserveTab: continueExistingTab && webHumanCheckEncountered
            });
            if (Number.isInteger(found.tabId)) webOpenTabIds.add(found.tabId);
            for (const candidate of found.candidates || []) {
              if (Number.isInteger(candidate.tabId)) webOpenTabIds.add(candidate.tabId);
            }
            if (found.pageStillLoading && found.tabId) {
              webScanUrl = found.finalUrl || webScanUrl;
              webResumeTabId = found.tabId;
              continueWebButton.dataset.resumeTabId = String(found.tabId);
              webCandidates = [];
              renderWebCandidates();
              webStatus.textContent = 'This page is still loading. Please go to the tab I just opened, complete any human test there might be and then come back to click Continue looking for PDFs.';
              continueWebButton.hidden = false;
              return;
            }
            if (found.humanCheckRequired && found.tabId) {
              webScanUrl = found.finalUrl || webScanUrl;
              webResumeTabId = found.tabId;
              continueWebButton.dataset.resumeTabId = String(found.tabId);
              webHumanCheckEncountered = true;
              webCandidates = [];
              renderWebCandidates();
              webStatus.textContent = 'This site requires a human check. Complete it in the journal tab. When that page changes URL, Smart Citations will switch back and continue looking for PDFs automatically. If it does not, return here and click Continue looking for PDFs.';
              continueWebButton.hidden = false;
              await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
              await globalThis.CollabTeXAttachmentStore.showWebHumanCheck(found.tabId, found.finalUrl || webScanUrl);
              return;
            }
            webResumeTabId = null;
            delete continueWebButton.dataset.resumeTabId;
            if (found.permissionRequired && found.finalUrl) {
              webScanUrl = found.finalUrl;
              webCandidates = [];
              renderWebCandidates();
              webStatus.textContent = 'The webpage forwarded to another site. Click Get from web again to grant access there and continue.';
              return;
            }
            webCandidates = (found.candidates || []).slice(0, 4);
            renderWebCandidates();
            webStatus.textContent = webCandidates.length
              ? `${webCandidates.length} PDF${webCandidates.length === 1 ? '' : 's'} found. Select the files to attach.`
              : 'No PDF files were found on this webpage.';
          } catch (error) {
            webCandidates = [];
            renderWebCandidates();
            webStatus.textContent = error.message || String(error);
            webStatus.classList.add('ctca-web-pdf-status-error');
          } finally {
            getWebButton.disabled = false;
            continueWebButton.disabled = false;
            webStatus.classList.remove('ctca-web-pdf-status-loading');
          }
        };
        getWebButton?.addEventListener('click', () => scanWebPage(false));
        continueWebButton?.addEventListener('click', () => scanWebPage(true));
        const renderLocalPaths = () => {
          [...localNameRows.querySelectorAll('[data-local-name-index]')].forEach((inputNode, index) => { localNames[index] = inputNode.value; });
          const paths = localPaths();
          localNameRows.replaceChildren();
          paths.forEach((path, index) => {
            const fileName = pathFileName(path);
            const defaultName = fileName.replace(/\.pdf$/i, "") || `PDF ${index + 1}`;
            const label = document.createElement('label');
            label.className = 'ctca-app-dialog-field';
            label.innerHTML = `<span>Name for ${managerEscapeHtml(fileName)}</span><input type="text" data-local-name-index="${index}" value="${managerEscapeHtml(localNames[index] || defaultName)}">`;
            localNameRows.appendChild(label);
          });
          localNames.length = paths.length;
        };
        const updateProvider = (provider, resetFiles = true) => {
          selectedProvider = provider || 'browser';
          providerButtons.forEach((button) => {
            const selected = button.dataset.provider === selectedProvider;
            button.classList.toggle('ctca-pdf-provider-choice-selected', selected);
            button.setAttribute('aria-pressed', selected ? 'true' : 'false');
          });
          const local = selectedProvider === 'local';
          const selectedLocalFiles = local && selectedFiles.length > 0;
          browseRow.hidden = local && !selectedLocalFiles;
          fileRows.hidden = local && !selectedLocalFiles;
          localPanel.hidden = !local || selectedLocalFiles;
          if (getWebButton) getWebButton.hidden = local;
          if (webPanel) webPanel.hidden = local || webPanel.dataset.expanded !== 'true';
          if (resetFiles) {
            selectedFiles = [];
            input.value = '';
            renderSelected();
          }
          if (local) window.setTimeout(() => localPathInput.focus(), 0);
        };
        providerButtons.forEach((button) => button.addEventListener('click', () => updateProvider(button.dataset.provider, false)));
        wrapper.querySelector('.ctca-pdf-browse').addEventListener('click', () => input.click());
        input.addEventListener('change', () => {
          selectedFiles = [...input.files];
          renderSelected();
        });
        localPathInput.addEventListener('input', renderLocalPaths);
        renderSelected();
        updateProvider(selectedProvider, false);
        if (options.getFromWeb && getWebButton) {
          window.setTimeout(() => getWebButton.click(), 0);
        }
      },
      buttons: [
        { label: "Cancel", value: null },
        { label: "Attach", primary: true, getValue: () => ({
          provider: selectedProvider,
          files: selectedFiles,
          paths: String(localPathInput?.value || "").split(/\r?\n/).map((value) => value.trim()).filter(Boolean),
          webFiles: selectedProvider === 'local' ? [] : webCandidates.flatMap((candidate, index) => {
            const checkbox = webResultRows?.querySelector(`[data-web-pdf-index="${index}"]`);
            if (!checkbox?.checked) return [];
            const name = webResultRows?.querySelector(`[data-web-pdf-name-index="${index}"]`)?.value.trim();
            return [{ ...candidate, name: name || candidate.name || candidate.fileName.replace(/\.pdf$/i, '') }];
          }),
          names: selectedProvider === 'local' && !selectedFiles.length
            ? [...localNameRows.querySelectorAll('[data-local-name-index]')].map((input) => input.value.trim())
            : [...fileRows.querySelectorAll('[data-pdf-name-index]')].map((input) => input.value.trim())
        }) }
      ],
      closeValue: null
    });
    if (!result) {
      await Promise.allSettled(
        [...webOpenTabIds].map((tabId) => globalThis.CollabTeXAttachmentStore.closeWebTab(tabId))
      );
      return;
    }

    managerPdfAttachmentLoadingIds.add(draft.id);
    syncManagerPdfAttachmentLoadingIndicators();
    try {
      const entryRef = { key: draft.key, fields: draft.fields };
      if (result.provider === 'local') {
        if (result.files.length) {
          for (let i = 0; i < result.files.length; i += 1) {
            await globalThis.CollabTeXPdfImport.attach(
              entryRef,
              { file: result.files[i], handle: null },
              'local',
              result.names[i]
            );
          }
          managerSetStatus('Local PDF link saved for this browser session.');
        } else {
          if (!result.paths.length) throw new Error('Enter at least one complete local PDF path.');
          let permitted = true;
          try { permitted = await globalThis.CollabTeXAttachmentStore.ensureLocalFilePermission(); } catch (_error) { permitted = false; }
          for (let i = 0; i < result.paths.length; i += 1) {
            await globalThis.CollabTeXAttachmentStore.addLocalLink(entryRef, result.paths[i], result.names[i]);
          }
          managerSetStatus(permitted
            ? 'Local PDF link saved. The PDF remains at its current disk location.'
            : 'Local PDF link saved. Enable local-file access for this extension before opening the PDF.');
        }
      } else {
      const files = result.files.map((file, index) => ({ file, name: result.names[index] }));
      const failures = [];
      const webTabIds = new Set([
        ...webOpenTabIds,
        ...(result.webFiles || []).map((candidate) => candidate.tabId).filter(Number.isInteger)
      ]);
      try {
        for (const candidate of result.webFiles || []) {
          try {
            files.push({
              file: await globalThis.CollabTeXAttachmentStore.downloadWebPdf(
                candidate.url,
                candidate.sourceUrl,
                candidate.tabId
              ),
              name: candidate.name
            });
          } catch (error) {
            failures.push(`${candidate.fileName || candidate.url}: ${error.message || String(error)}`);
          }
        }
      } finally {
        await Promise.allSettled(
          [...webTabIds].map((tabId) => globalThis.CollabTeXAttachmentStore.closeWebTab(tabId))
        );
      }
      if (!files.length) throw new Error(failures.join('; ') || 'Choose or catch at least one PDF file.');
      if (result.provider === 'nextcloud') {
        const cfg = await globalThis.CollabTeXAttachmentStore.getConfig();
        if (!cfg.nextcloud?.appPassword) throw new Error('Connect Nextcloud in the standalone PDF storage settings first.');
      }
      let attached = 0;
      for (const item of files) {
        const file = item.file;
        const name = item.name || file.name.replace(/\.pdf$/i, '');
        try {
          if (result.provider === 'nextcloud') await globalThis.CollabTeXAttachmentStore.addNextcloud(entryRef, file, name);
          else await globalThis.CollabTeXAttachmentStore.addBrowser(entryRef, file, name);
          attached += 1;
        } catch (error) {
          failures.push(`${file.name}: ${error.message || String(error)}`);
        }
      }
      if (!attached) throw new Error(failures.join('; ') || 'No PDF could be attached.');
      managerSetStatus(failures.length
        ? `${attached} PDF${attached === 1 ? '' : 's'} attached; ${failures.length} failed: ${failures.join('; ')}`
        : `${attached} PDF${attached === 1 ? '' : 's'} attached${result.provider === 'nextcloud' ? ' and uploaded to Nextcloud' : ''}.`,
        failures.length > 0);
      }
      await managerRenderPdfAttachmentList(draft);
    } finally {
      await Promise.allSettled(
        [...webOpenTabIds].map((tabId) => globalThis.CollabTeXAttachmentStore.closeWebTab(tabId))
      );
      managerPdfAttachmentLoadingIds.delete(draft.id);
      syncManagerPdfAttachmentLoadingIndicators();
    }
  }

  async function managerShowPdfImportReport(created, updated, skipped, failed, notes = []) {
    const summary = `${created} new entr${created === 1 ? "y" : "ies"} created, ` +
      `${updated} existing entr${updated === 1 ? "y" : "ies"} updated with a PDF, and ` +
      `${skipped} PDF${skipped === 1 ? " was" : "s were"} skipped as ${skipped === 1 ? "a duplicate" : "duplicates"}.` +
      (failed ? ` ${failed} PDF${failed === 1 ? " could" : "s could"} not be imported.` : "");
    await showAppDialog({
      title: "PDF import complete",
      message: summary,
      controls: notes.length ? (container) => {
        const details = document.createElement("div");
        details.className = "ctca-pdf-import-report";
        details.textContent = notes.slice(0, 12).join("\n");
        container.appendChild(details);
      } : null,
      buttons: [{ label: "Close", value: true, primary: true }],
      closeValue: true
    });
    return summary;
  }

  async function managerAddEntriesFromPdfs(initialFiles = []) {
    if (managerBusy) return;
    if (!managerFiles.length) await managerLoadBibliography({ saveDirty: false });
    const targetFile = managerFiles[0];
    if (!targetFile) {
      managerSetStatus("No writable BibTeX file is configured.", true);
      return;
    }
    const config = await globalThis.CollabTeXAttachmentStore.getConfig();
    let picker = null;
    const result = await showAppDialog({
      title: "Add new entry from PDF",
      message: "Choose where the imported PDFs should be kept. Smart Citations will read each PDF, find its DOI, and retrieve the bibliography details.",
      controls: (container) => {
        picker = globalThis.CollabTeXPdfImport.createSelectionControls(container, {
          provider: config.provider || "browser",
          files: initialFiles
        });
      },
      buttons: [
        { label: "Cancel", value: null },
        { label: "Add", primary: true, getValue: () => picker.value() }
      ],
      closeValue: null
    });
    if (!result) return;
    if (!result.items.length) {
      managerSetStatus("Select at least one PDF file.", true);
      return;
    }
    if (result.provider === "nextcloud" && !config.nextcloud?.appPassword) {
      managerSetStatus("Connect Nextcloud in PDF storage settings first.", true);
      return;
    }

    let created = 0;
    let updated = 0;
    let skipped = 0;
    let failed = 0;
    const notes = [];
    setManagerBusy(true, "Importing PDFs…");
    managerSetProgress(0, result.items.length, `0/${result.items.length} PDFs processed`, true);
    try {
      for (let index = 0; index < result.items.length; index += 1) {
        const item = result.items[index];
        const file = item.file;
        managerSetProgress(index, result.items.length, `Reading ${file.name}…`, true);
        try {
          const doi = await globalThis.CollabTeXPdfImport.extractDoi(file);
          if (!doi) {
            failed += 1;
            notes.push(`${file.name}: no DOI was found.`);
            continue;
          }
          const existing = [...managerDrafts.values()].find((draft) =>
            draft.centralPreview !== true &&
            normalizeDoiInput(draft.fields?.doi || "") === doi
          );
          if (existing) {
            const entryRef = { key: existing.key, fields: existing.fields };
            const attachments = await globalThis.CollabTeXAttachmentStore.list(entryRef);
            if (attachments.length) {
              skipped += 1;
              notes.push(`${file.name}: skipped because ${existing.key} already has a PDF.`);
              continue;
            }
            await globalThis.CollabTeXPdfImport.attach(entryRef, item, result.provider);
            updated += 1;
            managerSelectedId = existing.id;
            managerSelectedIds = new Set([existing.id]);
            continue;
          }

          const metadata = await fetchDoiMetadata(doi);
          const key = generateCitationKey(metadata, [...managerDrafts.values()].map((draft) => draft.key));
          const wrappedFields = metadataToBibFields({ ...metadata, doi: metadata.doi || doi }, null);
          const fields = {
            ...normalizeFieldMapForEditing(wrappedFields),
            [CTCA_ADDED_ON_FIELD]: new Date().toISOString(),
            [CTCA_DOI_SYNC_FIELD]: new Date().toISOString()
          };
          const syntheticRecord = {
            key,
            type: metadata.entryType || "misc",
            sourceFile: targetFile,
            fields: Object.fromEntries(
              Object.entries(fields).map(([name, value]) => [name, managerWrapBibValue(value)])
            )
          };
          const draft = draftFromRecord(syntheticRecord);
          draft.originalKey = "";
          draft.key = key;
          draft.fields = fields;
          managerRecords.push(syntheticRecord);
          managerDrafts.set(draft.id, draft);
          try {
            await globalThis.CollabTeXPdfImport.attach({ key, fields }, item, result.provider);
          } catch (error) {
            managerRecords = managerRecords.filter((record) => managerRecordId(record) !== draft.id);
            managerDrafts.delete(draft.id);
            throw error;
          }
          managerDirtyIds.add(draft.id);
          managerSessionChanged = true;
          managerNewEntryKeys.add(key.toLowerCase());
          if (!["all", "starred", "uncategorized"].includes(managerSelectedCategoryId)) {
            managerSetEntryCategoryIds(draft.id, [managerSelectedCategoryId]);
          }
          scheduleFastManagerCentralSync(draft);
          managerSelectedId = draft.id;
          managerSelectedIds = new Set([draft.id]);
          created += 1;
        } catch (error) {
          failed += 1;
          notes.push(`${file.name}: ${error?.message || String(error)}`);
        } finally {
          managerSetProgress(index + 1, result.items.length, `${index + 1}/${result.items.length} PDFs processed`, true);
        }
      }
      renderManagerCategories();
      renderManagerList();
      renderManagerDetails();
      updateManagerCount();
    } finally {
      setManagerBusy(false);
      managerSetProgress(0, 1, "", false);
    }
    const summary = await managerShowPdfImportReport(created, updated, skipped, failed, notes);
    const writeHint = created ? " Click Update Bib or close the window to write the new entries to the document." : "";
    managerSetStatus(`${summary}${writeHint}`, failed > 0 && created + updated === 0);
  }

  function managerRenderPdfTabs() {
    const tabs = bibManager.querySelector('.ctca-manager-inline-tabs');
    const hasPdfTabs = managerOpenPdfTabs.size > 0;
    tabs.hidden = !hasPdfTabs;
    bibManager.classList.toggle('ctca-has-pdf-tabs', hasPdfTabs);
    tabs.querySelectorAll('.ctca-manager-tab[data-tab-id]:not([data-tab-id="bibliography"])').forEach((node) => node.remove());
    const spacer = tabs.querySelector('.ctca-manager-tab-spacer');
    for (const [tabId, data] of managerOpenPdfTabs) {
      const button = document.createElement('button');
      button.type = 'button'; button.className = 'ctca-manager-tab'; button.dataset.tabId = tabId;
      const label = managerPdfWorkspaceTabLabel(data);
      button.title = label;
      button.innerHTML = `<span>${managerEscapeHtml(label)}</span><span class="ctca-manager-tab-close">×</span>`;
      tabs.insertBefore(button, spacer);
    }
    tabs.querySelectorAll('.ctca-manager-tab').forEach((tab) => tab.classList.toggle('ctca-manager-tab-active', tab.dataset.tabId === managerWorkspaceTab));
  }

  function managerPdfWorkspaceTabLabel(data) {
    const citationKey = String(
      managerDrafts.get(data?.draftId)?.key
      || data?.entryKey
      || ""
    ).trim() || "PDF";
    if (!(Number(data?.attachmentCount) > 1)) return citationKey;
    const pdfName = String(
      data?.attachment?.name
      || data?.attachment?.fileName?.replace(/\.pdf$/i, "")
      || ""
    ).trim();
    return pdfName ? `${citationKey} — ${pdfName}` : citationKey;
  }


  async function managerSendPdfDataToFrame(frame, attachment) {
    if (!frame?.contentWindow || !attachment) return;
    try {
      const blob = await globalThis.CollabTeXAttachmentStore.getBlob(attachment);
      if (!blob) throw new Error('PDF data is not available. Reattach the file or synchronize it again.');
      const bytes = await blob.arrayBuffer();
      frame.contentWindow.postMessage({
        type: 'ctca-pdf-load-data',
        attachmentId: attachment.id,
        provider: attachment.provider,
        bytes
      }, '*');
    } catch (error) {
      frame.contentWindow.postMessage({
        type: 'ctca-pdf-load-error',
        attachmentId: attachment.id,
        error: error?.message || String(error)
      }, '*');
    }
  }

  function managerPdfSaveRequestId() {
    return `pdf-save-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  }

  async function managerRequestPdfFrameSave(tabId = managerWorkspaceTab) {
    if (!tabId || tabId === 'bibliography') return;
    const data = managerOpenPdfTabs.get(tabId);
    const frame = bibManager.querySelector('.ctca-pdf-frame');
    if (!data || !frame?.contentWindow || !data.viewerReady) return;

    const requestId = managerPdfSaveRequestId();
    await new Promise((resolve, reject) => {
      const timer = window.setTimeout(() => {
        managerPendingPdfSaveRequests.delete(requestId);
        reject(new Error('Timed out while saving PDF annotations.'));
      }, 30000);
      managerPendingPdfSaveRequests.set(requestId, {
        resolve: () => { window.clearTimeout(timer); resolve(); },
        reject: (error) => { window.clearTimeout(timer); reject(error); }
      });
      frame.contentWindow.postMessage({
        type: 'ctca-pdf-request-save',
        attachmentId: data.attachment.id,
        requestId
      }, '*');
    });
  }

  async function managerPersistAnnotatedPdf(frame, message) {
    const data = managerOpenPdfTabs.get(managerWorkspaceTab);
    if (!data || message.attachmentId !== data.attachment.id) return;
    const originalProvider = data.attachment.provider;
    try {
      const fileName = data.attachment.fileName || `${data.attachment.name || 'annotated'}.pdf`;
      const file = new File([message.bytes], fileName, { type: 'application/pdf' });
      const updated = await globalThis.CollabTeXAttachmentStore.replaceFile(data.attachment.id, file);
      data.attachment = updated;
      data.pdfDirty = false;
      const draft = managerDrafts.get(data.draftId);
      if (draft) await managerRenderPdfAttachmentList(draft);
      const convertedLocal = originalProvider === 'local' && updated.provider === 'browser';
      const resultMessage = convertedLocal
        ? 'Annotations saved inside the PDF. The local link was converted to browser storage because extensions cannot overwrite an arbitrary local path.'
        : updated.provider === 'nextcloud'
          ? 'Annotations saved inside the PDF and uploaded to Nextcloud.'
          : 'Annotations saved inside the PDF.';
      frame.contentWindow.postMessage({
        type: 'ctca-pdf-save-result',
        attachmentId: updated.id,
        token: message.token,
        ok: true,
        persistenceMode: 'persistent',
        message: resultMessage
      }, '*');
      managerSetStatus(resultMessage);
    } catch (error) {
      const text = error?.message || String(error);
      frame.contentWindow.postMessage({
        type: 'ctca-pdf-save-result',
        attachmentId: data.attachment.id,
        token: message.token,
        ok: false,
        error: text
      }, '*');
      managerSetStatus(text, true);
    }
  }

  function managerSetPdfMaximized(maximized) {
    const value = Boolean(maximized && managerWorkspaceTab !== 'bibliography');
    const wasMaximized = bibManager?.classList.contains('ctca-pdf-maximized');
    const state = managerOpenPdfTabs.get(managerWorkspaceTab);

    if (value && !wasMaximized && state) {
      managerPdfFullscreenPaneState = {
        state,
        notesCollapsed: Boolean(state.notesCollapsed),
        detailsCollapsed: Boolean(state.detailsCollapsed),
        notesModified: false,
        detailsModified: false
      };
      managerSetPdfPaneCollapsed('notes', true, { trackFullscreenChange: false });
      managerSetPdfPaneCollapsed('details', true, { trackFullscreenChange: false });
    } else if (!value && wasMaximized && managerPdfFullscreenPaneState) {
      const snapshot = managerPdfFullscreenPaneState;
      if (!snapshot.notesModified) snapshot.state.notesCollapsed = snapshot.notesCollapsed;
      if (!snapshot.detailsModified) snapshot.state.detailsCollapsed = snapshot.detailsCollapsed;
      if (snapshot.state === state) {
        managerSetPdfPaneCollapsed('notes', snapshot.state.notesCollapsed, { trackFullscreenChange: false });
        managerSetPdfPaneCollapsed('details', snapshot.state.detailsCollapsed, { trackFullscreenChange: false });
      }
      managerPdfFullscreenPaneState = null;
    }

    bibManager?.classList.toggle('ctca-pdf-maximized', value);
    const frame = bibManager?.querySelector('.ctca-pdf-frame');
    frame?.contentWindow?.postMessage({
      type: 'ctca-pdf-host-layout',
      attachmentId: managerOpenPdfTabs.get(managerWorkspaceTab)?.attachment?.id || '',
      maximized: value
    }, '*');
  }

  async function managerActivatePdfTab(tabId) {
    const previousPdf = managerOpenPdfTabs.get(managerWorkspaceTab);
    if (managerWorkspaceTab !== "bibliography" && managerWorkspaceTab !== tabId) {
      await managerRequestPdfFrameSave(managerWorkspaceTab);
      window.clearTimeout(managerPdfNoteSaveTimer);
      await managerSaveActivePdfNotes().catch(() => {});
      if (bibManager.classList.contains('ctca-pdf-maximized')) managerSetPdfMaximized(false);
    }
    managerWorkspaceTab = tabId;
    managerRenderPdfTabs();
    const view = bibManager.querySelector('.ctca-manager-inline-pdf-view');
    const isPdf = tabId !== 'bibliography';
    bibManager.classList.toggle('ctca-manager-pdf-active', isPdf);
    view.hidden = !isPdf;
    if (!isPdf) {
      if (previousPdf?.draftId && managerDrafts.has(previousPdf.draftId)) {
        managerSelectedId = previousPdf.draftId;
        managerSelectedIds = new Set([previousPdf.draftId]);
        managerLastSelectionAnchorId = previousPdf.draftId;
      }
      managerSetPdfMaximized(false);
      renderManagerList();
      renderManagerDetails();
      return;
    }
    const data = managerOpenPdfTabs.get(tabId);
    if (!data) return managerActivatePdfTab('bibliography');
    const draft = managerDrafts.get(data.draftId);
    if (draft) managerSelectedId = draft.id;
    const layout = view.querySelector('.ctca-pdf-layout');
    layout.classList.toggle('ctca-pdf-notes-collapsed', Boolean(data.notesCollapsed));
    layout.classList.toggle('ctca-pdf-details-collapsed', Boolean(data.detailsCollapsed));
    view.querySelector('.ctca-pdf-note').value = data.attachment.notes || '';
    data.viewerReady = false;
    data.pdfDirty = false;
    view.querySelector('.ctca-pdf-frame').src = extensionApi.runtime.getURL(`pdf-viewer.html?attachment=${encodeURIComponent(data.attachment.id)}`);
    renderManagerDetails();
    const source = bibManager.querySelector('.ctca-manager-details');
    const target = view.querySelector('.ctca-pdf-entry-details');
    target.innerHTML = source.innerHTML;
  }

  async function managerOpenPdfTab(draft, attachment) {
    const tabId = `pdf:${attachment.id}`;
    const previous = managerOpenPdfTabs.get(tabId);
    const attachments = await globalThis.CollabTeXAttachmentStore.list({ key: draft.key, fields: draft.fields });
    const currentAttachment = attachments.find((item) => item.id === attachment.id) || attachment;
    managerOpenPdfTabs.set(tabId, {
      draftId: draft.id,
      entryKey: draft.key,
      attachment: currentAttachment,
      attachmentCount: attachments.length,
      notesCollapsed: previous?.notesCollapsed || false,
      detailsCollapsed: previous?.detailsCollapsed || false
    });
    await managerActivatePdfTab(tabId);
  }

  async function managerClosePdfTab(tabId) {
    const closingPdf = managerOpenPdfTabs.get(tabId);
    if (managerWorkspaceTab === tabId) {
      await managerRequestPdfFrameSave(tabId);
      window.clearTimeout(managerPdfNoteSaveTimer);
      await managerSaveActivePdfNotes().catch(() => {});
      if (bibManager.classList.contains('ctca-pdf-maximized')) managerSetPdfMaximized(false);
      managerWorkspaceTab = "bibliography";
      if (closingPdf?.draftId && managerDrafts.has(closingPdf.draftId)) {
        managerSelectedId = closingPdf.draftId;
        managerSelectedIds = new Set([closingPdf.draftId]);
        managerLastSelectionAnchorId = closingPdf.draftId;
      }
    }
    managerOpenPdfTabs.delete(tabId);
    managerRenderPdfTabs();
    await managerActivatePdfTab(managerWorkspaceTab);
  }

  async function managerSaveActivePdfNotes() {
    const data = managerOpenPdfTabs.get(managerWorkspaceTab); if (!data) return;
    const updated = await globalThis.CollabTeXAttachmentStore.update(data.attachment.id, { notes: bibManager.querySelector('.ctca-pdf-note').value });
    data.attachment = updated;
  }

  async function managerDownloadActivePdf() {
    const data = managerOpenPdfTabs.get(managerWorkspaceTab);
    if (!data) return;
    const blob = await globalThis.CollabTeXAttachmentStore.getBlob(data.attachment);
    if (!blob) return;
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = data.attachment.fileName || `${data.attachment.name}.pdf`;
    link.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function managerSetPdfPaneCollapsed(pane, collapsed, { trackFullscreenChange = true } = {}) {
    const data = managerOpenPdfTabs.get(managerWorkspaceTab); if (!data) return;
    data[pane === 'notes' ? 'notesCollapsed' : 'detailsCollapsed'] = Boolean(collapsed);
    if (
      trackFullscreenChange
      && bibManager.classList.contains('ctca-pdf-maximized')
      && managerPdfFullscreenPaneState?.state === data
    ) {
      managerPdfFullscreenPaneState[pane === 'notes' ? 'notesModified' : 'detailsModified'] = true;
    }
    const layout = bibManager.querySelector('.ctca-pdf-layout');
    layout.classList.toggle(
      pane === 'notes' ? 'ctca-pdf-notes-collapsed' : 'ctca-pdf-details-collapsed',
      Boolean(collapsed)
    );
    const collapseButton = bibManager.querySelector(
      pane === 'notes' ? '.ctca-pdf-collapse-notes' : '.ctca-pdf-collapse-details'
    );
    if (collapseButton) {
      collapseButton.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
      collapseButton.title = collapsed
        ? `Expand ${pane === 'notes' ? 'notes pane' : 'entry details'}`
        : `Collapse ${pane === 'notes' ? 'notes pane' : 'entry details'}`;
    }
  }

  function managerInitializePdfResizer(handle, kind) {
    handle?.addEventListener('pointerdown', (event) => {
      if (event.button !== 0) return;
      event.preventDefault();
      const start = event.clientX, startNotes = managerPdfNotesWidth, startDetails = managerPdfDetailsWidth;
      const layout = bibManager.querySelector('.ctca-pdf-layout');
      const move = (e) => {
        const delta = e.clientX - start;
        if (kind === 'notes') managerPdfNotesWidth = Math.max(240, Math.min(700, startNotes - delta));
        else managerPdfDetailsWidth = Math.max(280, Math.min(800, startDetails - delta));
        layout.style.setProperty('--ctca-pdf-notes-width', `${managerPdfNotesWidth}px`);
        layout.style.setProperty('--ctca-pdf-details-width', `${managerPdfDetailsWidth}px`);
      };
      const finish = () => { document.removeEventListener('pointermove', move, true); document.removeEventListener('pointerup', finish, true); };
      document.addEventListener('pointermove', move, true); document.addEventListener('pointerup', finish, true);
    });
  }

  function managerDetailInputChanged(event) {
    const draft = managerDrafts.get(managerSelectedId);
    if (!draft || managerBusy) return;
    const field = event.target.dataset.managerField;
    const property = event.target.dataset.managerProperty;
    if (field) {
      draft.fields[field] = event.target.value;
    } else if (property === "key") {
      draft.key = event.target.value.trim();
    } else if (property === "type") {
      draft.type = event.target.value;
    } else {
      return;
    }
    managerMarkDirty(draft, false);
    if (field === "author") renderManagerCategories();
    if (property === "key") {
      const keyLabel = bibManager.querySelector(".ctca-manager-detail-key");
      if (keyLabel) keyLabel.textContent = draft.key;
    }
    scheduleManagerListRender();
  }

  function managerStartInlineEdit(display) {
    const field = display?.dataset.managerInlineField;
    const draft = managerDrafts.get(managerSelectedId);
    if (!field || !draft || managerBusy || display.classList.contains("ctca-manager-inline-editing")) return false;

    const originalValue = String(draft.fields?.[field] || "");
    const textarea = document.createElement("textarea");
    textarea.className = "ctca-manager-inline-editor";
    textarea.value = originalValue;
    textarea.rows = field === "author" ? 5 : 2;
    textarea.setAttribute("aria-label", field === "author" ? "Edit authors" : "Edit title");
    display.classList.add("ctca-manager-inline-editing");
    display.replaceChildren(textarea);

    const authorIndex = field === "author"
      ? window.CollabTeXBibTeX.createAuthorIndex([...managerDrafts.values()].flatMap((item) => [
          item?.fields?.author || "",
          item?.fields?.editor || ""
        ]))
      : [];
    const completionElement = field === "author" ? document.createElement("div") : null;
    let authorCompletions = [];
    if (completionElement) {
      completionElement.className = "ctca-author-completion";
      completionElement.hidden = true;
      completionElement.setAttribute("role", "listbox");
      display.appendChild(completionElement);
    }

    const updateAuthorCompletion = () => {
      if (!completionElement) return;
      authorCompletions = textarea.selectionStart === textarea.selectionEnd
        ? window.CollabTeXBibTeX.findAuthorCompletions(
            authorIndex,
            textarea.value,
            textarea.selectionStart,
            8
          )
        : [];
      completionElement.replaceChildren(...authorCompletions.map((completion, index) => {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "ctca-completion-option";
        button.dataset.completionIndex = String(index);
        button.setAttribute("role", "option");
        const name = document.createElement("span");
        name.className = "ctca-completion-option-name";
        name.textContent = completion.label;
        button.appendChild(name);
        if (index === 0) {
          const hint = document.createElement("span");
          hint.className = "ctca-completion-option-hint";
          hint.textContent = "\u2192";
          hint.title = "Press Right Arrow to complete";
          button.appendChild(hint);
        }
        return button;
      }));
      completionElement.hidden = authorCompletions.length === 0;
      textarea.setAttribute("aria-expanded", String(authorCompletions.length > 0));
    };

    const acceptAuthorCompletion = (index = 0) => {
      const authorCompletion = authorCompletions[index];
      if (!authorCompletion) return false;
      textarea.setRangeText(
        authorCompletion.value,
        authorCompletion.start,
        authorCompletion.end,
        "end"
      );
      updateAuthorCompletion();
      return true;
    };

    let finished = false;
    const finish = (applyChange) => {
      if (finished) return;
      finished = true;
      if (applyChange && textarea.value !== originalValue) {
        draft.fields[field] = textarea.value;
        managerMarkDirty(draft, false);
        if (field === "author") renderManagerCategories();
        scheduleManagerListRender();
      }
      renderManagerDetails();
    };

    textarea.addEventListener("blur", () => finish(true), { once: true });
    textarea.addEventListener("input", updateAuthorCompletion);
    textarea.addEventListener("keyup", (event) => {
      if (event.key !== "ArrowRight") updateAuthorCompletion();
    });
    textarea.addEventListener("keydown", (event) => {
      if (event.key === "ArrowRight" && acceptAuthorCompletion()) {
        event.preventDefault();
      } else if (event.key === "Escape") {
        event.preventDefault();
        finish(false);
      } else if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
        event.preventDefault();
        textarea.blur();
      }
    });
    textarea.addEventListener("click", (event) => event.stopPropagation());
    completionElement?.addEventListener("mousedown", (event) => {
      const option = event.target.closest(".ctca-completion-option");
      if (!option) return;
      event.preventDefault();
      acceptAuthorCompletion(Number(option.dataset.completionIndex) || 0);
      textarea.focus();
    });
    completionElement?.addEventListener("click", (event) => event.stopPropagation());
    requestAnimationFrame(() => {
      textarea.focus();
      textarea.setSelectionRange(textarea.value.length, textarea.value.length);
      updateAuthorCompletion();
    });
    return true;
  }

  function managerDetailClicked(event) {
    const inlineDisplay = event.target.closest("[data-manager-inline-field]");
    if (inlineDisplay && managerStartInlineEdit(inlineDisplay)) {
      event.preventDefault();
      return;
    }
    managerDetailActionClicked(event);
  }

  function managerInlineDisplayKeydown(event) {
    if (!event.target.matches("[data-manager-inline-field]")) return;
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    managerStartInlineEdit(event.target);
  }

  async function managerDetailActionClicked(event) {
    const button = event.target.closest("button[data-manager-action]");
    if (!button || managerBusy) return;
    event.preventDefault();
    const draft = managerDrafts.get(managerSelectedId);
    if (!draft) return;
    const action = button.dataset.managerAction;

    if (action === "open-paper") {
      const url = managerPaperUrlFromDraft(draft);
      if (url) window.open(url, "_blank", "noopener,noreferrer");
      return;
    }
    if (action === "open-url") {
      const value = button.closest(".ctca-manager-url-row")?.querySelector('[data-manager-field="url"]')?.value || draft.fields?.url || "";
      try {
        const url = new URL(String(value).trim());
        if (!/^https?:$/.test(url.protocol)) throw new Error();
        window.open(url.href, "_blank", "noopener,noreferrer");
      } catch (_error) {
        managerSetStatus("Enter a valid HTTP or HTTPS URL first.", true);
      }
      return;
    }

    if (action === "add-pdf") {
      if (managerPdfAttachmentLoadingIds.has(draft.id)) return;
      try {
        await managerOpenAddPdfDialog(draft);
        await managerRenderPdfAttachmentList(draft);
      } catch (error) {
        managerSetStatus(error.message || String(error), true);
      }
      return;
    }
    if (action === "get-pdf-from-web") {
      if (managerPdfAttachmentLoadingIds.has(draft.id)) return;
      try {
        await managerOpenAddPdfDialog(draft, { getFromWeb: true });
        await managerRenderPdfAttachmentList(draft);
      } catch (error) {
        managerSetStatus(error.message || String(error), true);
      }
      return;
    }

    if (["open-pdf", "download-pdf", "rename-pdf", "replace-pdf", "remove-pdf"].includes(action)) {
      const attachments = await globalThis.CollabTeXAttachmentStore.list({ key: draft.key, fields: draft.fields });
      const attachment = attachments.find((item) => item.id === button.dataset.attachmentId);
      if (!attachment) return;

      if (action === "open-pdf") {
        await managerOpenPdfTab(draft, attachment);
        return;
      }
      if (action === "download-pdf") {
        try {
          await managerDownloadPdfAttachment(attachment);
          managerSetStatus(`Downloaded ${attachment.fileName || `${attachment.name}.pdf`}.`);
        } catch (error) {
          managerSetStatus(error?.message || String(error), true);
        }
        return;
      }

      if (action === "rename-pdf") {
        let input;
        const name = await showAppDialog({
          title: "Rename PDF attachment",
          controls: (container) => {
            const label = document.createElement("label");
            label.className = "ctca-app-dialog-field";
            label.innerHTML = `<span>Attachment name</span><input type="text" value="${managerEscapeHtml(attachment.name)}">`;
            input = label.querySelector("input");
            container.appendChild(label);
          },
          buttons: [
            { label: "Cancel", value: null },
            { label: "Rename", primary: true, getValue: () => input.value.trim() }
          ],
          closeValue: null
        });
        if (name) {
          const updated = await globalThis.CollabTeXAttachmentStore.update(attachment.id, { name });
          for (const data of managerOpenPdfTabs.values()) {
            if (data.attachment.id === updated.id) data.attachment = updated;
          }
          managerRenderPdfTabs();
          await managerRenderPdfAttachmentList(draft);
        }
        return;
      }

      if (action === "replace-pdf") {
        const input = document.createElement("input");
        input.type = "file";
        input.accept = "application/pdf,.pdf";
        input.addEventListener("change", async () => {
          if (!input.files[0]) return;
          try {
            const updated = await globalThis.CollabTeXAttachmentStore.replaceFile(attachment.id, input.files[0]);
            for (const data of managerOpenPdfTabs.values()) {
              if (data.attachment.id === updated.id) data.attachment = updated;
            }
            await managerRenderPdfAttachmentList(draft);
            if (managerOpenPdfTabs.has(`pdf:${attachment.id}`)) await managerActivatePdfTab(managerWorkspaceTab);
          } catch (error) {
            managerSetStatus(error.message || String(error), true);
          }
        }, { once: true });
        input.click();
        return;
      }

      const result = await showAppDialog({
        title: `Remove PDF “${attachment.name}”?`,
        message: attachment.provider === "nextcloud"
          ? "The PDF and its annotation sidecar will also be deleted from Nextcloud."
          : "The PDF attachment and its separate notes will be removed.",
        buttons: [{ label: "Cancel", value: false }, { label: "Remove", value: true, danger: true }],
        closeValue: false,
        danger: true
      });
      if (result) {
        await globalThis.CollabTeXAttachmentStore.remove(attachment.id);
        managerOpenPdfTabs.delete(`pdf:${attachment.id}`);
        if (managerWorkspaceTab === `pdf:${attachment.id}`) await managerActivatePdfTab("bibliography");
        await managerRenderPdfAttachmentList(draft);
      }
      return;
    }

    if (action === "add-tag") {
      if (managerAddTag(draft, button.dataset.tag || "")) {
        renderManagerDetails();
        requestAnimationFrame(() => bibManager.querySelector(".ctca-tag-input")?.focus());
      }
      return;
    }

    if (action === "remove-tag") {
      const remove = String(button.dataset.tag || "").toLocaleLowerCase();
      const tags = globalThis.CollabTeXSearchTools.splitTags(draft.fields?.[CTCA_TAGS_FIELD] || "").filter((tag) => tag.toLocaleLowerCase() !== remove);
      draft.fields[CTCA_TAGS_FIELD] = tags.join(", ");
      managerMarkDirty(draft);
      renderManagerDetails();
      return;
    }

    if (action === "remove-category-membership") {
      managerRemoveEntryFromCategory(draft.id, button.dataset.categoryId || "");
      return;
    }

    if (action === "add-field") {
      const select = bibManager.querySelector(".ctca-manager-add-field-select");
      const field = select?.value;
      if (field && !(field in draft.fields)) {
        draft.fields[field] = "";
        managerMarkDirty(draft);
        renderManagerDetails();
        bibManager.querySelector(`[data-manager-field="${CSS.escape(field)}"]`)?.focus();
      }
      return;
    }

    if (action === "remove-field") {
      delete draft.fields[button.dataset.field];
      managerMarkDirty(draft);
      renderManagerDetails();
      return;
    }

    if (action === "remove-entry") {
      const confirmed = await showAppDialog({
        title: `Remove ${draft.key}?`,
        message: `This entry will be marked for removal from ${draft.sourceFile || "the bibliography"}. When Update Bib writes the change, its attached PDFs will also be deleted from browser storage or Nextcloud.`,
        buttons: [
          { label: "Keep entry", value: false },
          { label: "Remove entry", value: true, danger: true }
        ],
        closeValue: false,
        danger: true
      });
      if (!confirmed) return;
      const centralChoices = await chooseManagerCentralDeletions([draft]);
      if (!centralChoices) return;

      managerDeletedDrafts.set(draft.id, draft);
      const deleteCentral = centralChoices.get(draft.id) === true;
      managerCentralDeletionChoices.set(draft.id, deleteCentral);
      if (deleteCentral) {
        managerPendingCentralDeletionIdentities.add(globalSyncIdentity(globalItemFromDraft(draft)));
      }
      managerDirtyIds.delete(draft.id);
      managerDrafts.delete(draft.id);
      managerMarkCategoryTreeDirty();
      managerRecords = managerRecords.filter((record) => managerRecordId(record) !== draft.id);
      managerSelectedIds.delete(draft.id);
      managerSelectedId = managerDrafts.keys().next().value || "";
      renderManagerCategories();
      renderManagerList();
      renderManagerDetails();
      updateManagerCount();
      managerSetStatus(
        `${draft.key} is marked for removal. Click Update Bib to write the change, or close the window to save it.`
      );
      return;
    }

    if (action === "update-doi") {
      const doi = normalizeDoiInput(draft.fields.doi || "");
      if (!doi) {
        managerSetStatus("Enter a DOI before requesting metadata.", true);
        return;
      }
      setManagerBusy(true, "Updating DOI…");
      managerSetStatus(`Retrieving metadata for ${doi}…`);
      try {
        const metadata = await fetchDoiMetadata(doi);
        const existingRecord = managerDraftToRecord(draft);
        const merged = metadataToBibFields(metadata, existingRecord);
        for (const [name, value] of Object.entries(merged)) {
          draft.fields[name] = stripOneBibDelimiter(value);
        }
        draft.fields.abstract = normalizeAbstractText(draft.fields.abstract || "");
        if (metadata.entryType && draft.type === "misc") draft.type = metadata.entryType;
        managerMarkDoiSynced(draft);
        managerMarkDirty(draft);
        renderManagerCategories();
        renderManagerList();
        renderManagerDetails();
        const updatedKey = draft.key;
        managerSetStatus(`Updated the ${updatedKey} draft from DOI metadata. Click Update Bib or close the window to write it to the document.`);
        showDoiSuccessToast(updatedKey, metadata.source);
      } catch (error) {
        managerSetStatus(error.message || String(error), true);
      } finally {
        setManagerBusy(false);
      }
    }
  }


  function managerBibImportLabel(item) {
    const fields = item?.fields || {};
    const title = stripOneBibDelimiter(fields.title || "Untitled reference");
    const doi = normalizeDoiInput(fields.doi || item?.doi || "");
    const source = item?.sourceFile ? ` · ${String(item.sourceFile).replace(/\\/g, "/").split("/").pop()}` : "";
    return `${item?.key || "(no citation key)"} — ${title}${doi ? ` · DOI ${doi}` : ""}${source}`;
  }

  function managerBuildBibImportPlan(currentDrafts, importedRecords) {
    const existing = currentDrafts.slice();
    const incoming = importedRecords.slice();
    const nodeCount = existing.length + incoming.length;
    const parent = Array.from({ length: nodeCount }, (_, index) => index);
    const find = (index) => {
      let value = index;
      while (parent[value] !== value) {
        parent[value] = parent[parent[value]];
        value = parent[value];
      }
      return value;
    };
    const unite = (left, right) => {
      const a = find(left), b = find(right);
      if (a !== b) parent[b] = a;
    };
    const keyOwner = new Map();
    const doiOwner = new Map();
    const all = [...existing, ...incoming];
    all.forEach((item, index) => {
      const key = String(item?.key || "").trim().toLowerCase();
      const doi = normalizeDoiInput(item?.fields?.doi || item?.doi || "").toLowerCase();
      if (key) {
        if (keyOwner.has(key)) unite(index, keyOwner.get(key));
        else keyOwner.set(key, index);
      }
      if (doi) {
        if (doiOwner.has(doi)) unite(index, doiOwner.get(doi));
        else doiOwner.set(doi, index);
      }
    });
    const components = new Map();
    all.forEach((_item, index) => {
      const rootIndex = find(index);
      if (!components.has(rootIndex)) components.set(rootIndex, { existingIndices: [], importIndices: [] });
      if (index < existing.length) components.get(rootIndex).existingIndices.push(index);
      else components.get(rootIndex).importIndices.push(index - existing.length);
    });
    const additions = [];
    const conflicts = [];
    for (const component of components.values()) {
      if (!component.importIndices.length) continue;
      if (!component.existingIndices.length && component.importIndices.length === 1) {
        additions.push(component.importIndices[0]);
        continue;
      }
      const componentItems = [
        ...component.existingIndices.map((index) => existing[index]),
        ...component.importIndices.map((index) => incoming[index])
      ];
      const keyCounts = new Map();
      const doiCounts = new Map();
      for (const item of componentItems) {
        const key = String(item?.key || "").trim().toLowerCase();
        const doi = normalizeDoiInput(item?.fields?.doi || item?.doi || "").toLowerCase();
        if (key) keyCounts.set(key, (keyCounts.get(key) || 0) + 1);
        if (doi) doiCounts.set(doi, (doiCounts.get(doi) || 0) + 1);
      }
      const duplicateKeys = [...keyCounts.entries()].filter(([, count]) => count > 1).map(([key]) => key);
      const duplicateDois = [...doiCounts.entries()].filter(([, count]) => count > 1).map(([doi]) => doi);
      const reasons = [];
      if (duplicateKeys.length) reasons.push(`Citation key: ${duplicateKeys.join(", ")}`);
      if (duplicateDois.length) reasons.push(`DOI: ${duplicateDois.join(", ")}`);
      conflicts.push({ ...component, reason: reasons.join(" · ") || "Matching bibliography entry" });
    }
    return { existing, incoming, additions, conflicts };
  }

  async function managerChooseBibImportConflicts(plan, fileName) {
    if (!plan.conflicts.length) return {};
    const choices = {};
    const result = await showAppDialog({
      title: "Resolve BibTeX import conflicts",
      message: `${plan.conflicts.length} conflict${plan.conflicts.length === 1 ? " was" : "s were"} found in ${fileName}. Choose which version to keep for each matching citation key or DOI.`,
      controls: (container) => {
        const list = document.createElement("div");
        list.className = "ctca-bib-import-conflict-list";
        plan.conflicts.forEach((conflict, conflictIndex) => {
          const row = document.createElement("fieldset");
          row.className = "ctca-nextcloud-conflict ctca-bib-import-conflict";
          row.dataset.conflictIndex = String(conflictIndex);
          const groupName = `ctca-import-${Math.random().toString(36).slice(2)}`;
          const existingLabels = conflict.existingIndices.map((index) => managerBibImportLabel(plan.existing[index]));
          const importedOptions = conflict.importIndices.map((index, optionIndex) => {
            const checked = !conflict.existingIndices.length && optionIndex === 0 ? " checked" : "";
            return `<label><input type="radio" name="${groupName}" value="import:${index}"${checked}><span><strong><span class="ctca-bib-import-conflict-source">Imported</span>Use imported entry</strong><small>${managerEscapeHtml(managerBibImportLabel(plan.incoming[index]))}</small></span></label>`;
          }).join("");
          row.innerHTML = `
            <legend>${managerEscapeHtml(conflict.reason)}</legend>
            ${conflict.existingIndices.length ? `<label><input type="radio" name="${groupName}" value="current" checked><span><strong><span class="ctca-bib-import-conflict-source">Current</span>Keep current project entr${conflict.existingIndices.length === 1 ? "y" : "ies"}</strong><small class="ctca-bib-import-conflict-current-list">${existingLabels.map((label) => `<span>${managerEscapeHtml(label)}</span>`).join("")}</small></span></label>` : ""}
            ${importedOptions}`;
          list.appendChild(row);
        });
        container.appendChild(list);
      },
      buttons: [
        { label: "Cancel import", value: null },
        {
          label: "Merge bibliography",
          primary: true,
          getValue: () => {
            for (const row of appDialog.querySelectorAll(".ctca-bib-import-conflict")) {
              const selected = row.querySelector('input[type="radio"]:checked');
              choices[Number(row.dataset.conflictIndex)] = selected?.value || "current";
            }
            return choices;
          }
        }
      ],
      closeValue: null
    });
    return result;
  }

  async function managerChooseBibImportFile() {
    return new Promise((resolve) => {
      const input = document.createElement("input");
      input.type = "file";
      input.accept = ".bib,application/x-bibtex,text/plain";
      input.addEventListener("change", () => resolve(input.files?.[0] || null), { once: true });
      input.click();
    });
  }

  async function managerImportBibFile() {
    if (managerBusy) return false;
    if (!managerFiles.length) await managerLoadBibliography({ saveDirty: false });
    const targetFile = managerFiles[0];
    if (!targetFile) {
      const completed = await importProjectBibliographyFromFile();
      if (completed && bibManager.classList.contains("ctca-manager-visible")) {
        await managerLoadBibliography({ saveDirty: false });
      }
      return completed;
    }

    const file = await managerChooseBibImportFile();
    if (!file) return false;
    const text = await file.text();
    const importedRecords = window.CollabTeXBibTeX.parseBibTeX(text, file.name);
    if (!importedRecords.length) throw new Error("The selected file contains no parseable BibTeX entries.");

    const plan = managerBuildBibImportPlan([...managerDrafts.values()], importedRecords);
    const choices = await managerChooseBibImportConflicts(plan, file.name);
    if (choices === null) return false;

    const selectedImportIndices = new Set(plan.additions);
    const selectedChoices = [];
    plan.conflicts.forEach((conflict, conflictIndex) => {
      const choice = choices[conflictIndex] || (conflict.existingIndices.length ? "current" : `import:${conflict.importIndices[0]}`);
      if (!choice.startsWith("import:")) return;
      const importIndex = Number(choice.slice("import:".length));
      if (!Number.isInteger(importIndex)) return;
      selectedImportIndices.add(importIndex);
      selectedChoices.push({ conflict, importIndex });
    });

    if (!selectedImportIndices.size) {
      managerSetStatus(`No entries were imported from ${file.name}; the current project versions were kept.`);
      return true;
    }

    setManagerBusy(true, "Importing bibliography…");
    let selectedDraftId = "";
    let replacedGroups = 0;
    try {
      const addImportedRecord = (record) => {
        const syntheticRecord = { ...record, sourceFile: targetFile, fields: { ...(record.fields || {}) } };
        const draft = draftFromRecord(syntheticRecord);
        draft.originalKey = "";
        draft.sourceFile = targetFile;
        if (!managerAddedOn(draft)) draft.fields[CTCA_ADDED_ON_FIELD] = new Date().toISOString();
        managerRecords.push(syntheticRecord);
        managerDrafts.set(draft.id, draft);
        managerDirtyIds.add(draft.id);
        selectedDraftId = selectedDraftId || draft.id;
        return draft;
      };

      const conflictImportIndices = new Set(selectedChoices.map((choice) => choice.importIndex));
      for (const { conflict, importIndex } of selectedChoices) {
        const imported = plan.incoming[importIndex];
        const matchingDrafts = conflict.existingIndices.map((index) => plan.existing[index]).filter(Boolean);
        if (matchingDrafts.length === 1) {
          const draft = matchingDrafts[0];
          const previousAddedOn = managerAddedOn(draft);
          draft.key = imported.key;
          draft.type = imported.type || "misc";
          draft.fields = normalizeFieldMapForEditing(imported.fields || {});
          if (!managerAddedOn(draft)) draft.fields[CTCA_ADDED_ON_FIELD] = previousAddedOn || new Date().toISOString();
          managerDirtyIds.add(draft.id);
          selectedDraftId = selectedDraftId || draft.id;
        } else {
          const removedIds = new Set();
          const inheritedCategories = new Set();
          for (const draft of matchingDrafts) {
            for (const categoryId of managerCategoryState.memberships?.[draft.id] || []) inheritedCategories.add(categoryId);
            managerDeletedDrafts.set(draft.id, draft);
            managerDirtyIds.delete(draft.id);
            managerDrafts.delete(draft.id);
            managerSelectedIds.delete(draft.id);
            removedIds.add(draft.id);
          }
          if (removedIds.size) managerRecords = managerRecords.filter((record) => !removedIds.has(managerRecordId(record)));
          const addedDraft = addImportedRecord(imported);
          if (inheritedCategories.size) managerCategoryState.memberships[addedDraft.id] = [...inheritedCategories];
        }
        if (matchingDrafts.length) replacedGroups += 1;
      }

      for (const importIndex of [...selectedImportIndices].sort((left, right) => left - right)) {
        if (conflictImportIndices.has(importIndex)) continue;
        addImportedRecord(plan.incoming[importIndex]);
      }

      managerSessionChanged = true;
      for (const id of managerDirtyIds) {
        const dirtyDraft = managerDrafts.get(id);
        if (dirtyDraft) scheduleFastManagerCentralSync(dirtyDraft);
      }
      managerSelectedIds = selectedDraftId ? new Set([selectedDraftId]) : new Set();
      managerSelectedId = selectedDraftId || managerSelectedId;
      const preferredKey = plan.incoming[[...selectedImportIndices][0]]?.key || "";
      if (preferredKey) {
        const preferred = [...managerDrafts.values()].find((draft) => draft.key === preferredKey);
        if (preferred) managerSelectedId = preferred.id;
      }
      renderManagerCategories();
      renderManagerList();
      renderManagerDetails();
      updateManagerCount();
      const skipped = Math.max(0, importedRecords.length - selectedImportIndices.size);
      managerSetStatus(
        `Prepared ${selectedImportIndices.size} entr${selectedImportIndices.size === 1 ? "y" : "ies"} from ${file.name}` +
        `${replacedGroups ? `, replacing ${replacedGroups} conflicting project selection${replacedGroups === 1 ? "" : "s"}` : ""}` +
        `${skipped ? `; kept the current version for ${skipped} imported conflict${skipped === 1 ? "" : "s"}` : ""}. ` +
        "Click Update Bib or close the window to write them to the document."
      );
      return true;
    } finally {
      setManagerBusy(false);
    }
  }

  async function managerOpenAddEntryDialog() {
    if (managerBusy) return;
    if (!managerFiles.length) await managerLoadBibliography({ saveDirty: false });
    const targetFile = managerFiles[0];
    if (!targetFile) {
      managerSetStatus("No writable BibTeX file is configured.", true);
      return;
    }
    let form = null;
    let extraContainer = null;
    const result = await showAppDialog({
      title: "Add bibliography entry",
      message: `The new entry will be saved to ${targetFile}.`,
      dialogClass: "ctca-add-entry-dialog-card",
      controls: (container) => {
        form = document.createElement("div");
        form.className = "ctca-add-entry-form";
        form.innerHTML = `
          <label class="ctca-app-dialog-field ctca-add-entry-wide"><span>DOI</span><span class="ctca-add-entry-doi-row"><input data-add-field="doi" placeholder="10.xxxx/…"><button type="button" class="ctca-add-entry-fetch-doi">🌐 Pull metadata</button></span></label>
          <label class="ctca-app-dialog-field ctca-add-entry-third"><span>Entry type</span><select data-add-property="type">${BIB_ENTRY_TYPES.map((type) => `<option value="${type}"${type === "article" ? " selected" : ""}>${type}</option>`).join("")}</select></label>
          <label class="ctca-app-dialog-field ctca-add-entry-two-thirds"><span>Citation key</span><input data-add-property="key" placeholder="Generated when empty"></label>
          <label class="ctca-app-dialog-field ctca-add-entry-half"><span>Title</span><textarea rows="2" data-add-field="title"></textarea></label>
          <label class="ctca-app-dialog-field ctca-add-entry-half"><span>Authors</span><textarea rows="3" data-add-field="author" placeholder="Family, Given and Family, Given"></textarea></label>
          <label class="ctca-app-dialog-field ctca-add-entry-wide"><span>Journal / book title</span><input data-add-field="journal"></label>
          <label class="ctca-app-dialog-field ctca-add-entry-third"><span>Year</span><input data-add-field="year"></label>
          <label class="ctca-app-dialog-field ctca-add-entry-third"><span>Volume</span><input data-add-field="volume"></label>
          <label class="ctca-app-dialog-field ctca-add-entry-third"><span>Pages</span><input data-add-field="pages"></label>
          <label class="ctca-app-dialog-field ctca-add-entry-half"><span>Abstract</span><textarea rows="5" data-add-field="abstract"></textarea></label>
          <label class="ctca-app-dialog-field ctca-add-entry-half"><span>Tags</span><input data-add-field="${CTCA_TAGS_FIELD}" list="ctca-add-entry-tag-list" placeholder="Comma-separated tags"><datalist id="ctca-add-entry-tag-list">${managerAllKnownTags().map((tag) => `<option value="${managerEscapeHtml(tag)}"></option>`).join("")}</datalist></label>
          <div class="ctca-add-entry-extra-section ctca-add-entry-wide"><h3>Additional BibTeX fields</h3><div class="ctca-add-entry-extra-list"></div><div class="ctca-add-entry-field-picker"><select>${AVAILABLE_BIB_FIELDS.map((name) => `<option value="${name}">${name}</option>`).join("")}</select><button type="button">+ Add additional field</button></div></div>
          <div class="ctca-add-entry-status ctca-add-entry-wide" aria-live="polite"></div>
        `;
        container.appendChild(form);
        extraContainer = form.querySelector(".ctca-add-entry-extra-list");
        form.querySelector(".ctca-add-entry-field-picker button").addEventListener("click", () => {
          const name = form.querySelector(".ctca-add-entry-field-picker select").value;
          if (!name || form.querySelector(`[data-add-field="${CSS.escape(name)}"]`)) return;
          const row = document.createElement("label");
          row.className = "ctca-add-entry-extra-row";
          row.innerHTML = `<span>${managerEscapeHtml(name)}</span><textarea rows="2" data-add-field="${managerEscapeHtml(name)}"></textarea><button type="button" title="Remove field">×</button>`;
          row.querySelector("button").addEventListener("click", () => row.remove());
          extraContainer.appendChild(row);
        });
        form.querySelector(".ctca-add-entry-fetch-doi").addEventListener("click", async (event) => {
          const doi = normalizeDoiInput(form.querySelector('[data-add-field="doi"]').value);
          const status = form.querySelector(".ctca-add-entry-status");
          if (!doi) { status.textContent = "Enter a DOI first."; return; }
          event.currentTarget.disabled = true;
          status.textContent = `Retrieving ${doi}…`;
          try {
            const metadata = await fetchDoiMetadata(doi);
            const merged = metadataToBibFields(metadata, { type: "misc", fields: {} });
            for (const [name, value] of Object.entries(merged)) {
              const input = form.querySelector(`[data-add-field="${CSS.escape(name)}"]`);
              if (input) input.value = stripOneBibDelimiter(value);
            }
            if (metadata.entryType) form.querySelector('[data-add-property="type"]').value = metadata.entryType;
            status.textContent = `Metadata loaded from ${metadata.source}.`;
          } catch (error) {
            status.textContent = error.message || String(error);
          } finally {
            event.currentTarget.disabled = false;
          }
        });
      },
      buttons: [
        { label: "Abort", value: null },
        { label: "Save entry", primary: true, getValue: () => {
          const fields = {};
          form.querySelectorAll("[data-add-field]").forEach((input) => { if (input.value.trim()) fields[input.dataset.addField] = input.value.trim(); });
          return { type: form.querySelector('[data-add-property="type"]').value, key: form.querySelector('[data-add-property="key"]').value.trim(), fields };
        }}
      ],
      closeValue: null
    });
    if (!result) return;
    let key = result.key;
    if (!key) {
      const metadata = {
        authors: window.CollabTeXBibTeX.splitAuthorsRaw(result.fields.author || "")
          .map((name) => ({ family: window.CollabTeXBibTeX.authorFamilyName(name) })),
        year: result.fields.year || ""
      };
      key = generateCitationKey(metadata, [...managerDrafts.values()].map((draft) => draft.key));
    }
    if ([...managerDrafts.values()].some((draft) => draft.key.toLowerCase() === key.toLowerCase())) {
      managerSetStatus(`The citation key ${key} already exists.`, true);
      return;
    }
    const syntheticRecord = { key, type: result.type || "misc", sourceFile: targetFile, fields: Object.fromEntries(Object.entries(result.fields).map(([name, value]) => [name, managerWrapBibValue(value)])) };
    const draft = draftFromRecord(syntheticRecord);
    draft.originalKey = "";
    draft.key = key;
    draft.fields = { ...result.fields, [CTCA_ADDED_ON_FIELD]: new Date().toISOString() };
    managerRecords.push(syntheticRecord);
    managerDrafts.set(draft.id, draft);
    managerDirtyIds.add(draft.id);
    managerSessionChanged = true;
    managerSelectedIds = new Set([draft.id]);
    managerSelectedId = draft.id;
    scheduleFastManagerCentralSync(draft);
    renderManagerCategories();
    renderManagerList();
    renderManagerDetails();
    updateManagerCount();
    managerSetStatus(`Prepared ${key}. Click Update Bib or close the window to add it to ${targetFile}.`);
  }

  async function managerUpdateSelectedEntriesFromDoi() {
    if (managerBusy) return;
    const selectedTargets = [...managerSelectedIds].map((id) => managerDrafts.get(id)).filter(Boolean);
    if (selectedTargets.length < 2) return;
    await managerRunDoiBatch(selectedTargets, "selected");
  }

  async function managerUpdateAllEntriesFromDoi() {
    if (managerBusy) return;
    await managerRunDoiBatch(
      [...managerDrafts.values()].filter((draft) => draft?.centralPreview !== true),
      "bibliography"
    );
  }

  async function managerRunDoiBatch(candidateTargets, scopeLabel = "bibliography") {
    if (managerBusy) return;
    // Central-database preview rows are deliberately read-only. Including them
    // here made a successful metadata lookup increase the "updated" counter even
    // though managerMarkDirty() correctly refused to persist the preview.
    const allTargets = candidateTargets.filter((draft) =>
      draft?.centralPreview !== true &&
      managerDrafts.get(draft?.id) === draft &&
      Boolean(normalizeDoiInput(draft?.fields?.doi || ""))
    );
    if (!allTargets.length) {
      managerSetStatus(scopeLabel === "selected" ? "None of the selected entries contains a DOI." : "No bibliography entries with a DOI are available.", true);
      return;
    }
    const previouslySynchronized = allTargets.filter((draft) => managerWasDoiSynced(draft));
    const decision = await showBatchDoiConfirmation(allTargets.length, previouslySynchronized.length);
    if (!decision) return;
    const targets = decision.includePreviouslySynchronized ? allTargets : allTargets.filter((draft) => !managerWasDoiSynced(draft));
    const skippedSynchronized = allTargets.length - targets.length;
    if (!targets.length) {
      managerSetStatus(`All ${allTargets.length} DOI entries have already been synchronized; no update was started.`);
      return;
    }
    let processed = 0, updated = 0, failed = 0;
    const failures = [];
    let finalSummary = "";
    managerBulkDoiAbortRequested = false;
    managerBulkDoiActiveRequestId = "";
    managerBulkDoiStats = { processed, total: targets.length, updated, failed };
    setManagerBusy(true, "Updating DOI…");
    managerSetProgress(0, targets.length, `0/${targets.length} processed · 0 updated · 0 failed`, true);
    try {
      for (const draft of targets) {
        if (managerBulkDoiAbortRequested) break;
        const doi = normalizeDoiInput(draft.fields?.doi || "");
        managerSetStatus(`Retrieving DOI metadata ${processed + 1}/${targets.length}: ${draft.key} · ${failed} failed`);
        const requestId = `ctca-manager-doi-${Date.now()}-${processed + 1}`;
        managerBulkDoiActiveRequestId = requestId;
        try {
          const metadata = await fetchDoiMetadata(doi, requestId);
          if (managerBulkDoiAbortRequested) break;
          if (draft.centralPreview === true || managerDrafts.get(draft.id) !== draft) {
            throw new Error("entry is no longer a writable bibliography draft");
          }
          const merged = metadataToBibFields(metadata, managerDraftToRecord(draft));
          for (const [name, value] of Object.entries(merged)) draft.fields[name] = stripOneBibDelimiter(value);
          draft.fields.abstract = normalizeAbstractText(draft.fields.abstract || "");
          if (metadata.entryType && draft.type === "misc") draft.type = metadata.entryType;
          managerMarkDoiSynced(draft);
          managerMarkDirty(draft, false);
          updated += 1;
        } catch (error) {
          if (managerBulkDoiAbortRequested) break;
          failed += 1;
          failures.push(`${draft.key}: ${error?.message || String(error)}`);
        } finally {
          managerBulkDoiActiveRequestId = "";
        }
        if (managerBulkDoiAbortRequested) break;
        processed += 1;
        managerBulkDoiStats = { processed, total: targets.length, updated, failed };
        managerSetProgress(processed, targets.length, `${processed}/${targets.length} processed · ${updated} updated · ${failed} failed`, true);
        if (processed < targets.length) await delay(DOI_BULK_DELAY_MS);
      }
      renderManagerList();
      if (managerSelectedId) renderManagerDetails();
      const notProcessed = Math.max(0, targets.length - processed);
      const skippedPart = skippedSynchronized ? ` · ${skippedSynchronized} previously synchronized skipped` : "";
      finalSummary = managerBulkDoiAbortRequested
        ? `DOI draft update aborted · ${processed}/${targets.length} processed · ${updated} updated · ${failed} failed · ${notProcessed} not processed${skippedPart}`
        : `DOI draft update completed · ${processed}/${targets.length} processed · ${updated} updated · ${failed} failed${skippedPart}`;
      const examples = failures.slice(0, 3).join("; ");
      const writeHint = updated ? " · Click Update Bib or close the window to write the changes to the document." : "";
      managerSetStatus(`${finalSummary}${writeHint}${examples ? ` · Failures: ${examples}${failures.length > 3 ? "; …" : ""}` : ""}`, failed > 0 && updated === 0);
      managerSetProgress(processed, targets.length, finalSummary, true, { final: true });
    } catch (error) {
      finalSummary = `DOI update stopped · ${processed}/${targets.length} processed · ${updated} updated · ${failed + 1} failed`;
      managerSetStatus(`${finalSummary} · ${error?.message || String(error)}`, true);
      managerSetProgress(processed, targets.length, finalSummary, true, { final: true });
    } finally {
      managerBulkDoiActiveRequestId = "";
      managerBulkDoiAbortRequested = false;
      managerBulkDoiStats = null;
      setManagerBusy(false);
      if (!finalSummary) managerSetProgress(0, 1, "", false);
    }
  }

  function managerWrapBibValue(value) {
    const text = String(value ?? "").trim();
    if (!text) return "";
    return `{${text}}`;
  }

  function encodeCtcaMetadata(value) {
    const bytes = new TextEncoder().encode(String(value || ""));
    let binary = "";
    for (let index = 0; index < bytes.length; index += 0x8000) binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
    return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
  }

  function decodeCtcaMetadata(value) {
    try {
      const normalized = String(value || "").replace(/-/g, "+").replace(/_/g, "/");
      const padded = normalized + "=".repeat((4 - normalized.length % 4) % 4);
      const binary = atob(padded);
      const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
      return new TextDecoder().decode(bytes);
    } catch (_error) { return ""; }
  }

  function managerEncodedCategoryTree() {
    return encodeCtcaMetadata(JSON.stringify({
      version: CATEGORY_STATE_VERSION,
      updatedAt: new Date().toISOString(),
      categories: managerCategoryState.categories.map((category) => ({ id: category.id, name: category.name, parentId: category.parentId || "", order: Number(category.order) || 0 }))
    }));
  }

  function managerCategoryCarrierId(fileName) {
    return [...managerDrafts.values()].filter((draft) => bibSourceMatches(draft.sourceFile, fileName)).sort((a, b) => a.key.localeCompare(b.key))[0]?.id || "";
  }

  function managerFieldsWithEmbeddedState(draft) {
    const fields = Object.fromEntries(Object.entries(draft.fields || {}).filter(([name]) => !CTCA_INTERNAL_FIELDS.has(name)));
    fields[CTCA_META_VERSION_FIELD] = CTCA_META_VERSION;
    const tags = globalThis.CollabTeXSearchTools.splitTags(draft.fields?.[CTCA_TAGS_FIELD] || "");
    if (tags.length) fields[CTCA_TAGS_FIELD] = tags.join(", ");
    const carrierId = managerCategoryCarrierId(draft.sourceFile);
    if (carrierId === draft.id && managerCategoryState.categories.length) fields[CTCA_CATEGORY_TREE_FIELD] = managerEncodedCategoryTree();
    const categoryIds = managerEntryCategoryIds(draft.id);
    if (categoryIds.length) fields[CTCA_CATEGORY_IDS_FIELD] = categoryIds.join(",");
    const synchronizedAt = managerDoiSyncedAt(draft);
    if (synchronizedAt) fields[CTCA_DOI_SYNC_FIELD] = synchronizedAt;
    const addedOn = managerAddedOn(draft);
    if (addedOn) fields[CTCA_ADDED_ON_FIELD] = addedOn;
    if (CTCA_STARRED_FIELD in (draft.fields || {})) {
      fields[CTCA_STARRED_FIELD] = managerIsStarred(draft) ? "true" : "false";
    }
    return fields;
  }

  function restoreEmbeddedManagerState(sourceRecords) {
    const memberships = {};
    const ledger = {};
    const treeCandidates = [];
    for (const record of sourceRecords || []) {
      const fields = record.fields || {};
      const treeValue = stripOneBibDelimiter(fields[CTCA_CATEGORY_TREE_FIELD] || "");
      if (treeValue) {
        try { treeCandidates.push(JSON.parse(decodeCtcaMetadata(treeValue))); } catch (_error) {}
      }
      const ids = stripOneBibDelimiter(fields[CTCA_CATEGORY_IDS_FIELD] || "").split(/[;,\s]+/).filter(Boolean);
      if (ids.length) memberships[managerRecordId(record)] = [...new Set(ids)];
      const doi = managerDoiSyncKey(record);
      const synced = stripOneBibDelimiter(fields[CTCA_DOI_SYNC_FIELD] || "");
      if (doi && synced) ledger[doi] = synced;
    }
    treeCandidates.sort((a, b) => String(b?.updatedAt || "").localeCompare(String(a?.updatedAt || "")));
    managerCategoryState = normalizeManagerCategoryState({ version: CATEGORY_STATE_VERSION, categories: treeCandidates[0]?.categories || [], memberships });
    doiSyncLedger = ledger;
  }

  function managerMarkEntriesStateDirty(entryIds) {
    managerSessionChanged = true;
    for (const id of entryIds || []) {
      const draft = managerDrafts.get(id);
      if (!draft || draft.centralPreview === true) continue;
      managerDirtyIds.add(id);
      scheduleFastManagerCentralSync(draft);
    }
    updateManagerCount();
  }

  function managerMarkCategoryTreeDirty() {
    managerSessionChanged = true;
    const files = new Set([...managerDrafts.values()].map((draft) => draft.sourceFile));
    for (const fileName of files) {
      const carrierId = managerCategoryCarrierId(fileName);
      if (!carrierId) continue;
      managerDirtyIds.add(carrierId);
      const carrier = managerDrafts.get(carrierId);
      if (carrier) scheduleFastManagerCentralSync(carrier);
    }
    updateManagerCount();
  }

  function managerSerializedFields(draft) {
    const result = {};
    for (const [name, value] of Object.entries(managerFieldsWithEmbeddedState(draft))) {
      const wrapped = managerWrapBibValue(value);
      if (wrapped) result[name] = wrapped;
    }
    return result;
  }

  function managerDraftToRecord(draft) {
    const serialized = serializeBibEntry(draft.type, draft.key, managerSerializedFields(draft));
    const parsed = window.CollabTeXBibTeX.parseBibTeX(serialized, draft.sourceFile)[0];
    return parsed || {
      key: draft.key,
      type: draft.type,
      sourceFile: draft.sourceFile,
      fields: managerSerializedFields(draft),
      title: draft.fields.title || draft.key,
      authors: window.CollabTeXBibTeX.splitAuthors(draft.fields.author || ""),
      year: draft.fields.year || "",
      doi: normalizeDoiInput(draft.fields.doi || "")
    };
  }

  function serializeManagerDraft(draft) {
    return serializeBibEntry(draft.type || "misc", draft.key, managerSerializedFields(draft));
  }

  function getMainDocumentName() {
    const selectedOption = document.querySelector('select[name="rootDoc_id"] option:checked');
    const optionName = selectedOption?.textContent?.trim();
    if (optionName && /\.tex$/i.test(optionName)) return optionName;
    const mainButton = findFileButton("main.tex");
    if (mainButton) return "main.tex";
    const texItem = [...document.querySelectorAll('.file-tree-list [role="treeitem"][aria-label$=".tex" i]')][0];
    return texItem?.getAttribute("aria-label") || "";
  }

  async function waitForMainDocumentState(timeoutMs = 45000) {
    const deadline = Date.now() + Math.max(5000, Number(timeoutMs) || 45000);
    let lastError = null;

    while (Date.now() < deadline) {
      const mainName = getMainDocumentName();
      if (!mainName || isSourceEditorLoading()) {
        await delay(200);
        continue;
      }

      try {
        const response = await bridgeRequest("getState", {}, 2000);
        const state = response.state;
        if (state && bibSourceMatches(state.fileName, mainName) && !isSourceEditorLoading()) {
          const firstFingerprint = contentFingerprint(state.value);
          await delay(250);
          const confirmation = (await bridgeRequest("getState", {}, 2000)).state;
          if (
            confirmation &&
            bibSourceMatches(confirmation.fileName, mainName) &&
            contentFingerprint(confirmation.value) === firstFingerprint &&
            !isSourceEditorLoading()
          ) {
            return confirmation;
          }
        }

        // The project tree and ACE bridge are ready, so it is now safe to open
        // the actual root document. The startup prompt is not shown before this
        // operation has completed and the editor content has stabilized.
        return await openFileAndWait(mainName);
      } catch (error) {
        lastError = error;
        await delay(250);
      }
    }

    throw new Error(
      lastError?.message ||
      "The main TeX document did not finish loading. Open it once and retry the bibliography setup."
    );
  }

  async function getManagerTexState() {
    return waitForMainDocumentState();
  }

  function normalizeBibFileName(value) {
    let name = String(value ?? "").trim().replace(/^['"]|['"]$/g, "");
    if (!name) return "";
    if (!/\.bib$/i.test(name)) name += ".bib";
    return name;
  }

  function buildBibliographyDeclaration(tex, fileName) {
    if (/\\usepackage(?:\[[^\]]*\])?\{biblatex\}/i.test(tex)) {
      return { line: `\\addbibresource{${fileName}}`, marker: /\\begin\{document\}/i, beforeMarker: true };
    }
    const base = fileName.replace(/\.bib$/i, "");
    return { line: `\\bibliography{${base}}`, marker: /\\end\{document\}/i, beforeMarker: true };
  }

  async function addBibliographyDeclaration(texState, fileName) {
    const declaration = buildBibliographyDeclaration(texState.value, fileName);
    const match = declaration.marker.exec(texState.value);
    const index = match ? match.index : texState.value.length;
    const before = texState.value.slice(0, index);
    const prefix = before.endsWith("\n") || !before ? "" : "\n";
    const suffix = match ? "\n" : (texState.value.endsWith("\n") ? "" : "\n");
    const text = `${prefix}${declaration.line}${suffix}`;
    const expectedValue = `${texState.value.slice(0, index)}${text}${texState.value.slice(index)}`;
    await replaceEditorRangeAndVerify({
      fileName: texState.fileName,
      start: index,
      end: index,
      text,
      expectedValue
    });
    return declaration.line;
  }

  function findNewFileToolbarButton() {
    const buttons = [...document.querySelectorAll(
      ".toolbar-filetree button, .file-tree-toolbar-action-buttons button, .file-tree-toolbar button"
    )];
    return buttons.find((button) => /new file/i.test(
      button.getAttribute("aria-label") ||
      button.textContent ||
      button.querySelector(".sr-only, .visually-hidden")?.textContent ||
      ""
    )) || buttons[0] || null;
  }

  function setNativeInputValue(input, value) {
    const descriptor = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), "value");
    descriptor?.set?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  }

  async function waitForCondition(callback, timeoutMs = 8000, intervalMs = 100) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const value = callback();
      if (value) return value;
      await delay(intervalMs);
    }
    return null;
  }

  async function waitForEditorFileValue(fileName, expectedValue, timeoutMs = 15000) {
    const deadline = Date.now() + Math.max(1000, Number(timeoutMs) || 15000);
    const expected = String(expectedValue ?? "");
    while (Date.now() < deadline) {
      try {
        const state = (await bridgeRequest("getState", {}, 2000)).state;
        if (
          state &&
          bibSourceMatches(state.fileName, fileName) &&
          String(state.value ?? "") === expected
        ) {
          return state;
        }
      } catch (_error) {
        // ACE can briefly be unavailable while ColLabTeX swaps sessions.
      }
      await delay(100);
    }
    return null;
  }

  async function replaceEditorRangeAndVerify({ fileName, start, end, text, expectedValue, timeoutMs = 15000 }) {
    await bridgeRequest("replaceRange", { start, end, text }, timeoutMs);
    const state = await waitForEditorFileValue(fileName, expectedValue, timeoutMs);
    if (!state) {
      throw new Error(`Writing ${fileName} did not produce the expected document state.`);
    }
    return state;
  }

  async function createProjectFile(fileName) {
    if (findFileButton(fileName)) return false;
    const button = findNewFileToolbarButton();
    if (!button) throw new Error("The ColLabTeX New File button could not be found.");
    button.click();

    const input = await waitForCondition(() => {
      const candidates = [...document.querySelectorAll('.modal input[type="text"], .modal input:not([type]), .file-tree input[type="text"], input[placeholder*="file" i]')];
      return candidates.find(isElementVisible) || null;
    }, 8000);
    if (!input) throw new Error("The ColLabTeX new-file dialog did not appear.");
    setNativeInputValue(input, fileName);
    input.focus();

    const dialog = input.closest(".modal, form, .file-tree") || document;
    const candidates = [...dialog.querySelectorAll('button[type="submit"], .btn-primary, button')]
      .filter(isElementVisible);
    const submit = candidates.find((candidate) =>
      /create|add|ok|new file/i.test(candidate.textContent || candidate.getAttribute("aria-label") || "")
    ) || candidates.find((candidate) => candidate.matches('button[type="submit"], .btn-primary'));
    if (submit) {
      submit.click();
    } else if (input.form?.requestSubmit) {
      input.form.requestSubmit();
    } else {
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", bubbles: true }));
      input.dispatchEvent(new KeyboardEvent("keyup", { key: "Enter", code: "Enter", bubbles: true }));
    }

    const created = await waitForCondition(() => findFileButton(fileName), 12000);
    if (!created) throw new Error(`ColLabTeX did not create ${fileName}.`);
    return true;
  }


  function isSampleBibliographyFile(fileName) {
    return normalizeBibSourceName(normalizeBibFileName(fileName)).split("/").pop() === "sample.bib";
  }

  function bibliographyDatabaseToText(database) {
    if (typeof globalThis.CollabTeXAttachmentStore?.databaseToBib !== "function") {
      throw new Error("The bibliography serializer is not available.");
    }
    return globalThis.CollabTeXAttachmentStore.databaseToBib(database || { entries: [] });
  }

  function bibliographyTextToDatabase(text) {
    if (typeof globalThis.CollabTeXAttachmentStore?.bibToDatabase !== "function") {
      throw new Error("The bibliography parser is not available.");
    }
    return globalThis.CollabTeXAttachmentStore.bibToDatabase(String(text || ""));
  }

  function mergeBibliographyText(existingText, incomingText) {
    const existing = bibliographyTextToDatabase(existingText);
    const incoming = bibliographyTextToDatabase(incomingText);
    const byKey = new Map();
    for (const entry of existing.entries || []) {
      byKey.set(String(entry.key || "").toLowerCase(), entry);
    }
    for (const entry of incoming.entries || []) {
      byKey.set(String(entry.key || "").toLowerCase(), entry);
    }
    const validKeys = new Set([...byKey.values()].map((entry) => entry.key));
    const memberships = { ...(existing.memberships || {}) };
    for (const [key, ids] of Object.entries(incoming.memberships || {})) memberships[key] = [...new Set(ids || [])];
    for (const key of Object.keys(memberships)) if (!validKeys.has(key)) delete memberships[key];
    return bibliographyDatabaseToText({
      version: 3,
      entries: [...byKey.values()],
      categories: (incoming.categories || []).length ? incoming.categories : (existing.categories || []),
      memberships,
      deletedEntries: incoming.deletedEntries || [],
      updatedAt: new Date().toISOString()
    });
  }

  async function replaceOrAddBibliographyDeclaration(texState, fileName) {
    const targetFile = normalizeBibFileName(fileName);
    const targetBase = targetFile.replace(/\.bib$/i, "");
    const tex = String(texState?.value || "");
    let replacement = null;

    const biblatexPattern = /\\(addbibresource|addglobalbib|addsectionbib)(\s*(?:\[[^\]]*\]\s*)?\{)([^{}]+)(\})/gi;
    let match;
    while ((match = biblatexPattern.exec(tex)) !== null) {
      if (!isSampleBibliographyFile(match[3])) continue;
      replacement = {
        start: match.index,
        end: match.index + match[0].length,
        text: `\\${match[1]}${match[2]}${targetFile}${match[4]}`
      };
      break;
    }

    if (!replacement) {
      const bibliographyPattern = /\\bibliography\s*\{([^{}]+)\}/gi;
      while ((match = bibliographyPattern.exec(tex)) !== null) {
        const names = match[1].split(",").map((value) => value.trim()).filter(Boolean);
        if (!names.some(isSampleBibliographyFile)) continue;
        const nextNames = [];
        for (const name of names) {
          const next = isSampleBibliographyFile(name) ? targetBase : name.replace(/\.bib$/i, "");
          if (!nextNames.some((item) => item.toLowerCase() === next.toLowerCase())) nextNames.push(next);
        }
        replacement = {
          start: match.index,
          end: match.index + match[0].length,
          text: `\\bibliography{${nextNames.join(",")}}`
        };
        break;
      }
    }

    if (replacement) {
      const expectedValue = `${tex.slice(0, replacement.start)}${replacement.text}${tex.slice(replacement.end)}`;
      await replaceEditorRangeAndVerify({
        fileName: texState.fileName,
        ...replacement,
        expectedValue
      });
      return replacement.text;
    }

    const configured = findBibliographyFiles(tex, texState?.cursorIndex || 0);
    if (configured.some((name) => bibSourceMatches(name, targetFile))) return "";
    return addBibliographyDeclaration(texState, targetFile);
  }

  async function writeProjectBibliographyFile(fileName, incomingText) {
    const target = normalizeBibFileName(fileName);
    await createProjectFile(target);
    const state = await openFileAndWait(target);
    if (!bibSourceMatches(state?.fileName, target)) {
      throw new Error(`ColLabTeX did not expose ${target} for writing.`);
    }
    const existingText = String(state?.value || "");
    const finalText = existingText.trim()
      ? mergeBibliographyText(existingText, incomingText)
      : String(incomingText || "").replace(/\r\n?/g, "\n").trimEnd() + "\n";
    const parsed = window.CollabTeXBibTeX.parseBibTeX(finalText, target);
    if (!parsed.length) throw new Error("The selected bibliography contains no parseable BibTeX entries.");
    if (existingText === finalText) return { fileName: target, text: finalText, records: parsed, changed: false };
    if (existingText.trim()) {
      await saveAutomaticBibBackup(target, existingText, window.CollabTeXBibTeX.parseBibTeX(existingText, target).length, "Before project bibliography setup");
    }
    await replaceEditorRangeAndVerify({
      fileName: target,
      start: 0,
      end: existingText.length,
      text: finalText,
      expectedValue: finalText,
      timeoutMs: 20000
    });
    return { fileName: target, text: finalText, records: parsed, changed: true };
  }

  async function importBibTextIntoGlobalDatabase(text, source = "project-setup") {
    const imported = bibliographyTextToDatabase(text);
    if (!(imported.entries || []).length) throw new Error("The selected bibliography contains no parseable BibTeX entries.");
    const current = await loadGlobalDatabaseState();
    const byKey = new Map((current.entries || []).map((entry) => [String(entry.key || "").toLowerCase(), entry]));
    for (const entry of imported.entries || []) byKey.set(String(entry.key || "").toLowerCase(), entry);
    const validKeys = new Set([...byKey.values()].map((entry) => entry.key));
    const categories = (imported.categories || []).length ? imported.categories : (current.categories || []);
    const memberships = { ...(current.memberships || {}), ...(imported.memberships || {}) };
    for (const key of Object.keys(memberships)) if (!validKeys.has(key)) delete memberships[key];
    await saveGlobalDatabase([...byKey.values()], {
      categoryState: { categories, memberships },
      replaceCategoryState: true,
      deletedEntries: current.deletedEntries || [],
      sourceDocumentId: currentDocumentSyncId(),
      changeCount: Math.max(1, (imported.entries || []).length)
    });
    await markDocumentBibliographyPushed(source);
  }

  async function chooseBibliographyFileForProjectSetup({ showSyncChoice = true, initialSync = false } = {}) {
    let selectedFile = null;
    let enableSync = Boolean(initialSync);
    const result = await showAppDialog({
      title: "Import your bibliography",
      message: "The global database is empty. Select a BibTeX file to create bibliography.bib in this project.",
      controls: (container) => {
        const wrapper = document.createElement("div");
        wrapper.className = "ctca-project-setup-controls";
        wrapper.innerHTML = `
          <label class="ctca-app-dialog-field"><span>BibTeX file</span><input type="file" accept=".bib,application/x-bibtex,text/plain" class="ctca-project-setup-file"></label>
          <div class="ctca-project-setup-file-name">No file selected</div>
          ${showSyncChoice ? `<label class="ctca-manager-global-sync ctca-project-setup-sync-switch" title="Keep this project bibliography synchronized with the Smart Citations database.">
            <input type="checkbox" class="ctca-project-setup-sync" role="switch" ${enableSync ? "checked" : ""}>
            <span class="ctca-manager-global-sync-track" aria-hidden="true"><span></span></span>
            <span>Sync with Smart Citations database</span>
          </label>` : ""}`;
        container.appendChild(wrapper);
        const fileInput = wrapper.querySelector(".ctca-project-setup-file");
        const fileName = wrapper.querySelector(".ctca-project-setup-file-name");
        fileInput.addEventListener("change", () => {
          selectedFile = fileInput.files?.[0] || null;
          fileName.textContent = selectedFile?.name || "No file selected";
        });
        wrapper.querySelector(".ctca-project-setup-sync")?.addEventListener("change", (event) => {
          enableSync = Boolean(event.target.checked);
        });
      },
      buttons: [
        { label: "Cancel", value: null },
        { label: "Import bibliography", primary: true, getValue: () => ({ file: selectedFile, enableSync }) }
      ],
      closeValue: null
    });
    if (!result) return null;
    if (!result.file) throw new Error("Select a .bib file before starting the import.");
    const text = await result.file.text();
    const database = bibliographyTextToDatabase(text);
    if (!(database.entries || []).length) throw new Error("The selected file contains no parseable BibTeX entries.");
    return { text, enableSync: Boolean(result.enableSync), fileName: result.file.name };
  }

  async function completeProjectBibliographySetup({ sourceText, enableGlobalSync = false, importToGlobal = false } = {}) {
    const originalFile = getSelectedFileName() || currentState?.fileName || "";
    const texState = await getManagerTexState();
    const configuredFiles = findBibliographyFiles(texState.value, texState.cursorIndex);
    const realConfiguredFiles = configuredFiles.filter((fileName) => !isSampleBibliographyFile(fileName));
    const targetFile = realConfiguredFiles[0] || GLOBAL_SETUP_BIB_FILE;

    // When a real bibliography declaration already exists, reuse its file.
    // Only missing or sample-only projects receive bibliography.bib and a
    // corresponding declaration update.
    const written = await writeProjectBibliographyFile(targetFile, sourceText);
    const mainState = await openFileAndWait(texState.fileName);
    if (!realConfiguredFiles.length) {
      await replaceOrAddBibliographyDeclaration(mainState, targetFile);
    }

    records = written.records;
    cachedFiles = [targetFile];
    restoreEmbeddedManagerState(records);
    await saveCachedState(cachedFiles);

    if (importToGlobal) await importBibTextIntoGlobalDatabase(sourceText, "project-setup-import");
    if (enableGlobalSync) {
      await setGlobalDatabaseSyncEnabled(true, { runNow: false });
      await registerCurrentDocumentWithGlobalDatabase();
      await acknowledgeCurrentDocumentGlobalChanges();
    }

    currentState = (await bridgeRequest("getState", {}, 3000)).state || currentState;
    renderSuggestions();
    showGlobalBanner("Successfully imported your bibliography into the project", { autoHideMs: 12000 });
    if (originalFile && !bibSourceMatches(originalFile, texState.fileName)) await restoreFile(originalFile);
    return written;
  }

  async function importProjectBibliographyFromFile() {
    if (projectBibliographySetupInProgress) return false;
    projectBibliographySetupInProgress = true;
    try {
      const importChoice = await chooseBibliographyFileForProjectSetup();
      if (!importChoice) return false;
      await completeProjectBibliographySetup({
        sourceText: importChoice.text,
        enableGlobalSync: importChoice.enableSync,
        importToGlobal: importChoice.enableSync
      });
      return true;
    } catch (error) {
      await showAppDialog({
        title: "Bibliography import failed",
        message: error?.message || String(error),
        buttons: [{ label: "Close", value: null, primary: true }]
      });
      return false;
    } finally {
      projectBibliographySetupInProgress = false;
    }
  }

  async function askProjectSetupGlobalSyncPreference() {
    return Boolean(await showAppDialog({
      title: "Keep this bibliography synchronized?",
      message: "Do you want to keep the bibliography of this project synchronized with the Smart Citations extension bibliography database?",
      buttons: [
        { label: "No", value: false },
        { label: "Yes", value: true, primary: true }
      ],
      closeValue: false
    }));
  }

  async function runProjectBibliographySetup({ skipInitialConfirmation = false } = {}) {
    if (projectBibliographySetupInProgress) return false;
    projectBibliographySetupInProgress = true;
    try {
      if (!skipInitialConfirmation) {
        const texState = await getManagerTexState();
        const files = findBibliographyFiles(texState.value, texState.cursorIndex);
        const sampleOnly = files.length > 0 && files.every(isSampleBibliographyFile);
        if (files.length && !sampleOnly) return false;
        const accepted = await showAppDialog({
          title: sampleOnly ? "Replace sample.bib?" : "Set up your bibliography?",
          message: sampleOnly
            ? "This project still uses sample.bib. Replace it with your bibliography in bibliography.bib?"
            : "This project has no configured bibliography. Create bibliography.bib and add it to the main document?",
          buttons: [
            { label: "Not now", value: false },
            { label: sampleOnly ? "Replace sample.bib" : "Set up bibliography", value: true, primary: true }
          ],
          closeValue: false
        });
        if (!accepted) return false;
      }

      const enableGlobalSync = await askProjectSetupGlobalSyncPreference();
      const globalState = await loadGlobalDatabaseState();
      if ((globalState.entries || []).length) {
        const text = bibliographyDatabaseToText(globalState);
        await completeProjectBibliographySetup({ sourceText: text, enableGlobalSync, importToGlobal: false });
        return true;
      }

      const importChoice = await chooseBibliographyFileForProjectSetup({ showSyncChoice: false, initialSync: enableGlobalSync });
      if (!importChoice) return false;
      await completeProjectBibliographySetup({
        sourceText: importChoice.text,
        enableGlobalSync,
        importToGlobal: enableGlobalSync
      });
      return true;
    } catch (error) {
      await showAppDialog({
        title: "Bibliography setup failed",
        message: error?.message || String(error),
        buttons: [{ label: "Close", value: null, primary: true }]
      });
      return false;
    } finally {
      projectBibliographySetupInProgress = false;
    }
  }

  async function syncProjectFromExistingNextcloudBackup() {
    let config = await globalThis.CollabTeXAttachmentStore.getConfig();
    if (!config.nextcloud?.appPassword) {
      await managerOpenCloudSettings();
      config = await globalThis.CollabTeXAttachmentStore.getConfig();
      if (!config.nextcloud?.appPassword) return false;
    }
    if (!config.nextcloud?.syncBibliography) {
      config.nextcloud = { ...(config.nextcloud || {}), syncBibliography: true };
      await globalThis.CollabTeXAttachmentStore.saveConfig(config);
    }
    const result = await managerSynchronizeNextcloud({ showSuccess: false, resolveConflicts: true });
    if (!result) throw new Error("The Nextcloud bibliography could not be synchronized.");
    const globalState = await loadGlobalDatabaseState();
    if (!(globalState.entries || []).length) throw new Error("The connected Nextcloud backup contains no bibliography entries.");
    await completeProjectBibliographySetup({
      sourceText: bibliographyDatabaseToText(globalState),
      enableGlobalSync: false,
      importToGlobal: false
    });
    return true;
  }

  async function ensureBibliographyConfigured(texState) {
    const files = findBibliographyFiles(texState.value, texState.cursorIndex);
    if (files.length) return { files, declarationAdded: "", created: false, texFileName: texState.fileName };
    // New projects are configured by the dedicated setup assistant. Returning
    // an empty list lets the manager display its import/Nextcloud start screen
    // when the user postpones that assistant.
    return { files: [], declarationAdded: "", created: false, texFileName: texState.fileName };
  }

  async function managerReadBibliographyFiles(files) {
    const parsed = [];
    const failures = [];
    for (let index = 0; index < files.length; index += 1) {
      const fileName = files[index];
      managerSetStatus(`Reading ${fileName} (${index + 1}/${files.length})…`);
      try {
        const text = await openAndReadFile(fileName);
        parsed.push(...window.CollabTeXBibTeX.parseBibTeX(text, fileName));
      } catch (error) {
        failures.push(`${fileName}: ${error.message}`);
      }
    }
    return { parsed, failures };
  }

  function resetManagerDrafts(preserveSelectionKey = "") {
    managerDrafts = new Map();
    for (const record of managerRecords) {
      const draft = draftFromRecord(record);
      managerDrafts.set(draft.id, draft);
    }
    managerDirtyIds.clear();
    managerDeletedDrafts.clear();
    managerCentralDeletionChoices.clear();
    managerSelectedIds.clear();
    managerLastSelectionAnchorId = "";
    const selected = preserveSelectionKey
      ? [...managerDrafts.values()].find((draft) => draft.key === preserveSelectionKey)
      : null;
    managerSelectedId = selected?.id || "";
    if (selected) managerSelectedIds.add(selected.id);
    renderManagerCategories();
    renderManagerList();
    renderManagerDetails();
  }

  async function managerLoadBibliography({
    saveDirty = true,
    preserveSelectionKey = "",
    scheduleSync = false,
    filesOverride = null
  } = {}) {
    if (saveDirty && (managerDirtyIds.size || managerDeletedDrafts.size)) {
      await managerWriteDirtyEntries({ scheduleSync });
    }
    const originalFile = captureSelectedTexFile(managerOriginalFile) || managerOriginalFile || getSelectedFileName();
    if (Array.isArray(filesOverride) && filesOverride.length) {
      managerFiles = [...new Set(filesOverride.map(normalizeBibFileName).filter(Boolean))];
    } else {
      const texState = await getManagerTexState();
      const setup = await ensureBibliographyConfigured(texState);
      managerFiles = setup.files;
    }
    updateManagerBibButton(false);
    const { parsed, failures } = await managerReadBibliographyFiles(managerFiles);

    const unique = new Map();
    for (const record of parsed) unique.set(managerRecordId(record), record);
    managerRecords = [...unique.values()];
    restoreEmbeddedManagerState(managerRecords);
    records = managerRecords.slice();
    cachedFiles = managerFiles.slice();
    resetManagerDrafts(preserveSelectionKey);
    await Promise.all([
      saveCachedState(managerFiles),
      originalFile ? restoreFile(originalFile) : Promise.resolve()
    ]);
    managerSetStatus(
      `Loaded ${managerRecords.length} entries from ${managerFiles.length} BibTeX file${managerFiles.length === 1 ? "" : "s"}.${failures.length ? ` ${failures.join("; ")}` : ""}`,
      failures.length > 0 && managerRecords.length === 0
    );
  }

  function normalizeBibSourceName(value) {
    return String(value || "")
      .replace(/\\/g, "/")
      .replace(/^\.\//, "")
      .toLowerCase();
  }

  function bibSourceMatches(left, right) {
    const leftName = normalizeBibSourceName(left);
    const rightName = normalizeBibSourceName(right);
    if (!leftName || !rightName) return false;
    if (leftName === rightName) return true;
    return leftName.split("/").pop() === rightName.split("/").pop();
  }

  function bibRecordKeySet(items) {
    return new Set((items || []).map((record) => String(record?.key || "")).filter(Boolean));
  }

  async function saveAutomaticBibBackup(fileName, text, entryCount, reason) {
    try {
      const backupKey = `${storageKey()}:bib-backup:${encodeURIComponent(fileName)}`;
      await extensionApi.storage.local.set({
        [backupKey]: {
          version: 1,
          fileName,
          text,
          entryCount,
          reason,
          createdAt: new Date().toISOString()
        }
      });
      return true;
    } catch (error) {
      console.warn("[Smart Citations] Could not create BibTeX safety backup:", error);
      return false;
    }
  }

  function validateManagerCandidate({
    fileName,
    originalRecords,
    candidateRecords,
    replacements,
    additions
  }) {
    const expectedKeys = bibRecordKeySet(originalRecords);

    for (const replacement of replacements) {
      const oldKey = replacement.lookupKey;
      if (oldKey) expectedKeys.delete(oldKey);
      if (!replacement.deletion) expectedKeys.add(replacement.draft.key);
    }
    for (const addition of additions) expectedKeys.add(addition.draft.key);

    const candidateKeys = bibRecordKeySet(candidateRecords);
    const missing = [...expectedKeys].filter((key) => !candidateKeys.has(key));
    if (missing.length) {
      throw new Error(
        `Safety stop: the proposed write to ${fileName} would lose ${missing.length} BibTeX ` +
        `entr${missing.length === 1 ? "y" : "ies"} (${missing.slice(0, 5).join(", ")}${missing.length > 5 ? ", …" : ""}). No changes were written.`
      );
    }
  }

  async function managerWriteDirtyEntries({ scheduleSync = false, fastRestore = false } = {}) {
    if (!managerDirtyIds.size && !managerDeletedDrafts.size) return;
    removeManagerCentralPreviewEntries();
    managerSessionChanged = true;

    const seenKeys = new Set();
    for (const draft of managerDrafts.values()) {
      if (!draft.key || !/^[^\s,{}]+$/.test(draft.key)) {
        throw new Error(`Invalid citation key: ${draft.key || "(empty)"}`);
      }
      const identity = `${draft.sourceFile || managerFiles[0] || ""}\u0000${draft.key.toLowerCase()}`;
      if (seenKeys.has(identity)) {
        throw new Error(`Duplicate citation key in ${draft.sourceFile || managerFiles[0]}: ${draft.key}`);
      }
      seenKeys.add(identity);
    }

    const originalFile = captureSelectedTexFile(managerOriginalFile) || getSelectedFileName() || managerOriginalFile;
    const groups = new Map();
    const ensureGroup = (fileName) => {
      if (!groups.has(fileName)) groups.set(fileName, { edits: [], deletions: [] });
      return groups.get(fileName);
    };

    for (const id of managerDirtyIds) {
      const draft = managerDrafts.get(id);
      if (!draft) continue;
      const fileName = draft.sourceFile || managerFiles[0];
      if (!fileName) throw new Error(`No target BibTeX file is available for ${draft.key}.`);
      draft.sourceFile = fileName;
      ensureGroup(fileName).edits.push(draft);
    }

    for (const draft of managerDeletedDrafts.values()) {
      const fileName = draft.sourceFile || managerFiles[0];
      if (!fileName) throw new Error(`No target BibTeX file is available for ${draft.key}.`);
      draft.sourceFile = fileName;
      ensureGroup(fileName).deletions.push(draft);
    }

    for (const [fileName, group] of groups) {
      const actionParts = [];
      if (group.edits.length) actionParts.push(`${group.edits.length} edited`);
      if (group.deletions.length) actionParts.push(`${group.deletions.length} removed`);
      managerSetStatus(`Safety-checking ${actionParts.join(" and ")} entries in ${fileName}…`);

      const state = await openFileAndWait(fileName);
      const stateFileName = String(state.fileName || "");
      if (!bibSourceMatches(stateFileName, fileName)) {
        throw new Error(
          `Safety stop: ColLabTeX still exposed ${stateFileName || "another document"} while ${fileName} was selected. No changes were written.`
        );
      }

      const text = String(state.value ?? "");
      const currentRecords = window.CollabTeXBibTeX.parseBibTeX(text, fileName);
      const pendingNewKeys = new Set(group.edits.filter((draft) => !draft.originalKey).map((draft) => draft.key));
      const baselineRecords = managerRecords.filter((record) => bibSourceMatches(record.sourceFile, fileName) && !pendingNewKeys.has(record.key));
      const currentKeys = bibRecordKeySet(currentRecords);
      const missingBaseline = baselineRecords
        .map((record) => record.key)
        .filter((key) => key && !currentKeys.has(key));

      // This is the critical guard against a still-loading or stale ACE session.
      // A write is refused when the live file does not contain every entry that
      // was present when the bibliography manager loaded it.
      if (missingBaseline.length) {
        throw new Error(
          `Safety stop: ${fileName} currently exposes only ${currentRecords.length} of at least ${baselineRecords.length} expected entries. ` +
          `${missingBaseline.length} expected key${missingBaseline.length === 1 ? " is" : "s are"} missing ` +
          `(${missingBaseline.slice(0, 5).join(", ")}${missingBaseline.length > 5 ? ", …" : ""}). ` +
          `The file may still be loading; no changes were written.`
        );
      }

      const replacements = [];
      const additions = [];

      for (const draft of group.deletions) {
        const lookupKey = draft.originalKey || draft.key;
        if (!lookupKey) continue;
        const range = findBibEntryRange(text, lookupKey);
        if (!range) {
          throw new Error(`Safety stop: could not locate ${lookupKey} in ${fileName} for removal. No changes were written to this file.`);
        }
        replacements.push({
          start: range.start,
          end: range.end,
          text: "",
          draft,
          lookupKey,
          deletion: true
        });
      }

      for (const draft of group.edits) {
        const serialized = serializeManagerDraft(draft);
        if (draft.originalKey) {
          const range = findBibEntryRange(text, draft.originalKey);
          if (!range) {
            throw new Error(
              `Safety stop: could not locate the existing entry ${draft.originalKey} in ${fileName}. ` +
              `It will not be mistaken for a new entry, and no changes were written to this file.`
            );
          }
          replacements.push({
            start: range.start,
            end: range.end,
            text: serialized,
            draft,
            lookupKey: draft.originalKey,
            deletion: false
          });
        } else {
          additions.push({ text: serialized, draft });
        }
      }

      replacements.sort((left, right) => right.start - left.start);
      let candidateText = text;
      for (const replacement of replacements) {
        candidateText =
          candidateText.slice(0, replacement.start) +
          replacement.text +
          candidateText.slice(replacement.end);
      }
      if (additions.length) {
        const additionText = additions.map((addition) => addition.text).join("\n\n");
        candidateText = `${candidateText.trimEnd()}${candidateText.trim() ? "\n\n" : ""}${additionText}\n`;
      }

      const candidateRecords = window.CollabTeXBibTeX.parseBibTeX(candidateText, fileName);
      validateManagerCandidate({
        fileName,
        originalRecords: currentRecords,
        candidateRecords,
        replacements,
        additions
      });

      // Ensure no collaborator or delayed ColLabTeX session swap changed the
      // document between planning and writing.
      const latest = (await bridgeRequest("getState", {}, 3000)).state;
      if (!bibSourceMatches(latest?.fileName, fileName) || String(latest?.value ?? "") !== text) {
        throw new Error(
          `Safety stop: ${fileName} changed while the update was being prepared. Reload the bibliography and try again; no changes were written.`
        );
      }

      const backupCreated = await saveAutomaticBibBackup(
        fileName,
        text,
        currentRecords.length,
        `Before writing ${actionParts.join(" and ")} bibliography entries`
      );
      managerSetStatus(
        `Writing ${actionParts.join(" and ")} entries to ${fileName}${backupCreated ? " (safety backup created)" : ""}…`
      );

      // Apply only the planned entry ranges, from the end of the document to
      // the beginning. Untouched bibliography text is never replaced wholesale.
      let workingText = text;
      for (const replacement of replacements) {
        if (replacement.deletion) {
          managerSetStatus(`Removing attachments for ${replacement.lookupKey}…`);
          await globalThis.CollabTeXAttachmentStore.removeForEntries([replacement.draft]);
        }
        const response = await bridgeRequest(
          "replaceRange",
          { start: replacement.start, end: replacement.end, text: replacement.text },
          10000
        );
        workingText =
          workingText.slice(0, replacement.start) +
          replacement.text +
          workingText.slice(replacement.end);
        if (String(response?.state?.value ?? workingText) !== workingText) {
          throw new Error(
            `Writing ${replacement.lookupKey} to ${fileName} did not produce the expected ACE document state. ` +
            `Further writes were stopped; untouched entries were not replaced.`
          );
        }
        // The editor bridge emits the resulting collaboration state on the
        // next animation frame. Record our acknowledged value now so that
        // event is not mistaken for a new collaborator edit.
        observedBibTextByFile.set(fileName, workingText);
        if (replacement.deletion) {
          delete managerCategoryState.memberships[replacement.draft.id];
          managerSelectedIds.delete(replacement.draft.id);
          managerDeletedDrafts.delete(replacement.draft.id);
        } else {
          const newId = `${replacement.draft.sourceFile || fileName}␟${replacement.draft.key}`;
          managerMigrateCategoryMembership(replacement.draft.id, newId);
          replacement.draft.originalKey = replacement.draft.key;
          managerDirtyIds.delete(replacement.draft.id);
        }
      }

      if (additions.length) {
        const additionText = additions.map((addition) => addition.text).join("\n\n");
        const separator = !workingText.trim()
          ? ""
          : workingText.endsWith("\n\n")
            ? ""
            : workingText.endsWith("\n")
              ? "\n"
              : "\n\n";
        const appendText = `${separator}${additionText}\n`;
        const appendStart = workingText.length;

        const response = await bridgeRequest(
          "replaceRange",
          { start: appendStart, end: appendStart, text: appendText },
          10000
        );
        workingText += appendText;
        if (String(response?.state?.value ?? workingText) !== workingText) {
          throw new Error(`Could not append new entries to ${fileName}; further writes were stopped.`);
        }
        observedBibTextByFile.set(fileName, workingText);
        for (const addition of additions) {
          const newId = `${addition.draft.sourceFile || fileName}␟${addition.draft.key}`;
          managerMigrateCategoryMembership(addition.draft.id, newId);
          addition.draft.originalKey = addition.draft.key;
          managerDirtyIds.delete(addition.draft.id);
        }
      }

      const finalState = (await bridgeRequest("getState", {}, 3000)).state;
      const finalText = String(finalState?.value ?? "");
      const finalRecords = window.CollabTeXBibTeX.parseBibTeX(finalText, fileName);
      validateManagerCandidate({
        fileName,
        originalRecords: currentRecords,
        candidateRecords: finalRecords,
        replacements,
        additions
      });
    }

    legacyCachedManagerState = null;
    legacyCachedDoiSyncLedger = null;
    // Keep the verified in-memory state and persistent cache aligned with the
    // completed writes. Central sync can then reuse this populated list without
    // reopening and reparsing every BibTeX file.
    const selectedKey = managerDrafts.get(managerSelectedId)?.key || "";
    managerRecords = [...managerDrafts.values()].map(managerDraftToRecord);
    records = managerRecords.slice();
    cachedFiles = managerFiles.slice();
    resetManagerDrafts(selectedKey);
    await Promise.all([
      saveCachedState(managerFiles),
      originalFile ? restoreFile(originalFile, { waitForStable: !fastRestore }) : Promise.resolve()
    ]);
    if (scheduleSync && settings.syncGlobalDatabase && !globalDatabaseSyncInProgress) {
      scheduleGlobalDatabaseSync(120, "project bibliography changed", true);
    }
  }

  function globalItemLookupKeys(item) {
    return new Set(
      [item?.key, ...(item?.aliases || []), ...splitAliasKeys(item?.fields?.ids || "")]
        .map((key) => String(key || "").trim().toLowerCase())
        .filter(Boolean)
    );
  }

  function pendingGlobalChangeCandidates(globalItems, localItems, snapshotItems, documentFlag) {
    if (documentFlag?.pending !== true) return [];
    const exactPendingIdentities = new Set(documentFlag.pendingEntryIdentities || []);
    const pendingIdentities = exactPendingIdentities.size
      ? exactPendingIdentities
      : changedGlobalEntryIdentities(
          globalItems,
          snapshotItems,
          localItems,
          Math.max(0, Number(documentFlag.pendingCount) || 0)
        );
    if (!pendingIdentities.size) return [];

    const localByIdentity = new Map((localItems || []).map((item) => [globalSyncIdentity(item), item]));
    return (globalItems || [])
      .filter((item) => pendingIdentities.has(globalSyncIdentity(item)))
      .filter((item) => {
        const local = localByIdentity.get(globalSyncIdentity(item));
        return !local || globalItemFingerprint(item) !== globalItemFingerprint(local);
      })
      .map((item) => ({
        ...item,
        _ctcaCentralChangeKind: localByIdentity.has(globalSyncIdentity(item)) ? "modified" : "new"
      }))
      .sort((left, right) => {
        const updated = String(right?.updatedAt || "").localeCompare(String(left?.updatedAt || ""));
        return updated || String(left?.key || "").localeCompare(String(right?.key || ""));
      });
  }

  function pendingGlobalImportCandidates(globalItems, localItems, snapshotItems, documentFlag) {
    const changedItems = pendingGlobalChangeCandidates(globalItems, localItems, snapshotItems, documentFlag);
    const localKeys = new Set();
    const localDoiCounts = new Map();
    for (const item of localItems || []) {
      for (const key of globalItemLookupKeys(item)) localKeys.add(key);
      const doi = normalizeDoiInput(item?.fields?.doi || "").toLowerCase();
      if (doi) localDoiCounts.set(doi, (localDoiCounts.get(doi) || 0) + 1);
    }
    const globalDoiCounts = new Map();
    for (const item of globalItems || []) {
      const doi = normalizeDoiInput(item?.fields?.doi || "").toLowerCase();
      if (doi) globalDoiCounts.set(doi, (globalDoiCounts.get(doi) || 0) + 1);
    }

    return changedItems
      .filter((item) => {
        if ([...globalItemLookupKeys(item)].some((key) => localKeys.has(key))) return false;
        const doi = normalizeDoiInput(item?.fields?.doi || "").toLowerCase();
        return !doi || localDoiCounts.get(doi) !== 1 || globalDoiCounts.get(doi) !== 1;
      });
  }

  async function loadPendingGlobalImportCandidates() {
    if (!settings.syncGlobalDatabase) return [];
    const [globalState, snapshotItems] = await Promise.all([
      loadGlobalDatabaseState(),
      loadGlobalSyncSnapshot()
    ]);
    const documentFlag = normalizeGlobalDocumentSync(globalState.documentSync).documents[currentDocumentSyncId()];
    return pendingGlobalChangeCandidates(
      Array.isArray(globalState.entries) ? globalState.entries : [],
      globalItemsFromCurrentDocument(),
      snapshotItems,
      documentFlag
    );
  }

  async function choosePendingGlobalImports(candidates) {
    if (!candidates.length) return new Set();
    const selected = new Set(candidates.map(globalSyncIdentity));
    const result = await showAppDialog({
      title: `Apply ${candidates.length} new or modified central database entr${candidates.length === 1 ? "y" : "ies"}?`,
      message: "Select the central entries to incorporate into this document's BibTeX file. All entries are selected by default.",
      controls: (container) => {
        const toolbar = document.createElement("div");
        toolbar.className = "ctca-global-import-toolbar";
        const selectAll = document.createElement("button");
        selectAll.type = "button";
        selectAll.textContent = "Select all";
        const clearAll = document.createElement("button");
        clearAll.type = "button";
        clearAll.textContent = "Clear all";
        const count = document.createElement("span");
        count.className = "ctca-global-import-count";

        const list = document.createElement("div");
        list.className = "ctca-global-import-list";
        const checkboxes = [];
        const updateCount = () => {
          count.textContent = `${selected.size} of ${candidates.length} selected`;
        };

        for (const item of candidates) {
          const identity = globalSyncIdentity(item);
          const fields = item?.fields || {};
          const label = document.createElement("label");
          label.className = "ctca-global-import-entry";
          const checkbox = document.createElement("input");
          checkbox.type = "checkbox";
          checkbox.checked = true;
          checkbox.value = identity;
          checkbox.addEventListener("change", () => {
            if (checkbox.checked) selected.add(identity);
            else selected.delete(identity);
            updateCount();
          });
          const details = document.createElement("span");
          details.className = "ctca-global-import-entry-details";
          const heading = document.createElement("span");
          heading.className = "ctca-global-import-entry-title";
          heading.innerHTML = managerLatexHtml(stripOneBibDelimiter(fields.title || item?.key || "Untitled reference"));
          const meta = document.createElement("span");
          meta.className = "ctca-global-import-entry-meta";
          const authors = window.CollabTeXBibTeX
            .splitAuthors(stripOneBibDelimiter(fields.author || fields.editor || ""))
            .join("; ");
          const year = stripOneBibDelimiter(fields.year || fields.date || "");
          meta.textContent = [item?.key || "Reference", authors, year].filter(Boolean).join(" · ");
          details.append(heading, meta);
          label.append(checkbox, details);
          list.appendChild(label);
          checkboxes.push(checkbox);
        }

        selectAll.addEventListener("click", () => {
          for (const checkbox of checkboxes) checkbox.checked = true;
          selected.clear();
          for (const item of candidates) selected.add(globalSyncIdentity(item));
          updateCount();
        });
        clearAll.addEventListener("click", () => {
          for (const checkbox of checkboxes) checkbox.checked = false;
          selected.clear();
          updateCount();
        });
        updateCount();
        toolbar.append(selectAll, clearAll, count);
        container.append(toolbar, list);
      },
      buttons: [
        { label: "Cancel update", value: null },
        {
          label: "Apply selected",
          primary: true,
          getValue: () => new Set(selected)
        }
      ],
      closeValue: null,
      dialogClass: "ctca-global-import-dialog-card"
    });
    return result;
  }

  async function managerSaveAndReload() {
    if (managerBusy) return;
    const returnTexFile = managerReturnTexFile || captureSelectedTexFile(managerOriginalFile);
    showDocumentBibliographyUpdateOverlay();
    await pauseFastManagerCentralSync();
    const hasPendingBibWrites = Boolean(managerDirtyIds.size || managerDeletedDrafts.size);
    setManagerBusy(true, hasPendingBibWrites ? "Saving…" : "Reading…");
    const selectedKey = managerDrafts.get(managerSelectedId)?.key || "";
    const localDeletedGlobalIdentities = managerChosenCentralDeletionIdentities();
    const applyPendingGlobalChanges = Boolean(settings.syncGlobalDatabase);
    let reloadSucceeded = false;
    try {
      if (hasPendingBibWrites) {
        // The write path already validates the final editor contents and
        // rebuilds the in-memory records/cache, so rereading every .bib file
        // here would only repeat the slow file-navigation cycle.
        await managerWriteDirtyEntries({ scheduleSync: false, fastRestore: true });
      } else {
        await managerLoadBibliography({
          saveDirty: false,
          preserveSelectionKey: selectedKey,
          scheduleSync: false
        });
      }
      reloadSucceeded = true;
    } catch (error) {
      managerSetStatus(error.message || String(error), true);
    } finally {
      setManagerBusy(false);
    }
    if (!reloadSucceeded) {
      hideDocumentBibliographyUpdateOverlay();
      if (returnTexFile) await restoreFile(returnTexFile, { waitForStable: false });
      return;
    }

    let excludedGlobalImportIdentities = new Set();
    if (applyPendingGlobalChanges) {
      let candidates = [];
      try {
        candidates = await loadPendingGlobalImportCandidates();
      } catch (error) {
        hideDocumentBibliographyUpdateOverlay();
        managerSetStatus(`Could not inspect new central database entries: ${error.message || String(error)}`, true);
        if (returnTexFile) await restoreFile(returnTexFile, { waitForStable: false });
        return;
      }
      if (candidates.length) {
        hideDocumentBibliographyUpdateOverlay();
        const selectedIdentities = await choosePendingGlobalImports(candidates);
        if (selectedIdentities === null) {
          if (returnTexFile) await restoreFile(returnTexFile, { waitForStable: false });
          return;
        }
        excludedGlobalImportIdentities = new Set(
          candidates
            .map(globalSyncIdentity)
            .filter((identity) => !selectedIdentities.has(identity))
        );
        showDocumentBibliographyUpdateOverlay();
      }
    }

    const shouldSynchronize = Boolean(
      settings.syncGlobalDatabase &&
      (applyPendingGlobalChanges || managerSessionChanged || deferredProjectGlobalPush)
    );
    if (!shouldSynchronize) {
      hideDocumentBibliographyUpdateOverlay();
      if (returnTexFile) await restoreFile(returnTexFile, { waitForStable: false });
      return;
    }

    window.clearTimeout(globalDatabaseSyncTimer);
    globalDatabaseSyncTimer = null;
    try {
      await synchronizeProjectWithGlobalDatabase({
        reason: "Update Bib",
        announce: true,
        force: true,
        allowManagerSession: true,
        localDeletedGlobalIdentities,
        excludedGlobalImportIdentities
      });
    } finally {
      hideDocumentBibliographyUpdateOverlay();
    }
    if (globalDocumentPendingCount > 0 && bibManager.classList.contains("ctca-manager-visible")) {
      showPendingGlobalSyncBanner();
    }
    if (returnTexFile) await restoreFile(returnTexFile, { waitForStable: false });
  }

  async function openBibManager({ bibFileName = "" } = {}) {
    await globalThis.SmartCitationsPrivacy.ensureAccepted();
    if (managerBusy) return;
    cancelScheduledPopup();
    hidePopup();
    managerNewEntryKeys = new Set();
    const requestedBibFile = normalizeBibFileName(bibFileName);
    const activeFile = getSelectedFileName() || currentState?.fileName || "";
    managerReturnTexFile = captureSelectedTexFile(activeFile);
    managerOriginalFile = managerReturnTexFile || (
      requestedBibFile
        ? currentState?.fileName || activeFile
        : activeFile
    );
    managerSessionChanged = false;
    bibManager.classList.add("ctca-manager-visible");
    bibManager.setAttribute("aria-hidden", "false");
    setManagerListLoading(true);
    managerBulkDoiAbortRequested = false;
    managerBulkDoiActiveRequestId = "";
    managerSetProgress(0, 1, "", false);
    const searchInput = bibManager.querySelector(".ctca-manager-search");
    searchInput.value = managerQuery;
    bibManager.querySelector(".ctca-manager-search-clear").hidden = !managerQuery;
    applyManagerColumnWidths();
    const requestedFileAlreadyLoaded = requestedBibFile
      ? managerFiles.length === 1 && bibSourceMatches(managerFiles[0], requestedBibFile)
      : true;
    let reusedPopulatedList = managerDrafts.size > 0 && requestedFileAlreadyLoaded;
    const requestedFileAlreadyCached = requestedBibFile
      ? cachedFiles.length === 1 && bibSourceMatches(cachedFiles[0], requestedBibFile)
      : true;
    if (!reusedPopulatedList && records.length > 0 && cachedFiles.length > 0 && requestedFileAlreadyCached) {
      managerFiles = cachedFiles.slice();
      managerRecords = records.slice();
      resetManagerDrafts();
      reusedPopulatedList = managerDrafts.size > 0;
    }

    try {
      await managerEnsureAuthorshipUserName();
      extensionApi.runtime.sendMessage({ type: "ctca-check-orcid-and-open" }).catch(() => {});
      if (reusedPopulatedList) {
        updateManagerBibButton(false);
        renderManagerCategories();
        renderManagerList();
        renderManagerDetails();
        updateManagerCount();
        managerSetStatus(`Showing ${managerDrafts.size} previously loaded bibliography entries.`);
      } else {
        setManagerBusy(true, "Loading…");
        managerSetStatus("Detecting bibliography configuration…");
        await managerLoadBibliography({
          saveDirty: false,
          filesOverride: requestedBibFile ? [requestedBibFile] : null
        });
        setManagerBusy(false);
      }

      managerUpdateCloudIconState().catch(() => {});
      managerScheduleNextcloudSync(200);
      bibManager.querySelector(".ctca-manager-search")?.focus();
      Promise.resolve().then(async () => {
        if (!globalPromptChecked && !startupAssistantCheckInProgress) {
          await checkGlobalDatabasePrompts({ allowAutomaticSync: false });
        }
        if (settings.syncGlobalDatabase) {
          await checkCurrentDocumentGlobalFlag({ allowAutomaticSync: false });
        }
        await refreshManagerPendingHighlights();
      }).catch((error) => {
        console.warn("[Smart Citations] Could not load central bibliography previews:", error);
      });
    } catch (error) {
      if (managerOriginalFile) await restoreFile(managerOriginalFile);
      managerSetStatus(error.message || String(error), true);
    } finally {
      setManagerListLoading(false);
      setManagerBusy(false);
    }
  }

  async function closeBibManager(event, { skipSynchronization = false, continueAfterHidden = false } = {}) {
    event?.preventDefault?.();
    const returnTexFile = managerReturnTexFile || captureSelectedTexFile(managerOriginalFile);
    const wasVisible = bibManager.classList.contains("ctca-manager-visible");
    if (wasVisible) {
      bibManager.classList.remove("ctca-manager-visible");
      bibManager.setAttribute("aria-hidden", "true");
    }
    if (!wasVisible && !continueAfterHidden) return;

    if (managerBusy) {
      if (!globalDatabaseSyncInProgress && !documentBibliographyUpdateOverlay?.classList.contains("ctca-document-bibliography-update-visible")) {
        managerCloseCommitRequested = true;
      }
      bridgeRequest("focus").catch(() => {});
      return;
    }
    await pauseFastManagerCentralSync();
    removeManagerCentralPreviewEntries();
    const localDeletedGlobalIdentities = managerChosenCentralDeletionIdentities();
    if (managerWorkspaceTab !== "bibliography") {
      try {
        await managerRequestPdfFrameSave(managerWorkspaceTab);
      } catch (error) {
        managerSetStatus(error?.message || String(error), true);
        showGlobalBanner(`Could not save the PDF workspace: ${error?.message || String(error)}`, { autoHideMs: 10000 });
        if (returnTexFile) await restoreFile(returnTexFile, { waitForStable: false });
        return;
      }
      window.clearTimeout(managerPdfNoteSaveTimer);
      await managerSaveActivePdfNotes().catch(() => {});
    }
    const hadChanges = Boolean(managerSessionChanged || managerDirtyIds.size || managerDeletedDrafts.size);
    const hasPendingBibWrites = Boolean(managerDirtyIds.size || managerDeletedDrafts.size);
    if (hadChanges) showDocumentBibliographyUpdateOverlay();
    let excludedGlobalImportIdentities = new Set();
    let selectedExternalChanges = 0;
    let externalCandidatesFound = false;
    let pendingSelectionCancelled = false;
    let synchronizationFailed = false;
    try {
      if (hasPendingBibWrites) {
        setManagerBusy(true, "Saving…");
        try {
          await managerWriteDirtyEntries({ scheduleSync: false, fastRestore: true });
        } catch (error) {
          managerSetStatus(error.message || String(error), true);
          showGlobalBanner(`Could not update the document bibliography: ${error.message || String(error)}`, { autoHideMs: 10000 });
          if (returnTexFile) await restoreFile(returnTexFile, { waitForStable: false });
          return;
        } finally {
          setManagerBusy(false);
        }
      }

      if (!skipSynchronization && settings.syncGlobalDatabase) {
        // Inspect pending central entries only after local drafts have been
        // written. Entries produced by this manager session then match the
        // document and fall out of the candidate list; what remains is truly
        // new or modified outside the current ColLabTeX document.
        let candidates;
        try {
          candidates = await loadPendingGlobalImportCandidates();
        } catch (error) {
          managerSetStatus(`Could not inspect central database changes: ${error.message || String(error)}`, true);
          showGlobalBanner(`Could not inspect central database changes: ${error.message || String(error)}`, { autoHideMs: 10000 });
          synchronizationFailed = true;
          candidates = [];
        }
        if (!synchronizationFailed && candidates.length) {
          externalCandidatesFound = true;
          hideDocumentBibliographyUpdateOverlay();
          const selectedIdentities = await choosePendingGlobalImports(candidates);
          pendingSelectionCancelled = selectedIdentities === null;
          const selected = selectedIdentities || new Set();
          selectedExternalChanges = selected.size;
          excludedGlobalImportIdentities = new Set(
            candidates
              .map(globalSyncIdentity)
              .filter((identity) => !selected.has(identity))
          );
        }
      }

      const shouldSynchronize = Boolean(
        !synchronizationFailed &&
        !skipSynchronization &&
        settings.syncGlobalDatabase &&
        (hadChanges || selectedExternalChanges > 0)
      );
      if (shouldSynchronize) {
        showDocumentBibliographyUpdateOverlay();
        window.clearTimeout(globalDatabaseSyncTimer);
        globalDatabaseSyncTimer = null;
        const result = await synchronizeProjectWithGlobalDatabase({
          reason: "bibliography manager closed",
          announce: false,
          force: true,
          localDeletedGlobalIdentities,
          excludedGlobalImportIdentities
        });
        if (!result) {
          showGlobalBanner("The document bibliography could not be synchronized.", { autoHideMs: 10000 });
          synchronizationFailed = true;
        }
      }
    } finally {
      hideDocumentBibliographyUpdateOverlay();
    }
    if (
      !synchronizationFailed &&
      (
        pendingSelectionCancelled ||
        (externalCandidatesFound && selectedExternalChanges === 0) ||
        globalDocumentPendingCount > 0
      )
    ) {
      showPendingGlobalSyncBanner();
    }
    if (returnTexFile) await restoreFile(returnTexFile, { waitForStable: false });
    bridgeRequest("focus").catch(() => {});
    managerSessionChanged = false;
    managerReturnTexFile = "";
  }

  function globalIdentity(item) {
    const doi = normalizeDoiInput(item?.fields?.doi || item?.doi || "").toLowerCase();
    if (doi) return `doi:${doi}`;
    return `key:${String(item?.key || "").trim().toLowerCase()}`;
  }

  function normalizeGlobalDeletionTombstones(value) {
    const byIdentity = new Map();
    for (const item of Array.isArray(value) ? value : []) {
      const identity = String(item?.identity || "").trim().toLowerCase();
      if (!identity || (!identity.startsWith("doi:") && !identity.startsWith("key:"))) continue;
      const candidate = {
        identity,
        doi: String(item?.doi || ""),
        key: String(item?.key || ""),
        title: String(item?.title || ""),
        deletedAt: item?.deletedAt || new Date().toISOString(),
        source: "global"
      };
      const previous = byIdentity.get(identity);
      if (!previous || String(candidate.deletedAt) > String(previous.deletedAt)) byIdentity.set(identity, candidate);
    }
    return [...byIdentity.values()];
  }

  function splitAliasKeys(value) {
    return String(value || "").split(/[;,\s]+/).map((item) => item.trim()).filter(Boolean);
  }

  function globalItemFromDraft(draft) {
    const aliases = new Set([draft.key, draft.originalKey, ...splitAliasKeys(draft.fields.ids || "")].filter(Boolean));
    const fields = Object.fromEntries(Object.entries(draft.fields || {}).filter(([name]) => !CTCA_INTERNAL_FIELDS.has(name)));
    return {
      key: draft.key,
      type: draft.type,
      fields,
      aliases: [...aliases],
      tags: globalThis.CollabTeXSearchTools.splitTags(draft.fields?.[CTCA_TAGS_FIELD] || ""),
      updatedAt: new Date().toISOString(),
      addedOn: managerAddedOn(draft) || new Date().toISOString(),
      starred: managerIsStarred(draft),
      _starredDefined: CTCA_STARRED_FIELD in (draft.fields || {})
    };
  }

  function scheduleFastManagerCentralSync(draft, delayMs = 280) {
    if (!settings.syncGlobalDatabase || !draft || draft.centralPreview === true) return;
    const identity = globalSyncIdentity(globalItemFromDraft(draft));
    const originalIdentity = `key:${String(draft.originalKey || "").trim().toLowerCase()}`;
    if (
      managerPendingCentralIdentities.has(identity) ||
      (originalIdentity !== "key:" && managerPendingCentralIdentities.has(originalIdentity))
    ) {
      return;
    }
    managerFastCentralSyncDraftIds.add(draft.id);
    window.clearTimeout(managerFastCentralSyncTimer);
    managerFastCentralSyncTimer = window.setTimeout(() => {
      managerFastCentralSyncTimer = null;
      managerFastCentralSyncPromise = managerFastCentralSyncPromise
        .catch(() => {})
        .then(() => flushFastManagerCentralSync())
        .catch((error) => {
          if (bibManager.classList.contains("ctca-manager-visible")) {
            managerSetStatus(`Central database update failed: ${error?.message || String(error)}`, true);
          }
        });
    }, Math.max(0, Number(delayMs) || 0));
  }

  async function pauseFastManagerCentralSync() {
    window.clearTimeout(managerFastCentralSyncTimer);
    managerFastCentralSyncTimer = null;
    managerFastCentralSyncDraftIds.clear();
    await managerFastCentralSyncPromise.catch(() => {});
  }

  async function flushFastManagerCentralSync() {
    if (managerFastCentralSyncInProgress || !settings.syncGlobalDatabase || !managerFastCentralSyncDraftIds.size) return;
    managerFastCentralSyncInProgress = true;
    const draftIds = [...managerFastCentralSyncDraftIds];
    managerFastCentralSyncDraftIds.clear();
    try {
      const current = await loadGlobalDatabaseState();
      const currentFlag = normalizeGlobalDocumentSync(current.documentSync).documents[currentDocumentSyncId()];
      const exactPending = new Set(currentFlag?.pendingEntryIdentities || []);
      const pendingWithoutExactIdentities = currentFlag?.pending === true && exactPending.size === 0;
      const nextByIdentity = new Map(
        (current.entries || []).map((entry) => [globalSyncIdentity(entry), entry])
      );
      let updated = 0;

      for (const draftId of draftIds) {
        const draft = managerDrafts.get(draftId);
        if (!draft || draft.centralPreview === true || managerDeletedDrafts.has(draftId)) continue;
        const incoming = globalItemFromDraft(draft);
        const identity = globalSyncIdentity(incoming);
        const originalIdentity = `key:${String(draft.originalKey || "").trim().toLowerCase()}`;
        if (
          pendingWithoutExactIdentities ||
          exactPending.has(identity) ||
          (originalIdentity !== "key:" && exactPending.has(originalIdentity))
        ) {
          continue;
        }

        const existing = nextByIdentity.get(identity) || nextByIdentity.get(originalIdentity) || null;
        if (originalIdentity !== "key:" && originalIdentity !== identity) nextByIdentity.delete(originalIdentity);
        const aliases = new Set([
          ...(existing?.aliases || []),
          ...(incoming.aliases || []),
          existing?.key,
          draft.originalKey
        ].filter(Boolean));
        aliases.delete(incoming.key);
        nextByIdentity.set(identity, {
          ...incoming,
          aliases: [...aliases],
          addedOn: existing?.addedOn || incoming.addedOn,
          updatedAt: new Date().toISOString()
        });
        updated += 1;
      }

      if (!updated) return;
      await saveGlobalDatabase([...nextByIdentity.values()], {
        categoryState: globalCategoryStateFromCurrentDocument(),
        sourceDocumentId: currentDocumentSyncId(),
        changeCount: updated,
        preserveSourcePending: true
      });
      if (bibManager.classList.contains("ctca-manager-visible")) {
        managerSetStatus(
          `${updated} draft entr${updated === 1 ? "y" : "ies"} synchronized rapidly to the central database. ` +
          "The document BibTeX file will be updated by Update Bib or when this window closes."
        );
      }
    } finally {
      managerFastCentralSyncInProgress = false;
    }
  }

  function mergeGlobalItems(existing, incoming) {
    const merged = {
      key: existing.key || incoming.key,
      type: existing.type && existing.type !== "misc" ? existing.type : incoming.type,
      fields: { ...(existing.fields || {}) },
      aliases: [...new Set([existing.key, incoming.key, ...(existing.aliases || []), ...(incoming.aliases || [])].filter(Boolean))],
      tags: globalThis.CollabTeXSearchTools.splitTags([...(existing.tags || []), ...(incoming.tags || [])]),
      updatedAt: new Date().toISOString(),
      addedOn: existing.addedOn || incoming.addedOn || new Date().toISOString(),
      starred: incoming._starredDefined ? incoming.starred === true : existing.starred === true
    };
    for (const [name, value] of Object.entries(incoming.fields || {})) {
      if (!value || CTCA_INTERNAL_FIELDS.has(name)) continue;
      merged.fields[name] = value;
    }
    const aliases = merged.aliases.filter((alias) => alias !== merged.key);
    if (aliases.length) merged.fields.ids = aliases.join(", ");
    return merged;
  }

  async function loadGlobalDatabaseState() {
    const data = await extensionApi.storage.local.get(GLOBAL_DATABASE_KEY);
    const value = data?.[GLOBAL_DATABASE_KEY];
    if (!value || typeof value !== "object") {
      return { version: 3, entries: [], categories: [], memberships: {}, deletedEntries: [], documentSync: normalizeGlobalDocumentSync(null) };
    }
    const entries = Array.isArray(value.entries) ? value.entries : [];
    const presentIdentities = new Set(entries.map(globalIdentity));
    return {
      ...value,
      entries,
      documentSync: normalizeGlobalDocumentSync(value.documentSync),
      // A restored or re-imported global entry invalidates any older deletion
      // marker for the same DOI/citation key. This also cleans up tombstones
      // created by pre-1.9.4 synchronization regressions.
      deletedEntries: normalizeGlobalDeletionTombstones(value.deletedEntries)
        .filter((item) => !presentIdentities.has(item.identity))
    };
  }

  async function loadGlobalDatabase() {
    const value = await loadGlobalDatabaseState();
    return Array.isArray(value?.entries) ? value.entries : [];
  }

  function currentDocumentSyncId() {
    return storageKey();
  }

  function currentDocumentSyncLabel() {
    const projectMatch = window.location.pathname.match(/\/project\/([^/?#]+)/);
    return projectMatch?.[1] || document.title || window.location.pathname;
  }

  function normalizeGlobalDocumentSync(value) {
    const source = value && typeof value === "object" ? value : {};
    const documents = {};
    for (const [id, raw] of Object.entries(source.documents || {})) {
      if (!id || !raw || typeof raw !== "object") continue;
      documents[id] = {
        label: String(raw.label || ""),
        pending: raw.pending === true,
        pendingCount: Math.max(0, Number(raw.pendingCount) || 0),
        pendingRevision: Math.max(0, Number(raw.pendingRevision) || 0),
        acknowledgedRevision: Math.max(0, Number(raw.acknowledgedRevision) || 0),
        pendingEntryIdentities: [...new Set((Array.isArray(raw.pendingEntryIdentities) ? raw.pendingEntryIdentities : [])
          .map((identity) => String(identity || "").trim().toLowerCase())
          .filter((identity) => identity.startsWith("key:")))],
        registeredAt: String(raw.registeredAt || ""),
        updatedAt: String(raw.updatedAt || "")
      };
    }
    return {
      version: GLOBAL_DOCUMENT_SYNC_VERSION,
      revision: Math.max(0, Number(source.revision) || 0),
      documents
    };
  }

  function globalDatabaseContentFingerprint(database) {
    const value = database && typeof database === "object" ? database : {};
    return JSON.stringify({
      entries: (value.entries || []).map(canonicalGlobalItem).sort((left, right) => left.key.localeCompare(right.key)),
      categories: value.categories || [],
      memberships: value.memberships || {},
      deletedEntries: normalizeGlobalDeletionTombstones(value.deletedEntries)
    });
  }

  function changedGlobalDatabaseEntryIdentities(currentState, nextState) {
    const current = new Map((currentState?.entries || []).map((item) => [globalSyncIdentity(item), globalItemFingerprint(item)]));
    const next = new Map((nextState?.entries || []).map((item) => [globalSyncIdentity(item), globalItemFingerprint(item)]));
    const identities = new Set([...current.keys(), ...next.keys()]);
    return [...identities].filter((identity) => current.get(identity) !== next.get(identity));
  }

  function updateDocumentSyncForGlobalWrite(currentState, nextState, { sourceDocumentId = "", changeCount = 1 } = {}) {
    const sync = normalizeGlobalDocumentSync(currentState?.documentSync);
    const now = new Date().toISOString();
    const documentId = currentDocumentSyncId();
    if (!sync.documents[documentId]) {
      sync.documents[documentId] = {
        label: currentDocumentSyncLabel(),
        pending: false,
        pendingCount: 0,
        pendingRevision: 0,
        acknowledgedRevision: sync.revision,
        pendingEntryIdentities: [],
        registeredAt: now,
        updatedAt: now
      };
    }
    const changed = globalDatabaseContentFingerprint(currentState) !== globalDatabaseContentFingerprint(nextState);
    if (!changed) return sync;

    sync.revision += 1;
    const increment = Math.max(1, Number(changeCount) || 1);
    const changedEntryIdentities = changedGlobalDatabaseEntryIdentities(currentState, nextState);
    for (const [id, flag] of Object.entries(sync.documents)) {
      flag.updatedAt = now;
      if (id === sourceDocumentId) {
        flag.pending = false;
        flag.pendingCount = 0;
        flag.pendingRevision = 0;
        flag.acknowledgedRevision = sync.revision;
        flag.pendingEntryIdentities = [];
      } else {
        const pendingEntryIdentities = new Set(flag.pendingEntryIdentities || []);
        for (const identity of changedEntryIdentities) pendingEntryIdentities.add(identity);
        flag.pending = true;
        flag.pendingEntryIdentities = [...pendingEntryIdentities];
        flag.pendingCount = flag.pendingEntryIdentities.length
          ? flag.pendingEntryIdentities.length
          : Math.max(0, Number(flag.pendingCount) || 0) + increment;
        flag.pendingRevision = sync.revision;
      }
    }
    return sync;
  }

  async function registerCurrentDocumentWithGlobalDatabase() {
    const current = await loadGlobalDatabaseState();
    const sync = normalizeGlobalDocumentSync(current.documentSync);
    const documentId = currentDocumentSyncId();
    if (sync.documents[documentId]) return sync.documents[documentId];
    const now = new Date().toISOString();
    const hasGlobalData = Array.isArray(current.entries) && current.entries.length > 0;
    // Existing projects created before per-document flags receive one explicit
    // collection cycle after upgrading. Afterwards only the flag is consulted.
    const pending = hasGlobalData;
    sync.documents[documentId] = {
      label: currentDocumentSyncLabel(),
      pending,
      pendingCount: pending ? 1 : 0,
      pendingRevision: pending ? sync.revision : 0,
      acknowledgedRevision: pending ? 0 : sync.revision,
      pendingEntryIdentities: [],
      registeredAt: now,
      updatedAt: now
    };
    await extensionApi.storage.local.set({
      [GLOBAL_DATABASE_KEY]: { ...current, documentSync: sync }
    });
    return sync.documents[documentId];
  }

  async function acknowledgeCurrentDocumentGlobalChanges() {
    const current = await loadGlobalDatabaseState();
    const sync = normalizeGlobalDocumentSync(current.documentSync);
    const documentId = currentDocumentSyncId();
    const now = new Date().toISOString();
    const existing = sync.documents[documentId] || {};
    sync.documents[documentId] = {
      label: currentDocumentSyncLabel(),
      pending: false,
      pendingCount: 0,
      pendingRevision: 0,
      acknowledgedRevision: sync.revision,
      pendingEntryIdentities: [],
      registeredAt: String(existing.registeredAt || now),
      updatedAt: now
    };
    suppressGlobalDatabaseStorageSync = true;
    try {
      await extensionApi.storage.local.set({
        [GLOBAL_DATABASE_KEY]: { ...current, documentSync: sync }
      });
    } finally {
      suppressGlobalDatabaseStorageSync = false;
    }
    updateGlobalPendingUi(0, 0);
  }

  async function preserveCurrentDocumentPendingGlobalChanges(identities) {
    const remaining = [...new Set(
      [...(identities || [])]
        .map((identity) => String(identity || "").trim().toLowerCase())
        .filter((identity) => identity.startsWith("key:"))
    )];
    if (!remaining.length) {
      await acknowledgeCurrentDocumentGlobalChanges();
      return;
    }

    const current = await loadGlobalDatabaseState();
    const sync = normalizeGlobalDocumentSync(current.documentSync);
    const documentId = currentDocumentSyncId();
    const now = new Date().toISOString();
    const existing = sync.documents[documentId] || {};
    sync.documents[documentId] = {
      label: currentDocumentSyncLabel(),
      pending: true,
      pendingCount: remaining.length,
      pendingRevision: Math.max(1, Number(existing.pendingRevision) || sync.revision || 1),
      acknowledgedRevision: Math.max(0, Number(existing.acknowledgedRevision) || 0),
      pendingEntryIdentities: remaining,
      registeredAt: String(existing.registeredAt || now),
      updatedAt: now
    };
    suppressGlobalDatabaseStorageSync = true;
    try {
      await extensionApi.storage.local.set({
        [GLOBAL_DATABASE_KEY]: { ...current, documentSync: sync }
      });
    } finally {
      suppressGlobalDatabaseStorageSync = false;
    }
    updateGlobalPendingUi(remaining.length, sync.documents[documentId].pendingRevision);
    globalDocumentWasPending = true;
  }

  function globalItemToSuggestionRecord(item) {
    const fields = { ...(item?.fields || {}) };
    const authorText = stripOneBibDelimiter(fields.author || fields.editor || "");
    return {
      key: String(item?.key || "Reference"),
      type: String(item?.type || "misc"),
      fields,
      aliases: [...new Set(item?.aliases || [])],
      title: stripOneBibDelimiter(fields.title || ""),
      authors: window.CollabTeXBibTeX.splitAuthors(authorText),
      journal: stripOneBibDelimiter(fields.journal || fields.journaltitle || fields.booktitle || ""),
      year: stripOneBibDelimiter(fields.year || fields.date || ""),
      keywords: stripOneBibDelimiter(fields.keywords || fields.keyword || ""),
      abstract: normalizeAbstractText(stripOneBibDelimiter(fields.abstract || "")),
      doi: normalizeDoiInput(stripOneBibDelimiter(fields.doi || "")),
      url: stripOneBibDelimiter(fields.url || ""),
      sourceFile: "",
      ctcaGlobalPending: true
    };
  }

  function pendingSuggestionRecords() {
    if (!globalDocumentPendingCount || !globalSuggestionRecords.length) return records;
    const combined = new Map();
    for (const record of records) {
      const deletionId = globalIdentity(globalItemFromRecord(record));
      if (!globalSuggestionDeletedIdentities.has(deletionId)) combined.set(String(record.key || "").toLowerCase(), record);
    }
    for (const record of globalSuggestionRecords) combined.set(String(record.key || "").toLowerCase(), record);
    return [...combined.values()];
  }

  function updateGlobalPendingUi(count, revision = 0) {
    globalDocumentPendingCount = Math.max(0, Number(count) || 0);
    globalDocumentPendingRevision = Math.max(0, Number(revision) || 0);
    toolbarButton.classList.toggle("ctca-global-pending", globalDocumentPendingCount > 0);
    if (globalDocumentPendingCount > 0) {
      toolbarButton.dataset.globalPendingCount = globalDocumentPendingCount > 99 ? "99+" : String(globalDocumentPendingCount);
      toolbarButton.title = `${globalDocumentPendingCount} global bibliography change${globalDocumentPendingCount === 1 ? "" : "s"} waiting to be synchronized`;
    } else {
      delete toolbarButton.dataset.globalPendingCount;
      toolbarButton.title = "Open bibliography manager";
      globalSuggestionRecords = [];
      globalSuggestionDeletedIdentities = new Set();
      globalDocumentWasPending = false;
      hideGlobalBanner();
    }
    if (popup.classList.contains("ctca-visible")) renderSuggestions();
  }

  async function syncPendingGlobalChangesNow() {
    const returnTexFile = captureSelectedTexFile(managerOriginalFile);
    try {
      const texState = await getManagerTexState();
      const files = findBibliographyFiles(texState.value, texState.cursorIndex);
      if (!files.length) throw new Error("No bibliography file is configured in this document.");
      await openFileAndWait(files[0]);
      window.clearTimeout(globalDatabaseSyncTimer);
      globalDatabaseSyncTimer = null;
      const result = await synchronizeProjectWithGlobalDatabase({ reason: "Sync now", announce: true, force: true });
      if (result && !result.cancelled) hideGlobalBanner();
      return result;
    } finally {
      if (returnTexFile) await restoreFile(returnTexFile, { waitForStable: false });
    }
  }

  async function selectPendingGlobalChangesNow() {
    const originalFile = captureSelectedTexFile(managerOriginalFile) || getSelectedFileName() || currentState?.fileName || "";
    const localDeletedGlobalIdentities = managerChosenCentralDeletionIdentities();
    let candidates = [];
    let selectedIdentities = null;
    let result = null;
    let failure = null;
    hideGlobalBanner();
    showDocumentBibliographyUpdateOverlay();
    try {
      await pauseFastManagerCentralSync();
      managerOriginalFile = originalFile;
      if (managerDirtyIds.size || managerDeletedDrafts.size) {
        await managerWriteDirtyEntries({ scheduleSync: false, fastRestore: true });
      } else {
        await managerLoadBibliography({ saveDirty: false, scheduleSync: false });
      }
      candidates = await loadPendingGlobalImportCandidates();
      hideDocumentBibliographyUpdateOverlay();
      if (candidates.length) {
        selectedIdentities = await choosePendingGlobalImports(candidates);
        if (selectedIdentities === null) return null;
      } else {
        selectedIdentities = new Set();
      }

      const excludedGlobalImportIdentities = new Set(
        candidates
          .map(globalSyncIdentity)
          .filter((identity) => !selectedIdentities.has(identity))
      );
      showDocumentBibliographyUpdateOverlay();
      window.clearTimeout(globalDatabaseSyncTimer);
      globalDatabaseSyncTimer = null;
      result = await synchronizeProjectWithGlobalDatabase({
        reason: "selected pending global changes",
        announce: true,
        force: true,
        allowManagerSession: true,
        localDeletedGlobalIdentities,
        excludedGlobalImportIdentities
      });
      if (!result) throw new Error("The document bibliography could not be synchronized.");
      return result;
    } catch (error) {
      failure = error;
      return null;
    } finally {
      hideDocumentBibliographyUpdateOverlay();
      if (originalFile) await restoreFile(originalFile, { waitForStable: false });
      if (failure) {
        showGlobalBanner(failure.message || String(failure), { autoHideMs: 10000 });
      } else if (selectedIdentities === null || globalDocumentPendingCount > 0) {
        showPendingGlobalSyncBanner();
      } else {
        hideGlobalBanner();
      }
    }
  }

  function ensureDocumentBibliographyUpdateOverlay() {
    if (documentBibliographyUpdateOverlay) return documentBibliographyUpdateOverlay;
    const overlay = document.createElement("div");
    overlay.id = "ctca-document-bibliography-update-overlay";
    overlay.setAttribute("role", "status");
    overlay.setAttribute("aria-live", "polite");
    overlay.setAttribute("aria-hidden", "true");
    overlay.innerHTML = `
      <div class="ctca-document-bibliography-update-card">
        <span class="ctca-document-bibliography-update-spinner" aria-hidden="true"></span>
        <span>Updating bib file</span>
      </div>
    `;
    document.documentElement.appendChild(overlay);
    documentBibliographyUpdateOverlay = overlay;
    return overlay;
  }

  function showDocumentBibliographyUpdateOverlay() {
    hideGlobalBanner();
    const overlay = ensureDocumentBibliographyUpdateOverlay();
    overlay.classList.add("ctca-document-bibliography-update-visible");
    overlay.setAttribute("aria-hidden", "false");
  }

  function hideDocumentBibliographyUpdateOverlay() {
    documentBibliographyUpdateOverlay?.classList.remove("ctca-document-bibliography-update-visible");
    documentBibliographyUpdateOverlay?.setAttribute("aria-hidden", "true");
  }

  function showPendingGlobalSyncBanner() {
    showGlobalBanner("New bibliography entries need to be synced to your bib file.", {
      yesLabel: "Sync now",
      noLabel: "Later",
      selectLabel: "Select",
      onYes: async () => {
        hideGlobalBanner();
        showDocumentBibliographyUpdateOverlay();
        try {
          await syncPendingGlobalChangesNow();
        } finally {
          hideDocumentBibliographyUpdateOverlay();
        }
      },
      onSelect: selectPendingGlobalChangesNow
    });
    ensureGlobalBanner().querySelector(".ctca-global-banner-yes")?.classList.add("ctca-global-banner-sync-link");
  }

  async function checkCurrentDocumentGlobalFlag({ allowAutomaticSync = true } = {}) {
    if (!settings.syncGlobalDatabase || globalDocumentFlagCheckInProgress) return null;
    globalDocumentFlagCheckInProgress = true;
    try {
      // Change detection deliberately reads only this document's flag. Entry
      // arrays are inspected only after the flag says that changes are pending.
      const data = await extensionApi.storage.local.get(GLOBAL_DATABASE_KEY);
      const rawDatabase = data?.[GLOBAL_DATABASE_KEY] && typeof data[GLOBAL_DATABASE_KEY] === "object"
        ? data[GLOBAL_DATABASE_KEY]
        : { entries: [], deletedEntries: [], documentSync: null };
      const sync = normalizeGlobalDocumentSync(rawDatabase.documentSync);
      const documentId = currentDocumentSyncId();
      let flag = sync.documents[documentId];
      if (!flag) flag = await registerCurrentDocumentWithGlobalDatabase();
      const pending = flag?.pending === true;
      const count = pending ? Math.max(1, Number(flag.pendingCount) || 1) : 0;
      updateGlobalPendingUi(count, flag?.pendingRevision || 0);
      if (pending) {
        const managerIsApplyingChanges = Boolean(
          managerSessionChanged ||
          globalDatabaseSyncInProgress ||
          documentBibliographyUpdateOverlay?.classList.contains("ctca-document-bibliography-update-visible")
        );
        globalSuggestionRecords = (Array.isArray(rawDatabase.entries) ? rawDatabase.entries : []).map(globalItemToSuggestionRecord);
        globalSuggestionDeletedIdentities = new Set(
          normalizeGlobalDeletionTombstones(rawDatabase.deletedEntries).map((item) => item.identity)
        );
        if (popup.classList.contains("ctca-visible")) renderSuggestions();
        // A manager edit is synchronized to the central database before the
        // corresponding .bib write completes. During that short interval the
        // same edit can look like an incoming global change. The close/update
        // transaction already applies it locally, so do not prompt for it.
        if (!globalDocumentWasPending && !managerIsApplyingChanges) {
          showPendingGlobalSyncBanner();
          globalDocumentWasPending = true;
        }
        if (allowAutomaticSync && (/\.bib$/i.test(String(currentState?.fileName || "")) || bibManager.classList.contains("ctca-manager-visible"))) {
          scheduleGlobalDatabaseSync(0, "pending global changes became collectable", false, { force: true });
        }
      }
      return flag;
    } catch (error) {
      console.warn("[Smart Citations] Could not check the global bibliography flag:", error);
      return null;
    } finally {
      globalDocumentFlagCheckInProgress = false;
    }
  }

  function globalCategoryStateFromCurrentDocument(keyMap = new Map()) {
    const categories = managerCategoryState.categories.map((category) => ({
      id: category.id,
      name: category.name,
      parentId: category.parentId || "",
      order: Number(category.order) || 0
    }));
    const memberships = {};
    const sourceItems = managerDrafts.size
      ? [...managerDrafts.values()].filter((item) => item.centralPreview !== true)
      : records.filter((item) => item?.ctcaCentralPreview !== true);
    for (const item of sourceItems) {
      const entryId = managerRecordId(item);
      const categoryIds = managerEntryCategoryIds(entryId);
      if (!categoryIds.length) continue;
      const sourceKey = item.key;
      const targetKey = keyMap.get(sourceKey) || sourceKey;
      if (!targetKey) continue;
      memberships[targetKey] = [...new Set([...(memberships[targetKey] || []), ...categoryIds])];
    }
    return normalizeManagerCategoryState({ version: CATEGORY_STATE_VERSION, categories, memberships });
  }

  function mergeGlobalCategoryStates(currentValue, incomingValue, validKeys, { replace = false } = {}) {
    const current = normalizeManagerCategoryState(currentValue || {});
    const incoming = normalizeManagerCategoryState(incomingValue || {});
    const filterMemberships = (memberships) => {
      const filtered = {};
      for (const [key, ids] of Object.entries(memberships || {})) {
        if (!validKeys.has(key)) continue;
        const unique = [...new Set(ids || [])];
        if (unique.length) filtered[key] = unique;
      }
      return filtered;
    };
    if (replace) {
      return {
        categories: incoming.categories,
        memberships: filterMemberships(incoming.memberships)
      };
    }

    const categories = current.categories.map((category) => ({ ...category }));
    const existingById = new Map(categories.map((category) => [category.id, category]));
    const usedIds = new Set(existingById.keys());
    const idMap = new Map();
    const makeUniqueId = (base) => {
      let candidate = base || `category-${Date.now()}`;
      let index = 1;
      while (usedIds.has(candidate)) candidate = `${base || "category"}-import-${index++}`;
      usedIds.add(candidate);
      return candidate;
    };

    for (const category of incoming.categories) {
      const existing = existingById.get(category.id);
      if (!existing) {
        idMap.set(category.id, makeUniqueId(category.id));
      } else if (existing.name === category.name) {
        idMap.set(category.id, category.id);
      } else {
        idMap.set(category.id, makeUniqueId(category.id));
      }
    }
    for (const category of incoming.categories) {
      const mappedId = idMap.get(category.id);
      if (existingById.has(mappedId)) continue;
      const mappedParent = category.parentId ? (idMap.get(category.parentId) || category.parentId) : "";
      const imported = {
        id: mappedId,
        name: category.name,
        parentId: usedIds.has(mappedParent) ? mappedParent : "",
        order: Number(category.order) || 0
      };
      categories.push(imported);
      existingById.set(mappedId, imported);
    }

    const memberships = filterMemberships(current.memberships);
    for (const [key, categoryIds] of Object.entries(incoming.memberships || {})) {
      if (!validKeys.has(key)) continue;
      const mapped = categoryIds.map((id) => idMap.get(id) || id).filter((id) => existingById.has(id));
      if (mapped.length) memberships[key] = [...new Set([...(memberships[key] || []), ...mapped])];
    }
    return { categories, memberships };
  }


  function managerCloudConflictLabel(entry, fallback) {
    if (!entry) return fallback || "Deleted entry";
    const title = stripOneBibDelimiter(entry.fields?.title || "Untitled reference");
    return `${entry.key || fallback || "Reference"} — ${title}`;
  }

  function managerFormatNextcloudConflictEntry(entry) {
    if (!entry) return "This version contains no entry (deleted or absent).";
    const lines = [
      `Citation key: ${entry.key || ""}`,
      `Entry type: ${entry.type || "misc"}`
    ];
    for (const [name, value] of Object.entries(entry.fields || {}).sort(([left], [right]) => left.localeCompare(right))) {
      lines.push(`${name}: ${stripOneBibDelimiter(value)}`);
    }
    if ((entry.aliases || []).length) lines.push(`Aliases: ${entry.aliases.join(", ")}`);
    if ((entry.tags || []).length) lines.push(`Tags: ${entry.tags.join(", ")}`);
    if (entry.doiSyncedAt) lines.push(`DOI metadata synchronized: ${entry.doiSyncedAt}`);
    if (entry.updatedAt) lines.push(`Last local update: ${entry.updatedAt}`);
    return lines.join("\n");
  }

  function managerAddNextcloudConflictDetails(row, conflict) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "ctca-nextcloud-conflict-details-button";
    button.textContent = "Show all details";
    button.setAttribute("aria-expanded", "false");

    const panel = document.createElement("div");
    panel.className = "ctca-nextcloud-conflict-details";
    panel.hidden = true;
    const versions = [
      ["Browser version", conflict.local],
      ["Nextcloud version", conflict.remote]
    ];
    if (conflict.base) versions.push(["Last synchronized version", conflict.base]);
    for (const [title, entry] of versions) {
      const section = document.createElement("section");
      const heading = document.createElement("strong");
      const pre = document.createElement("pre");
      heading.textContent = title;
      pre.textContent = managerFormatNextcloudConflictEntry(entry);
      section.append(heading, pre);
      panel.appendChild(section);
    }
    button.addEventListener("click", () => {
      panel.hidden = !panel.hidden;
      button.textContent = panel.hidden ? "Show all details" : "Hide details";
      button.setAttribute("aria-expanded", panel.hidden ? "false" : "true");
    });
    row.append(button, panel);
  }

  async function managerResolveNextcloudConflicts(syncResult) {
    const choices = {};
    const result = await showAppDialog({
      title: "Nextcloud bibliography conflicts",
      message: "The same bibliography entries were changed differently in this browser and in Nextcloud. Choose which version to keep for each entry.",
      controls: (container) => {
        const bulkActions = document.createElement("div");
        bulkActions.className = "ctca-nextcloud-conflict-bulk-actions";
        bulkActions.innerHTML = `
          <button type="button" data-choice="local">Use all from local</button>
          <button type="button" data-choice="remote">Use all from cloud</button>`;
        const list = document.createElement("div");
        list.className = "ctca-nextcloud-conflict-list";
        bulkActions.addEventListener("click", (event) => {
          const button = event.target.closest("button[data-choice]");
          if (!button) return;
          const choice = button.dataset.choice;
          list.querySelectorAll(`input[type="radio"][value="${choice}"]`).forEach((radio) => {
            radio.checked = true;
          });
        });
        for (const conflict of syncResult.conflicts || []) {
          const row = document.createElement("fieldset");
          row.className = "ctca-nextcloud-conflict";
          const group = `ctca-cloud-${Math.random().toString(36).slice(2)}`;
          row.dataset.conflictIdentity = conflict.identity;
          row.innerHTML = `
            <legend>${managerEscapeHtml(conflict.reason || "Conflicting changes")}</legend>
            <div class="ctca-nextcloud-conflict-identity">${managerEscapeHtml(conflict.identity)}</div>
            <label><input type="radio" name="${group}" value="local" checked> <span><strong>Use browser version</strong><small>${managerEscapeHtml(managerCloudConflictLabel(conflict.local, conflict.identity))}</small></span></label>
            <label><input type="radio" name="${group}" value="remote"> <span><strong>Use Nextcloud version</strong><small>${managerEscapeHtml(managerCloudConflictLabel(conflict.remote, conflict.identity))}</small></span></label>`;
          managerAddNextcloudConflictDetails(row, conflict);
          list.appendChild(row);
        }
        container.append(bulkActions, list);
      },
      buttons: [
        { label: "Cancel", value: null },
        {
          label: "Resolve and synchronize",
          primary: true,
          getValue: () => {
            for (const row of appDialog.querySelectorAll(".ctca-nextcloud-conflict")) {
              const selected = row.querySelector('input[type="radio"]:checked');
              choices[row.dataset.conflictIdentity] = selected?.value || "local";
            }
            return choices;
          }
        }
      ],
      closeValue: null
    });
    if (!result) return false;
    await globalThis.CollabTeXAttachmentStore.resolveBibliographyConflicts(syncResult, result);
    managerSetStatus("Nextcloud bibliography conflicts resolved and synchronized.");
    return true;
  }

  async function managerSynchronizeNextcloud({ showSuccess = false, resolveConflicts = true } = {}) {
    if (managerNextcloudSyncInProgress) return null;
    const config = await globalThis.CollabTeXAttachmentStore.getConfig();
    if (!config.nextcloud?.appPassword) return null;
    managerNextcloudSyncInProgress = true;
    try {
      await globalThis.CollabTeXAttachmentStore.syncNextcloud();
      const result = await globalThis.CollabTeXAttachmentStore.syncBibliographyNextcloud();
      if (result?.status === "conflict") {
        if (!resolveConflicts) return result;
        if (appDialog.classList.contains("ctca-app-dialog-visible")) {
          managerScheduleNextcloudSync(1500);
          return result;
        }
        await managerResolveNextcloudConflicts(result);
      }
      if (showSuccess) managerSetStatus("Nextcloud synchronization completed.");
      return result;
    } catch (error) {
      managerSetStatus(`Nextcloud synchronization failed: ${error.message || String(error)}`, true);
      return null;
    } finally {
      managerNextcloudSyncInProgress = false;
    }
  }

  function managerScheduleNextcloudSync(delay = 900) {
    window.clearTimeout(managerNextcloudSyncTimer);
    managerNextcloudSyncTimer = window.setTimeout(() => {
      managerNextcloudSyncTimer = null;
      managerSynchronizeNextcloud().catch(() => {});
    }, delay);
  }

  async function managerUpdateCloudIconState(configOverride = null) {
    if (!bibManager) return false;
    const config = configOverride || await globalThis.CollabTeXAttachmentStore.getConfig();
    const nc = config?.nextcloud || {};
    const credentialsPresent = Boolean(nc.server && nc.loginName && nc.appPassword);
    let connected = false;
    if (credentialsPresent) {
      try {
        connected = await globalThis.CollabTeXAttachmentStore.checkNextcloudConnection(config);
      } catch (_error) {
        connected = false;
      }
    }
    managerNextcloudConnected = connected;
    const projectCloudButton = document.querySelector("#ctca-project-cloud-button");
    if (projectCloudButton) {
      projectCloudButton.classList.toggle("ctca-nextcloud-connected", connected);
      projectCloudButton.setAttribute("aria-pressed", connected ? "true" : "false");
      projectCloudButton.title = connected
        ? `Nextcloud connected as ${nc.loginName}; configure project-file access`
        : "Configure Nextcloud for this Collabtex project";
    }
    const active = Boolean(connected && nc.syncBibliography);
    bibManager.querySelectorAll(".ctca-manager-nextcloud-sync-checkbox").forEach((checkbox) => {
      checkbox.checked = active;
      checkbox.disabled = Boolean(managerBusy || !connected);
      const label = checkbox.closest(".ctca-manager-nextcloud-sync");
      label?.classList.toggle("ctca-nextcloud-connected", connected);
      label?.classList.toggle("ctca-nextcloud-disconnected", !connected);
      if (label) {
        label.title = connected
          ? "Synchronize the Smart Citations bibliography database with Nextcloud in the background."
          : "Connect to Nextcloud first to enable database synchronization.";
      }
    });
    bibManager.querySelectorAll(".ctca-manager-cloud-settings").forEach((button) => {
      button.classList.toggle("ctca-nextcloud-sync-active", active);
      button.setAttribute("aria-pressed", active ? "true" : "false");
      button.title = active
        ? "Nextcloud connected; bibliography synchronization is active"
        : "Configure Nextcloud and PDF storage";
    });
    return active;
  }

  async function managerOpenOptionsPage() {
    try {
      await extensionApi.runtime.openOptionsPage();
    } catch (error) {
      managerSetStatus(error?.message || "Smart Citations options could not be opened.", true);
    }
  }

  async function managerOpenCloudSettings({ context = "bibliography" } = {}) {
    const projectContext = context === "project";
    const config = await globalThis.CollabTeXAttachmentStore.getConfig();
    const initiallyConnected = Boolean(config.nextcloud?.appPassword);
    let initializedFromThisDialog = false;
    let providerSelect = null;
    let serverInput, directoryInput, syncBibliographyInput = null, statusNode;

    const result = await showAppDialog({
      title: projectContext ? "Nextcloud settings" : "Nextcloud and PDF storage settings",
      message: projectContext
        ? "Configure the Nextcloud connection used for importing and refreshing project files. Bibliography synchronization is intentionally not enabled from this window."
        : "Connect Nextcloud once. Credentials and synchronization settings are stored inside the browser extension.",
      controls: (container) => {
        const wrapper = document.createElement("div");
        wrapper.className = "ctca-pdf-dialog-grid";
        wrapper.innerHTML = `
          ${projectContext ? "" : '<label class="ctca-app-dialog-field"><span>Default PDF storage</span><select class="ctca-pdf-default-provider"><option value="browser">Browser storage</option><option value="nextcloud">Nextcloud</option><option value="local">Local disk link</option></select></label>'}
          <div class="ctca-nextcloud-settings">
            <strong>Nextcloud client login flow</strong>
            <label class="ctca-app-dialog-field"><span>Nextcloud server</span><input type="url" class="ctca-nextcloud-server" placeholder="https://cloud.example.org"></label>
            ${projectContext ? "" : '<label class="ctca-app-dialog-field"><span>Smart Citations directory</span><input type="text" class="ctca-nextcloud-directory" placeholder="Smart Citations"></label>'}
            ${projectContext ? "" : '<label class="ctca-app-dialog-check"><input type="checkbox" class="ctca-nextcloud-sync-bibliography"> Synchronize the global bibliography through global-bibliography.bib</label>'}
            <div class="ctca-nextcloud-settings-actions">
              <button type="button" class="ctca-nextcloud-connect">Connect / reconnect</button>
              <button type="button" class="ctca-nextcloud-test">Check connection</button>
              ${projectContext ? "" : '<button type="button" class="ctca-nextcloud-sync">Synchronize now</button>'}
            </div>
            <div class="ctca-nextcloud-status"></div>
          </div>`;
        container.appendChild(wrapper);
        providerSelect = wrapper.querySelector(".ctca-pdf-default-provider");
        serverInput = wrapper.querySelector(".ctca-nextcloud-server");
        directoryInput = wrapper.querySelector(".ctca-nextcloud-directory");
        syncBibliographyInput = wrapper.querySelector(".ctca-nextcloud-sync-bibliography");
        statusNode = wrapper.querySelector(".ctca-nextcloud-status");

        const setConnectionStatus = (message, state = "neutral") => {
          statusNode.textContent = message;
          statusNode.classList.toggle("ctca-nextcloud-status-success", state === "success");
          statusNode.classList.toggle("ctca-nextcloud-status-error", state === "error");
        };

        if (providerSelect) providerSelect.value = config.provider || "browser";
        serverInput.value = config.nextcloud?.server || "";
        if (directoryInput) directoryInput.value = config.nextcloud?.directory || "Smart Citations";
        if (syncBibliographyInput) syncBibliographyInput.checked = Boolean(config.nextcloud?.syncBibliography);
        setConnectionStatus(
          config.nextcloud?.appPassword
            ? `Connected to Nextcloud as ${config.nextcloud.loginName}.`
            : "Not connected.",
          config.nextcloud?.appPassword ? "success" : "neutral"
        );

        wrapper.querySelector(".ctca-nextcloud-connect").addEventListener("click", async (event) => {
          event.currentTarget.disabled = true;
          try {
            const before = await globalThis.CollabTeXAttachmentStore.getConfig();
            const firstInitialization = !before.nextcloud?.appPassword;
            const previousProvider = before.provider || "browser";
            const previousBibliographySync = Boolean(before.nextcloud?.syncBibliography);
            if (firstInitialization) {
              before.nextcloud = {
                ...(before.nextcloud || {}),
                syncBibliography: projectContext ? false : true
              };
              await globalThis.CollabTeXAttachmentStore.saveConfig(before);
            }
            await globalThis.CollabTeXAttachmentStore.connectNextcloud(
              serverInput.value,
              directoryInput?.value || before.nextcloud?.directory || "Smart Citations",
              (message) => {
                setConnectionStatus(message, String(message).startsWith("Connected to Nextcloud as ") ? "success" : "neutral");
              }
            );
            initializedFromThisDialog = firstInitialization;
            if (providerSelect) providerSelect.value = "nextcloud";
            if (syncBibliographyInput && firstInitialization) syncBibliographyInput.checked = true;
            if (projectContext) {
              const connectedConfig = await globalThis.CollabTeXAttachmentStore.getConfig();
              connectedConfig.provider = previousProvider;
              connectedConfig.nextcloud = {
                ...(connectedConfig.nextcloud || {}),
                syncBibliography: firstInitialization ? false : previousBibliographySync
              };
              await globalThis.CollabTeXAttachmentStore.saveConfig(connectedConfig);
            }
          } catch (error) {
            setConnectionStatus(error.message || String(error), "error");
          } finally {
            event.currentTarget.disabled = false;
          }
        });

        wrapper.querySelector(".ctca-nextcloud-test").addEventListener("click", async (event) => {
          event.currentTarget.disabled = true;
          try {
            setConnectionStatus("Checking Nextcloud connection…");
            const current = await globalThis.CollabTeXAttachmentStore.getConfig();
            const connected = await globalThis.CollabTeXAttachmentStore.checkNextcloudConnection(current);
            setConnectionStatus(
              connected ? `Connected to Nextcloud as ${current.nextcloud.loginName}.` : "The stored Nextcloud connection could not be verified.",
              connected ? "success" : "error"
            );
          } catch (error) {
            setConnectionStatus(error.message || String(error), "error");
          } finally {
            event.currentTarget.disabled = false;
          }
        });

        wrapper.querySelector(".ctca-nextcloud-sync")?.addEventListener("click", async (event) => {
          event.currentTarget.disabled = true;
          try {
            const current = await globalThis.CollabTeXAttachmentStore.getConfig();
            current.nextcloud = { ...(current.nextcloud || {}), syncBibliography: Boolean(syncBibliographyInput?.checked) };
            await globalThis.CollabTeXAttachmentStore.saveConfig(current);
            setConnectionStatus("Synchronizing Nextcloud…");
            const syncResult = await managerSynchronizeNextcloud({ showSuccess: false, resolveConflicts: false });
            if (syncResult?.status === "conflict") {
              setConnectionStatus("Bibliography conflicts were detected. Save and close settings to resolve them.", "error");
            } else {
              setConnectionStatus("Nextcloud synchronization completed.", "success");
            }
          } catch (error) {
            setConnectionStatus(error.message || String(error), "error");
          } finally {
            event.currentTarget.disabled = false;
          }
        });
      },
      buttons: [
        { label: "Cancel", value: null },
        {
          label: "Save settings",
          primary: true,
          getValue: () => ({
            provider: providerSelect?.value || null,
            server: serverInput.value,
            directory: directoryInput?.value || config.nextcloud?.directory || "Smart Citations",
            syncBibliography: syncBibliographyInput?.checked
          })
        }
      ],
      closeValue: null
    });

    if (!result) return false;
    const next = await globalThis.CollabTeXAttachmentStore.getConfig();
    if (result.provider) next.provider = result.provider;
    next.nextcloud = {
      ...(next.nextcloud || {}),
      server: result.server.trim(),
      directory: String(result.directory || next.nextcloud?.directory || "Smart Citations").trim() || "Smart Citations",
      syncBibliography: projectContext
        ? (initializedFromThisDialog && !initiallyConnected ? false : Boolean(next.nextcloud?.syncBibliography))
        : Boolean(result.syncBibliography)
    };
    await globalThis.CollabTeXAttachmentStore.saveConfig(next);
    await managerUpdateCloudIconState(next);
    if (projectContext) {
      showProjectCloudToast("Nextcloud project-file settings saved.");
    } else {
      managerSetStatus("Nextcloud and PDF storage settings saved.");
      managerScheduleNextcloudSync(50);
    }
    return true;
  }


  function projectNextcloudLinksKey() {
    return `${storageKey()}${PROJECT_NEXTCLOUD_LINKS_SUFFIX}`;
  }

  function normalizeProjectNextcloudLink(value) {
    if (!value || typeof value !== "object") return null;
    const nextcloudPath = globalThis.CollabTeXAttachmentStore.normalizeNextcloudPath?.(value.nextcloudPath || "") || String(value.nextcloudPath || "");
    const targetName = String(value.targetName || value.targetPath || "").split("/").pop().trim();
    if (!nextcloudPath || !targetName) return null;
    return {
      id: String(value.id || globalThis.crypto?.randomUUID?.() || `nc-${Date.now()}-${Math.random().toString(36).slice(2)}`),
      targetPath: String(value.targetPath || targetName),
      targetName,
      nextcloudPath,
      nextcloudFileId: String(value.nextcloudFileId || ""),
      etag: String(value.etag || ""),
      size: Number(value.size) || 0,
      lastModified: String(value.lastModified || ""),
      syncedAt: String(value.syncedAt || ""),
      pendingUpload: Boolean(value.pendingUpload)
    };
  }

  async function loadProjectNextcloudLinks() {
    const key = projectNextcloudLinksKey();
    const value = (await extensionApi.storage.local.get(key))?.[key];
    projectNextcloudLinks = (Array.isArray(value?.links) ? value.links : [])
      .map(normalizeProjectNextcloudLink)
      .filter(Boolean);
    return projectNextcloudLinks;
  }

  function projectNextcloudMetadataDocument() {
    return {
      version: 1,
      description: "Smart Citations Nextcloud project-file links. This file contains no credentials.",
      updatedAt: new Date().toISOString(),
      links: projectNextcloudLinks.map((link) => ({
        id: link.id,
        targetPath: link.targetPath,
        targetName: link.targetName,
        nextcloudPath: link.nextcloudPath,
        nextcloudFileId: link.nextcloudFileId,
        etag: link.etag,
        size: link.size,
        lastModified: link.lastModified,
        syncedAt: link.syncedAt
      }))
    };
  }

  function scheduleProjectNextcloudMetadataWrite(delayMs = 2500) {
    window.clearTimeout(projectNextcloudMetadataTimer);
    projectNextcloudMetadataTimer = window.setTimeout(() => {
      projectNextcloudMetadataTimer = null;
      persistProjectNextcloudMetadataFile().catch((error) => {
        console.warn("[Smart Citations] Could not persist Nextcloud project-file links:", error);
      });
    }, delayMs);
  }

  async function saveProjectNextcloudLinks({ persistProjectFile = true } = {}) {
    await extensionApi.storage.local.set({
      [projectNextcloudLinksKey()]: {
        version: 1,
        updatedAt: new Date().toISOString(),
        links: projectNextcloudLinks
      }
    });
    if (persistProjectFile) scheduleProjectNextcloudMetadataWrite();
  }

  async function persistProjectNextcloudMetadataFile() {
    if (projectNextcloudMetadataWriteInProgress || !projectNextcloudLinks.length) return;
    if (
      findNativeProjectUploadDialogs().length ||
      appDialog.classList.contains("ctca-app-dialog-visible") ||
      startupAssistantCheckInProgress ||
      projectBibliographySetupInProgress ||
      refreshInProgress ||
      jumpInProgress ||
      managerBusy
    ) {
      scheduleProjectNextcloudMetadataWrite(3000);
      return;
    }
    projectNextcloudMetadataWriteInProgress = true;
    const originalFile = getSelectedFileName() || currentState?.fileName || "";
    try {
      if (!findFileButton(PROJECT_NEXTCLOUD_LINKS_FILE)) {
        await createProjectFile(PROJECT_NEXTCLOUD_LINKS_FILE);
      }
      const state = await openFileAndWait(PROJECT_NEXTCLOUD_LINKS_FILE);
      const serialized = `${JSON.stringify(projectNextcloudMetadataDocument(), null, 2)}\n`;
      if (String(state.value || "") !== serialized) {
        await replaceEditorRangeAndVerify({
          fileName: PROJECT_NEXTCLOUD_LINKS_FILE,
          start: 0,
          end: String(state.value || "").length,
          text: serialized,
          expectedValue: serialized
        });
      }
    } finally {
      if (originalFile && originalFile !== PROJECT_NEXTCLOUD_LINKS_FILE) {
        await restoreFile(originalFile).catch(() => {});
      }
      projectNextcloudMetadataWriteInProgress = false;
    }
  }

  async function loadProjectNextcloudLinksFromMetadataFile() {
    if (!findFileButton(PROJECT_NEXTCLOUD_LINKS_FILE)) return false;
    const originalFile = getSelectedFileName() || currentState?.fileName || "";
    try {
      const text = await openAndReadFile(PROJECT_NEXTCLOUD_LINKS_FILE);
      const value = JSON.parse(String(text || "{}"));
      const fromProject = (Array.isArray(value?.links) ? value.links : [])
        .map(normalizeProjectNextcloudLink)
        .filter(Boolean);
      if (!fromProject.length) return false;
      const byIdentity = new Map(projectNextcloudLinks.map((link) => [link.id || `${link.targetPath}|${link.nextcloudPath}`, link]));
      for (const link of fromProject) {
        const key = link.id || `${link.targetPath}|${link.nextcloudPath}`;
        byIdentity.set(key, { ...(byIdentity.get(key) || {}), ...link, pendingUpload: false });
      }
      projectNextcloudLinks = [...byIdentity.values()];
      await saveProjectNextcloudLinks({ persistProjectFile: false });
      scheduleProjectNextcloudUiRefresh();
      return true;
    } finally {
      if (originalFile && originalFile !== PROJECT_NEXTCLOUD_LINKS_FILE) {
        await restoreFile(originalFile).catch(() => {});
      }
    }
  }

  function showProjectCloudToast(message, isError = false) {
    let toast = document.querySelector("#ctca-project-cloud-toast");
    if (!toast) {
      toast = document.createElement("div");
      toast.id = "ctca-project-cloud-toast";
      toast.setAttribute("role", "status");
      toast.setAttribute("aria-live", "polite");
      document.documentElement.appendChild(toast);
    }
    window.clearTimeout(projectCloudToastTimer);
    toast.textContent = String(message || "");
    toast.classList.toggle("ctca-project-cloud-toast-error", Boolean(isError));
    toast.classList.add("ctca-project-cloud-toast-visible");
    projectCloudToastTimer = window.setTimeout(() => {
      toast.classList.remove("ctca-project-cloud-toast-visible");
    }, isError ? 12000 : 7000);
  }

  function projectFileTreeItems() {
    return [...document.querySelectorAll('.file-tree-list [role="treeitem"]')];
  }

  function projectFileTreeItemName(item) {
    return String(
      item?.getAttribute("data-path") ||
      item?.getAttribute("data-file-path") ||
      item?.getAttribute("aria-label") ||
      item?.querySelector(".item-name-button span, .item-name span, .entity-name span")?.textContent ||
      ""
    ).trim();
  }

  function projectFileTreeItemBaseName(item) {
    return projectFileTreeItemName(item).replace(/\\/g, "/").split("/").pop();
  }

  function findProjectFileTreeItem(linkOrName) {
    const targetPath = typeof linkOrName === "string" ? linkOrName : linkOrName?.targetPath;
    const targetName = (typeof linkOrName === "string" ? linkOrName : linkOrName?.targetName) || String(targetPath || "").split("/").pop();
    const normalizedPath = String(targetPath || "").replace(/\\/g, "/").replace(/^\/+/, "").toLowerCase();
    return projectFileTreeItems().find((item) => {
      const itemPath = projectFileTreeItemName(item).replace(/\\/g, "/").replace(/^\/+/, "").toLowerCase();
      return (normalizedPath && itemPath === normalizedPath) || projectFileTreeItemBaseName(item).toLowerCase() === String(targetName || "").toLowerCase();
    }) || null;
  }

  function linkedRecordForTreeItem(item) {
    const itemPath = projectFileTreeItemName(item).replace(/\\/g, "/").replace(/^\/+/, "").toLowerCase();
    const itemName = projectFileTreeItemBaseName(item).toLowerCase();
    return projectNextcloudLinks.find((link) => {
      const targetPath = String(link.targetPath || "").replace(/\\/g, "/").replace(/^\/+/, "").toLowerCase();
      return (targetPath && targetPath === itemPath) || String(link.targetName || "").toLowerCase() === itemName;
    }) || null;
  }

  function scheduleProjectNextcloudUiRefresh(delayMs = 80) {
    window.clearTimeout(projectNextcloudUiTimer);
    projectNextcloudUiTimer = window.setTimeout(() => {
      projectNextcloudUiTimer = null;
      refreshProjectNextcloudUi();
    }, delayMs);
  }

  function injectProjectNextcloudFileButtons() {
    for (const item of projectFileTreeItems()) {
      const link = linkedRecordForTreeItem(item);
      const existing = item.querySelector(":scope > .ctca-nextcloud-file-refresh, .ctca-nextcloud-file-refresh");
      if (!link) {
        existing?.remove();
        item.classList.remove("ctca-nextcloud-linked-tree-item");
        continue;
      }
      item.classList.add("ctca-nextcloud-linked-tree-item");
      if (existing) {
        existing.dataset.linkId = link.id;
        continue;
      }
      const button = document.createElement("button");
      button.type = "button";
      button.className = "ctca-nextcloud-file-refresh";
      button.dataset.linkId = link.id;
      button.textContent = "☁↻";
      button.title = `Refresh ${link.targetName} from Nextcloud`;
      button.setAttribute("aria-label", `Refresh ${link.targetName} from Nextcloud`);
      button.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        refreshSingleProjectNextcloudFile(link.id).catch((error) => {
          showProjectCloudToast(error.message || String(error), true);
        });
      });
      item.appendChild(button);
    }
  }

  function findProjectFileToolbar() {
    return document.querySelector(".toolbar-filetree, .file-tree-toolbar-action-buttons, .file-tree-toolbar");
  }

  function injectProjectNextcloudUpdateAllButton() {
    const toolbar = findProjectFileToolbar();
    if (!toolbar) return;
    let button = toolbar.querySelector(".ctca-nextcloud-update-all-files");
    if (!button) {
      button = document.createElement("button");
      button.type = "button";
      button.className = "ctca-nextcloud-update-all-files";
      button.textContent = "☁↻";
      button.title = "Update all linked project files from Nextcloud";
      button.setAttribute("aria-label", "Update all linked project files from Nextcloud");
      button.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        updateAllProjectNextcloudFiles().catch((error) => {
          showProjectCloudToast(error.message || String(error), true);
        });
      });
      toolbar.appendChild(button);
    }
    button.hidden = projectNextcloudLinks.length === 0;
    button.disabled = projectNextcloudUpdateInProgress;
  }

  function findNativeProjectUploadDialogs() {
    const result = new Map();
    for (const input of document.querySelectorAll('input[type="file"]')) {
      if (input.closest("#ctca-app-dialog, #ctca-bib-manager, #ctca-popup, .ctca-nextcloud-upload-source")) continue;
      const dialog = input.closest('[role="dialog"], .modal, .modal-dialog, .modal-content') || input.parentElement;
      if (!dialog || dialog.closest("#ctca-app-dialog, #ctca-bib-manager")) continue;
      if (!isElementVisible(dialog) && !isElementVisible(input)) continue;
      const contextText = [dialog.textContent, input.getAttribute("aria-label"), input.getAttribute("title")].filter(Boolean).join(" ");
      if (!/upload|drop|browse|choose|select files?|hochladen|datei/i.test(contextText)) continue;
      result.set(dialog, input);
    }
    return [...result.entries()];
  }

  async function closeNativeProjectUploadDialog(dialog) {
    if (!dialog) return;
    const directClose = dialog.querySelector(
      '[data-bs-dismiss="modal"], [data-dismiss="modal"], .modal-header .btn-close, .modal-header .close, button[aria-label*="close" i], button[title*="close" i], button[aria-label*="schließ" i], button[title*="schließ" i]'
    );
    const closeButton = directClose || [...dialog.querySelectorAll("button")].find((candidate) => {
      const labels = [
        candidate.getAttribute("aria-label"),
        candidate.getAttribute("title"),
        candidate.textContent
      ].filter(Boolean).map((value) => String(value).replace(/\s+/g, " ").trim());
      return labels.some((label) =>
        /^(close|cancel|dismiss|×|x|schließen|abbrechen)(?:\s+(?:modal|dialog|window|fenster))?$/i.test(label)
      );
    });
    if (closeButton) closeButton.click();
    else {
      const escapeEvent = () => new KeyboardEvent("keydown", {
        key: "Escape",
        code: "Escape",
        bubbles: true,
        cancelable: true
      });
      dialog.dispatchEvent(escapeEvent());
      document.dispatchEvent(escapeEvent());
    }
    await waitForCondition(() => !dialog.isConnected || !isElementVisible(dialog), 1800, 60);
  }

  function selectedProjectNextcloudLink() {
    const selectedName = String(getSelectedFileName() || currentState?.fileName || "").replace(/\\/g, "/");
    const normalized = selectedName.replace(/^\/+/, "").toLowerCase();
    const baseName = normalized.split("/").pop();
    return projectNextcloudLinks.find((link) => {
      const targetPath = String(link.targetPath || "").replace(/\\/g, "/").replace(/^\/+/, "").toLowerCase();
      const targetName = String(link.targetName || "").toLowerCase();
      return (normalized && targetPath === normalized) || (baseName && targetName === baseName);
    }) || null;
  }

  function injectProjectNextcloudViewerRefreshButton() {
    const link = selectedProjectNextcloudLink();
    const existingButtons = [...document.querySelectorAll(".ctca-nextcloud-view-refresh")];
    if (!link) {
      existingButtons.forEach((button) => {
        const parent = button.parentElement;
        button.remove();
        parent?.classList.remove("ctca-nextcloud-view-actions");
      });
      return;
    }

    const downloadButtons = [...document.querySelectorAll("button, a")].filter((candidate) => {
      if (!isElementVisible(candidate) || candidate.closest("#ctca-app-dialog, #ctca-bib-manager, #ctca-popup")) return false;
      const labels = [
        candidate.getAttribute("aria-label"),
        candidate.getAttribute("title"),
        candidate.textContent
      ].filter(Boolean).map((value) => String(value).replace(/\s+/g, " ").trim());
      return labels.some((label) => /^(download|download file)$/i.test(label));
    });

    const validParents = new Set(downloadButtons.map((button) => button.parentElement).filter(Boolean));
    existingButtons.forEach((button) => {
      if (!validParents.has(button.parentElement)) {
        const parent = button.parentElement;
        button.remove();
        parent?.classList.remove("ctca-nextcloud-view-actions");
      }
    });

    for (const downloadButton of downloadButtons) {
      const parent = downloadButton.parentElement;
      if (!parent) continue;
      parent.classList.add("ctca-nextcloud-view-actions");
      const previous = parent.querySelector(":scope > .ctca-nextcloud-view-refresh");
      if (previous?.dataset.linkId === link.id) continue;
      previous?.remove();
      const button = document.createElement("button");
      button.type = "button";
      button.className = "ctca-nextcloud-view-refresh";
      button.dataset.linkId = link.id;
      button.textContent = "Refresh from NextCloud";
      button.title = `Refresh ${link.targetName} from Nextcloud`;
      button.setAttribute("aria-label", `Refresh ${link.targetName} from Nextcloud`);
      button.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        refreshSingleProjectNextcloudFile(link.id).catch((error) => {
          showProjectCloudToast(error.message || String(error), true);
        });
      });
      downloadButton.insertAdjacentElement("afterend", button);
    }
  }

  function injectNextcloudIntoNativeUploadDialogs() {
    for (const [dialog, input] of findNativeProjectUploadDialogs()) {
      if (dialog.querySelector(".ctca-nextcloud-upload-source")) continue;
      const source = document.createElement("div");
      source.className = "ctca-nextcloud-upload-source";
      const button = document.createElement("button");
      button.type = "button";
      button.className = "ctca-nextcloud-upload-source-button";
      button.innerHTML = '<span aria-hidden="true">☁</span><span><strong>From Nextcloud</strong><small>Select files from your connected Nextcloud account</small></span>';
      button.addEventListener("click", async (event) => {
        event.preventDefault();
        event.stopPropagation();
        button.disabled = true;
        const allowMultiple = input.multiple !== false;
        try {
          // The native Collabtex modal traps focus. Close it before opening an
          // extension-owned dialog, then reopen a fresh upload input afterwards.
          await closeNativeProjectUploadDialog(dialog);
          const connected = await ensureProjectNextcloudConnection();
          if (!connected) return;
          const selected = await showNextcloudProjectFilePicker({ multiple: allowMultiple });
          if (!selected?.length) return;
          const freshInput = await openNativeProjectUploadInput();
          await importNextcloudFilesThroughNativeInput(freshInput, selected);
        } catch (error) {
          showProjectCloudToast(error.message || String(error), true);
        } finally {
          button.disabled = false;
        }
      });
      source.appendChild(button);
      const anchor = input.closest(".form-group, .upload-area, .dropzone") || input;
      anchor.parentElement?.insertBefore(source, anchor.nextSibling);
    }
  }

  function refreshProjectNextcloudUi() {
    injectNextcloudIntoNativeUploadDialogs();
    injectProjectNextcloudFileButtons();
    injectProjectNextcloudUpdateAllButton();
    injectProjectNextcloudViewerRefreshButton();
  }

  function initializeProjectNextcloudUi() {
    if (!projectNextcloudUiObserver) {
      projectNextcloudUiObserver = new MutationObserver(() => scheduleProjectNextcloudUiRefresh());
      projectNextcloudUiObserver.observe(document.documentElement, { childList: true, subtree: true });
    }
    refreshProjectNextcloudUi();
  }

  async function ensureProjectNextcloudConnection() {
    let config = await globalThis.CollabTeXAttachmentStore.getConfig();
    if (config.nextcloud?.appPassword) {
      const connected = await globalThis.CollabTeXAttachmentStore.checkNextcloudConnection(config).catch(() => false);
      if (connected) return true;
    }
    await managerOpenCloudSettings({ context: "project" });
    config = await globalThis.CollabTeXAttachmentStore.getConfig();
    return Boolean(
      config.nextcloud?.appPassword &&
      await globalThis.CollabTeXAttachmentStore.checkNextcloudConnection(config).catch(() => false)
    );
  }

  function formatProjectCloudFileSize(bytes) {
    const value = Number(bytes) || 0;
    if (value < 1024) return `${value} B`;
    if (value < 1024 ** 2) return `${(value / 1024).toFixed(1)} kB`;
    if (value < 1024 ** 3) return `${(value / 1024 ** 2).toFixed(1)} MB`;
    return `${(value / 1024 ** 3).toFixed(1)} GB`;
  }

  function formatProjectCloudDate(value) {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? "" : date.toLocaleString();
  }

  async function showNextcloudProjectFilePicker({ multiple = true } = {}) {
    const selected = new Map();
    let currentPath = "";
    let currentEntries = [];
    let loading = false;
    let listNode, breadcrumbNode, statusNode, searchInput;
    let loadError = "";

    const result = await showAppDialog({
      title: "Select files from Nextcloud",
      message: "Browse your personal Nextcloud files. Selected files are downloaded and passed to Collabtex's native upload process.",
      controls: (container) => {
        const picker = document.createElement("div");
        picker.className = "ctca-nextcloud-file-picker";
        picker.innerHTML = `
          <div class="ctca-nextcloud-picker-toolbar">
            <button type="button" class="ctca-nextcloud-picker-up" title="Parent directory" aria-label="Parent directory">↑</button>
            <div class="ctca-nextcloud-picker-breadcrumb"></div>
            <input type="search" class="ctca-nextcloud-picker-search" placeholder="Filter this directory">
          </div>
          <div class="ctca-nextcloud-picker-list" role="listbox"></div>
          <div class="ctca-nextcloud-picker-status"></div>`;
        container.appendChild(picker);
        listNode = picker.querySelector(".ctca-nextcloud-picker-list");
        breadcrumbNode = picker.querySelector(".ctca-nextcloud-picker-breadcrumb");
        statusNode = picker.querySelector(".ctca-nextcloud-picker-status");
        searchInput = picker.querySelector(".ctca-nextcloud-picker-search");

        const updatePrimaryState = () => {
          const primary = appDialog.querySelector(".ctca-app-dialog-primary");
          if (primary) primary.disabled = loading || selected.size === 0;
          statusNode.textContent = loading
            ? "Loading Nextcloud directory…"
            : loadError || `${selected.size} file${selected.size === 1 ? "" : "s"} selected`;
          statusNode.classList.toggle("ctca-nextcloud-picker-status-error", Boolean(loadError));
        };

        const renderBreadcrumb = () => {
          breadcrumbNode.replaceChildren();
          const rootButton = document.createElement("button");
          rootButton.type = "button";
          rootButton.textContent = "Nextcloud";
          rootButton.addEventListener("click", () => loadDirectory(""));
          breadcrumbNode.appendChild(rootButton);
          let accumulated = "";
          for (const part of currentPath.split("/").filter(Boolean)) {
            breadcrumbNode.append(" / ");
            accumulated = accumulated ? `${accumulated}/${part}` : part;
            const segmentPath = accumulated;
            const segmentButton = document.createElement("button");
            segmentButton.type = "button";
            segmentButton.textContent = part;
            segmentButton.addEventListener("click", () => loadDirectory(segmentPath));
            breadcrumbNode.appendChild(segmentButton);
          }
        };

        const renderEntries = () => {
          const filter = String(searchInput.value || "").trim().toLocaleLowerCase();
          listNode.replaceChildren();
          const visible = currentEntries.filter((entry) => !filter || entry.name.toLocaleLowerCase().includes(filter));
          if (!visible.length && !loading) {
            const empty = document.createElement("div");
            empty.className = "ctca-nextcloud-picker-empty";
            empty.textContent = filter ? "No matching files in this directory." : "This directory is empty.";
            listNode.appendChild(empty);
          }
          for (const entry of visible) {
            const row = document.createElement("div");
            row.className = "ctca-nextcloud-picker-row";
            row.dataset.path = entry.path;
            const selection = document.createElement("input");
            selection.type = multiple ? "checkbox" : "radio";
            selection.name = multiple ? "" : "ctca-nextcloud-single-file";
            selection.disabled = entry.isDirectory;
            selection.checked = selected.has(entry.path);
            selection.setAttribute("aria-label", `Select ${entry.name}`);
            selection.addEventListener("change", () => {
              if (!multiple) selected.clear();
              if (selection.checked) selected.set(entry.path, entry);
              else selected.delete(entry.path);
              if (!multiple) renderEntries();
              updatePrimaryState();
            });
            const icon = document.createElement("span");
            icon.className = "ctca-nextcloud-picker-icon";
            icon.textContent = entry.isDirectory ? "📁" : "📄";
            const name = document.createElement("button");
            name.type = "button";
            name.className = "ctca-nextcloud-picker-name";
            name.textContent = entry.name;
            if (entry.isDirectory) {
              name.addEventListener("click", () => loadDirectory(entry.path));
              row.addEventListener("dblclick", () => loadDirectory(entry.path));
            } else {
              name.addEventListener("click", () => {
                if (!multiple) selected.clear();
                if (selected.has(entry.path)) selected.delete(entry.path);
                else selected.set(entry.path, entry);
                renderEntries();
                updatePrimaryState();
              });
            }
            const meta = document.createElement("span");
            meta.className = "ctca-nextcloud-picker-meta";
            meta.textContent = entry.isDirectory
              ? formatProjectCloudDate(entry.lastModified)
              : [formatProjectCloudFileSize(entry.size), formatProjectCloudDate(entry.lastModified)].filter(Boolean).join(" · ");
            row.append(selection, icon, name, meta);
            listNode.appendChild(row);
          }
          updatePrimaryState();
        };

        const loadDirectory = async (path) => {
          if (loading) return;
          loading = true;
          currentPath = globalThis.CollabTeXAttachmentStore.normalizeNextcloudPath(path);
          renderBreadcrumb();
          renderEntries();
          try {
            currentEntries = await globalThis.CollabTeXAttachmentStore.listNextcloudDirectory(currentPath);
            loadError = "";
          } catch (error) {
            currentEntries = [];
            loadError = error.message || String(error);
          } finally {
            loading = false;
            renderEntries();
          }
        };

        picker.querySelector(".ctca-nextcloud-picker-up").addEventListener("click", () => {
          const parts = currentPath.split("/").filter(Boolean);
          parts.pop();
          loadDirectory(parts.join("/"));
        });
        searchInput.addEventListener("input", renderEntries);
        window.setTimeout(() => loadDirectory(""), 0);
      },
      buttons: [
        { label: "Cancel", value: null },
        { label: "Add selected", primary: true, getValue: () => [...selected.values()] }
      ],
      closeValue: null,
      dialogClass: "ctca-nextcloud-picker-dialog-card"
    });
    return Array.isArray(result) ? result : null;
  }

  async function importNextcloudFilesThroughNativeInput(input, entries) {
    if (!input || !entries.length) return;
    showProjectCloudToast(`Downloading ${entries.length} file${entries.length === 1 ? "" : "s"} from Nextcloud…`);
    const files = [];
    const links = [];
    for (const entry of entries) {
      const downloaded = await globalThis.CollabTeXAttachmentStore.downloadNextcloudFile(entry.path);
      const info = { ...entry, ...(downloaded.info || {}) };
      const file = new File([downloaded.blob], entry.name, {
        type: info.contentType || downloaded.blob.type || "application/octet-stream",
        lastModified: info.lastModified ? (new Date(info.lastModified).getTime() || Date.now()) : Date.now()
      });
      files.push(file);
      links.push(normalizeProjectNextcloudLink({
        targetPath: entry.name,
        targetName: entry.name,
        nextcloudPath: entry.path,
        nextcloudFileId: info.fileId,
        etag: info.etag,
        size: info.size || file.size,
        lastModified: info.lastModified,
        syncedAt: new Date().toISOString(),
        pendingUpload: true
      }));
    }

    if (!input.multiple && files.length > 1) files.splice(1);
    const transfer = new DataTransfer();
    for (const file of files) transfer.items.add(file);
    input.files = transfer.files;
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));

    for (const link of links.slice(0, files.length)) {
      const existingIndex = projectNextcloudLinks.findIndex((candidate) => candidate.targetName.toLowerCase() === link.targetName.toLowerCase());
      if (existingIndex >= 0) projectNextcloudLinks[existingIndex] = { ...projectNextcloudLinks[existingIndex], ...link };
      else projectNextcloudLinks.push(link);
    }
    await saveProjectNextcloudLinks();

    window.setTimeout(async () => {
      let changed = false;
      for (const link of projectNextcloudLinks) {
        if (!link.pendingUpload) continue;
        const item = findProjectFileTreeItem(link);
        if (!item) continue;
        link.targetPath = projectFileTreeItemName(item) || link.targetName;
        link.pendingUpload = false;
        changed = true;
      }
      if (changed) await saveProjectNextcloudLinks();
      scheduleProjectNextcloudUiRefresh();
    }, 2500);
    showProjectCloudToast(`${files.length} Nextcloud file${files.length === 1 ? "" : "s"} handed to Collabtex for upload.`);
  }

  function findNativeProjectUploadButton() {
    const buttons = [...document.querySelectorAll(
      ".toolbar-filetree button, .file-tree-toolbar-action-buttons button, .file-tree-toolbar button, button"
    )];
    return buttons.find((button) => {
      if (!isElementVisible(button) || button.closest("#ctca-app-dialog, #ctca-bib-manager")) return false;
      const label = [button.getAttribute("aria-label"), button.getAttribute("title"), button.textContent].filter(Boolean).join(" ");
      return /upload( files?)?|datei(en)? hochladen/i.test(label);
    }) || null;
  }

  async function openNativeProjectUploadInput() {
    const button = findNativeProjectUploadButton();
    if (!button) throw new Error("The Collabtex file-upload button could not be found.");
    button.click();
    const input = await waitForCondition(() => {
      const dialogs = findNativeProjectUploadDialogs();
      return dialogs.map((entry) => entry[1]).find(Boolean) || null;
    }, 8000, 100);
    if (!input) throw new Error("The Collabtex upload dialog did not expose a file input.");
    return input;
  }

  async function acceptNativeOverwritePrompt(fileName) {
    const startedAt = Date.now();
    const deadline = startedAt + 4000;
    while (Date.now() < deadline) {
      const dialogs = [...document.querySelectorAll('[role="dialog"], .modal, .modal-dialog, .modal-content')]
        .filter((dialog) => !dialog.closest("#ctca-app-dialog") && isElementVisible(dialog));
      for (const dialog of dialogs) {
        const text = dialog.textContent || "";
        if (!/exist|already|replace|overwrite|conflict|besteh|ersetzen|überschreiben/i.test(text)) continue;
        if (fileName && !text.toLowerCase().includes(fileName.toLowerCase()) && dialogs.length > 1) continue;
        const button = [...dialog.querySelectorAll("button")].find((candidate) =>
          /^(replace|overwrite|upload|ersetzen|überschreiben)$/i.test((candidate.textContent || "").trim())
        );
        if (button) {
          button.click();
          return true;
        }
      }
      if (Date.now() - startedAt > 900 && findNativeProjectUploadDialogs().length === 0) return false;
      await delay(150);
    }
    return false;
  }

  async function uploadReplacementToCollabtex(link, file) {
    const item = findProjectFileTreeItem(link);
    const selectable = item?.querySelector(".item-name-button, button, [role='button']") || item;
    selectable?.click?.();
    await delay(150);
    const input = await openNativeProjectUploadInput();
    const transfer = new DataTransfer();
    transfer.items.add(file);
    input.files = transfer.files;
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
    await acceptNativeOverwritePrompt(link.targetName);
    await delay(800);
  }

  async function refreshSingleProjectNextcloudFile(linkId, { skipConfirmation = false, knownInfo = null } = {}) {
    if (projectNextcloudUpdateInProgress && !skipConfirmation) {
      throw new Error("A Nextcloud project-file update is already running.");
    }
    const link = projectNextcloudLinks.find((candidate) => candidate.id === linkId);
    if (!link) throw new Error("The Nextcloud link for this project file was not found.");
    const info = knownInfo || await globalThis.CollabTeXAttachmentStore.getNextcloudFileInfo(link.nextcloudPath);
    if (info.isDirectory) throw new Error("The linked Nextcloud source is a directory, not a file.");
    if (link.etag && info.etag && link.etag === info.etag) {
      if (!skipConfirmation) showProjectCloudToast(`${link.targetName} is already up to date.`);
      return "unchanged";
    }

    if (!skipConfirmation) {
      const confirmed = await showAppDialog({
        title: "Refresh project file from Nextcloud",
        message: `Replace ${link.targetName} with the latest Nextcloud version?\n\nNextcloud source: /${link.nextcloudPath}\nModified: ${formatProjectCloudDate(info.lastModified) || "unknown"}\nSize: ${formatProjectCloudFileSize(info.size)}`,
        buttons: [
          { label: "Cancel", value: false },
          { label: "Replace from Nextcloud", primary: true, value: true }
        ],
        closeValue: false
      });
      if (!confirmed) return "cancelled";
    }

    const downloaded = await globalThis.CollabTeXAttachmentStore.downloadNextcloudFile(link.nextcloudPath);
    const mergedInfo = { ...info, ...(downloaded.info || {}) };
    const file = new File([downloaded.blob], link.targetName, {
      type: mergedInfo.contentType || downloaded.blob.type || "application/octet-stream",
      lastModified: mergedInfo.lastModified ? (new Date(mergedInfo.lastModified).getTime() || Date.now()) : Date.now()
    });
    await uploadReplacementToCollabtex(link, file);
    Object.assign(link, {
      etag: mergedInfo.etag || info.etag || link.etag,
      nextcloudFileId: mergedInfo.fileId || info.fileId || link.nextcloudFileId,
      size: mergedInfo.size || file.size,
      lastModified: mergedInfo.lastModified || info.lastModified,
      syncedAt: new Date().toISOString(),
      pendingUpload: false
    });
    await saveProjectNextcloudLinks();
    scheduleProjectNextcloudUiRefresh();
    if (!skipConfirmation) showProjectCloudToast(`${link.targetName} was refreshed from Nextcloud.`);
    return "updated";
  }

  async function updateAllProjectNextcloudFiles() {
    if (projectNextcloudUpdateInProgress) return;
    if (!projectNextcloudLinks.length) {
      showProjectCloudToast("This project has no files linked to Nextcloud.");
      return;
    }
    if (!(await ensureProjectNextcloudConnection())) throw new Error("Nextcloud is not connected.");
    projectNextcloudUpdateInProgress = true;
    injectProjectNextcloudUpdateAllButton();
    const changed = [];
    let unavailable = 0;
    try {
      showProjectCloudToast(`Checking ${projectNextcloudLinks.length} linked file${projectNextcloudLinks.length === 1 ? "" : "s"}…`);
      for (const link of projectNextcloudLinks) {
        try {
          const info = await globalThis.CollabTeXAttachmentStore.getNextcloudFileInfo(link.nextcloudPath);
          if (!link.etag || !info.etag || link.etag !== info.etag) changed.push({ link, info });
        } catch (_error) {
          unavailable += 1;
        }
      }
      if (!changed.length) {
        showProjectCloudToast(
          unavailable
            ? `All reachable linked files are current; ${unavailable} source${unavailable === 1 ? " is" : "s are"} unavailable.`
            : "All linked Nextcloud files are already current."
        );
        return;
      }
      const confirmed = await showAppDialog({
        title: "Update all Nextcloud project files",
        message: `${changed.length} linked file${changed.length === 1 ? " has" : "s have"} a newer or changed Nextcloud source. Replace the corresponding Collabtex files now?${unavailable ? `\n\n${unavailable} source${unavailable === 1 ? " is" : "s are"} currently unavailable and will be skipped.` : ""}`,
        buttons: [
          { label: "Cancel", value: false },
          { label: `Update ${changed.length} file${changed.length === 1 ? "" : "s"}`, primary: true, value: true }
        ],
        closeValue: false
      });
      if (!confirmed) return;

      let updated = 0;
      let failed = 0;
      for (const { link, info } of changed) {
        showProjectCloudToast(`Updating ${link.targetName} from Nextcloud (${updated + failed + 1}/${changed.length})…`);
        try {
          const state = await refreshSingleProjectNextcloudFile(link.id, { skipConfirmation: true, knownInfo: info });
          if (state === "updated") updated += 1;
        } catch (_error) {
          failed += 1;
        }
      }
      showProjectCloudToast(
        `Nextcloud update complete: ${updated} updated, ${Math.max(0, projectNextcloudLinks.length - changed.length - unavailable)} already current, ${failed + unavailable} unavailable or failed.`,
        failed > 0
      );
    } finally {
      projectNextcloudUpdateInProgress = false;
      injectProjectNextcloudUpdateAllButton();
    }
  }

  async function saveGlobalDatabase(entries, {
    categoryState = null,
    replaceCategoryState = false,
    deletedEntries = null,
    sourceDocumentId = currentDocumentSyncId(),
    changeCount = 1,
    preserveSourcePending = false
  } = {}) {
    const current = await loadGlobalDatabaseState();
    const currentSync = normalizeGlobalDocumentSync(current.documentSync);
    const previousSourceFlag = preserveSourcePending && sourceDocumentId
      ? currentSync.documents[sourceDocumentId] || null
      : null;
    const normalizedEntries = (Array.isArray(entries) ? entries : []).map((entry) => {
      const { _starredDefined, ...stored } = entry || {};
      return stored;
    });
    const validKeys = new Set(normalizedEntries.map((entry) => entry.key));
    const presentIdentities = new Set(normalizedEntries.map(globalIdentity));
    const tombstones = normalizeGlobalDeletionTombstones(
      (deletedEntries === null ? current.deletedEntries : deletedEntries)
        .filter((item) => !presentIdentities.has(item.identity))
    );
    const mergedCategoryState = categoryState
      ? mergeGlobalCategoryStates(current, categoryState, validKeys, { replace: replaceCategoryState })
      : mergeGlobalCategoryStates(current, null, validKeys);
    const next = {
      version: 3,
      entries: normalizedEntries,
      categories: mergedCategoryState.categories,
      memberships: mergedCategoryState.memberships,
      deletedEntries: tombstones,
      updatedAt: new Date().toISOString()
    };
    next.documentSync = updateDocumentSyncForGlobalWrite(current, next, {
      sourceDocumentId,
      changeCount
    });
    if (previousSourceFlag?.pending === true) {
      next.documentSync.documents[sourceDocumentId] = {
        ...previousSourceFlag,
        pendingEntryIdentities: [...(previousSourceFlag.pendingEntryIdentities || [])],
        updatedAt: new Date().toISOString()
      };
    }
    await extensionApi.storage.local.set({ [GLOBAL_DATABASE_KEY]: next });
    managerScheduleNextcloudSync();
  }

  async function hasDocumentBibliographyEverBeenPushed() {
    const data = await extensionApi.storage.local.get(GLOBAL_DOCUMENT_PUSH_STATE_KEY);
    return data?.[GLOBAL_DOCUMENT_PUSH_STATE_KEY]?.pushed === true;
  }

  async function markDocumentBibliographyPushed(source = "document") {
    await extensionApi.storage.local.set({
      [GLOBAL_DOCUMENT_PUSH_STATE_KEY]: {
        version: 1,
        pushed: true,
        source,
        updatedAt: new Date().toISOString()
      }
    });
  }

  async function loadGlobalPendingState() {
    const data = await extensionApi.storage.local.get(GLOBAL_PENDING_KEY);
    return data?.[GLOBAL_PENDING_KEY] && typeof data[GLOBAL_PENDING_KEY] === "object"
      ? data[GLOBAL_PENDING_KEY]
      : { pending: false };
  }

  async function clearGlobalPendingState() {
    await extensionApi.storage.local.remove(GLOBAL_PENDING_KEY);
  }

  async function discardPendingGlobalChanges() {
    const pending = await loadGlobalPendingState();
    if (pending?.backup && Array.isArray(pending.backup.entries)) {
      await extensionApi.storage.local.set({ [GLOBAL_DATABASE_KEY]: pending.backup });
    }
    await clearGlobalPendingState();
  }

  function globalItemFromRecord(record) {
    const fields = Object.fromEntries(
      Object.entries(record?.fields || {})
        .filter(([name]) => !CTCA_INTERNAL_FIELDS.has(name))
        .map(([name, value]) => [name, stripOneBibDelimiter(value)])
    );
    const aliases = new Set([record?.key, ...splitAliasKeys(fields.ids || "")].filter(Boolean));
    return {
      key: record?.key || "Reference",
      type: record?.type || "misc",
      fields,
      aliases: [...aliases],
      tags: globalThis.CollabTeXSearchTools.splitTags(stripOneBibDelimiter(record?.fields?.[CTCA_TAGS_FIELD] || "")),
      updatedAt: new Date().toISOString(),
      addedOn: stripOneBibDelimiter(record?.fields?.[CTCA_ADDED_ON_FIELD] || "") || new Date().toISOString(),
      starred: /^(?:true|1|yes|starred)$/i.test(stripOneBibDelimiter(record?.fields?.[CTCA_STARRED_FIELD] || "")),
      _starredDefined: CTCA_STARRED_FIELD in (record?.fields || {})
    };
  }

  function globalItemsFromCurrentDocument() {
    if (bibManager.classList.contains("ctca-manager-visible") && managerDrafts.size) {
      return [...managerDrafts.values()]
        .filter((draft) => draft.centralPreview !== true)
        .map(globalItemFromDraft);
    }
    return records
      .filter((record) => record?.ctcaCentralPreview !== true)
      .map(globalItemFromRecord);
  }

  async function overwriteGlobalDatabaseWithDocument() {
    const entries = globalItemsFromCurrentDocument();
    const categoryState = globalCategoryStateFromCurrentDocument();
    await saveGlobalDatabase(entries, { categoryState, replaceCategoryState: true, deletedEntries: [] });
    await markDocumentBibliographyPushed("overwrite-from-document");
    await clearGlobalPendingState();
    managerSessionChanged = false;
    managerSetStatus(`Global database overwritten with this document's bibliography: ${entries.length} entries.`);
    return entries.length;
  }

  function updateGlobalDatabaseSyncUi() {
    bibManager.querySelectorAll(".ctca-manager-global-sync-checkbox").forEach((checkbox) => {
      checkbox.checked = Boolean(settings.syncGlobalDatabase);
    });
  }

  async function setGlobalDatabaseSyncEnabled(enabled, { runNow = true } = {}) {
    settings.syncGlobalDatabase = Boolean(enabled);
    updateGlobalDatabaseSyncUi();
    // Persist the choice only in this project's cache. Do not broadcast it as
    // a global preference: every new document must default to no synchronization.
    await saveCachedState(cachedFiles);
    await clearGlobalPendingState();
    if (settings.syncGlobalDatabase && runNow) {
      managerSetStatus("Central synchronization enabled. Central changes are shown as previews and are applied only by Update Bib or after closing.");
      await registerCurrentDocumentWithGlobalDatabase();
      await checkCurrentDocumentGlobalFlag({ allowAutomaticSync: false });
      refreshManagerPendingHighlights().catch(() => {});
    } else if (!settings.syncGlobalDatabase) {
      updateGlobalPendingUi(0, 0);
      managerSetStatus("Global database synchronization disabled.");
    }
  }

  async function askWhetherToPushDocumentChangesToGlobal({ reason = "document changes" } = {}) {
    if (!settings.syncGlobalDatabase) return "skip";
    if (bibManager.classList.contains("ctca-manager-visible")) {
      deferredProjectGlobalPush = true;
      return "deferred";
    }
    if (/\.bib$/i.test(String(currentState?.fileName || ""))) {
      scheduleGlobalDatabaseSync(0, reason, true);
      return "sync";
    }
    deferredProjectGlobalPush = true;
    return "deferred";
  }

  async function saveManagerEntriesToGlobalDatabase({ source = "manual", skipPrompt = false } = {}) {
    if (managerBusy) return;
    if (!skipPrompt) {
      const pending = await loadGlobalPendingState();
      if (pending?.pending) {
        await askWhetherToPushDocumentChangesToGlobal({ reason: source, forcePrompt: true });
        return;
      }
    }
    setManagerBusy(true, "Merging…");
    try {
      if (managerDirtyIds.size || managerDeletedDrafts.size) await managerWriteDirtyEntries();
      const globalEntries = await loadGlobalDatabase();
      const byIdentity = new Map(globalEntries.map((entry) => [globalSyncIdentity(entry), entry]));
      const documentKeyToGlobalKey = new Map();
      let added = 0;
      let mergedCount = 0;
      for (const incoming of globalItemsFromCurrentDocument()) {
        const identity = globalSyncIdentity(incoming);
        const existing = byIdentity.get(identity);
        if (existing) {
          const merged = mergeGlobalItems(existing, incoming);
          byIdentity.set(identity, merged);
          documentKeyToGlobalKey.set(incoming.key, merged.key);
          mergedCount += 1;
        } else {
          byIdentity.set(identity, incoming);
          documentKeyToGlobalKey.set(incoming.key, incoming.key);
          added += 1;
        }
      }
      const categoryState = globalCategoryStateFromCurrentDocument(documentKeyToGlobalKey);
      await saveGlobalDatabase([...byIdentity.values()], { categoryState });
      await markDocumentBibliographyPushed(source);
      managerSessionChanged = false;
      managerSetStatus(`Global database updated: ${added} added, ${mergedCount} merged, ${byIdentity.size} total entries.`);
    } catch (error) {
      managerSetStatus(error.message || String(error), true);
    } finally {
      setManagerBusy(false);
    }
  }

  function uniquePulledKey(baseKey, reserved) {
    const cleanBase = String(baseKey || "Reference").replace(/[^A-Za-z0-9_.:-]+/g, "") || "Reference";
    if (!reserved.has(cleanBase.toLowerCase())) return cleanBase;
    for (let index = 0; index < 702; index += 1) {
      const candidate = `${cleanBase}${alphabeticSuffix(index)}`;
      if (!reserved.has(candidate.toLowerCase())) return candidate;
    }
    return `${cleanBase}${Date.now()}`;
  }

  function mergeGlobalIntoDraft(draft, globalItem, { globalPrecedence = false } = {}) {
    let conflicts = 0;
    for (const [name, value] of Object.entries(globalItem.fields || {})) {
      if (!value || CTCA_INTERNAL_FIELDS.has(name)) continue;
      const current = String(draft.fields[name] || "");
      if (globalPrecedence) {
        if (current && current !== String(value)) conflicts += 1;
        draft.fields[name] = value;
      } else if (!current || (["abstract", "keywords", "title"].includes(name) && String(value).length > current.length)) {
        draft.fields[name] = value;
      }
    }
    const globalTags = globalThis.CollabTeXSearchTools.splitTags(globalItem.tags || []);
    if (globalTags.length) {
      const currentTags = globalThis.CollabTeXSearchTools.splitTags(draft.fields?.[CTCA_TAGS_FIELD] || "");
      const mergedTags = globalPrecedence ? globalTags : globalThis.CollabTeXSearchTools.splitTags([...currentTags, ...globalTags]);
      if (globalPrecedence && currentTags.join("\u0000") !== mergedTags.join("\u0000") && currentTags.length) conflicts += 1;
      draft.fields[CTCA_TAGS_FIELD] = mergedTags.join(", ");
    }
    if (globalItem.addedOn && (globalPrecedence || !managerAddedOn(draft))) {
      draft.fields[CTCA_ADDED_ON_FIELD] = globalItem.addedOn;
    }
    if (globalPrecedence || !(CTCA_STARRED_FIELD in (draft.fields || {}))) {
      draft.fields[CTCA_STARRED_FIELD] = globalItem.starred === true ? "true" : "false";
    }
    const aliases = new Set([...splitAliasKeys(draft.fields.ids || ""), globalItem.key, ...(globalItem.aliases || [])]);
    aliases.delete(draft.key);
    if (aliases.size) draft.fields.ids = [...aliases].join(", ");
    managerMarkDirty(draft, false);
    return conflicts;
  }

  async function pullGlobalDatabaseIntoProject({ globalPrecedence = false, clearPending = false, announce = true } = {}) {
    if (managerBusy) return null;
    setManagerBusy(true, "Pulling…");
    try {
      const globalEntries = await loadGlobalDatabase();
      if (!globalEntries.length) throw new Error("The global bibliography database is empty.");
      if (!managerFiles.length) await managerLoadBibliography({ saveDirty: true });
      const targetFile = managerFiles[0];
      const byIdentity = new Map();
      const byKey = new Map();
      const reserved = new Set();
      for (const draft of managerDrafts.values()) {
        const localItem = globalItemFromDraft(draft);
        byIdentity.set(globalIdentity(localItem), draft);
        for (const key of [draft.key, ...splitAliasKeys(draft.fields.ids || "")]) if (key) byKey.set(String(key).toLowerCase(), draft);
        reserved.add(draft.key.toLowerCase());
      }
      let added = 0, mergedCount = 0, conflicts = 0;
      for (const item of globalEntries) {
        const identity = globalIdentity(item);
        const duplicate = byIdentity.get(identity)
          || byKey.get(String(item.key || "").toLowerCase())
          || (item.aliases || []).map((key) => byKey.get(String(key).toLowerCase())).find(Boolean);
        if (duplicate) {
          conflicts += mergeGlobalIntoDraft(duplicate, item, { globalPrecedence });
          mergedCount += 1;
          continue;
        }
        const key = uniquePulledKey(item.key, reserved);
        reserved.add(key.toLowerCase());
        const cleanFields = Object.fromEntries(Object.entries(item.fields || {}).filter(([name]) => !CTCA_INTERNAL_FIELDS.has(name)));
        const syntheticRecord = { key, type: item.type || "misc", sourceFile: targetFile, fields: Object.fromEntries(Object.entries(cleanFields).map(([name, value]) => [name, managerWrapBibValue(value)])) };
        const draft = draftFromRecord(syntheticRecord);
        draft.originalKey = "";
        draft.key = key;
        draft.fields = cleanFields;
        const importedTags = globalThis.CollabTeXSearchTools.splitTags(item.tags || []);
        if (importedTags.length) draft.fields[CTCA_TAGS_FIELD] = importedTags.join(", ");
        const aliases = new Set([item.key, ...(item.aliases || [])]);
        aliases.delete(key);
        if (aliases.size) draft.fields.ids = [...aliases].join(", ");
        managerRecords.push(syntheticRecord);
        managerDrafts.set(draft.id, draft);
        managerDirtyIds.add(draft.id);
        byIdentity.set(identity, draft);
        for (const alias of [draft.key, ...splitAliasKeys(draft.fields.ids || "")]) if (alias) byKey.set(String(alias).toLowerCase(), draft);
        added += 1;
      }
      renderManagerList();
      updateManagerCount();
      await managerWriteDirtyEntries();
      await managerLoadBibliography({ saveDirty: false });
      if (clearPending) await clearGlobalPendingState();
      if (announce) managerSetStatus(`Applied global database: ${added} added and ${mergedCount} merged.`);
      return { added, mergedCount, conflicts };
    } catch (error) {
      managerSetStatus(error.message || String(error), true);
      if (!announce) throw error;
      return null;
    } finally {
      setManagerBusy(false);
    }
  }


  function globalSyncSnapshotKey() {
    return `${storageKey()}${GLOBAL_SYNC_SNAPSHOT_SUFFIX}`;
  }

  function globalSyncIdentity(item) {
    // Synchronization records are keyed by citation key so that two BibTeX
    // entries with the same DOI remain distinct. DOI identity is reserved for
    // explicit deletion tombstones only.
    return `key:${String(item?.key || "").trim().toLowerCase()}`;
  }

  function canonicalGlobalItem(item) {
    const fields = Object.fromEntries(
      Object.entries(item?.fields || {})
        .filter(([name]) => !CTCA_INTERNAL_FIELDS.has(name))
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([name, value]) => [name, String(value ?? "")])
    );
    const key = String(item?.key || "");
    const aliasesByIdentity = new Map();
    for (const alias of [...(item?.aliases || []), ...splitAliasKeys(fields.ids || "")]) {
      const trimmed = String(alias || "").trim();
      const identity = trimmed.toLowerCase();
      if (!identity || identity === key.trim().toLowerCase()) continue;
      if (!aliasesByIdentity.has(identity)) aliasesByIdentity.set(identity, trimmed);
    }
    const aliases = [...aliasesByIdentity.values()].sort((left, right) => left.localeCompare(right));
    if (aliases.length) fields.ids = aliases.join(", ");
    else delete fields.ids;
    return {
      key,
      type: String(item?.type || "misc"),
      fields,
      aliases,
      tags: globalThis.CollabTeXSearchTools.splitTags(item?.tags || []).slice().sort()
    };
  }

  function globalItemFingerprint(item) {
    return item ? JSON.stringify(canonicalGlobalItem(item)) : "";
  }

  function changedGlobalEntryIdentities(globalItems, snapshotItems, localItems = [], limit = Number.POSITIVE_INFINITY) {
    const changed = [];
    const localByIdentity = new Map(
      (localItems || []).map((item) => [globalSyncIdentity(item), item])
    );
    for (const item of globalItems || []) {
      const identity = globalSyncIdentity(item);
      const baseItem = snapshotItems.get(identity) || null;
      const localItem = localByIdentity.get(identity) || null;
      const changedSinceSnapshot = !baseItem || globalItemFingerprint(item) !== globalItemFingerprint(baseItem);
      const differsFromDocument = !localItem || globalItemFingerprint(item) !== globalItemFingerprint(localItem);
      if (changedSinceSnapshot && differsFromDocument) {
        changed.push({ identity, updatedAt: String(item?.updatedAt || "") });
      }
    }
    changed.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
    const maximum = Number.isFinite(Number(limit)) ? Math.max(0, Number(limit) || 0) : changed.length;
    return new Set(changed.slice(0, maximum).map((item) => item.identity));
  }

  function removeManagerCentralPreviewEntries() {
    const previewIds = new Set(
      [...managerDrafts.values()]
        .filter((draft) => draft.centralPreview === true)
        .map((draft) => draft.id)
    );
    if (!previewIds.size) return;
    managerRecords = managerRecords.filter((record) => !previewIds.has(managerRecordId(record)));
    for (const id of previewIds) {
      managerDrafts.delete(id);
      managerSelectedIds.delete(id);
      managerDirtyIds.delete(id);
    }
    if (previewIds.has(managerSelectedId)) {
      managerSelectedId = [...managerDrafts.values()].find((draft) => draft.centralPreview !== true)?.id || "";
    }
  }

  function addManagerCentralPreviewEntry(item) {
    const record = {
      key: String(item?.key || "Reference"),
      type: String(item?.type || "misc"),
      sourceFile: CENTRAL_PREVIEW_SOURCE,
      fields: { ...(item?.fields || {}) },
      ctcaCentralPreview: true
    };
    const draft = draftFromRecord(record);
    draft.centralPreview = true;
    draft.centralIdentity = globalSyncIdentity(item);
    draft.aliases = [...(item?.aliases || [])];
    if (item?.tags?.length) draft.fields[CTCA_TAGS_FIELD] = globalThis.CollabTeXSearchTools.splitTags(item.tags).join(", ");
    if (item?.addedOn) draft.fields[CTCA_ADDED_ON_FIELD] = item.addedOn;
    draft.fields[CTCA_STARRED_FIELD] = item?.starred === true ? "true" : "false";
    managerRecords.unshift(record);
    managerDrafts.set(draft.id, draft);
    return draft;
  }

  async function refreshManagerPendingHighlights() {
    if (!bibManager.classList.contains("ctca-manager-visible")) return;
    removeManagerCentralPreviewEntries();
    managerNewEntryKeys = new Set();
    managerPendingCentralIdentities = new Set();
    if (!settings.syncGlobalDatabase) {
      renderManagerList();
      return;
    }
    const [globalState, snapshot] = await Promise.all([
      loadGlobalDatabaseState(),
      loadGlobalSyncSnapshot()
    ]);
    if (!bibManager.classList.contains("ctca-manager-visible")) return;
    const documentFlag = normalizeGlobalDocumentSync(globalState.documentSync).documents[currentDocumentSyncId()];
    if (documentFlag?.pending !== true) {
      renderManagerList();
      return;
    }
    const localItems = globalItemsFromCurrentDocument();
    const changedItems = pendingGlobalChangeCandidates(
      globalState.entries || [],
      localItems,
      snapshot,
      documentFlag
    );
    const identities = new Set(changedItems.map(globalSyncIdentity));
    managerPendingCentralIdentities = new Set(identities);
    managerNewEntryKeys = new Set(
      [...identities]
        .filter((identity) => identity.startsWith("key:"))
        .map((identity) => identity.slice(4))
    );
    const newItems = pendingGlobalImportCandidates(
      globalState.entries || [],
      localItems,
      snapshot,
      documentFlag
    );
    for (const item of newItems) addManagerCentralPreviewEntry(item);
    renderManagerList();
    updateManagerCount();
  }

  function globalCollectionFingerprint(items) {
    return JSON.stringify(
      (items || [])
        .map((item) => [globalSyncIdentity(item), canonicalGlobalItem(item)])
        .sort(([left], [right]) => left.localeCompare(right))
    );
  }

  async function loadGlobalSyncSnapshot() {
    const key = globalSyncSnapshotKey();
    const data = await extensionApi.storage.local.get(key);
    const value = data?.[key];
    const items = Array.isArray(value?.items) ? value.items : [];
    return new Map(items.map((item) => [globalSyncIdentity(item), item]));
  }

  async function saveGlobalSyncSnapshot(items) {
    const key = globalSyncSnapshotKey();
    await extensionApi.storage.local.set({
      [key]: {
        version: 1,
        items: (items || []).map(canonicalGlobalItem),
        synchronizedAt: new Date().toISOString()
      }
    });
  }

  function mergeLocalChangeIntoGlobal(globalItem, localItem) {
    const merged = mergeGlobalItems(globalItem, localItem);
    merged.key = globalItem?.key || localItem?.key || merged.key;
    merged.updatedAt = new Date().toISOString();
    return merged;
  }

  function resolveThreeWayGlobalSync(localItems, globalItems, snapshotItems, deletedEntries = []) {
    const localByIdentity = new Map((localItems || []).map((item) => [globalSyncIdentity(item), item]));
    const globalByIdentity = new Map((globalItems || []).map((item) => [globalSyncIdentity(item), item]));
    const tombstoneByDeletionIdentity = new Map(
      normalizeGlobalDeletionTombstones(deletedEntries).map((item) => [item.identity, item])
    );
    const identities = new Set([
      ...localByIdentity.keys(),
      ...globalByIdentity.keys(),
      ...snapshotItems.keys()
    ]);
    const resolved = [];
    const deletions = [];
    let conflicts = 0;
    let localChanges = 0;
    let globalChanges = 0;

    for (const identity of identities) {
      const localItem = localByIdentity.get(identity) || null;
      const globalItem = globalByIdentity.get(identity) || null;
      const baseItem = snapshotItems.get(identity) || null;
      const deletionIdentity = globalIdentity(localItem || baseItem || globalItem);
      const tombstone = tombstoneByDeletionIdentity.get(deletionIdentity) || null;

      if (globalItem) {
        if (!localItem) {
          resolved.push(globalItem);
          globalChanges += 1;
          continue;
        }

        if (!baseItem) {
          // Both sides contain a previously unsynchronized citation key. The
          // global record wins field conflicts, but the citation-key record is
          // retained as its own entry rather than being collapsed by DOI.
          resolved.push(globalItem);
          if (globalItemFingerprint(localItem) !== globalItemFingerprint(globalItem)) conflicts += 1;
          continue;
        }

        const localChanged = globalItemFingerprint(localItem) !== globalItemFingerprint(baseItem);
        const globalChanged = globalItemFingerprint(globalItem) !== globalItemFingerprint(baseItem);
        if (localChanged && !globalChanged) {
          resolved.push(mergeLocalChangeIntoGlobal(globalItem, localItem));
          localChanges += 1;
        } else {
          resolved.push(globalItem);
          if (globalChanged) globalChanges += 1;
          if (localChanged && globalChanged && globalItemFingerprint(localItem) !== globalItemFingerprint(globalItem)) conflicts += 1;
        }
        continue;
      }

      if (tombstone && baseItem) {
        // Only an explicit DOI/key tombstone may remove a citation-key record,
        // and only if that exact citation-key record was part of a previous
        // successful synchronization snapshot.
        if (localItem) {
          deletions.push({ identity, local: localItem, tombstone });
          globalChanges += 1;
          if (globalItemFingerprint(localItem) !== globalItemFingerprint(baseItem)) conflicts += 1;
        }
        continue;
      }

      // Absence from global storage is never deletion. The document record is
      // pushed to global storage, including records without a DOI.
      if (localItem) {
        resolved.push(localItem);
        localChanges += 1;
      }
    }

    const reservedKeys = new Set();
    const normalized = resolved.map((item) => {
      const clone = { ...item, fields: { ...(item.fields || {}) }, aliases: [...(item.aliases || [])], tags: [...(item.tags || [])] };
      const requested = String(clone.key || "Reference");
      const key = uniquePulledKey(requested, reservedKeys);
      reservedKeys.add(key.toLowerCase());
      if (key !== requested) {
        clone.aliases = [...new Set([requested, ...(clone.aliases || [])].filter(Boolean))];
        clone.key = key;
      }
      return clone;
    });

    return { entries: normalized, deletions, conflicts, localChanges, globalChanges };
  }

  function draftSyncPayload(draft) {
    const fields = Object.fromEntries(
      Object.entries(draft.fields || {})
        .filter(([name]) => !CTCA_INTERNAL_FIELDS.has(name))
        .sort(([left], [right]) => left.localeCompare(right))
    );
    return JSON.stringify({
      key: draft.key,
      type: draft.type,
      fields,
      tags: globalThis.CollabTeXSearchTools.splitTags(draft.fields?.[CTCA_TAGS_FIELD] || []).slice().sort()
    });
  }

  async function confirmGlobalTombstoneDeletions(deletions) {
    if (!Array.isArray(deletions) || deletions.length < GLOBAL_DELETION_CONFIRM_THRESHOLD) return true;
    const preview = deletions.slice(0, 12).map(({ local, identity }) => {
      const title = stripOneBibDelimiter(local?.fields?.title || "Untitled reference");
      return `<li><strong>${managerEscapeHtml(local?.key || identity)}</strong><span>${managerEscapeHtml(title)}</span></li>`;
    }).join("");
    const remainder = deletions.length > 12
      ? `<p class="ctca-dialog-note">…and ${deletions.length - 12} more.</p>`
      : "";
    const result = await showAppDialog({
      title: `Delete ${deletions.length} entries from this document?`,
      message: "These entries carry explicit deletion markers from the global database. Missing global entries without such a marker are never deleted.",
      controls: (container) => {
        const wrapper = document.createElement("div");
        wrapper.className = "ctca-global-deletion-preview";
        wrapper.innerHTML = `<ul>${preview}</ul>${remainder}`;
        container.appendChild(wrapper);
      },
      buttons: [
        { label: "Keep document unchanged", value: false },
        { label: `Delete ${deletions.length} entries`, value: true, danger: true }
      ],
      closeValue: false,
      danger: true
    });
    return Boolean(result);
  }

  async function applyResolvedGlobalEntriesToProject(
    globalEntries,
    globalState,
    approvedDeletions = [],
    highlightedGlobalIdentities = new Set(),
    restrictGlobalUpdatesToHighlighted = false
  ) {
    const targetFile = managerFiles[0];
    if (!targetFile) throw new Error("No project BibTeX file is available for synchronization.");

    const byExactKey = new Map();
    const byDeletionIdentity = new Map();
    for (const draft of managerDrafts.values()) {
      byExactKey.set(String(draft.key || "").toLowerCase(), draft);
      for (const alias of splitAliasKeys(draft.fields.ids || "")) {
        const normalizedAlias = String(alias || "").toLowerCase();
        if (normalizedAlias && !byExactKey.has(normalizedAlias)) byExactKey.set(normalizedAlias, draft);
      }
      const deletionIdentity = globalIdentity(globalItemFromDraft(draft));
      if (!byDeletionIdentity.has(deletionIdentity)) byDeletionIdentity.set(deletionIdentity, []);
      byDeletionIdentity.get(deletionIdentity).push(draft);
    }

    const globalDeletionIdentityCounts = new Map();
    for (const item of globalEntries || []) {
      const identity = globalIdentity(item);
      globalDeletionIdentityCounts.set(identity, (globalDeletionIdentityCounts.get(identity) || 0) + 1);
    }

    const consumedDraftIds = new Set();
    for (const item of globalEntries || []) {
      const highlightAsNew = highlightedGlobalIdentities.has(globalSyncIdentity(item));
      if (restrictGlobalUpdatesToHighlighted && !highlightAsNew) continue;
      const candidateKeys = [item.key, ...(item.aliases || [])]
        .map((key) => String(key || "").toLowerCase())
        .filter(Boolean);
      let duplicate = candidateKeys.map((key) => byExactKey.get(key)).find((draft) => draft && !consumedDraftIds.has(draft.id)) || null;

      if (!duplicate) {
        // DOI fallback is safe only for a one-to-one match. This avoids
        // choosing an arbitrary citation key when several entries share a DOI.
        const deletionIdentity = globalIdentity(item);
        const localCandidates = (byDeletionIdentity.get(deletionIdentity) || []).filter((draft) => !consumedDraftIds.has(draft.id));
        if (localCandidates.length === 1 && globalDeletionIdentityCounts.get(deletionIdentity) === 1) {
          duplicate = localCandidates[0];
        }
      }

      const cleanFields = Object.fromEntries(
        Object.entries(item.fields || {}).filter(([name]) => !CTCA_INTERNAL_FIELDS.has(name))
      );
      if (item.tags?.length) cleanFields[CTCA_TAGS_FIELD] = globalThis.CollabTeXSearchTools.splitTags(item.tags).join(", ");
      if (item.addedOn) cleanFields[CTCA_ADDED_ON_FIELD] = item.addedOn;
      cleanFields[CTCA_STARRED_FIELD] = item.starred === true ? "true" : "false";

      if (duplicate) {
        consumedDraftIds.add(duplicate.id);
        const aliases = new Set([
          ...splitAliasKeys(duplicate.fields.ids || ""),
          item.key,
          ...(item.aliases || [])
        ].filter(Boolean));
        aliases.delete(duplicate.key);
        if (aliases.size) cleanFields.ids = [...aliases].join(", ");
        else delete cleanFields.ids;

        const before = draftSyncPayload(duplicate);
        // Preserve the document citation key. Global field data wins, but a
        // DOI match must never rename or remove another local citation record.
        duplicate.type = item.type || "misc";
        duplicate.fields = cleanFields;
        duplicate.sourceFile = duplicate.sourceFile || targetFile;
        if (highlightAsNew) managerNewEntryKeys.add(String(duplicate.key || "").toLowerCase());
        if (before !== draftSyncPayload(duplicate)) managerMarkDirty(duplicate, false);
      } else {
        const reservedKeys = new Set([...managerDrafts.values()].map((draft) => String(draft.key || "").toLowerCase()));
        const requestedKey = String(item.key || "Reference");
        const targetKey = uniquePulledKey(requestedKey, reservedKeys);
        const aliases = new Set([...(item.aliases || [])].filter(Boolean));
        if (targetKey !== requestedKey) aliases.add(requestedKey);
        aliases.delete(targetKey);
        if (aliases.size) cleanFields.ids = [...aliases].join(", ");
        else delete cleanFields.ids;

        const syntheticRecord = {
          key: targetKey,
          type: item.type || "misc",
          sourceFile: targetFile,
          fields: Object.fromEntries(Object.entries(cleanFields).map(([name, value]) => [name, managerWrapBibValue(value)]))
        };
        const draft = draftFromRecord(syntheticRecord);
        draft.originalKey = "";
        draft.key = targetKey;
        draft.fields = cleanFields;
        managerRecords.push(syntheticRecord);
        managerDrafts.set(draft.id, draft);
        managerDirtyIds.add(draft.id);
        if (highlightAsNew) managerNewEntryKeys.add(String(targetKey || "").toLowerCase());
        byExactKey.set(targetKey.toLowerCase(), draft);
        consumedDraftIds.add(draft.id);
      }
    }

    // Apply only the exact citation-key records approved from explicit
    // tombstones. No absence or merge omission can enter this deletion set.
    const approvedSyncIdentities = new Set(
      (approvedDeletions || []).map((item) => globalSyncIdentity(item?.local)).filter((identity) => identity !== "key:")
    );
    for (const [id, draft] of [...managerDrafts.entries()]) {
      if (!approvedSyncIdentities.has(globalSyncIdentity(globalItemFromDraft(draft)))) continue;
      managerDeletedDrafts.set(id, { ...draft });
      managerDrafts.delete(id);
      managerDirtyIds.delete(id);
      managerSelectedIds.delete(id);
    }

    // Merge category metadata without rewriting every BibTeX entry. Global
    // category definitions override equal IDs; local-only definitions and
    // memberships remain intact. Only entries whose embedded category metadata
    // actually changes are marked dirty.
    const currentState = normalizeManagerCategoryState(managerCategoryState);
    const globalCategories = normalizeManagerCategoryState({
      version: CATEGORY_STATE_VERSION,
      categories: globalState?.categories || [],
      memberships: {}
    }).categories;
    const categoryById = new Map(currentState.categories.map((category) => [category.id, { ...category }]));
    for (const category of globalCategories) categoryById.set(category.id, { ...category });
    const nextCategories = [...categoryById.values()];
    const validCategoryIds = new Set(nextCategories.map((category) => category.id));
    const nextMemberships = Object.fromEntries(
      Object.entries(currentState.memberships).map(([entryId, ids]) => [entryId, [...ids]])
    );
    const globalMemberships = globalState?.memberships && typeof globalState.memberships === "object"
      ? globalState.memberships
      : {};
    const globalMembershipsByKey = new Map(
      Object.entries(globalMemberships).map(([key, ids]) => [String(key).toLowerCase(), Array.isArray(ids) ? ids : []])
    );

    const changedMembershipDraftIds = new Set();
    for (const draft of managerDrafts.values()) {
      const lookupKeys = [draft.key, ...splitAliasKeys(draft.fields.ids || "")]
        .map((key) => String(key || "").toLowerCase())
        .filter(Boolean);
      const matched = lookupKeys.find((key) => globalMembershipsByKey.has(key));
      if (!matched) continue;
      const incomingIds = [...new Set(globalMembershipsByKey.get(matched).filter((id) => validCategoryIds.has(id)))].sort();
      const currentIds = [...new Set(nextMemberships[draft.id] || [])].sort();
      if (JSON.stringify(incomingIds) === JSON.stringify(currentIds)) continue;
      if (incomingIds.length) nextMemberships[draft.id] = incomingIds;
      else delete nextMemberships[draft.id];
      changedMembershipDraftIds.add(draft.id);
    }

    const oldCarrierIds = new Set(managerFiles.map((fileName) => managerCategoryCarrierId(fileName)).filter(Boolean));
    const treeChanged = JSON.stringify(currentState.categories) !== JSON.stringify(nextCategories);
    managerCategoryState = normalizeManagerCategoryState({
      version: CATEGORY_STATE_VERSION,
      categories: nextCategories,
      memberships: nextMemberships
    });
    for (const id of changedMembershipDraftIds) if (managerDrafts.has(id)) managerDirtyIds.add(id);
    if (treeChanged) {
      for (const id of oldCarrierIds) if (managerDrafts.has(id)) managerDirtyIds.add(id);
      for (const fileName of managerFiles) {
        const carrierId = managerCategoryCarrierId(fileName);
        if (carrierId) managerDirtyIds.add(carrierId);
      }
    }

    if (bibManager.classList.contains("ctca-manager-visible")) {
      renderManagerCategories();
      renderManagerList();
      renderManagerDetails();
      updateManagerCount();
    }

    if (managerDirtyIds.size || managerDeletedDrafts.size) {
      await managerWriteDirtyEntries();
    }
  }

  async function synchronizeProjectWithGlobalDatabase({
    reason = "background sync",
    announce = false,
    force = false,
    allowManagerSession = false,
    localDeletedGlobalIdentities = null,
    excludedGlobalImportIdentities = new Set()
  } = {}) {
    if (!settings.syncGlobalDatabase) return null;
    const excludedImportIdentities = new Set(
      [...(excludedGlobalImportIdentities || [])]
        .map((identity) => String(identity || "").trim().toLowerCase())
        .filter((identity) => identity.startsWith("key:"))
    );
    const locallyDeletedIdentities = new Set(
      [...(localDeletedGlobalIdentities === null
        ? managerPendingCentralDeletionIdentities
        : localDeletedGlobalIdentities || [])]
        .map((identity) => String(identity || "").trim().toLowerCase())
        .filter((identity) => identity.startsWith("key:"))
    );
    const managerWasVisibleAtStart = bibManager.classList.contains("ctca-manager-visible");
    if (managerWasVisibleAtStart && !allowManagerSession) return null;
    const activeFileIsBib = /\.bib$/i.test(String(currentState?.fileName || getSelectedFileName() || ""));
    if (!force && !managerWasVisibleAtStart && !activeFileIsBib) {
      return null;
    }
    if (globalDatabaseSyncInProgress || managerBusy || refreshInProgress || jumpInProgress || doiOperationInProgress) {
      globalDatabaseSyncQueued = true;
      scheduleGlobalDatabaseSync(500, reason, announce, { force });
      return null;
    }

    globalDatabaseSyncInProgress = true;
    globalDatabaseSyncQueued = false;
    const originalFile = captureSelectedTexFile(managerOriginalFile) || getSelectedFileName() || currentState?.fileName || "";
    const managerWasVisible = managerWasVisibleAtStart;
    let preservedPendingIdentities = new Set();
    setManagerCentralSyncLoading(managerWasVisible);
    setManagerBusy(true, "Syncing…");

    try {
      if (!managerFiles.length || !managerDrafts.size) {
        const texState = await getManagerTexState();
        const files = findBibliographyFiles(texState.value, texState.cursorIndex);
        if (!files.length) return null;
        managerOriginalFile = originalFile || texState.fileName;
        managerFiles = files;
        await managerLoadBibliography({ saveDirty: false });
      }

      const [globalState, snapshot] = await Promise.all([
        loadGlobalDatabaseState(),
        loadGlobalSyncSnapshot()
      ]);
      const localItems = globalItemsFromCurrentDocument();
      const storedGlobalItems = Array.isArray(globalState.entries) ? globalState.entries : [];
      const locallyDeletedGlobalItems = storedGlobalItems.filter(
        (item) => locallyDeletedIdentities.has(globalSyncIdentity(item))
      );
      const globalItems = storedGlobalItems.filter(
        (item) => !locallyDeletedIdentities.has(globalSyncIdentity(item))
      );
      const documentFlag = normalizeGlobalDocumentSync(globalState.documentSync).documents[currentDocumentSyncId()];
      const exactPendingIdentities = new Set(documentFlag?.pendingEntryIdentities || []);
      const pendingGlobalIdentities = documentFlag?.pending === true || globalDocumentPendingCount > 0
        ? (exactPendingIdentities.size
            ? exactPendingIdentities
            : changedGlobalEntryIdentities(
                globalItems,
                snapshot,
                localItems,
                Math.max(0, Number(documentFlag?.pendingCount || globalDocumentPendingCount) || 0)
              ))
        : new Set();
      for (const identity of locallyDeletedIdentities) pendingGlobalIdentities.delete(identity);
      const remainingPendingIdentities = new Set(
        [...pendingGlobalIdentities].filter((identity) => excludedImportIdentities.has(identity))
      );
      preservedPendingIdentities = remainingPendingIdentities;
      const highlightedGlobalIdentities = new Set(
        [...pendingGlobalIdentities].filter((identity) => !remainingPendingIdentities.has(identity))
      );
      const resolved = resolveThreeWayGlobalSync(localItems, globalItems, snapshot, globalState.deletedEntries);

      const deletionSignature = JSON.stringify(
        resolved.deletions
          .map(({ identity, tombstone }) => [identity, String(tombstone?.deletedAt || "")])
          .sort(([left], [right]) => left.localeCompare(right))
      );
      if (resolved.deletions.length >= GLOBAL_DELETION_CONFIRM_THRESHOLD && deletionSignature === blockedGlobalDeletionSignature) {
        // The user already rejected this exact deletion set. Do not reopen the
        // same safety dialog on every storage/background synchronization event.
        globalDatabaseSyncQueued = false;
        return { ...resolved, cancelled: true, previouslyDeclined: true };
      }
      if (!(await confirmGlobalTombstoneDeletions(resolved.deletions))) {
        blockedGlobalDeletionSignature = deletionSignature;
        globalDatabaseSyncQueued = false;
        window.clearTimeout(globalDatabaseSyncTimer);
        globalDatabaseSyncTimer = null;
        if (announce || managerWasVisible) {
          managerSetStatus(`Synchronization paused. No document entries were deleted.`);
        }
        return { ...resolved, cancelled: true };
      }
      blockedGlobalDeletionSignature = "";

      if (
        locallyDeletedGlobalItems.length ||
        globalCollectionFingerprint(storedGlobalItems) !== globalCollectionFingerprint(resolved.entries)
      ) {
        const localDeletionTombstones = locallyDeletedGlobalItems.map((item) => ({
          identity: globalIdentity(item),
          doi: normalizeDoiInput(item?.fields?.doi || ""),
          key: String(item?.key || ""),
          title: stripOneBibDelimiter(item?.fields?.title || ""),
          deletedAt: new Date().toISOString(),
          source: "document"
        }));
        suppressGlobalDatabaseStorageSync = true;
        try {
          await saveGlobalDatabase(resolved.entries, {
            categoryState: globalCategoryStateFromCurrentDocument(),
            replaceCategoryState: false,
            deletedEntries: [...(globalState.deletedEntries || []), ...localDeletionTombstones],
            sourceDocumentId: currentDocumentSyncId(),
            changeCount: Math.max(1, resolved.localChanges + locallyDeletedGlobalItems.length || 1)
          });
        } finally {
          suppressGlobalDatabaseStorageSync = false;
        }
      }

      if (highlightedGlobalIdentities.size || resolved.deletions.length) {
        const updatedGlobalState = await loadGlobalDatabaseState();
        await applyResolvedGlobalEntriesToProject(
          resolved.entries,
          updatedGlobalState,
          resolved.deletions,
          highlightedGlobalIdentities,
          true
        );
      }
      const nextSnapshotEntries = resolved.entries.filter(
        (item) => !remainingPendingIdentities.has(globalSyncIdentity(item))
      );
      for (const identity of remainingPendingIdentities) {
        const previous = snapshot.get(identity);
        if (previous) nextSnapshotEntries.push(previous);
      }
      await Promise.all([
        saveGlobalSyncSnapshot(nextSnapshotEntries),
        clearGlobalPendingState(),
        markDocumentBibliographyPushed(`automatic-${reason}`)
      ]);
      await preserveCurrentDocumentPendingGlobalChanges(remainingPendingIdentities);
      for (const identity of locallyDeletedIdentities) {
        managerPendingCentralDeletionIdentities.delete(identity);
      }
      deferredProjectGlobalPush = false;
      managerSessionChanged = false;
      if (bibManager.classList.contains("ctca-manager-visible")) {
        await refreshManagerPendingHighlights();
      }

      if (announce || managerWasVisible) {
        const conflictText = resolved.conflicts
          ? ` ${resolved.conflicts} conflict${resolved.conflicts === 1 ? "" : "s"} resolved using global data.`
          : "";
        const pendingText = remainingPendingIdentities.size
          ? ` ${remainingPendingIdentities.size} unselected new entr${remainingPendingIdentities.size === 1 ? "y remains" : "ies remain"} pending.`
          : "";
        managerSetStatus(`Synchronized with global database.${conflictText}${pendingText}`);
      }
      return resolved;
    } catch (error) {
      if (announce || managerWasVisible) managerSetStatus(`Global database synchronization failed: ${error?.message || String(error)}`, true);
      else console.warn("[Smart Citations] Background global synchronization failed:", error);
      return null;
    } finally {
      if (originalFile) await restoreFile(originalFile, { waitForStable: false });
      setManagerCentralSyncLoading(false);
      setManagerBusy(false);
      globalDatabaseSyncInProgress = false;
      if (preservedPendingIdentities.size) {
        globalDatabaseSyncQueued = false;
        window.clearTimeout(globalDatabaseSyncTimer);
        globalDatabaseSyncTimer = null;
      } else if (globalDatabaseSyncQueued && settings.syncGlobalDatabase) {
        globalDatabaseSyncQueued = false;
        scheduleGlobalDatabaseSync(350, "queued changes", false, { force });
      }
    }
  }

  function scheduleGlobalDatabaseSync(delayMs = 250, reason = "background sync", announce = false, { force = false } = {}) {
    window.clearTimeout(globalDatabaseSyncTimer);
    if (!settings.syncGlobalDatabase || bibManager.classList.contains("ctca-manager-visible")) return;
    globalDatabaseSyncTimer = window.setTimeout(() => {
      globalDatabaseSyncTimer = null;
      synchronizeProjectWithGlobalDatabase({ reason, announce, force });
    }, Math.max(0, Number(delayMs) || 0));
  }


  function ensureGlobalBanner() {
    if (globalBanner) return globalBanner;
    globalBanner = document.createElement("div");
    globalBanner.id = "ctca-global-banner";
    globalBanner.setAttribute("role", "status");
    globalBanner.innerHTML = `
      <div class="ctca-global-banner-text"></div>
      <div class="ctca-global-banner-actions">
        <button type="button" class="ctca-global-banner-later">Not now</button>
        <button type="button" class="ctca-global-banner-select" hidden>Select</button>
        <button type="button" class="ctca-global-banner-yes">Yes</button>
      </div>
      <button type="button" class="ctca-global-banner-close" aria-label="Close banner" title="Close">×</button>
    `;
    globalBanner.querySelector(".ctca-global-banner-close").addEventListener("click", hideGlobalBanner);
    globalBanner.querySelector(".ctca-global-banner-later").addEventListener("click", hideGlobalBanner);
    document.documentElement.appendChild(globalBanner);
    return globalBanner;
  }

  function hideGlobalBanner() {
    window.clearTimeout(globalBannerTimer);
    globalBannerTimer = null;
    globalBanner?.classList.remove("ctca-global-banner-visible", "ctca-global-banner-busy");
  }

  function showGlobalBanner(message, {
    yesLabel = "Yes",
    noLabel = "Not now",
    selectLabel = "Select",
    onYes = null,
    onSelect = null,
    autoHideMs = 0
  } = {}) {
    window.clearTimeout(globalBannerTimer);
    globalBannerTimer = null;
    const banner = ensureGlobalBanner();
    banner.querySelector(".ctca-global-banner-text").textContent = message;
    const yes = banner.querySelector(".ctca-global-banner-yes");
    const later = banner.querySelector(".ctca-global-banner-later");
    const select = banner.querySelector(".ctca-global-banner-select");
    yes.classList.remove("ctca-global-banner-sync-link");
    yes.textContent = yesLabel;
    later.textContent = noLabel;
    select.textContent = selectLabel;
    yes.hidden = typeof onYes !== "function";
    later.hidden = typeof onYes !== "function";
    select.hidden = typeof onSelect !== "function";
    yes.onclick = typeof onYes === "function" ? async () => {
      banner.classList.add("ctca-global-banner-busy");
      yes.disabled = true;
      later.disabled = true;
      select.disabled = true;
      try { await onYes(); }
      finally {
        yes.disabled = false;
        later.disabled = false;
        select.disabled = false;
        banner.classList.remove("ctca-global-banner-busy");
      }
    } : null;
    select.onclick = typeof onSelect === "function" ? async () => {
      banner.classList.add("ctca-global-banner-busy");
      yes.disabled = true;
      later.disabled = true;
      select.disabled = true;
      try { await onSelect(); }
      finally {
        yes.disabled = false;
        later.disabled = false;
        select.disabled = false;
        banner.classList.remove("ctca-global-banner-busy");
      }
    } : null;
    banner.classList.add("ctca-global-banner-visible");
    if (autoHideMs > 0) globalBannerTimer = window.setTimeout(() => {
      if (banner.classList.contains("ctca-global-banner-visible")) hideGlobalBanner();
    }, autoHideMs);
  }

  async function importDocumentBibliographyToGlobalFromBanner({ enableSync = false } = {}) {
    const banner = ensureGlobalBanner();
    const text = banner.querySelector(".ctca-global-banner-text");
    const originalFile = getSelectedFileName() || currentState?.fileName || "";
    try {
      text.textContent = "Importing this document's bibliography into the global database…";
      managerOriginalFile = originalFile;
      await managerLoadBibliography({ saveDirty: false });
      if (!managerRecords.length) {
        throw new Error("The bibliography file does not contain any BibTeX entries.");
      }
      if (enableSync && !settings.syncGlobalDatabase) {
        await setGlobalDatabaseSyncEnabled(true, { runNow: false });
      }
      await saveManagerEntriesToGlobalDatabase({ source: "initial-document-import", skipPrompt: true });
      const globalState = await loadGlobalDatabaseState();
      if (!(globalState.entries || []).length) {
        throw new Error("The bibliography could not be stored in the global database.");
      }
      await registerCurrentDocumentWithGlobalDatabase();
      await acknowledgeCurrentDocumentGlobalChanges();
      showGlobalBanner(
        `Successfully synchronized ${managerRecords.length} bibliography entr${managerRecords.length === 1 ? "y" : "ies"} with the global database.`,
        { autoHideMs: 10000 }
      );
    } catch (error) {
      text.textContent = `The bibliography could not be imported: ${error.message || String(error)}`;
    } finally {
      if (originalFile) await restoreFile(originalFile);
    }
  }

  async function applyGlobalDatabaseFromBanner({ createIfMissing = false } = {}) {
    const banner = ensureGlobalBanner();
    const text = banner.querySelector(".ctca-global-banner-text");
    const originalFile = getSelectedFileName() || currentState?.fileName || "";
    try {
      text.textContent = "Applying the global bibliography database…";
      const texState = await getManagerTexState();
      let files = findBibliographyFiles(texState.value, texState.cursorIndex);
      if (!files.length && createIfMissing) {
        const created = await createProjectFile(GLOBAL_SETUP_BIB_FILE);
        const writableTexState = created ? await openFileAndWait(texState.fileName) : texState;
        await addBibliographyDeclaration(writableTexState, GLOBAL_SETUP_BIB_FILE);
        files = [GLOBAL_SETUP_BIB_FILE];
      }
      if (!files.length) throw new Error("No bibliography file is configured in this document.");
      managerOriginalFile = originalFile || texState.fileName;
      managerFiles = files;
      await managerLoadBibliography({ saveDirty: true });
      const result = await pullGlobalDatabaseIntoProject({ globalPrecedence: true, clearPending: true, announce: false });
      const conflictText = result?.conflicts ? " There were conflicts that were solved by using the extension's data." : "";
      showGlobalBanner(`Global bibliography applied: ${result?.added || 0} added and ${result?.mergedCount || 0} merged.${conflictText}`, { autoHideMs: 12000 });
    } catch (error) {
      text.textContent = `The global bibliography could not be applied: ${error.message || String(error)}`;
    } finally {
      if (originalFile) await restoreFile(originalFile);
    }
  }

  async function checkGlobalDatabasePrompts({ allowAutomaticSync = false } = {}) {
    if (startupAssistantCheckInProgress) return;
    startupAssistantCheckInProgress = true;
    let startupImportOffered = false;
    try {
      if (!globalPromptChecked) {
        // Do not classify the project or show a prompt until the root document
        // is genuinely loaded in ACE. Reading a transient empty/current file was
        // the source of false "no bibliography" detections in earlier versions.
        const texState = await getManagerTexState();
        const configured = findBibliographyFiles(texState.value, texState.cursorIndex);
        const needsSetup = configured.length === 0 || configured.every(isSampleBibliographyFile);
        globalPromptChecked = true;

        if (needsSetup) {
          await runProjectBibliographySetup();
        } else {
          const globalState = await loadGlobalDatabaseState();
          if (!(globalState.entries || []).length) {
            showGlobalBanner(
              "Do you want to use the bibliography of this document to be synchronized with the global database?",
              {
                yesLabel: "Yes",
                noLabel: "No",
                onYes: () => importDocumentBibliographyToGlobalFromBanner({ enableSync: true })
              }
            );
            startupImportOffered = true;
          }
        }
      }

      if (startupImportOffered) return;
      if (settings.syncGlobalDatabase) {
        await registerCurrentDocumentWithGlobalDatabase();
        await checkCurrentDocumentGlobalFlag({ allowAutomaticSync });
      }
    } catch (error) {
      // Keep the assistant eligible for a later retry when ColLabTeX was still
      // initializing its file tree or root-document editor session.
      globalPromptChecked = false;
      console.warn("[Smart Citations] Could not run the bibliography startup assistant:", error);
      window.setTimeout(() => checkGlobalDatabasePrompts(), 1500);
    } finally {
      startupAssistantCheckInProgress = false;
    }
  }

  function createToolbarButton() {
    const button = document.createElement("button");
    button.id = "ctca-toolbar-button";
    button.type = "button";
    button.textContent = "bib";
    button.title = "Open Smart Citations bibliography manager";
    button.setAttribute("aria-label", "Open Smart Citations bibliography manager");
    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      openBibManager();
    });

    const cloudButton = document.createElement("button");
    cloudButton.id = "ctca-project-cloud-button";
    cloudButton.type = "button";
    cloudButton.textContent = "☁";
    cloudButton.title = "Configure Nextcloud for this Collabtex project";
    cloudButton.setAttribute("aria-label", "Configure Nextcloud for this Collabtex project");
    cloudButton.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      managerOpenCloudSettings({ context: "project" }).catch((error) => {
        showProjectCloudToast(error.message || String(error), true);
      });
    });

    let overleafSlot = null;
    let cloudSlot = null;

    const directChildWithin = (element, container) => {
      let current = element;
      while (current?.parentElement && current.parentElement !== container) current = current.parentElement;
      return current?.parentElement === container ? current : element;
    };

    const findShareButton = () => [...document.querySelectorAll("button, a")].find((candidate) => {
      if (!isElementVisible(candidate)) return false;
      const label = [
        candidate.getAttribute("aria-label"),
        candidate.getAttribute("title"),
        candidate.textContent
      ].filter(Boolean).join(" ").trim();
      return /(^|\s)(share|teilen)(\s|$)/i.test(label);
    }) || null;

    const attachProjectCloudButton = () => {
      const shareButton = findShareButton();
      const fallbackActions = document.querySelector(
        ".ide-redesign-toolbar-actions, .toolbar-header .toolbar-right, .project-actions, [class*='project'][class*='actions']"
      );
      const actions = shareButton?.closest(
        ".ide-redesign-toolbar-actions, .toolbar-header .toolbar-right, .project-actions, [class*='project'][class*='actions']"
      ) || shareButton?.parentElement || fallbackActions;
      if (!actions) return;

      if (!cloudSlot || !cloudSlot.isConnected || cloudSlot.parentElement !== actions) {
        cloudSlot?.remove();
        cloudSlot = document.createElement("div");
        cloudSlot.id = "ctca-project-cloud-slot";
        cloudSlot.className = IS_OVERLEAF
          ? "ide-redesign-toolbar-button-container ctca-project-cloud-slot"
          : "ctca-project-cloud-slot";
        cloudSlot.appendChild(cloudButton);
      }

      cloudButton.className = IS_OVERLEAF
        ? "d-inline-grid btn btn-secondary btn-sm ctca-project-cloud-top-button"
        : "ctca-project-cloud-top-button";

      if (shareButton) {
        const shareContainer = directChildWithin(shareButton, actions);
        if (cloudSlot.parentElement !== actions || cloudSlot.nextSibling !== shareContainer) {
          actions.insertBefore(cloudSlot, shareContainer);
        }
      } else if (cloudSlot.parentElement !== actions) {
        actions.appendChild(cloudSlot);
      }
    };

    const attach = () => {
      if (IS_OVERLEAF) {
        const actions = document.querySelector(".ide-redesign-toolbar-actions");
        if (actions) {
          if (!overleafSlot || !overleafSlot.isConnected || overleafSlot.parentElement !== actions) {
            overleafSlot?.remove();
            overleafSlot = document.createElement("div");
            overleafSlot.id = "ctca-overleaf-toolbar-slot";
            overleafSlot.className = "ide-redesign-toolbar-button-container ctca-overleaf-toolbar-slot";
          }

          button.classList.remove("ol-cm-toolbar-button", "ctca-overleaf-toolbar-button");
          button.classList.add("d-inline-grid", "btn", "btn-primary", "btn-sm", "ctca-overleaf-top-button");
          if (button.parentElement !== overleafSlot) overleafSlot.appendChild(button);
          if (overleafSlot.parentElement !== actions) actions.insertBefore(overleafSlot, actions.firstChild);
        }
      } else {
        const toolbar = document.querySelector(".toolbar.toolbar-editor");
        if (toolbar && !(button.isConnected && toolbar.contains(button))) {
          if (getComputedStyle(toolbar).position === "static") toolbar.style.position = "relative";
          toolbar.appendChild(button);
        }
      }
      attachProjectCloudButton();
    };

    attach();
    const observer = new MutationObserver(attach);
    observer.observe(document.documentElement, { childList: true, subtree: true });
    return button;
  }

  function storageKey() {
    const projectMatch = window.location.pathname.match(/\/project\/([^/?#]+)/);
    const projectId = projectMatch?.[1] || `${window.location.pathname}${window.location.search}`;
    return `${STORAGE_PREFIX}${window.location.origin}:${projectId}`;
  }

  async function loadCachedRecords() {
    try {
      const key = storageKey();
      const data = await extensionApi.storage.local.get([key]);
      const cached = data[key];

      // Global-database synchronization is intentionally a per-project choice.
      // A newly opened ColLabTeX project therefore starts with synchronization
      // disabled even when another project enabled it previously.
      settings = mergeSettings(
        cached?.settings || {
          caseSensitive: cached?.caseSensitive,
          searchFields: cached?.searchFields,
          appearance: cached?.appearance,
          syncGlobalDatabase: false
        }
      );
      managerSelectedCategoryId = settings.managerSelectedCategoryId || "all";
      applySettingsToPopup();
      applyManagerSearchSettings();
      applyManagerColumnWidths();
      cachedFiles = Array.isArray(cached?.files) ? cached.files : [];
      legacyCachedDoiSyncLedger = cached?.doiSyncLedger && typeof cached.doiSyncLedger === "object" ? { ...cached.doiSyncLedger } : null;
      legacyCachedManagerState = cached?.managerCategoryState ? normalizeManagerCategoryState(cached.managerCategoryState) : null;
      doiSyncLedger = {};
      managerCategoryState = normalizeManagerCategoryState(null);

      if (
        cached?.cacheVersion === CACHE_VERSION &&
        Array.isArray(cached?.records)
      ) {
        records = cached.records.map((record) => ({
          ...record,
          abstract: normalizeAbstractText(record?.abstract),
          authors: window.CollabTeXBibTeX.splitAuthors(
            record?.fields?.author || record?.fields?.editor || (record?.authors || []).join(" and ")
          )
        }));
        restoreEmbeddedManagerState(records);
      }
    } catch (error) {
      console.warn("[Smart Citations] Could not load cache:", error);
    }
  }

  async function saveCachedState(files = cachedFiles) {
    cachedFiles = Array.isArray(files) ? files : [];

    try {
      const key = storageKey();
      await extensionApi.storage.local.set({
        [key]: {
          cacheVersion: CACHE_VERSION,
          records,
          files: cachedFiles,
          settings,
          ...(legacyCachedDoiSyncLedger ? { doiSyncLedger: legacyCachedDoiSyncLedger } : {}),
          ...(legacyCachedManagerState ? { managerCategoryState: legacyCachedManagerState } : {}),
          updatedAt: new Date().toISOString()
        }
      });
    } catch (error) {
      console.warn("[Smart Citations] Could not save cache:", error);
    }
  }

  function bridgeRequest(type, payload = {}, timeoutMs = 3000) {
    const requestId = `${Date.now()}-${++requestCounter}`;

    return new Promise((resolve, reject) => {
      const timeout = window.setTimeout(() => {
        pendingRequests.delete(requestId);
        reject(new Error(`Editor bridge request timed out: ${type}`));
      }, timeoutMs);

      pendingRequests.set(requestId, { resolve, reject, timeout });
      window.dispatchEvent(
        new CustomEvent(REQUEST_EVENT, {
          detail: JSON.stringify({ requestId, type, ...payload })
        })
      );
    });
  }

  function describeBibStateObservation(previousFileName, fileName, previousValue, value) {
    const firstObservation = previousValue === undefined;
    const fileWasJustOpened = previousFileName !== fileName;
    const textChanged = !firstObservation && previousValue !== value;
    return {
      firstObservation,
      fileWasJustOpened,
      textChanged,
      collectableStateChanged: firstObservation || fileWasJustOpened || textChanged
    };
  }

  function bibSyncRequestForObservation(observation, {
    syncInProgress = false,
    doiInProgress = false,
    deferredPush = false
  } = {}) {
    if (
      !syncInProgress &&
      !doiInProgress &&
      deferredPush &&
      observation.collectableStateChanged
    ) {
      return { delayMs: 250, reason: "deferred bibliography changes became collectable", force: false };
    }
    if (observation.textChanged && !syncInProgress && !doiInProgress) {
      return { delayMs: 900, reason: "active BibTeX file changed", force: false };
    }
    return null;
  }

  window.addEventListener(RESPONSE_EVENT, (event) => {
    let response = {};
    try {
      response = JSON.parse(String(event.detail || "{}"));
    } catch (_error) {
      return;
    }

    const pending = pendingRequests.get(response.requestId);
    if (!pending) return;

    window.clearTimeout(pending.timeout);
    pendingRequests.delete(response.requestId);

    if (response.ok) {
      pending.resolve(response);
    } else {
      pending.reject(new Error(response.error || "Editor bridge request failed"));
    }
  });

  window.addEventListener(STATE_EVENT, (event) => {
    let nextState;
    try {
      nextState = JSON.parse(String(event.detail || "null"));
    } catch (_error) {
      return;
    }
    const previousEditorFileName = observedEditorFileName;
    currentState = nextState;
    observedEditorFileName = String(currentState?.fileName || "");
    updateFromEditorState();
    if (settings.syncGlobalDatabase && /\.bib$/i.test(observedEditorFileName)) {
      const fileName = observedEditorFileName;
      const value = String(currentState.value || "");
      const previousValue = observedBibTextByFile.get(fileName);
      observedBibTextByFile.set(fileName, value);
      const observation = describeBibStateObservation(previousEditorFileName, fileName, previousValue, value);

      // Collaborative editors emit state events for cursor movement, rendering,
      // and remote-presence updates. Pending work must not reschedule on every
      // unchanged event or an in-progress synchronization continually queues
      // its successor.
      const request = bibSyncRequestForObservation(observation, {
        syncInProgress: globalDatabaseSyncInProgress,
        doiInProgress: doiOperationInProgress,
        deferredPush: deferredProjectGlobalPush
      });
      if (request) {
        scheduleGlobalDatabaseSync(request.delayMs, request.reason, false, { force: request.force });
      }
    }
  });

  function findCitationContext(state) {
    if (!state?.value || !Number.isInteger(state.cursorIndex)) {
      return null;
    }

    const beforeCursor = state.value.slice(0, state.cursorIndex);
    const match = beforeCursor.match(CITE_COMMAND);
    if (!match) {
      return null;
    }

    const completeMatch = match[0];
    const completeArgument = match[1];
    const matchStart = beforeCursor.length - completeMatch.length;
    const openBraceOffset = completeMatch.lastIndexOf("{");
    const lastComma = completeArgument.lastIndexOf(",");
    const rawFragmentBeforeCursor = completeArgument.slice(lastComma + 1);
    const leadingWhitespace = rawFragmentBeforeCursor.match(/^\s*/)?.[0] || "";
    const fragmentBeforeCursor = rawFragmentBeforeCursor.slice(leadingWhitespace.length);
    const fragmentStart =
      state.cursorIndex - rawFragmentBeforeCursor.length + leadingWhitespace.length;

    // ACE reports the cursor position inside the existing citation key. Extend the
    // search and replacement range to the right until the next BibTeX-key delimiter,
    // so placing the cursor in "Mackinnon2002" searches for the complete key rather
    // than only the left-hand substring before the cursor.
    const afterCursor = state.value.slice(state.cursorIndex);
    const fragmentAfterCursor = afterCursor.match(/^[^,{}\s]*/)?.[0] || "";
    const fragment = `${fragmentBeforeCursor}${fragmentAfterCursor}`;

    return {
      fragment,
      fragmentStart,
      fragmentEnd: state.cursorIndex + fragmentAfterCursor.length,
      completeArgument,
      anchorIndex: matchStart + Math.max(0, openBraceOffset)
    };
  }

  function shouldKeepSelectionDismissed(context) {
    if (!dismissedSelection) {
      return false;
    }

    if (!context) {
      dismissedSelection = null;
      return false;
    }

    const sameFragment =
      context.fragmentStart === dismissedSelection.fragmentStart &&
      context.fragment === dismissedSelection.key;

    if (sameFragment) {
      dismissedSelection.settled = true;
      return true;
    }

    if (!dismissedSelection.settled && Date.now() < dismissedSelection.deadline) {
      return true;
    }

    dismissedSelection = null;
    return false;
  }

  function citationContextId(context) {
    if (!context) return "";
    return `${currentState?.fileName || ""}:${context.anchorIndex}`;
  }

  function cancelScheduledPopup() {
    if (popupOpenTimer !== null) {
      window.clearTimeout(popupOpenTimer);
      popupOpenTimer = null;
    }
    pendingContextId = "";
  }

  function openPopupForContext(contextId) {
    popupOpenTimer = null;
    pendingContextId = "";

    if (
      refreshInProgress ||
      jumpInProgress ||
      doiOperationInProgress ||
      bibManager.classList.contains("ctca-manager-visible") ||
      !currentContext ||
      citationContextId(currentContext) !== contextId
    ) {
      return;
    }

    popupContextId = contextId;
    selectedIndex = popupKeyboardActive ? Math.max(0, selectedIndex) : -1;
    anchorScreen = currentState?.screen || anchorScreen;
    renderSuggestions();
    showPopup();
    positionPopup();
    updatePopupAnchor(currentContext);
    bridgeRequest("hideAutocomplete").catch(() => {});
  }

  function updateFromEditorState() {
    if (
      refreshInProgress ||
      jumpInProgress ||
      doiOperationInProgress ||
      bibManager.classList.contains("ctca-manager-visible")
    ) {
      cancelScheduledPopup();
      hidePopup();
      return;
    }

    currentContext = findCitationContext(currentState);
    if (shouldKeepSelectionDismissed(currentContext)) {
      hidePopup();
      return;
    }

    if (!currentContext) {
      hidePopup();
      return;
    }

    const contextId = citationContextId(currentContext);
    const now = performance.now();
    const recentTyping =
      lastEditorInteraction === "typing" &&
      now - lastEditorInteractionAt <= NAVIGATION_ENTRY_WINDOW_MS;

    if (recentTyping) {
      popupKeyboardActive = true;
    }

    anchorScreen = currentState?.screen || anchorScreen;

    if (
      popup.classList.contains("ctca-visible") &&
      popupContextId === contextId
    ) {
      selectedIndex = popupKeyboardActive ? Math.max(0, selectedIndex) : -1;
      renderSuggestions();
      positionPopup();
      updatePopupAnchor(currentContext);
      return;
    }

    if (popupOpenTimer !== null && pendingContextId === contextId) {
      selectedIndex = popupKeyboardActive ? Math.max(0, selectedIndex) : -1;
      return;
    }

    hidePopup();

    const enteredByArrowNavigation =
      lastEditorInteraction === "navigation" &&
      now - lastEditorInteractionAt <= NAVIGATION_ENTRY_WINDOW_MS;

    popupKeyboardActive = !enteredByArrowNavigation;
    selectedIndex = popupKeyboardActive ? 0 : -1;
    pendingContextId = contextId;
    popupOpenTimer = window.setTimeout(
      () => openPopupForContext(contextId),
      POPUP_OPEN_DELAY_MS
    );
  }

  async function updatePopupAnchor(context) {
    const requestNumber = ++positionRequestCounter;

    try {
      const response = await bridgeRequest(
        "getCoordinates",
        { index: context.anchorIndex },
        1200
      );

      if (
        requestNumber !== positionRequestCounter ||
        !currentContext ||
        currentContext.anchorIndex !== context.anchorIndex
      ) {
        return;
      }

      anchorScreen = response.screen || anchorScreen;
      positionPopup();
    } catch (_error) {
      // Cursor coordinates remain a safe fallback if the editor is being rerendered.
    }
  }

  function normalizeDoiInput(value) {
    return String(value ?? "")
      .trim()
      .replace(/^doi\s*:\s*/i, "")
      .replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, "")
      .replace(/[\s<>]+/g, "")
      .replace(/[),.;]+$/, "");
  }

  function isDoiQuery(value) {
    return DOI_PATTERN.test(normalizeDoiInput(value));
  }

  function parseSearchTerms(query) {
    const source = String(query ?? "").trim();
    if (!source) return [];

    const terms = [];
    const pattern = /"([^"]+)"|(\S+)/g;
    let match;
    while ((match = pattern.exec(source)) !== null) {
      const term = (match[1] ?? match[2] ?? "").trim();
      if (term) terms.push(term);
    }
    return terms;
  }

  function normalizeSearchValue(value) {
    const text = String(value ?? "");
    return settings.caseSensitive ? text : text.toLowerCase();
  }

  function scoreText(value, query, fieldOffset = 0) {
    const haystack = normalizeSearchValue(value);
    const needle = normalizeSearchValue(query);
    if (!needle || !haystack) return Number.POSITIVE_INFINITY;
    if (haystack === needle) return fieldOffset;
    if (haystack.startsWith(needle)) {
      return fieldOffset + 1 + (haystack.length - needle.length) / 10000;
    }

    const tokenStart = haystack.search(
      new RegExp(`(?:^|[\\s,;:_./()\\-])${escapeRegExp(needle)}`)
    );
    if (tokenStart >= 0) return fieldOffset + 10 + tokenStart / 1000;

    const contains = haystack.indexOf(needle);
    if (contains >= 0) return fieldOffset + 20 + contains / 1000;
    return Number.POSITIVE_INFINITY;
  }

  function scoreRecordTerm(record, term) {
    const candidates = [];
    const fields = record.fields || {};

    if (settings.searchFields.key) {
      candidates.push(scoreText(record.key, term, 0));
      candidates.push(scoreText(stripOneBibDelimiter(fields.ids || ""), term, 2));
    }
    if (settings.searchFields.title) {
      candidates.push(scoreText(record.title, term, 50));
      candidates.push(scoreText(stripOneBibDelimiter(fields.title || ""), term, 52));
    }
    if (settings.searchFields.authors) {
      candidates.push(scoreText((record.authors || []).join("; "), term, 100));
      candidates.push(scoreText(stripOneBibDelimiter(fields.author || fields.editor || ""), term, 102));
    }
    if (settings.searchFields.journal) {
      candidates.push(scoreText(record.journal, term, 150));
      candidates.push(scoreText([
        fields.journal,
        fields.journaltitle,
        fields.booktitle,
        fields.publisher,
        fields.institution,
        fields.organization,
        fields.series
      ].map(stripOneBibDelimiter).filter(Boolean).join("; "), term, 152));
    }
    if (settings.searchFields.year) {
      candidates.push(scoreText(record.year, term, 180));
      candidates.push(scoreText([
        fields.year,
        fields.date,
        fields.month,
        fields.urldate
      ].map(stripOneBibDelimiter).filter(Boolean).join("; "), term, 182));
    }
    if (settings.searchFields.keywords) {
      candidates.push(scoreText(record.keywords, term, 200));
      candidates.push(scoreText(stripOneBibDelimiter(fields.keywords || fields.keyword || fields.subject || ""), term, 202));
    }
    if (settings.searchFields.abstract) {
      candidates.push(scoreText(record.abstract, term, 300));
      candidates.push(scoreText(stripOneBibDelimiter(fields.abstract || ""), term, 302));
    }
    if (settings.searchFields.doi) {
      candidates.push(scoreText(record.doi, normalizeDoiInput(term), 400));
      candidates.push(scoreText(stripOneBibDelimiter(fields.doi || ""), normalizeDoiInput(term), 402));
    }
    if (settings.searchFields.other) {
      const dedicatedFields = new Set([
        "ids", "title", "author", "editor", "journal", "journaltitle", "booktitle",
        "publisher", "institution", "organization", "series", "year", "date", "month",
        "urldate", "keywords", "keyword", "subject", "abstract", "doi"
      ]);
      const remaining = Object.entries(fields)
        .filter(([name]) => !dedicatedFields.has(String(name).toLowerCase()))
        .flatMap(([name, value]) => [name, stripOneBibDelimiter(value)])
        .filter(Boolean)
        .join("; ");
      candidates.push(scoreText(remaining, term, 500));
    }
    return Math.min(...candidates, Number.POSITIVE_INFINITY);
  }

  function scoreRecord(record, query) {
    const terms = parseSearchTerms(query);
    if (!terms.length) return 100;

    let total = 0;
    for (const term of terms) {
      const score = scoreRecordTerm(record, term);
      if (!Number.isFinite(score)) return Number.POSITIVE_INFINITY;
      total += score;
    }
    return total;
  }

  function escapeRegExp(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  function findRecordByDoi(doi) {
    const normalized = normalizeDoiInput(doi).toLowerCase();
    if (!normalized) return null;
    return pendingSuggestionRecords().find(
      (record) => normalizeDoiInput(record.doi).toLowerCase() === normalized
    ) || null;
  }

  function citationRecordYear(record) {
    const candidate = String(
      record?.year || record?.fields?.year || record?.fields?.date || ""
    );
    const match = candidate.match(/(?:^|\D)((?:18|19|20|21)\d{2})(?:\D|$)/);
    return match ? Number(match[1]) : Number.NEGATIVE_INFINITY;
  }

  function matchingRecords(query) {
    const exactDoiRecord = isDoiQuery(query) ? findRecordByDoi(query) : null;
    const matches = pendingSuggestionRecords()
      .map((record) => ({ record, score: scoreRecord(record, query) }))
      .filter((item) => Number.isFinite(item.score))
      .sort((left, right) => {
        const leftYear = citationRecordYear(left.record);
        const rightYear = citationRecordYear(right.record);
        if (leftYear !== rightYear) {
          if (!Number.isFinite(leftYear)) return 1;
          if (!Number.isFinite(rightYear)) return -1;
          return rightYear - leftYear;
        }
        if (left.score !== right.score) return left.score - right.score;
        return left.record.key.localeCompare(right.record.key, undefined, {
          sensitivity: settings.caseSensitive ? "variant" : "base"
        });
      })
      .map((item) => item.record);

    const unique = [];
    const seen = new Set();
    if (exactDoiRecord) {
      unique.push(exactDoiRecord);
      seen.add(`${exactDoiRecord.sourceFile || ""}\u0000${exactDoiRecord.key}`);
    }
    for (const record of matches) {
      const identity = `${record.sourceFile || ""}\u0000${record.key}`;
      if (!seen.has(identity)) {
        unique.push(record);
        seen.add(identity);
      }
      if (unique.length >= MAX_RESULTS) break;
    }
    return unique;
  }

  function formatAuthors(authors) {
    if (!authors?.length) return "Authors not specified";
    const first = authors.slice(0, 3).join(", ");
    return authors.length > 3 ? `${first} et al.` : first;
  }

  function appendSeparated(parent, node, hasPrevious) {
    if (hasPrevious) parent.appendChild(document.createTextNode(", "));
    parent.appendChild(node);
    return true;
  }

  function createMetadataElement(record, openAlexLookupKey = "") {
    const metadata = document.createElement("div");
    metadata.className = "ctca-meta";
    let hasPart = false;

    if (record.journal) {
      const journal = document.createElement("span");
      journal.textContent = record.journal;
      hasPart = appendSeparated(metadata, journal, hasPart);
    }

    if (record.volume) {
      const volume = document.createElement("strong");
      volume.className = "ctca-journal-volume";
      volume.textContent = record.volume;
      hasPart = appendSeparated(metadata, volume, hasPart);
    }

    if (record.pages) {
      const pages = document.createElement("span");
      pages.textContent = record.pages;
      hasPart = appendSeparated(metadata, pages, hasPart);
    }

    if (record.year) {
      const year = document.createElement("span");
      year.textContent = `(${record.year})`;
      hasPart = appendSeparated(metadata, year, hasPart);
    }

    if (!hasPart) {
      metadata.textContent = "Publication details not specified";
    }
    const openAlexDescriptor = globalThis.SmartCitationsOpenAlex.descriptor(record, openAlexLookupKey);
    if (openAlexDescriptor.identity) {
      const citation = document.createElement("span");
      citation.className = "ctca-openalex-citation";
      citation.dataset.openalexLookupKey = openAlexDescriptor.lookupKey;
      citation.textContent = "Citations: …";
      metadata.append(document.createTextNode(" "), citation);
    }
    return metadata;
  }

  function getPaperUrl(record) {
    let candidate = "";

    if (record.doi) {
      candidate = `https://doi.org/${encodeURI(record.doi)}`;
    } else if (record.url) {
      candidate = record.url;
    }

    if (!candidate) return "";

    try {
      const url = new URL(candidate, window.location.href);
      return ["http:", "https:"].includes(url.protocol) ? url.href : "";
    } catch (_error) {
      return "";
    }
  }

  function stopActionPointer(event) {
    event.preventDefault();
    event.stopPropagation();
  }

  function createRecordActions(record) {
    const paperUrl = getPaperUrl(record);
    const hasAbstract = Boolean(record.abstract);
    const canJumpToSource = Boolean(record.sourceFile);
    const hasDoi = Boolean(record.doi);

    if (!hasAbstract && !paperUrl && !canJumpToSource && !hasDoi) {
      return null;
    }

    const actions = document.createElement("div");
    actions.className = "ctca-actions";

    if (hasAbstract) {
      const abstractButton = document.createElement("button");
      abstractButton.type = "button";
      abstractButton.className = "ctca-action ctca-abstract-button";
      abstractButton.textContent = "Abstract";
      abstractButton.setAttribute("aria-haspopup", "dialog");
      abstractButton.title = `Show abstract and full citation details for ${record.key}`;
      abstractButton.addEventListener("mousedown", stopActionPointer);
      abstractButton.addEventListener("click", (event) => {
        stopActionPointer(event);
        openAbstractOverlay(record);
      });
      actions.appendChild(abstractButton);
    }

    if (paperUrl) {
      const link = document.createElement("a");
      link.className = "ctca-action ctca-paper-link";
      link.href = paperUrl;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      link.textContent = "Open paper ↗";
      link.addEventListener("mousedown", (event) => event.stopPropagation());
      link.addEventListener("click", (event) => event.stopPropagation());
      actions.appendChild(link);
    }

    // Keep the source jump immediately to the right of the paper link. This makes
    // the two navigation actions visually adjacent while leaving the DOI refresh
    // control anchored at the far right of the action row.
    if (canJumpToSource) {
      const jumpButton = document.createElement("button");
      jumpButton.type = "button";
      jumpButton.className = "ctca-action ctca-jump-button";
      jumpButton.title = `Jump to ${record.key} in ${record.sourceFile}`;
      jumpButton.setAttribute(
        "aria-label",
        `Jump to BibTeX entry ${record.key} in ${record.sourceFile}`
      );
      jumpButton.innerHTML = '<span aria-hidden="true" class="ctca-jump-icon">→•</span>';
      jumpButton.addEventListener("mousedown", stopActionPointer);
      jumpButton.addEventListener("click", (event) => {
        stopActionPointer(event);
        jumpToBibEntry(record);
      });
      actions.appendChild(jumpButton);
    }

    if (hasDoi && canJumpToSource) {
      const doiButton = document.createElement("button");
      doiButton.type = "button";
      const doiSyncLabel = managerDoiSyncLabel(record);
      doiButton.className = `ctca-action ctca-doi-update${doiSyncLabel ? " ctca-doi-update-synced" : ""}`;
      doiButton.textContent = doiSyncLabel ? "🌐✓" : "🌐";
      doiButton.title = doiSyncLabel
        ? `${doiSyncLabel}. Click to update ${record.key} again.`
        : `Update ${record.key} from DOI metadata`;
      doiButton.setAttribute(
        "aria-label",
        doiSyncLabel
          ? `${record.key} was synchronized from DOI metadata; update it again`
          : `Update BibTeX entry ${record.key} from DOI metadata`
      );
      doiButton.disabled = doiOperationInProgress;
      doiButton.addEventListener("mousedown", stopActionPointer);
      doiButton.addEventListener("click", (event) => {
        stopActionPointer(event);
        updateRecordFromDoi(record);
      });
      actions.appendChild(doiButton);
    }

    return actions;
  }

  function updateSuggestionListOverflow() {
    const list = popup.querySelector(".ctca-list");
    const resultCount = list.querySelectorAll('.ctca-item[role="option"], .ctca-doi-missing-card').length;
    list.classList.toggle("ctca-single-result", resultCount === 1);
  }

  function renderDoiNotFoundCard(doi) {
    const list = popup.querySelector(".ctca-list");
    const item = document.createElement("div");
    item.className = "ctca-item ctca-doi-missing-card";

    const heading = document.createElement("div");
    heading.className = "ctca-doi-missing-heading";
    const value = document.createElement("strong");
    value.className = "ctca-doi-missing-value";
    value.textContent = doi;
    heading.appendChild(value);

    const description = document.createElement("div");
    description.className = "ctca-doi-missing-description";
    description.textContent = "This DOI is not present in the parsed bibliography.";

    const addButton = document.createElement("button");
    addButton.type = "button";
    addButton.className = "ctca-action ctca-add-doi-button";
    addButton.textContent = "+";
    addButton.title = `Download metadata for ${doi} and add it to the bibliography`;
    addButton.setAttribute("aria-label", `Add DOI ${doi} to the bibliography`);
    addButton.disabled = doiOperationInProgress;
    addButton.addEventListener("mousedown", stopActionPointer);
    addButton.addEventListener("click", (event) => {
      stopActionPointer(event);
      addDoiEntry(doi);
    });

    item.append(heading, description, addButton);
    list.appendChild(item);
  }

  function renderSuggestions() {
    const filter = popup.querySelector(".ctca-filter");
    const list = popup.querySelector(".ctca-list");
    const query = currentContext?.fragment || "";
    filter.textContent = query || "Type a citation key, author, keyword, abstract text, or DOI…";
    applySettingsToPopup();

    renderedRecords = matchingRecords(query);
    if (selectedIndex >= renderedRecords.length) {
      selectedIndex = renderedRecords.length ? renderedRecords.length - 1 : -1;
    }
    list.replaceChildren();
    list.classList.remove("ctca-single-result");
    const openAlexDescriptors = [];

    const doi = isDoiQuery(query) ? normalizeDoiInput(query) : "";
    const doiIsMissing = Boolean(doi) && !findRecordByDoi(doi);

    if (!pendingSuggestionRecords().length && !doiIsMissing) {
      const empty = document.createElement("div");
      empty.className = "ctca-empty";
      empty.textContent = "No bibliography has been parsed yet. Open Config and select “Update bibliography”.";
      list.appendChild(empty);
      updateSuggestionListOverflow();
      return;
    }

    if (doiIsMissing) {
      renderDoiNotFoundCard(doi);
    }

    if (!renderedRecords.length) {
      if (doiIsMissing) {
        updateSuggestionListOverflow();
        return;
      }

      const empty = document.createElement("div");
      empty.className = "ctca-empty";
      empty.textContent = settings.caseSensitive
        ? "No enabled search field matches the current text with case-sensitive matching."
        : "No enabled search field matches the current text.";
      list.appendChild(empty);
      updateSuggestionListOverflow();
      return;
    }

    renderedRecords.forEach((record, index) => {
      const item = document.createElement("div");
      item.className = `ctca-item${index === selectedIndex ? " ctca-selected" : ""}`;
      item.setAttribute("role", "option");
      item.setAttribute("aria-selected", index === selectedIndex ? "true" : "false");
      item.title = record.sourceFile ? `Source: ${record.sourceFile}` : "";

      const heading = document.createElement("div");
      heading.className = "ctca-item-heading";

      const title = document.createElement("div");
      title.className = "ctca-title";
      title.textContent = record.title || record.key;

      const key = document.createElement("div");
      key.className = "ctca-key";
      key.textContent = record.key;
      key.title = record.key;

      const openAlexLookupKey = `suggestion:${index}:${record.key}`;
      const openAlexDescriptor = globalThis.SmartCitationsOpenAlex.descriptor(record, openAlexLookupKey);
      if (openAlexDescriptor.identity) openAlexDescriptors.push(openAlexDescriptor);
      const metadata = createMetadataElement(record, openAlexLookupKey);
      const authors = document.createElement("div");
      authors.className = "ctca-authors";
      authors.textContent = formatAuthors(record.authors);

      if (settings.appearance.mode === "compact") {
        heading.append(authors, key);
        item.appendChild(heading);
        if (settings.appearance.showTitleInCompact) {
          item.appendChild(title);
        }
        item.appendChild(metadata);
      } else {
        heading.append(title, key);
        item.append(heading, metadata, authors);
      }

      const actions = createRecordActions(record);
      if (actions) item.appendChild(actions);

      item.addEventListener("mouseenter", () => {
        selectedIndex = index;
        updateSelectedItem();
      });
      item.addEventListener("mousedown", (event) => {
        if (event.target.closest(".ctca-action")) return;
        event.preventDefault();
      });
      item.addEventListener("click", (event) => {
        if (event.target.closest(".ctca-action")) return;
        event.preventDefault();
        event.stopPropagation();
        insertRecord(record, true);
      });

      list.appendChild(item);
    });
    globalThis.SmartCitationsOpenAlex.hydrateCitations(list, openAlexDescriptors).catch(() => {});
    updateSuggestionListOverflow();
  }

  function updateSelectedItem() {
    const items = popup.querySelectorAll('.ctca-item[role="option"]');
    items.forEach((item, index) => {
      const selected = index === selectedIndex;
      item.classList.toggle("ctca-selected", selected);
      item.setAttribute("aria-selected", selected ? "true" : "false");
    });
    items[selectedIndex]?.scrollIntoView({ block: "nearest" });
  }

  async function insertRecord(record, dismissImmediately = false) {
    if (!currentContext || !record) return;

    if (dismissImmediately) {
      hidePopup();
    }

    try {
      // Resolve and replace the citation token atomically inside the live ACE
      // session. The popup context can lag one animation frame behind cursor
      // movement or typing; using its stored end position could therefore replace
      // only the text left of the cursor and leave a suffix such as a year behind.
      const response = await bridgeRequest("replaceCitationToken", {
        text: record.key
      });

      dismissedSelection = {
        fragmentStart: response.token.start,
        key: record.key,
        settled: false,
        deadline: Date.now() + 2000
      };
      hidePopup();
    } catch (error) {
      dismissedSelection = null;
      showPopup();
      setStatus(error.message, true);
    }
  }

  function showPopup() {
    popup.classList.add("ctca-visible");
  }

  function hidePopup() {
    cancelScheduledPopup();
    closeMenus();
    popup.classList.remove("ctca-visible");
    popupContextId = "";
    clearStatus();
  }

  function positionPopup() {
    const anchor = anchorScreen || currentState?.screen;
    const cursor = currentState?.screen || anchor;
    if (!anchor || !cursor) return;

    const margin = 8;
    const viewportWidth = Math.max(1, window.innerWidth);
    const viewportHeight = Math.max(1, window.innerHeight);
    const availableViewportWidth = Math.max(1, viewportWidth - 2 * margin);
    const availableViewportHeight = Math.max(1, viewportHeight - 2 * margin);
    const baseWidth = Math.min(680, availableViewportWidth);

    const cursorLeft = cursor.pageX - window.scrollX;
    const cursorTop = cursor.pageY - window.scrollY;
    const cursorLineHeight = Math.max(12, Number(cursor.lineHeight) || 16);
    const verticalGap = Math.max(20, Math.round(cursorLineHeight * 2));
    const horizontalGap = Math.max(10, Math.round(cursorLineHeight * 0.75));
    const cursorRight = cursorLeft + 2;
    const cursorBottom = cursorTop + cursorLineHeight;
    const anchorLeft = anchor.pageX - window.scrollX;

    // Measure the natural popup height at its normal width before imposing a
    // viewport-dependent maximum. This allows the placement logic to decide
    // whether the complete popup fits above or below the caret.
    popup.style.width = `${Math.round(baseWidth)}px`;
    popup.style.maxWidth = `${Math.round(baseWidth)}px`;
    popup.style.maxHeight = "none";

    const unconstrainedRect = popup.getBoundingClientRect();
    const preferredHeight = Math.min(
      620,
      availableViewportHeight,
      Math.max(120, popup.scrollHeight || unconstrainedRect.height || 120)
    );

    const spaceAbove = Math.max(0, cursorTop - verticalGap - margin);
    const spaceBelow = Math.max(0, viewportHeight - margin - cursorBottom - verticalGap);
    const largerVerticalSpace = Math.max(spaceAbove, spaceBelow);
    const preferredVerticalPlacement = spaceAbove > spaceBelow ? "above" : "below";

    const rightSpace = Math.max(0, viewportWidth - margin - cursorRight - horizontalGap);
    const leftSpace = Math.max(0, cursorLeft - horizontalGap - margin);
    const minimumSideWidth = Math.min(baseWidth, 360);
    const minimumComfortableHeight = Math.min(preferredHeight, 260);

    let placement = preferredVerticalPlacement;
    let targetWidth = baseWidth;
    let targetMaxHeight = Math.min(preferredHeight, largerVerticalSpace);

    // If neither vertical side can show a useful portion of the result list,
    // move the popup beside the caret instead. Right is preferred as requested;
    // left is only a fallback for very narrow right-hand editor panes.
    if (largerVerticalSpace < minimumComfortableHeight) {
      if (rightSpace >= minimumSideWidth) {
        placement = "right";
        targetWidth = Math.min(baseWidth, rightSpace);
        targetMaxHeight = Math.min(preferredHeight, availableViewportHeight);
      } else if (leftSpace >= minimumSideWidth) {
        placement = "left";
        targetWidth = Math.min(baseWidth, leftSpace);
        targetMaxHeight = Math.min(preferredHeight, availableViewportHeight);
      }
    }

    // When side placement is impossible, cap the popup to the available space
    // above or below. The scrollable result list then exposes fewer entries
    // without ever covering the caret line.
    if (placement === "above") {
      targetMaxHeight = Math.min(preferredHeight, spaceAbove);
    } else if (placement === "below") {
      targetMaxHeight = Math.min(preferredHeight, spaceBelow);
    }

    targetWidth = Math.max(1, Math.min(targetWidth, availableViewportWidth));
    targetMaxHeight = Math.max(1, Math.min(targetMaxHeight, availableViewportHeight));

    popup.style.width = `${Math.round(targetWidth)}px`;
    popup.style.maxWidth = `${Math.round(targetWidth)}px`;
    popup.style.maxHeight = `${Math.round(targetMaxHeight)}px`;
    popup.dataset.placement = placement;

    const finalRect = popup.getBoundingClientRect();
    const popupWidth = finalRect.width || targetWidth;
    const popupHeight = finalRect.height || targetMaxHeight;
    let left;
    let top;

    if (placement === "right") {
      left = cursorRight + horizontalGap;
      top = cursorTop + cursorLineHeight / 2 - popupHeight / 2;
    } else if (placement === "left") {
      left = cursorLeft - horizontalGap - popupWidth;
      top = cursorTop + cursorLineHeight / 2 - popupHeight / 2;
    } else {
      left = anchorLeft;
      top = placement === "above"
        ? cursorTop - verticalGap - popupHeight
        : cursorBottom + verticalGap;
    }

    left = Math.max(margin, Math.min(left, viewportWidth - popupWidth - margin));
    top = Math.max(margin, Math.min(top, viewportHeight - popupHeight - margin));

    popup.style.left = `${Math.round(left)}px`;
    popup.style.top = `${Math.round(top)}px`;
  }

  function setStatus(message, isError = false) {
    const status = popup.querySelector(".ctca-status");
    status.textContent = message;
    status.classList.add("ctca-show");
    status.classList.toggle("ctca-error", isError);
  }

  function clearStatus() {
    const status = popup.querySelector(".ctca-status");
    status.textContent = "";
    status.classList.remove("ctca-show", "ctca-error");
  }

  function setRefreshBusy(busy) {
    refreshInProgress = busy;
    const popupButton = popup.querySelector(".ctca-update");
    const bulkDoiButton = popup.querySelector(".ctca-update-all-doi");
    popupButton.disabled = busy || doiOperationInProgress;
    popupButton.textContent = busy ? "Updating…" : "↻ Update bibliography";
    if (bulkDoiButton) {
      bulkDoiButton.disabled = busy || doiOperationInProgress;
    }
    toolbarButton.disabled = busy || doiOperationInProgress || jumpInProgress;
    toolbarButton.textContent = busy
      ? "Updating…"
      : doiOperationInProgress
        ? "DOI…"
        : jumpInProgress
          ? "Opening…"
          : "bib";
    renderSuggestions();
  }

  function findBibliographyFiles(tex, cursorIndex = 0) {
    const found = [];

    const add = (name, position) => {
      let normalized = name.trim().replace(/^['"]|['"]$/g, "");
      if (!normalized) return;
      if (!/\.bib$/i.test(normalized)) normalized += ".bib";
      found.push({ name: normalized, position });
    };

    const bibliographyPattern = /\\bibliography\s*\{([^{}]+)\}/gi;
    let match;
    while ((match = bibliographyPattern.exec(tex)) !== null) {
      match[1].split(",").forEach((name) => add(name, match.index));
    }

    const biblatexPattern = /\\(?:addbibresource|addglobalbib|addsectionbib)\s*(?:\[[^\]]*\]\s*)?\{([^{}]+)\}/gi;
    while ((match = biblatexPattern.exec(tex)) !== null) {
      add(match[1], match.index);
    }

    const unique = new Map();
    found
      .sort((left, right) => {
        const leftAfter = left.position >= cursorIndex ? 0 : 1;
        const rightAfter = right.position >= cursorIndex ? 0 : 1;
        return leftAfter - rightAfter || left.position - right.position;
      })
      .forEach((entry) => {
        const base = entry.name.split("/").pop().toLowerCase();
        if (!unique.has(base)) unique.set(base, entry.name);
      });

    return [...unique.values()];
  }

  function visibleBibFileNames() {
    const names = new Set();
    document.querySelectorAll('.file-tree-list [role="treeitem"][aria-label$=".bib" i]').forEach((item) => {
      const name = item.getAttribute("aria-label")?.trim();
      if (name) names.add(name);
    });
    document.querySelectorAll(".file-tree-list .item-name-button span").forEach((span) => {
      const name = span.textContent?.trim();
      if (/\.bib$/i.test(name)) names.add(name);
    });
    return [...names];
  }

  function getSelectedFileName() {
    const selected = document.querySelector(
      '.file-tree-list [role="treeitem"][aria-selected="true"], ' +
      '.file-tree-list li.selected[role="treeitem"]'
    );
    const selectedName = (
      selected?.getAttribute("aria-label") ||
      selected?.querySelector(".item-name-button span")?.textContent ||
      selected?.querySelector(".item-name span")?.textContent ||
      selected?.querySelector(".entity-name span")?.textContent ||
      ""
    ).trim();
    if (selectedName) return selectedName;
    if (IS_OVERLEAF) {
      const breadcrumbName = document.querySelector(".ol-cm-breadcrumbs > div")?.textContent?.trim() || "";
      if (/\.[A-Za-z0-9]+$/i.test(breadcrumbName)) return breadcrumbName;
    }
    return "";
  }

  function captureSelectedTexFile(...fallbacks) {
    const selectedFile = getSelectedFileName();
    const editorFile = String(currentState?.fileName || "");
    const candidates = [
      editorFile && (!selectedFile || bibSourceMatches(editorFile, selectedFile)) ? editorFile : "",
      selectedFile,
      ...fallbacks,
      managerReturnTexFile,
      managerOriginalFile
    ];
    return String(candidates.find((fileName) => /\.tex$/i.test(String(fileName || "").trim())) || "");
  }

  function findFileButton(fileName) {
    const targetName = String(fileName || "").replace(/\\/g, "/").replace(/^\/+/, "").toLowerCase();
    const targetBase = targetName.split("/").pop();
    const items = document.querySelectorAll('.file-tree-list [role="treeitem"]');
    let baseNameMatch = null;

    for (const item of items) {
      const label = (
        item.getAttribute("aria-label") ||
        item.querySelector(".item-name-button span")?.textContent ||
        ""
      ).trim();
      const itemName = projectFileTreeItemName(item).replace(/\\/g, "/").replace(/^\/+/, "").toLowerCase();
      const control = (
        item.querySelector(".item-name-button") ||
        item.querySelector(".file-tree-entity-details") ||
        item.querySelector(".entity-name") ||
        item
      );
      if (itemName === targetName || label.toLowerCase() === targetName) return control;
      const itemBase = itemName.split("/").pop();
      if (!baseNameMatch && (itemBase === targetBase || label.toLowerCase() === targetBase)) {
        baseNameMatch = control;
      }
    }

    return baseNameMatch;
  }

  async function expandFoldersUntilFound(fileName) {
    let button = findFileButton(fileName);
    if (button) return button;

    for (let pass = 0; pass < 3; pass += 1) {
      const collapsed = [
        ...document.querySelectorAll(
          '.file-tree-list [role="treeitem"][aria-expanded="false"] button[aria-label="Expand"]'
        )
      ];
      if (!collapsed.length) break;

      for (const expandButton of collapsed) {
        expandButton.click();
      }
      await delay(150);

      button = findFileButton(fileName);
      if (button) return button;
    }

    return null;
  }

  function delay(milliseconds) {
    return new Promise((resolve) => window.setTimeout(resolve, milliseconds));
  }

  function isElementVisible(element) {
    if (!element || element.classList.contains("ng-hide")) {
      return false;
    }

    const style = window.getComputedStyle(element);
    return (
      style.display !== "none" &&
      style.visibility !== "hidden" &&
      element.getClientRects().length > 0
    );
  }

  function isSourceEditorLoading() {
    if (IS_OVERLEAF) {
      const editorHost = document.querySelector(
        "#ide-redesign-panel-source-editor .cm-editor, .ide-redesign-editor-container .cm-editor, .cm-editor"
      );
      const content = editorHost?.querySelector(".cm-content");
      const visibleLoadingPanel = [...document.querySelectorAll(
        ".ide-redesign-editor-container [class*='loading'], .ide-redesign-editor-panel [class*='loading']"
      )].some((element) => isElementVisible(element) && /loading/i.test(element.textContent || element.getAttribute("aria-label") || ""));
      return visibleLoadingPanel || !editorHost || !content || !isElementVisible(editorHost);
    }

    const loadingPanels = document.querySelectorAll(
      ".editor-container .loading-panel, .vertical-resizable-top .loading-panel"
    );
    const visibleLoadingPanel = [...loadingPanels].some(isElementVisible);
    const editorHost = document.querySelector("#editor");
    const editorUnavailable = !editorHost || !isElementVisible(editorHost);
    return visibleLoadingPanel || editorUnavailable;
  }

  function contentFingerprint(value) {
    const text = String(value ?? "");
    const edgeLength = 512;
    return `${text.length}:${text.slice(0, edgeLength)}:${text.slice(-edgeLength)}`;
  }

  async function waitForFile(fileName, transition = {}) {
    const targetName = fileName.toLowerCase();
    const targetBase = fileName.split("/").pop().toLowerCase();
    const deadline = Date.now() + FILE_OPEN_TIMEOUT_MS;
    const previousSessionToken = String(transition.previousSessionToken || "");
    const previousDocumentToken = String(transition.previousDocumentToken || "");
    const previousFingerprint = String(transition.previousFingerprint || "");
    const requireTransition = Boolean(transition.requireTransition);
    let lastFingerprint = null;
    let stableSince = 0;
    let sawSelectedFile = false;
    let sawLoadingState = false;
    let sawAceTransition = !requireTransition;

    while (Date.now() < deadline) {
      const selected = getSelectedFileName().toLowerCase();
      const selectedTarget = selected === targetName || selected === targetBase;

      if (selectedTarget) {
        sawSelectedFile = true;
      }

      const loading = isSourceEditorLoading();
      if (selectedTarget && loading) {
        sawLoadingState = true;
        lastFingerprint = null;
        stableSince = 0;
      }

      if (selectedTarget && !loading) {
        try {
          const response = await bridgeRequest("getState", {}, 1500);
          const state = response.state;

          if (state?.value !== undefined) {
            const aceFileName = String(state.fileName || "").toLowerCase();
            const aceFileBase = aceFileName.split("/").pop();
            const aceTarget = aceFileName === targetName || aceFileBase === targetBase;
            const fingerprint = contentFingerprint(state.value);
            const sessionChanged = previousSessionToken && state.sessionToken
              ? String(state.sessionToken) !== previousSessionToken
              : false;
            const documentChanged = previousDocumentToken && state.documentToken
              ? String(state.documentToken) !== previousDocumentToken
              : false;
            const contentChanged = previousFingerprint
              ? fingerprint !== previousFingerprint
              : false;

            // The React file tree marks a file as selected before ColLabTeX has
            // necessarily replaced the ACE session. The selected filename alone
            // is therefore insufficient. Require an actual ACE session/document
            // transition (or at least different document content) when opening a
            // different file.
            if (!aceTarget || (requireTransition && !sawAceTransition)) {
              if (aceTarget && (sessionChanged || documentChanged || contentChanged)) {
                sawAceTransition = true;
              } else {
                lastFingerprint = null;
                stableSince = 0;
                await delay(FILE_POLL_INTERVAL_MS);
                continue;
              }
            }

            if (fingerprint !== lastFingerprint) {
              lastFingerprint = fingerprint;
              stableSince = Date.now();
            } else if (Date.now() - stableSince >= FILE_CONTENT_STABLE_MS) {
              return state;
            }
          }
        } catch (_error) {
          // The ACE editor may still be replacing its session after the loading overlay disappears.
        }
      }

      await delay(FILE_POLL_INTERVAL_MS);
    }

    if (!sawSelectedFile) {
      throw new Error(`ColLabTeX did not select ${fileName} before the timeout`);
    }

    if (sawLoadingState || isSourceEditorLoading()) {
      throw new Error(`Timed out while waiting for ${fileName} to finish loading`);
    }

    throw new Error(`Timed out while waiting for stable content from ${fileName}`);
  }

  async function openFileAndWait(fileName) {
    const button = await expandFoldersUntilFound(fileName);
    if (!button) {
      throw new Error(`Could not find ${fileName} in the ColLabTeX file tree`);
    }

    let beforeState = null;
    try {
      beforeState = (await bridgeRequest("getState", {}, 1500)).state || null;
    } catch (_error) {
      // The normal loading wait below remains authoritative.
    }
    const selectedBefore = getSelectedFileName();
    const requireTransition = !bibSourceMatches(selectedBefore, fileName);

    button.click();
    return waitForFile(fileName, {
      requireTransition,
      previousSessionToken: beforeState?.sessionToken || "",
      previousDocumentToken: beforeState?.documentToken || "",
      previousFingerprint: beforeState?.value !== undefined
        ? contentFingerprint(beforeState.value)
        : ""
    });
  }

  async function openAndReadFile(fileName) {
    const state = await openFileAndWait(fileName);
    return state.value;
  }

  function findBibEntryKeyIndex(text, citationKey) {
    const source = String(text ?? "");
    const escapedKey = escapeRegExp(String(citationKey ?? ""));
    if (!escapedKey) return -1;

    // Match an entry start independently of preceding malformed BibTeX content.
    // The key itself is captured so the cursor can be placed on the citation key,
    // rather than merely at the beginning of the complete entry.
    const pattern = new RegExp(
      `^[\t ]*@[A-Za-z]+\\s*[({]\\s*(${escapedKey})(?=\\s*,)`,
      "m"
    );
    const match = pattern.exec(source);
    if (!match) return -1;

    return match.index + match[0].lastIndexOf(match[1]);
  }

  async function fetchDoiMetadata(doi, requestId = "") {
    const response = await extensionApi.runtime.sendMessage({
      type: "ctca-fetch-doi-metadata",
      doi: normalizeDoiInput(doi),
      requestId
    });
    if (!response?.ok || !response.metadata) {
      throw new Error(response?.error || `No metadata could be retrieved for ${doi}`);
    }
    return response.metadata;
  }

  function escapeBibText(value) {
    const backslashPlaceholder = "\uE000";
    return String(value ?? "")
      .replace(/\\/g, backslashPlaceholder)
      .replace(/([%&#_$])/g, "\\$1")
      .replace(/\{/g, "\\{")
      .replace(/\}/g, "\\}")
      .replace(new RegExp(backslashPlaceholder, "g"), "\\textbackslash{}")
      .replace(/\s+/g, " ")
      .trim();
  }

  function bibValue(value) {
    const escaped = escapeBibText(value);
    return escaped ? `{${escaped}}` : "";
  }

  function formatMetadataAuthorForBib(author) {
    const family = escapeBibText(author?.family || "");
    const given = escapeBibText(author?.given || "");
    const name = escapeBibText(author?.name || "");
    if (family && given) return `${family}, ${given}`;
    if (family) return family;
    if (name) return `{${name}}`;
    return given;
  }

  function metadataToBibFields(metadata, existingRecord = null) {
    const fields = { ...(existingRecord?.fields || {}) };
    const entryType = existingRecord?.type || metadata.entryType || "misc";
    const set = (name, value) => {
      const wrapped = bibValue(value);
      if (wrapped) fields[name] = wrapped;
    };

    set("title", metadata.title);
    set("year", metadata.year);

    const journalField =
      entryType === "inproceedings" || entryType === "incollection"
        ? "booktitle"
        : "journal";
    set(journalField, metadata.journal);

    const authorText = (metadata.authors || [])
      .map(formatMetadataAuthorForBib)
      .filter(Boolean)
      .join(" and ");
    if (authorText) fields.author = `{${authorText}}`;

    set("volume", metadata.volume);
    set("number", metadata.number);
    set("pages", String(metadata.pages || "").replace(/(\d)-(\d)/g, "$1--$2"));
    set("publisher", metadata.publisher);
    set("doi", normalizeDoiInput(metadata.doi));
    set("url", metadata.url || (metadata.doi ? `https://doi.org/${metadata.doi}` : ""));
    set("abstract", normalizeAbstractText(metadata.abstract));
    set("keywords", metadata.keywords);

    return fields;
  }

  function serializeBibEntry(type, key, fields) {
    const preferredOrder = [
      "title",
      "year",
      "journal",
      "booktitle",
      "author",
      "editor",
      "volume",
      "number",
      "pages",
      "publisher",
      "institution",
      "url",
      "doi",
      "abstract",
      "keywords"
    ];
    const orderedNames = [
      ...preferredOrder.filter((name) => fields[name]),
      ...Object.keys(fields).filter(
        (name) => !preferredOrder.includes(name) && fields[name]
      )
    ];
    const lines = orderedNames.map(
      (name) => `    ${name} = ${String(fields[name]).trim()}`
    );
    return `@${type || "misc"}{${key},\n${lines.join(",\n")}\n}`;
  }

  function buildBibEntry(key, metadata, existingRecord = null) {
    const type = existingRecord?.type || metadata.entryType || "misc";
    const fields = metadataToBibFields(metadata, existingRecord);
    return serializeBibEntry(type, key, fields);
  }

  function findBibEntryRange(text, citationKey) {
    const source = String(text ?? "");
    const escapedKey = escapeRegExp(String(citationKey ?? ""));
    if (!escapedKey) return null;

    const pattern = new RegExp(
      `^[\\t ]*@([A-Za-z]+)\\s*([({])\\s*${escapedKey}(?=\\s*,)`,
      "m"
    );
    const match = pattern.exec(source);
    if (!match) return null;

    const start = match.index + match[0].search(/@/);
    const openChar = match[2];
    const closeChar = openChar === "{" ? "}" : ")";
    const openIndex = source.indexOf(openChar, start);
    let depth = 0;
    let quoted = false;
    let escaped = false;

    for (let index = openIndex; index < source.length; index += 1) {
      const char = source[index];
      if (escaped) {
        escaped = false;
        continue;
      }
      if (char === "\\") {
        escaped = true;
        continue;
      }
      if (char === '"' && depth <= 1) {
        quoted = !quoted;
        continue;
      }
      if (quoted) continue;
      if (char === openChar) depth += 1;
      if (char === closeChar) {
        depth -= 1;
        if (depth === 0) {
          return { start, end: index + 1, type: match[1].toLowerCase() };
        }
      }
    }

    const nextEntry = source.slice(openIndex + 1).search(/^[\t ]*@[A-Za-z]+\s*[({]/m);
    return {
      start,
      end: nextEntry >= 0 ? openIndex + 1 + nextEntry : source.length,
      type: match[1].toLowerCase()
    };
  }

  function replaceRecordInMemory(updatedRecord) {
    const index = records.findIndex(
      (record) =>
        record.key === updatedRecord.key &&
        (record.sourceFile || "") === (updatedRecord.sourceFile || "")
    );
    if (index >= 0) {
      records[index] = updatedRecord;
    } else {
      records.push(updatedRecord);
    }
  }

  function chooseTargetBibFile() {
    const selected = getSelectedFileName();
    if (/\.bib$/i.test(selected)) return selected;

    const detected = currentState?.value
      ? findBibliographyFiles(currentState.value, currentState.cursorIndex)
      : [];
    return detected[0] || cachedFiles[0] || visibleBibFileNames()[0] || "";
  }

  function citationKeyStem(metadata) {
    const firstAuthor = metadata.authors?.[0] || {};
    const rawFamily = firstAuthor.family || firstAuthor.name?.split(/\s+/).pop() || "Reference";
    let family = String(rawFamily)
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[^A-Za-z0-9]+/g, "");
    if (!family) family = "Reference";
    if (/^\d/.test(family)) family = `Reference${family}`;
    family = family.charAt(0).toUpperCase() + family.slice(1);
    const year = String(metadata.year || "").match(/\d{4}/)?.[0] || "NoYear";
    return `${family}${year}`;
  }

  function alphabeticSuffix(index) {
    let value = index;
    let suffix = "";
    do {
      suffix = String.fromCharCode(97 + (value % 26)) + suffix;
      value = Math.floor(value / 26) - 1;
    } while (value >= 0);
    return suffix;
  }

  function generateCitationKey(metadata, additionalKeys = []) {
    const base = citationKeyStem(metadata);
    const existing = new Set([
      ...pendingSuggestionRecords().map((record) => record.key.toLowerCase()),
      ...additionalKeys.map((key) => String(key).toLowerCase())
    ]);
    if (!existing.has(base.toLowerCase())) return base;

    for (let index = 0; index < 702; index += 1) {
      const candidate = `${base}${alphabeticSuffix(index)}`;
      if (!existing.has(candidate.toLowerCase())) return candidate;
    }
    return `${base}${Date.now()}`;
  }

  function setDoiOperationBusy(busy, label = "DOI…") {
    doiOperationInProgress = busy;
    toolbarButton.disabled = busy || refreshInProgress || jumpInProgress;
    toolbarButton.textContent = busy
      ? label
      : refreshInProgress
        ? "Updating…"
        : jumpInProgress
          ? "Opening…"
          : "bib";
    const updateButton = popup.querySelector(".ctca-update");
    const bulkDoiButton = popup.querySelector(".ctca-update-all-doi");
    updateButton.disabled = busy || refreshInProgress;
    if (bulkDoiButton) {
      bulkDoiButton.disabled = busy || refreshInProgress;
    }
    renderSuggestions();
  }

  async function updateRecordFromDoi(record) {
    if (
      doiOperationInProgress ||
      refreshInProgress ||
      jumpInProgress ||
      !record?.doi ||
      !record?.sourceFile
    ) {
      return;
    }

    const originalFile = getSelectedFileName() || currentState?.fileName || "";
    setDoiOperationBusy(true, "Updating DOI…");
    closeMenus();
    showPopup();
    setStatus(`Retrieving DOI metadata for ${record.doi}…`);

    try {
      const metadata = await fetchDoiMetadata(record.doi);
      setStatus(`Updating ${record.key} in ${record.sourceFile} from ${metadata.source}…`);
      const state = await openFileAndWait(record.sourceFile);
      const range = findBibEntryRange(state.value, record.key);
      if (!range) {
        throw new Error(`Could not locate ${record.key} in ${record.sourceFile}`);
      }

      const existingText = state.value.slice(range.start, range.end);
      const existingRecord =
        window.CollabTeXBibTeX.parseBibTeX(existingText, record.sourceFile)[0] || record;
      const replacement = buildBibEntry(record.key, metadata, existingRecord);
      const expectedValue =
        state.value.slice(0, range.start) +
        replacement +
        state.value.slice(range.end);
      await replaceEditorRangeAndVerify({
        fileName: record.sourceFile,
        start: range.start,
        end: range.end,
        text: replacement,
        expectedValue,
        timeoutMs: 10000
      });

      const updatedRecord =
        window.CollabTeXBibTeX.parseBibTeX(replacement, record.sourceFile)[0];
      if (!updatedRecord) {
        throw new Error(`The updated BibTeX entry ${record.key} could not be parsed`);
      }
      replaceRecordInMemory(updatedRecord);
      managerMarkDoiSynced(updatedRecord);
      await saveCachedState(cachedFiles);
      await delay(200);
      await restoreFile(originalFile);

      setDoiOperationBusy(false);
      try {
        currentState = (await bridgeRequest("getState", {}, 2500)).state;
        currentContext = findCitationContext(currentState);
      } catch (_error) {
        // ACE state events will restore the citation context.
      }
      renderSuggestions();
      showPopup();
      positionPopup();
      if (currentContext) updatePopupAnchor(currentContext);
      setStatus(
        `Updated ${record.key} from ${metadata.source}${metadata.abstract ? ", including the abstract" : ""}.`
      );
      showDoiSuccessToast(record.key, metadata.source);
    } catch (error) {
      await restoreFile(originalFile);
      setDoiOperationBusy(false);
      showPopup();
      renderSuggestions();
      positionPopup();
      setStatus(error.message || String(error), true);
    }
  }

  async function updateAllRecordsFromDoi() {
    if (doiOperationInProgress || refreshInProgress || jumpInProgress) return;

    const allTargets = [];
    const seen = new Set();
    for (const record of records) {
      if (!record?.doi || !record?.sourceFile) continue;
      const identity = `${record.sourceFile}\u0000${record.key}`;
      if (seen.has(identity)) continue;
      seen.add(identity);
      allTargets.push(record);
    }

    if (!allTargets.length) {
      closeMenus();
      showPopup();
      setStatus("No parsed bibliography entries with a DOI are available.", true);
      positionPopup();
      return;
    }

    const previouslySynchronized = allTargets.filter((record) => managerWasDoiSynced(record));
    const decision = await showBatchDoiConfirmation(allTargets.length, previouslySynchronized.length);
    if (!decision) return;
    const includePreviouslySynchronized = Boolean(decision.includePreviouslySynchronized);
    const targets = includePreviouslySynchronized
      ? allTargets
      : allTargets.filter((record) => !managerWasDoiSynced(record));
    const skippedSynchronized = allTargets.length - targets.length;

    if (!targets.length) {
      closeMenus();
      showPopup();
      setStatus(`All ${allTargets.length} DOI entries have already been synchronized; no update was started.`);
      positionPopup();
      return;
    }

    const originalFile = getSelectedFileName() || currentState?.fileName || "";
    const grouped = new Map();
    for (const record of targets) {
      if (!grouped.has(record.sourceFile)) grouped.set(record.sourceFile, []);
      grouped.get(record.sourceFile).push(record);
    }

    let processed = 0;
    let updated = 0;
    let skipped = 0;
    const failures = [];
    const synchronizedDois = new Set();

    setDoiOperationBusy(true, "Updating all DOI…");
    closeMenus();
    showPopup();
    positionPopup();

    try {
      for (const [sourceFile, fileTargets] of grouped) {
        setStatus(`Opening ${sourceFile}…`);
        const state = await openFileAndWait(sourceFile);
        let workingText = state.value;
        const currentFileRecords = window.CollabTeXBibTeX.parseBibTeX(
          workingText,
          sourceFile
        );
        const currentByKey = new Map(
          currentFileRecords.map((record) => [record.key, record])
        );
        const replacements = [];

        for (const target of fileTargets) {
          processed += 1;
          const currentRecord = currentByKey.get(target.key) || target;
          const currentDoi = normalizeDoiInput(currentRecord.doi || target.doi);

          if (!currentDoi) {
            skipped += 1;
            continue;
          }

          setStatus(
            `Retrieving DOI metadata ${processed}/${targets.length}: ${target.key}…`
          );

          try {
            const metadata = await fetchDoiMetadata(currentDoi);
            const range = findBibEntryRange(workingText, target.key);
            if (!range) {
              throw new Error(`entry not found in ${sourceFile}`);
            }

            replacements.push({
              start: range.start,
              end: range.end,
              key: target.key,
              doi: currentDoi,
              text: buildBibEntry(target.key, metadata, currentRecord)
            });
          } catch (error) {
            failures.push(`${target.key}: ${error?.message || String(error)}`);
          }

          if (processed < targets.length) {
            await delay(DOI_BULK_DELAY_MS);
          }
        }

        // Apply changes from the end of the file towards the beginning. Earlier
        // ranges therefore remain valid even when a rewritten entry changes length.
        replacements.sort((left, right) => right.start - left.start);
        for (let index = 0; index < replacements.length; index += 1) {
          const replacement = replacements[index];
          setStatus(
            `Writing ${sourceFile}: ${index + 1}/${replacements.length} (${replacement.key})…`
          );
          try {
            const expectedValue =
              workingText.slice(0, replacement.start) +
              replacement.text +
              workingText.slice(replacement.end);
            await replaceEditorRangeAndVerify({
              fileName: sourceFile,
              start: replacement.start,
              end: replacement.end,
              text: replacement.text,
              expectedValue,
              timeoutMs: 15000
            });
            workingText = expectedValue;
            synchronizedDois.add(replacement.doi);
            updated += 1;
          } catch (error) {
            failures.push(
              `${replacement.key}: could not write entry (${error?.message || String(error)})`
            );
          }
        }

        if (replacements.length) {
          await delay(250);
          try {
            workingText = (await bridgeRequest("getState", {}, 3000)).state.value;
          } catch (_error) {
            // The locally updated text is already correct because replacements were
            // applied from high to low offsets.
          }
        }

        const reparsed = window.CollabTeXBibTeX.parseBibTeX(workingText, sourceFile);
        records = records.filter((record) => record.sourceFile !== sourceFile);
        records.push(...reparsed);
        await saveCachedState(cachedFiles);
      }

      for (const doi of synchronizedDois) {
        managerMarkDoiSynced(doi);
      }
      await saveCachedState(cachedFiles);
      await restoreFile(originalFile);
      setDoiOperationBusy(false);

      try {
        currentState = (await bridgeRequest("getState", {}, 2500)).state;
        currentContext = findCitationContext(currentState);
      } catch (_error) {
        // ACE state events will restore the current manuscript context.
      }

      renderSuggestions();
      showPopup();
      positionPopup();
      if (currentContext) updatePopupAnchor(currentContext);

      const summary = [
        `Updated ${updated} entr${updated === 1 ? "y" : "ies"} from DOI metadata.`
      ];
      if (skipped) summary.push(`Skipped ${skipped} without a usable DOI.`);
      if (skippedSynchronized) {
        summary.push(`Skipped ${skippedSynchronized} previously synchronized entr${skippedSynchronized === 1 ? "y" : "ies"}.`);
      }
      if (failures.length) {
        const examples = failures.slice(0, 3).join("; ");
        summary.push(
          `${failures.length} failed${examples ? `: ${examples}${failures.length > 3 ? "; …" : ""}` : "."}`
        );
      }
      setStatus(summary.join(" "), failures.length > 0 && updated === 0);
    } catch (error) {
      await restoreFile(originalFile);
      setDoiOperationBusy(false);
      showPopup();
      renderSuggestions();
      positionPopup();
      setStatus(error?.message || String(error), true);
    }
  }

  async function addDoiEntry(doi) {
    if (doiOperationInProgress || refreshInProgress || jumpInProgress) return;

    const normalizedDoi = normalizeDoiInput(doi);
    const insertionContext = currentContext ? { ...currentContext } : null;
    const originalFile = getSelectedFileName() || currentState?.fileName || "";
    const targetFile = chooseTargetBibFile();
    if (!targetFile) {
      setStatus("No target bibliography file is known. Update the bibliography first.", true);
      return;
    }

    setDoiOperationBusy(true, "Adding DOI…");
    closeMenus();
    showPopup();
    setStatus(`Retrieving metadata for ${normalizedDoi}…`);

    try {
      const metadata = await fetchDoiMetadata(normalizedDoi);
      const state = await openFileAndWait(targetFile);
      const targetRecords = window.CollabTeXBibTeX.parseBibTeX(state.value, targetFile);
      const key = generateCitationKey(
        metadata,
        targetRecords.map((record) => record.key)
      );
      setStatus(`Adding ${key} to ${targetFile}…`);
      const entry = buildBibEntry(key, metadata, null);
      const separator = state.value.length
        ? state.value.endsWith("\n\n")
          ? ""
          : state.value.endsWith("\n")
            ? "\n"
            : "\n\n"
        : "";
      const insertionText = `${separator}${entry}\n`;
      await bridgeRequest(
        "replaceRange",
        {
          start: state.value.length,
          end: state.value.length,
          text: insertionText
        },
        5000
      );

      const addedRecord = window.CollabTeXBibTeX.parseBibTeX(entry, targetFile)[0];
      if (!addedRecord) {
        throw new Error(`The generated BibTeX entry ${key} could not be parsed`);
      }
      replaceRecordInMemory(addedRecord);
      managerMarkDoiSynced(addedRecord);
      if (!cachedFiles.includes(targetFile)) cachedFiles.unshift(targetFile);
      await saveCachedState(cachedFiles);
      await delay(200);
      await restoreFile(originalFile);

      if (insertionContext) {
        const response = await bridgeRequest(
          "replaceCitationToken",
          { text: key },
          5000
        );
        dismissedSelection = {
          fragmentStart: response.token.start,
          key,
          settled: false,
          deadline: Date.now() + 2500
        };
      }

      setDoiOperationBusy(false);
      hidePopup();
      await askWhetherToPushDocumentChangesToGlobal({ reason: "adding an entry from DOI" });
    } catch (error) {
      await restoreFile(originalFile);
      setDoiOperationBusy(false);
      showPopup();
      renderSuggestions();
      positionPopup();
      setStatus(error.message || String(error), true);
    }
  }

  async function jumpToBibEntry(record) {
    if (refreshInProgress || jumpInProgress || doiOperationInProgress || !record?.sourceFile) {
      return;
    }

    const originalFile = getSelectedFileName() || currentState?.fileName || "";
    let targetFileOpened = false;
    let jumpFailed = false;

    jumpInProgress = true;
    cancelScheduledPopup();
    hidePopup();
    toolbarButton.disabled = true;
    toolbarButton.textContent = "Opening…";

    try {
      const state = await openFileAndWait(record.sourceFile);
      targetFileOpened = true;
      const keyIndex = findBibEntryKeyIndex(state.value, record.key);

      if (keyIndex < 0) {
        throw new Error(
          `Could not locate the BibTeX entry ${record.key} in ${record.sourceFile}`
        );
      }

      // The ACE session can still be completing its final render after the file
      // contents have stabilized. Retry cursor placement briefly, but never undo a
      // successful switch to the bibliography file merely because positioning fails.
      let positioned = false;
      let lastError = null;
      for (let attempt = 0; attempt < 4 && !positioned; attempt += 1) {
        try {
          await bridgeRequest(
            "gotoIndex",
            { index: keyIndex, align: "top" },
            3000
          );
          positioned = true;
        } catch (error) {
          lastError = error;
          await delay(150 * (attempt + 1));
        }
      }

      if (!positioned) {
        throw lastError || new Error(`Could not position the editor at ${record.key}`);
      }

      try {
        const response = await bridgeRequest("getState", {}, 2000);
        currentState = response.state;
      } catch (_error) {
        currentState = state;
      }
      currentContext = null;
      popupContextId = "";
      pendingContextId = "";
      hidePopup();
    } catch (error) {
      jumpFailed = true;

      // Restore the manuscript only when opening the target bibliography itself
      // failed. Once the .bib file has opened, stay there even if locating or
      // centering the entry failed; otherwise the user sees an immediate jump back.
      if (!targetFileOpened) {
        await restoreFile(originalFile);
        anchorScreen = currentState?.screen || anchorScreen;
        showPopup();
        positionPopup();
        setStatus(error.message || String(error), true);
      } else {
        console.warn("[Smart Citations] BibTeX jump positioning failed:", error);
      }
    } finally {
      jumpInProgress = false;
      toolbarButton.disabled = refreshInProgress;
      toolbarButton.textContent = refreshInProgress ? "Updating…" : "bib";

      if (!jumpFailed || targetFileOpened) {
        cancelScheduledPopup();
        currentContext = null;
        popupContextId = "";
        hidePopup();
      }
    }
  }

  async function waitForFileActivation(fileName, timeoutMs = 5000) {
    const deadline = Date.now() + Math.max(500, Number(timeoutMs) || 5000);
    while (Date.now() < deadline) {
      if (
        bibSourceMatches(getSelectedFileName(), fileName) &&
        !isSourceEditorLoading()
      ) {
        try {
          const state = (await bridgeRequest("getState", {}, 1000)).state;
          if (bibSourceMatches(state?.fileName, fileName)) {
            currentState = state;
            return true;
          }
        } catch (_error) {
          // The next short poll can observe the completed editor switch.
        }
      }
      await delay(50);
    }
    return false;
  }

  async function restoreFile(fileName, { waitForStable = true } = {}) {
    if (!fileName) return;
    const selectedFile = getSelectedFileName();
    if (
      bibSourceMatches(selectedFile, fileName) &&
      bibSourceMatches(currentState?.fileName, fileName) &&
      !isSourceEditorLoading()
    ) {
      return;
    }
    const button = await expandFoldersUntilFound(fileName);
    if (!button) return;
    button.click();
    try {
      if (waitForStable) {
        await waitForFile(fileName);
      } else if (!(await waitForFileActivation(fileName))) {
        await waitForFile(fileName);
      }
    } catch (_error) {
      // Restoration is best-effort; ColLabTeX may still complete the click.
    }
  }

  async function refreshBibliography() {
    if (refreshInProgress || jumpInProgress || doiOperationInProgress) return;

    setRefreshBusy(true);
    anchorScreen = currentState?.screen || anchorScreen;
    showPopup();
    positionPopup();
    setStatus("Detecting bibliography files…");

    const originalFile = getSelectedFileName() || currentState?.fileName || "";
    let files = [];

    try {
      const stateResponse = await bridgeRequest("getState", {}, 3000);
      const texState = stateResponse.state;
      currentState = texState;
      files = findBibliographyFiles(texState.value, texState.cursorIndex);

      if (!files.length) {
        files = visibleBibFileNames();
      }

      if (!files.length) {
        throw new Error(
          "No \\bibliography{…}, \\addbibresource{…}, or visible .bib file was found."
        );
      }

      const parsed = [];
      const failures = [];

      for (let index = 0; index < files.length; index += 1) {
        const fileName = files[index];
        setStatus(`Opening and parsing ${fileName} (${index + 1}/${files.length})…`);
        try {
          const bibText = await openAndReadFile(fileName);
          parsed.push(...window.CollabTeXBibTeX.parseBibTeX(bibText, fileName));
        } catch (error) {
          failures.push(`${fileName}: ${error.message}`);
        }
      }

      const unique = new Map();
      for (const record of parsed) {
        if (!unique.has(record.key)) {
          unique.set(record.key, record);
        }
      }
      records = [...unique.values()];

      await saveCachedState(files);

      if (!records.length) {
        throw new Error(
          failures.length
            ? `No BibTeX entries were parsed. ${failures.join("; ")}`
            : "The detected bibliography file(s) contain no parseable BibTeX entries."
        );
      }

      const failureSuffix = failures.length
        ? ` ${failures.length} file(s) could not be read.`
        : "";
      setStatus(
        `Loaded ${records.length} citation entries from ${files.length - failures.length} file(s).${failureSuffix}`
      );
      renderSuggestions();
      positionPopup();
    } catch (error) {
      setStatus(error.message || String(error), true);
    } finally {
      await restoreFile(originalFile);
      setRefreshBusy(false);
      try {
        const response = await bridgeRequest("getState", {}, 2000);
        currentState = response.state;
        updateFromEditorState();
      } catch (_error) {
        // State updates will resume automatically through the ACE event bridge.
      }
    }
  }

  const pendingWebPdfAutoContinueTabs = new Set();

  function scheduleWebPdfAutoContinue(tabId) {
    const normalizedTabId = Number(tabId);
    if (!Number.isInteger(normalizedTabId) || pendingWebPdfAutoContinueTabs.has(normalizedTabId)) return false;
    pendingWebPdfAutoContinueTabs.add(normalizedTabId);
    let attempts = 0;
    const tryContinue = () => {
      const button = [...document.querySelectorAll(".ctca-web-pdf-continue:not([hidden])")]
        .find((candidate) => Number(candidate.dataset.resumeTabId) === normalizedTabId);
      if (button && !button.disabled) {
        pendingWebPdfAutoContinueTabs.delete(normalizedTabId);
        button.click();
        return;
      }
      attempts += 1;
      if (attempts >= 150) {
        pendingWebPdfAutoContinueTabs.delete(normalizedTabId);
        return;
      }
      window.setTimeout(tryContinue, 100);
    };
    tryContinue();
    return true;
  }

  extensionApi.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === "ctca-auto-continue-web-pdf") {
      const scheduled = scheduleWebPdfAutoContinue(message.tabId);
      sendResponse({ ok: scheduled });
      return false;
    }
    if (message?.type !== "ctca-open-bib-manager") return undefined;
    openBibManager()
      .then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse({ ok: false, error: error?.message || String(error) }));
    return true;
  });

  function bibFileTreeSelection(event) {
    // Internal reads and writes use HTMLElement.click() to select a project
    // file. Those synthetic clicks must reach ColLabTeX; only a real user
    // activation should be redirected to the full-screen manager.
    if (!IS_COLLABTEX || !event.isTrusted || event.button !== 0) return null;
    const item = typeof event.target?.closest === "function"
      ? event.target.closest('.file-tree-list [role="treeitem"]')
      : null;
    if (!item) return null;

    const name = projectFileTreeItemName(item);
    if (!/\.bib$/i.test(name)) return null;

    const selectionControl = event.target.closest(
      ".item-name-button, .file-tree-entity-details, .entity-name, .item-name"
    );
    if (!selectionControl || !item.contains(selectionControl)) return null;
    return name;
  }

  // Keep the collaborative source document active when a bibliography is
  // selected in ColLabTeX's project tree. The manager may temporarily visit
  // the requested BibTeX file through the editor bridge in order to read or
  // safely write it, but it restores the source document before it is exposed
  // again.
  document.addEventListener(
    "click",
    (event) => {
      const bibFileName = bibFileTreeSelection(event);
      if (!bibFileName) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      openBibManager({ bibFileName }).catch((error) => {
        managerSetStatus(error?.message || String(error), true);
      });
    },
    true
  );

  extensionApi.storage.onChanged?.addListener((changes, areaName) => {
    if (areaName !== "local") return;
    if (AUTHOR_OPTIONS_KEY in changes) {
      managerAuthorshipUserName = String(changes[AUTHOR_OPTIONS_KEY]?.newValue?.userName || "").trim();
      if (bibManager?.classList.contains("ctca-manager-visible")) {
        renderManagerCategories();
        renderManagerList();
        renderManagerDetails();
      }
    }
    const projectKey = storageKey();
    if (projectKey in changes) {
      const value = changes[projectKey]?.newValue || {};
      const nextEnabled = value?.settings?.syncGlobalDatabase === true;
      const wasEnabled = settings.syncGlobalDatabase;
      settings.syncGlobalDatabase = nextEnabled;
      updateGlobalDatabaseSyncUi();
      if (!wasEnabled && nextEnabled) {
        registerCurrentDocumentWithGlobalDatabase()
          .then(() => checkCurrentDocumentGlobalFlag({ allowAutomaticSync: true }))
          .catch(() => {});
      }
      if (!nextEnabled) updateGlobalPendingUi(0, 0);
    }
    if (globalThis.CollabTeXAttachmentStore?.CONFIG_KEY in changes) {
      managerUpdateCloudIconState(changes[globalThis.CollabTeXAttachmentStore.CONFIG_KEY]?.newValue || null).catch(() => {});
    }
    if (
      globalThis.CollabTeXAttachmentStore?.INDEX_KEY in changes &&
      bibManager?.classList.contains("ctca-manager-visible")
    ) {
      const draft = managerDrafts.get(managerSelectedId);
      if (draft) managerRenderPdfAttachmentList(draft).catch(() => {});
    }
    if (projectNextcloudLinksKey() in changes) {
      const value = changes[projectNextcloudLinksKey()]?.newValue || {};
      projectNextcloudLinks = (Array.isArray(value.links) ? value.links : []).map(normalizeProjectNextcloudLink).filter(Boolean);
      scheduleProjectNextcloudUiRefresh();
    }
    // Global database changes are intentionally not inspected here. Each
    // document checks only its own pending flag on the 30-second cadence below.
  });

  document.addEventListener(
    "keydown",
    (event) => {
      const eventIsInsidePopup = popup.contains(event.target);
      const isArrowNavigation = [
        "ArrowLeft",
        "ArrowRight",
        "ArrowUp",
        "ArrowDown"
      ].includes(event.key);
      const isTypingInput =
        !event.ctrlKey &&
        !event.metaKey &&
        !event.altKey &&
        (event.key.length === 1 || event.key === "Backspace" || event.key === "Delete");

      if (bibManager.classList.contains("ctca-manager-visible")) {
        if (event.key === "Escape" && !event.target.closest("input, textarea, select")) {
          event.preventDefault();
          event.stopImmediatePropagation();
          closeBibManager(event);
        }
        return;
      }

      if (abstractOverlay.classList.contains("ctca-abstract-overlay-visible")) {
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopImmediatePropagation();
          closeAbstractOverlay(event);
        }
        return;
      }

      if (activeMenu && event.key === "Escape") {
        event.preventDefault();
        event.stopImmediatePropagation();
        closeMenus();
        bridgeRequest("focus").catch(() => {});
        return;
      }

      if (eventIsInsidePopup && event.target.closest(".ctca-menu, .ctca-menu-button")) {
        return;
      }

      if (!eventIsInsidePopup) {
        if (isArrowNavigation) {
          lastEditorInteraction = "navigation";
          lastEditorInteractionAt = performance.now();
        } else if (isTypingInput) {
          lastEditorInteraction = "typing";
          lastEditorInteractionAt = performance.now();

          if (currentContext) {
            popupKeyboardActive = true;
            selectedIndex = 0;
            if (popup.classList.contains("ctca-visible")) {
              renderSuggestions();
            }
          }
        }
      }

      if (
        !popup.classList.contains("ctca-visible") ||
        refreshInProgress ||
        jumpInProgress ||
        doiOperationInProgress ||
        !popupKeyboardActive
      ) {
        return;
      }

      if (event.key === "ArrowDown" && renderedRecords.length) {
        event.preventDefault();
        event.stopImmediatePropagation();
        selectedIndex = (selectedIndex + 1) % renderedRecords.length;
        updateSelectedItem();
        return;
      }

      if (event.key === "ArrowUp" && renderedRecords.length) {
        event.preventDefault();
        event.stopImmediatePropagation();
        selectedIndex = (selectedIndex - 1 + renderedRecords.length) % renderedRecords.length;
        updateSelectedItem();
        return;
      }

      if ((event.key === "Enter" || event.key === "Tab") && renderedRecords.length) {
        event.preventDefault();
        event.stopImmediatePropagation();
        insertRecord(renderedRecords[selectedIndex], true);
        return;
      }

      if (event.key === "Escape") {
        event.preventDefault();
        event.stopImmediatePropagation();
        hidePopup();
        bridgeRequest("focus").catch(() => {});
      }
    },
    true
  );

  document.addEventListener("mousedown", (event) => {
    if (
      !popup.contains(event.target) &&
      !abstractOverlay.contains(event.target) &&
      !bibManager.contains(event.target) &&
      event.target !== toolbarButton
    ) {
      lastEditorInteraction = "pointer";
      lastEditorInteractionAt = performance.now();
      hidePopup();
    }
  });

  window.addEventListener("resize", positionPopup);
  window.addEventListener("scroll", positionPopup, true);
  window.addEventListener("focus", () => {
    managerScheduleNextcloudSync(100);
  });
  window.setInterval(async () => {
    await managerSynchronizeNextcloud().catch(() => null);
    if (settings.syncGlobalDatabase) {
      await checkCurrentDocumentGlobalFlag({ allowAutomaticSync: false }).catch(() => null);
    }
  }, GLOBAL_CHANGE_CHECK_INTERVAL_MS);

  async function initialize() {
    await loadCachedRecords();
    await loadProjectNextcloudLinks();
    initializeProjectNextcloudUi();
    managerUpdateCloudIconState().catch(() => {});

    for (let attempt = 0; attempt < 40; attempt += 1) {
      try {
        const response = await bridgeRequest("getState", {}, 1000);
        currentState = response.state;
        updateFromEditorState();
        window.setTimeout(() => checkGlobalDatabasePrompts(), 700);
        window.setTimeout(() => managerScheduleNextcloudSync(50), 1000);
        window.setTimeout(() => {
          if (projectNextcloudLinks.length || startupAssistantCheckInProgress || projectBibliographySetupInProgress) return;
          loadProjectNextcloudLinksFromMetadataFile().catch((error) => {
            console.warn("[Smart Citations] Could not read the project Nextcloud link file:", error);
          });
        }, 6000);
        return;
      } catch (_error) {
        await delay(250);
      }
    }

    console.warn("[Smart Citations] Source-editor bridge was not found.");
  }

  initialize();
})();
