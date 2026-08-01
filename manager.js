/* SPDX-License-Identifier: CC-BY-NC-SA-4.0 */

(() => {
  "use strict";

  const extensionApi = globalThis.browser ?? globalThis.chrome;
  const PREFIX = "collabtex-citation-assistant:";
  const DB_KEY = `${PREFIX}global-bibliography:v1`;
  const PENDING_KEY = `${PREFIX}global-bibliography-pending:v1`;
  const UI_KEY = `${PREFIX}global-manager-ui:v2`;
  const AUTHOR_OPTIONS_KEY = `${PREFIX}manuscript-links:v1`;
  const CTCA_TAGS_FIELD = "ctca_tags";
  const CTCA_COMMENTS_FIELD = "ctca_comments";
  const CTCA_CROSSLINKS_FIELD = "ctca_crosslinks";
  const LIST_COLUMNS = [
    { id: "title", label: "Title / authors", min: 140, defaultWidth: 360, defaultVisible: true },
    { id: "year", label: "Year", min: 58, defaultWidth: 72, defaultVisible: true },
    { id: "key", label: "Citation key", min: 100, defaultWidth: 170, defaultVisible: true },
    { id: "addedOn", label: "Added on", min: 130, defaultWidth: 176, defaultVisible: false }
  ];

  const ENTRY_TYPES = [
    "article", "book", "booklet", "conference", "inbook", "incollection",
    "inproceedings", "manual", "mastersthesis", "misc", "phdthesis",
    "proceedings", "techreport", "unpublished"
  ];
  const CORE_FIELDS = new Set([
    "title", "author", "editor", "journal", "journaltitle", "booktitle",
    "year", "volume", "pages", "doi", "url", "abstract", "keywords",
    "publisher", "institution", "annotation", "note"
  ]);
  const AVAILABLE_FIELDS = [
    "address", "annote", "archiveprefix", "booktitle", "chapter",
    "crossref", "date", "edition", "editor", "eprint", "howpublished",
    "institution", "isbn", "issn", "journaltitle", "language", "month",
    "note", "number", "organization", "pmid", "publisher", "school",
    "series", "type", "urldate"
  ];

  const root = document.querySelector("#ctca-bib-manager");
  const appDialog = document.querySelector("#ctca-app-dialog");
  const $ = (selector, parent = document) => parent.querySelector(selector);
  const $$ = (selector, parent = document) => [...parent.querySelectorAll(selector)];

  let entries = [];
  let categoryState = { categories: [], memberships: {} };
  let selectedCategoryId = "all";
  let authorshipUserName = "";
  let selectedKey = "";
  let selectedKeys = new Set();
  let selectionAnchorKey = "";
  let crosslinkNavigationStack = [];
  let detailOnlyKey = "";
  let query = "";
  let sortState = { field: "year", direction: "desc" };
  let starredFirst = false;
  let columnWidths = Object.fromEntries(LIST_COLUMNS.map((column) => [column.id, column.defaultWidth]));
  let columnVisibility = {
    ...Object.fromEntries(LIST_COLUMNS.map((column) => [column.id, column.defaultVisible])),
    authors: true
  };
  let listDisplayOptions = {
    crosslinks: false,
    entryNotes: false,
    pdfNotes: false
  };
  let searchFields = {
    key: true,
    authors: true,
    journal: true,
    year: true,
    abstract: true,
    others: true
  };
  let searchOptions = { includeAbstract: true, includePdfText: false, includeNotesComments: false };
  let attachmentNotesSearchByKey = new Map();
  let searchFilters = { type: "", yearFrom: "", yearTo: "", doi: "any", tagged: "any" };
  let categoryWidth = 190;
  let detailsWidth = 430;
  let authorImpactHeight = 300;
  let authorImpactCollapsed = false;
  let dirty = false;
  let changeRevision = 0;
  let savedRevision = 0;
  let savedEntryContentByKey = new Map();
  let syncNextcloudBibliography = false;
  let nextcloudConnected = false;
  let deletionTombstones = [];
  let documentSyncState = { version: 1, revision: 0, documents: {} };
  let autoSaveTimer = null;
  let saveQueue = Promise.resolve();
  let busy = false;
  let bulkAbortRequested = false;
  let activeDoiRequestId = "";
  let listRenderTimer = null;
  let searchRenderTimer = null;
  let categoryListRenderRevision = 0;
  let virtualListFrame = null;
  let virtualListResizeObserver = null;
  let virtualListState = {
    entries: [],
    visibleKeys: [],
    entryByKey: new Map(),
    attachmentsByKey: null,
    estimatedRowHeight: 60,
    rowHeights: [],
    rowOffsets: [0],
    start: -1,
    end: -1,
    revision: 0
  };
  let activeWorkspaceTab = "bibliography";
  const openPdfTabs = new Map();
  const pdfAttachmentLoadingKeys = new Set();
  let renderingPdfEntryDetails = false;
  let pdfNotesWidth = 360;
  let pdfDetailsWidth = 390;
  let pdfFullscreenPaneState = null;
  const pendingPdfSaveRequests = new Map();
  let bibliographyDetailsCollapsed = false;
  let nextcloudSyncTimer = null;
  let nextcloudSyncRetryTimer = null;
  let nextcloudSyncInProgress = false;
  let nextcloudSyncFailureCount = 0;
  let nextcloudSyncWaiters = [];
  let pdfLinkRequestInProgress = false;
  let standaloneManagerPort = null;
  let standaloneCommandQueue = Promise.resolve();
  const NEXTCLOUD_SYNC_RETRY_DELAY_MS = 30 * 1000;
  const SEARCH_RENDER_DELAY_MS = 500;
  const VIRTUAL_LIST_OVERSCAN = 8;
  const MAX_MANAGER_COLUMN_WIDTH = 2400;
  const DEFAULT_DETAIL_SECTION_ORDER = ["metadata", "tags", "comments", "attachments", "crosslinks", "extra", "categories"];
  const LEGACY_DEFAULT_DETAIL_SECTION_ORDERS = [
    ["metadata", "tags", "comments", "attachments", "crosslinks", "categories", "extra"],
    ["metadata", "tags", "comments", "crosslinks", "attachments", "categories", "extra"],
    ["metadata", "tags", "comments", "crosslinks", "categories", "attachments", "extra"],
    ["metadata", "tags", "comments", "categories", "attachments", "extra"],
    ["metadata", "tags", "comments", "categories", "attachments", "extra", "crosslinks"]
  ];
  const DEFAULT_DETAIL_FIELD_ORDER = [
    "type", "key", "editor", "publication", "year", "volume", "pages",
    "doi", "url", "abstract", "keywords", "publisher", "institution", "note"
  ];
  let detailSectionOrder = [...DEFAULT_DETAIL_SECTION_ORDER];
  let detailFieldOrder = [...DEFAULT_DETAIL_FIELD_ORDER];
  let detailRenderPending = false;
  let detailRenderFlushTimer = null;

  function normalizeDetailSectionOrder(value) {
    const saved = Array.isArray(value)
      ? value.filter((id) => DEFAULT_DETAIL_SECTION_ORDER.includes(id))
      : [];
    if (LEGACY_DEFAULT_DETAIL_SECTION_ORDERS.some((order) => order.join("\u0000") === saved.join("\u0000"))) {
      return [...DEFAULT_DETAIL_SECTION_ORDER];
    }
    return [
      ...saved,
      ...DEFAULT_DETAIL_SECTION_ORDER.filter((id) => !saved.includes(id))
    ];
  }

  function escapeHtml(value) {
    return String(value ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function latexHtml(value) {
    return globalThis.CollabTeXLatex?.toHtml(value) || escapeHtml(value);
  }

  function stripBibValue(value) {
    let text = String(value ?? "").trim();
    for (let depth = 0; depth < 4 && text.length >= 2; depth += 1) {
      const braced = text.startsWith("{") && text.endsWith("}");
      const quoted = text.startsWith('"') && text.endsWith('"');
      if (!braced && !quoted) break;
      text = text.slice(1, -1).trim();
    }
    return text;
  }

  function formatDoiSyncDateTime(value) {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return String(value || "");
    const formattedDate = [
      String(date.getDate()).padStart(2, "0"),
      String(date.getMonth() + 1).padStart(2, "0"),
      date.getFullYear()
    ].join("/");
    const hour = String(date.getHours() % 12 || 12).padStart(2, "0");
    const minute = String(date.getMinutes()).padStart(2, "0");
    const period = date.getHours() < 12 ? "am" : "pm";
    return `${formattedDate}, ${hour}:${minute} ${period}`;
  }

  function stableValue(value) {
    if (Array.isArray(value)) return value.map(stableValue);
    if (value && typeof value === "object") {
      return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
    }
    return value;
  }

  function stableString(value) {
    return JSON.stringify(stableValue(value));
  }

  function normalizeCrosslinkKeys(value, selfKey = "") {
    const values = Array.isArray(value) ? value : String(value || "").split(/[,;\n]+/);
    const self = String(selfKey || "").trim().toLocaleLowerCase();
    const seen = new Set();
    return values.map((key) => String(key || "").trim()).filter((key) => {
      const normalized = key.toLocaleLowerCase();
      if (!key || normalized === self || seen.has(normalized)) return false;
      seen.add(normalized);
      return true;
    });
  }

  function normalizeEntry(entry) {
    const fields = Object.fromEntries(
      Object.entries(entry?.fields || {}).map(([name, value]) => [name, stripBibValue(value)])
    );
    const tags = globalThis.CollabTeXSearchTools.splitTags(entry?.tags || fields[CTCA_TAGS_FIELD] || "");
    delete fields[CTCA_TAGS_FIELD];
    let comments = Array.isArray(entry?.comments) ? entry.comments : [];
    if (!comments.length && fields[CTCA_COMMENTS_FIELD]) {
      try { comments = JSON.parse(decodeBase64Url(fields[CTCA_COMMENTS_FIELD])); } catch (_error) {}
    }
    delete fields[CTCA_COMMENTS_FIELD];
    const crosslinks = normalizeCrosslinkKeys(entry?.crosslinks || fields[CTCA_CROSSLINKS_FIELD] || "", entry?.key);
    delete fields[CTCA_CROSSLINKS_FIELD];
    return {
      key: String(entry?.key || "Reference"),
      type: String(entry?.type || "misc"),
      fields,
      aliases: [...new Set(Array.isArray(entry?.aliases) ? entry.aliases.filter(Boolean) : [])],
      tags,
      comments: normalizeCommentItems(comments),
      crosslinks,
      updatedAt: entry?.updatedAt || "",
      doiSyncedAt: entry?.doiSyncedAt || "",
      addedOn: entry?.addedOn || entry?.createdAt || entry?.updatedAt || "",
      starred: entry?.starred === true
    };
  }

  function entryContentFingerprint(entry) {
    const normalized = normalizeEntry(entry);
    const keyIdentity = normalized.key.trim().toLowerCase();
    const aliases = [...new Set((normalized.aliases || [])
      .map((alias) => String(alias || "").trim())
      .filter((alias) => alias && alias.toLowerCase() !== keyIdentity))]
      .sort((left, right) => left.localeCompare(right));
    return stableString({
      key: normalized.key,
      type: normalized.type,
      fields: normalized.fields,
      aliases,
      tags: [...new Set(normalized.tags || [])].sort((left, right) => left.localeCompare(right)),
      comments: normalizeCommentItems(normalized.comments),
      crosslinks: normalizeCrosslinkKeys(normalized.crosslinks, normalized.key),
      doiSyncedAt: normalized.doiSyncedAt,
      addedOn: normalized.addedOn,
      starred: normalized.starred
    });
  }

  function entryContentMap(items = entries) {
    return new Map((items || []).map((entry) => [
      `key:${String(entry?.key || "").trim().toLowerCase()}`,
      entryContentFingerprint(entry)
    ]));
  }

  function changedEntryIdentitiesSinceSave() {
    const current = entryContentMap();
    const identities = new Set([...savedEntryContentByKey.keys(), ...current.keys()]);
    return [...identities].filter((identity) => savedEntryContentByKey.get(identity) !== current.get(identity));
  }

  function deletionIdentity(entry) {
    const doi = normalizeDoi(entry?.fields?.doi || entry?.doi || "");
    if (doi) return `doi:${doi}`;
    return `key:${String(entry?.key || "").trim().toLowerCase()}`;
  }

  function normalizeDeletionTombstones(value) {
    const byIdentity = new Map();
    for (const item of Array.isArray(value) ? value : []) {
      const identity = String(item?.identity || "").trim().toLowerCase();
      if (!identity || (!identity.startsWith("doi:") && !identity.startsWith("key:"))) continue;
      const previous = byIdentity.get(identity);
      const candidate = {
        identity,
        doi: String(item?.doi || ""),
        key: String(item?.key || ""),
        title: String(item?.title || ""),
        deletedAt: item?.deletedAt || new Date().toISOString(),
        source: "global"
      };
      if (!previous || String(candidate.deletedAt) > String(previous.deletedAt)) byIdentity.set(identity, candidate);
    }
    return [...byIdentity.values()];
  }

  function rememberGlobalDeletion(entry) {
    const identity = deletionIdentity(entry);
    if (!identity || identity === "key:") return;
    const tombstone = {
      identity,
      doi: normalizeDoi(entry?.fields?.doi || ""),
      key: String(entry?.key || ""),
      title: stripBibValue(entry?.fields?.title || ""),
      deletedAt: new Date().toISOString(),
      source: "global"
    };
    deletionTombstones = normalizeDeletionTombstones([
      ...deletionTombstones.filter((item) => item.identity !== identity),
      tombstone
    ]);
  }

  function normalizeDocumentSyncState(value) {
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
      version: 1,
      revision: Math.max(0, Number(source.revision) || 0),
      documents
    };
  }

  function markKnownDocumentsPending(changeCount = 1, changedEntryIdentities = []) {
    const sync = normalizeDocumentSyncState(documentSyncState);
    const now = new Date().toISOString();
    const increment = Math.max(1, Number(changeCount) || 1);
    sync.revision += 1;
    for (const flag of Object.values(sync.documents)) {
      const pendingEntryIdentities = new Set(flag.pendingEntryIdentities || []);
      for (const identity of changedEntryIdentities) pendingEntryIdentities.add(identity);
      flag.pending = true;
      flag.pendingEntryIdentities = [...pendingEntryIdentities];
      flag.pendingCount = flag.pendingEntryIdentities.length
        ? flag.pendingEntryIdentities.length
        : Math.max(0, Number(flag.pendingCount) || 0) + increment;
      flag.pendingRevision = sync.revision;
      flag.updatedAt = now;
    }
    documentSyncState = sync;
    return sync;
  }

  function normalizeCategoryState(database) {
    const categories = Array.isArray(database?.categories)
      ? database.categories
          .filter((category) => category && typeof category.id === "string")
          .map((category, index) => ({
            id: category.id,
            name: String(category.name || "Untitled category"),
            parentId: String(category.parentId || ""),
            order: Number.isFinite(Number(category.order)) ? Number(category.order) : index,
            ...(category.shared && typeof category.shared === "object"
              ? { shared: {
                  ...category.shared,
                  categoryIds: { ...(category.shared.categoryIds || {}) },
                  entryKeys: { ...(category.shared.entryKeys || {}) }
                } }
              : {})
          }))
      : [];
    const validIds = new Set(categories.map((category) => category.id));
    for (const category of categories) {
      if (category.parentId === category.id || !validIds.has(category.parentId)) category.parentId = "";
    }
    const validKeys = new Set(entries.map((entry) => entry.key));
    const memberships = {};
    if (database?.memberships && typeof database.memberships === "object") {
      for (const [key, categoryIds] of Object.entries(database.memberships)) {
        if (!validKeys.has(key)) continue;
        const normalized = [...new Set((Array.isArray(categoryIds) ? categoryIds : []).filter((id) => validIds.has(id)))];
        if (normalized.length) memberships[key] = normalized;
      }
    }
    return { categories, memberships };
  }

  function setStatus(message, error = false) {
    const node = $(".ctca-manager-status", root);
    node.textContent = message || "";
    node.title = node.textContent;
    node.classList.toggle("ctca-manager-error", Boolean(error));
    if (error && message) console.error("[Smart Citations]", message);
  }

  function nextcloudCredentialsPresent(config) {
    const nc = config?.nextcloud || {};
    return Boolean(nc.server && nc.loginName && nc.appPassword);
  }

  function updateNextcloudSyncToggle(config = null) {
    const toggle = $(".ctca-manager-global-sync-checkbox", root);
    const label = toggle?.closest(".ctca-manager-global-sync");
    if (!toggle) return;
    const requested = config ? Boolean(config.nextcloud?.syncBibliography) : syncNextcloudBibliography;
    toggle.checked = Boolean(nextcloudConnected && requested);
    toggle.disabled = Boolean(busy || !nextcloudConnected);
    const cloudButton = $(".ctca-manager-cloud-settings", root);
    const active = Boolean(nextcloudConnected && requested);
    label?.classList.toggle("ctca-nextcloud-connected", nextcloudConnected);
    label?.classList.toggle("ctca-nextcloud-disconnected", !nextcloudConnected);
    cloudButton?.classList.toggle("ctca-nextcloud-sync-active", active);
    cloudButton?.setAttribute("aria-pressed", active ? "true" : "false");
    if (cloudButton) cloudButton.title = active
      ? "Nextcloud connected; bibliography synchronization is active"
      : "Configure Nextcloud and PDF storage";
    if (label) {
      label.title = nextcloudConnected
        ? "Synchronize the global bibliography BibTeX file with Nextcloud in the background."
        : "Connect to Nextcloud first to enable bibliography synchronization.";
    }
  }

  async function refreshNextcloudSyncState(configOverride = null) {
    const config = configOverride || await globalThis.CollabTeXAttachmentStore.getConfig();
    nextcloudConnected = nextcloudCredentialsPresent(config)
      && await globalThis.CollabTeXAttachmentStore.checkNextcloudConnection(config);
    syncNextcloudBibliography = Boolean(nextcloudConnected && config.nextcloud?.syncBibliography);
    updateNextcloudSyncToggle(config);
    return nextcloudConnected;
  }

  function setBusy(value, label = "Working…") {
    busy = value;
    root.classList.toggle("ctca-manager-busy", value);
    const controls = root.querySelectorAll(
      ".ctca-manager-add-entry, .ctca-manager-add-menu button, .ctca-manager-add-category, .ctca-manager-update, " +
      ".ctca-manager-update-all-doi, .ctca-manager-update-selected, .ctca-manager-remove-selected, " +
      ".ctca-manager-select-visible-checkbox, .ctca-manager-global-sync-checkbox, .ctca-manager-cloud-settings, .ctca-manager-options, .ctca-manager-star-sort, .ctca-manager-column-eye, [data-manager-sort]"
    );
    controls.forEach((control) => { control.disabled = value; });
    updateNextcloudSyncToggle();
    const exportButton = $(".ctca-manager-update", root);
    if (exportButton) exportButton.disabled = value || entries.length === 0;
    updateSelectionControls(filteredEntries().map((entry) => entry.key));
  }

  function setListLoading(visible) {
    const overlay = $(".ctca-manager-list-loading-overlay", root);
    const list = $(".ctca-manager-list", root);
    if (!overlay || !list) return;
    overlay.hidden = !visible;
    list.setAttribute("aria-busy", visible ? "true" : "false");
  }

  function selectCategory(categoryId) {
    if (!categoryId || selectedCategoryId === categoryId) return;
    selectedCategoryId = categoryId;
    setListLoading(true);
    const revision = ++categoryListRenderRevision;
    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => {
        if (revision !== categoryListRenderRevision) return;
        try {
          renderCategories();
          renderList();
        } finally {
          setListLoading(false);
        }
        window.requestAnimationFrame(() => {
          saveUiState().catch(() => {});
        });
      });
    });
  }

  function setProgress(processed, total, label, visible = true) {
    const container = $(".ctca-manager-progress", root);
    const progress = $(".ctca-manager-progress-bar", root);
    const text = $(".ctca-manager-progress-label", root);
    container.hidden = !visible;
    progress.max = Math.max(1, total);
    progress.value = Math.min(processed, Math.max(1, total));
    text.textContent = label || "";
  }

  async function storageGet(key) {
    return extensionApi.storage.local.get(key);
  }

  async function loadDatabase() {
    const [dbData, uiData, attachmentConfig] = await Promise.all([
      storageGet(DB_KEY),
      storageGet(UI_KEY),
      globalThis.CollabTeXAttachmentStore.getConfig()
    ]);
    const database = dbData?.[DB_KEY] || { version: 1, entries: [] };
    entries = Array.isArray(database.entries) ? database.entries.map(normalizeEntry) : [];
    crosslinkNavigationStack = [];
    detailOnlyKey = "";
    const legacyAddedOn = database.updatedAt || new Date().toISOString();
    for (const entry of entries) if (!entry.addedOn) entry.addedOn = legacyAddedOn;
    savedEntryContentByKey = entryContentMap(entries);
    deletionTombstones = normalizeDeletionTombstones(database.deletedEntries);
    documentSyncState = normalizeDocumentSyncState(database.documentSync);
    categoryState = normalizeCategoryState(database);
    window.clearTimeout(autoSaveTimer);
    autoSaveTimer = null;
    dirty = false;
    changeRevision = 0;
    savedRevision = 0;
    nextcloudConnected = nextcloudCredentialsPresent(attachmentConfig)
      && await globalThis.CollabTeXAttachmentStore.checkNextcloudConnection(attachmentConfig);
    syncNextcloudBibliography = Boolean(nextcloudConnected && attachmentConfig?.nextcloud?.syncBibliography);
    updateNextcloudSyncToggle(attachmentConfig);

    const ui = uiData?.[UI_KEY] || {};
    categoryWidth = Math.max(130, Math.min(420, Number(ui.categoryWidth) || 190));
    detailsWidth = Math.max(280, Math.min(900, Number(ui.detailsWidth) || 430));
    authorImpactHeight = Math.max(120, Math.min(720, Number(ui.authorImpactHeight) || 300));
    authorImpactCollapsed = ui.authorImpactCollapsed === true;
    starredFirst = ui.starredFirst === true;
    if (ui.sortState && ["author", "year", "key", "addedOn"].includes(ui.sortState.field)) {
      sortState = {
        field: ui.sortState.field,
        direction: ui.sortState.direction === "desc" ? "desc" : "asc"
      };
    }
    if (ui.columnWidths && typeof ui.columnWidths === "object") {
      for (const column of LIST_COLUMNS) {
        const width = Number(ui.columnWidths[column.id]);
        if (Number.isFinite(width)) columnWidths[column.id] = Math.max(column.min, Math.min(MAX_MANAGER_COLUMN_WIDTH, width));
      }
    }
    if (ui.columnVisibility && typeof ui.columnVisibility === "object") {
      for (const column of LIST_COLUMNS) {
        if (column.id in ui.columnVisibility) columnVisibility[column.id] = ui.columnVisibility[column.id] !== false;
      }
      if ("authors" in ui.columnVisibility) columnVisibility.authors = ui.columnVisibility.authors !== false;
    }
    if (ui.listDisplayOptions && typeof ui.listDisplayOptions === "object") {
      for (const key of Object.keys(listDisplayOptions)) {
        if (key in ui.listDisplayOptions) listDisplayOptions[key] = ui.listDisplayOptions[key] === true;
      }
    }
    selectedCategoryId = ui.selectedCategoryId && (
      ["all", "starred", "authorships", "coauthorships", "recent", "uncategorized"].includes(ui.selectedCategoryId) ||
      categoryState.categories.some((category) => category.id === ui.selectedCategoryId)
    ) ? ui.selectedCategoryId : "all";
    if (ui.searchFields && typeof ui.searchFields === "object") {
      searchFields = { ...searchFields, ...ui.searchFields };
      if (!Object.values(searchFields).some(Boolean)) searchFields.key = true;
    }
    if (ui.searchOptions && typeof ui.searchOptions === "object") {
      searchOptions = { ...searchOptions, ...ui.searchOptions };
    }
    if (Array.isArray(ui.detailSectionOrder)) {
      detailSectionOrder = normalizeDetailSectionOrder(ui.detailSectionOrder);
    }
    if (Array.isArray(ui.detailFieldOrder)) {
      detailFieldOrder = [
        ...ui.detailFieldOrder.filter((id) => DEFAULT_DETAIL_FIELD_ORDER.includes(id)),
        ...DEFAULT_DETAIL_FIELD_ORDER.filter((id) => !ui.detailFieldOrder.includes(id))
      ];
    }
    searchFilters = globalThis.CollabTeXSearchTools.normalizeFilterState(ui.searchFilters || searchFilters);
    if (searchOptions.includeNotesComments) await refreshNotesCommentsSearchCache(false);
    applyColumnWidths();
    applyManagerTableColumns();
    applySearchFieldSettings();
    applyAdvancedSearchUi();
  }

  async function saveUiState() {
    await extensionApi.storage.local.set({
      [UI_KEY]: {
        categoryWidth,
        detailsWidth,
        authorImpactHeight,
        authorImpactCollapsed,
        starredFirst,
        sortState: { ...sortState },
        columnWidths: { ...columnWidths },
        columnVisibility: { ...columnVisibility },
        listDisplayOptions: { ...listDisplayOptions },
        selectedCategoryId,
        searchFields,
        searchOptions,
        searchFilters,
        detailSectionOrder,
        detailFieldOrder
      }
    });
  }

  function databaseSnapshot({ markChanged = false, changeCount = 1, changedEntryIdentities = [] } = {}) {
    const presentIdentities = new Set(entries.map(deletionIdentity));
    deletionTombstones = normalizeDeletionTombstones(
      deletionTombstones.filter((item) => !presentIdentities.has(item.identity))
    );
    if (markChanged) markKnownDocumentsPending(changeCount, changedEntryIdentities);
    return {
      version: 3,
      entries: entries.map((entry) => ({
        key: entry.key,
        type: entry.type,
        fields: { ...(entry.fields || {}) },
        aliases: [...new Set(entry.aliases || [])],
        tags: globalThis.CollabTeXSearchTools.splitTags(entry.tags || []),
        comments: normalizeCommentItems(entry.comments),
        crosslinks: normalizeCrosslinkKeys(entry.crosslinks, entry.key),
        updatedAt: entry.updatedAt || "",
        doiSyncedAt: entry.doiSyncedAt || "",
        addedOn: entry.addedOn || "",
        starred: entry.starred === true
      })),
      categories: categoryState.categories.map((category) => ({ ...category })),
      memberships: Object.fromEntries(
        Object.entries(categoryState.memberships || {}).map(([key, ids]) => [key, [...ids]])
      ),
      deletedEntries: deletionTombstones.map((item) => ({ ...item })),
      documentSync: normalizeDocumentSyncState(documentSyncState),
      updatedAt: new Date().toISOString()
    };
  }

  function scheduleAutoSave(message = "Changes saved automatically.", delay = 260) {
    window.clearTimeout(autoSaveTimer);
    autoSaveTimer = window.setTimeout(() => {
      autoSaveTimer = null;
      saveDatabase(message).catch((error) => {
        dirty = true;
        setStatus(`Automatic save failed: ${error.message || String(error)}`, true);
      });
    }, delay);
  }

  async function saveDatabase(message = "Changes saved automatically.") {
    window.clearTimeout(autoSaveTimer);
    autoSaveTimer = null;
    const revision = changeRevision;
    const changedEntryIdentities = changedEntryIdentitiesSinceSave();
    const snapshot = databaseSnapshot({
      markChanged: dirty || revision > savedRevision,
      changeCount: Math.max(1, changedEntryIdentities.length),
      changedEntryIdentities
    });
    saveQueue = saveQueue.catch(() => {}).then(async () => {
      await extensionApi.storage.local.set({ [DB_KEY]: snapshot });
      await extensionApi.storage.local.remove(PENDING_KEY);
      savedEntryContentByKey = entryContentMap(snapshot.entries);
      savedRevision = Math.max(savedRevision, revision);
      dirty = savedRevision < changeRevision;
      updateCount();
      setStatus(syncNextcloudBibliography
        ? `${message} Nextcloud synchronization is enabled.`
        : message);
      scheduleNextcloudSync();
      if (dirty) scheduleAutoSave();
    });
    return saveQueue;
  }

  async function flushAutoSave(message = "Changes saved automatically.") {
    window.clearTimeout(autoSaveTimer);
    autoSaveTimer = null;
    if (!dirty && savedRevision >= changeRevision) return saveQueue;
    return saveDatabase(message);
  }

  function markDirty(message = "Saving changes automatically…") {
    dirty = true;
    changeRevision += 1;
    updateCount();
    setStatus(message);
    scheduleAutoSave();
  }

  function entryByKey(key) {
    return entries.find((entry) => entry.key === key) || null;
  }

  function allAuthors(entry) {
    return authorNames(entry).join("; ");
  }

  function authorNames(entry) {
    const value = String(entry?.fields?.author || entry?.fields?.editor || "");
    const authors = globalThis.CollabTeXBibTeX.splitAuthors(value);
    return authors.length ? authors : ["Authors not specified"];
  }

  function allAuthorsHtml(entry) {
    const value = String(entry?.fields?.author || entry?.fields?.editor || "");
    const authors = globalThis.CollabTeXBibTeX.splitAuthorsDisplayRaw(value);
    return latexHtml(authors.length ? authors.join("\n") : "Authors not specified");
  }

  function firstAuthor(entry) {
    const value = String(entry?.fields?.author || entry?.fields?.editor || "");
    const first = globalThis.CollabTeXBibTeX.splitAuthorsRaw(value)[0] || "";
    return globalThis.CollabTeXBibTeX.authorFamilyName(first);
  }

  function abbreviatedFirstAuthor(entry) {
    const value = String(entry?.fields?.author || entry?.fields?.editor || "");
    const raw = globalThis.CollabTeXBibTeX.splitAuthorsRaw(value)[0] || "";
    if (!raw) return "Unknown et al.";
    const formatted = globalThis.CollabTeXBibTeX.formatAuthorName(raw);
    const family = globalThis.CollabTeXBibTeX.authorFamilyName(raw);
    const given = formatted.slice(0, Math.max(0, formatted.lastIndexOf(family))).trim();
    const initial = given.match(/\p{L}/u)?.[0] || "";
    return `${initial ? `${initial}. ` : ""}${family || formatted} et al.`;
  }

  function personIdentity(value) {
    const raw = String(value || "").trim();
    if (!raw) return null;
    const formatted = globalThis.CollabTeXBibTeX.formatAuthorName(raw);
    const family = globalThis.CollabTeXBibTeX.authorFamilyName(raw);
    const given = formatted.slice(0, Math.max(0, formatted.lastIndexOf(family))).trim();
    const normalize = (text) => globalThis.CollabTeXBibTeX.latexToText(text)
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

  function personNamesMatch(left, right) {
    const first = personIdentity(left);
    const second = personIdentity(right);
    if (!first || !second || !first.family || first.family !== second.family) return false;
    if (first.full === second.full) return true;
    return !first.initial || !second.initial || first.initial === second.initial;
  }

  function entryAuthorshipCategory(entry) {
    if (!authorshipUserName) return "";
    const authors = globalThis.CollabTeXBibTeX.splitAuthorsRaw(entry?.fields?.author || "");
    const index = authors.findIndex((author) => personNamesMatch(author, authorshipUserName));
    return index === 0 ? "authorships" : index > 0 ? "coauthorships" : "";
  }

  async function ensureAuthorshipUserName() {
    const stored = (await extensionApi.storage.local.get(AUTHOR_OPTIONS_KEY))?.[AUTHOR_OPTIONS_KEY] || {};
    authorshipUserName = String(stored.userName || "").trim();
    if (authorshipUserName || stored.identitySetupSeen === true) return;
    let nameInput;
    const result = await showDialog({
      title: "Link your author identity",
      message: "Enter your published name, or authenticate through ORCID’s official sign-in flow. This is used for the automatic author categories and exact OpenAlex matching.",
      controls: (container) => {
        const fields = document.createElement("div");
        fields.className = "ctca-global-dialog-form";
        fields.innerHTML = `
          <label class="ctca-app-dialog-field"><span>Your published name</span><input data-author-name type="text" autocomplete="name" placeholder="e.g. Ada Lovelace"></label>
        `;
        nameInput = $("[data-author-name]", fields);
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
        setStatus(response?.error || "The ORCID account could not be linked.", true);
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
    authorshipUserName = String(next.userName || "").trim();
    await extensionApi.storage.local.set({
      [AUTHOR_OPTIONS_KEY]: next
    });
  }

  function formatAddedOn(value) {
    return value ? formatDoiSyncDateTime(value) : "Unknown";
  }

  function publication(entry) {
    const fields = entry?.fields || {};
    return fields.journal || fields.journaltitle || fields.booktitle || "Publication not specified";
  }

  function parseSearchTerms(value) {
    const result = [];
    const pattern = /"([^"]+)"|(\S+)/g;
    let match;
    while ((match = pattern.exec(String(value || "")))) {
      result.push((match[1] ?? match[2]).toLowerCase());
    }
    return result;
  }

  function searchHaystack(entry) {
    const fields = entry.fields || {};
    const pieces = [];
    if (searchFields.key) pieces.push(entry.key, ...(entry.aliases || []));
    if (searchFields.authors) pieces.push(fields.author, fields.editor);
    if (searchFields.journal) pieces.push(fields.journal, fields.journaltitle, fields.booktitle, fields.publisher);
    if (searchFields.year) pieces.push(fields.year);
    if (searchFields.abstract) pieces.push(fields.abstract);
    if (searchFields.others) {
      const categorized = new Set([
        "author", "editor", "journal", "journaltitle", "booktitle", "publisher", "year", "abstract"
      ]);
      for (const [name, value] of Object.entries(fields)) {
        if (!categorized.has(name)) pieces.push(name, value);
      }
      pieces.push(fields.title, entry.type);
    } else {
      pieces.push(fields.title);
    }
    return pieces.filter(Boolean).join("\n").toLowerCase();
  }

  function categoryById(categoryId) {
    return categoryState.categories.find((category) => category.id === categoryId) || null;
  }

  function categoryChildren(parentId = "") {
    return categoryState.categories
      .filter((category) => category.parentId === parentId)
      .sort((left, right) => left.order - right.order || left.name.localeCompare(right.name));
  }

  function categoryDescendants(categoryId) {
    const result = new Set([categoryId]);
    const visit = (parentId) => {
      for (const child of categoryChildren(parentId)) {
        if (result.has(child.id)) continue;
        result.add(child.id);
        visit(child.id);
      }
    };
    visit(categoryId);
    return result;
  }

  function categoryPath(categoryId) {
    const parts = [];
    const seen = new Set();
    let current = categoryById(categoryId);
    while (current && !seen.has(current.id)) {
      seen.add(current.id);
      parts.unshift(current.name);
      current = categoryById(current.parentId);
    }
    return parts.join(" / ");
  }

  function sharedCategoryRoot(categoryId) {
    let current = categoryById(categoryId);
    const visited = new Set();
    while (current && !visited.has(current.id)) {
      visited.add(current.id);
      if (current.shared?.id) return current;
      current = categoryById(current.parentId);
    }
    return null;
  }

  function sharedCategoryForEntry(key) {
    return entryCategoryIds(key).map(sharedCategoryRoot).find(Boolean) || null;
  }

  function isReadOnlySharedCategory(categoryId) {
    const rootCategory = sharedCategoryRoot(categoryId);
    return Boolean(rootCategory?.shared?.role === "member" && rootCategory.shared.permission !== "write");
  }

  function isReadOnlySharedEntry(key) {
    const rootCategory = sharedCategoryForEntry(key);
    return Boolean(rootCategory?.shared?.role === "member" && rootCategory.shared.permission !== "write");
  }

  function updateSharedLocalKeyOverride(oldKey, newKey) {
    for (const category of categoryState.categories) {
      if (!category.shared?.id) continue;
      const entryKeys = { ...(category.shared.entryKeys || {}) };
      const canonicalKey = Object.keys(entryKeys).find((key) => String(entryKeys[key]).toLowerCase() === String(oldKey).toLowerCase());
      if (canonicalKey) {
        entryKeys[canonicalKey] = newKey;
        category.shared.entryKeys = entryKeys;
      }
    }
  }

  function entryCategoryIds(key) {
    return Array.isArray(categoryState.memberships[key])
      ? categoryState.memberships[key].filter((id) => Boolean(categoryById(id)))
      : [];
  }

  function setEntryCategoryIds(key, categoryIds) {
    const valid = [...new Set((categoryIds || []).filter((id) => Boolean(categoryById(id))))];
    if (valid.length) categoryState.memberships[key] = valid;
    else delete categoryState.memberships[key];
  }

  function entryMatchesCategory(entry) {
    const ids = entryCategoryIds(entry.key);
    if (selectedCategoryId === "all") return true;
    if (selectedCategoryId === "starred") return entry.starred === true;
    if (selectedCategoryId === "recent") return true;
    if (selectedCategoryId === "authorships" || selectedCategoryId === "coauthorships") {
      return entryAuthorshipCategory(entry) === selectedCategoryId;
    }
    if (selectedCategoryId === "uncategorized") return ids.length === 0 && !entryAuthorshipCategory(entry);
    const accepted = categoryDescendants(selectedCategoryId);
    return ids.some((id) => accepted.has(id));
  }

  function categoryCount(categoryId) {
    if (categoryId === "all") return entries.length;
    if (categoryId === "starred") return entries.filter((entry) => entry.starred === true).length;
    if (categoryId === "recent") return entries.length;
    if (categoryId === "authorships" || categoryId === "coauthorships") {
      return entries.filter((entry) => entryAuthorshipCategory(entry) === categoryId).length;
    }
    if (categoryId === "uncategorized") {
      return entries.filter((entry) => entryCategoryIds(entry.key).length === 0 && !entryAuthorshipCategory(entry)).length;
    }
    const accepted = categoryDescendants(categoryId);
    return entries.filter((entry) => entryCategoryIds(entry.key).some((id) => accepted.has(id))).length;
  }

  function entrySearchModel(entry) {
    return {
      ...entry,
      tags: globalThis.CollabTeXSearchTools.splitTags(entry.tags || []),
      categoryPaths: entryCategoryIds(entry.key).map(categoryPath).filter(Boolean),
      notesCommentsText: [
        ...normalizeCommentItems(entry.comments).map((comment) => comment.text),
        attachmentNotesSearchByKey.get(entry.key) || ""
      ].join("\n")
    };
  }

  async function refreshNotesCommentsSearchCache(render = true) {
    const grouped = await globalThis.CollabTeXAttachmentStore.listMany(entries);
    attachmentNotesSearchByKey = new Map(entries.map((entry) => [
      entry.key,
      (grouped.get(entry.key) || [])
        .flatMap((attachment) => normalizedPdfNoteItems(attachment).map((note) => note.text))
        .join("\n")
    ]));
    if (render) renderList();
  }

  function filteredEntries() {
    const ranked = entries.map((entry) => ({
      entry,
      ...globalThis.CollabTeXSearchTools.matchEntry(entrySearchModel(entry), query, {
        includeAbstract: searchOptions.includeAbstract,
        includePdfText: searchOptions.includePdfText,
        includeNotesComments: searchOptions.includeNotesComments,
        filters: searchFilters
      })
    })).filter((item) => item.matched && entryMatchesCategory(item.entry));
    if (selectedCategoryId === "recent") {
      return ranked.sort((left, right) =>
        (new Date(right.entry.addedOn || 0).getTime() || 0) -
        (new Date(left.entry.addedOn || 0).getTime() || 0)
      ).map((item) => item.entry);
    }
    const direction = sortState.direction === "asc" ? 1 : -1;
    const value = (entry) => {
      if (sortState.field === "year") return Number(String(entry.fields?.year || "").match(/\d{4}/)?.[0] || -Infinity);
      if (sortState.field === "author") return firstAuthor(entry).toLowerCase();
      if (sortState.field === "addedOn") return new Date(entry.addedOn || 0).getTime() || 0;
      return entry.key.toLowerCase();
    };
    return ranked.sort((left, right) => {
      if (starredFirst && left.entry.starred !== right.entry.starred) return left.entry.starred ? -1 : 1;
      const leftValue = value(left.entry);
      const rightValue = value(right.entry);
      let comparison;
      if (typeof leftValue === "number" && typeof rightValue === "number") {
        comparison = (leftValue - rightValue) * direction;
      } else {
        comparison = String(leftValue).localeCompare(String(rightValue), undefined, { numeric: true, sensitivity: "base" }) * direction;
      }
      if (comparison) return comparison;
      if (query.trim() && left.rank !== right.rank) return left.rank - right.rank;
      return left.entry.key.localeCompare(right.entry.key, undefined, { numeric: true, sensitivity: "base" });
    }).map((item) => item.entry);
  }

  function updateCount(visibleCount = filteredEntries().length) {
    const changes = [
      selectedKeys.size ? `${selectedKeys.size} selected` : "",
      dirty ? "saving…" : ""
    ].filter(Boolean).join(" · ");
    const filterCount = globalThis.CollabTeXSearchTools.activeFilterCount(searchFilters);
    const filterLabel = filterCount ? ` · ${filterCount} filter${filterCount === 1 ? "" : "s"}` : "";
    $(".ctca-manager-count", root).textContent = `${visibleCount} of ${entries.length} entries${filterLabel}${changes ? ` · ${changes}` : ""}`;
    const exportButton = $(".ctca-manager-update", root);
    if (exportButton) exportButton.disabled = busy || entries.length === 0;
  }

  function renderCategories() {
    const container = $(".ctca-manager-category-tree", root);
    container.replaceChildren();

    const createFixed = (id, label) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "ctca-manager-category-fixed";
      button.classList.toggle("ctca-manager-category-selected", selectedCategoryId === id);
      button.dataset.categoryId = id;
      button.innerHTML = `<span>${escapeHtml(label)}</span><span class="ctca-manager-category-count">${categoryCount(id)}</span>`;
      button.addEventListener("click", () => {
        selectCategory(id);
      });
      if (id === "uncategorized") {
        button.addEventListener("dragover", (event) => {
          if (!Array.from(event.dataTransfer?.types || []).includes("application/x-ctca-entry-keys")) return;
          event.preventDefault();
          button.classList.add("ctca-manager-category-drop-target");
        });
        button.addEventListener("dragleave", () => button.classList.remove("ctca-manager-category-drop-target"));
        button.addEventListener("drop", (event) => {
          event.preventDefault();
          button.classList.remove("ctca-manager-category-drop-target");
          try {
            const keys = JSON.parse(event.dataTransfer.getData("application/x-ctca-entry-keys") || "[]");
            for (const key of keys) delete categoryState.memberships[key];
            markDirty("Saving category assignments automatically…");
            renderCategories();
            renderList();
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
      for (const category of categoryChildren(parentId)) {
        const categorySharedRoot = sharedCategoryRoot(category.id);
        const sharedStatusClass = categorySharedRoot?.shared?.syncStatus === "error"
          ? "ctca-shared-error"
          : categorySharedRoot?.shared?.role === "owner"
            ? "ctca-shared-owner"
            : "";
        const sharedTitle = categorySharedRoot
          ? categorySharedRoot.shared.syncStatus === "error"
            ? `Last shared-category sync failed: ${categorySharedRoot.shared.syncError || "Unknown error"}`
            : categorySharedRoot.shared.role === "owner"
              ? "You own this shared category"
              : `Shared category (${categorySharedRoot.shared.permission === "write" ? "read and write" : "read only"})`
          : "";
        const row = document.createElement("div");
        row.className = "ctca-manager-category-row";
        row.classList.toggle("ctca-manager-category-selected", selectedCategoryId === category.id);
        row.dataset.categoryId = category.id;
        row.draggable = true;
        row.style.setProperty("--ctca-category-depth", String(depth));
        row.innerHTML = `
          <span class="ctca-manager-category-handle" title="Drag to reorder or nest" aria-hidden="true">⋮⋮</span>
          <button type="button" class="ctca-manager-category-name" title="${escapeHtml(categoryPath(category.id))}">${escapeHtml(category.name)}</button>
          ${categorySharedRoot ? `<button type="button" class="ctca-manager-category-share-icon ${sharedStatusClass}" title="${escapeHtml(sharedTitle)}" aria-label="${escapeHtml(`${sharedTitle}. Open sharing menu`)}" aria-haspopup="menu">&#128279;&#xfe0e;</button>` : ""}
          <span class="ctca-manager-category-count">${categoryCount(category.id)}</span>
        `;
        $(".ctca-manager-category-name", row).addEventListener("click", () => {
          selectCategory(category.id);
        });
        $(".ctca-manager-category-share-icon", row)?.addEventListener("click", (event) => {
          event.preventDefault();
          event.stopPropagation();
          hideEntryContextMenu();
          const menu = $(".ctca-category-context-menu", root);
          menu.dataset.categoryId = categorySharedRoot.id;
          $(".ctca-category-add-child", menu).hidden = true;
          $(".ctca-category-share", menu).hidden = true;
          $(".ctca-category-view-share-link", menu).hidden = false;
          const stopButton = $(".ctca-category-stop-sharing", menu);
          stopButton.hidden = false;
          stopButton.textContent = categorySharedRoot.shared.role === "owner" ? "Stop sharing…" : "Stop remote sync…";
          $(".ctca-category-remove", menu).hidden = true;
          delete menu.dataset.pointerEntered;
          menu.onpointerenter = () => { menu.dataset.pointerEntered = "true"; };
          menu.onpointerleave = () => {
            if (menu.dataset.pointerEntered === "true") hideCategoryContextMenu();
          };
          const bounds = event.currentTarget.getBoundingClientRect();
          menu.style.left = `${Math.min(bounds.right, window.innerWidth - 220)}px`;
          menu.style.top = `${Math.min(bounds.bottom + 2, window.innerHeight - 110)}px`;
          menu.hidden = false;
        });
        row.addEventListener("contextmenu", (event) => {
          event.preventDefault();
          hideEntryContextMenu();
          const menu = $(".ctca-category-context-menu", root);
          menu.dataset.categoryId = category.id;
          const sharedRoot = sharedCategoryRoot(category.id);
          const isSharedRoot = sharedRoot?.id === category.id;
          const readOnly = isReadOnlySharedCategory(category.id);
          const addChildButton = $(".ctca-category-add-child", menu);
          const shareButton = $(".ctca-category-share", menu);
          const viewShareLinkButton = $(".ctca-category-view-share-link", menu);
          const stopButton = $(".ctca-category-stop-sharing", menu);
          const removeButton = $(".ctca-category-remove", menu);
          addChildButton.hidden = false;
          addChildButton.disabled = readOnly;
          addChildButton.title = readOnly ? "This shared category is read-only." : "Add a subcategory";
          shareButton.hidden = isSharedRoot;
          shareButton.disabled = Boolean(!nextcloudConnected || !syncNextcloudBibliography || sharedRoot);
          shareButton.title = !nextcloudConnected || !syncNextcloudBibliography
            ? "Connect Nextcloud and enable bibliography synchronization to share categories."
            : sharedRoot
              ? "Subcategories of a shared category cannot be shared again."
              : "Share this category through Nextcloud";
          viewShareLinkButton.hidden = !sharedRoot;
          stopButton.hidden = !isSharedRoot;
          if (isSharedRoot) stopButton.textContent = sharedRoot.shared.role === "owner" ? "Stop sharing…" : "Stop remote sync…";
          removeButton.hidden = false;
          delete menu.dataset.pointerEntered;
          menu.onpointerenter = () => { menu.dataset.pointerEntered = "true"; };
          menu.onpointerleave = () => {
            if (menu.dataset.pointerEntered === "true") hideCategoryContextMenu();
          };
          menu.style.left = `${Math.min(event.clientX, window.innerWidth - 220)}px`;
          menu.style.top = `${Math.min(event.clientY, window.innerHeight - 180)}px`;
          menu.hidden = false;
        });
        row.addEventListener("dragstart", (event) => {
          event.dataTransfer.effectAllowed = "move";
          event.dataTransfer.setData("application/x-ctca-category", category.id);
          row.classList.add("ctca-manager-category-dragging");
        });
        row.addEventListener("dragend", () => {
          row.classList.remove("ctca-manager-category-dragging");
          root.querySelectorAll(".ctca-manager-category-drop-before, .ctca-manager-category-drop-after, .ctca-manager-category-drop-inside")
            .forEach((item) => item.classList.remove("ctca-manager-category-drop-before", "ctca-manager-category-drop-after", "ctca-manager-category-drop-inside"));
        });
        row.addEventListener("dragover", (event) => {
          const types = Array.from(event.dataTransfer?.types || []);
          if (!types.includes("application/x-ctca-category") && !types.includes("application/x-ctca-entry-keys")) return;
          event.preventDefault();
          const mode = types.includes("application/x-ctca-category") ? categoryDropMode(row, event.clientY) : "inside";
          row.classList.remove("ctca-manager-category-drop-before", "ctca-manager-category-drop-after", "ctca-manager-category-drop-inside");
          row.classList.add(`ctca-manager-category-drop-${mode}`);
        });
        row.addEventListener("dragleave", (event) => {
          if (row.contains(event.relatedTarget)) return;
          row.classList.remove("ctca-manager-category-drop-before", "ctca-manager-category-drop-after", "ctca-manager-category-drop-inside");
        });
        row.addEventListener("drop", (event) => {
          event.preventDefault();
          event.stopPropagation();
          const sourceCategory = event.dataTransfer.getData("application/x-ctca-category");
          const entryPayload = event.dataTransfer.getData("application/x-ctca-entry-keys");
          const mode = categoryDropMode(row, event.clientY);
          row.classList.remove("ctca-manager-category-drop-before", "ctca-manager-category-drop-after", "ctca-manager-category-drop-inside");
          if (sourceCategory) {
            moveCategory(sourceCategory, category.id, mode);
          } else if (entryPayload) {
            try {
              assignEntriesToCategory(JSON.parse(entryPayload), category.id);
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

  function categoryDropMode(element, clientY) {
    const rect = element.getBoundingClientRect();
    const relative = (clientY - rect.top) / Math.max(1, rect.height);
    if (relative < 0.25) return "before";
    if (relative > 0.75) return "after";
    return "inside";
  }

  function normalizeCategoryOrders(parentId = "") {
    categoryChildren(parentId).forEach((category, index) => { category.order = index; });
  }

  function canMoveCategory(categoryId, parentId) {
    if (!categoryId || categoryId === parentId) return false;
    if (!parentId) return true;
    return !categoryDescendants(categoryId).has(parentId);
  }

  function moveCategory(categoryId, targetId, mode) {
    const category = categoryById(categoryId);
    const target = categoryById(targetId);
    if (!category || !target) return;
    const oldParentId = category.parentId;
    const newParentId = mode === "inside" ? target.id : target.parentId;
    const sourceSharedRoot = sharedCategoryRoot(categoryId);
    const targetSharedRoot = sharedCategoryRoot(newParentId);
    if (isReadOnlySharedCategory(categoryId) || isReadOnlySharedCategory(newParentId)) {
      setStatus("This shared category is read-only.", true);
      return;
    }
    if (sourceSharedRoot?.id === categoryId || (sourceSharedRoot && sourceSharedRoot.id !== targetSharedRoot?.id)) {
      setStatus("A shared category tree cannot be moved outside its shared root.", true);
      return;
    }
    if (!canMoveCategory(categoryId, newParentId)) return;
    category.parentId = newParentId;
    const siblings = categoryChildren(newParentId).filter((item) => item.id !== categoryId);
    if (mode === "inside") {
      siblings.push(category);
    } else {
      const targetIndex = siblings.findIndex((item) => item.id === target.id);
      siblings.splice(Math.max(0, targetIndex + (mode === "after" ? 1 : 0)), 0, category);
    }
    siblings.forEach((item, index) => { item.order = index; });
    normalizeCategoryOrders(oldParentId);
    markDirty("Saving category order automatically…");
    renderCategories();
  }

  function assignEntriesToCategory(keys, categoryId) {
    if (!categoryById(categoryId)) return;
    if (isReadOnlySharedCategory(categoryId)) {
      setStatus("Entries cannot be added to a read-only shared category.", true);
      return;
    }
    for (const key of keys) {
      const memberships = new Set(entryCategoryIds(key));
      memberships.add(categoryId);
      setEntryCategoryIds(key, [...memberships]);
    }
    markDirty("Saving category assignments automatically…");
    renderCategories();
    renderList();
  }

  function selectRange(visibleKeys, targetKey) {
    const anchor = selectionAnchorKey && visibleKeys.includes(selectionAnchorKey) ? selectionAnchorKey : targetKey;
    const start = visibleKeys.indexOf(anchor);
    const end = visibleKeys.indexOf(targetKey);
    if (start < 0 || end < 0) return;
    const [low, high] = start <= end ? [start, end] : [end, start];
    for (let index = low; index <= high; index += 1) selectedKeys.add(visibleKeys[index]);
  }

  function updateSelectionControls(visibleKeys = []) {
    const selectedCount = selectedKeys.size;
    const selectedWithDoi = [...selectedKeys].filter((key) => Boolean(entryByKey(key)?.fields?.doi)).length;
    const actionBar = $(".ctca-manager-selection-actionbar", root);
    actionBar.hidden = selectedCount < 2;
    const updateButton = $(".ctca-manager-update-selected", root);
    const removeButton = $(".ctca-manager-remove-selected", root);
    updateButton.disabled = busy || selectedCount < 2 || selectedWithDoi === 0;
    updateButton.textContent = selectedCount >= 2
      ? `🌐 Update selected${selectedWithDoi !== selectedCount ? ` (${selectedWithDoi}/${selectedCount} with DOI)` : ` (${selectedCount})`}`
      : "🌐 Update selected";
    removeButton.disabled = busy || selectedCount < 2;
    removeButton.textContent = selectedCount >= 2 ? `Remove selected (${selectedCount})` : "Remove selected";

    const selectVisible = $(".ctca-manager-select-visible-checkbox", root);
    const selectedVisible = visibleKeys.filter((key) => selectedKeys.has(key)).length;
    selectVisible.checked = visibleKeys.length > 0 && selectedVisible === visibleKeys.length;
    selectVisible.indeterminate = selectedVisible > 0 && selectedVisible < visibleKeys.length;
    selectVisible.disabled = busy || visibleKeys.length === 0;
  }

  function updateListSelectionState(visibleKeys, previousSelectedKeys, previousActiveKey) {
    const affectedKeys = new Set([
      ...(previousSelectedKeys || []),
      ...selectedKeys,
      previousActiveKey,
      selectedKey
    ]);
    const list = $(".ctca-manager-list", root);
    affectedKeys.forEach((key) => {
      if (!key) return;
      const row = list.querySelector(`.ctca-manager-row[data-manager-record-id="${CSS.escape(key)}"]`);
      if (!row) return;
      const selected = selectedKeys.has(key);
      row.classList.toggle("ctca-manager-row-active", selectedKeys.has(key) && selectedKey === key);
      row.classList.toggle("ctca-manager-row-selected", selected);
      row.setAttribute("aria-selected", selected ? "true" : "false");
      const checkbox = $(".ctca-manager-row-checkbox", row);
      if (checkbox) checkbox.checked = selected;
    });
    updateSelectionControls(visibleKeys);
    updateCount(visibleKeys.length);
  }

  function managerRowTitleAndPublication(title, publicationText, publicationHtml, condensedAuthor) {
    const compact = !columnVisibility.authors && columnVisibility.title;
    const publication = `
      <span class="ctca-manager-row-publication${compact ? " ctca-manager-row-publication-inline" : ""}" title="${escapeHtml(publicationText)}">
        ${columnVisibility.authors ? "" : `<span class="ctca-manager-condensed-author-citation"><button type="button" class="ctca-manager-condensed-author" title="Show full authors">${escapeHtml(condensedAuthor)}</button>,</span>`}
        ${publicationHtml}
      </span>`;
    const titleCell = compact
      ? `<span class="ctca-manager-row-title ctca-manager-row-cell ctca-manager-row-title-publication-stack">
          <span class="ctca-manager-row-title-text" title="${escapeHtml(title)}">${latexHtml(title)}</span>
          ${publication}
        </span>`
      : `<span class="ctca-manager-row-title ctca-manager-row-cell" title="${escapeHtml(title)}">${latexHtml(title)}</span>`;
    return {
      compact,
      titleCell,
      trailingPublication: compact ? "" : publication
    };
  }

  function listDisplayChainIconHtml() {
    return `<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M6.2 10.1 5 11.3a2.5 2.5 0 0 1-3.5-3.6l2.2-2.2a2.5 2.5 0 0 1 3.5 0M9.8 5.9 11 4.7a2.5 2.5 0 0 1 3.5 3.6l-2.2 2.2a2.5 2.5 0 0 1-3.5 0M5.8 10.2l4.4-4.4" fill="none" stroke="currentColor" stroke-linecap="round" stroke-width="1.5"/></svg>`;
  }

  function listDisplayNoteIconHtml(pdf = false) {
    return pdf
      ? `<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 1.8h7l3 3v9.4H3zM10 1.8v3h3M5.2 8h5.6M5.2 10.4h4.2" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="1.3"/></svg>`
      : `<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2.5 2.3h11v8.2h-6L4.3 13v-2.5H2.5zM5 5.3h6M5 7.7h4.5" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="1.35"/></svg>`;
  }

  function managerRowDisplayToggleHtml(entry) {
    const hasCrosslinks = normalizeCrosslinkKeys(entry.crosslinks, entry.key).length > 0;
    const hasEntryNotes = Boolean(stripBibValue(entry.fields?.note || "") || normalizeCommentItems(entry.comments).some((comment) => comment.text));
    return `<span class="ctca-manager-row-display-toggles">
      ${hasCrosslinks ? `<button type="button" class="ctca-manager-row-display-toggle${listDisplayOptions.crosslinks ? " ctca-manager-row-display-toggle-active" : ""}" data-manager-list-display-toggle="crosslinks" aria-pressed="${listDisplayOptions.crosslinks}" title="${listDisplayOptions.crosslinks ? "Hide" : "Show"} cross-referenced entries in the list">${listDisplayChainIconHtml()}</button>` : ""}
      ${hasEntryNotes ? `<button type="button" class="ctca-manager-row-display-toggle${listDisplayOptions.entryNotes ? " ctca-manager-row-display-toggle-active" : ""}" data-manager-list-display-toggle="entryNotes" aria-pressed="${listDisplayOptions.entryNotes}" title="${listDisplayOptions.entryNotes ? "Hide" : "Show"} notes and comments in the list">${listDisplayNoteIconHtml()}</button>` : ""}
      <span class="ctca-manager-row-pdf-notes-toggle-slot"></span>
    </span>`;
  }

  function activeManagerTagFilterSet() {
    return new Set(
      globalThis.CollabTeXSearchTools.activeTagFilters(query)
        .map((tag) => tag.toLocaleLowerCase())
    );
  }

  function managerRowTagsHtml(entry) {
    const activeTags = activeManagerTagFilterSet();
    const tags = globalThis.CollabTeXSearchTools.splitTags(entry.tags || entry.fields?.ctca_tags || "");
    if (!tags.length) return "";
    return `<span class="ctca-manager-row-tags" aria-label="Tags">${tags.map((tag) => {
      const selected = activeTags.has(tag.toLocaleLowerCase());
      return `<button type="button" class="ctca-manager-row-tag${selected ? " ctca-manager-row-tag-selected" : ""}" data-manager-list-tag="${escapeHtml(tag)}" aria-pressed="${selected ? "true" : "false"}" title="${selected ? "Remove" : "Filter by"} tag ${escapeHtml(tag)}">${escapeHtml(tag)}</button>`;
    }).join("")}<button type="button" class="ctca-manager-row-tag ctca-manager-row-tag-overflow" title="Show all tags in details" aria-label="Show all tags in details" hidden>...</button></span>`;
  }

  function fitManagerRowTags(row) {
    const container = row.querySelector(".ctca-manager-row-tags");
    const overflow = container?.querySelector(".ctca-manager-row-tag-overflow");
    if (!container || !overflow) return;
    const chips = [...container.querySelectorAll(".ctca-manager-row-tag[data-manager-list-tag]")];
    chips.forEach((chip) => { chip.hidden = false; });
    overflow.hidden = true;
    const gap = Number.parseFloat(getComputedStyle(container).columnGap) || 0;
    const chipWidths = chips.map((chip) => chip.getBoundingClientRect().width);
    const totalChipWidth = chipWidths.reduce((sum, width) => sum + width, 0) + gap * Math.max(0, chips.length - 1);
    const availableWidth = container.clientWidth;
    if (totalChipWidth <= availableWidth + 1) return;
    overflow.hidden = false;
    overflow.style.visibility = "hidden";
    const overflowWidth = overflow.getBoundingClientRect().width;
    overflow.style.removeProperty("visibility");
    let usedWidth = overflowWidth;
    let ranOutOfSpace = false;
    for (let index = 0; index < chips.length; index += 1) {
      const nextWidth = chipWidths[index] + gap;
      const fits = !ranOutOfSpace && usedWidth + nextWidth <= availableWidth + 1;
      chips[index].hidden = !fits;
      if (fits) usedWidth += nextWidth;
      else ranOutOfSpace = true;
    }
  }

  function toggleManagerListTag(tag) {
    window.clearTimeout(searchRenderTimer);
    searchRenderTimer = null;
    query = globalThis.CollabTeXSearchTools.toggleTagFilter(query, tag);
    const searchInput = $(".ctca-manager-search", root);
    searchInput.value = query;
    $(".ctca-manager-search-clear", root).hidden = !query;
    renderList();
    searchInput.focus();
  }

  function virtualListRowHeight() {
    return columnVisibility.authors ? 78 : 60;
  }

  function rebuildVirtualListOffsets() {
    const offsets = [0];
    for (const height of virtualListState.rowHeights) {
      offsets.push(offsets[offsets.length - 1] + height);
    }
    virtualListState.rowOffsets = offsets;
  }

  function virtualListIndexAtOffset(offset) {
    const count = virtualListState.entries.length;
    if (!count) return 0;
    const offsets = virtualListState.rowOffsets;
    let low = 0;
    let high = count;
    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      if (offsets[middle + 1] <= offset) low = middle + 1;
      else high = middle;
    }
    return Math.min(count - 1, low);
  }

  function virtualListSpacer(height) {
    const spacer = document.createElement("div");
    spacer.className = "ctca-manager-virtual-spacer";
    spacer.style.height = `${Math.max(0, height)}px`;
    spacer.setAttribute("aria-hidden", "true");
    return spacer;
  }

  function measureVirtualListRows(mounted, topSpacer, bottomSpacer) {
    let changed = false;
    for (const { row, index } of mounted) {
      const height = Math.max(virtualListState.estimatedRowHeight, Math.ceil(row.getBoundingClientRect().height));
      if (height === virtualListState.rowHeights[index]) continue;
      virtualListState.rowHeights[index] = height;
      changed = true;
    }
    if (!changed) return;
    rebuildVirtualListOffsets();
    const offsets = virtualListState.rowOffsets;
    const totalHeight = offsets[offsets.length - 1] || 0;
    topSpacer.style.height = `${offsets[virtualListState.start] || 0}px`;
    bottomSpacer.style.height = `${Math.max(0, totalHeight - (offsets[virtualListState.end] || totalHeight))}px`;
  }

  function createManagerListRow(entry, visibleKeys, position, total) {
    const row = document.createElement("div");
    row.className = "ctca-manager-row";
    row.dataset.managerRecordId = entry.key;
    row.setAttribute("role", "option");
    row.setAttribute("tabindex", "0");
    row.setAttribute("aria-selected", selectedKeys.has(entry.key) ? "true" : "false");
    row.setAttribute("aria-posinset", String(position + 1));
    row.setAttribute("aria-setsize", String(total));
    row.draggable = true;
    row.classList.toggle("ctca-manager-row-active", selectedKeys.has(entry.key) && selectedKey === entry.key);
    row.classList.toggle("ctca-manager-row-selected", selectedKeys.has(entry.key));
    row.classList.toggle("ctca-manager-row-authors-hidden", !columnVisibility.authors);

    const title = entry.fields?.title || "Untitled reference";
    const authors = allAuthors(entry);
    const year = entry.fields?.year || "";
    const journal = publication(entry);
    const volume = entry.fields?.volume || "";
    const pages = entry.fields?.pages || "";
    const addedOn = formatAddedOn(entry.addedOn);
    const publicationLeadText = [journal, volume].filter(Boolean).join(" ");
    const publicationBaseText = `${publicationLeadText}${pages ? `${publicationLeadText ? ", " : ""}${pages}` : ""}` || "Publication not specified";
    const publicationText = `${publicationBaseText}${!columnVisibility.year && year ? ` (${year})` : ""}`;
    const publicationLeadHtml = [
      journal ? `<i>${escapeHtml(journal)}</i>` : "",
      volume ? `<strong>${escapeHtml(volume)}</strong>` : ""
    ].filter(Boolean).join(" ");
    const publicationBaseHtml = `${publicationLeadHtml}${pages ? `${publicationLeadHtml ? ", " : ""}${escapeHtml(pages)}` : ""}` || "Publication not specified";
    const publicationHtml = `<span class="ctca-manager-publication-text">${publicationBaseHtml}${!columnVisibility.year && year ? ` (${escapeHtml(year)})` : ""}</span>${managerRowDisplayToggleHtml(entry)}${managerRowTagsHtml(entry)}`;
    const specifiedUrl = specifiedHttpUrl(entry);
    const doiSynchronized = wasUpdatedFromDoi(entry);
    const doiSyncTitle = doiSynchronized
      ? `${entry.doiSyncedAt ? `DOI synchronized ${entry.doiSyncedAt}` : "DOI synchronized"}. `
      : "";
    const urlGlobe = specifiedUrl
      ? `<button type="button" class="ctca-manager-row-doi-sync${doiSynchronized ? " ctca-manager-row-doi-synced" : ""}" title="${escapeHtml(`${doiSyncTitle}Open ${specifiedUrl}`)}" aria-label="${escapeHtml(`Open URL for ${entry.key}`)}">${urlGlobeIconHtml()}</button>`
      : `<span class="ctca-manager-row-doi-sync ctca-manager-row-doi-placeholder" aria-hidden="true">${urlGlobeIconHtml()}</span>`;
    const condensedAuthor = abbreviatedFirstAuthor(entry);
    const titleAndPublication = managerRowTitleAndPublication(title, publicationText, publicationHtml, condensedAuthor);
    row.classList.toggle("ctca-manager-row-publication-compact", titleAndPublication.compact);
    const cells = [];
    if (columnVisibility.title) cells.push(titleAndPublication.titleCell);
    if (columnVisibility.year) cells.push(`<span class="ctca-manager-row-year ctca-manager-row-cell" title="${escapeHtml(year)}">${escapeHtml(year)}</span>`);
    if (columnVisibility.key) cells.push(`
      <span class="ctca-manager-row-meta ctca-manager-row-cell">
        <span class="ctca-manager-row-link-actions">
          ${urlGlobe}
          <span class="ctca-manager-row-pdf-slot"></span>
        </span>
        <span class="ctca-manager-row-key" title="${escapeHtml(entry.key)}">${escapeHtml(entry.key)}</span>
      </span>`);
    if (managerColumnVisible("addedOn")) cells.push(`<span class="ctca-manager-row-added ctca-manager-row-cell" title="${escapeHtml(addedOn)}">${escapeHtml(addedOn)}</span>`);
    row.innerHTML = `
      <button type="button" class="ctca-manager-row-star" title="${entry.starred ? "Remove star" : "Star entry"}" aria-label="${entry.starred ? "Remove star from" : "Star"} ${escapeHtml(entry.key)}" aria-pressed="${entry.starred ? "true" : "false"}">${entry.starred ? "★" : "☆"}</button>
      <span class="ctca-manager-row-select"><input type="checkbox" class="ctca-manager-row-checkbox" aria-label="Select ${escapeHtml(entry.key)}" ${selectedKeys.has(entry.key) ? "checked" : ""}></span>
      ${cells.join("")}
      ${columnVisibility.authors ? `<span class="ctca-manager-row-author" title="${escapeHtml(authors)}"><span class="ctca-manager-row-author-text">${latexHtml(authors)}</span><button type="button" class="ctca-manager-author-eye" title="Hide authors" aria-label="Hide authors">👁</button></span>` : ""}
      ${titleAndPublication.trailingPublication}
      <div class="ctca-manager-row-supplemental" hidden></div>
    `;
    updateManagerRowSupplemental(row, entry, []);

    const activate = (event) => {
      crosslinkNavigationStack = [];
      detailOnlyKey = "";
      const previousSelectedKeys = new Set(selectedKeys);
      const previousActiveKey = selectedKey;
      if (event.shiftKey) {
        selectRange(visibleKeys, entry.key);
      } else if (event.ctrlKey || event.metaKey) {
        if (selectedKeys.has(entry.key)) selectedKeys.delete(entry.key);
        else selectedKeys.add(entry.key);
        selectionAnchorKey = entry.key;
      } else {
        selectedKeys = new Set([entry.key]);
        selectionAnchorKey = entry.key;
      }
      selectedKey = entry.key;
      updateListSelectionState(visibleKeys, previousSelectedKeys, previousActiveKey);
      renderDetails();
    };

    row.addEventListener("click", (event) => {
      if (event.target.closest(".ctca-manager-row-checkbox, .ctca-manager-row-star, .ctca-manager-row-doi-sync, .ctca-manager-row-pdf-action, .ctca-manager-row-display-toggle, .ctca-manager-author-eye, .ctca-manager-condensed-author, .ctca-manager-row-tag")) return;
      activate(event);
    });
    row.addEventListener("contextmenu", (event) => {
      showEntryContextMenu(event, entry).catch((error) => {
        hideEntryContextMenu();
        setStatus(error?.message || String(error), true);
      });
    });
    row.addEventListener("keydown", (event) => {
      if (event.target.closest(".ctca-manager-row-doi-sync, .ctca-manager-row-pdf-action, .ctca-manager-row-display-toggle, .ctca-manager-row-tag")) return;
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      activate(event);
    });
    $(".ctca-manager-row-checkbox", row).addEventListener("click", (event) => {
      event.stopPropagation();
      crosslinkNavigationStack = [];
      detailOnlyKey = "";
      const previousSelectedKeys = new Set(selectedKeys);
      const previousActiveKey = selectedKey;
      if (event.target.checked) selectedKeys.add(entry.key);
      else selectedKeys.delete(entry.key);
      selectedKey = entry.key;
      selectionAnchorKey = entry.key;
      updateListSelectionState(visibleKeys, previousSelectedKeys, previousActiveKey);
      renderDetails();
    });
    $(".ctca-manager-row-star", row).addEventListener("click", (event) => {
      event.stopPropagation();
      if (isReadOnlySharedEntry(entry.key)) {
        setStatus("This shared entry is read-only. Its citation key may still be changed locally.", true);
        return;
      }
      entry.starred = !entry.starred;
      entry.updatedAt = new Date().toISOString();
      markDirty(entry.starred ? "Starring entry…" : "Removing star…");
      renderCategories();
      renderList();
    });
    $("button.ctca-manager-row-doi-sync", row)?.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      window.open(specifiedUrl, "_blank", "noopener,noreferrer");
    });
    $(".ctca-manager-author-eye", row)?.addEventListener("click", (event) => {
      event.stopPropagation();
      setColumnVisible("authors", false);
    });
    $(".ctca-manager-condensed-author", row)?.addEventListener("click", (event) => {
      event.stopPropagation();
      setColumnVisible("authors", true);
    });
    row.querySelectorAll(".ctca-manager-row-tag").forEach((button) => {
      if (button.classList.contains("ctca-manager-row-tag-overflow")) return;
      button.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        toggleManagerListTag(button.dataset.managerListTag || "");
      });
    });
    row.querySelectorAll("[data-manager-list-display-toggle]").forEach((button) => {
      button.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        const option = button.dataset.managerListDisplayToggle;
        setListDisplayOption(option, !listDisplayOptions[option]);
      });
    });
    row.querySelector(".ctca-manager-row-tag-overflow")?.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      detailOnlyKey = "";
      const previousSelectedKeys = new Set(selectedKeys);
      const previousActiveKey = selectedKey;
      selectedKeys = new Set([entry.key]);
      selectedKey = entry.key;
      selectionAnchorKey = entry.key;
      bibliographyDetailsCollapsed = false;
      updateListSelectionState(visibleKeys, previousSelectedKeys, previousActiveKey);
      renderDetails();
      requestAnimationFrame(() => {
        const tagInput = $(".ctca-manager-details .ctca-tag-input", root);
        const tagSection = tagInput?.closest(".ctca-manager-tags");
        tagSection?.scrollIntoView({ block: "start", behavior: "smooth" });
        tagInput?.focus({ preventScroll: true });
      });
    });
    row.addEventListener("dragstart", (event) => {
      if (!selectedKeys.has(entry.key)) {
        selectedKeys = new Set([entry.key]);
        selectedKey = entry.key;
        selectionAnchorKey = entry.key;
      }
      const keys = [...selectedKeys];
      event.dataTransfer.effectAllowed = "copy";
      event.dataTransfer.setData("application/x-ctca-entry-keys", JSON.stringify(keys));
      row.classList.add("ctca-manager-row-dragging");
    });
    row.addEventListener("dragend", () => row.classList.remove("ctca-manager-row-dragging"));
    bindPdfDropTarget(row, entry);
    return row;
  }

  function updateMountedRowAttachments() {
    if (!virtualListState.attachmentsByKey) return;
    const list = $(".ctca-manager-list", root);
    list.querySelectorAll(".ctca-manager-row[data-manager-record-id]").forEach((row) => {
      const entry = virtualListState.entryByKey.get(row.dataset.managerRecordId || "");
      if (entry) updateRowPdfAction(row, entry, virtualListState.attachmentsByKey.get(entry.key) || []);
    });
    window.requestAnimationFrame(() => renderVirtualListWindow(true));
  }

  function renderVirtualListWindow(force = false) {
    const list = $(".ctca-manager-list", root);
    const visible = virtualListState.entries;
    if (!visible.length) return;
    const viewportHeight = Math.max(list.clientHeight, virtualListState.estimatedRowHeight * 6);
    const start = Math.max(0, virtualListIndexAtOffset(list.scrollTop) - VIRTUAL_LIST_OVERSCAN);
    const end = Math.min(
      visible.length,
      virtualListIndexAtOffset(list.scrollTop + viewportHeight) + 1 + VIRTUAL_LIST_OVERSCAN
    );
    if (!force && start === virtualListState.start && end === virtualListState.end) return;
    virtualListState.start = start;
    virtualListState.end = end;

    const offsets = virtualListState.rowOffsets;
    const totalHeight = offsets[offsets.length - 1] || 0;
    const fragment = document.createDocumentFragment();
    const topSpacer = virtualListSpacer(offsets[start] || 0);
    fragment.appendChild(topSpacer);
    const mounted = [];
    const openAlexDescriptors = [];
    for (let index = start; index < end; index += 1) {
      const entry = visible[index];
      const row = createManagerListRow(entry, virtualListState.visibleKeys, index, visible.length);
      mounted.push({ row, entry, index });
      fragment.appendChild(row);
      const descriptor = globalThis.SmartCitationsOpenAlex.descriptor(entry, entry.key);
      if (descriptor.identity) openAlexDescriptors.push(descriptor);
    }
    const bottomSpacer = virtualListSpacer(Math.max(0, totalHeight - (offsets[end] || totalHeight)));
    fragment.appendChild(bottomSpacer);
    list.replaceChildren(fragment);
    mounted.forEach(({ row }) => fitManagerRowTags(row));
    if (virtualListState.attachmentsByKey) {
      mounted.forEach(({ row, entry }) => {
        updateRowPdfAction(row, entry, virtualListState.attachmentsByKey.get(entry.key) || []);
      });
    }
    measureVirtualListRows(mounted, topSpacer, bottomSpacer);
    syncPdfAttachmentLoadingIndicators();
    globalThis.SmartCitationsOpenAlex.hydrateCitations(list, openAlexDescriptors).catch(() => {});
  }

  function scheduleVirtualListWindow() {
    if (virtualListFrame !== null) return;
    virtualListFrame = window.requestAnimationFrame(() => {
      virtualListFrame = null;
      renderVirtualListWindow();
    });
  }

  function loadVisibleRowAttachments(visible, revision) {
    globalThis.CollabTeXAttachmentStore.listMany(visible).then((attachmentsByKey) => {
      if (revision !== virtualListState.revision) return;
      virtualListState.attachmentsByKey = attachmentsByKey;
      updateMountedRowAttachments();
    }).catch(() => {
      if (revision !== virtualListState.revision) return;
      virtualListState.attachmentsByKey = new Map();
      updateMountedRowAttachments();
    });
  }

  function renderList() {
    applyManagerTableColumns();
    const list = $(".ctca-manager-list", root);
    const visible = filteredEntries();
    const visibleKeys = visible.map((entry) => entry.key);
    selectedKeys = new Set([...selectedKeys].filter((key) => entries.some((entry) => entry.key === key)));
    if (!selectedKeys.size) selectedKey = "";
    else if (!selectedKeys.has(selectedKey)) selectedKey = selectedKeys.values().next().value || "";

    root.querySelectorAll("[data-manager-sort]").forEach((button) => {
      const active = button.dataset.managerSort === (selectedCategoryId === "recent" ? "addedOn" : sortState.field);
      button.classList.toggle("ctca-manager-sort-active", active);
      $("span", button).textContent = active ? (sortState.direction === "asc" ? "↑" : "↓") : "↕";
    });
    const starSort = $(".ctca-manager-star-sort", root);
    starSort.setAttribute("aria-pressed", starredFirst ? "true" : "false");
    starSort.textContent = starredFirst ? "★" : "☆";
    $(".ctca-global-empty", root).hidden = entries.length !== 0;

    const revision = virtualListState.revision + 1;
    const estimatedRowHeight = virtualListRowHeight();
    virtualListState = {
      entries: visible,
      visibleKeys,
      entryByKey: new Map(visible.map((entry) => [entry.key, entry])),
      attachmentsByKey: null,
      estimatedRowHeight,
      rowHeights: visible.map(() => estimatedRowHeight),
      rowOffsets: [0],
      start: -1,
      end: -1,
      revision
    };
    rebuildVirtualListOffsets();
    list.style.setProperty("--ctca-manager-virtual-row-height", `${estimatedRowHeight}px`);
    if (!visible.length) {
      list.classList.remove("ctca-manager-list-virtualized");
      list.replaceChildren();
      if (entries.length) {
        const empty = document.createElement("div");
        empty.className = "ctca-manager-empty-list";
        empty.textContent = "No entries match this search or category.";
        list.appendChild(empty);
      }
    } else {
      list.classList.add("ctca-manager-list-virtualized");
      const totalHeight = virtualListState.rowOffsets[virtualListState.rowOffsets.length - 1] || 0;
      const maximumScrollTop = Math.max(0, totalHeight - list.clientHeight);
      if (list.scrollTop > maximumScrollTop) list.scrollTop = maximumScrollTop;
      renderVirtualListWindow(true);
      loadVisibleRowAttachments(visible, revision);
    }

    updateSelectionControls(visibleKeys);
    updateCount(visible.length);
    renderDetails();
    syncManagerTableHeader();
  }

  function managerInput(label, field, value, options = {}) {
    const wide = options.wide ? " ctca-manager-field-wide" : "";
    const autocomplete = options.autocomplete
      ? ` data-manager-autocomplete="${escapeHtml(options.autocomplete)}" autocomplete="off"`
      : "";
    const input = options.multiline
      ? `<textarea data-manager-field="${escapeHtml(field)}" rows="${options.rows || 3}"${autocomplete}>${escapeHtml(value || "")}</textarea>`
      : `<input data-manager-field="${escapeHtml(field)}" value="${escapeHtml(value || "")}"${autocomplete}>`;
    const control = options.autocomplete
      ? `<span class="ctca-field-completion-wrap">${input}<span class="ctca-field-completion" hidden role="listbox"></span></span>`
      : input;
    return `<label class="ctca-manager-field${wide}"><span>${escapeHtml(label)}</span>${control}</label>`;
  }

  function bindPdfDropTarget(target, entry) {
    if (!target || !entry) return;
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
      selectedKey = entry.key;
      selectedKeys = new Set([entry.key]);
      openAddPdfDialog(entry, { files }).catch((error) => setStatus(error?.message || String(error), true));
    });
  }

  function availableFields(entry) {
    const existing = new Set(Object.keys(entry.fields || {}));
    return AVAILABLE_FIELDS.filter((field) => !existing.has(field));
  }

  function paperUrl(entry) {
    const doi = String(entry.fields?.doi || "").trim();
    if (doi) return `https://doi.org/${encodeURIComponent(doi)}`;
    const url = String(entry.fields?.url || "").trim();
    return /^https?:\/\//i.test(url) ? url : "";
  }

  function specifiedHttpUrl(entry) {
    const value = stripBibValue(entry?.fields?.url || "");
    if (!value) return "";
    try {
      const url = new URL(value);
      return /^https?:$/.test(url.protocol) ? url.href : "";
    } catch (_error) {
      return "";
    }
  }

  function formattedCitationParts(entry) {
    const authors = globalThis.CollabTeXBibTeX.splitAuthorsRaw(entry?.fields?.author || "");
    const authorText = authors.slice(0, 3).map((author) => {
      const formatted = globalThis.CollabTeXBibTeX.formatAuthorName(author);
      const family = globalThis.CollabTeXBibTeX.authorFamilyName(author);
      const given = formatted.slice(0, Math.max(0, formatted.lastIndexOf(family))).trim();
      const initial = globalThis.CollabTeXBibTeX.latexToText(given).match(/\p{L}/u)?.[0] || "";
      return `${initial ? `${initial}. ` : ""}${family || formatted}`.trim();
    }).filter(Boolean).join(", ") + (authors.length > 3 ? " et al." : "");
    const fields = entry?.fields || {};
    return {
      authors: authorText || "Unknown author",
      title: globalThis.CollabTeXBibTeX.latexToText(fields.title || "Untitled"),
      journal: globalThis.CollabTeXBibTeX.latexToText(fields.journal || fields.journaltitle || fields.booktitle || ""),
      number: globalThis.CollabTeXBibTeX.latexToText(fields.volume || fields.number || ""),
      pages: globalThis.CollabTeXBibTeX.latexToText(fields.pages || ""),
      year: globalThis.CollabTeXBibTeX.latexToText(fields.year || "")
    };
  }

  async function copyTextWithFormatting(plainText, htmlText = "") {
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

  function formattedCitationContent(entry) {
    const parts = formattedCitationParts(entry);
    const journalPlain = parts.journal ? `, ${parts.journal}` : "";
    const numberPlain = parts.number ? ` ${parts.number}` : "";
    const pagesPlain = parts.pages ? `, ${parts.pages}` : "";
    const yearPlain = parts.year ? ` (${parts.year})` : "";
    const plain = `${parts.authors}, ${parts.title}${journalPlain}${numberPlain}${pagesPlain}${yearPlain}`;
    const journalHtml = parts.journal ? `, <i>${escapeHtml(parts.journal)}</i>` : "";
    const numberHtml = parts.number ? ` <b>${escapeHtml(parts.number)}</b>` : "";
    const pagesHtml = parts.pages ? `, ${escapeHtml(parts.pages)}` : "";
    const yearHtml = parts.year ? ` (${escapeHtml(parts.year)})` : "";
    const html = `${escapeHtml(parts.authors)}, ${escapeHtml(parts.title)}${journalHtml}${numberHtml}${pagesHtml}${yearHtml}`;
    return { plain, html };
  }

  async function copyFormattedCitation(entry) {
    const citation = formattedCitationContent(entry);
    await copyTextWithFormatting(citation.plain, citation.html);
  }

  function downloadTextFile(text, fileName, type = "text/plain;charset=utf-8") {
    const url = URL.createObjectURL(new Blob([text], { type }));
    const link = document.createElement("a");
    link.href = url;
    link.download = fileName;
    link.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function hideCategoryContextMenu() {
    const menu = $(".ctca-category-context-menu", root);
    if (!menu) return;
    menu.hidden = true;
    delete menu.dataset.categoryId;
    delete menu.dataset.pointerEntered;
  }

  function hideEntryContextMenu() {
    const menu = $(".ctca-entry-context-menu", root);
    if (!menu) return;
    menu.hidden = true;
    menu.replaceChildren();
    delete menu.dataset.entryKey;
    delete menu.dataset.pointerEntered;
  }

  async function showEntryContextMenu(event, entry) {
    event.preventDefault();
    event.stopPropagation();
    hideCategoryContextMenu();
    const preserveMultiple = selectedKeys.size > 1 && selectedKeys.has(entry.key);
    if (!preserveMultiple) selectedKeys = new Set([entry.key]);
    selectedKey = entry.key;
    selectionAnchorKey = entry.key;
    renderList();
    renderDetails();

    const menu = $(".ctca-entry-context-menu", root);
    menu.dataset.entryKey = entry.key;
    delete menu.dataset.pointerEntered;
    menu.onpointerenter = () => { menu.dataset.pointerEntered = "true"; };
    menu.onpointerleave = () => {
      if (menu.dataset.pointerEntered === "true") hideEntryContextMenu();
    };
    menu.innerHTML = `<button type="button" disabled>Loading actions…</button>`;
    menu.style.left = `${Math.max(8, Math.min(event.clientX, window.innerWidth - 265))}px`;
    menu.style.top = `${Math.max(8, Math.min(event.clientY, window.innerHeight - 390))}px`;
    menu.hidden = false;

    const contextEntries = entries.filter((candidate) => selectedKeys.has(candidate.key));
    const readOnlyContext = contextEntries.some((candidate) => isReadOnlySharedEntry(candidate.key));
    const multiple = contextEntries.length > 1;
    const attachments = multiple ? [] : await globalThis.CollabTeXAttachmentStore.list(entry);
    if (menu.dataset.entryKey !== entry.key) return;
    const url = specifiedHttpUrl(entry);
    const actions = multiple ? [
      { action: "update-dois", label: "Update from DOIs" },
      { action: "copy-keys", label: "Copy citation keys" },
      { action: "copy-formatted-many", label: "Copy as formatted citations" },
      { action: "star-many", label: "Star" },
      { action: "download-bib-many", label: "Download BibTeX entries" },
      { action: "delete-many", label: "Delete", danger: true }
    ] : [
      ...(url ? [{ action: "visit-url", label: "Visit URL" }] : []),
      ...(normalizeDoi(entry.fields?.doi || "") ? [{ action: "update-doi", label: "Update entry from DOI" }] : []),
      ...(!attachments.length ? [{ action: "get-pdf-from-web", label: "Download attachment from web" }] : []),
      ...(attachments.length ? [{ action: "open-pdf", label: "Open PDF", attachmentId: attachments[0].id }] : []),
      { action: "star", label: entry.starred ? "Unstar" : "Star" },
      { action: "copy-key", label: "Copy citation key" },
      { action: "copy-formatted", label: "Copy as formatted citation" },
      { action: "download-bib", label: "Download BibTeX entry" },
      { action: "delete", label: "Delete", danger: true }
    ];
    menu.innerHTML = actions.map((item) =>
      `<button type="button" role="menuitem" data-entry-context-action="${item.action}"${item.attachmentId ? ` data-attachment-id="${escapeHtml(item.attachmentId)}"` : ""}${item.danger ? ` class="ctca-entry-context-danger"` : ""}>${escapeHtml(item.label)}</button>`
    ).join("");
    menu.onclick = async (clickEvent) => {
      const button = clickEvent.target.closest("[data-entry-context-action]");
      if (!button) return;
      const action = button.dataset.entryContextAction;
      hideEntryContextMenu();
      try {
        if (readOnlyContext && !/^(?:visit|open|download|copy)/.test(action)) {
          setStatus("Read-only shared entries cannot be changed.", true);
          return;
        }
        if (action === "update-dois") {
          await updateEntriesFromDoi(contextEntries, { showBatchConfirmation: true });
        } else if (action === "copy-keys") {
          await copyTextWithFormatting(contextEntries.map((item) => item.key).join("\n"));
          setStatus(`Copied ${contextEntries.length} citation keys.`);
        } else if (action === "copy-formatted-many") {
          const citations = contextEntries.map(formattedCitationContent);
          await copyTextWithFormatting(
            citations.map((citation) => citation.plain).join("\n"),
            citations.map((citation) => `<div>${citation.html}</div>`).join("")
          );
          setStatus(`Copied ${contextEntries.length} formatted citations.`);
        } else if (action === "star-many") {
          for (const item of contextEntries) {
            item.starred = true;
            item.updatedAt = new Date().toISOString();
          }
          markDirty(`Starring ${contextEntries.length} selected entriesâ€¦`);
          renderAll();
        } else if (action === "download-bib-many") {
          downloadTextFile(
            `${contextEntries.map((item) => exportBibEntry(item)).join("\n\n")}\n`,
            "selected-bibliography-entries.bib",
            "application/x-bibtex;charset=utf-8"
          );
        } else if (action === "delete-many") {
          await removeSelected();
        } else if (action === "visit-url") window.open(url, "_blank", "noopener,noreferrer");
        else if (action === "star") {
          entry.starred = !entry.starred;
          entry.updatedAt = new Date().toISOString();
          markDirty(entry.starred ? "Starring entry…" : "Removing star…");
          renderAll();
        } else if (action === "copy-key") {
          await copyTextWithFormatting(entry.key);
          setStatus(`Copied ${entry.key}.`);
        } else if (action === "copy-formatted") {
          await copyFormattedCitation(entry);
          setStatus(`Copied formatted citation for ${entry.key}.`);
        } else if (action === "download-bib") {
          downloadTextFile(`${exportBibEntry(entry)}\n`, `${entry.key}.bib`, "application/x-bibtex;charset=utf-8");
        } else {
          const syntheticButton = document.createElement("button");
          syntheticButton.dataset.managerAction = action === "delete" ? "remove-entry" : action;
          if (button.dataset.attachmentId) syntheticButton.dataset.attachmentId = button.dataset.attachmentId;
          await detailActionClicked({ target: syntheticButton, preventDefault() {} });
        }
      } catch (error) {
        setStatus(error?.message || String(error), true);
      }
    };
    menu.querySelector("button")?.focus();
  }

  function urlGlobeIconHtml() {
    return `<svg class="ctca-manager-row-globe-icon" viewBox="0 0 16 16" aria-hidden="true" focusable="false"><circle cx="8" cy="8" r="6.25" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M1.75 8h12.5M8 1.75C6.15 3.45 5.1 5.55 5.1 8S6.15 12.55 8 14.25M8 1.75c1.85 1.7 2.9 3.8 2.9 6.25S9.85 12.55 8 14.25" fill="none" stroke="currentColor" stroke-linecap="round" stroke-width="1.25"/></svg>`;
  }

  function paperclipIconHtml() {
    return `<svg class="ctca-manager-row-pdf-icon" viewBox="0 0 16 16" aria-hidden="true" focusable="false"><path d="M5.2 8.25 9.45 4a2.15 2.15 0 0 1 3.05 3.05l-5.4 5.4a3.25 3.25 0 0 1-4.6-4.6l5.1-5.1" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="1.45"/></svg>`;
  }

  function downloadIconHtml() {
    return `<svg class="ctca-manager-row-pdf-icon" viewBox="0 0 16 16" aria-hidden="true" focusable="false"><path d="M8 1.75v8.1m-3-3 3 3 3-3M2.25 13.5h11.5" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5"/></svg>`;
  }

  function pdfAttachmentActionIconHtml(action) {
    if (action === "open") {
      return `<svg class="ctca-manager-pdf-action-icon" viewBox="0 0 16 16" aria-hidden="true" focusable="false"><path d="M1.25 8s2.45-4.25 6.75-4.25S14.75 8 14.75 8 12.3 12.25 8 12.25 1.25 8 1.25 8Z" fill="none" stroke="currentColor" stroke-linejoin="round" stroke-width="1.5"/><circle cx="8" cy="8" r="2.15" fill="none" stroke="currentColor" stroke-width="1.5"/></svg>`;
    }
    if (action === "notes") {
      return `<svg class="ctca-manager-pdf-action-icon" viewBox="0 0 16 16" aria-hidden="true" focusable="false"><path d="M3 1.5h6.25L13 5.25V14.5H3Z" fill="none" stroke="currentColor" stroke-linejoin="round" stroke-width="1.45"/><path d="M9.25 1.5v3.75H13M5.25 8h5.5M5.25 10.5h5.5" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="1.35"/></svg>`;
    }
    if (action === "rename") {
      return `<span class="ctca-manager-pdf-action-abc" aria-hidden="true">abc</span>`;
    }
    if (action === "replace") {
      return `<svg class="ctca-manager-pdf-action-icon" viewBox="0 0 16 16" aria-hidden="true" focusable="false"><path d="M13.2 6.1A5.45 5.45 0 0 0 3.45 4.35L2.2 5.6M2.8 9.9a5.45 5.45 0 0 0 9.75 1.75l1.25-1.25" fill="none" stroke="currentColor" stroke-linecap="round" stroke-width="1.85"/><path d="M2.05 2.85 2.2 5.6l2.75-.15M13.95 13.15l-.15-2.75-2.75.15" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="1.85"/></svg>`;
    }
    return `<svg class="ctca-manager-pdf-action-icon" viewBox="0 0 16 16" aria-hidden="true" focusable="false"><path d="M2.5 4h11M6 1.75h4L10.75 4h-5.5ZM4 4l.65 10.25h6.7L12 4M6.4 6.25l.25 5.5M9.6 6.25l-.25 5.5" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="1.4"/></svg>`;
  }

  function updateRowPdfAction(row, entry, attachments) {
    if (!row?.isConnected || row.dataset.managerRecordId !== entry.key) return;
    updateManagerRowSupplemental(row, entry, attachments);
    delete row.dataset.pdfActionRequest;
    const slot = $(".ctca-manager-row-pdf-slot", row);
    if (!slot) return;
    const attachment = attachments[0];
    const sourceUrl = specifiedHttpUrl(entry);
    if (!attachment && !sourceUrl) {
      slot.replaceChildren();
      return;
    }
    const button = document.createElement("button");
    button.type = "button";
    button.className = "ctca-manager-row-pdf-action";
    if (attachment) {
      button.title = `Open attached PDF: ${attachment.name}`;
      button.setAttribute("aria-label", `Open first PDF attached to ${entry.key}`);
      button.innerHTML = paperclipIconHtml();
      button.addEventListener("click", async (event) => {
        event.preventDefault();
        event.stopPropagation();
        await openPdfTab(entry, attachment);
      });
    } else {
      button.title = `Get PDF from ${sourceUrl}`;
      button.setAttribute("aria-label", `Get PDF from the web for ${entry.key}`);
      button.innerHTML = downloadIconHtml();
      button.addEventListener("click", async (event) => {
        event.preventDefault();
        event.stopPropagation();
        await openAddPdfDialog(entry, { getFromWeb: true });
      });
    }
    slot.replaceChildren(button);
  }

  function allKnownTags(exceptKey = "") {
    const seen = new Map();
    for (const item of entries) {
      if (item.key === exceptKey) continue;
      for (const tag of globalThis.CollabTeXSearchTools.splitTags(item.tags || [])) {
        const key = tag.toLocaleLowerCase();
        if (!seen.has(key)) seen.set(key, tag);
      }
    }
    return [...seen.values()].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));
  }

  function setInlineCompletionHint(input, completionValue, typedValue, hostSelector) {
    const host = hostSelector ? input.closest(hostSelector) : input.parentElement;
    host?.querySelector(":scope > .ctca-inline-completion-hint")?.remove();
    input.classList.remove("ctca-inline-completion-active");
    if (input.dataset.skipInlineCompletionOnce === "true") {
      delete input.dataset.skipInlineCompletionOnce;
      return false;
    }
    const candidate = String(completionValue || "");
    const typed = String(typedValue || "");
    if (
      !candidate ||
      !typed ||
      candidate.length <= typed.length ||
      !candidate.toLocaleLowerCase().startsWith(typed.toLocaleLowerCase()) ||
      input.selectionStart !== input.selectionEnd
    ) return false;
    const caret = input.selectionStart;
    const start = caret - typed.length;
    if (start < 0 || input.value.slice(start, caret).toLocaleLowerCase() !== typed.toLocaleLowerCase()) return false;
    input.setRangeText(candidate, start, caret, "end");
    input.setSelectionRange(start + typed.length, start + candidate.length);
    input.classList.add("ctca-inline-completion-active");
    return true;
  }

  function acceptInlineCompletion(input) {
    if (!input?.classList.contains("ctca-inline-completion-active") || input.selectionStart === input.selectionEnd) return false;
    const end = input.selectionEnd;
    input.setSelectionRange(end, end);
    input.classList.remove("ctca-inline-completion-active");
    input.dataset.skipInlineCompletionOnce = "true";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    return true;
  }

  function discardInlineCompletion(input) {
    if (!input?.classList.contains("ctca-inline-completion-active") || input.selectionStart === input.selectionEnd) return false;
    input.setRangeText("", input.selectionStart, input.selectionEnd, "end");
    input.classList.remove("ctca-inline-completion-active");
    return true;
  }

  function handleInlineCompletionDeletion(event, input) {
    if (
      !["Backspace", "Delete"].includes(event.key) ||
      !input?.classList.contains("ctca-inline-completion-active") ||
      input.selectionStart === input.selectionEnd
    ) return false;

    const typedEnd = input.selectionStart;
    discardInlineCompletion(input);
    const previousCharacter = Array.from(input.value.slice(0, typedEnd)).pop() || "";
    if (previousCharacter) {
      input.setRangeText("", typedEnd - previousCharacter.length, typedEnd, "end");
    }
    event.preventDefault();
    input.dispatchEvent(new Event("input", { bubbles: true }));
    return true;
  }

  function setSearchInlineTagCompletion(input, context, tag) {
    input.classList.remove("ctca-inline-completion-active");
    if (input.dataset.skipInlineCompletionOnce === "true") {
      delete input.dataset.skipInlineCompletionOnce;
      return false;
    }
    const typed = String(context?.query || "");
    const candidate = String(tag || "");
    if (!typed || candidate.length <= typed.length || !candidate.toLocaleLowerCase().startsWith(typed.toLocaleLowerCase())) return false;
    const encoded = globalThis.CollabTeXSearchTools.quoteQueryValue(candidate);
    const typedOffset = encoded.startsWith('"') ? 1 : 0;
    if (encoded.slice(typedOffset, typedOffset + typed.length).toLocaleLowerCase() !== typed.toLocaleLowerCase()) return false;
    input.setRangeText(encoded, context.replaceStart, context.replaceEnd, "end");
    const selectionStart = context.replaceStart + typedOffset + typed.length;
    const selectionEnd = context.replaceStart + encoded.length;
    input.setSelectionRange(selectionStart, selectionEnd);
    input.classList.add("ctca-inline-completion-active");
    return true;
  }

  function renderSearchTagSuggestions(input) {
    const container = input.closest(".ctca-manager-search-input-wrap")?.querySelector(".ctca-manager-tag-search-suggestions");
    if (!container) return;
    const context = globalThis.CollabTeXSearchTools.tagCompletionContext(input.value, input.selectionStart);
    if (!context || input.selectionStart !== input.selectionEnd) {
      container.hidden = true;
      container.replaceChildren();
      setInlineCompletionHint(input, "", "", ".ctca-manager-search-input-wrap");
      return;
    }
    const typed = context.query.toLocaleLowerCase();
    const suggestions = allKnownTags()
      .filter((tag) => tag.toLocaleLowerCase() !== typed)
      .filter((tag) => !typed || tag.toLocaleLowerCase().includes(typed))
      .sort((left, right) => {
        const leftStarts = left.toLocaleLowerCase().startsWith(typed) ? 0 : 1;
        const rightStarts = right.toLocaleLowerCase().startsWith(typed) ? 0 : 1;
        return leftStarts - rightStarts || left.localeCompare(right, undefined, { sensitivity: "base" });
      })
      .slice(0, 10);
    container.innerHTML = suggestions.map((tag, index) =>
      `<button type="button" data-search-tag="${escapeHtml(tag)}" role="option"><span>${escapeHtml(tag)}</span>${index === 0 ? '<span class="ctca-completion-option-hint" title="Press Right Arrow to complete">→</span>' : ""}</button>`
    ).join("");
    container.hidden = suggestions.length === 0;
    setSearchInlineTagCompletion(input, context, suggestions[0]);
  }

  function acceptSearchTagSuggestion(input, tag) {
    discardInlineCompletion(input);
    const context = globalThis.CollabTeXSearchTools.tagCompletionContext(input.value, input.selectionStart);
    if (!context || !tag) return false;
    input.setRangeText(
      globalThis.CollabTeXSearchTools.quoteQueryValue(tag),
      context.replaceStart,
      context.replaceEnd,
      "end"
    );
    input.dispatchEvent(new Event("input", { bubbles: true }));
    const container = input.closest(".ctca-manager-search-input-wrap")?.querySelector(".ctca-manager-tag-search-suggestions");
    if (container) container.hidden = true;
    setInlineCompletionHint(input, "", "", ".ctca-manager-search-input-wrap");
    return true;
  }

  function allKnownJournals(exceptKey = "") {
    const seen = new Map();
    for (const item of entries) {
      if (item.key === exceptKey) continue;
      for (const field of ["journal", "journaltitle", "booktitle"]) {
        const value = String(item?.fields?.[field] || "").replace(/\s+/g, " ").trim();
        const key = value.toLocaleLowerCase();
        if (!value || seen.has(key)) continue;
        seen.set(key, {
          value,
          label: globalThis.CollabTeXBibTeX.latexToText(value)
        });
      }
    }
    return [...seen.values()].sort((left, right) =>
      left.label.localeCompare(right.label, undefined, { sensitivity: "base" })
    );
  }

  function allKnownKeywords(exceptKey = "") {
    const seen = new Map();
    for (const item of entries) {
      if (item.key === exceptKey) continue;
      for (const field of ["keywords", "keyword"]) {
        for (const keyword of String(item?.fields?.[field] || "").split(/[,;\n]+/)) {
          const value = keyword.replace(/\s+/g, " ").trim();
          const key = value.toLocaleLowerCase();
          if (!value || seen.has(key)) continue;
          seen.set(key, {
            value,
            label: globalThis.CollabTeXBibTeX.latexToText(value)
          });
        }
      }
    }
    return [...seen.values()].sort((left, right) =>
      left.label.localeCompare(right.label, undefined, { sensitivity: "base" })
    );
  }

  function keywordCompletionToken(input) {
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

  function setFieldCompletionOptions(container, suggestions) {
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

  function renderJournalSuggestions(entry, input) {
    const container = input.closest(".ctca-field-completion-wrap")?.querySelector(".ctca-field-completion");
    if (!container) return;
    const queryText = input.value.replace(/\s+/g, " ").trim().toLocaleLowerCase();
    const suggestions = allKnownJournals(entry.key)
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
    setFieldCompletionOptions(container, suggestions);
    setInlineCompletionHint(input, suggestions[0]?.value, input.value, ".ctca-field-completion-wrap");
    input.setAttribute("aria-expanded", String(suggestions.length > 0));
  }

  function renderKeywordSuggestions(entry, input) {
    const container = input.closest(".ctca-field-completion-wrap")?.querySelector(".ctca-field-completion");
    if (!container) return;
    const token = keywordCompletionToken(input);
    const queryText = token.value.replace(/\s+/g, " ").trim().toLocaleLowerCase();
    const current = new Set(
      String(input.value || "")
        .split(/[,;\n]+/)
        .map((keyword) => keyword.replace(/\s+/g, " ").trim().toLocaleLowerCase())
        .filter(Boolean)
    );
    current.delete(queryText);
    const suggestions = allKnownKeywords(entry.key)
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
    setFieldCompletionOptions(container, suggestions);
    input.setAttribute("aria-expanded", String(suggestions.length > 0));
  }

  function acceptJournalSuggestion(input, value) {
    if (!input || !value) return false;
    input.value = value;
    const container = input.closest(".ctca-field-completion-wrap")?.querySelector(".ctca-field-completion");
    if (container) container.hidden = true;
    setInlineCompletionHint(input, "", "", ".ctca-field-completion-wrap");
    input.setAttribute("aria-expanded", "false");
    input.dispatchEvent(new Event("change", { bubbles: true }));
    return true;
  }

  function acceptKeywordSuggestion(input, value) {
    if (!input || !value) return false;
    const token = keywordCompletionToken(input);
    input.setRangeText(value, token.start, token.end, "end");
    const container = input.closest(".ctca-field-completion-wrap")?.querySelector(".ctca-field-completion");
    if (container) container.hidden = true;
    input.setAttribute("aria-expanded", "false");
    input.dispatchEvent(new Event("change", { bubbles: true }));
    return true;
  }

  function fieldAutocompleteKeydown(event) {
    const input = event.target.closest("[data-manager-autocomplete]");
    if (!input) return;
    if (handleInlineCompletionDeletion(event, input)) return;
    const container = input.closest(".ctca-field-completion-wrap")?.querySelector(".ctca-field-completion");
    const token = input.dataset.managerAutocomplete === "keywords"
      ? keywordCompletionToken(input)
      : { end: input.value.length };
    if (event.key === "ArrowRight" && acceptInlineCompletion(input)) {
      event.preventDefault();
    } else if (event.key === "Escape" && discardInlineCompletion(input)) {
      event.preventDefault();
      container?.setAttribute("hidden", "");
    } else if (
      event.key === "ArrowRight" &&
      !container?.hidden &&
      input.selectionStart === input.selectionEnd &&
      input.selectionStart === token.end
    ) {
      const first = container.querySelector(".ctca-completion-option");
      const accepted = input.dataset.managerAutocomplete === "keywords"
        ? acceptKeywordSuggestion(input, first?.dataset.completionValue)
        : acceptJournalSuggestion(input, first?.dataset.completionValue);
      if (first && accepted) {
        event.preventDefault();
      }
    } else if (event.key === "Escape" && container && !container.hidden) {
      event.preventDefault();
      container.hidden = true;
      setInlineCompletionHint(input, "", "", ".ctca-field-completion-wrap");
      input.setAttribute("aria-expanded", "false");
    }
  }

  function fieldAutocompleteMouseDown(event) {
    const option = event.target.closest(".ctca-field-completion .ctca-completion-option");
    if (!option) return;
    const input = option.closest(".ctca-field-completion-wrap")?.querySelector("[data-manager-autocomplete]");
    event.preventDefault();
    event.stopPropagation();
    const accepted = input?.dataset.managerAutocomplete === "keywords"
      ? acceptKeywordSuggestion(input, option.dataset.completionValue)
      : acceptJournalSuggestion(input, option.dataset.completionValue);
    if (accepted) input.focus();
  }

  function tagEditorHtml(entry) {
    const tags = globalThis.CollabTeXSearchTools.splitTags(entry.tags || []);
    return `
      <div class="ctca-manager-tags">
        <h3>Tags</h3>
        <div class="ctca-tag-editor">
          <div class="ctca-tag-chip-list">
            ${tags.map((tag) => `<span class="ctca-tag-chip"><span>${escapeHtml(tag)}</span><button type="button" data-manager-action="remove-tag" data-tag="${escapeHtml(tag)}" aria-label="Remove tag ${escapeHtml(tag)}">×</button></span>`).join("")}
            <span class="ctca-tag-input-wrap">
              <input class="ctca-tag-input" placeholder="Add tag…" autocomplete="off" aria-label="Add tag">
              <span class="ctca-tag-suggestions" hidden role="listbox"></span>
            </span>
          </div>
          <div class="ctca-tag-help">Press Enter or comma to add. Existing tags are suggested automatically.</div>
        </div>
      </div>`;
  }

  function renderTagSuggestions(entry, input) {
    const container = input.closest(".ctca-tag-input-wrap")?.querySelector(".ctca-tag-suggestions");
    if (!container) return;
    const queryText = input.value.trim().toLocaleLowerCase();
    const current = new Set(globalThis.CollabTeXSearchTools.splitTags(entry.tags || []).map((tag) => tag.toLocaleLowerCase()));
    const suggestions = allKnownTags(entry.key)
      .filter((tag) => !current.has(tag.toLocaleLowerCase()))
      .filter((tag) => !queryText || tag.toLocaleLowerCase().includes(queryText))
      .sort((left, right) => {
        const leftStarts = left.toLocaleLowerCase().startsWith(queryText) ? 0 : 1;
        const rightStarts = right.toLocaleLowerCase().startsWith(queryText) ? 0 : 1;
        return leftStarts - rightStarts || left.localeCompare(right, undefined, { sensitivity: "base" });
      })
      .slice(0, 10);
    container.innerHTML = suggestions.map((tag, index) => `<button type="button" data-manager-action="add-tag" data-tag="${escapeHtml(tag)}" role="option"><span>${escapeHtml(tag)}</span>${index === 0 ? '<span class="ctca-completion-option-hint" title="Press Right Arrow to complete">→</span>' : ""}</button>`).join("");
    container.hidden = suggestions.length === 0;
    setInlineCompletionHint(input, suggestions[0], input.value, ".ctca-tag-input-wrap");
  }

  function addTagToEntry(entry, tagValue) {
    const tag = String(tagValue || "").trim().replace(/^[,;]+|[,;]+$/g, "").replace(/\s+/g, " ");
    if (!tag) return false;
    const tags = globalThis.CollabTeXSearchTools.splitTags(entry.tags || []);
    if (tags.some((item) => item.toLocaleLowerCase() === tag.toLocaleLowerCase())) return false;
    entry.tags = [...tags, tag];
    entry.updatedAt = new Date().toISOString();
    markDirty("Saving tag automatically…");
    scheduleListRender();
    return true;
  }

  function detailEntryFromTarget(target) {
    const container = target?.closest?.(".ctca-manager-details, .ctca-pdf-entry-details");
    const key = container?.dataset.detailEntryKey || "";
    return entryByKey(key) || entryByKey(selectedKey);
  }

  function tagInputKeydown(event) {
    const input = event.target.closest(".ctca-tag-input");
    if (!input) return;
    if (handleInlineCompletionDeletion(event, input)) return;
    const entry = detailEntryFromTarget(input);
    if (!entry) return;
    if (event.key === "ArrowRight" && acceptInlineCompletion(input)) {
      event.preventDefault();
    } else if (event.key === "ArrowRight" && input.selectionStart === input.selectionEnd && input.selectionStart === input.value.length) {
      const first = input.closest(".ctca-tag-input-wrap")?.querySelector(".ctca-tag-suggestions button");
      if (first && addTagToEntry(entry, first.dataset.tag || "")) {
        event.preventDefault();
        input.blur();
        renderDetails();
        requestAnimationFrame(() => $(".ctca-tag-input", root)?.focus());
      }
    } else if (event.key === "Enter" || event.key === ",") {
      event.preventDefault();
      if (addTagToEntry(entry, input.value)) {
        input.blur();
        renderDetails();
        requestAnimationFrame(() => $(".ctca-tag-input", root)?.focus());
      }
    } else if (event.key === "Backspace" && !input.value) {
      const tags = globalThis.CollabTeXSearchTools.splitTags(entry.tags || []);
      if (tags.length) {
        event.preventDefault();
        entry.tags = tags.slice(0, -1);
        markDirty("Saving tag automatically…");
        scheduleListRender();
        input.blur();
        renderDetails();
        requestAnimationFrame(() => $(".ctca-tag-input", root)?.focus());
      }
    } else if (event.key === "Escape") {
      discardInlineCompletion(input);
      input.closest(".ctca-tag-input-wrap")?.querySelector(".ctca-tag-suggestions")?.setAttribute("hidden", "");
      setInlineCompletionHint(input, "", "", ".ctca-tag-input-wrap");
    }
  }

  const RICH_TEXT_FONTS = [
    ["", "Default"],
    ["Arial, sans-serif", "Arial"],
    ["Georgia, serif", "Georgia"],
    ["Times New Roman, serif", "Times New Roman"],
    ["Courier New, monospace", "Courier New"],
    ["Verdana, sans-serif", "Verdana"]
  ];
  const RICH_TEXT_ALLOWED_TAGS = new Set(["b", "strong", "i", "em", "u", "span", "br", "div", "p"]);
  const RICH_TEXT_BLOCK_TAGS = new Set(["div", "p"]);
  const richTextSelectionByItem = new WeakMap();
  let richTextOutsideDismissBound = false;

  function normalizeRichColor(value) {
    const candidate = String(value || "").trim();
    if (!candidate) return "";
    const probe = document.createElement("span");
    probe.style.color = candidate;
    return probe.style.color || "";
  }

  function normalizeRichFont(value) {
    const candidate = String(value || "").trim().replace(/["']/g, "");
    return RICH_TEXT_FONTS.find(([font]) => font.toLowerCase() === candidate.toLowerCase())?.[0] || "";
  }

  function normalizeRichTextStyle(value) {
    const style = value && typeof value === "object" ? value : {};
    return {
      backgroundColor: normalizeRichColor(style.backgroundColor),
      textColor: normalizeRichColor(style.textColor),
      fontFamily: normalizeRichFont(style.fontFamily)
    };
  }

  function sanitizeRichTextHtml(value) {
    const template = document.createElement("template");
    template.innerHTML = String(value || "");
    const sanitizeChildren = (parent) => {
      [...parent.childNodes].forEach((node) => {
        if (node.nodeType !== Node.ELEMENT_NODE) return;
        const tag = node.tagName.toLowerCase();
        if (["script", "style", "iframe", "object", "embed", "svg", "math"].includes(tag)) {
          node.remove();
          return;
        }
        sanitizeChildren(node);
        if (!RICH_TEXT_ALLOWED_TAGS.has(tag)) {
          node.replaceWith(...node.childNodes);
          return;
        }
        const safe = [];
        const color = normalizeRichColor(node.style.color);
        const background = normalizeRichColor(node.style.backgroundColor);
        const font = normalizeRichFont(node.style.fontFamily);
        if (color) safe.push(`color: ${color}`);
        if (background) safe.push(`background-color: ${background}`);
        if (font) safe.push(`font-family: ${font}`);
        if (["bold", "700"].includes(node.style.fontWeight)) safe.push("font-weight: bold");
        if (node.style.fontStyle === "italic") safe.push("font-style: italic");
        if (String(node.style.textDecorationLine).includes("underline") || String(node.style.textDecoration).includes("underline")) safe.push("text-decoration: underline");
        [...node.attributes].forEach((attribute) => node.removeAttribute(attribute.name));
        if (safe.length) node.setAttribute("style", safe.join("; "));
      });
    };
    sanitizeChildren(template.content);
    return template.innerHTML;
  }

  function richTextPlainText(html) {
    const template = document.createElement("template");
    template.innerHTML = sanitizeRichTextHtml(html);
    const read = (node) => {
      if (node.nodeType === Node.TEXT_NODE) return node.nodeValue || "";
      if (node.nodeType !== Node.ELEMENT_NODE && node.nodeType !== Node.DOCUMENT_FRAGMENT_NODE) return "";
      if (node.nodeType === Node.ELEMENT_NODE && node.tagName.toLowerCase() === "br") return "\n";
      const text = [...node.childNodes].map(read).join("");
      return node.nodeType === Node.ELEMENT_NODE && RICH_TEXT_BLOCK_TAGS.has(node.tagName.toLowerCase()) ? `${text}\n` : text;
    };
    return read(template.content).replace(/\u00a0/g, " ").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  }

  function normalizeRichTextItem(item, index, prefix) {
    const fallbackHtml = escapeHtml(String(item?.text || "")).replace(/\r?\n/g, "<br>");
    const html = sanitizeRichTextHtml(item?.html != null ? item.html : fallbackHtml);
    return {
      id: String(item?.id || `${prefix}-${index}-${Date.now()}`),
      text: richTextPlainText(html),
      html,
      style: normalizeRichTextStyle(item?.style)
    };
  }

  function richTextItemStyle(item) {
    const style = normalizeRichTextStyle(item?.style);
    return [
      style.backgroundColor ? `--ctca-rich-background:${style.backgroundColor}` : "",
      style.textColor ? `--ctca-rich-color:${style.textColor}` : "",
      style.fontFamily ? `--ctca-rich-font:${style.fontFamily}` : ""
    ].filter(Boolean).join(";");
  }

  function richTextToolbarHtml(item, label = "Note") {
    const style = normalizeRichTextStyle(item?.style);
    const fonts = RICH_TEXT_FONTS.map(([value, label]) => `<option value="${escapeHtml(value)}"${value === style.fontFamily ? " selected" : ""}>${escapeHtml(label)}</option>`).join("");
    return `
      <div class="ctca-rich-toolbar" hidden>
        <div class="ctca-rich-toolbar-row" aria-label="Format selected text">
          <span>Selection</span>
          <button type="button" class="ctca-rich-command" data-rich-command="bold" title="Bold"><strong>B</strong></button>
          <button type="button" class="ctca-rich-command" data-rich-command="italic" title="Italic"><em>I</em></button>
          <button type="button" class="ctca-rich-command" data-rich-command="underline" title="Underline"><u>U</u></button>
          <select class="ctca-rich-selection-font" aria-label="Font for selected text" title="Font for selected text">${fonts}</select>
          <input class="ctca-rich-selection-color" type="color" value="#24292f" aria-label="Color for selected text" title="Color for selected text">
          <input class="ctca-rich-selection-background" type="color" value="#fff59d" aria-label="Background for selected text" title="Background for selected text">
        </div>
        <div class="ctca-rich-toolbar-row" aria-label="Default note appearance">
          <span>${escapeHtml(label)}</span>
          <label>Background <input class="ctca-rich-default-background" type="color" value="${escapeHtml(style.backgroundColor || "#f6f8fa")}"></label>
          <button type="button" class="ctca-rich-reset" data-rich-reset="background" title="Use the default background">Reset</button>
          <label>Text <input class="ctca-rich-default-color" type="color" value="${escapeHtml(style.textColor || "#24292f")}"></label>
          <button type="button" class="ctca-rich-reset" data-rich-reset="color" title="Use the default text color">Reset</button>
          <label>Font <select class="ctca-rich-default-font">${fonts}</select></label>
        </div>
      </div>`;
  }

  function richTextItemHtml(item, { kind, index, count, placeholder }) {
    const idAttribute = kind === "comment" ? "data-comment-id" : "data-note-id";
    const itemClass = kind === "comment" ? "ctca-comment-item" : "ctca-pdf-note-item";
    const textClass = kind === "comment" ? " ctca-comment-text" : "";
    const deleteClass = kind === "comment" ? " ctca-comment-delete" : "";
    const label = kind === "comment" ? "comment" : "note";
    const style = normalizeRichTextStyle(item.style);
    return `
      <article class="ctca-note-item ${itemClass}" ${idAttribute}="${escapeHtml(item.id)}"
        data-rich-background="${escapeHtml(style.backgroundColor)}" data-rich-color="${escapeHtml(style.textColor)}"
        data-rich-font="${escapeHtml(style.fontFamily)}" style="${escapeHtml(richTextItemStyle(item))}">
        <button type="button" class="ctca-note-drag" draggable="${count > 1 ? "true" : "false"}" title="Drag to reorder ${label}" aria-label="Reorder ${label} ${index + 1}">⋮⋮</button>
        <div class="ctca-note-text${textClass}" contenteditable="true" role="textbox" aria-multiline="true"
          aria-label="${label === "comment" ? "Comment" : "PDF note"} ${index + 1}" data-placeholder="${escapeHtml(placeholder)}">${item.html}</div>
        <button type="button" class="ctca-note-style" title="Format text and change appearance" aria-label="Format ${label}">&#9998;</button>
        <button type="button" class="ctca-note-delete${deleteClass}" title="Delete ${label}" aria-label="Delete ${label}">&#128465;&#65038;</button>
        ${richTextToolbarHtml(item, label === "comment" ? "Comment" : "Note")}
      </article>`;
  }

  function readRichTextItem(item, prefix) {
    const editor = $(".ctca-note-text", item);
    const html = sanitizeRichTextHtml(editor?.innerHTML || "");
    return {
      id: item.dataset.commentId || item.dataset.noteId || `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      text: richTextPlainText(html),
      html,
      style: normalizeRichTextStyle({
        backgroundColor: item.dataset.richBackground,
        textColor: item.dataset.richColor,
        fontFamily: item.dataset.richFont
      })
    };
  }

  function bindRichTextControls(container, save, onChange = () => {}) {
    const changedItems = new WeakSet();
    const markChanged = (item) => {
      if (!item) return;
      changedItems.add(item);
      onChange(item);
    };
    if (!richTextOutsideDismissBound) {
      document.addEventListener("pointerdown", (event) => {
        $$(".ctca-rich-toolbar:not([hidden])", root).forEach((toolbar) => {
          const item = toolbar.closest(".ctca-note-item");
          if (item && !item.contains(event.target)) toolbar.hidden = true;
        });
      }, true);
      richTextOutsideDismissBound = true;
    }
    const rememberSelection = (item) => {
      const editor = $(".ctca-note-text", item);
      const selection = document.getSelection();
      if (!editor || !selection?.rangeCount) return;
      const range = selection.getRangeAt(0);
      if (editor.contains(range.commonAncestorContainer)) richTextSelectionByItem.set(item, range.cloneRange());
    };
    const restoreSelection = (item) => {
      const editor = $(".ctca-note-text", item);
      const range = richTextSelectionByItem.get(item);
      editor?.focus();
      if (range) {
        const selection = document.getSelection();
        selection.removeAllRanges();
        selection.addRange(range);
      }
      return editor;
    };
    const applyAppearance = (item) => {
      const style = normalizeRichTextStyle({
        backgroundColor: item.dataset.richBackground,
        textColor: item.dataset.richColor,
        fontFamily: item.dataset.richFont
      });
      item.style.setProperty("--ctca-rich-background", style.backgroundColor || "");
      item.style.setProperty("--ctca-rich-color", style.textColor || "");
      item.style.setProperty("--ctca-rich-font", style.fontFamily || "");
    };
    container.addEventListener("mouseup", (event) => {
      const item = event.target.closest(".ctca-note-item");
      if (event.target.closest(".ctca-note-text") && item) rememberSelection(item);
    });
    container.addEventListener("keyup", (event) => {
      const item = event.target.closest(".ctca-note-item");
      if (event.target.closest(".ctca-note-text") && item) rememberSelection(item);
    });
    container.addEventListener("paste", (event) => {
      if (!event.target.closest(".ctca-note-text")) return;
      event.preventDefault();
      document.execCommand("insertText", false, event.clipboardData?.getData("text/plain") || "");
    });
    container.addEventListener("input", (event) => {
      if (event.target.closest(".ctca-note-text")) markChanged(event.target.closest(".ctca-note-item"));
    });
    container.addEventListener("pointerdown", (event) => {
      const item = event.target.closest(".ctca-note-item");
      if (item && event.target.closest(".ctca-note-style, .ctca-rich-toolbar")) rememberSelection(item);
      if (event.target.closest(".ctca-rich-command, .ctca-rich-reset")) event.preventDefault();
    });
    container.addEventListener("click", (event) => {
      const item = event.target.closest(".ctca-note-item");
      if (!item) return;
      const pen = event.target.closest(".ctca-note-style");
      if (pen) {
        const toolbar = $(".ctca-rich-toolbar", item);
        const opening = toolbar.hidden;
        $$(".ctca-rich-toolbar", container).forEach((candidate) => { candidate.hidden = true; });
        toolbar.hidden = !opening;
        return;
      }
      const command = event.target.closest(".ctca-rich-command")?.dataset.richCommand;
      if (command) {
        restoreSelection(item);
        document.execCommand("styleWithCSS", false, true);
        document.execCommand(command, false);
        rememberSelection(item);
        markChanged(item);
        return;
      }
      const reset = event.target.closest(".ctca-rich-reset")?.dataset.richReset;
      if (reset) {
        if (reset === "background") item.dataset.richBackground = "";
        if (reset === "color") item.dataset.richColor = "";
        applyAppearance(item);
        markChanged(item);
      }
    });
    container.addEventListener("change", (event) => {
      const item = event.target.closest(".ctca-note-item");
      if (!item) return;
      if (event.target.matches(".ctca-rich-selection-font, .ctca-rich-selection-color, .ctca-rich-selection-background")) {
        restoreSelection(item);
        document.execCommand("styleWithCSS", false, true);
        const command = event.target.matches(".ctca-rich-selection-font")
          ? "fontName"
          : event.target.matches(".ctca-rich-selection-color") ? "foreColor" : "hiliteColor";
        document.execCommand(command, false, event.target.value);
        rememberSelection(item);
        markChanged(item);
        return;
      }
      if (event.target.matches(".ctca-rich-default-background")) item.dataset.richBackground = event.target.value;
      if (event.target.matches(".ctca-rich-default-color")) item.dataset.richColor = event.target.value;
      if (event.target.matches(".ctca-rich-default-font")) item.dataset.richFont = event.target.value;
      if (event.target.matches(".ctca-rich-default-background, .ctca-rich-default-color, .ctca-rich-default-font")) {
        applyAppearance(item);
        markChanged(item);
      }
    });
    container.addEventListener("focusout", (event) => {
      const item = event.target.closest(".ctca-note-item");
      if (!item) return;
      const nextFocus = event.relatedTarget;
      if (nextFocus instanceof Node && item.contains(nextFocus)) return;
      const editor = $(".ctca-note-text", item);
      if (editor) editor.innerHTML = sanitizeRichTextHtml(editor.innerHTML);
      $(".ctca-rich-toolbar", item)?.setAttribute("hidden", "");
      if (changedItems.has(item)) {
        changedItems.delete(item);
        save();
      }
    });
  }

  function normalizeCommentItems(value) {
    return (Array.isArray(value) ? value : []).map((comment, index) => normalizeRichTextItem(comment, index, "comment"));
  }

  function commentsEditorHtml(entry) {
    const comments = normalizeCommentItems(entry.comments);
    return `
      <section class="ctca-manager-comments ctca-detail-reorderable" data-detail-section="comments">
        <div class="ctca-manager-section-head"><h3>Comments</h3></div>
        <div class="ctca-note-list ctca-comment-list">
          ${comments.map((comment, index) => richTextItemHtml(comment, {
            kind: "comment", index, count: comments.length, placeholder: "Comment on this entry…"
          })).join("")}
        </div>
        <button type="button" class="ctca-note-add ctca-comment-add" title="Add comment" aria-label="Add comment">+</button>
      </section>`;
  }

  function bindCommentsEditor(container, entry) {
    const section = $(".ctca-manager-comments", container);
    if (!section) return;
    const collect = () => {
      entry.comments = $$(".ctca-comment-item", section).map((item) => readRichTextItem(item, "comment"));
      entry.updatedAt = new Date().toISOString();
      markDirty("Saving comment automatically…");
      scheduleListRender();
    };
    bindRichTextControls(section, collect);
    section.addEventListener("click", async (event) => {
      if (event.target.closest(".ctca-comment-add")) {
        entry.comments = [
          ...normalizeCommentItems(entry.comments),
          { id: `comment-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, text: "" }
        ];
        markDirty("Saving comment automatically…");
        renderDetails();
        requestAnimationFrame(() => $(".ctca-comment-item:last-child .ctca-comment-text", root)?.focus());
        return;
      }
      const remove = event.target.closest(".ctca-comment-delete");
      if (!remove) return;
      const confirmed = await showDialog({
        title: "Delete this comment?",
        message: "The comment will be permanently removed.",
        buttons: [
          { label: "Cancel", value: false },
          { label: "Delete comment", value: true, danger: true }
        ],
        closeValue: false,
        danger: true
      });
      if (!confirmed) return;
      remove.closest(".ctca-comment-item")?.remove();
      collect();
    });
    let dragged = null;
    section.addEventListener("dragstart", (event) => {
      if (event.target.closest(".ctca-detail-section-drag")) return;
      dragged = event.target.closest(".ctca-note-drag")?.closest(".ctca-comment-item") || null;
      if (!dragged) return;
      dragged.classList.add("ctca-note-dragging");
      event.dataTransfer.effectAllowed = "move";
      event.stopPropagation();
    });
    section.addEventListener("dragover", (event) => {
      const target = event.target.closest(".ctca-comment-item");
      if (!dragged || !target || target === dragged) return;
      event.preventDefault();
      event.stopPropagation();
      const after = event.clientY > target.getBoundingClientRect().top + target.offsetHeight / 2;
      target.parentElement.insertBefore(dragged, after ? target.nextSibling : target);
    });
    section.addEventListener("drop", (event) => {
      if (!dragged) return;
      event.preventDefault();
      event.stopPropagation();
      dragged.classList.remove("ctca-note-dragging");
      dragged = null;
      collect();
    });
    section.addEventListener("dragend", () => {
      dragged?.classList.remove("ctca-note-dragging");
      dragged = null;
    });
  }

  function crosslinkEntry(key) {
    const normalized = String(key || "").trim().toLocaleLowerCase();
    return entries.find((entry) =>
      entry.key.toLocaleLowerCase() === normalized
      || (entry.aliases || []).some((alias) => String(alias).toLocaleLowerCase() === normalized)
    ) || null;
  }

  function crosslinkKeyMatchesEntry(key, entry) {
    const normalized = String(key || "").trim().toLocaleLowerCase();
    if (!normalized || !entry) return false;
    return entry.key.toLocaleLowerCase() === normalized
      || (entry.aliases || []).some((alias) => String(alias).trim().toLocaleLowerCase() === normalized);
  }

  function abbreviatedCrosslinkAuthor(name) {
    const value = String(name || "").trim();
    if (!value) return "";
    if (value.includes(",")) {
      const [family, ...givenParts] = value.split(",");
      const initials = givenParts.join(" ").trim().split(/\s+/).filter(Boolean)
        .map((part) => `${part.replace(/[{}]/g, "").charAt(0).toUpperCase()}.`).join(" ");
      return [initials, family.trim()].filter(Boolean).join(" ");
    }
    const parts = value.split(/\s+/).filter(Boolean);
    if (parts.length < 2) return value;
    const family = parts.pop();
    return `${parts.map((part) => `${part.replace(/[{}]/g, "").charAt(0).toUpperCase()}.`).join(" ")} ${family}`;
  }

  function crosslinkAuthors(entry) {
    const authors = globalThis.CollabTeXBibTeX.splitAuthors(stripBibValue(entry?.fields?.author || entry?.fields?.editor || ""));
    const visible = authors.slice(0, 3).map(abbreviatedCrosslinkAuthor).filter(Boolean);
    return `${visible.join(", ")}${authors.length > 3 ? `${visible.length ? ", " : ""}et al.` : ""}` || "Authors not specified";
  }

  function crosslinkCitationHtml(entry) {
    const fields = entry?.fields || {};
    const journal = stripBibValue(fields.journal || fields.journaltitle || fields.booktitle || "");
    const number = stripBibValue(fields.volume || fields.number || "");
    const pages = stripBibValue(fields.pages || "");
    const year = stripBibValue(fields.year || fields.date || "");
    const publication = [journal ? `<i>${escapeHtml(journal)}</i>` : "", number ? `<b>${escapeHtml(number)}</b>` : ""].filter(Boolean).join(" ");
    return `${publication}${pages ? `${publication ? ", " : ""}${escapeHtml(pages)}` : ""}${year ? ` (${escapeHtml(year)})` : ""}`.trim();
  }

  function managerListCrosslinkBoxHtml(key) {
    const target = crosslinkEntry(key);
    if (!target) return `<div class="ctca-manager-row-info-box ctca-manager-row-crosslink-box" title="Linked entry unavailable">${escapeHtml(key)}</div>`;
    const authors = globalThis.CollabTeXBibTeX.splitAuthors(stripBibValue(target.fields?.author || target.fields?.editor || ""));
    const firstAuthorLabel = `${abbreviatedCrosslinkAuthor(authors[0] || "") || "Unknown"}${authors.length > 1 ? " et al." : ""}`;
    const citation = crosslinkCitationHtml(target);
    const title = stripBibValue(target.fields?.title || target.key);
    return `<button type="button" class="ctca-manager-row-info-box ctca-manager-row-crosslink-box" data-manager-list-crosslink-key="${escapeHtml(target.key)}" title="${escapeHtml(title)}"><strong class="ctca-manager-row-crosslink-title">${escapeHtml(title)}</strong><span class="ctca-manager-row-crosslink-citation"><span class="ctca-manager-row-crosslink-author">${escapeHtml(firstAuthorLabel)}${citation ? "," : ""}</span>${citation ? `<span>${citation}</span>` : ""}</span></button>`;
  }

  function managerListEntryNotesHtml(entry) {
    const items = [];
    const note = stripBibValue(entry.fields?.note || "");
    if (note) items.push(`<div class="ctca-manager-row-info-box ctca-manager-row-note-box" role="button" tabindex="0" data-manager-list-entry-note="note">${escapeHtml(note).replace(/\r?\n/g, "<br>")}</div>`);
    for (const comment of normalizeCommentItems(entry.comments)) {
      if (!comment.text) continue;
      items.push(`<div class="ctca-manager-row-info-box ctca-manager-row-note-box" role="button" tabindex="0" data-manager-list-comment-id="${escapeHtml(comment.id)}" style="${escapeHtml(richTextItemStyle(comment))}">${comment.html}</div>`);
    }
    return items.join("");
  }

  function managerListPdfNotesHtml(attachments) {
    return (Array.isArray(attachments) ? attachments : []).map((attachment) => {
      const notes = normalizedPdfNoteItems(attachment).filter((note) => note.text);
      if (!notes.length) return "";
      return `<section class="ctca-manager-row-pdf-note-group" data-attachment-id="${escapeHtml(attachment.id)}">
        <small>${escapeHtml(attachment.name || attachment.fileName || "PDF")}</small>
        <div>${notes.map((note) => `<div class="ctca-manager-row-info-box ctca-manager-row-note-box" role="button" tabindex="0" data-manager-list-pdf-note-id="${escapeHtml(note.id)}" data-attachment-id="${escapeHtml(attachment.id)}" style="${escapeHtml(richTextItemStyle(note))}">${note.html}</div>`).join("")}</div>
      </section>`;
    }).join("");
  }

  function managerVisibleEntryKeys() {
    return virtualListState.visibleKeys?.length
      ? [...virtualListState.visibleKeys]
      : filteredEntries().map((entry) => entry.key);
  }

  function openListEntryDetails(entry, { detailOnly = false } = {}) {
    if (!entry) return;
    const visibleKeys = managerVisibleEntryKeys();
    const previousSelectedKeys = new Set(selectedKeys);
    const previousActiveKey = selectedKey;
    detailOnlyKey = detailOnly ? entry.key : "";
    selectedKeys = detailOnly ? new Set() : new Set([entry.key]);
    selectedKey = entry.key;
    selectionAnchorKey = detailOnly ? "" : entry.key;
    bibliographyDetailsCollapsed = false;
    updateListSelectionState(visibleKeys, previousSelectedKeys, previousActiveKey);
    renderDetails();
  }

  function scrollToDetailTarget(resolveTarget, { focus = false } = {}) {
    let remaining = 50;
    const find = () => {
      const target = resolveTarget();
      if (target) {
        target.scrollIntoView({ block: "center", behavior: "smooth" });
        if (focus) {
          const editor = target.matches("input, textarea, [contenteditable]") ? target : target.querySelector("input, textarea, [contenteditable]");
          editor?.focus({ preventScroll: true });
        }
        return;
      }
      remaining -= 1;
      if (remaining > 0) window.setTimeout(find, 50);
    };
    requestAnimationFrame(find);
  }

  function bindManagerRowSupplementalNavigation(row, entry) {
    const supplemental = $(".ctca-manager-row-supplemental", row);
    if (!supplemental || supplemental.dataset.navigationBound === "true") return;
    supplemental.dataset.navigationBound = "true";
    supplemental.addEventListener("keydown", (event) => {
      const target = event.target.closest(".ctca-manager-row-info-box");
      if (!target) return;
      event.stopPropagation();
      if (target.matches('[role="button"]') && (event.key === "Enter" || event.key === " ")) {
        event.preventDefault();
        target.click();
      }
    });
    supplemental.addEventListener("click", (event) => {
      const target = event.target.closest(".ctca-manager-row-info-box[data-manager-list-crosslink-key], .ctca-manager-row-info-box[data-manager-list-entry-note], .ctca-manager-row-info-box[data-manager-list-comment-id], .ctca-manager-row-info-box[data-manager-list-pdf-note-id]");
      if (!target) return;
      event.preventDefault();
      event.stopPropagation();

      const crosslinkKey = target.dataset.managerListCrosslinkKey;
      if (crosslinkKey) {
        const linked = crosslinkEntry(crosslinkKey);
        if (!linked) return;
        crosslinkNavigationStack = [entry.key];
        openListEntryDetails(linked, { detailOnly: true });
        return;
      }

      crosslinkNavigationStack = [];
      openListEntryDetails(entry);
      if (target.dataset.managerListEntryNote) {
        scrollToDetailTarget(() => $(".ctca-manager-details [data-manager-field=\"note\"]", root), { focus: true });
        return;
      }
      const commentId = target.dataset.managerListCommentId;
      if (commentId) {
        scrollToDetailTarget(
          () => $(`.ctca-manager-details .ctca-comment-item[data-comment-id="${CSS.escape(commentId)}"]`, root),
          { focus: true }
        );
        return;
      }
      const pdfNoteId = target.dataset.managerListPdfNoteId;
      const attachmentId = target.dataset.attachmentId;
      if (!pdfNoteId || !attachmentId) return;
      scrollToDetailTarget(() => {
        const attachmentRow = $(`.ctca-manager-details .ctca-manager-pdf-row[data-attachment-id="${CSS.escape(attachmentId)}"]`, root);
        if (!attachmentRow) return null;
        const toggle = $(".ctca-manager-pdf-notes-toggle", attachmentRow);
        if (toggle?.getAttribute("aria-expanded") !== "true") toggle?.click();
        return $(`.ctca-rich-note-preview[data-note-id="${CSS.escape(pdfNoteId)}"]`, attachmentRow);
      });
    });
  }

  function updateManagerRowSupplemental(row, entry, attachments = []) {
    const supplemental = $(".ctca-manager-row-supplemental", row);
    if (!supplemental) return;
    const groups = [];
    if (listDisplayOptions.crosslinks) {
      const boxes = normalizeCrosslinkKeys(entry.crosslinks, entry.key).map(managerListCrosslinkBoxHtml).join("");
      if (boxes) groups.push(`<div class="ctca-manager-row-info-group ctca-manager-row-crosslinks"><small>Crosslinks</small><div>${boxes}</div></div>`);
    }
    if (listDisplayOptions.entryNotes) {
      const boxes = managerListEntryNotesHtml(entry);
      if (boxes) groups.push(`<div class="ctca-manager-row-info-group ctca-manager-row-entry-notes"><small>Notes &amp; comments</small><div>${boxes}</div></div>`);
    }
    if (listDisplayOptions.pdfNotes) {
      const pdfNotes = managerListPdfNotesHtml(attachments);
      if (pdfNotes) groups.push(`<div class="ctca-manager-row-info-group ctca-manager-row-pdf-notes"><small>PDF notes</small><div>${pdfNotes}</div></div>`);
    }
    supplemental.innerHTML = groups.join("");
    supplemental.hidden = groups.length === 0;
    row.classList.toggle("ctca-manager-row-has-supplemental", groups.length > 0);
    bindManagerRowSupplementalNavigation(row, entry);

    const pdfToggleSlot = $(".ctca-manager-row-pdf-notes-toggle-slot", row);
    if (!pdfToggleSlot) return;
    const hasPdfNotes = (Array.isArray(attachments) ? attachments : [])
      .some((attachment) => normalizedPdfNoteItems(attachment).some((note) => note.text));
    if (!hasPdfNotes) {
      pdfToggleSlot.replaceChildren();
      return;
    }
    pdfToggleSlot.innerHTML = `<button type="button" class="ctca-manager-row-display-toggle${listDisplayOptions.pdfNotes ? " ctca-manager-row-display-toggle-active" : ""}" data-manager-list-display-toggle="pdfNotes" aria-pressed="${listDisplayOptions.pdfNotes}" title="${listDisplayOptions.pdfNotes ? "Hide" : "Show"} PDF notes in the list">${listDisplayNoteIconHtml(true)}</button>`;
    $("button", pdfToggleSlot).addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      setListDisplayOption("pdfNotes", !listDisplayOptions.pdfNotes);
    });
  }

  function crosslinksEditorHtml(entry) {
    const linked = normalizeCrosslinkKeys(entry.crosslinks, entry.key);
    return `
      <section class="ctca-manager-crosslinks ctca-detail-reorderable" data-detail-section="crosslinks">
        <div class="ctca-manager-section-head"><h3>Crosslinks</h3></div>
        <div class="ctca-crosslink-list">
          ${linked.map((key, index) => {
            const target = crosslinkEntry(key);
            if (!target) return `
              <article class="ctca-crosslink-chip ctca-crosslink-missing" data-crosslink-key="${escapeHtml(key)}">
                <button type="button" class="ctca-crosslink-drag" draggable="${linked.length > 1 ? "true" : "false"}" aria-label="Reorder missing crosslink">⋮⋮</button>
                <span class="ctca-crosslink-main"><strong>${escapeHtml(key)}</strong><small>Linked entry is not currently available.</small></span>
                <button type="button" class="ctca-crosslink-delete" data-manager-action="remove-crosslink" data-crosslink-key="${escapeHtml(key)}" title="Remove crosslink" aria-label="Remove crosslink">&#128465;&#65038;</button>
              </article>`;
            return `
              <article class="ctca-crosslink-chip" data-crosslink-key="${escapeHtml(key)}">
                <button type="button" class="ctca-crosslink-drag" draggable="${linked.length > 1 ? "true" : "false"}" aria-label="Reorder crosslink to ${escapeHtml(target.key)}">⋮⋮</button>
                <button type="button" class="ctca-crosslink-main" data-manager-action="open-crosslink" data-crosslink-key="${escapeHtml(key)}" title="Open ${escapeHtml(target.key)}">
                  <strong class="ctca-crosslink-title" title="${escapeHtml(stripBibValue(target.fields?.title || target.key))}">${escapeHtml(stripBibValue(target.fields?.title || target.key))}</strong>
                  <small>${escapeHtml(crosslinkAuthors(target))}</small>
                  <small>${crosslinkCitationHtml(target)}</small>
                </button>
                <button type="button" class="ctca-crosslink-delete" data-manager-action="remove-crosslink" data-crosslink-key="${escapeHtml(key)}" title="Remove crosslink" aria-label="Remove crosslink to ${escapeHtml(target.key)}">&#128465;&#65038;</button>
              </article>`;
          }).join("") || `<div class="ctca-crosslink-empty">No crosslinks yet.</div>`}
        </div>
        <button type="button" class="ctca-note-add ctca-crosslink-add" data-manager-action="add-crosslink" title="Add crosslinks" aria-label="Add crosslinks">+</button>
      </section>`;
  }

  function bindCrosslinkReordering(container, entry) {
    const section = container.querySelector(".ctca-manager-crosslinks");
    if (!section) return;
    let dragged = null;
    section.addEventListener("dragstart", (event) => {
      dragged = event.target.closest(".ctca-crosslink-drag")?.closest(".ctca-crosslink-chip") || null;
      if (!dragged) return;
      dragged.classList.add("ctca-crosslink-dragging");
      event.dataTransfer.effectAllowed = "move";
      event.stopPropagation();
    });
    section.addEventListener("dragover", (event) => {
      const target = event.target.closest(".ctca-crosslink-chip");
      if (!dragged || !target || target === dragged) return;
      event.preventDefault();
      event.stopPropagation();
      const after = event.clientY > target.getBoundingClientRect().top + target.offsetHeight / 2;
      target.parentElement.insertBefore(dragged, after ? target.nextSibling : target);
    });
    section.addEventListener("drop", (event) => {
      if (!dragged) return;
      event.preventDefault();
      event.stopPropagation();
      dragged.classList.remove("ctca-crosslink-dragging");
      dragged = null;
      entry.crosslinks = [...section.querySelectorAll(".ctca-crosslink-chip")]
        .map((item) => item.dataset.crosslinkKey).filter(Boolean);
      entry.updatedAt = new Date().toISOString();
      markDirty("Saving crosslink order automatically…");
      scheduleListRender();
    });
    section.addEventListener("dragend", () => {
      dragged?.classList.remove("ctca-crosslink-dragging");
      dragged = null;
    });
  }

  function crosslinkSearchControlsHtml() {
    const typeOptions = ENTRY_TYPES.map((type) => `<option value="${escapeHtml(type)}"${searchFilters.type === type ? " selected" : ""}>${escapeHtml(type)}</option>`).join("");
    const filterCount = globalThis.CollabTeXSearchTools.activeFilterCount(searchFilters);
    return `
      <div class="ctca-crosslink-search-composite">
        <span class="ctca-manager-search-input-wrap ctca-crosslink-search-input-wrap">
          <input type="search" class="ctca-crosslink-picker-search" placeholder="Search text or use operators. Press ‘/’ for assistance." autocomplete="off">
          <button type="button" class="ctca-crosslink-search-config${filterCount ? " ctca-search-has-filters" : ""}" data-filter-count="${filterCount || ""}" aria-expanded="false" aria-label="Open search and filter menu" title="Search operators and filters">
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h10M18 7h2M4 17h2M10 17h10M8 4v6M16 14v6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><circle cx="16" cy="7" r="2" fill="none" stroke="currentColor" stroke-width="2"/><circle cx="8" cy="17" r="2" fill="none" stroke="currentColor" stroke-width="2"/></svg>
          </button>
          <span class="ctca-manager-tag-search-suggestions" hidden role="listbox"></span>
        </span>
        <div class="ctca-crosslink-search-menu" hidden role="dialog" aria-label="Crosslink search operators and filters">
          <span class="ctca-search-section">
            <strong>Search operators</strong>
            <span class="ctca-search-chip-grid">
              <button type="button" data-crosslink-search-insert='""' data-crosslink-search-cursor-back="1"><b>“”</b><span>Exact phrase</span></button>
              <button type="button" data-crosslink-search-insert="!"><b>!</b><span>Exclude</span></button>
            </span>
          </span>
          <span class="ctca-search-section">
            <strong>Field search</strong>
            <span class="ctca-search-field-chips">
              ${["title:", "author:", "year:", "abstract:", "pdf:", "tag:", "citekey:", "journal:", "doi:", "type:", "category:"]
                .map((operator) => `<button type="button" data-crosslink-search-insert="${operator}">${operator}</button>`).join("")}
            </span>
          </span>
          <span class="ctca-search-section ctca-search-includes">
            <strong>Include in unqualified search</strong>
            <label><span>Abstract</span><input type="checkbox" data-crosslink-search-option="includeAbstract" ${searchOptions.includeAbstract !== false ? "checked" : ""}></label>
            <label><span>PDF text / PDF-related fields</span><input type="checkbox" data-crosslink-search-option="includePdfText" ${searchOptions.includePdfText ? "checked" : ""}></label>
            <label><span>PDF notes and entry comments</span><input type="checkbox" data-crosslink-search-option="includeNotesComments" ${searchOptions.includeNotesComments ? "checked" : ""}></label>
          </span>
          <span class="ctca-search-section ctca-search-filters">
            <span class="ctca-search-filter-heading"><strong>Filters</strong><button type="button" class="ctca-crosslink-search-clear-filters">Clear filters</button></span>
            <span class="ctca-search-filter-grid">
              <label><span>Entry type</span><select data-crosslink-search-filter="type"><option value="">Any type</option>${typeOptions}</select></label>
              <label><span>Year from</span><input data-crosslink-search-filter="yearFrom" inputmode="numeric" maxlength="4" value="${escapeHtml(searchFilters.yearFrom || "")}" placeholder="Any"></label>
              <label><span>Year to</span><input data-crosslink-search-filter="yearTo" inputmode="numeric" maxlength="4" value="${escapeHtml(searchFilters.yearTo || "")}" placeholder="Any"></label>
              <label><span>DOI</span><select data-crosslink-search-filter="doi"><option value="any"${searchFilters.doi === "any" ? " selected" : ""}>Any</option><option value="with"${searchFilters.doi === "with" ? " selected" : ""}>With DOI</option><option value="without"${searchFilters.doi === "without" ? " selected" : ""}>Without DOI</option></select></label>
              <label><span>Tags</span><select data-crosslink-search-filter="tagged"><option value="any"${searchFilters.tagged === "any" ? " selected" : ""}>Any</option><option value="tagged"${searchFilters.tagged === "tagged" ? " selected" : ""}>Tagged</option><option value="untagged"${searchFilters.tagged === "untagged" ? " selected" : ""}>Untagged</option></select></label>
            </span>
          </span>
        </div>
      </div>`;
  }

  async function chooseCrosslinkEntries(entry) {
    const existing = normalizeCrosslinkKeys(entry.crosslinks, entry.key);
    const candidates = entries.filter((candidate) =>
      candidate !== entry
      && !existing.some((key) => crosslinkKeyMatchesEntry(key, candidate))
      && !isReadOnlySharedEntry(candidate.key)
    );
    if (!candidates.length) {
      setStatus("There are no additional writable entries available to crosslink.", true);
      return [];
    }
    const selected = new Set();
    const result = await showDialog({
      title: "Add crosslinks",
      message: "Select one or more bibliography entries. Reciprocal backlinks will be added automatically.",
      dialogClass: "ctca-crosslink-picker-dialog",
      controls: (host) => {
        const picker = document.createElement("div");
        picker.className = "ctca-crosslink-picker";
        picker.innerHTML = `${crosslinkSearchControlsHtml()}<div class="ctca-crosslink-picker-list"></div>`;
        host.appendChild(picker);
        const search = picker.querySelector(".ctca-crosslink-picker-search");
        const list = picker.querySelector(".ctca-crosslink-picker-list");
        let searchRenderTimer = null;
        let searchQuery = "";
        const render = () => {
          const visible = candidates.map((candidate) => ({
            candidate,
            ...globalThis.CollabTeXSearchTools.matchEntry(entrySearchModel(candidate), searchQuery, {
              includeAbstract: searchOptions.includeAbstract,
              includePdfText: searchOptions.includePdfText,
              includeNotesComments: searchOptions.includeNotesComments,
              filters: searchFilters
            })
          })).filter((item) => item.matched)
            .sort((left, right) => left.rank - right.rank || left.candidate.key.localeCompare(right.candidate.key))
            .map((item) => item.candidate);
          list.innerHTML = visible.map((candidate) => `
            <label class="ctca-crosslink-picker-row">
              <input type="checkbox" value="${escapeHtml(candidate.key)}" ${selected.has(candidate.key) ? "checked" : ""}>
              <span><strong>${escapeHtml(stripBibValue(candidate.fields?.title || candidate.key))}</strong><small>${escapeHtml(crosslinkAuthors(candidate))}</small><small>${crosslinkCitationHtml(candidate)}</small></span>
            </label>`).join("") || `<div class="ctca-crosslink-empty">No matching entries.</div>`;
          list.querySelectorAll("input[type=checkbox]").forEach((checkbox) => {
            checkbox.addEventListener("change", () => checkbox.checked ? selected.add(checkbox.value) : selected.delete(checkbox.value));
          });
        };
        const renderCurrentSearch = () => {
          window.clearTimeout(searchRenderTimer);
          searchRenderTimer = null;
          searchQuery = search.value;
          render();
        };
        const menu = picker.querySelector(".ctca-crosslink-search-menu");
        const config = picker.querySelector(".ctca-crosslink-search-config");
        const suggestions = picker.querySelector(".ctca-manager-tag-search-suggestions");
        const setMenuOpen = (open) => {
          menu.hidden = !open;
          config.setAttribute("aria-expanded", open ? "true" : "false");
        };
        const insert = (value, cursorBack = 0) => {
          const start = Number.isFinite(search.selectionStart) ? search.selectionStart : search.value.length;
          const end = Number.isFinite(search.selectionEnd) ? search.selectionEnd : search.value.length;
          search.setRangeText(value, start, end, "end");
          const next = Math.max(0, search.selectionStart - Number(cursorBack || 0));
          search.setSelectionRange(next, next);
          renderCurrentSearch();
          search.focus();
        };
        const refreshConfig = async () => {
          picker.querySelectorAll("[data-crosslink-search-option]").forEach((control) => {
            searchOptions[control.dataset.crosslinkSearchOption] = control.checked;
          });
          searchFilters = globalThis.CollabTeXSearchTools.normalizeFilterState(Object.fromEntries(
            [...picker.querySelectorAll("[data-crosslink-search-filter]")].map((control) => [control.dataset.crosslinkSearchFilter, control.value])
          ));
          const filterCount = globalThis.CollabTeXSearchTools.activeFilterCount(searchFilters);
          config.dataset.filterCount = filterCount ? String(filterCount) : "";
          config.classList.toggle("ctca-search-has-filters", filterCount > 0);
          if (searchOptions.includeNotesComments) await refreshNotesCommentsSearchCache(false);
          render();
          scheduleListRender();
          saveUiState().catch(() => {});
        };
        config.addEventListener("click", (event) => {
          event.preventDefault();
          event.stopPropagation();
          setMenuOpen(menu.hidden);
        });
        picker.querySelectorAll("[data-crosslink-search-insert]").forEach((button) => {
          button.addEventListener("click", () => insert(button.dataset.crosslinkSearchInsert || "", Number(button.dataset.crosslinkSearchCursorBack || 0)));
        });
        picker.querySelectorAll("[data-crosslink-search-option], [data-crosslink-search-filter]").forEach((control) => {
          control.addEventListener(control.matches("select, input[type=checkbox]") ? "change" : "input", () => refreshConfig().catch(() => {}));
        });
        picker.querySelector(".ctca-crosslink-search-clear-filters").addEventListener("click", () => {
          searchFilters = { type: "", yearFrom: "", yearTo: "", doi: "any", tagged: "any" };
          picker.querySelectorAll("[data-crosslink-search-filter]").forEach((control) => {
            control.value = ["doi", "tagged"].includes(control.dataset.crosslinkSearchFilter) ? "any" : "";
          });
          refreshConfig().catch(() => {});
        });
        search.addEventListener("input", () => {
          window.clearTimeout(searchRenderTimer);
          searchRenderTimer = window.setTimeout(() => {
            searchRenderTimer = null;
            searchQuery = search.value;
            render();
          }, SEARCH_RENDER_DELAY_MS);
          renderSearchTagSuggestions(search);
        });
        search.addEventListener("click", () => renderSearchTagSuggestions(search));
        search.addEventListener("focusout", () => {
          window.setTimeout(() => {
            suggestions.hidden = true;
            setInlineCompletionHint(search, "", "", ".ctca-manager-search-input-wrap");
          }, 120);
        });
        search.addEventListener("keydown", (event) => {
          if (handleInlineCompletionDeletion(event, search)) {
            return;
          } else if (event.key === "/" && !search.value) {
            event.preventDefault();
            setMenuOpen(true);
          } else if (event.key === "ArrowRight" && acceptInlineCompletion(search)) {
            event.preventDefault();
            renderCurrentSearch();
          } else if (event.key === "Escape" && !menu.hidden) {
            event.preventDefault();
            setMenuOpen(false);
          }
        });
        suggestions.addEventListener("mousedown", (event) => {
          const option = event.target.closest("[data-search-tag]");
          if (!option) return;
          event.preventDefault();
          if (acceptSearchTagSuggestion(search, option.dataset.searchTag || "")) {
            renderCurrentSearch();
            search.focus();
          }
        });
        picker.addEventListener("pointerdown", (event) => {
          if (!event.target.closest(".ctca-crosslink-search-composite")) setMenuOpen(false);
        });
        render();
      },
      buttons: [
        { label: "Cancel", value: null },
        { label: "Add selected", primary: true, getValue: () => [...selected] }
      ],
      closeValue: null
    });
    return Array.isArray(result) ? result : [];
  }

  function detailFieldOrderId(field) {
    const control = field.querySelector("[data-manager-property], [data-manager-field]");
    const name = control?.dataset.managerProperty || control?.dataset.managerField || "";
    return ["journal", "journaltitle", "booktitle"].includes(name) ? "publication" : name;
  }

  function bindDetailFieldReordering(container) {
    const form = container.querySelector(".ctca-manager-form-grid");
    if (!form) return;
    const fields = [...form.querySelectorAll(":scope > .ctca-manager-field")];
    const byId = new Map();
    for (const field of fields) {
      const id = detailFieldOrderId(field);
      if (!id) continue;
      field.dataset.detailField = id;
      field.classList.add("ctca-detail-field-reorderable");
      const handle = document.createElement("button");
      handle.type = "button";
      handle.className = "ctca-detail-field-drag";
      handle.draggable = true;
      handle.title = `Drag to reorder ${field.querySelector(":scope > span")?.textContent?.trim() || id}`;
      handle.setAttribute("aria-label", handle.title);
      handle.textContent = "⋮⋮";
      handle.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
      });
      field.appendChild(handle);
      byId.set(id, field);
    }
    for (const id of detailFieldOrder) {
      const field = byId.get(id);
      if (field) form.appendChild(field);
    }
    let dragged = null;
    form.querySelectorAll(".ctca-detail-field-drag").forEach((handle) => {
      handle.addEventListener("dragstart", (event) => {
        dragged = handle.closest(".ctca-manager-field");
        dragged?.classList.add("ctca-detail-field-dragging");
        event.dataTransfer.effectAllowed = "move";
        event.stopPropagation();
      });
    });
    form.addEventListener("dragover", (event) => {
      const target = event.target.closest(".ctca-manager-field");
      if (!dragged || !target || target === dragged || target.parentElement !== form) return;
      event.preventDefault();
      event.stopPropagation();
      const bounds = target.getBoundingClientRect();
      const after = !target.classList.contains("ctca-manager-field-wide")
        && event.clientY >= bounds.top && event.clientY <= bounds.bottom
        ? event.clientX > bounds.left + bounds.width / 2
        : event.clientY > bounds.top + bounds.height / 2;
      form.insertBefore(dragged, after ? target.nextSibling : target);
    });
    form.addEventListener("drop", (event) => {
      if (!dragged) return;
      event.preventDefault();
      event.stopPropagation();
      dragged.classList.remove("ctca-detail-field-dragging");
      dragged = null;
      detailFieldOrder = [...form.querySelectorAll(":scope > .ctca-manager-field")]
        .map((field) => field.dataset.detailField)
        .filter(Boolean);
      saveUiState().catch(() => {});
    });
    form.addEventListener("dragend", () => {
      dragged?.classList.remove("ctca-detail-field-dragging");
      dragged = null;
    });
  }

  function bindDetailSectionReordering(container) {
    bindDetailFieldReordering(container);
    const definitions = [
      ["metadata", ".ctca-manager-form-grid", "Bibliographic details"],
      ["tags", ".ctca-manager-tags", "Tags"],
      ["comments", ".ctca-manager-comments", "Comments"],
      ["crosslinks", ".ctca-manager-crosslinks", "Crosslinks"],
      ["categories", ".ctca-manager-entry-categories", "Categories"],
      ["attachments", ".ctca-manager-pdf-attachments", "PDF attachments"],
      ["extra", ".ctca-manager-extra-fields", "Additional fields"]
    ];
    const sections = new Map();
    for (const [id, selector, label] of definitions) {
      const section = container.querySelector(selector);
      if (!section) continue;
      section.dataset.detailSection = id;
      section.classList.add("ctca-detail-reorderable");
      if (!section.querySelector(".ctca-detail-section-drag")) {
        const handle = document.createElement("button");
        handle.type = "button";
        handle.className = "ctca-detail-section-drag";
        handle.draggable = true;
        handle.title = `Drag to reorder ${label}`;
        handle.setAttribute("aria-label", `Reorder ${label}`);
        handle.textContent = "⋮⋮";
        section.prepend(handle);
      }
      sections.set(id, section);
    }
    const anchor = container.querySelector(".ctca-manager-unsaved-note");
    for (const id of detailSectionOrder) {
      const section = sections.get(id);
      if (section) container.insertBefore(section, anchor);
    }
    let dragged = null;
    container.querySelectorAll(".ctca-detail-section-drag").forEach((handle) => {
      handle.addEventListener("dragstart", (event) => {
        dragged = handle.closest("[data-detail-section]");
        dragged?.classList.add("ctca-detail-section-dragging");
        event.dataTransfer.effectAllowed = "move";
      });
    });
    container.addEventListener("dragover", (event) => {
      const target = event.target.closest("[data-detail-section]");
      if (!dragged || !target || target === dragged || target.parentElement !== container) return;
      event.preventDefault();
      const after = event.clientY > target.getBoundingClientRect().top + target.offsetHeight / 2;
      container.insertBefore(dragged, after ? target.nextSibling : target);
    });
    container.addEventListener("drop", (event) => {
      if (!dragged) return;
      event.preventDefault();
      dragged.classList.remove("ctca-detail-section-dragging");
      dragged = null;
      detailSectionOrder = [...container.querySelectorAll(":scope > [data-detail-section]")].map((section) => section.dataset.detailSection);
      saveUiState().catch(() => {});
    });
    container.addEventListener("dragend", () => {
      dragged?.classList.remove("ctca-detail-section-dragging");
      dragged = null;
    });
  }

  function updateBibliographyDetailsVisibility() {
    const hasActiveSelection = (selectedKeys.size > 0 && Boolean(entryByKey(selectedKey))) || Boolean(entryByKey(detailOnlyKey));
    const hasAuthorImpact = globalThis.SmartCitationsOpenAlex.isAuthorCategory(selectedCategoryId);
    const noSelectionDetailsHidden = !hasActiveSelection && (!hasAuthorImpact || authorImpactCollapsed);
    const collapsed = bibliographyDetailsCollapsed || noSelectionDetailsHidden;
    root.classList.toggle("ctca-details-collapsed", collapsed);
    root.classList.toggle("ctca-details-no-selection", noSelectionDetailsHidden);
    const collapseButton = $(".ctca-manager-collapse-details", root);
    if (collapseButton) {
      collapseButton.title = collapsed ? "Expand detail pane" : "Collapse detail pane";
      collapseButton.setAttribute("aria-expanded", collapsed ? "false" : "true");
    }
  }

  function activeDetailEditor() {
    const active = document.activeElement;
    if (!(active instanceof HTMLElement)) return null;
    if (!active.closest(".ctca-manager-details, .ctca-pdf-entry-details")) return null;
    const richTextItem = active.closest(".ctca-note-item");
    if (richTextItem && !$(".ctca-rich-toolbar", richTextItem)?.hidden) return active;
    return active.matches("[data-manager-field], [data-manager-property], .ctca-manager-inline-editor, .ctca-comment-text, .ctca-tag-input")
      ? active
      : null;
  }

  function flushPendingDetailRender(delay = 0) {
    window.clearTimeout(detailRenderFlushTimer);
    detailRenderFlushTimer = window.setTimeout(() => {
      detailRenderFlushTimer = null;
      if (!detailRenderPending || activeDetailEditor()) return;
      detailRenderPending = false;
      renderDetails();
    }, delay);
  }

  function detailEditorKeydown(event) {
    if (event.isComposing || event.key !== "Enter") return;
    const control = event.target.closest("input[data-manager-field], input[data-manager-property], select[data-manager-property]");
    if (!control) return;
    event.preventDefault();
    control.blur();
    flushPendingDetailRender();
  }

  function detailEditorFocusOut(event) {
    if (!event.target.matches("[data-manager-field], [data-manager-property], .ctca-manager-inline-editor, .ctca-comment-text, .ctca-tag-input")
      && !event.target.closest(".ctca-note-item")) return;
    flushPendingDetailRender(180);
  }

  function renderDetails() {
    if (activeDetailEditor()) {
      detailRenderPending = true;
      return;
    }
    detailRenderPending = false;
    updateBibliographyDetailsVisibility();
    const container = $(".ctca-manager-details", root);
    const entry = selectedKeys.size ? entryByKey(selectedKey) : entryByKey(detailOnlyKey);
    renderOpenAlexAuthorImpactSlot();
    if (!entry) {
      delete container.dataset.detailEntryKey;
      container.innerHTML = `<div class="ctca-manager-empty-details">Select a bibliography entry.</div>`;
      if (activeWorkspaceTab !== "bibliography" && !renderingPdfEntryDetails) syncPdfEntryDetails();
      return;
    }
    container.dataset.detailEntryKey = entry.key;

    const fields = entry.fields || {};
    const journalField = fields.journal !== undefined
      ? "journal"
      : fields.journaltitle !== undefined
        ? "journaltitle"
        : fields.booktitle !== undefined
          ? "booktitle"
          : (["inproceedings", "incollection", "conference"].includes(entry.type) ? "booktitle" : "journal");
    const journalLabel = journalField === "booktitle" ? "Book / proceedings title" : "Journal";
    const extras = Object.keys(fields).filter((name) => !CORE_FIELDS.has(name) && name !== "ids").sort();
    const available = availableFields(entry);
    const title = fields.title || "Untitled paper";
    const authors = allAuthors(entry);

    container.innerHTML = `
      <div class="ctca-manager-detail-head">
        ${crosslinkNavigationStack.length ? `<button type="button" class="ctca-crosslink-back" data-manager-action="crosslink-back" title="Back to previous entry" aria-label="Back to previous entry">←</button>` : ""}
        <div class="ctca-manager-detail-heading-text">
          <div class="ctca-manager-detail-title" data-manager-inline-field="title" role="button" tabindex="0" title="Click to edit title">${latexHtml(title)}</div>
          <div class="ctca-manager-detail-authors" data-manager-inline-field="author" role="button" tabindex="0" title="Click to edit authors">${allAuthorsHtml(entry)}</div>
          ${entry.doiSyncedAt ? `<div class="ctca-manager-detail-doi-sync">🌐✓ DOI synchronized ${escapeHtml(formatDoiSyncDateTime(entry.doiSyncedAt))}</div>` : ""}
        </div>
        <div class="ctca-manager-detail-actions" data-detail-entry-key="${escapeHtml(entry.key)}"></div>
      </div>
      <div class="ctca-manager-form-grid">
        <label class="ctca-manager-field"><span>Entry type</span>
          <select data-manager-property="type">${ENTRY_TYPES.map((type) => `<option value="${type}" ${entry.type === type ? "selected" : ""}>${type}</option>`).join("")}</select>
        </label>
        <label class="ctca-manager-field"><span>Citation key</span><input data-manager-property="key" value="${escapeHtml(entry.key)}"></label>
        ${managerInput("Editors", "editor", fields.editor, { multiline: true, rows: 2, wide: true })}
        ${managerInput(journalLabel, journalField, fields[journalField], { wide: true, autocomplete: "journal" })}
        ${managerInput("Year", "year", fields.year)}
        ${managerInput("Volume", "volume", fields.volume)}
        ${managerInput("Pages / article number", "pages", fields.pages)}
        <label class="ctca-manager-field ctca-manager-field-wide"><span>DOI</span>
          <div class="ctca-manager-doi-row">
            <input data-manager-field="doi" value="${escapeHtml(fields.doi || "")}">
            <button type="button" data-manager-action="update-doi" title="Update this entry from DOI metadata">🌐</button>
          </div>
        </label>
        <label class="ctca-manager-field ctca-manager-field-wide"><span>URL</span>
          <div class="ctca-manager-url-row">
            <input data-manager-field="url" type="url" value="${escapeHtml(fields.url || "")}">
            <button type="button" data-manager-action="open-url" title="Open URL" aria-label="Open URL">↗</button>
          </div>
        </label>
        ${managerInput("Abstract", "abstract", fields.abstract, { multiline: true, rows: 8, wide: true })}
        ${managerInput("Keywords", "keywords", fields.keywords, { multiline: true, rows: 3, wide: true, autocomplete: "keywords" })}
        ${managerInput("Publisher", "publisher", fields.publisher, { wide: true })}
        ${managerInput("Institution", "institution", fields.institution, { wide: true })}
        ${managerInput("Note", "note", fields.note, { multiline: true, rows: 4, wide: true })}
      </div>
      ${tagEditorHtml(entry)}
      ${commentsEditorHtml(entry)}
      ${crosslinksEditorHtml(entry)}
      <div class="ctca-manager-entry-categories">
        <h3>Categories</h3>
        <div class="ctca-manager-entry-category-list">
          ${entryCategoryIds(entry.key).map((categoryId) => {
            const path = categoryPath(categoryId);
            return `<span class="ctca-manager-entry-category-chip" title="${escapeHtml(path)}"><span>${escapeHtml(path)}</span><button type="button" data-manager-action="remove-category-membership" data-category-id="${escapeHtml(categoryId)}" title="Remove from this category">🗑</button></span>`;
          }).join("") || `<span class="ctca-manager-no-category">Uncategorized. Drag the selected entry onto a category to assign it.</span>`}
        </div>
      </div>
      <section class="ctca-manager-pdf-attachments" data-entry-key="${escapeHtml(entry.key)}">
        <div class="ctca-manager-pdf-attachments-head"><h3>PDF attachments</h3><button type="button" class="ctca-manager-add-pdf" data-manager-action="add-pdf" ${pdfAttachmentLoadingKeys.has(entry.key) ? "disabled" : ""}>+ Attach PDF</button></div>
        <div class="ctca-manager-pdf-list"><div class="ctca-manager-no-pdf">Loading attachments…</div></div>
        <div class="ctca-manager-pdf-loading" data-entry-key="${escapeHtml(entry.key)}" role="status" aria-label="Loading PDF attachments" hidden><span class="ctca-manager-pdf-loading-spinner" aria-hidden="true"></span></div>
      </section>
      <div class="ctca-manager-extra-fields">
        <h3>Additional BibTeX fields</h3>
        <div class="ctca-manager-extra-list">
          ${extras.map((field) => `
            <label class="ctca-manager-extra-field">
              <span>${escapeHtml(field)}</span>
              <textarea data-manager-field="${escapeHtml(field)}" rows="2">${escapeHtml(fields[field] || "")}</textarea>
              <button type="button" data-manager-action="remove-field" data-field="${escapeHtml(field)}" title="Remove field">×</button>
            </label>
          `).join("") || `<div class="ctca-manager-no-extra">No additional fields.</div>`}
        </div>
        <div class="ctca-manager-add-field-row">
          <select class="ctca-manager-add-field-select" ${available.length ? "" : "disabled"}>${available.map((field) => `<option value="${escapeHtml(field)}">${escapeHtml(field)}</option>`).join("")}</select>
          <button type="button" data-manager-action="add-field" ${available.length ? "" : "disabled"}>+ Add field</button>
        </div>
      </div>
      <div class="ctca-manager-unsaved-note">Changes are saved automatically.</div>
      <div class="ctca-manager-remove-entry-row"><button type="button" class="ctca-manager-remove-entry" data-manager-action="remove-entry">Remove entry</button></div>
    `;
    const readOnlySharedEntry = isReadOnlySharedEntry(entry.key);
    if (!readOnlySharedEntry) bindPdfDropTarget(container, entry);
    if (readOnlySharedEntry) {
      container.querySelectorAll("input, textarea, select, button[data-manager-action]").forEach((control) => {
        if (control.matches('[data-manager-property="key"], [data-manager-action="open-url"], [data-manager-action="open-paper"], [data-manager-action="open-crosslink"], [data-manager-action="crosslink-back"]')) return;
        control.disabled = true;
      });
      container.querySelectorAll(".ctca-manager-comments button, .ctca-manager-comments textarea").forEach((control) => { control.disabled = true; });
      container.querySelectorAll(".ctca-manager-comments [contenteditable]").forEach((control) => {
        control.setAttribute("contenteditable", "false");
      });
      container.querySelectorAll(".ctca-manager-crosslinks .ctca-crosslink-drag").forEach((control) => { control.disabled = true; });
      container.querySelectorAll("[data-manager-inline-field]").forEach((control) => {
        control.removeAttribute("role");
        control.removeAttribute("tabindex");
        control.title = "This shared entry is read-only.";
      });
    }
    bindCommentsEditor(container, entry);
    bindCrosslinkReordering(container, entry);
    bindDetailSectionReordering(container);
    renderAttachmentList(entry).catch((error) => setStatus(error.message || String(error), true));
    syncPdfAttachmentLoadingIndicators();
    syncPdfEntryDetails();
  }

  function renderOpenAlexAuthorImpactSlot() {
    const column = $(".ctca-manager-details-column", root);
    const slot = $(".ctca-openalex-impact-slot", column);
    const visible = globalThis.SmartCitationsOpenAlex.isAuthorCategory(selectedCategoryId);
    column.classList.toggle("ctca-openalex-impact-visible", visible);
    slot.hidden = !visible;
    if (!visible) {
      slot.replaceChildren();
      return;
    }
    slot.innerHTML = globalThis.SmartCitationsOpenAlex.impactPlaceholderHtml();
    globalThis.SmartCitationsOpenAlex.bindImpactResize(slot, {
      height: authorImpactHeight,
      onChange: (height) => {
        authorImpactHeight = height;
        saveUiState().catch(() => {});
      }
    });
    globalThis.SmartCitationsOpenAlex.bindImpactCollapse(slot, {
      collapsed: authorImpactCollapsed,
      onChange: (collapsed) => {
        authorImpactCollapsed = collapsed;
        updateBibliographyDetailsVisibility();
        saveUiState().catch(() => {});
      }
    });
    const authoredEntries = entries.filter((entry) => Boolean(entryAuthorshipCategory(entry)));
    const descriptors = authoredEntries.map((entry) =>
      globalThis.SmartCitationsOpenAlex.descriptor(entry, entry.key)
    );
    globalThis.SmartCitationsOpenAlex.hydrateAuthorImpact(
      slot.querySelector(".ctca-openalex-impact"),
      descriptors,
      authorshipUserName
    ).catch(() => {});
  }

  function attachmentProviderLabel(attachment) {
    if (attachment?.provider === "nextcloud") return "Nextcloud";
    if (attachment?.provider === "local") return attachment.sessionOnly ? "Local disk link · temporary" : "Local disk link";
    return "Browser storage";
  }

  async function renderAttachmentList(entry) {
    const attachments = await globalThis.CollabTeXAttachmentStore.list(entry);
    let openTabChanged = false;
    for (const data of openPdfTabs.values()) {
      if (data.entryKey !== entry.key) continue;
      const currentAttachment = attachments.find((attachment) => attachment.id === data.attachment.id);
      if (currentAttachment) data.attachment = currentAttachment;
      data.attachmentCount = attachments.length;
      openTabChanged = true;
    }
    if (openTabChanged) renderWorkspaceTabs();
    const row = root.querySelector(`.ctca-manager-row[data-manager-record-id="${CSS.escape(entry.key)}"]`);
    updateRowPdfAction(row, entry, attachments);
    const activePdfEntryKey = openPdfTabs.get(activeWorkspaceTab)?.entryKey || "";
    const renderedInPdfDetails = Boolean(
      root.querySelector(`.ctca-pdf-entry-details[data-detail-entry-key="${CSS.escape(entry.key)}"]`)
    );
    if (selectedKey !== entry.key && activePdfEntryKey !== entry.key && !renderedInPdfDetails) return;

    const detailActionsHtml = attachments.length
      ? `<button type="button" data-manager-action="open-pdf" data-attachment-id="${escapeHtml(attachments[0].id)}">Open PDF ↗</button>`
      : specifiedHttpUrl(entry)
        ? `<button type="button" class="ctca-manager-detail-get-pdf" data-manager-action="get-pdf-from-web">${downloadIconHtml()}<span>Get PDF from web</span></button>`
        : "";
    root.querySelectorAll(`.ctca-manager-detail-actions[data-detail-entry-key="${CSS.escape(entry.key)}"]`).forEach((detailActions) => {
      detailActions.innerHTML = detailActionsHtml;
    });

    const listHtml = attachments.length
      ? attachments.map((attachment) => `
        <div class="ctca-manager-pdf-row" data-attachment-id="${escapeHtml(attachment.id)}">
          <button type="button" class="ctca-manager-pdf-reorder" draggable="${attachments.length > 1 ? "true" : "false"}" ${attachments.length > 1 ? "" : "disabled"} title="Drag to reorder PDF" aria-label="Reorder ${escapeHtml(attachment.name)}">⋮⋮</button>
          <div class="ctca-manager-pdf-name" title="${escapeHtml(attachment.name)}">${escapeHtml(attachment.name)}</div>
          <div class="ctca-manager-pdf-meta">${escapeHtml(attachmentProviderLabel(attachment))}${attachment.fileName ? ` · ${escapeHtml(attachment.fileName)}` : ""}${attachment.size ? ` · ${(attachment.size / 1024 / 1024).toFixed(1)} MB` : ""}</div>
          <div class="ctca-manager-pdf-actions">
            <button type="button" class="ctca-manager-pdf-icon-action" data-label="Open" data-manager-action="open-pdf" data-attachment-id="${escapeHtml(attachment.id)}" aria-label="Open ${escapeHtml(attachment.name)}">${pdfAttachmentActionIconHtml("open")}</button>
            <button type="button" class="ctca-manager-pdf-icon-action ctca-manager-pdf-download" data-label="Download" data-manager-action="download-pdf" data-attachment-id="${escapeHtml(attachment.id)}" aria-label="Download ${escapeHtml(attachment.name)}">${downloadIconHtml()}</button>
            <button type="button" class="ctca-manager-pdf-icon-action ctca-manager-pdf-notes-toggle" data-label="Notes" data-attachment-id="${escapeHtml(attachment.id)}" aria-label="Show notes for ${escapeHtml(attachment.name)}" aria-expanded="false">${pdfAttachmentActionIconHtml("notes")}</button>
            <button type="button" class="ctca-manager-pdf-icon-action" data-label="Rename" data-manager-action="rename-pdf" data-attachment-id="${escapeHtml(attachment.id)}" aria-label="Rename ${escapeHtml(attachment.name)}">${pdfAttachmentActionIconHtml("rename")}</button>
            ${attachment.provider !== "local" ? `<button type="button" class="ctca-manager-pdf-icon-action" data-label="Replace" data-manager-action="replace-pdf" data-attachment-id="${escapeHtml(attachment.id)}" aria-label="Replace ${escapeHtml(attachment.name)}">${pdfAttachmentActionIconHtml("replace")}</button>` : ""}
            <button type="button" class="ctca-manager-pdf-icon-action ctca-manager-pdf-remove" data-label="Remove" data-manager-action="remove-pdf" data-attachment-id="${escapeHtml(attachment.id)}" aria-label="Remove ${escapeHtml(attachment.name)}">${pdfAttachmentActionIconHtml("remove")}</button>
          </div>
          <div class="ctca-manager-pdf-notes-preview" hidden>
            ${normalizedPdfNoteItems(attachment).map((note) => `<div class="ctca-rich-note-preview" data-note-id="${escapeHtml(note.id)}" style="${escapeHtml(richTextItemStyle(note))}">${note.html || "<em>Empty note</em>"}</div>`).join("") || "<em>No notes for this attachment.</em>"}
          </div>
        </div>`).join("")
      : `<div class="ctca-manager-no-pdf">No PDF attachments. Multiple named PDFs can be attached to each entry.</div>`;

    root.querySelectorAll(`.ctca-manager-pdf-attachments[data-entry-key="${CSS.escape(entry.key)}"] .ctca-manager-pdf-list`).forEach((list) => {
      list.innerHTML = listHtml;
      bindAttachmentReordering(list, entry, attachments);
      bindAttachmentNoteToggles(list);
    });
  }

  function bindAttachmentNoteToggles(list) {
    list.querySelectorAll(".ctca-manager-pdf-notes-toggle").forEach((button) => {
      button.addEventListener("click", () => {
        const preview = button.closest(".ctca-manager-pdf-row")?.querySelector(".ctca-manager-pdf-notes-preview");
        if (!preview) return;
        preview.hidden = !preview.hidden;
        button.setAttribute("aria-expanded", preview.hidden ? "false" : "true");
        button.classList.toggle("ctca-manager-pdf-notes-toggle-active", !preview.hidden);
      });
    });
  }

  function reorderedAttachmentIds(attachments, sourceId, targetId, placeAfter) {
    const ids = attachments.map((attachment) => attachment.id);
    if (sourceId === targetId || !ids.includes(sourceId) || !ids.includes(targetId)) return ids;
    ids.splice(ids.indexOf(sourceId), 1);
    const targetIndex = ids.indexOf(targetId);
    ids.splice(targetIndex + (placeAfter ? 1 : 0), 0, sourceId);
    return ids;
  }

  function bindAttachmentReordering(list, entry, attachments) {
    if (!list || attachments.length < 2) return;
    let saving = false;
    const clearDropState = () => {
      list.querySelectorAll(".ctca-manager-pdf-drop-before, .ctca-manager-pdf-drop-after, .ctca-manager-pdf-reordering")
        .forEach((row) => row.classList.remove("ctca-manager-pdf-drop-before", "ctca-manager-pdf-drop-after", "ctca-manager-pdf-reordering"));
    };
    const persistOrder = async (orderedIds) => {
      if (saving || orderedIds.every((id, index) => id === attachments[index]?.id)) return;
      saving = true;
      try {
        await globalThis.CollabTeXAttachmentStore.reorder(entry, orderedIds);
        await renderAttachmentList(entry);
        setStatus("PDF attachment order saved.");
      } catch (error) {
        setStatus(error?.message || String(error), true);
        await renderAttachmentList(entry);
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
        const orderedIds = reorderedAttachmentIds(attachments, sourceId, row.dataset.attachmentId || "", placeAfter);
        clearDropState();
        persistOrder(orderedIds);
      });
    });
  }

  async function downloadPdfAttachment(attachment) {
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

  function syncPdfAttachmentLoadingIndicators() {
    root.querySelectorAll(".ctca-manager-row[data-manager-record-id]").forEach((row) => {
      const loading = pdfAttachmentLoadingKeys.has(row.dataset.managerRecordId || "");
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
    root.querySelectorAll(".ctca-manager-pdf-loading[data-entry-key]").forEach((indicator) => {
      const loading = pdfAttachmentLoadingKeys.has(indicator.dataset.entryKey || "");
      indicator.hidden = !loading;
      const addButton = indicator.closest(".ctca-manager-pdf-attachments")?.querySelector(".ctca-manager-add-pdf");
      if (addButton) addButton.disabled = loading;
    });
  }

  function localPathToUrl(value) {
    const text = String(value || "").trim();
    if (/^[a-z][a-z0-9+.-]*:/i.test(text)) return text;
    if (/^[A-Za-z]:[\\/]/.test(text)) return `file:///${text.replace(/\\/g, "/")}`;
    if (text.startsWith("/")) return `file://${text}`;
    return text;
  }


  function conflictEntryLabel(entry, fallback) {
    if (!entry) return fallback || "Deleted entry";
    const title = stripBibValue(entry.fields?.title || "Untitled reference");
    return `${entry.key || fallback || "Reference"} — ${title}`;
  }

  function formatNextcloudConflictEntry(entry) {
    if (!entry) return "This version contains no entry (deleted or absent).";
    const lines = [
      `Citation key: ${entry.key || ""}`,
      `Entry type: ${entry.type || "misc"}`
    ];
    for (const [name, value] of Object.entries(entry.fields || {}).sort(([left], [right]) => left.localeCompare(right))) {
      lines.push(`${name}: ${stripBibValue(value)}`);
    }
    if ((entry.aliases || []).length) lines.push(`Aliases: ${entry.aliases.join(", ")}`);
    if ((entry.tags || []).length) lines.push(`Tags: ${entry.tags.join(", ")}`);
    if (entry.doiSyncedAt) lines.push(`DOI metadata synchronized: ${entry.doiSyncedAt}`);
    if (entry.updatedAt) lines.push(`Last local update: ${entry.updatedAt}`);
    return lines.join("\n");
  }

  function addNextcloudConflictDetails(row, conflict) {
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
      pre.textContent = formatNextcloudConflictEntry(entry);
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

  async function resolveNextcloudBibliographyConflicts(syncResult) {
    const choices = {};
    const result = await showDialog({
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
          row.dataset.conflictIdentity = conflict.identity;
          const group = `ctca-cloud-${Math.random().toString(36).slice(2)}`;
          const localLabel = conflictEntryLabel(conflict.local, conflict.identity);
          const remoteLabel = conflictEntryLabel(conflict.remote, conflict.identity);
          row.innerHTML = `
            <legend>${escapeHtml(conflict.reason || "Conflicting changes")}</legend>
            <div class="ctca-nextcloud-conflict-identity">${escapeHtml(conflict.identity)}</div>
            <label><input type="radio" name="${group}" value="local" checked> <span><strong>Use browser version</strong><small>${escapeHtml(localLabel)}</small></span></label>
            <label><input type="radio" name="${group}" value="remote"> <span><strong>Use Nextcloud version</strong><small>${escapeHtml(remoteLabel)}</small></span></label>`;
          addNextcloudConflictDetails(row, conflict);
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
    await loadDatabase();
    selectedKey = entries.some((entry) => entry.key === selectedKey) ? selectedKey : entries[0]?.key || "";
    renderAll();
    setStatus("Nextcloud bibliography conflicts resolved and synchronized.");
    return true;
  }

  async function synchronizeNextcloud({ showSuccess = false, resolveConflicts = true } = {}) {
    if (nextcloudSyncInProgress) return null;
    const config = await globalThis.CollabTeXAttachmentStore.getConfig();
    if (!config.nextcloud?.appPassword) return null;
    const retryAttempt = nextcloudSyncFailureCount > 0 ? nextcloudSyncFailureCount + 1 : 0;
    if (retryAttempt) setStatus(`Retrying Nextcloud synchronization (attempt ${retryAttempt})…`);
    nextcloudSyncInProgress = true;
    try {
      await globalThis.CollabTeXAttachmentStore.syncNextcloud();
      const result = await globalThis.CollabTeXAttachmentStore.syncBibliographyNextcloud();
      if (result?.status === "conflict") {
        if (!resolveConflicts) return result;
        if (appDialog.classList.contains("ctca-app-dialog-visible")) {
          scheduleNextcloudSync(1500);
          return result;
        }
        await resolveNextcloudBibliographyConflicts(result);
      } else if (result?.database) {
        await loadDatabase();
        selectedKey = entries.some((entry) => entry.key === selectedKey) ? selectedKey : entries[0]?.key || "";
        renderAll();
      }
      const sharedResult = await globalThis.CollabTeXAttachmentStore.syncSharedCategories();
      if (sharedResult.synchronized || sharedResult.errors.length) {
        await loadDatabase();
        selectedKey = entries.some((entry) => entry.key === selectedKey) ? selectedKey : entries[0]?.key || "";
        renderAll();
      }
      const recovered = nextcloudSyncFailureCount > 0;
      nextcloudSyncFailureCount = 0;
      window.clearTimeout(nextcloudSyncRetryTimer);
      nextcloudSyncRetryTimer = null;
      if (sharedResult.errors.length) {
        setStatus(`${sharedResult.errors.length} shared categor${sharedResult.errors.length === 1 ? "y" : "ies"} could not be synchronized.`, true);
      } else if (showSuccess || recovered) {
        setStatus("Nextcloud synchronization completed.");
      }
      return result;
    } catch (error) {
      const message = error?.message || String(error);
      if (/failed to fetch/i.test(message)) {
        nextcloudSyncFailureCount += 1;
        setStatus(
          `Nextcloud synchronization failed: ${message}. Retrying in ${NEXTCLOUD_SYNC_RETRY_DELAY_MS / 1000} seconds.`,
          true
        );
        scheduleNextcloudSyncRetry();
      } else {
        nextcloudSyncFailureCount = 0;
        window.clearTimeout(nextcloudSyncRetryTimer);
        nextcloudSyncRetryTimer = null;
        setStatus(`Nextcloud synchronization failed: ${message}`, true);
      }
      return null;
    } finally {
      finishCurrentNextcloudSync();
    }
  }

  function waitForCurrentNextcloudSync() {
    if (!nextcloudSyncInProgress) return Promise.resolve();
    return new Promise((resolve) => {
      nextcloudSyncWaiters.push(resolve);
    });
  }

  function finishCurrentNextcloudSync() {
    nextcloudSyncInProgress = false;
    const waiters = nextcloudSyncWaiters;
    nextcloudSyncWaiters = [];
    waiters.forEach((resolve) => resolve());
  }

  function scheduleNextcloudSync(delay = 900) {
    window.clearTimeout(nextcloudSyncTimer);
    nextcloudSyncTimer = window.setTimeout(() => {
      nextcloudSyncTimer = null;
      if (busy) {
        scheduleNextcloudSync(1500);
        return;
      }
      synchronizeNextcloud().catch(() => {});
    }, delay);
  }

  function scheduleNextcloudSyncRetry(delay = NEXTCLOUD_SYNC_RETRY_DELAY_MS) {
    window.clearTimeout(nextcloudSyncRetryTimer);
    nextcloudSyncRetryTimer = window.setTimeout(() => {
      nextcloudSyncRetryTimer = null;
      if (busy || nextcloudSyncInProgress) {
        scheduleNextcloudSyncRetry(1500);
        return;
      }
      synchronizeNextcloud().catch(() => {});
    }, delay);
  }

  async function propagateRemovedEntriesToNextcloud(removedEntries) {
    if (!syncNextcloudBibliography || !removedEntries?.length) return;
    window.clearTimeout(nextcloudSyncTimer);
    nextcloudSyncTimer = null;
    setStatus(
      `Deleting ${removedEntries.length} entr${removedEntries.length === 1 ? "y" : "ies"} from Nextcloud…`
    );
    const waitDeadline = Date.now() + 30000;
    while (nextcloudSyncInProgress && Date.now() < waitDeadline) {
      await new Promise((resolve) => window.setTimeout(resolve, 100));
    }
    if (nextcloudSyncInProgress) {
      setStatus("The local removal was saved, but the active Nextcloud synchronization did not finish in time.", true);
      return;
    }
    nextcloudSyncInProgress = true;
    try {
      const result = await globalThis.CollabTeXAttachmentStore.deleteBibliographyEntriesNextcloud(removedEntries);
      if (result?.status === "deleted") {
        setStatus(
          `Removed ${result.deleted} entr${result.deleted === 1 ? "y" : "ies"} locally and from Nextcloud.`
        );
      } else {
        setStatus("The local removal is saved; Nextcloud will be brought up to date by synchronization.");
      }
    } catch (error) {
      setStatus(
        `The local removal was saved, but deletion from Nextcloud failed: ${error?.message || String(error)}`,
        true
      );
      return;
    } finally {
      finishCurrentNextcloudSync();
    }
    scheduleNextcloudSync(0);
  }

  async function openOptionsPage() {
    try {
      await extensionApi.runtime.openOptionsPage();
    } catch (error) {
      setStatus(error?.message || "Smart Citations options could not be opened.", true);
    }
  }

  async function openPdfStorageSettings() {
    const config = await globalThis.CollabTeXAttachmentStore.getConfig();
    let providerSelect, serverInput, directoryInput, syncBibliographyInput, statusNode;
    await showDialog({
      title: "Nextcloud and PDF storage settings",
      message: "Connect Nextcloud, choose the default PDF storage, and optionally synchronize the global bibliography through its BibTeX file. Existing attachments keep their current storage type.",
      controls: (container) => {
        const wrapper = document.createElement("div");
        wrapper.className = "ctca-pdf-dialog-grid";
        wrapper.innerHTML = `
          <label class="ctca-app-dialog-field"><span>Default storage</span><select class="ctca-pdf-default-provider"><option value="browser">Browser storage</option><option value="nextcloud">Nextcloud</option><option value="local">Local disk link</option></select></label>
          <div class="ctca-nextcloud-settings">
            <strong>Nextcloud client login flow</strong>
            <label class="ctca-app-dialog-field"><span>Nextcloud server</span><input type="url" class="ctca-nextcloud-server" placeholder="https://cloud.example.org"></label>
            <label class="ctca-app-dialog-field"><span>Directory</span><input type="text" class="ctca-nextcloud-directory" placeholder="Smart Citations"></label>
            <label class="ctca-app-dialog-check"><input type="checkbox" class="ctca-nextcloud-sync-bibliography"> Synchronize the global bibliography through global-bibliography.bib</label>
            <div><button type="button" class="ctca-nextcloud-connect">Connect / reconnect</button> <button type="button" class="ctca-nextcloud-sync">Synchronize now</button></div>
            <div class="ctca-nextcloud-status"></div>
          </div>
          <p class="ctca-local-link-warning">Local-disk links store only the path or URL. Browser security may require enabling file-URL access. Saving inline annotations converts the attachment to browser storage because extensions cannot silently overwrite an arbitrary local path.</p>`;
        container.appendChild(wrapper);
        providerSelect = $(".ctca-pdf-default-provider", wrapper);
        serverInput = $(".ctca-nextcloud-server", wrapper);
        directoryInput = $(".ctca-nextcloud-directory", wrapper);
        statusNode = $(".ctca-nextcloud-status", wrapper);
        syncBibliographyInput = $(".ctca-nextcloud-sync-bibliography", wrapper);
        const setConnectionStatus = (message, state = "neutral") => {
          statusNode.textContent = message;
          statusNode.classList.toggle("ctca-nextcloud-status-success", state === "success");
          statusNode.classList.toggle("ctca-nextcloud-status-error", state === "error");
        };
        providerSelect.value = config.provider || "browser";
        serverInput.value = config.nextcloud?.server || "";
        directoryInput.value = config.nextcloud?.directory || "Smart Citations";
        syncBibliographyInput.checked = Boolean(config.nextcloud?.syncBibliography);
        if (config.nextcloud?.appPassword) {
          setConnectionStatus(`Connected to Nextcloud as ${config.nextcloud.loginName}.`, "success");
        } else {
          setConnectionStatus("Not connected.");
        }
        $(".ctca-nextcloud-connect", wrapper).addEventListener("click", async (event) => {
          event.currentTarget.disabled = true;
          try {
            await globalThis.CollabTeXAttachmentStore.connectNextcloud(serverInput.value, directoryInput.value, (message) => {
              setConnectionStatus(message, String(message).startsWith("Connected to Nextcloud as ") ? "success" : "neutral");
            });
            providerSelect.value = "nextcloud";
          } catch (error) {
            setConnectionStatus(error.message || String(error), "error");
          } finally { event.currentTarget.disabled = false; }
        });
        $(".ctca-nextcloud-sync", wrapper).addEventListener("click", async (event) => {
          event.currentTarget.disabled = true;
          try {
            const current = await globalThis.CollabTeXAttachmentStore.getConfig();
            current.nextcloud = { ...(current.nextcloud || {}), syncBibliography: Boolean(syncBibliographyInput.checked) };
            await globalThis.CollabTeXAttachmentStore.saveConfig(current);
            setConnectionStatus("Synchronizing Nextcloud…");
            const result = await synchronizeNextcloud({ showSuccess: false, resolveConflicts: false });
            if (result?.status === "conflict") {
              setConnectionStatus("Bibliography conflicts were detected. Save and close settings to resolve them.", "error");
            } else {
              setConnectionStatus("Nextcloud synchronization completed.", "success");
            }
            const entry = entryByKey(selectedKey); if (entry) await renderAttachmentList(entry);
          } catch (error) { setConnectionStatus(error.message || String(error), "error"); }
          finally { event.currentTarget.disabled = false; }
        });
      },
      buttons: [
        { label: "Cancel", value: null },
        { label: "Save settings", primary: true, getValue: () => ({ provider: providerSelect.value, server: serverInput.value, directory: directoryInput.value, syncBibliography: syncBibliographyInput.checked }) }
      ],
      closeValue: null
    }).then(async (result) => {
      if (!result) return;
      const next = await globalThis.CollabTeXAttachmentStore.getConfig();
      next.provider = result.provider;
      next.nextcloud = { ...(next.nextcloud || {}), server: result.server.trim(), directory: result.directory.trim() || "Smart Citations", syncBibliography: Boolean(result.syncBibliography) };
      await globalThis.CollabTeXAttachmentStore.saveConfig(next);
      setStatus("Cloud and PDF storage settings saved.");
      scheduleNextcloudSync(50);
    });
  }

  function setPdfViewAttachmentProgress(visible, label = "Downloading and attaching PDF…") {
    let overlay = $(".ctca-pdf-view-attachment-progress", root);
    if (!overlay) {
      overlay = document.createElement("div");
      overlay.className = "ctca-pdf-view-attachment-progress";
      overlay.hidden = true;
      overlay.setAttribute("role", "status");
      overlay.setAttribute("aria-live", "polite");
      overlay.innerHTML = `
        <div class="ctca-pdf-view-attachment-progress-card">
          <span class="ctca-pdf-view-attachment-progress-spinner" aria-hidden="true"></span>
          <span class="ctca-pdf-view-attachment-progress-label"></span>
        </div>`;
      root.appendChild(overlay);
    }
    $(".ctca-pdf-view-attachment-progress-label", overlay).textContent = label;
    overlay.hidden = !visible;
    overlay.setAttribute("aria-hidden", visible ? "false" : "true");
  }

  function validJournalManuscriptUrl(value) {
    try {
      const url = new URL(String(value || ""));
      return /^https?:$/.test(url.protocol) ? url.href : "";
    } catch (_error) {
      return "";
    }
  }

  async function showPdfViewAttachmentFailure(error, journalUrl = "") {
    const message = error?.message || String(error || "Unknown error");
    const manuscriptUrl = validJournalManuscriptUrl(journalUrl);
    setStatus(message, true);
    const choice = await showDialog({
      title: "PDF attachment failed",
      message: `The PDF could not be downloaded or attached.\n\n${message}`,
      buttons: [
        { label: "OK", value: "ok", primary: !manuscriptUrl },
        ...(manuscriptUrl
          ? [{ label: "Go to journal manuscript site", value: "journal", primary: true }]
          : [])
      ],
      closeValue: "ok"
    });
    if (choice === "journal") await openPdfLinkInBrowser(manuscriptUrl);
  }

  async function openAddPdfDialog(entry, options = {}) {
    const config = await globalThis.CollabTeXAttachmentStore.getConfig();
    const sourceUrl = options.sourceUrl || specifiedHttpUrl(entry);
    const fromPdfView = options.fromPdfView === true || activeWorkspaceTab !== "bibliography";
    const failureJournalUrl = options.failureJournalUrl || sourceUrl;
    const initialFiles = globalThis.CollabTeXPdfImport.pdfFiles(options.files || []);
    let selectedProvider = (options.getFromWeb || initialFiles.length) && config.provider === "local" ? "browser" : (config.provider || "browser");
    let fileInput = null;
    let fileRows = null;
    let localPanel = null;
    let localPathInput = null;
    let localNameRows = null;
    let localPermissionButton = null;
    let localPermissionStatus = null;
    let selectedFiles = [...initialFiles];
    let localNames = [];
    let webCandidates = [];
    let webResultRows = null;
    let webScanUrl = sourceUrl;
    let webResumeTabId = null;
    let webHumanCheckEncountered = false;
    const webOpenTabIds = new Set();

    const result = await showDialog({
      title: `Attach PDF to ${entry.key}`,
      message: options.getFromWebFile
        ? "The journal PDF is selected. Choose where it should be kept, then attach it."
        : "Choose where the PDF should be kept. You can attach several PDFs and name each attachment separately.",
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
          <div class="ctca-pdf-browse-row">
            ${sourceUrl ? `<button type="button" class="ctca-pdf-get-web">Get from web</button>` : ""}
            <button type="button" class="ctca-pdf-browse">Browse PDF file(s)…</button>
            <span class="ctca-pdf-browse-summary">No PDF selected</span>
            <input type="file" accept=".pdf,application/pdf,application/x-pdf" multiple hidden>
          </div>
          ${sourceUrl ? `
          <div class="ctca-web-pdf-panel" hidden>
            <div class="ctca-web-pdf-status" aria-live="polite">Ready to inspect ${escapeHtml(sourceUrl)}</div>
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
        fileInput = wrapper.querySelector('input[type="file"]');
        fileRows = wrapper.querySelector('.ctca-pdf-file-name-list');
        localPanel = wrapper.querySelector('.ctca-local-path-panel');
        localPathInput = wrapper.querySelector('.ctca-local-path-input');
        localNameRows = wrapper.querySelector('.ctca-local-path-name-list');
        localPermissionButton = wrapper.querySelector('.ctca-local-permission-button');
        localPermissionStatus = wrapper.querySelector('.ctca-local-permission-status');
        const browseRow = wrapper.querySelector('.ctca-pdf-browse-row');
        const summary = wrapper.querySelector('.ctca-pdf-browse-summary');
        const providerButtons = [...wrapper.querySelectorAll('.ctca-pdf-provider-choice')];
        const getWebButton = wrapper.querySelector(".ctca-pdf-get-web");
        const webPanel = wrapper.querySelector(".ctca-web-pdf-panel");
        const webStatus = wrapper.querySelector(".ctca-web-pdf-status");
        const webPermissionLink = wrapper.querySelector(".ctca-web-file-permission-link");
        const continueWebButton = wrapper.querySelector(".ctca-web-pdf-continue");
        const webResults = wrapper.querySelector(".ctca-web-pdf-results");
        webResultRows = webResults;

        const localPaths = () => String(localPathInput.value || "")
          .split(/\r?\n/)
          .map((value) => value.trim())
          .filter(Boolean);
        const pathFileName = (value) => {
          const clean = String(value || "").trim().replace(/^['"]|['"]$/g, "").replace(/\\/g, "/");
          const last = clean.split("/").pop() || "Local PDF";
          try { return decodeURIComponent(last); } catch (_error) { return last; }
        };
        const refreshLocalPermissionStatus = async () => {
          try {
            const granted = await globalThis.CollabTeXAttachmentStore.isLocalFilePermissionGranted();
            localPermissionStatus.textContent = granted ? "Local-file access is granted." : "Local-file access is not currently granted.";
            localPermissionStatus.classList.toggle("ctca-local-permission-granted", granted);
          } catch (_error) {
            localPermissionStatus.textContent = "Local-file access status could not be determined.";
          }
        };
        localPermissionButton.addEventListener("click", async () => {
          localPermissionButton.disabled = true;
          localPermissionStatus.textContent = "Enable local-file access on the extension page.";
          try {
            await globalThis.CollabTeXAttachmentStore.openLocalFilePermissionSettings();
          } catch (error) {
            localPermissionStatus.textContent = error?.message || String(error);
          } finally {
            localPermissionButton.disabled = false;
          }
        });
        webPermissionLink?.addEventListener("click", (event) => {
          event.preventDefault();
          globalThis.CollabTeXAttachmentStore.openLocalFilePermissionSettings().catch(() => null);
        });
        refreshLocalPermissionStatus();

        const renderSelectedFiles = () => {
          summary.textContent = selectedFiles.length ? `${selectedFiles.length} PDF${selectedFiles.length === 1 ? "" : "s"} selected` : "No PDF selected";
          fileRows.replaceChildren();
          selectedFiles.forEach((file, index) => {
            const label = document.createElement("label");
            label.className = "ctca-app-dialog-field";
            label.innerHTML = `<span>Name for ${escapeHtml(file.name)}</span><input type="text" data-pdf-name-index="${index}" value="Manuscript">`;
            fileRows.appendChild(label);
          });
        };
        const renderWebCandidates = () => {
          webResults?.replaceChildren();
          webCandidates.forEach((candidate, index) => {
            const row = document.createElement("label");
            row.className = "ctca-web-pdf-result";
            row.title = candidate.url;
            row.innerHTML = `
              <input type="checkbox" data-web-pdf-index="${index}" ${index === 0 ? "checked" : ""}>
              <span class="ctca-web-pdf-result-copy">
                <strong>${escapeHtml(candidate.fileName || `PDF ${index + 1}`)}</strong>
                <input type="text" data-web-pdf-name-index="${index}" value="${escapeHtml(candidate.name || `PDF ${index + 1}`)}" aria-label="Attachment name">
              </span>`;
            webResults.appendChild(row);
          });
        };
        const scanWebPage = async (continueExistingTab = false) => {
          webPanel.hidden = false;
          webPanel.dataset.expanded = "true";
          getWebButton.disabled = true;
          continueWebButton.disabled = true;
          continueWebButton.hidden = true;
          webStatus.removeAttribute("title");
          webStatus.textContent = "Opening the webpage in the background and looking for PDFs…";
          webStatus.classList.remove("ctca-web-pdf-status-error");
          webStatus.classList.add("ctca-web-pdf-status-loading");
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
              webStatus.textContent = "This page is still loading. Please go to the tab I just opened, complete any human test there might be and then come back to click Continue looking for PDFs.";
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
              webStatus.textContent = "This site requires a human check. Complete it in the journal tab. When that page changes URL, Smart Citations will switch back and continue looking for PDFs automatically. If it does not, return here and click Continue looking for PDFs.";
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
              webStatus.textContent = "The webpage forwarded to another site. Click Get from web again to grant access there and continue.";
              return;
            }
            webCandidates = (found.candidates || []).slice(0, 4);
            renderWebCandidates();
            webStatus.textContent = webCandidates.length
              ? `${webCandidates.length} PDF${webCandidates.length === 1 ? "" : "s"} found. Select the files to attach.`
              : "No PDF files were found on this webpage.";
          } catch (error) {
            webCandidates = [];
            renderWebCandidates();
            webStatus.textContent = error.message || String(error);
            webStatus.title = webStatus.textContent;
            webStatus.classList.add("ctca-web-pdf-status-error");
            console.error("[Smart Citations] Web PDF discovery failed.", error);
          } finally {
            getWebButton.disabled = false;
            continueWebButton.disabled = false;
            webStatus.classList.remove("ctca-web-pdf-status-loading");
          }
        };
        getWebButton?.addEventListener("click", () => scanWebPage(false));
        continueWebButton?.addEventListener("click", () => scanWebPage(true));
        const renderLocalPaths = () => {
          const oldInputs = [...localNameRows.querySelectorAll('[data-local-name-index]')];
          oldInputs.forEach((input, index) => { localNames[index] = input.value; });
          const paths = localPaths();
          localNameRows.replaceChildren();
          paths.forEach((path, index) => {
            const fileName = pathFileName(path);
            const defaultName = fileName.replace(/\.pdf$/i, "") || `PDF ${index + 1}`;
            const label = document.createElement("label");
            label.className = "ctca-app-dialog-field";
            label.innerHTML = `<span>Name for ${escapeHtml(fileName)}</span><input type="text" data-local-name-index="${index}" value="${escapeHtml(localNames[index] || defaultName)}">`;
            localNameRows.appendChild(label);
          });
          localNames.length = paths.length;
        };
        const updateProvider = (provider, resetFiles = true) => {
          selectedProvider = provider || "browser";
          providerButtons.forEach((button) => {
            const selected = button.dataset.provider === selectedProvider;
            button.classList.toggle('ctca-pdf-provider-choice-selected', selected);
            button.setAttribute('aria-pressed', selected ? 'true' : 'false');
          });
          const local = selectedProvider === "local";
          const selectedLocalFiles = local && selectedFiles.length > 0;
          browseRow.hidden = local && !selectedLocalFiles;
          fileRows.hidden = local && !selectedLocalFiles;
          localPanel.hidden = !local || selectedLocalFiles;
          if (getWebButton) getWebButton.hidden = local;
          if (webPanel) webPanel.hidden = local || webPanel.dataset.expanded !== "true";
          if (resetFiles) {
            selectedFiles = [];
            fileInput.value = "";
            renderSelectedFiles();
          }
          if (local) window.setTimeout(() => localPathInput.focus(), 0);
        };
        providerButtons.forEach((button) => button.addEventListener('click', () => updateProvider(button.dataset.provider, false)));
        wrapper.querySelector('.ctca-pdf-browse').addEventListener('click', () => fileInput.click());
        fileInput.addEventListener('change', () => {
          selectedFiles = [...fileInput.files];
          renderSelectedFiles();
        });
        localPathInput.addEventListener('input', renderLocalPaths);
        renderSelectedFiles();
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
          webFiles: selectedProvider === "local" ? [] : webCandidates.flatMap((candidate, index) => {
            const checkbox = webResultRows?.querySelector(`[data-web-pdf-index="${index}"]`);
            if (!checkbox?.checked) return [];
            const name = webResultRows?.querySelector(`[data-web-pdf-name-index="${index}"]`)?.value.trim();
            return [{ ...candidate, name: name || candidate.name || candidate.fileName.replace(/\.pdf$/i, "") }];
          }),
          names: selectedProvider === "local" && !selectedFiles.length
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
      return [];
    }
    pdfAttachmentLoadingKeys.add(entry.key);
    syncPdfAttachmentLoadingIndicators();
    if (fromPdfView) {
      const downloading = Array.isArray(result.webFiles) && result.webFiles.length > 0;
      setPdfViewAttachmentProgress(true, downloading ? "Downloading and attaching PDF…" : "Attaching PDF…");
    }
    const attachedItems = [];
    let partialFailure = null;
    try {
      if (result.provider === "local") {
        if (result.files.length) {
          for (let index = 0; index < result.files.length; index += 1) {
            const attachment = await globalThis.CollabTeXPdfImport.attach(
              entry,
              { file: result.files[index], handle: null },
              "local",
              result.names[index]
            );
            if (attachment) attachedItems.push(attachment);
          }
          setStatus("Local PDF link saved for this browser session.");
        } else {
          if (!result.paths.length) throw new Error("Enter at least one complete local PDF path.");
          let permitted = true;
          try { permitted = await globalThis.CollabTeXAttachmentStore.ensureLocalFilePermission(); } catch (_error) { permitted = false; }
          for (let index = 0; index < result.paths.length; index += 1) {
            const attachment = await globalThis.CollabTeXAttachmentStore.addLocalLink(entry, result.paths[index], result.names[index]);
            if (attachment) attachedItems.push(attachment);
          }
          setStatus(permitted
            ? "Local PDF link saved. The PDF remains at its current disk location."
            : "Local PDF link saved. Enable local-file access for this extension before opening the PDF.");
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
              const failure = `${candidate.fileName || candidate.url}: ${error.message || String(error)}`;
              failures.push(failure);
              console.error("[Smart Citations] Could not download a discovered web PDF.", {
                candidate,
                error,
                message: failure
              });
            }
          }
        } finally {
          await Promise.allSettled(
            [...webTabIds].map((tabId) => globalThis.CollabTeXAttachmentStore.closeWebTab(tabId))
          );
        }
        if (!files.length) throw new Error(failures.join("; ") || "Choose or catch at least one PDF file.");
        if (result.provider === "nextcloud") {
          const cfg = await globalThis.CollabTeXAttachmentStore.getConfig();
          if (!cfg.nextcloud?.appPassword) throw new Error("Connect Nextcloud in PDF storage settings first.");
        }
        let attached = 0;
        for (const item of files) {
          const file = item.file;
          const name = item.name || file.name.replace(/\.pdf$/i, "");
          try {
            const attachment = result.provider === "nextcloud"
              ? await globalThis.CollabTeXAttachmentStore.addNextcloud(entry, file, name)
              : await globalThis.CollabTeXAttachmentStore.addBrowser(entry, file, name);
            if (attachment) attachedItems.push(attachment);
            attached += 1;
          } catch (error) {
            failures.push(`${file.name}: ${error.message || String(error)}`);
          }
        }
        if (!attached) throw new Error(failures.join("; ") || "No PDF could be attached.");
        const attachmentStatus = failures.length
          ? `${attached} PDF${attached === 1 ? "" : "s"} attached; ${failures.length} failed: ${failures.join("; ")}`
          : `${attached} PDF${attached === 1 ? "" : "s"} attached${result.provider === "nextcloud" ? " and uploaded to Nextcloud" : ""}.`;
        setStatus(attachmentStatus, failures.length > 0);
        if (failures.length) partialFailure = new Error(attachmentStatus);
      }
      await renderAttachmentList(entry);
      if (options.openAfterAttach && attachedItems[0]) {
        await openPdfTab(entry, attachedItems[0]);
      }
      if (fromPdfView && partialFailure) {
        setPdfViewAttachmentProgress(false);
        await showPdfViewAttachmentFailure(partialFailure, failureJournalUrl);
      }
    } catch (error) {
      if (fromPdfView) {
        setPdfViewAttachmentProgress(false);
        await showPdfViewAttachmentFailure(error, failureJournalUrl);
      } else {
        setStatus(error.message || String(error), true);
      }
    } finally {
      if (fromPdfView) setPdfViewAttachmentProgress(false);
      await Promise.allSettled(
        [...webOpenTabIds].map((tabId) => globalThis.CollabTeXAttachmentStore.closeWebTab(tabId))
      );
      pdfAttachmentLoadingKeys.delete(entry.key);
      syncPdfAttachmentLoadingIndicators();
    }
    return attachedItems;
  }

  async function showPdfImportReport(created, updated, skipped, failed, notes = []) {
    const summary = `${created} new entr${created === 1 ? "y" : "ies"} created, ` +
      `${updated} existing entr${updated === 1 ? "y" : "ies"} updated with a PDF, and ` +
      `${skipped} PDF${skipped === 1 ? " was" : "s were"} skipped as ${skipped === 1 ? "a duplicate" : "duplicates"}.` +
      (failed ? ` ${failed} PDF${failed === 1 ? " could" : "s could"} not be imported.` : "");
    await showDialog({
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

  async function addEntriesFromPdfs(initialFiles = []) {
    if (isReadOnlySharedCategory(selectedCategoryId)) {
      setStatus("Entries cannot be added to a read-only shared category.", true);
      return;
    }
    if (busy) return;
    const config = await globalThis.CollabTeXAttachmentStore.getConfig();
    let picker = null;
    const result = await showDialog({
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
      setStatus("Select at least one PDF file.", true);
      return;
    }
    if (result.provider === "nextcloud" && !config.nextcloud?.appPassword) {
      setStatus("Connect Nextcloud in PDF storage settings first.", true);
      return;
    }

    let created = 0;
    let updated = 0;
    let skipped = 0;
    let failed = 0;
    const notes = [];
    setBusy(true, "Importing PDFs…");
    setProgress(0, result.items.length, `0/${result.items.length} PDFs processed`, true);
    try {
      for (let index = 0; index < result.items.length; index += 1) {
        const item = result.items[index];
        const file = item.file;
        setProgress(index, result.items.length, `Reading ${file.name}…`, true);
        try {
          const doi = await globalThis.CollabTeXPdfImport.extractDoi(file);
          if (!doi) {
            failed += 1;
            notes.push(`${file.name}: no DOI was found.`);
            continue;
          }
          const existing = entries.find((entry) => normalizeDoi(entry.fields?.doi || "") === doi);
          if (existing) {
            const attachments = await globalThis.CollabTeXAttachmentStore.list(existing);
            if (attachments.length) {
              skipped += 1;
              notes.push(`${file.name}: skipped because ${existing.key} already has a PDF.`);
              continue;
            }
            await globalThis.CollabTeXPdfImport.attach(existing, item, result.provider);
            updated += 1;
            selectedKey = existing.key;
            selectedKeys = new Set([existing.key]);
            continue;
          }

          const metadata = await fetchDoiMetadata(doi);
          const entry = {
            key: "",
            type: metadata.entryType || "misc",
            fields: {},
            aliases: [],
            tags: [],
            updatedAt: "",
            addedOn: new Date().toISOString(),
            starred: false,
            doiSyncedAt: ""
          };
          mergeMetadata(entry, { ...metadata, doi: metadata.doi || doi });
          entry.key = uniqueKey(generatedKey(entry.fields));
          entries.push(entry);
          try {
            await globalThis.CollabTeXPdfImport.attach(entry, item, result.provider);
          } catch (error) {
            entries.splice(entries.indexOf(entry), 1);
            throw error;
          }
          if (selectedCategoryId !== "all" && selectedCategoryId !== "starred" && selectedCategoryId !== "uncategorized") {
            setEntryCategoryIds(entry.key, [selectedCategoryId]);
          }
          selectedKey = entry.key;
          selectedKeys = new Set([entry.key]);
          created += 1;
        } catch (error) {
          failed += 1;
          notes.push(`${file.name}: ${error?.message || String(error)}`);
        } finally {
          setProgress(index + 1, result.items.length, `${index + 1}/${result.items.length} PDFs processed`, true);
        }
      }
      if (created) {
        markDirty("Saving imported PDF entries…");
        await saveDatabase("Imported entries from PDF.");
      }
      renderAll();
    } finally {
      setBusy(false);
      setProgress(0, 1, "", false);
    }
    const summary = await showPdfImportReport(created, updated, skipped, failed, notes);
    setStatus(summary, failed > 0 && created + updated === 0);
  }

  function renderWorkspaceTabs() {
    const tabs = $(".ctca-manager-tabs", root);
    const hasPdfTabs = openPdfTabs.size > 0;
    tabs.hidden = !hasPdfTabs;
    root.classList.toggle("ctca-has-pdf-tabs", hasPdfTabs);
    tabs.querySelectorAll(".ctca-manager-tab[data-tab-id]:not([data-tab-id=bibliography])").forEach((node) => node.remove());
    const spacer = $(".ctca-manager-tab-spacer", tabs);
    for (const [tabId, data] of openPdfTabs) {
      const button = document.createElement("button");
      button.type = "button"; button.className = "ctca-manager-tab"; button.dataset.tabId = tabId; button.setAttribute("role", "tab");
      const label = pdfWorkspaceTabLabel(data);
      button.title = label;
      button.innerHTML = `<span>${escapeHtml(label)}</span><span class="ctca-manager-tab-close" title="Close PDF tab" aria-label="Close PDF tab">×</span>`;
      tabs.insertBefore(button, spacer);
    }
    tabs.querySelectorAll(".ctca-manager-tab").forEach((tab) => {
      const active = tab.dataset.tabId === activeWorkspaceTab;
      tab.classList.toggle("ctca-manager-tab-active", active); tab.setAttribute("aria-selected", active ? "true" : "false");
    });
  }

  function pdfWorkspaceTabLabel(data) {
    const citationKey = String(data?.entryKey || "").trim() || "PDF";
    if (!(Number(data?.attachmentCount) > 1)) return citationKey;
    const pdfName = String(
      data?.attachment?.name
      || data?.attachment?.fileName?.replace(/\.pdf$/i, "")
      || ""
    ).trim();
    return pdfName ? `${citationKey} — ${pdfName}` : citationKey;
  }

  function sourcePdfAttachmentId(attachment) {
    const id = String(attachment?.id || "");
    const sharedId = String(attachment?.sharedCategoryId || "");
    const prefix = sharedId ? `shared-${sharedId}-` : "";
    return prefix && id.startsWith(prefix) ? id.slice(prefix.length) : id;
  }

  function pdfAttachmentsMatch(left, right) {
    const leftId = String(left?.id || "");
    const rightId = String(right?.id || "");
    if (leftId && rightId && leftId === rightId) return true;
    const leftSourceId = sourcePdfAttachmentId(left);
    const rightSourceId = sourcePdfAttachmentId(right);
    if (leftSourceId && rightSourceId && leftSourceId === rightSourceId) return true;
    const sharedPath = (property) => {
      const leftValue = String(left?.[property] || "").trim();
      const rightValue = String(right?.[property] || "").trim();
      return Boolean(leftValue && rightValue && leftValue === rightValue);
    };
    return sharedPath("remotePath") || sharedPath("localUrl") || sharedPath("localPath");
  }

  function openPdfTabIdForAttachment(attachment) {
    for (const [tabId, data] of openPdfTabs) {
      if (pdfAttachmentsMatch(data?.attachment, attachment)) return tabId;
    }
    return "";
  }

  async function openPdfTab(entry, attachment) {
    const directTabId = `pdf:${attachment.id}`;
    if (openPdfTabs.has(directTabId)) {
      await activateWorkspaceTab(directTabId);
      return;
    }
    const attachments = await globalThis.CollabTeXAttachmentStore.list(entry);
    const currentAttachment = attachments.find((item) => item.id === attachment.id) || attachment;
    const existingTabId = openPdfTabIdForAttachment(currentAttachment);
    if (existingTabId) {
      await activateWorkspaceTab(existingTabId);
      return;
    }
    const tabId = directTabId;
    openPdfTabs.set(tabId, {
      entryKey: entry.key,
      attachment: currentAttachment,
      attachmentCount: attachments.length,
      notesCollapsed: false,
      detailsCollapsed: false
    });
    await activateWorkspaceTab(tabId);
  }

  function renderPdfEntryDetails(entry) {
    const preserved = {
      selectedKey,
      selectedKeys,
      selectionAnchorKey
    };
    selectedKey = entry.key;
    selectedKeys = new Set([entry.key]);
    selectionAnchorKey = entry.key;
    renderingPdfEntryDetails = true;
    try {
      renderDetails();
    } finally {
      renderingPdfEntryDetails = false;
      selectedKey = preserved.selectedKey;
      selectedKeys = preserved.selectedKeys;
      selectionAnchorKey = preserved.selectionAnchorKey;
    }
  }

  async function activateWorkspaceTab(tabId) {
    if (activeWorkspaceTab !== "bibliography" && activeWorkspaceTab !== tabId) {
      await requestPdfFrameSave(activeWorkspaceTab);
      await savePdfNotes().catch(() => {});
      if (root.classList.contains("ctca-pdf-maximized")) setPdfMaximized(false);
    }
    activeWorkspaceTab = tabId;
    renderWorkspaceTabs();
    const bibliography = $(".ctca-manager-bibliography-view", root);
    const pdfView = $(".ctca-manager-pdf-view", root);
    root.classList.toggle("ctca-manager-pdf-active", tabId !== "bibliography");
    bibliography.hidden = tabId !== "bibliography";
    pdfView.hidden = tabId === "bibliography";
    if (tabId === "bibliography") {
      showPdfFrame("");
      setPdfMaximized(false);
      renderList();
      renderDetails();
      return;
    }
    const data = openPdfTabs.get(tabId);
    if (!data) return activateWorkspaceTab("bibliography");
    const entry = entryByKey(data.entryKey);
    await loadPdfView(data.attachment, entry, tabId);
  }

  async function closePdfTab(tabId) {
    if (activeWorkspaceTab === tabId) {
      await requestPdfFrameSave(tabId);
      await savePdfNotes().catch(() => {});
      if (root.classList.contains("ctca-pdf-maximized")) setPdfMaximized(false);
      activeWorkspaceTab = "bibliography";
    }
    pdfFrameForTab(tabId)?.remove();
    openPdfTabs.delete(tabId);
    renderWorkspaceTabs();
    await activateWorkspaceTab(activeWorkspaceTab);
  }

  function syncPdfEntryDetails() {
    if (activeWorkspaceTab === "bibliography") return;
    if (!renderingPdfEntryDetails) {
      const entry = entryByKey(openPdfTabs.get(activeWorkspaceTab)?.entryKey);
      if (entry) renderPdfEntryDetails(entry);
      else $(".ctca-pdf-entry-details", root).innerHTML = `<div class="ctca-manager-empty-details">The entry for this PDF is no longer available.</div>`;
      return;
    }
    const source = $(".ctca-manager-details", root);
    const target = $(".ctca-pdf-entry-details", root);
    if (source && target) {
      target.innerHTML = source.innerHTML;
      const entry = entryByKey(selectedKey) || entryByKey(openPdfTabs.get(activeWorkspaceTab)?.entryKey);
      if (entry) {
        target.dataset.detailEntryKey = entry.key;
        bindCommentsEditor(target, entry);
        bindCrosslinkReordering(target, entry);
        bindDetailSectionReordering(target);
      }
    }
  }


  async function sendPdfDataToFrame(frame, attachment) {
    if (!frame?.contentWindow || !attachment) return;
    try {
      const blob = await globalThis.CollabTeXAttachmentStore.getBlob(attachment);
      if (!blob) throw new Error("PDF data is not available. Reattach the file or synchronize it again.");
      const bytes = await blob.arrayBuffer();
      frame.contentWindow.postMessage({
        type: "ctca-pdf-load-data",
        attachmentId: attachment.id,
        provider: attachment.provider,
        bytes
      }, "*");
    } catch (error) {
      frame.contentWindow.postMessage({
        type: "ctca-pdf-load-error",
        attachmentId: attachment.id,
        error: error?.message || String(error)
      }, "*");
    }
  }

  function pdfSaveRequestId() {
    return `pdf-save-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  }

  async function requestPdfFrameSave(tabId = activeWorkspaceTab) {
    if (!tabId || tabId === "bibliography") return;
    const data = openPdfTabs.get(tabId);
    const frame = pdfFrameForTab(tabId);
    if (!data || !frame?.contentWindow || !data.viewerReady) return;

    const requestId = pdfSaveRequestId();
    await new Promise((resolve, reject) => {
      const timer = window.setTimeout(() => {
        pendingPdfSaveRequests.delete(requestId);
        reject(new Error("Timed out while saving PDF annotations."));
      }, 30000);
      pendingPdfSaveRequests.set(requestId, {
        resolve: () => { window.clearTimeout(timer); resolve(); },
        reject: (error) => { window.clearTimeout(timer); reject(error); }
      });
      frame.contentWindow.postMessage({
        type: "ctca-pdf-request-save",
        attachmentId: data.attachment.id,
        requestId
      }, "*");
    });
  }

  async function persistAnnotatedPdf(frame, message, tabId) {
    const data = openPdfTabs.get(tabId);
    if (!data || message.attachmentId !== data.attachment.id) return;
    const originalProvider = data.attachment.provider;
    try {
      const fileName = data.attachment.fileName || `${data.attachment.name || "annotated"}.pdf`;
      const file = new File([message.bytes], fileName, { type: "application/pdf" });
      const updated = await globalThis.CollabTeXAttachmentStore.replaceFile(data.attachment.id, file);
      data.attachment = updated;
      data.pdfDirty = false;
      const entry = entryByKey(data.entryKey);
      if (entry) await renderAttachmentList(entry);
      const convertedLocal = originalProvider === "local" && updated.provider === "browser";
      const resultMessage = convertedLocal
        ? "Annotations saved inside the PDF. The local link was converted to browser storage because extensions cannot overwrite an arbitrary local path."
        : updated.provider === "nextcloud"
          ? "Annotations saved inside the PDF and uploaded to Nextcloud."
          : "Annotations saved inside the PDF.";
      frame.contentWindow.postMessage({
        type: "ctca-pdf-save-result",
        attachmentId: updated.id,
        token: message.token,
        ok: true,
        persistenceMode: "persistent",
        message: resultMessage
      }, "*");
      setStatus(resultMessage);
    } catch (error) {
      const text = error?.message || String(error);
      frame.contentWindow.postMessage({
        type: "ctca-pdf-save-result",
        attachmentId: data.attachment.id,
        token: message.token,
        ok: false,
        error: text
      }, "*");
      setStatus(text, true);
    }
  }

  function pdfFrameForTab(tabId) {
    return $$(".ctca-pdf-frame", root).find((frame) => frame.dataset.pdfTabId === tabId) || null;
  }

  function ensurePdfFrame(tabId, attachment) {
    const pane = $(".ctca-pdf-viewer-pane", root);
    const unavailable = $(".ctca-pdf-unavailable", pane);
    let frame = pdfFrameForTab(tabId);
    if (frame && frame.dataset.attachmentId !== attachment.id) {
      frame.remove();
      frame = null;
    }
    if (!frame) {
      frame = document.createElement("iframe");
      frame.className = "ctca-pdf-frame";
      frame.title = `PDF viewer: ${attachment.name || attachment.fileName || attachment.id}`;
      frame.dataset.pdfTabId = tabId;
      frame.dataset.attachmentId = attachment.id;
      frame.hidden = true;
      pane.insertBefore(frame, unavailable);
      const tabState = openPdfTabs.get(tabId);
      if (tabState) {
        tabState.viewerReady = false;
        tabState.pdfDirty = false;
      }
      frame.src = extensionApi.runtime.getURL(`pdf-viewer.html?attachment=${encodeURIComponent(attachment.id)}`);
    }
    return frame;
  }

  function showPdfFrame(tabId) {
    $$(".ctca-pdf-frame", root).forEach((frame) => {
      frame.hidden = frame.dataset.pdfTabId !== tabId;
    });
  }

  async function loadPdfView(attachment, entry, tabId = activeWorkspaceTab) {
    renderPdfNoteEditor(attachment);
    const notesReadOnly = Boolean(entry && isReadOnlySharedEntry(entry.key));
    $$(".ctca-pdf-notes-content .ctca-note-add, .ctca-pdf-notes-content .ctca-note-delete, .ctca-pdf-notes-content .ctca-note-style, .ctca-pdf-notes-content .ctca-rich-toolbar button, .ctca-pdf-notes-content .ctca-rich-toolbar input, .ctca-pdf-notes-content .ctca-rich-toolbar select", root)
      .forEach((control) => { control.disabled = notesReadOnly; });
    $$(".ctca-pdf-notes-content [contenteditable]", root).forEach((control) => {
      control.setAttribute("contenteditable", notesReadOnly ? "false" : "true");
    });
    $(".ctca-pdf-notes-content", root)?.classList.toggle("ctca-note-editor-readonly", notesReadOnly);
    const tabState = openPdfTabs.get(tabId) || {};
    const layout = $(".ctca-pdf-layout", root);
    layout.classList.toggle("ctca-pdf-notes-collapsed", Boolean(tabState.notesCollapsed));
    layout.classList.toggle("ctca-pdf-details-collapsed", Boolean(tabState.detailsCollapsed));
    const unavailable = $(".ctca-pdf-unavailable", root);
    unavailable.hidden = true;
    try {
      ensurePdfFrame(tabId, attachment);
      showPdfFrame(tabId);
    } catch (error) {
      showPdfFrame("");
      unavailable.hidden = false;
      unavailable.textContent = error.message || String(error);
    }
    if (entry) renderPdfEntryDetails(entry);
    else $(".ctca-pdf-entry-details", root).innerHTML = `<div class="ctca-manager-empty-details">The entry for this PDF is no longer available.</div>`;
  }

  async function activePdfAttachment() {
    return openPdfTabs.get(activeWorkspaceTab)?.attachment || null;
  }

  async function downloadPdfAttachment(attachment) {
    if (!attachment) return;
    const blob = await globalThis.CollabTeXAttachmentStore.getBlob(attachment);
    if (!blob) return;
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = attachment.fileName || `${attachment.name}.pdf`;
    link.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  async function downloadActivePdf() {
    await downloadPdfAttachment(await activePdfAttachment());
  }

  async function savePdfNotes() {
    const tabId = activeWorkspaceTab;
    const tabData = openPdfTabs.get(tabId);
    if (tabData?.entryKey && isReadOnlySharedEntry(tabData.entryKey)) return;
    if (!tabData?.pdfNotesDirty) return;
    const attachment = tabData.attachment;
    if (!attachment) return;
    const noteItems = $$(".ctca-pdf-note-item", root).map((item) => readRichTextItem(item, "note"));
    const notes = noteItems.map((note) => note.text).filter(Boolean).join("\n\n");
    tabData.attachment = { ...attachment, noteItems, notes };
    tabData.pdfNotesDirty = false;
    try {
      const updated = await globalThis.CollabTeXAttachmentStore.update(attachment.id, {
        noteItems,
        notes
      });
      tabData.attachment = updated;
      const cachedAttachments = virtualListState.attachmentsByKey?.get(tabData.entryKey || "");
      if (Array.isArray(cachedAttachments)) {
        const index = cachedAttachments.findIndex((item) => item.id === updated.id);
        if (index >= 0) cachedAttachments.splice(index, 1, updated);
        updateMountedRowAttachments();
      }
      if (searchOptions.includeNotesComments) await refreshNotesCommentsSearchCache();
      setStatus(updated.provider === "nextcloud" ? "PDF notes saved and uploaded to Nextcloud." : "PDF notes saved.");
    } catch (error) {
      tabData.pdfNotesDirty = true;
      throw error;
    }
  }

  function markActivePdfNotesDirty() {
    const tabData = openPdfTabs.get(activeWorkspaceTab);
    if (tabData) tabData.pdfNotesDirty = true;
  }

  function normalizedPdfNoteItems(attachment) {
    if (Array.isArray(attachment?.noteItems)) {
      return attachment.noteItems.map((note, index) => normalizeRichTextItem(note, index, "note"));
    }
    const legacy = String(attachment?.notes || "");
    return legacy ? [normalizeRichTextItem({ id: `legacy-${attachment?.id || "pdf"}`, text: legacy }, 0, "note")] : [];
  }

  function renderPdfNoteEditor(attachment) {
    const list = $(".ctca-pdf-note-list", root);
    if (!list) return;
    const notes = normalizedPdfNoteItems(attachment);
    list.innerHTML = notes.map((note, index) => richTextItemHtml(note, {
      kind: "note", index, count: notes.length, placeholder: "Notes for this PDF are saved automatically."
    })).join("");
  }

  function bindPdfNoteEditor() {
    const content = $(".ctca-pdf-notes-content", root);
    const commit = () => savePdfNotes().catch((error) => setStatus(error.message || String(error), true));
    bindRichTextControls(content, commit, markActivePdfNotesDirty);
    content.addEventListener("click", async (event) => {
      if (event.target.closest(".ctca-pdf-note-add")) {
        const attachment = await activePdfAttachment();
        if (!attachment) return;
        attachment.noteItems = [
          ...normalizedPdfNoteItems(attachment),
          { id: `note-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, text: "" }
        ];
        renderPdfNoteEditor(attachment);
        content.querySelector(".ctca-pdf-note-item:last-child .ctca-note-text")?.focus();
        return;
      }
      const remove = event.target.closest(".ctca-note-delete");
      if (!remove) return;
      const item = remove.closest(".ctca-pdf-note-item");
      const confirmed = await showDialog({
        title: "Delete this PDF note?",
        message: "The note will be permanently removed.",
        buttons: [
          { label: "Cancel", value: false },
          { label: "Delete note", value: true, danger: true }
        ],
        closeValue: false,
        danger: true
      });
      if (!confirmed) return;
      item.remove();
      markActivePdfNotesDirty();
      await savePdfNotes();
    });
    let dragged = null;
    content.addEventListener("dragstart", (event) => {
      const handle = event.target.closest(".ctca-note-drag");
      dragged = handle?.closest(".ctca-pdf-note-item") || null;
      if (!dragged) return;
      dragged.classList.add("ctca-note-dragging");
      event.dataTransfer.effectAllowed = "move";
    });
    content.addEventListener("dragover", (event) => {
      const target = event.target.closest(".ctca-pdf-note-item");
      if (!dragged || !target || target === dragged) return;
      event.preventDefault();
      const after = event.clientY > target.getBoundingClientRect().top + target.offsetHeight / 2;
      target.parentElement.insertBefore(dragged, after ? target.nextSibling : target);
    });
    content.addEventListener("drop", (event) => {
      if (!dragged) return;
      event.preventDefault();
      dragged.classList.remove("ctca-note-dragging");
      dragged = null;
      markActivePdfNotesDirty();
      savePdfNotes().catch((error) => setStatus(error.message || String(error), true));
    });
    content.addEventListener("dragend", () => {
      dragged?.classList.remove("ctca-note-dragging");
      dragged = null;
    });
  }

  function initializePdfResizer(handle, kind) {
    handle?.addEventListener("pointerdown", (event) => {
      if (event.button !== 0) return; event.preventDefault();
      const startX = event.clientX, startNotes = pdfNotesWidth, startDetails = pdfDetailsWidth;
      const layout = $(".ctca-pdf-layout", root);
      const move = (moveEvent) => {
        const delta = moveEvent.clientX - startX;
        if (kind === "notes") pdfNotesWidth = Math.max(240, Math.min(700, startNotes - delta));
        else pdfDetailsWidth = Math.max(280, Math.min(800, startDetails - delta));
        layout.style.setProperty("--ctca-pdf-notes-width", `${pdfNotesWidth}px`);
        layout.style.setProperty("--ctca-pdf-details-width", `${pdfDetailsWidth}px`);
      };
      const finish = () => { document.removeEventListener("pointermove", move, true); document.removeEventListener("pointerup", finish, true); };
      document.addEventListener("pointermove", move, true); document.addEventListener("pointerup", finish, true);
    });
  }

  function scheduleListRender() {
    window.clearTimeout(listRenderTimer);
    listRenderTimer = window.setTimeout(() => renderList(), 120);
  }

  function detailInputChanged(event, entryOverride = null) {
    if (busy) return;
    const entry = entryOverride || detailEntryFromTarget(event.target);
    if (!entry) return;
    const field = event.target.dataset.managerField;
    const property = event.target.dataset.managerProperty;
    if (isReadOnlySharedEntry(entry.key) && property !== "key") {
      setStatus("This shared entry is read-only. Its citation key may still be changed locally.", true);
      renderDetails();
      return;
    }
    if (field) {
      entry.fields[field] = event.target.value;
    } else if (property === "type") {
      entry.type = event.target.value;
    } else if (property === "key") {
      const oldKey = entry.key;
      const newKey = event.target.value.trim();
      if (!newKey || newKey === oldKey) return;
      if (entries.some((item) => item !== entry && item.key.toLowerCase() === newKey.toLowerCase())) {
        setStatus(`Citation key ${newKey} already exists.`, true);
        return;
      }
      entry.key = newKey;
      entry.aliases = [...new Set([...(entry.aliases || []), oldKey])];
      for (const candidate of entries) {
        candidate.crosslinks = normalizeCrosslinkKeys(
          (candidate.crosslinks || []).map((key) => key.toLocaleLowerCase() === oldKey.toLocaleLowerCase() ? newKey : key),
          candidate.key
        );
      }
      crosslinkNavigationStack = crosslinkNavigationStack.map((key) =>
        key.toLocaleLowerCase() === oldKey.toLocaleLowerCase() ? newKey : key
      );
      if (categoryState.memberships[oldKey]) {
        categoryState.memberships[newKey] = categoryState.memberships[oldKey];
        delete categoryState.memberships[oldKey];
      }
      if (selectedKeys.delete(oldKey)) selectedKeys.add(newKey);
      if (selectedKey === oldKey) selectedKey = newKey;
      if (detailOnlyKey === oldKey) detailOnlyKey = newKey;
      if (selectionAnchorKey === oldKey) selectionAnchorKey = newKey;
      updateSharedLocalKeyOverride(oldKey, newKey);
    } else {
      return;
    }
    entry.updatedAt = new Date().toISOString();
    markDirty();
    if (field === "author") renderCategories();
    scheduleListRender();
    if (event.type === "change") flushAutoSave().catch(() => {});
  }

  function startInlineEdit(display) {
    const field = display?.dataset.managerInlineField;
    const entry = detailEntryFromTarget(display);
    if (!field || !entry || busy || display.classList.contains("ctca-manager-inline-editing")) return false;
    if (isReadOnlySharedEntry(entry.key)) {
      setStatus("This shared entry is read-only. Its citation key may still be changed locally.", true);
      return false;
    }

    const originalValue = String(entry.fields?.[field] || "");
    const textarea = document.createElement("textarea");
    textarea.className = "ctca-manager-inline-editor";
    textarea.value = originalValue;
    textarea.rows = field === "author" ? 5 : 2;
    textarea.setAttribute("aria-label", field === "author" ? "Edit authors" : "Edit title");
    display.classList.add("ctca-manager-inline-editing");
    display.replaceChildren(textarea);

    const authorIndex = field === "author"
      ? globalThis.CollabTeXBibTeX.createAuthorIndex(entries.flatMap((item) => [
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
        ? globalThis.CollabTeXBibTeX.findAuthorCompletions(
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
      const topCompletion = authorCompletions[0];
      const typedAuthor = topCompletion
        ? textarea.value.slice(topCompletion.start, topCompletion.end).trim()
        : "";
      setInlineCompletionHint(textarea, topCompletion?.value, typedAuthor, ".ctca-manager-inline-editing");
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
        detailInputChanged({
          target: { dataset: { managerField: field }, value: textarea.value },
          type: "change"
        }, entry);
      }
      renderDetails();
    };

    textarea.addEventListener("blur", () => finish(true), { once: true });
    textarea.addEventListener("input", updateAuthorCompletion);
    textarea.addEventListener("keydown", (event) => {
      if (handleInlineCompletionDeletion(event, textarea)) {
        return;
      } else if (event.key === "ArrowRight" && acceptInlineCompletion(textarea)) {
        event.preventDefault();
      } else if (event.key === "ArrowRight" && acceptAuthorCompletion()) {
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

  function detailClicked(event) {
    const inlineDisplay = event.target.closest("[data-manager-inline-field]");
    if (inlineDisplay && startInlineEdit(inlineDisplay)) {
      event.preventDefault();
      return;
    }
    detailActionClicked(event);
  }

  function inlineDisplayKeydown(event) {
    if (!event.target.matches("[data-manager-inline-field]")) return;
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    startInlineEdit(event.target);
  }

  async function detailActionClicked(event) {
    const button = event.target.closest("button[data-manager-action]");
    if (!button || busy) return;
    event.preventDefault();
    const entry = detailEntryFromTarget(button);
    if (!entry) return;
    const action = button.dataset.managerAction;

    if (action === "crosslink-back") {
      const previousKey = crosslinkNavigationStack.pop();
      const previous = crosslinkEntry(previousKey);
      if (previous) {
        if (button.closest(".ctca-pdf-entry-details")) {
          renderPdfEntryDetails(previous);
          return;
        }
        openListEntryDetails(previous, { detailOnly: Boolean(detailOnlyKey) });
      } else {
        renderDetails();
      }
      return;
    }
    if (action === "open-crosslink") {
      const target = crosslinkEntry(button.dataset.crosslinkKey);
      if (!target) return;
      crosslinkNavigationStack.push(entry.key);
      if (button.closest(".ctca-pdf-entry-details")) {
        renderPdfEntryDetails(target);
        return;
      }
      openListEntryDetails(target, { detailOnly: Boolean(detailOnlyKey) });
      return;
    }
    if (action === "open-paper") {
      const url = paperUrl(entry);
      if (url) window.open(url, "_blank", "noopener,noreferrer");
      return;
    }
    if (action === "open-url") {
      const value = button.closest(".ctca-manager-url-row")?.querySelector('[data-manager-field="url"]')?.value || entry.fields?.url || "";
      try {
        const url = new URL(String(value).trim());
        if (!/^https?:$/.test(url.protocol)) throw new Error();
        window.open(url.href, "_blank", "noopener,noreferrer");
      } catch (_error) {
        setStatus("Enter a valid HTTP or HTTPS URL first.", true);
      }
      return;
    }
    if (isReadOnlySharedEntry(entry.key) && !/^(?:open|download|copy)/.test(action)) {
      setStatus("This shared entry is read-only. Its citation key may still be changed locally.", true);
      return;
    }
    if (action === "add-crosslink") {
      const keys = await chooseCrosslinkEntries(entry);
      if (!keys.length) return;
      entry.crosslinks = normalizeCrosslinkKeys([...(entry.crosslinks || []), ...keys], entry.key);
      for (const key of keys) {
        const target = crosslinkEntry(key);
        if (!target) continue;
        target.crosslinks = normalizeCrosslinkKeys([...(target.crosslinks || []), entry.key], target.key);
        target.updatedAt = new Date().toISOString();
      }
      entry.updatedAt = new Date().toISOString();
      markDirty("Saving reciprocal crosslinks automatically…");
      renderList();
      renderDetails();
      return;
    }
    if (action === "remove-crosslink") {
      const key = button.dataset.crosslinkKey || "";
      const target = crosslinkEntry(key);
      entry.crosslinks = normalizeCrosslinkKeys(entry.crosslinks, entry.key)
        .filter((linkedKey) => target
          ? !crosslinkKeyMatchesEntry(linkedKey, target)
          : linkedKey.toLocaleLowerCase() !== key.toLocaleLowerCase());
      if (target) {
        target.crosslinks = normalizeCrosslinkKeys(target.crosslinks, target.key)
          .filter((linkedKey) => !crosslinkKeyMatchesEntry(linkedKey, entry));
        target.updatedAt = new Date().toISOString();
      }
      entry.updatedAt = new Date().toISOString();
      markDirty("Removing reciprocal crosslink automatically…");
      renderList();
      renderDetails();
      return;
    }
    if (action === "add-tag") {
      if (addTagToEntry(entry, button.dataset.tag || "")) {
        renderDetails();
        requestAnimationFrame(() => $(".ctca-tag-input", root)?.focus());
      }
      return;
    }
    if (action === "remove-tag") {
      const remove = String(button.dataset.tag || "").toLocaleLowerCase();
      entry.tags = globalThis.CollabTeXSearchTools.splitTags(entry.tags || []).filter((tag) => tag.toLocaleLowerCase() !== remove);
      entry.updatedAt = new Date().toISOString();
      markDirty("Saving tag automatically…");
      scheduleListRender();
      renderDetails();
      return;
    }
    if (action === "remove-category-membership") {
      setEntryCategoryIds(entry.key, entryCategoryIds(entry.key).filter((id) => id !== button.dataset.categoryId));
      markDirty("Saving category assignment automatically…");
      renderCategories();
      renderDetails();
      return;
    }
    if (action === "add-field") {
      const select = $(".ctca-manager-add-field-select", root);
      const field = select?.value;
      if (field && !(field in entry.fields)) {
        entry.fields[field] = "";
        markDirty();
        renderDetails();
        root.querySelector(`[data-manager-field="${CSS.escape(field)}"]`)?.focus();
      }
      return;
    }
    if (action === "remove-field") {
      delete entry.fields[button.dataset.field];
      markDirty();
      renderDetails();
      return;
    }
    if (action === "remove-entry") {
      const confirmed = await showDialog({
        title: `Remove ${entry.key}?`,
        message: syncNextcloudBibliography
          ? "This entry and all of its attached PDFs will be removed from the global bibliography database, browser storage or Nextcloud, and the synchronized Nextcloud bibliography."
          : "This entry and all of its attached PDFs will be removed from the global bibliography database and browser storage or Nextcloud.",
        buttons: [
          { label: "Keep entry", value: false },
          { label: "Remove entry", value: true, danger: true }
        ],
        closeValue: false,
        danger: true
      });
      if (!confirmed) return;
      setStatus(`Removing attachments for ${entry.key}…`);
      try {
        await globalThis.CollabTeXAttachmentStore.removeForEntries([entry]);
      } catch (error) {
        setStatus(`The entry was kept because its attachments could not be deleted: ${error?.message || String(error)}`, true);
        return;
      }
      removeEntryKeys([entry.key]);
      await saveDatabase(`Removed ${entry.key}.`);
      await propagateRemovedEntriesToNextcloud([entry]);
      renderAll();
      return;
    }
    if (action === "add-pdf") {
      if (pdfAttachmentLoadingKeys.has(entry.key)) return;
      await openAddPdfDialog(entry);
      return;
    }
    if (action === "get-pdf-from-web") {
      if (pdfAttachmentLoadingKeys.has(entry.key)) return;
      await openAddPdfDialog(entry, { getFromWeb: true });
      return;
    }
    if (["open-pdf", "download-pdf", "rename-pdf", "replace-pdf", "remove-pdf"].includes(action)) {
      const attachments = await globalThis.CollabTeXAttachmentStore.list(entry);
      const attachment = attachments.find((item) => item.id === button.dataset.attachmentId);
      if (!attachment) return;
      if (action === "open-pdf") {
        await openPdfTab(entry, attachment);
        return;
      }
      if (action === "download-pdf") {
        try {
          await downloadPdfAttachment(attachment);
          setStatus(`Downloaded ${attachment.fileName || `${attachment.name}.pdf`}.`);
        } catch (error) {
          setStatus(error?.message || String(error), true);
        }
        return;
      }
      if (action === "rename-pdf") {
        let input;
        const name = await showDialog({
          title: "Rename PDF attachment",
          controls: (container) => {
            const label = document.createElement("label");
            label.className = "ctca-app-dialog-field";
            label.innerHTML = `<span>Attachment name</span><input type="text" value="${escapeHtml(attachment.name)}">`;
            input = $("input", label); container.appendChild(label);
          },
          buttons: [{ label: "Cancel", value: null }, { label: "Rename", primary: true, getValue: () => input.value.trim() }], closeValue: null
        });
        if (name) {
          const updated = await globalThis.CollabTeXAttachmentStore.update(attachment.id, { name });
          for (const data of openPdfTabs.values()) if (data.attachment.id === updated.id) data.attachment = updated;
          renderWorkspaceTabs();
          await renderAttachmentList(entry);
        }
        return;
      }
      if (action === "replace-pdf") {
        const input = document.createElement("input"); input.type = "file"; input.accept = "application/pdf,.pdf";
        input.addEventListener("change", async () => {
          if (!input.files[0]) return;
          try {
            const updated = await globalThis.CollabTeXAttachmentStore.replaceFile(attachment.id, input.files[0]);
            for (const data of openPdfTabs.values()) if (data.attachment.id === updated.id) data.attachment = updated;
            await renderAttachmentList(entry);
            if (openPdfTabs.has(`pdf:${attachment.id}`)) await loadPdfView(updated, entry);
          } catch (error) { setStatus(error.message || String(error), true); }
        }, { once: true });
        input.click();
        return;
      }
      const confirmed = await showDialog({
        title: `Remove PDF “${attachment.name}”?`,
        message: attachment.provider === "nextcloud" ? "The PDF and its annotation sidecar will also be deleted from Nextcloud." : "The PDF attachment and its notes will be removed.",
        buttons: [{ label: "Keep PDF", value: false }, { label: "Remove PDF", value: true, danger: true }], closeValue: false, danger: true
      });
      if (confirmed) {
        try {
          await globalThis.CollabTeXAttachmentStore.remove(attachment.id);
        } catch (error) {
          setStatus(`The attachment was kept because its file could not be deleted: ${error?.message || String(error)}`, true);
          return;
        }
        await closePdfTab(`pdf:${attachment.id}`);
        await renderAttachmentList(entry);
      }
      return;
    }
    if (action === "update-doi") {
      await updateEntriesFromDoi([entry]);
    }
  }

  function normalizeDoi(value) {
    return String(value ?? "")
      .trim()
      .replace(/^doi\s*:\s*/i, "")
      .replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, "")
      .replace(/[\s<>]+/g, "")
      .replace(/[),.;]+$/, "");
  }

  function doiFromPdfLink(value) {
    try {
      const url = new URL(String(value || ""));
      const host = url.hostname.toLowerCase().replace(/^www\./, "");
      if (host !== "doi.org" && host !== "dx.doi.org") return "";
      const doi = normalizeDoi(decodeURIComponent(url.pathname.replace(/^\/+/, "")));
      return /^10\.\d{4,9}\/\S+$/i.test(doi) ? doi : "";
    } catch (_error) {
      return "";
    }
  }

  async function openPdfLinkInBrowser(value) {
    const response = await extensionApi.runtime.sendMessage({
      type: "ctca-open-external-tab",
      url: value,
      active: true
    });
    if (!response?.ok) throw new Error(response?.error || "The link could not be opened.");
  }

  async function createEntryFromPdfDoi(doi) {
    setStatus(`Retrieving DOI metadata for ${doi}â€¦`);
    const metadata = await fetchDoiMetadata(doi);
    const now = new Date().toISOString();
    const entry = {
      key: "",
      type: metadata.entryType || "article",
      fields: { doi },
      aliases: [],
      tags: [],
      updatedAt: now,
      doiSyncedAt: now,
      addedOn: now,
      starred: false
    };
    mergeMetadata(entry, { ...metadata, doi: metadata.doi || doi });
    entry.key = generatedKey(entry.fields);
    entries.push(entry);
    markDirty(`Saving ${entry.key}â€¦`);
    await saveDatabase(`Added ${entry.key} from DOI metadata.`);
    return entry;
  }

  async function handlePdfLinkRequest(value) {
    if (pdfLinkRequestInProgress) return;
    pdfLinkRequestInProgress = true;
    try {
      const url = new URL(String(value || ""));
      if (!/^https?:$/.test(url.protocol)) throw new Error("Only HTTP or HTTPS links can be opened.");
      const doi = doiFromPdfLink(url.href);
      if (!doi) {
        await openPdfLinkInBrowser(url.href);
        return;
      }

      let entry = entries.find((candidate) =>
        normalizeDoi(candidate?.fields?.doi || "").toLowerCase() === doi.toLowerCase()
      ) || null;
      if (entry) {
        const attachments = await globalThis.CollabTeXAttachmentStore.list(entry);
        if (attachments.length) {
          await openPdfTab(entry, attachments[0]);
          return;
        }
        const readOnly = isReadOnlySharedEntry(entry.key);
        const choice = await showDialog({
          title: "DOI entry has no PDF",
          message: readOnly
            ? `${entry.key} matches ${doi}, but this shared entry is read-only and cannot receive an attachment.`
            : `${entry.key} matches ${doi}, but it has no attached PDF. Would you like to look for the manuscript or open the DOI page in a browser tab?`,
          buttons: readOnly
            ? [
                { label: "Cancel", value: null },
                { label: "Open DOI page", value: "browser", primary: true }
              ]
            : [
                { label: "Cancel", value: null },
                { label: "Open DOI page", value: "browser" },
                { label: "Try to download PDF", value: "download", primary: true }
              ],
          closeValue: null
        });
        if (choice === "browser") {
          await openPdfLinkInBrowser(url.href);
        } else if (choice === "download") {
          await openAddPdfDialog(entry, {
            getFromWeb: true,
            sourceUrl: url.href,
            openAfterAttach: true,
            fromPdfView: true,
            failureJournalUrl: url.href
          });
        }
        return;
      }

      const choice = await showDialog({
        title: "DOI not in the bibliography",
        message: `${doi} is not in Smart Citations. Would you like to add it and look for the manuscript, or open the DOI page in a browser tab?`,
        buttons: [
          { label: "Cancel", value: null },
          { label: "Open DOI page", value: "browser" },
          { label: "Add entry and try download", value: "add", primary: true }
        ],
        closeValue: null
      });
      if (choice === "browser") {
        await openPdfLinkInBrowser(url.href);
        return;
      }
      if (choice !== "add") return;

      entry = await createEntryFromPdfDoi(doi);
      renderAll();
      await openAddPdfDialog(entry, {
        getFromWeb: true,
        sourceUrl: url.href,
        openAfterAttach: true,
        fromPdfView: true,
        failureJournalUrl: url.href
      });
    } finally {
      pdfLinkRequestInProgress = false;
    }
  }

  function wasUpdatedFromDoi(entry) {
    return Boolean(
      entry?.doiSyncedAt ||
      stripBibValue(entry?.fields?.ctca_doi_synced || "")
    );
  }

  async function fetchDoiMetadata(doi, requestId = "") {
    const response = await extensionApi.runtime.sendMessage({ type: "ctca-fetch-doi-metadata", doi, requestId });
    if (!response?.ok) throw new Error(response?.error || "DOI lookup failed.");
    return response.metadata || {};
  }

  function mergeMetadata(entry, metadata) {
    const fields = entry.fields;
    const authors = (metadata.authors || [])
      .map((author) => author.family && author.given ? `${author.family}, ${author.given}` : author.name || author.family || "")
      .filter(Boolean)
      .join(" and ");
    const values = {
      doi: metadata.doi,
      title: metadata.title,
      author: authors,
      journal: metadata.journal,
      year: metadata.year,
      volume: metadata.volume,
      number: metadata.number,
      pages: metadata.pages,
      publisher: metadata.publisher,
      url: metadata.url,
      abstract: metadata.abstract,
      keywords: metadata.keywords
    };
    for (const [name, value] of Object.entries(values)) {
      if (value !== undefined && value !== null && String(value).trim()) fields[name] = String(value).trim();
    }
    if (metadata.entryType) entry.type = metadata.entryType;
    entry.doiSyncedAt = new Date().toISOString();
    entry.updatedAt = entry.doiSyncedAt;
  }

  async function showBatchDoiConfirmation(total, previouslySynchronized) {
    let includePreviouslySynchronized = false;
    return showDialog({
      title: "Update entries from DOI",
      message:
        `${total} entr${total === 1 ? "y contains" : "ies contain"} a DOI. ` +
        `${previouslySynchronized ? `${previouslySynchronized} ${previouslySynchronized === 1 ? "was" : "were"} updated from DOI before. ` : ""}` +
        "Existing fields not supplied by the DOI service are preserved.",
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
  }

  async function updateEntriesFromDoi(targets, { showBatchConfirmation = false } = {}) {
    targets = (targets || []).filter((entry) => !isReadOnlySharedEntry(entry.key));
    if (!targets.length) {
      setStatus("Read-only shared entries cannot be updated.", true);
      return;
    }
    if (nextcloudSyncInProgress) {
      const targetKeys = targets.map((entry) => entry.key);
      setStatus("DOI metadata update queued; it will start when Nextcloud synchronization is complete.");
      await waitForCurrentNextcloudSync();
      targets = targetKeys.map(entryByKey).filter(Boolean);
    }
    const allDoiTargets = targets.filter((entry) => normalizeDoi(entry.fields?.doi));
    if (!allDoiTargets.length) {
      setStatus("None of the selected entries contains a DOI.", true);
      return;
    }
    const previouslySynchronized = allDoiTargets.filter(wasUpdatedFromDoi);
    let doiTargets = allDoiTargets;
    let skippedSynchronized = 0;
    if (showBatchConfirmation) {
      const decision = await showBatchDoiConfirmation(allDoiTargets.length, previouslySynchronized.length);
      if (!decision) return;
      doiTargets = decision.includePreviouslySynchronized
        ? allDoiTargets
        : allDoiTargets.filter((entry) => !wasUpdatedFromDoi(entry));
      skippedSynchronized = allDoiTargets.length - doiTargets.length;
      if (!doiTargets.length) {
        setStatus(`All ${allDoiTargets.length} DOI entries were updated from DOI before; no update was started.`);
        return;
      }
    }

    bulkAbortRequested = false;
    let updated = 0;
    let failed = 0;
    const dirtyBeforeBatch = dirty;
    const revisionBeforeBatch = changeRevision;
    // Reserve one tracked revision before the first asynchronous lookup. This
    // keeps storage change listeners from reloading `entries` halfway through a
    // long "update all" run and leaving doiTargets pointing at detached objects.
    window.clearTimeout(autoSaveTimer);
    autoSaveTimer = null;
    dirty = true;
    changeRevision += 1;
    updateCount();
    setBusy(true, "Updating DOI…");
    setProgress(0, doiTargets.length, `0/${doiTargets.length} processed`, true);
    $(".ctca-manager-abort-doi", root).disabled = false;
    try {
      for (let index = 0; index < doiTargets.length; index += 1) {
        if (bulkAbortRequested) break;
        const entry = doiTargets[index];
        const doi = normalizeDoi(entry.fields.doi);
        activeDoiRequestId = `ctca-global-doi-${Date.now()}-${index}`;
        setStatus(`Retrieving DOI metadata ${index + 1}/${doiTargets.length}: ${entry.key}`);
        try {
          const metadata = await fetchDoiMetadata(doi, activeDoiRequestId);
          if (bulkAbortRequested) break;
          mergeMetadata(entry, metadata);
          updated += 1;
        } catch (error) {
          if (!bulkAbortRequested) {
            failed += 1;
            console.warn("[Smart Citations] Global DOI update failed:", error);
          }
        } finally {
          activeDoiRequestId = "";
        }
        setProgress(index + 1, doiTargets.length, `${index + 1}/${doiTargets.length} processed · ${updated} updated · ${failed} failed`, true);
        if (index + 1 < doiTargets.length && !bulkAbortRequested) await new Promise((resolve) => setTimeout(resolve, 120));
      }
      if (updated) {
        await saveDatabase(
          `DOI update completed: ${updated} updated${failed ? `, ${failed} failed` : ""}` +
          `${skippedSynchronized ? `, ${skippedSynchronized} previously updated skipped` : ""}.`
        );
      } else {
        changeRevision = revisionBeforeBatch;
        dirty = dirtyBeforeBatch || savedRevision < changeRevision;
        updateCount();
        if (dirty) scheduleAutoSave();
        setStatus(
          `DOI update completed: 0 updated${failed ? `, ${failed} failed` : ""}` +
          `${skippedSynchronized ? `, ${skippedSynchronized} previously updated skipped` : ""}.`,
          failed > 0
        );
      }
      renderAll();
    } catch (error) {
      setStatus(
        `DOI metadata was updated in memory but could not be saved yet: ${error?.message || String(error)}`,
        true
      );
    } finally {
      activeDoiRequestId = "";
      bulkAbortRequested = false;
      setBusy(false);
      if (dirty && autoSaveTimer === null) scheduleAutoSave();
      window.setTimeout(() => setProgress(0, 1, "", false), 1600);
    }
  }

  function abortDoiUpdate() {
    bulkAbortRequested = true;
    if (activeDoiRequestId) {
      extensionApi.runtime.sendMessage({ type: "ctca-abort-doi-request", requestId: activeDoiRequestId }).catch(() => {});
    }
    $(".ctca-manager-abort-doi", root).disabled = true;
    setStatus("Stopping DOI update after the current request…");
  }

  function removeEntryKeys(keys) {
    const removal = new Set(keys);
    const removalIdentities = new Set([...removal].map((key) => String(key).toLocaleLowerCase()));
    const removedEntries = entries.filter((entry) => removal.has(entry.key));
    for (const entry of entries) {
      if (removal.has(entry.key)) rememberGlobalDeletion(entry);
    }
    entries = entries.filter((entry) => !removal.has(entry.key));
    for (const entry of entries) {
      entry.crosslinks = normalizeCrosslinkKeys(entry.crosslinks, entry.key)
        .filter((key) => !removedEntries.some((removed) => crosslinkKeyMatchesEntry(key, removed)));
    }
    crosslinkNavigationStack = crosslinkNavigationStack.filter((key) => !removalIdentities.has(key.toLocaleLowerCase()));
    for (const key of removal) delete categoryState.memberships[key];
    selectedKeys = new Set([...selectedKeys].filter((key) => !removal.has(key)));
    if (removal.has(selectedKey)) selectedKey = entries[0]?.key || "";
    markDirty("Saving removals automatically…");
  }

  async function removeSelected() {
    if ([...selectedKeys].some(isReadOnlySharedEntry)) {
      setStatus("Read-only shared entries cannot be removed.", true);
      return;
    }
    if (selectedKeys.size < 2) return;
    const count = selectedKeys.size;
    const removedEntries = entries.filter((entry) => selectedKeys.has(entry.key));
    const confirmed = await showDialog({
      title: `Remove ${count} selected entries?`,
      message: syncNextcloudBibliography
        ? "The selected entries and all of their attached PDFs will be removed from the global bibliography database, browser storage or Nextcloud, and the synchronized Nextcloud bibliography."
        : "The selected entries and all of their attached PDFs will be removed from the global bibliography database and browser storage or Nextcloud.",
      buttons: [
        { label: "Keep entries", value: false },
        { label: `Remove ${count} entries`, value: true, danger: true }
      ],
      closeValue: false,
      danger: true
    });
    if (!confirmed) return;
    setStatus(`Removing attachments for ${count} entries…`);
    try {
      await globalThis.CollabTeXAttachmentStore.removeForEntries(removedEntries);
    } catch (error) {
      setStatus(`The entries were kept because their attachments could not all be deleted: ${error?.message || String(error)}`, true);
      return;
    }
    removeEntryKeys([...selectedKeys]);
    await saveDatabase(`Removed ${count} entries.`);
    await propagateRemovedEntriesToNextcloud(removedEntries);
    renderAll();
  }

  function createCategoryId() {
    return `category-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
  }

  function applySharedDatabaseResult(database) {
    entries = Array.isArray(database?.entries) ? database.entries.map(normalizeEntry) : entries;
    crosslinkNavigationStack = [];
    categoryState = normalizeCategoryState(database || {});
    deletionTombstones = normalizeDeletionTombstones(database?.deletedEntries);
    documentSyncState = normalizeDocumentSyncState(database?.documentSync);
    savedEntryContentByKey = entryContentMap(entries);
    dirty = false;
    savedRevision = changeRevision;
  }

  async function requestNextcloudSharePassword(title, message) {
    while (true) {
      let passwordInput;
      const password = await showDialog({
        title,
        message,
        controls: (container) => {
          const label = document.createElement("label");
          label.className = "ctca-app-dialog-field";
          label.innerHTML = `<span>Share password</span><input type="password" autocomplete="new-password" required>`;
          passwordInput = $("input", label);
          container.appendChild(label);
        },
        buttons: [
          { label: "Cancel", value: null },
          { label: "Continue", primary: true, getValue: () => passwordInput?.value || "" }
        ],
        closeValue: null
      });
      if (password === null) return null;
      if (password) return password;
      setStatus("Enter a password for the Nextcloud share.", true);
    }
  }

  async function createCategory(parentId = "") {
    parentId = typeof parentId === "string" ? parentId : "";
    if (parentId && isReadOnlySharedCategory(parentId)) {
      setStatus("Subcategories cannot be added to a read-only shared category.", true);
      return;
    }
    let input;
    let linkInput;
    const result = await showDialog({
      title: "Create bibliography category",
      message: parentId
        ? `Create a subcategory in “${categoryById(parentId)?.name || "category"}”.`
        : "Create a top-level category, or add a shared category from a Nextcloud link.",
      controls: (container) => {
        const label = document.createElement("label");
        label.className = "ctca-app-dialog-field";
        label.innerHTML = `<span>Category name</span><input type="text" maxlength="120" placeholder="e.g. Plasma instabilities">`;
        input = $("input", label);
        container.appendChild(label);
        if (!parentId) {
          const separator = document.createElement("div");
          separator.className = "ctca-shared-category-dialog-separator";
          separator.textContent = "or add a shared category";
          const linkLabel = document.createElement("label");
          linkLabel.className = "ctca-app-dialog-field";
          linkLabel.innerHTML = `<span>Nextcloud share link</span><input type="url" placeholder="https://cloud.example.org/s/…">`;
          linkInput = $("input", linkLabel);
          container.append(separator, linkLabel);
        }
      },
      buttons: [
        { label: "Cancel", value: null },
        ...(!parentId ? [{ label: "Add from link", getValue: () => ({ action: "import", value: linkInput?.value.trim() || "" }) }] : []),
        { label: "Create category", primary: true, getValue: () => ({ action: "create", value: input?.value.trim() || "" }) }
      ],
      closeValue: null
    });
    if (!result?.value) return;
    if (result.action === "import") {
      setBusy(true, "Adding shared category…");
      try {
        let sharePassword = "";
        let imported;
        while (!imported) {
          try {
            imported = await globalThis.CollabTeXAttachmentStore.importSharedCategory(result.value, sharePassword);
          } catch (error) {
            if (!error?.sharePasswordRequired) throw error;
            setBusy(false);
            const enteredPassword = await requestNextcloudSharePassword(
              "Password-protected shared category",
              sharePassword
                ? "The password was not accepted. Enter the password for this Nextcloud share again."
                : "This Nextcloud share is password-protected. Enter its password to add and synchronize the category."
            );
            if (enteredPassword === null) return;
            sharePassword = enteredPassword;
            setBusy(true, "Adding shared category…");
          }
        }
        applySharedDatabaseResult(imported.database);
        selectedCategoryId = imported.categoryId;
        renderAll();
        setStatus("Shared category added and copied to your Nextcloud account.");
      } finally {
        setBusy(false);
      }
      return;
    }
    categoryState.categories.push({
      id: createCategoryId(),
      name: result.value,
      parentId,
      order: categoryChildren(parentId).length
    });
    markDirty("Saving new category automatically…");
    renderCategories();
  }

  async function shareCategory(categoryId) {
    const category = categoryById(categoryId);
    if (!category || sharedCategoryRoot(categoryId)) return;
    if (!nextcloudConnected || !syncNextcloudBibliography) {
      setStatus("Connect to Nextcloud and enable bibliography synchronization before sharing a category.", true);
      return;
    }
    let permissionInput;
    const permission = await showDialog({
      title: `Share “${category.name}”`,
      message: "The category, all subcategories, bibliography entries, and attached PDFs will be copied to a separate Nextcloud folder and kept in sync.",
      controls: (container) => {
        const wrapper = document.createElement("div");
        wrapper.innerHTML = `
          <label class="ctca-app-dialog-check"><input type="radio" name="ctca-share-permission" value="read" checked> Others may only read</label>
          <label class="ctca-app-dialog-check"><input type="radio" name="ctca-share-permission" value="write"> Others may add and change categories, entries, and PDFs</label>`;
        permissionInput = wrapper;
        container.appendChild(wrapper);
      },
      buttons: [
        { label: "Cancel", value: null },
        { label: "Create share link", primary: true, getValue: () => permissionInput?.querySelector("input:checked")?.value || "read" }
      ],
      closeValue: null
    });
    if (!permission) return;
    setBusy(true, "Creating Nextcloud share…");
    try {
      await flushAutoSave();
      let sharePassword = "";
      let result;
      try {
        result = await globalThis.CollabTeXAttachmentStore.createSharedCategory(databaseSnapshot(), categoryId, permission);
      } catch (error) {
        if (!error?.sharePasswordRequired) throw error;
        setBusy(false);
        const enteredPassword = await requestNextcloudSharePassword(
          "Set a Nextcloud share password",
          "Your Nextcloud server requires passwords for public links. Set a password for this shared category and send it to recipients separately."
        );
        if (enteredPassword === null) return;
        sharePassword = enteredPassword;
        setBusy(true, "Creating password-protected Nextcloud share…");
        result = await globalThis.CollabTeXAttachmentStore.createSharedCategory(
          databaseSnapshot(),
          categoryId,
          permission,
          sharePassword
        );
      }
      applySharedDatabaseResult(result.database);
      renderAll();
      await showDialog({
        title: "Shared category link",
        message: (permission === "write"
          ? "Anyone with this link can add and change shared content."
          : "Anyone with this link can add a synchronized read-only copy.")
          + (sharePassword ? " The link is password-protected; send the password to recipients separately." : ""),
        controls: (container) => {
          const row = document.createElement("div");
          row.className = "ctca-shared-category-link-row";
          row.innerHTML = `<input type="url" readonly><button type="button">Copy</button>`;
          $("input", row).value = result.shareUrl;
          $("button", row).addEventListener("click", () => navigator.clipboard.writeText(result.shareUrl).catch(() => {}));
          container.appendChild(row);
        },
        buttons: [{ label: "Done", primary: true, value: true }],
        closeValue: true
      });
      setStatus("Category sharing is active.");
    } finally {
      setBusy(false);
    }
  }

  async function viewSharedCategoryLink(categoryId) {
    const sharedRoot = sharedCategoryRoot(categoryId);
    const shareUrl = String(sharedRoot?.shared?.shareUrl || "");
    if (!sharedRoot || !shareUrl) throw new Error("No share link is available for this category.");
    await showDialog({
      title: `Share link for “${sharedRoot.name}”`,
      message: sharedRoot.shared.role === "owner"
        ? "Copy this link to invite another user to the shared category."
        : "This is the link used to synchronize the remote shared category.",
      controls: (container) => {
        const row = document.createElement("div");
        row.className = "ctca-shared-category-link-row";
        row.innerHTML = `<input type="url" readonly><button type="button">Copy</button>`;
        $("input", row).value = shareUrl;
        $("button", row).addEventListener("click", () => navigator.clipboard.writeText(shareUrl).catch(() => {}));
        container.appendChild(row);
      },
      buttons: [{ label: "Done", primary: true, value: true }],
      closeValue: true
    });
  }

  async function stopSharedCategory(categoryId) {
    const category = categoryById(categoryId);
    const sharedRoot = sharedCategoryRoot(categoryId);
    if (!category || sharedRoot?.id !== categoryId) return;
    const owner = sharedRoot.shared.role === "owner";
    const confirmed = await showDialog({
      title: owner ? `Stop sharing “${category.name}”?` : `Stop remote sync for “${category.name}”?`,
      message: owner
        ? "This revokes the share link and removes the separate shared folder from Nextcloud. The local category remains. This cannot be undone."
        : "This removes the synchronized Nextcloud copy and disconnects the category. The local category remains. This cannot be undone.",
      buttons: [
        { label: "Cancel", value: false },
        { label: owner ? "Stop sharing" : "Stop remote sync", value: true, danger: true }
      ],
      closeValue: false,
      danger: true
    });
    if (!confirmed) return;
    setBusy(true, owner ? "Stopping sharing…" : "Stopping remote sync…");
    try {
      const result = await globalThis.CollabTeXAttachmentStore.stopSharedCategory(databaseSnapshot(), categoryId);
      applySharedDatabaseResult(result.database);
      renderAll();
      setStatus(owner ? "Sharing stopped; the local category was kept." : "Remote sync stopped; the local category was kept.");
    } finally {
      setBusy(false);
    }
  }

  async function removeCategory(categoryId) {
    const category = categoryById(categoryId);
    if (!category) return;
    const sharedRoot = sharedCategoryRoot(categoryId);
    if (sharedRoot?.id === categoryId) {
      setStatus(`Use “${sharedRoot.shared.role === "owner" ? "Stop sharing" : "Stop remote sync"}” before removing this category.`, true);
      return;
    }
    if (isReadOnlySharedCategory(categoryId)) {
      setStatus("Subcategories cannot be removed from a read-only shared category.", true);
      return;
    }
    const parent = categoryById(category.parentId);
    const choice = await showDialog({
      title: `Remove category “${category.name}”?`,
      message: "The bibliography entries themselves will not be deleted. Subcategories move to the current parent level.",
      buttons: parent
        ? [
            { label: "Cancel", value: null },
            { label: "Ungroup entries", value: "ungroup", danger: true },
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

    for (const [key, ids] of Object.entries(categoryState.memberships)) {
      if (!ids.includes(categoryId)) continue;
      const next = ids.filter((id) => id !== categoryId);
      if (choice === "parent" && parent && !next.includes(parent.id)) next.push(parent.id);
      setEntryCategoryIds(key, next);
    }
    const children = categoryChildren(categoryId);
    const parentChildren = categoryChildren(category.parentId).filter((item) => item.id !== categoryId);
    for (const child of children) {
      child.parentId = category.parentId;
      child.order = parentChildren.length;
      parentChildren.push(child);
    }
    categoryState.categories = categoryState.categories.filter((item) => item.id !== categoryId);
    normalizeCategoryOrders(category.parentId);
    if (selectedCategoryId === categoryId) selectedCategoryId = parent?.id || "all";
    markDirty("Saving category removal automatically…");
    renderAll();
  }

  function showDialog({ title, message = "", controls = null, buttons = [{ label: "Close", value: null }], closeValue = null, danger = false, dialogClass = "" }) {
    return new Promise((resolve) => {
      const titleElement = $("#ctca-app-dialog-title", appDialog);
      const messageElement = $(".ctca-app-dialog-message", appDialog);
      const controlsElement = $(".ctca-app-dialog-controls", appDialog);
      const actionsElement = $(".ctca-app-dialog-actions", appDialog);
      const closeButton = $(".ctca-app-dialog-close", appDialog);
      const backdrop = $(".ctca-app-dialog-backdrop", appDialog);
      const card = $(".ctca-app-dialog-card", appDialog);
      let settled = false;

      const finish = (value) => {
        if (settled) return;
        settled = true;
        appDialog.classList.remove("ctca-app-dialog-visible");
        appDialog.setAttribute("aria-hidden", "true");
        if (dialogClass) card.classList.remove(dialogClass);
        document.removeEventListener("keydown", onKeyDown, true);
        resolve(value);
      };
      const onKeyDown = (event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          finish(closeValue);
          return;
        }
        if (event.key === "Enter" && !event.target.matches("textarea")) {
          const primary = actionsElement.querySelector(".ctca-app-dialog-primary");
          if (primary && !primary.disabled) {
            event.preventDefault();
            primary.click();
          }
        }
      };

      titleElement.textContent = title || "Confirmation";
      messageElement.replaceChildren();
      const paragraph = document.createElement("p");
      paragraph.textContent = message;
      messageElement.appendChild(paragraph);
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
          const value = typeof specification.getValue === "function" ? specification.getValue() : specification.value;
          finish(value);
        });
        actionsElement.appendChild(button);
      }
      card.classList.toggle("ctca-app-dialog-danger-card", Boolean(danger));
      if (dialogClass) card.classList.add(dialogClass);
      closeButton.onclick = () => finish(closeValue);
      backdrop.onclick = () => finish(closeValue);
      document.addEventListener("keydown", onKeyDown, true);
      appDialog.classList.add("ctca-app-dialog-visible");
      appDialog.setAttribute("aria-hidden", "false");
      window.setTimeout(() => {
        const focusTarget = controlsElement.querySelector("input, select, textarea")
          || actionsElement.querySelector(".ctca-app-dialog-primary")
          || actionsElement.querySelector("button");
        focusTarget?.focus();
      }, 0);
    });
  }

  function addEntryForm() {
    const form = document.createElement("div");
    form.className = "ctca-global-dialog-form";
    form.innerHTML = `
      <label class="ctca-app-dialog-field ctca-app-dialog-field-wide ctca-global-dialog-doi"><span>DOI</span><span class="ctca-add-entry-doi-row"><input data-add-field="doi" placeholder="10.xxxx/…"><button type="button" class="ctca-add-entry-fetch-doi">🌐 Pull metadata</button></span></label>
      <label class="ctca-app-dialog-field ctca-add-entry-third"><span>Entry type</span><select data-add-property="type">${ENTRY_TYPES.map((type) => `<option value="${type}" ${type === "article" ? "selected" : ""}>${type}</option>`).join("")}</select></label>
      <label class="ctca-app-dialog-field ctca-add-entry-two-thirds"><span>Citation key</span><input data-add-property="key" placeholder="Generated if empty"></label>
      <label class="ctca-app-dialog-field ctca-add-entry-half"><span>Title</span><textarea rows="2" data-add-field="title"></textarea></label>
      <label class="ctca-app-dialog-field ctca-add-entry-half"><span>Authors</span><textarea rows="3" data-add-field="author" placeholder="Family, Given and Family, Given"></textarea></label>
      <label class="ctca-app-dialog-field ctca-add-entry-half"><span>Journal / book title</span><input data-add-field="journal"></label>
      <label class="ctca-app-dialog-field ctca-add-entry-half"><span>URL</span><input data-add-field="url"></label>
      <label class="ctca-app-dialog-field ctca-add-entry-third"><span>Year</span><input data-add-field="year"></label>
      <label class="ctca-app-dialog-field ctca-add-entry-third"><span>Volume</span><input data-add-field="volume"></label>
      <label class="ctca-app-dialog-field ctca-add-entry-third"><span>Pages / article number</span><input data-add-field="pages"></label>
      <label class="ctca-app-dialog-field ctca-add-entry-half"><span>Abstract</span><textarea rows="5" data-add-field="abstract"></textarea></label>
      <label class="ctca-app-dialog-field ctca-add-entry-half"><span>Keywords</span><textarea rows="2" data-add-field="keywords"></textarea></label>
      <label class="ctca-app-dialog-field ctca-app-dialog-field-wide"><span>Tags</span><input data-add-tags list="ctca-global-add-tag-list" placeholder="Comma-separated tags"><datalist id="ctca-global-add-tag-list">${allKnownTags().map((tag) => `<option value="${escapeHtml(tag)}"></option>`).join("")}</datalist></label>
      <section class="ctca-global-dialog-extra"><h3>Additional BibTeX fields</h3><div class="ctca-global-dialog-extra-list"></div><div class="ctca-manager-add-field-row"><select class="ctca-global-add-field-select">${AVAILABLE_FIELDS.map((field) => `<option value="${field}">${field}</option>`).join("")}</select><button type="button" class="ctca-global-add-field">+ Add field</button></div></section>
    `;
    $(".ctca-global-add-field", form).addEventListener("click", () => {
      const select = $(".ctca-global-add-field-select", form);
      const field = select.value;
      if (!field || form.querySelector(`[data-add-field="${CSS.escape(field)}"]`)) return;
      const row = document.createElement("label");
      row.className = "ctca-manager-extra-field";
      row.innerHTML = `<span>${escapeHtml(field)}</span><textarea rows="2" data-add-field="${escapeHtml(field)}"></textarea><button type="button" title="Remove field">×</button>`;
      $("button", row).addEventListener("click", () => row.remove());
      $(".ctca-global-dialog-extra-list", form).appendChild(row);
      $("textarea", row).focus();
    });
    $(".ctca-add-entry-fetch-doi", form).addEventListener("click", async (event) => {
      const doi = normalizeDoi($("[data-add-field=doi]", form).value);
      if (!doi) {
        setStatus("Enter a DOI first.", true);
        return;
      }
      event.currentTarget.disabled = true;
      try {
        const metadata = await fetchDoiMetadata(doi);
        const values = {
          doi,
          title: metadata.title,
          author: (metadata.authors || []).map((author) => author.family && author.given ? `${author.family}, ${author.given}` : author.name || author.family || "").filter(Boolean).join(" and "),
          journal: metadata.journal,
          year: metadata.year,
          volume: metadata.volume,
          pages: metadata.pages,
          url: metadata.url,
          abstract: metadata.abstract,
          keywords: metadata.keywords
        };
        for (const [field, value] of Object.entries(values)) {
          const input = form.querySelector(`[data-add-field="${field}"]`);
          if (input && value) input.value = value;
        }
        if (metadata.entryType) $("[data-add-property=type]", form).value = metadata.entryType;
        setStatus(`Metadata loaded from ${metadata.source}.`);
      } catch (error) {
        setStatus(error.message || String(error), true);
      } finally {
        event.currentTarget.disabled = false;
      }
    });
    return form;
  }

  function uniqueKey(base, except = "") {
    const used = new Set(entries.filter((entry) => entry.key !== except).map((entry) => entry.key.toLowerCase()));
    let key = String(base || "Reference").replace(/[^A-Za-z0-9_.:-]+/g, "") || "Reference";
    if (!used.has(key.toLowerCase())) return key;
    let index = 0;
    while (index < 26 && used.has(`${key}${String.fromCharCode(97 + index)}`.toLowerCase())) index += 1;
    return `${key}${String.fromCharCode(97 + Math.min(index, 25))}`;
  }

  function generatedKey(fields) {
    const first = String(fields.author || "Reference").split(/\s+and\s+/i)[0];
    const surname = first.includes(",") ? first.split(",")[0].trim() : first.trim().split(/\s+/).pop();
    const year = String(fields.year || "").match(/\d{4}/)?.[0] || "";
    return uniqueKey(`${surname || "Reference"}${year}`);
  }

  async function addEntry() {
    if (isReadOnlySharedCategory(selectedCategoryId)) {
      setStatus("Entries cannot be added to a read-only shared category.", true);
      return;
    }
    let form;
    const result = await showDialog({
      title: "Add bibliography entry",
      message: "DOI metadata can fill the form before saving.",
      dialogClass: "ctca-add-entry-dialog-card",
      controls: (container) => {
        form = addEntryForm();
        container.appendChild(form);
      },
      buttons: [
        { label: "Abort", value: null },
        {
          label: "Save entry",
          primary: true,
          getValue: () => {
            const fields = {};
            form.querySelectorAll("[data-add-field]").forEach((input) => {
              if (input.value.trim()) fields[input.dataset.addField] = input.value.trim();
            });
            return {
              type: $("[data-add-property=type]", form).value || "misc",
              key: $("[data-add-property=key]", form).value.trim(),
              fields,
              tags: globalThis.CollabTeXSearchTools.splitTags($("[data-add-tags]", form)?.value || "")
            };
          }
        }
      ],
      closeValue: null
    });
    if (!result) return;
    const key = uniqueKey(result.key || generatedKey(result.fields));
    const entry = {
      key,
      type: result.type || "misc",
      fields: result.fields,
      aliases: [],
      tags: result.tags || [],
      updatedAt: new Date().toISOString(),
      addedOn: new Date().toISOString(),
      starred: false,
      doiSyncedAt: result.fields.doi ? new Date().toISOString() : ""
    };
    entries.push(entry);
    if (selectedCategoryId !== "all" && selectedCategoryId !== "starred" && selectedCategoryId !== "uncategorized") {
      setEntryCategoryIds(key, [selectedCategoryId]);
    }
    selectedKey = key;
    selectedKeys = new Set([key]);
    await saveDatabase(`Added ${key}.`);
    renderAll();
  }

  function orcidMetadataText(value) {
    return String(value || "").trim();
  }

  function orcidMetadataAuthors(metadata) {
    return (metadata?.authors || []).map((author) =>
      orcidMetadataText(author?.name || [author?.given, author?.family].filter(Boolean).join(" "))
    ).filter(Boolean);
  }

  function hasOrcidDoiMetadata(metadata) {
    return Boolean(metadata && typeof metadata === "object" && orcidMetadataText(metadata.doi));
  }

  async function offerOrcidWorks(result = null, { force = false, announceEmpty = false } = {}) {
    let items = [];
    let chooser = null;
    let dialogPromise = null;
    let dialogClosed = false;
    let dialogMessage = null;
    let dialogControls = null;
    let closeButton = null;
    let addButton = null;
    let loadingProgress = null;
    const progressRequestId = !result && force
      ? `orcid-doi-${Date.now()}-${Math.random().toString(36).slice(2)}`
      : "";
    const onDiscoveryProgress = (message) => {
      if (message?.type !== "ctca-orcid-discover-progress"
        || message.progressRequestId !== progressRequestId) return;
      const completed = Math.max(0, Number(message.completed) || 0);
      const total = Math.max(0, Number(message.total) || 0);
      if (loadingProgress && total) {
        loadingProgress.hidden = false;
        loadingProgress.max = total;
        loadingProgress.value = Math.min(completed, total);
      }
    };

    const openOrcidDialog = (loading = false) => {
      dialogPromise = showDialog({
        title: "Import new co-authored manuscripts from ORCID",
        message: loading
          ? "Checking ORCID for new manuscripts and retrieving publication details by DOI…"
          : "",
        dialogClass: "ctca-orcid-works-dialog-card",
        controls: loading
          ? (container) => {
              const loadingState = document.createElement("div");
              loadingState.className = "ctca-orcid-work-loading";
              loadingState.setAttribute("role", "status");
              loadingState.setAttribute("aria-live", "polite");
              loadingState.innerHTML = `
                <span class="ctca-orcid-work-loading-main">
                  <span class="ctca-orcid-work-loading-spinner" aria-hidden="true"></span>
                  <span>Checking ORCID…</span>
                </span>
                <progress class="ctca-orcid-work-loading-progress" max="1" value="0" aria-label="DOI lookup progress" hidden></progress>
              `;
              loadingProgress = loadingState.querySelector(".ctca-orcid-work-loading-progress");
              container.appendChild(loadingState);
            }
          : null,
        buttons: [
          { label: loading ? "Close" : "Not now", value: [] },
          {
            label: "Add selected",
            primary: true,
            getValue: () => chooser
              ? [...chooser.querySelectorAll("[data-orcid-work]:checked")]
                .map((input) => Number(input.dataset.orcidWork))
                .filter((index) => Number.isInteger(index) && items[index])
              : []
          }
        ],
        closeValue: []
      });
      dialogPromise.then(() => { dialogClosed = true; });
      dialogMessage = $(".ctca-app-dialog-message p", appDialog);
      dialogControls = $(".ctca-app-dialog-controls", appDialog);
      const actions = $(".ctca-app-dialog-actions", appDialog);
      closeButton = actions.querySelector("button:not(.ctca-app-dialog-primary)");
      addButton = actions.querySelector(".ctca-app-dialog-primary");
      addButton.disabled = loading;
    };

    const showDialogResult = (message, { empty = false } = {}) => {
      if (!dialogPromise || dialogClosed) return;
      dialogMessage.textContent = message;
      if (empty) {
        dialogControls.replaceChildren();
        dialogControls.hidden = true;
        addButton.hidden = true;
        closeButton.textContent = "Close";
      }
    };

    if (announceEmpty) openOrcidDialog(true);

    let discovery = result;
    try {
      if (!discovery) {
        if (progressRequestId) extensionApi.runtime.onMessage.addListener(onDiscoveryProgress);
        let response;
        try {
          response = await extensionApi.runtime.sendMessage({
            type: "ctca-orcid-discover",
            force,
            progressRequestId,
            existingDois: entries.map((entry) => entry?.fields?.doi || "").filter(Boolean)
          });
        } finally {
          if (progressRequestId) extensionApi.runtime.onMessage.removeListener(onDiscoveryProgress);
        }
        if (!response?.ok) throw new Error(response?.error || "The ORCID manuscript check failed.");
        discovery = response;
      }
      if (dialogClosed) return;
      if (discovery.skipped) {
        const message = !discovery.authenticated
          ? (discovery.linked
              ? "Reconnect your ORCID account in Smart Citations options before checking for manuscripts."
              : "Link an ORCID account in Smart Citations options before checking for manuscripts.")
          : "ORCID was already checked within the last 24 hours.";
        if (announceEmpty) showDialogResult(message, { empty: true });
        setStatus(message, !discovery.linked);
        if (dialogPromise) await dialogPromise;
        return;
      }
      if (!force && discovery.newItemCount === 0) {
        return;
      }

      items = Array.isArray(discovery.items)
        ? discovery.items.filter((item) => hasOrcidDoiMetadata(item?.metadata))
        : [];
      const rejectedCount = Number(discovery.failedLookupCount) || 0;
      if (!items.length) {
        const message = "No new manuscript entries were found on ORCID.";
        if (announceEmpty) {
          showDialogResult(
            rejectedCount
              ? `${message} ${rejectedCount} ORCID work${rejectedCount === 1 ? " was" : "s were"} ignored because DOI lookup failed.`
              : message,
            { empty: true }
          );
        }
        if (announceEmpty) setStatus(message);
        if (dialogPromise) await dialogPromise;
        return;
      }

      if (!dialogPromise) openOrcidDialog(false);
      if (dialogClosed) return;
      dialogMessage.textContent =
        `${items.length} ORCID manuscript entr${items.length === 1 ? "y has" : "ies have"} DOI details. ` +
        `Select the ${items.length === 1 ? "entry" : "entries"} to add.` +
        (rejectedCount
          ? ` ${rejectedCount} ORCID work${rejectedCount === 1 ? " was" : "s were"} excluded because DOI lookup failed.`
          : "");
      chooser = document.createElement("div");
      chooser.className = "ctca-orcid-work-list";
      chooser.innerHTML = items.map((item, index) => {
        const metadata = item.metadata;
        const authors = orcidMetadataAuthors(metadata).join("; ") || "—";
        const publication = [
          `Journal: ${orcidMetadataText(metadata.journal) || "—"}`,
          metadata.volume ? `vol. ${metadata.volume}` : "",
          `Journal no.: ${orcidMetadataText(metadata.number) || "—"}`,
          `Pages: ${orcidMetadataText(metadata.pages) || "—"}`,
          `Year: ${orcidMetadataText(metadata.year) || "—"}`,
          `DOI ${item.doi}`
        ].filter(Boolean).join(" · ");
        return `
          <label class="ctca-orcid-work-choice">
            <input type="checkbox" data-orcid-work="${index}"${item.previouslyIgnored ? "" : " checked"}>
            <span>
              <strong>${escapeHtml(metadata.title || item.title || item.doi)}</strong>
              <span class="ctca-orcid-work-authors">Authors: ${escapeHtml(authors)}</span>
              <small>${escapeHtml(publication)}</small>
            </span>
          </label>
        `;
      }).join("");
      dialogControls.replaceChildren(chooser);
      dialogControls.hidden = false;
      closeButton.textContent = "Not now";
      addButton.hidden = false;
      addButton.disabled = false;
    } catch (error) {
      if (dialogPromise && !dialogClosed) {
        showDialogResult(
          `The ORCID manuscript check failed: ${error?.message || String(error)}`,
          { empty: true }
        );
        setStatus(error?.message || String(error), true);
        await dialogPromise;
        return;
      }
      throw error;
    }

    const selectedIndexes = await dialogPromise;
    const selectedIndexSet = new Set(selectedIndexes || []);
    await extensionApi.runtime.sendMessage({
      type: "ctca-orcid-record-review",
      ignoredDois: items
        .filter((_item, index) => !selectedIndexSet.has(index))
        .map((item) => item.doi),
      reconsideredDois: items
        .filter((_item, index) => selectedIndexSet.has(index))
        .map((item) => item.doi)
    }).catch(() => {});
    if (!selectedIndexes?.length) {
      setStatus("No ORCID manuscripts were added.");
      return;
    }

    setBusy(true, "Adding ORCID manuscripts…");
    let added = 0;
    const failed = [];
    try {
      for (let index = 0; index < selectedIndexes.length; index += 1) {
        const selectedItem = items[selectedIndexes[index]];
        const doi = normalizeDoi(selectedItem?.doi || "");
        if (!doi || entries.some((entry) =>
          normalizeDoi(entry?.fields?.doi || "").toLowerCase() === doi.toLowerCase()
        )) continue;
        setStatus(`Adding retrieved DOI details ${index + 1}/${selectedIndexes.length}: ${doi}`);
        try {
          const metadata = selectedItem.metadata;
          if (!hasOrcidDoiMetadata(metadata)) continue;
          const now = new Date().toISOString();
          const entry = {
            key: "",
            type: metadata.entryType || "article",
            fields: { doi },
            aliases: [],
            tags: [],
            updatedAt: now,
            doiSyncedAt: now,
            addedOn: now,
            starred: false
          };
          mergeMetadata(entry, { ...metadata, doi: metadata.doi || doi });
          entry.key = generatedKey(entry.fields);
          entries.push(entry);
          added += 1;
        } catch (error) {
          failed.push(`${doi}: ${error?.message || String(error)}`);
        }
      }
      if (added) {
        markDirty("Saving ORCID manuscripts…");
        await saveDatabase(`Added ${added} ORCID manuscript${added === 1 ? "" : "s"} from DOI metadata.`);
        renderAll();
      }
      if (failed.length) {
        setStatus(`${added} added; ${failed.length} failed. ${failed.join(" ")}`, true);
      } else if (!added) {
        setStatus("The selected ORCID manuscripts were already present.");
      }
    } finally {
      setBusy(false);
    }
  }

  function manuscriptWorkflowParameters() {
    const parameters = new URLSearchParams(location.search);
    const doi = normalizeDoi(parameters.get("manuscriptDoi") || "");
    const pdfUrl = parameters.get("manuscriptPdfUrl") || "";
    const sourceUrl = parameters.get("manuscriptSourceUrl") || "";
    const sourceTabIdValue = parameters.get("manuscriptSourceTabId") || "";
    const sourceTabId = /^\d+$/.test(sourceTabIdValue) ? Number(sourceTabIdValue) : null;
    if (!doi || !pdfUrl || !sourceUrl) return null;
    try {
      const parsedPdfUrl = new URL(pdfUrl);
      const parsedSourceUrl = new URL(sourceUrl);
      if (!/^https?:$/.test(parsedPdfUrl.protocol) || !/^https?:$/.test(parsedSourceUrl.protocol)) return null;
      return {
        doi,
        pdfUrl: parsedPdfUrl.href,
        sourceUrl: parsedSourceUrl.href,
        sourceTabId: Number.isInteger(sourceTabId) && sourceTabId >= 0 ? sourceTabId : null
      };
    } catch (_error) {
      return null;
    }
  }

  async function runManuscriptPdfWorkflow(workflow) {
    const normalizedDoi = normalizeDoi(workflow.doi).toLowerCase();
    let entry = entries.find((candidate) =>
      normalizeDoi(candidate?.fields?.doi || "").toLowerCase() === normalizedDoi
    ) || null;

    if (!entry) {
      setStatus(`Retrieving DOI metadata for ${workflow.doi}…`);
      const metadata = await fetchDoiMetadata(workflow.doi);
      const now = new Date().toISOString();
      entry = {
        key: "",
        type: metadata.entryType || "article",
        fields: { doi: workflow.doi },
        aliases: [],
        tags: [],
        updatedAt: now,
        doiSyncedAt: now,
        addedOn: now,
        starred: false
      };
      mergeMetadata(entry, { ...metadata, doi: metadata.doi || workflow.doi });
      entry.key = generatedKey(entry.fields);
      entries.push(entry);
      markDirty(`Saving ${entry.key}…`);
      await saveDatabase(`Added ${entry.key} from DOI metadata.`);
    }

    selectedKey = entry.key;
    selectedKeys = new Set([entry.key]);
    await activateWorkspaceTab("bibliography");
    renderAll();

    const existingAttachments = await globalThis.CollabTeXAttachmentStore.list(entry);
    if (existingAttachments.length) {
      setStatus(`Opening the PDF attached to ${entry.key}.`);
      await openPdfTab(entry, existingAttachments[0]);
      return;
    }

    setStatus(`Downloading the journal PDF for ${entry.key}…`);
    setPdfViewAttachmentProgress(true, "Downloading PDF…");
    let file;
    try {
      file = await globalThis.CollabTeXAttachmentStore.downloadWebPdf(
        workflow.pdfUrl,
        workflow.sourceUrl,
        Number.isInteger(workflow.sourceTabId) ? workflow.sourceTabId : null
      );
    } catch (error) {
      setPdfViewAttachmentProgress(false);
      await showPdfViewAttachmentFailure(error, workflow.sourceUrl);
      return;
    } finally {
      setPdfViewAttachmentProgress(false);
      if (Number.isInteger(workflow.sourceTabId)) {
        await globalThis.CollabTeXAttachmentStore.closeWebTab(workflow.sourceTabId);
      }
    }
    setStatus(`Journal PDF downloaded for ${entry.key}. Choose its storage and attach it.`);
    await openAddPdfDialog(entry, {
      files: [file],
      getFromWebFile: true,
      sourceUrl: workflow.sourceUrl,
      openAfterAttach: true,
      fromPdfView: true,
      failureJournalUrl: workflow.sourceUrl
    });
  }

  function waitForStandaloneCommandReady() {
    return new Promise((resolve) => {
      const check = () => {
        if (!busy && !appDialog.classList.contains("ctca-app-dialog-visible")) {
          resolve();
          return;
        }
        window.setTimeout(check, 120);
      };
      check();
    });
  }

  async function selectStandaloneEntry(key) {
    const entry = entryByKey(String(key || ""));
    if (!entry) throw new Error(`The requested bibliography entry “${key}” was not found.`);
    await activateWorkspaceTab("bibliography");
    selectedKey = entry.key;
    selectedKeys = new Set([entry.key]);
    renderAll();
    setStatus(`Selected ${entry.key}.`);
  }

  function queueStandaloneCommand(command) {
    standaloneCommandQueue = standaloneCommandQueue
      .catch(() => {})
      .then(async () => {
        await waitForStandaloneCommandReady();
        setBusy(true, "Opening…");
        try {
          if (command?.type === "ctca-run-manuscript-pdf-workflow") {
            await runManuscriptPdfWorkflow(command.workflow || {});
          } else if (command?.type === "ctca-select-standalone-entry") {
            await selectStandaloneEntry(command.key);
          } else if (command?.type === "ctca-check-orcid-now") {
            await offerOrcidWorks(null, { force: true, announceEmpty: true });
          } else if (command?.type === "ctca-offer-orcid-works") {
            await offerOrcidWorks(command.result);
          }
        } catch (error) {
          setStatus(error?.message || String(error), true);
        } finally {
          setBusy(false);
        }
      });
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
        try {
          Promise.resolve(extensionApi.runtime.sendMessage({
            type: "ctca-auto-continue-web-pdf-ack",
            tabId: normalizedTabId
          })).catch(() => {});
        } catch (_error) {}
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

  function connectStandaloneManager() {
    if (standaloneManagerPort) return;
    try {
      const port = extensionApi.runtime.connect({ name: "ctca-standalone-manager" });
      standaloneManagerPort = port;
      port.onMessage.addListener((command) => {
        if (command?.type === "ctca-auto-continue-web-pdf") {
          scheduleWebPdfAutoContinue(command.tabId);
          return;
        }
        queueStandaloneCommand(command);
      });
      port.onDisconnect.addListener(() => {
        if (standaloneManagerPort === port) standaloneManagerPort = null;
      });
    } catch (_error) {
      standaloneManagerPort = null;
    }
  }

  function syncManagerTableHeader() {
    const header = $(".ctca-manager-table-head", root);
    const list = $(".ctca-manager-list", root);
    if (!header || !list) return;
    const scrollbarWidth = Math.max(0, list.offsetWidth - list.clientWidth);
    root.style.setProperty("--ctca-manager-list-scrollbar-width", `${scrollbarWidth}px`);
    header.scrollLeft = list.scrollLeft;
  }

  function applyManagerTableColumns() {
    const visible = LIST_COLUMNS.filter((column) => managerColumnVisible(column.id));
    const flexibleColumnId = visible.some((column) => column.id === "title") ? "title" : visible[0]?.id;
    const widths = [
      34,
      24,
      ...visible.map((column) => column.id === flexibleColumnId ? 0 : columnWidths[column.id])
    ];
    const template = [
      "34px",
      "24px",
      ...visible.map((column) => column.id === flexibleColumnId
        ? "minmax(0,1fr)"
        : `${Math.round(columnWidths[column.id])}px`)
    ];
    root.style.setProperty("--ctca-manager-table-columns", template.join(" "));
    root.style.setProperty("--ctca-manager-table-width", `${widths.reduce((sum, width) => sum + width, 0)}px`);
    for (const column of LIST_COLUMNS) {
      const header = root.querySelector(`.ctca-manager-column-header[data-manager-column="${column.id}"]`);
      if (!header) continue;
      header.hidden = !managerColumnVisible(column.id);
      const resizer = $(".ctca-manager-column-resizer", header);
      if (resizer) resizer.hidden = header.hidden || column.id === visible[visible.length - 1]?.id;
    }
  }

  function managerColumnVisible(columnId) {
    return columnId === "addedOn" && selectedCategoryId === "recent"
      ? true
      : columnVisibility[columnId] !== false;
  }

  function renderColumnVisibilityMenu(clientX, clientY) {
    const menu = $(".ctca-manager-column-menu", root);
    const choices = [
      ...LIST_COLUMNS.map((column) => ({ id: column.id, label: column.label })),
      { id: "authors", label: "Authors" }
    ];
    menu.innerHTML = choices.map((choice) => `
      <label role="menuitemcheckbox">
        <input type="checkbox" data-manager-visible-column="${choice.id}" ${columnVisibility[choice.id] !== false ? "checked" : ""}>
        <span>${escapeHtml(choice.label)}</span>
      </label>
    `).join("") + `
      <div class="ctca-manager-column-menu-separator" role="separator"></div>
      <label role="menuitemcheckbox">
        <input type="checkbox" data-manager-list-display="crosslinks" ${listDisplayOptions.crosslinks ? "checked" : ""}>
        <span>Cross-referenced entries</span>
      </label>
      <label role="menuitemcheckbox">
        <input type="checkbox" data-manager-list-display="entryNotes" ${listDisplayOptions.entryNotes ? "checked" : ""}>
        <span>Notes and comments</span>
      </label>
      <label role="menuitemcheckbox">
        <input type="checkbox" data-manager-list-display="pdfNotes" ${listDisplayOptions.pdfNotes ? "checked" : ""}>
        <span>PDF notes</span>
      </label>`;
    menu.style.left = `${Math.min(clientX, window.innerWidth - 235)}px`;
    menu.style.top = `${Math.max(8, Math.min(clientY, window.innerHeight - 350))}px`;
    menu.hidden = false;
  }

  function setColumnVisible(columnId, visible) {
    if (!(columnId in columnVisibility)) return false;
    if (!visible && columnId !== "authors") {
      const visibleColumns = LIST_COLUMNS.filter((column) => columnVisibility[column.id] !== false);
      if (visibleColumns.length <= 1 && visibleColumns[0]?.id === columnId) return false;
    }
    columnVisibility[columnId] = Boolean(visible);
    applyManagerTableColumns();
    renderList();
    saveUiState().catch(() => {});
    return true;
  }

  function setListDisplayOption(option, visible) {
    if (!(option in listDisplayOptions)) return;
    listDisplayOptions[option] = Boolean(visible);
    renderList();
    saveUiState().catch(() => {});
  }

  function initializeTableColumns() {
    const header = $(".ctca-manager-table-head", root);
    const list = $(".ctca-manager-list", root);
    const menu = $(".ctca-manager-column-menu", root);
    root.appendChild(menu);
    applyManagerTableColumns();
    syncManagerTableHeader();

    header.addEventListener("contextmenu", (event) => {
      event.preventDefault();
      renderColumnVisibilityMenu(event.clientX, event.clientY);
    });
    header.querySelectorAll(".ctca-manager-column-eye").forEach((button) => {
      button.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        setColumnVisible(button.closest("[data-manager-column]")?.dataset.managerColumn, false);
      });
    });
    header.querySelectorAll(".ctca-manager-column-resizer").forEach((handle) => {
      handle.addEventListener("pointerdown", (event) => {
        if (event.button !== 0) return;
        event.preventDefault();
        event.stopPropagation();
        const column = handle.closest("[data-manager-column]")?.dataset.managerColumn;
        const definition = LIST_COLUMNS.find((item) => item.id === column);
        if (!definition) return;
        const startX = event.clientX;
        const visibleColumns = LIST_COLUMNS.filter((item) => managerColumnVisible(item.id));
        const columnIndex = visibleColumns.findIndex((item) => item.id === column);
        const nextDefinition = visibleColumns[columnIndex + 1];
        if (!nextDefinition) return;
        const currentHeader = header.querySelector(`[data-manager-column="${column}"]`);
        const nextHeader = header.querySelector(`[data-manager-column="${nextDefinition.id}"]`);
        const startWidth = currentHeader?.getBoundingClientRect().width || columnWidths[column];
        const startNextWidth = nextHeader?.getBoundingClientRect().width || columnWidths[nextDefinition.id];
        root.classList.add("ctca-manager-resizing-columns");
        const move = (moveEvent) => {
          const delta = moveEvent.clientX - startX;
          const minimumDelta = Math.max(
            definition.min - startWidth,
            startNextWidth - MAX_MANAGER_COLUMN_WIDTH
          );
          const maximumDelta = Math.min(
            MAX_MANAGER_COLUMN_WIDTH - startWidth,
            startNextWidth - nextDefinition.min
          );
          const effectiveDelta = Math.max(minimumDelta, Math.min(maximumDelta, delta));
          columnWidths[column] = startWidth + effectiveDelta;
          columnWidths[nextDefinition.id] = startNextWidth - effectiveDelta;
          applyManagerTableColumns();
          syncManagerTableHeader();
        };
        const finish = () => {
          document.removeEventListener("pointermove", move, true);
          document.removeEventListener("pointerup", finish, true);
          document.removeEventListener("pointercancel", finish, true);
          root.classList.remove("ctca-manager-resizing-columns");
          renderList();
          saveUiState().catch(() => {});
        };
        document.addEventListener("pointermove", move, true);
        document.addEventListener("pointerup", finish, true);
        document.addEventListener("pointercancel", finish, true);
      });
    });
    $(".ctca-manager-star-sort", header).addEventListener("click", () => {
      starredFirst = !starredFirst;
      renderList();
      saveUiState().catch(() => {});
    });
    menu.addEventListener("change", (event) => {
      const input = event.target.closest("[data-manager-visible-column]");
      if (input && !setColumnVisible(input.dataset.managerVisibleColumn, input.checked)) {
        input.checked = columnVisibility[input.dataset.managerVisibleColumn] !== false;
      }
      const displayInput = event.target.closest("[data-manager-list-display]");
      if (displayInput) setListDisplayOption(displayInput.dataset.managerListDisplay, displayInput.checked);
    });
    list.addEventListener("scroll", () => {
      header.scrollLeft = list.scrollLeft;
      scheduleVirtualListWindow();
    }, { passive: true });
    if (typeof ResizeObserver === "function") {
      virtualListResizeObserver?.disconnect();
      virtualListResizeObserver = new ResizeObserver(() => {
        syncManagerTableHeader();
        list.querySelectorAll(".ctca-manager-row").forEach((row) => fitManagerRowTags(row));
        scheduleVirtualListWindow();
      });
      virtualListResizeObserver.observe(list);
    }
  }

  function applyColumnWidths() {
    root.style.setProperty("--ctca-category-width", `${categoryWidth}px`);
    root.style.setProperty("--ctca-details-width", `${detailsWidth}px`);
  }

  function initializeResizers() {
    const bind = (handle, kind) => {
      handle.addEventListener("pointerdown", (event) => {
        if (event.button !== 0) return;
        event.preventDefault();
        const startX = event.clientX;
        const startCategory = categoryWidth;
        const startDetails = detailsWidth;
        root.classList.add("ctca-manager-resizing");
        const move = (moveEvent) => {
          const delta = moveEvent.clientX - startX;
          if (kind === "categories") categoryWidth = Math.max(130, Math.min(420, startCategory + delta));
          else detailsWidth = Math.max(280, Math.min(900, startDetails - delta));
          applyColumnWidths();
        };
        const finish = () => {
          document.removeEventListener("pointermove", move, true);
          document.removeEventListener("pointerup", finish, true);
          document.removeEventListener("pointercancel", finish, true);
          root.classList.remove("ctca-manager-resizing");
          saveUiState().catch(() => {});
        };
        document.addEventListener("pointermove", move, true);
        document.addEventListener("pointerup", finish, true);
        document.addEventListener("pointercancel", finish, true);
      });
      handle.addEventListener("keydown", (event) => {
        if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
        event.preventDefault();
        const delta = (event.key === "ArrowRight" ? 1 : -1) * (event.shiftKey ? 40 : 10);
        if (kind === "categories") categoryWidth = Math.max(130, Math.min(420, categoryWidth + delta));
        else detailsWidth = Math.max(280, Math.min(900, detailsWidth - delta));
        applyColumnWidths();
        saveUiState().catch(() => {});
      });
    };
    bind($(".ctca-manager-resizer-categories", root), "categories");
    bind($(".ctca-manager-resizer-details", root), "details");
  }

  function applySearchFieldSettings() {
    root.querySelectorAll("[data-manager-search-field]").forEach((checkbox) => {
      checkbox.checked = Boolean(searchFields[checkbox.dataset.managerSearchField]);
    });
  }

  function applyAdvancedSearchUi() {
    const typeSelect = $(".ctca-search-filter-type", root);
    if (typeSelect && typeSelect.options.length <= 1) {
      for (const type of ENTRY_TYPES) {
        const option = document.createElement("option");
        option.value = type;
        option.textContent = type;
        typeSelect.appendChild(option);
      }
    }
    const abstractToggle = $(".ctca-search-include-abstract", root);
    const pdfToggle = $(".ctca-search-include-pdf", root);
    const notesCommentsToggle = $(".ctca-search-include-notes-comments", root);
    if (abstractToggle) abstractToggle.checked = searchOptions.includeAbstract !== false;
    if (pdfToggle) pdfToggle.checked = searchOptions.includePdfText === true;
    if (notesCommentsToggle) notesCommentsToggle.checked = searchOptions.includeNotesComments === true;
    if (typeSelect) typeSelect.value = searchFilters.type || "";
    const yearFrom = $(".ctca-search-filter-year-from", root);
    const yearTo = $(".ctca-search-filter-year-to", root);
    const doi = $(".ctca-search-filter-doi", root);
    const tagged = $(".ctca-search-filter-tagged", root);
    if (yearFrom) yearFrom.value = searchFilters.yearFrom || "";
    if (yearTo) yearTo.value = searchFilters.yearTo || "";
    if (doi) doi.value = searchFilters.doi || "any";
    if (tagged) tagged.value = searchFilters.tagged || "any";
    updateSearchFilterBadge();
  }

  function updateSearchFilterBadge() {
    const button = $(".ctca-manager-search-details", root);
    if (!button) return;
    const count = globalThis.CollabTeXSearchTools.activeFilterCount(searchFilters);
    button.dataset.filterCount = count ? String(count) : "";
    button.classList.toggle("ctca-search-has-filters", count > 0);
  }

  function insertIntoSearch(value, cursorBack = 0) {
    const input = $(".ctca-manager-search", root);
    if (!input) return;
    const start = Number.isFinite(input.selectionStart) ? input.selectionStart : input.value.length;
    const end = Number.isFinite(input.selectionEnd) ? input.selectionEnd : input.value.length;
    const needsSpace = start > 0 && !/\s/.test(input.value[start - 1]) && value !== "!";
    const insertion = `${needsSpace ? " " : ""}${value}`;
    input.setRangeText(insertion, start, end, "end");
    const next = Math.max(0, (input.selectionStart || input.value.length) - Number(cursorBack || 0));
    input.setSelectionRange(next, next);
    window.clearTimeout(searchRenderTimer);
    searchRenderTimer = null;
    query = input.value;
    $(".ctca-manager-search-clear", root).hidden = !query;
    renderList();
    input.focus();
  }

  function renderAll() {
    renderCategories();
    renderList();
  }

  function encodeBase64Url(value) {
    const text = String(value || "");
    let binary = "";
    if (typeof TextEncoder === "function") {
      const bytes = new TextEncoder().encode(text);
      for (let index = 0; index < bytes.length; index += 0x8000) {
        binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
      }
    } else {
      binary = unescape(encodeURIComponent(text));
    }
    return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
  }

  function decodeBase64Url(value) {
    const encoded = String(value || "").replace(/-/g, "+").replace(/_/g, "/");
    const binary = atob(encoded.padEnd(Math.ceil(encoded.length / 4) * 4, "="));
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    return typeof TextDecoder === "function"
      ? new TextDecoder().decode(bytes)
      : decodeURIComponent(escape(binary));
  }

  function exportBibValue(value) {
    const text = String(value ?? "").trim();
    return text ? `{${text}}` : "";
  }

  function exportBibEntry(entry, { includeCategoryTree = false } = {}) {
    const fields = Object.fromEntries(
      Object.entries(entry.fields || {}).filter(([name, value]) => value !== undefined && value !== null && String(value).trim() && !String(name).startsWith("ctca_"))
    );
    fields.ctca_meta_version = "1";
    if ((entry.aliases || []).length && !fields.ids) fields.ids = [...new Set(entry.aliases)].join(", ");
    if (entry.doiSyncedAt) fields.ctca_doi_synced = entry.doiSyncedAt;
    if (entry.addedOn) fields.ctca_added_on = entry.addedOn;
    if (entry.starred) fields.ctca_starred = "true";
    const tags = globalThis.CollabTeXSearchTools.splitTags(entry.tags || []);
    if (tags.length) fields.ctca_tags = tags.join(", ");
    const comments = normalizeCommentItems(entry.comments);
    if (comments.length) fields[CTCA_COMMENTS_FIELD] = encodeBase64Url(JSON.stringify(comments));
    const crosslinks = normalizeCrosslinkKeys(entry.crosslinks, entry.key);
    if (crosslinks.length) fields[CTCA_CROSSLINKS_FIELD] = crosslinks.join(", ");
    const memberships = categoryState.memberships?.[entry.key] || [];
    if (memberships.length) fields.ctca_categories = memberships.join(",");
    if (includeCategoryTree && categoryState.categories.length) {
      fields.ctca_category_tree = encodeBase64Url(JSON.stringify({
        version: 1,
        categories: categoryState.categories.map((category) => ({
          id: category.id,
          name: category.name,
          parentId: category.parentId || "",
          order: Number(category.order) || 0
        }))
      }));
    }

    const preferredOrder = [
      "title", "year", "journal", "journaltitle", "booktitle", "author", "editor",
      "volume", "number", "pages", "publisher", "institution", "url", "doi",
      "abstract", "keywords", "ctca_meta_version", "ctca_doi_synced", "ctca_added_on", "ctca_starred", "ctca_tags", CTCA_COMMENTS_FIELD, CTCA_CROSSLINKS_FIELD,
      "ctca_categories", "ctca_category_tree"
    ];
    const names = [
      ...preferredOrder.filter((name) => fields[name]),
      ...Object.keys(fields).filter((name) => !preferredOrder.includes(name) && fields[name]).sort()
    ];
    const lines = names.map((name) => `    ${name} = ${exportBibValue(fields[name])}`);
    return `@${entry.type || "misc"}{${entry.key},\n${lines.join(",\n")}\n}`;
  }


  function bibImportEntryLabel(entry) {
    const title = stripBibValue(entry?.fields?.title || "Untitled reference");
    const doi = normalizeDoi(entry?.fields?.doi || "");
    const details = [title, doi ? `DOI ${doi}` : ""].filter(Boolean).join(" · ");
    return `${entry?.key || "(no citation key)"}${details ? ` — ${details}` : ""}`;
  }

  function buildBibImportPlan(currentEntries, importedEntries) {
    const existing = currentEntries.map(normalizeEntry);
    const incoming = importedEntries.map(normalizeEntry);
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
    all.forEach((entry, index) => {
      const key = String(entry.key || "").trim().toLowerCase();
      const doi = normalizeDoi(entry.fields?.doi || "").toLowerCase();
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
    all.forEach((_entry, index) => {
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
      const componentEntries = [
        ...component.existingIndices.map((index) => existing[index]),
        ...component.importIndices.map((index) => incoming[index])
      ];
      const keyCounts = new Map();
      const doiCounts = new Map();
      for (const entry of componentEntries) {
        const key = String(entry.key || "").trim().toLowerCase();
        const doi = normalizeDoi(entry.fields?.doi || "").toLowerCase();
        if (key) keyCounts.set(key, (keyCounts.get(key) || 0) + 1);
        if (doi) doiCounts.set(doi, (doiCounts.get(doi) || 0) + 1);
      }
      const reasons = [];
      const duplicateKeys = [...keyCounts.entries()].filter(([, count]) => count > 1).map(([key]) => key);
      const duplicateDois = [...doiCounts.entries()].filter(([, count]) => count > 1).map(([doi]) => doi);
      if (duplicateKeys.length) reasons.push(`Citation key: ${duplicateKeys.join(", ")}`);
      if (duplicateDois.length) reasons.push(`DOI: ${duplicateDois.join(", ")}`);
      conflicts.push({ ...component, reason: reasons.join(" · ") || "Matching bibliography entry" });
    }
    return { existing, incoming, additions, conflicts };
  }

  async function chooseBibImportConflicts(plan, fileName) {
    if (!plan.conflicts.length) return {};
    const choices = {};
    const result = await showDialog({
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
          const existingLabels = conflict.existingIndices.map((index) => bibImportEntryLabel(plan.existing[index]));
          const importedOptions = conflict.importIndices.map((index, optionIndex) => {
            const checked = !conflict.existingIndices.length && optionIndex === 0 ? " checked" : "";
            return `<label><input type="radio" name="${groupName}" value="import:${index}"${checked}><span><strong><span class="ctca-bib-import-conflict-source">Imported</span>Use imported entry</strong><small>${escapeHtml(bibImportEntryLabel(plan.incoming[index]))}</small></span></label>`;
          }).join("");
          row.innerHTML = `
            <legend>${escapeHtml(conflict.reason)}</legend>
            ${conflict.existingIndices.length ? `<label><input type="radio" name="${groupName}" value="current" checked><span><strong><span class="ctca-bib-import-conflict-source">Current</span>Keep current database entr${conflict.existingIndices.length === 1 ? "y" : "ies"}</strong><small class="ctca-bib-import-conflict-current-list">${existingLabels.map((label) => `<span>${escapeHtml(label)}</span>`).join("")}</small></span></label>` : ""}
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

  function mergeImportedCategoryState(imported, selectedImportIndices, removedExistingKeys, replacementMemberships = new Map()) {
    const categoriesById = new Map(categoryState.categories.map((category) => [category.id, { ...category }]));
    for (const category of imported.categories || []) {
      if (!categoriesById.has(category.id)) categoriesById.set(category.id, { ...category });
    }
    const memberships = Object.fromEntries(
      Object.entries(categoryState.memberships || {})
        .filter(([key]) => !removedExistingKeys.has(key))
        .map(([key, ids]) => [key, [...ids]])
    );
    for (const index of selectedImportIndices) {
      const key = imported.entries[index]?.key;
      if (!key) continue;
      const ids = imported.memberships?.[key];
      if (Array.isArray(ids) && ids.length) memberships[key] = [...new Set(ids)];
      else if (replacementMemberships.has(key)) memberships[key] = [...replacementMemberships.get(key)];
    }
    categoryState = normalizeCategoryState({ categories: [...categoriesById.values()], memberships });
  }


  async function importBibFileIntoGlobalDatabase() {
    const file = await new Promise((resolve) => {
      const input = document.createElement("input");
      input.type = "file";
      input.accept = ".bib,application/x-bibtex,text/plain";
      input.addEventListener("change", () => resolve(input.files?.[0] || null), { once: true });
      input.click();
    });
    if (!file) return false;

    setBusy(true, "Reading bibliography…");
    let imported;
    try {
      const text = await file.text();
      imported = globalThis.CollabTeXAttachmentStore.bibToDatabase(text);
      if (!(imported.entries || []).length) throw new Error("The selected file contains no parseable BibTeX entries.");
    } finally {
      setBusy(false);
    }

    const plan = buildBibImportPlan(entries, imported.entries || []);
    const choices = await chooseBibImportConflicts(plan, file.name);
    if (choices === null) return false;

    const selectedImportIndices = new Set(plan.additions);
    const removedExistingIndices = new Set();
    const replacementMemberships = new Map();
    let replacedGroups = 0;
    plan.conflicts.forEach((conflict, conflictIndex) => {
      const choice = choices[conflictIndex] || (conflict.existingIndices.length ? "current" : `import:${conflict.importIndices[0]}`);
      if (!choice.startsWith("import:")) return;
      const importIndex = Number(choice.slice("import:".length));
      if (!Number.isInteger(importIndex)) return;
      selectedImportIndices.add(importIndex);
      const importedKey = plan.incoming[importIndex]?.key || "";
      const inheritedCategories = new Set();
      conflict.existingIndices.forEach((index) => {
        removedExistingIndices.add(index);
        const existingKey = plan.existing[index]?.key;
        for (const categoryId of categoryState.memberships?.[existingKey] || []) inheritedCategories.add(categoryId);
      });
      if (importedKey && inheritedCategories.size) replacementMemberships.set(importedKey, [...inheritedCategories]);
      if (conflict.existingIndices.length) replacedGroups += 1;
    });

    const removedKeys = new Set([...removedExistingIndices].map((index) => plan.existing[index]?.key).filter(Boolean));
    const retained = plan.existing.filter((_entry, index) => !removedExistingIndices.has(index));
    const now = new Date().toISOString();
    const selectedImported = [...selectedImportIndices]
      .sort((left, right) => left - right)
      .map((index) => ({
        ...normalizeEntry(plan.incoming[index]),
        updatedAt: plan.incoming[index]?.updatedAt || now,
        addedOn: plan.incoming[index]?.addedOn || now
      }));

    if (!selectedImported.length && !removedExistingIndices.size) {
      setStatus(`No entries were imported from ${file.name}; the current database versions were kept.`);
      return true;
    }

    entries = [...retained, ...selectedImported];
    mergeImportedCategoryState(imported, selectedImportIndices, removedKeys, replacementMemberships);
    selectedKey = selectedImported[0]?.key || entries[0]?.key || "";
    selectedKeys = selectedKey ? new Set([selectedKey]) : new Set();
    dirty = true;
    changeRevision += Math.max(1, selectedImported.length + removedExistingIndices.size);
    await saveDatabase(`Merged ${file.name} into the global bibliography.`);
    renderAll();
    const skipped = Math.max(0, (imported.entries || []).length - selectedImported.length);
    setStatus(
      `Imported ${selectedImported.length} entr${selectedImported.length === 1 ? "y" : "ies"} from ${file.name}` +
      `${replacedGroups ? `, replacing ${replacedGroups} conflicting database selection${replacedGroups === 1 ? "" : "s"}` : ""}` +
      `${skipped ? `; kept the current version for ${skipped} imported conflict${skipped === 1 ? "" : "s"}` : ""}.`
    );
    return true;
  }

  async function syncExistingNextcloudBackup() {
    let config = await globalThis.CollabTeXAttachmentStore.getConfig();
    if (!nextcloudCredentialsPresent(config)) {
      await openPdfStorageSettings();
      config = await globalThis.CollabTeXAttachmentStore.getConfig();
      if (!nextcloudCredentialsPresent(config)) return false;
    }
    if (!config.nextcloud?.syncBibliography) {
      config.nextcloud = { ...(config.nextcloud || {}), syncBibliography: true };
      await globalThis.CollabTeXAttachmentStore.saveConfig(config);
    }
    nextcloudConnected = true;
    syncNextcloudBibliography = true;
    updateNextcloudSyncToggle(config);
    setBusy(true, "Synchronizing Nextcloud bibliography…");
    try {
      const result = await synchronizeNextcloud({ showSuccess: false, resolveConflicts: true });
      await loadDatabase();
      selectedKey = entries[0]?.key || "";
      selectedKeys = selectedKey ? new Set([selectedKey]) : new Set();
      renderAll();
      if (!entries.length) throw new Error("The connected Nextcloud backup contains no bibliography entries.");
      setStatus(`Restored ${entries.length} bibliography entr${entries.length === 1 ? "y" : "ies"} from Nextcloud.`);
      return Boolean(result);
    } finally {
      setBusy(false);
    }
  }

  async function exportGlobalBibliography() {
    if (!entries.length) {
      setStatus("There are no bibliography entries to export.", true);
      return;
    }
    await flushAutoSave();
    const sorted = [...entries].sort((left, right) => String(left.key).localeCompare(String(right.key), undefined, { numeric: true, sensitivity: "base" }));
    const carrierKey = sorted[0]?.key || "";
    const text = `${sorted.map((entry) => exportBibEntry(entry, { includeCategoryTree: entry.key === carrierKey })).join("\n\n")}\n`;
    const blob = new Blob([text], { type: "application/x-bibtex;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = "global-bibliography.bib";
    link.style.display = "none";
    document.body.appendChild(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1500);
    setStatus(`Exported ${entries.length} entr${entries.length === 1 ? "y" : "ies"} as global-bibliography.bib.`);
  }

  async function closeStandaloneManager() {
    try {
      if (activeWorkspaceTab !== "bibliography") await requestPdfFrameSave(activeWorkspaceTab);
      await flushAutoSave();
    } catch (error) {
      setStatus(error?.message || String(error), true);
      return;
    }

    try {
      const response = await extensionApi.runtime.sendMessage({ type: "ctca-close-standalone-manager" });
      if (response?.ok) return;
    } catch (_) {
      // Fall through to the direct tab/window close fallbacks.
    }

    try {
      const currentTab = await extensionApi.tabs.getCurrent?.();
      if (Number.isInteger(currentTab?.id)) {
        await extensionApi.tabs.remove(currentTab.id);
        return;
      }
    } catch (_) {
      // window.close() is the final compatibility fallback.
    }

    window.close();
  }

  function setPdfPaneCollapsed(pane, collapsed, { trackFullscreenChange = true } = {}) {
    const state = openPdfTabs.get(activeWorkspaceTab);
    if (!state) return;
    const stateKey = pane === "notes" ? "notesCollapsed" : "detailsCollapsed";
    state[stateKey] = Boolean(collapsed);
    if (
      trackFullscreenChange
      && root.classList.contains("ctca-pdf-maximized")
      && pdfFullscreenPaneState?.state === state
    ) {
      pdfFullscreenPaneState[pane === "notes" ? "notesModified" : "detailsModified"] = true;
    }
    const layout = $(".ctca-pdf-layout", root);
    layout?.classList.toggle(
      pane === "notes" ? "ctca-pdf-notes-collapsed" : "ctca-pdf-details-collapsed",
      Boolean(collapsed)
    );
    const collapseButton = $(pane === "notes" ? ".ctca-pdf-collapse-notes" : ".ctca-pdf-collapse-details", root);
    if (collapseButton) {
      collapseButton.setAttribute("aria-expanded", collapsed ? "false" : "true");
      collapseButton.title = collapsed
        ? `Expand ${pane === "notes" ? "notes pane" : "entry details"}`
        : `Collapse ${pane === "notes" ? "notes pane" : "entry details"}`;
    }
  }

  function setPdfMaximized(maximized) {
    const value = Boolean(maximized && activeWorkspaceTab !== "bibliography");
    const wasMaximized = root.classList.contains("ctca-pdf-maximized");
    const state = openPdfTabs.get(activeWorkspaceTab);

    if (value && !wasMaximized && state) {
      pdfFullscreenPaneState = {
        state,
        notesCollapsed: Boolean(state.notesCollapsed),
        detailsCollapsed: Boolean(state.detailsCollapsed),
        notesModified: false,
        detailsModified: false
      };
      setPdfPaneCollapsed("notes", true, { trackFullscreenChange: false });
      setPdfPaneCollapsed("details", true, { trackFullscreenChange: false });
    } else if (!value && wasMaximized && pdfFullscreenPaneState) {
      const snapshot = pdfFullscreenPaneState;
      if (!snapshot.notesModified) {
        snapshot.state.notesCollapsed = snapshot.notesCollapsed;
      }
      if (!snapshot.detailsModified) {
        snapshot.state.detailsCollapsed = snapshot.detailsCollapsed;
      }
      if (snapshot.state === state) {
        setPdfPaneCollapsed("notes", snapshot.state.notesCollapsed, { trackFullscreenChange: false });
        setPdfPaneCollapsed("details", snapshot.state.detailsCollapsed, { trackFullscreenChange: false });
      }
      pdfFullscreenPaneState = null;
    }

    root.classList.toggle("ctca-pdf-maximized", value);
    const frame = pdfFrameForTab(activeWorkspaceTab);
    frame?.contentWindow?.postMessage({
      type: "ctca-pdf-host-layout",
      attachmentId: openPdfTabs.get(activeWorkspaceTab)?.attachment?.id || "",
      maximized: value
    }, "*");
  }

  function bindEvents() {
    const addMenuWrap = $(".ctca-manager-add-menu-wrap", root);
    const addMenuButton = $(".ctca-manager-add-entry", root);
    const closeAddMenu = () => {
      addMenuWrap?.classList.remove("ctca-manager-add-menu-open");
      addMenuButton?.setAttribute("aria-expanded", "false");
    };
    const openAddMenu = () => {
      addMenuWrap?.classList.add("ctca-manager-add-menu-open");
      addMenuButton?.setAttribute("aria-expanded", "true");
    };
    addMenuButton.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (addMenuWrap.classList.contains("ctca-manager-add-menu-open")) closeAddMenu();
      else openAddMenu();
    });
    addMenuButton.addEventListener("keydown", (event) => {
      if (event.key === "ArrowDown") {
        event.preventDefault();
        openAddMenu();
        $(".ctca-manager-add-new-entry", root)?.focus();
      }
    });
    $(".ctca-manager-add-new-entry", root).addEventListener("click", (event) => {
      event.stopPropagation();
      closeAddMenu();
      addEntry().catch((error) => setStatus(error.message || String(error), true));
    });
    $(".ctca-manager-add-from-pdf", root).addEventListener("click", (event) => {
      event.stopPropagation();
      closeAddMenu();
      addEntriesFromPdfs().catch((error) => setStatus(error.message || String(error), true));
    });
    $(".ctca-manager-import-bib", root).addEventListener("click", (event) => {
      event.stopPropagation();
      closeAddMenu();
      importBibFileIntoGlobalDatabase().catch((error) => setStatus(error.message || String(error), true));
    });
    $(".ctca-global-empty-add", root).addEventListener("click", addEntry);
    $(".ctca-global-empty-upload", root).addEventListener("click", () => importBibFileIntoGlobalDatabase().catch((error) => setStatus(error.message || String(error), true)));
    $(".ctca-global-empty-nextcloud", root).addEventListener("click", () => syncExistingNextcloudBackup().catch((error) => setStatus(error.message || String(error), true)));
    $(".ctca-manager-add-category", root).addEventListener("click", createCategory);
    $(".ctca-manager-update", root).addEventListener("click", () => {
      exportGlobalBibliography().catch((error) => setStatus(error.message || String(error), true));
    });
    $(".ctca-manager-update-all-doi", root).addEventListener("click", () => {
      updateEntriesFromDoi(entries, { showBatchConfirmation: true });
    });
    $(".ctca-manager-update-selected", root).addEventListener("click", () => {
      updateEntriesFromDoi(
        [...selectedKeys].map(entryByKey).filter(Boolean),
        { showBatchConfirmation: true }
      );
    });
    $(".ctca-manager-remove-selected", root).addEventListener("click", removeSelected);
    $(".ctca-manager-abort-doi", root).addEventListener("click", abortDoiUpdate);
    $(".ctca-manager-cloud-settings", root).addEventListener("click", () => openPdfStorageSettings().catch((error) => setStatus(error.message || String(error), true)));
    $(".ctca-manager-options", root).addEventListener("click", () => openOptionsPage());
    $(".ctca-manager-collapse-details", root).addEventListener("click", () => {
      bibliographyDetailsCollapsed = !bibliographyDetailsCollapsed;
      updateBibliographyDetailsVisibility();
    });
    $(".ctca-manager-restore-details", root).addEventListener("click", () => {
      bibliographyDetailsCollapsed = false;
      updateBibliographyDetailsVisibility();
    });
    window.addEventListener("message", (event) => {
      const frame = $$(".ctca-pdf-frame", root).find((candidate) => event.source === candidate.contentWindow);
      if (!frame) return;
      const tabId = frame.dataset.pdfTabId;
      const message = event.data || {};
      const data = openPdfTabs.get(tabId);
      const attachment = data?.attachment;
      if (!attachment || (message.attachmentId && message.attachmentId !== attachment.id)) return;

      if (message.type === "ctca-pdf-link-request") {
        handlePdfLinkRequest(message.url)
          .catch((error) => showPdfViewAttachmentFailure(error, message.url));
        return;
      }
      if (message.type === "ctca-pdf-viewer-ready") {
        data.viewerReady = true;
        frame.contentWindow.postMessage({
          type: "ctca-pdf-host-layout",
          attachmentId: attachment.id,
          maximized: tabId === activeWorkspaceTab && root.classList.contains("ctca-pdf-maximized")
        }, "*");
        return;
      }
      if (message.type === "ctca-pdf-request-data") {
        sendPdfDataToFrame(frame, attachment).catch(() => {});
        return;
      }
      if (message.type === "ctca-pdf-download-request") {
        downloadPdfAttachment(attachment).catch((error) => setStatus(error?.message || String(error), true));
        return;
      }
      if (message.type === "ctca-pdf-fullscreen-request") {
        if (tabId === activeWorkspaceTab) setPdfMaximized(!root.classList.contains("ctca-pdf-maximized"));
        return;
      }
      if (message.type === "ctca-pdf-dirty-state") {
        data.pdfDirty = Boolean(message.dirty);
        data.pdfSaving = Boolean(message.saving);
        return;
      }
      if (message.type === "ctca-pdf-save-data") {
        persistAnnotatedPdf(frame, message, tabId).catch((error) => setStatus(error?.message || String(error), true));
        return;
      }
      if (message.type === "ctca-pdf-save-request-complete") {
        const pending = pendingPdfSaveRequests.get(message.requestId);
        if (!pending) return;
        pendingPdfSaveRequests.delete(message.requestId);
        if (message.ok) pending.resolve();
        else pending.reject(new Error(message.error || "The PDF annotations could not be saved."));
      }
    });
    $(".ctca-manager-tabs", root).addEventListener("click", (event) => {
      const tab = event.target.closest(".ctca-manager-tab[data-tab-id]");
      if (!tab) return;
      const tabId = tab.dataset.tabId;
      if (event.target.closest(".ctca-manager-tab-close")) closePdfTab(tabId).catch(() => {});
      else activateWorkspaceTab(tabId).catch((error) => setStatus(error.message || String(error), true));
    });
    $(".ctca-pdf-collapse-notes", root).addEventListener("click", () => setPdfPaneCollapsed("notes", true));
    $(".ctca-pdf-restore-notes", root).addEventListener("click", () => setPdfPaneCollapsed("notes", false));
    $(".ctca-pdf-collapse-details", root).addEventListener("click", () => setPdfPaneCollapsed("details", true));
    $(".ctca-pdf-restore-details", root).addEventListener("click", () => setPdfPaneCollapsed("details", false));
    bindPdfNoteEditor();
    initializePdfResizer($(".ctca-pdf-resizer-notes", root), "notes");
    initializePdfResizer($(".ctca-pdf-resizer-details", root), "details");
    root.addEventListener("keydown", (event) => { if (event.key === "Escape" && root.classList.contains("ctca-pdf-maximized")) { event.preventDefault(); setPdfMaximized(false); } });
    $(".ctca-manager-select-visible-checkbox", root).addEventListener("change", (event) => {
      const visibleKeys = filteredEntries().map((entry) => entry.key);
      detailOnlyKey = "";
      if (event.target.checked) visibleKeys.forEach((key) => selectedKeys.add(key));
      else visibleKeys.forEach((key) => selectedKeys.delete(key));
      if (!selectedKeys.has(selectedKey)) selectedKey = [...selectedKeys][0] || "";
      renderList();
      renderDetails();
    });
    $(".ctca-category-remove", root).addEventListener("click", () => {
      const menu = $(".ctca-category-context-menu", root);
      const categoryId = menu.dataset.categoryId || "";
      hideCategoryContextMenu();
      removeCategory(categoryId);
    });
    $(".ctca-category-add-child", root).addEventListener("click", () => {
      const menu = $(".ctca-category-context-menu", root);
      const categoryId = menu.dataset.categoryId || "";
      hideCategoryContextMenu();
      createCategory(categoryId).catch((error) => setStatus(error?.message || String(error), true));
    });
    $(".ctca-category-share", root).addEventListener("click", () => {
      const menu = $(".ctca-category-context-menu", root);
      const categoryId = menu.dataset.categoryId || "";
      hideCategoryContextMenu();
      shareCategory(categoryId).catch((error) => setStatus(error?.message || String(error), true));
    });
    $(".ctca-category-view-share-link", root).addEventListener("click", () => {
      const menu = $(".ctca-category-context-menu", root);
      const categoryId = menu.dataset.categoryId || "";
      hideCategoryContextMenu();
      viewSharedCategoryLink(categoryId).catch((error) => setStatus(error?.message || String(error), true));
    });
    $(".ctca-category-stop-sharing", root).addEventListener("click", () => {
      const menu = $(".ctca-category-context-menu", root);
      const categoryId = menu.dataset.categoryId || "";
      hideCategoryContextMenu();
      stopSharedCategory(categoryId).catch((error) => setStatus(error?.message || String(error), true));
    });

    const searchInput = $(".ctca-manager-search", root);
    const searchClear = $(".ctca-manager-search-clear", root);
    searchInput.addEventListener("input", () => {
      window.clearTimeout(searchRenderTimer);
      searchClear.hidden = !searchInput.value;
      renderSearchTagSuggestions(searchInput);
      searchRenderTimer = window.setTimeout(() => {
        searchRenderTimer = null;
        query = searchInput.value || "";
        renderList();
      }, SEARCH_RENDER_DELAY_MS);
    });
    searchClear.addEventListener("click", () => {
      window.clearTimeout(searchRenderTimer);
      searchRenderTimer = null;
      searchInput.value = "";
      query = "";
      searchClear.hidden = true;
      renderList();
      searchInput.focus();
    });
    searchInput.addEventListener("keydown", (event) => {
      const suggestions = searchInput.closest(".ctca-manager-search-input-wrap")?.querySelector(".ctca-manager-tag-search-suggestions");
      if (handleInlineCompletionDeletion(event, searchInput)) {
        return;
      } else if (event.key === "ArrowRight" && acceptInlineCompletion(searchInput)) {
        event.preventDefault();
      } else if (event.key === "Escape" && discardInlineCompletion(searchInput)) {
        event.preventDefault();
        suggestions?.setAttribute("hidden", "");
      } else if (
        event.key === "ArrowRight" &&
        !suggestions?.hidden &&
        searchInput.selectionStart === searchInput.selectionEnd &&
        searchInput.selectionStart === searchInput.value.length
      ) {
        const first = suggestions.querySelector("[data-search-tag]");
        if (first && acceptSearchTagSuggestion(searchInput, first.dataset.searchTag || "")) event.preventDefault();
      } else if (event.key === "Escape" && suggestions && !suggestions.hidden) {
        event.preventDefault();
        suggestions.hidden = true;
        setInlineCompletionHint(searchInput, "", "", ".ctca-manager-search-input-wrap");
      }
    });
    searchInput.addEventListener("click", () => renderSearchTagSuggestions(searchInput));
    const searchTagSuggestions = $(".ctca-manager-tag-search-suggestions", root);
    searchTagSuggestions.addEventListener("mousedown", (event) => {
      const option = event.target.closest("[data-search-tag]");
      if (!option) return;
      event.preventDefault();
      if (acceptSearchTagSuggestion(searchInput, option.dataset.searchTag || "")) searchInput.focus();
    });
    searchInput.addEventListener("focusout", () => {
      window.setTimeout(() => {
        searchTagSuggestions.hidden = true;
        setInlineCompletionHint(searchInput, "", "", ".ctca-manager-search-input-wrap");
      }, 120);
    });

    const searchDetails = $(".ctca-manager-search-details", root);
    const searchMenu = $(".ctca-manager-search-menu", root);
    const setSearchMenuOpen = (open) => {
      searchMenu.hidden = !open;
      searchDetails.setAttribute("aria-expanded", open ? "true" : "false");
      if (open) applyAdvancedSearchUi();
    };
    searchDetails.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      setSearchMenuOpen(searchMenu.hidden);
    });
    root.querySelectorAll("[data-search-insert]").forEach((button) => {
      button.addEventListener("click", (event) => {
        event.preventDefault();
        insertIntoSearch(button.dataset.searchInsert || "", Number(button.dataset.searchCursorBack || 0));
      });
    });
    const refreshAdvancedSearch = () => {
      searchOptions.includeAbstract = $(".ctca-search-include-abstract", root).checked;
      searchOptions.includePdfText = $(".ctca-search-include-pdf", root).checked;
      searchOptions.includeNotesComments = $(".ctca-search-include-notes-comments", root).checked;
      searchFilters = globalThis.CollabTeXSearchTools.normalizeFilterState({
        type: $(".ctca-search-filter-type", root).value,
        yearFrom: $(".ctca-search-filter-year-from", root).value,
        yearTo: $(".ctca-search-filter-year-to", root).value,
        doi: $(".ctca-search-filter-doi", root).value,
        tagged: $(".ctca-search-filter-tagged", root).value
      });
      updateSearchFilterBadge();
      if (searchOptions.includeNotesComments) refreshNotesCommentsSearchCache().catch((error) => setStatus(error.message || String(error), true));
      else renderList();
      saveUiState().catch(() => {});
    };
    root.querySelectorAll(".ctca-search-include-abstract, .ctca-search-include-pdf, .ctca-search-include-notes-comments, .ctca-search-filter-type, .ctca-search-filter-year-from, .ctca-search-filter-year-to, .ctca-search-filter-doi, .ctca-search-filter-tagged").forEach((control) => {
      const eventName = control.matches("input[type=checkbox], select") ? "change" : "input";
      control.addEventListener(eventName, refreshAdvancedSearch);
    });
    $(".ctca-search-clear-filters", root).addEventListener("click", () => {
      searchFilters = { type: "", yearFrom: "", yearTo: "", doi: "any", tagged: "any" };
      applyAdvancedSearchUi();
      renderList();
      saveUiState().catch(() => {});
    });
    root.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && addMenuWrap?.classList.contains("ctca-manager-add-menu-open")) {
        event.preventDefault();
        closeAddMenu();
        addMenuButton?.focus();
      } else if (event.key === "/" && !event.ctrlKey && !event.metaKey && !event.altKey && !event.target.matches("input, textarea, select")) {
        event.preventDefault();
        searchInput.focus();
        setSearchMenuOpen(true);
      } else if (event.key === "Escape" && !searchMenu.hidden) {
        event.preventDefault();
        setSearchMenuOpen(false);
        searchInput.focus();
      } else if (!searchMenu.hidden && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
        const focusables = [...searchMenu.querySelectorAll("button:not([disabled]), input:not([disabled]), select:not([disabled])")].filter((element) => !element.hidden);
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
        setSearchMenuOpen(false);
      }
      if (!event.target.closest(".ctca-manager-add-menu-wrap")) closeAddMenu();
      if (!event.target.closest(".ctca-category-context-menu")) hideCategoryContextMenu();
      if (!event.target.closest(".ctca-entry-context-menu")) hideEntryContextMenu();
      if (!event.target.closest(".ctca-manager-column-menu")) {
        $(".ctca-manager-column-menu", root).hidden = true;
      }
    });

    root.querySelectorAll("[data-manager-sort]").forEach((button) => {
      button.addEventListener("click", () => {
        const field = button.dataset.managerSort;
        if (sortState.field === field) sortState.direction = sortState.direction === "asc" ? "desc" : "asc";
        else sortState = { field, direction: "asc" };
        renderList();
        saveUiState().catch(() => {});
      });
    });

    const details = $(".ctca-manager-details", root);
    details.addEventListener("input", (event) => {
      if (event.target.matches(".ctca-tag-input")) {
        const entry = entryByKey(selectedKey);
        if (entry) renderTagSuggestions(entry, event.target);
        return;
      }
      if (event.target.matches("[data-manager-autocomplete]")) {
        const entry = entryByKey(selectedKey);
        if (entry && event.target.dataset.managerAutocomplete === "keywords") renderKeywordSuggestions(entry, event.target);
        else if (entry) renderJournalSuggestions(entry, event.target);
        return;
      }
      detailInputChanged(event);
    });
    details.addEventListener("change", detailInputChanged);
    details.addEventListener("keydown", inlineDisplayKeydown);
    details.addEventListener("keydown", tagInputKeydown);
    details.addEventListener("keydown", fieldAutocompleteKeydown);
    details.addEventListener("keydown", detailEditorKeydown);
    details.addEventListener("mousedown", fieldAutocompleteMouseDown);
    details.addEventListener("focusin", (event) => {
      if (event.target.matches(".ctca-tag-input")) {
        const entry = entryByKey(selectedKey);
        if (entry) renderTagSuggestions(entry, event.target);
      } else if (event.target.matches("[data-manager-autocomplete]")) {
        const entry = entryByKey(selectedKey);
        if (entry && event.target.dataset.managerAutocomplete === "keywords") renderKeywordSuggestions(entry, event.target);
        else if (entry) renderJournalSuggestions(entry, event.target);
      }
    });
    details.addEventListener("focusout", (event) => {
      if (event.target.matches(".ctca-tag-input")) {
        window.setTimeout(() => {
          event.target.closest(".ctca-tag-input-wrap")?.querySelector(".ctca-tag-suggestions")?.setAttribute("hidden", "");
          setInlineCompletionHint(event.target, "", "", ".ctca-tag-input-wrap");
        }, 120);
      } else if (event.target.matches("[data-manager-autocomplete]")) {
        window.setTimeout(() => {
          const container = event.target.closest(".ctca-field-completion-wrap")?.querySelector(".ctca-field-completion");
          if (container) container.hidden = true;
          setInlineCompletionHint(event.target, "", "", ".ctca-field-completion-wrap");
          event.target.setAttribute("aria-expanded", "false");
        }, 120);
      }
    });
    details.addEventListener("focusout", detailEditorFocusOut);
    details.addEventListener("click", detailClicked);

    const pdfDetails = $(".ctca-pdf-entry-details", root);
    pdfDetails.addEventListener("input", (event) => {
      if (event.target.matches(".ctca-tag-input")) { const entry = detailEntryFromTarget(event.target); if (entry) renderTagSuggestions(entry, event.target); return; }
      if (event.target.matches("[data-manager-autocomplete]")) {
        const entry = detailEntryFromTarget(event.target);
        if (entry && event.target.dataset.managerAutocomplete === "keywords") renderKeywordSuggestions(entry, event.target);
        else if (entry) renderJournalSuggestions(entry, event.target);
        return;
      }
      detailInputChanged(event);
    });
    pdfDetails.addEventListener("change", detailInputChanged);
    pdfDetails.addEventListener("keydown", inlineDisplayKeydown);
    pdfDetails.addEventListener("keydown", tagInputKeydown);
    pdfDetails.addEventListener("keydown", fieldAutocompleteKeydown);
    pdfDetails.addEventListener("keydown", detailEditorKeydown);
    pdfDetails.addEventListener("mousedown", fieldAutocompleteMouseDown);
    pdfDetails.addEventListener("focusin", (event) => {
      if (event.target.matches("[data-manager-autocomplete]")) {
        const entry = detailEntryFromTarget(event.target);
        if (entry && event.target.dataset.managerAutocomplete === "keywords") renderKeywordSuggestions(entry, event.target);
        else if (entry) renderJournalSuggestions(entry, event.target);
      }
    });
    pdfDetails.addEventListener("focusout", (event) => {
      if (event.target.matches("[data-manager-autocomplete]")) {
        window.setTimeout(() => {
          const container = event.target.closest(".ctca-field-completion-wrap")?.querySelector(".ctca-field-completion");
          if (container) container.hidden = true;
          setInlineCompletionHint(event.target, "", "", ".ctca-field-completion-wrap");
          event.target.setAttribute("aria-expanded", "false");
        }, 120);
      }
    });
    pdfDetails.addEventListener("focusout", detailEditorFocusOut);
    pdfDetails.addEventListener("click", detailClicked);

    const globalSyncToggle = $(".ctca-manager-global-sync-checkbox", root);
    if (globalSyncToggle) {
      updateNextcloudSyncToggle();
      globalSyncToggle.addEventListener("change", async () => {
        if (!nextcloudConnected) {
          globalSyncToggle.checked = false;
          updateNextcloudSyncToggle();
          setStatus("Connect to Nextcloud before enabling synchronization.", true);
          return;
        }
        globalSyncToggle.disabled = true;
        try {
          const config = await globalThis.CollabTeXAttachmentStore.getConfig();
          config.nextcloud = {
            ...(config.nextcloud || {}),
            syncBibliography: Boolean(globalSyncToggle.checked)
          };
          await globalThis.CollabTeXAttachmentStore.saveConfig(config);
          syncNextcloudBibliography = Boolean(globalSyncToggle.checked);
          if (syncNextcloudBibliography) {
            setStatus("Nextcloud bibliography synchronization enabled.");
            scheduleNextcloudSync(50);
          } else {
            setStatus("Nextcloud bibliography synchronization disabled.");
          }
        } catch (error) {
          globalSyncToggle.checked = syncNextcloudBibliography;
          setStatus(error?.message || String(error), true);
        } finally {
          updateNextcloudSyncToggle();
        }
      });
    }

    extensionApi.storage.onChanged?.addListener(async (changes, areaName) => {
      if (areaName !== "local") return;
      if (AUTHOR_OPTIONS_KEY in changes) {
        authorshipUserName = String(changes[AUTHOR_OPTIONS_KEY]?.newValue?.userName || "").trim();
        renderCategories();
        renderList();
        renderDetails();
      }
      if (globalThis.CollabTeXAttachmentStore.CONFIG_KEY in changes) {
        const config = changes[globalThis.CollabTeXAttachmentStore.CONFIG_KEY]?.newValue || {};
        await refreshNextcloudSyncState(config);
      }
      if (globalThis.CollabTeXAttachmentStore.INDEX_KEY in changes && document.visibilityState === "visible") {
        const entry = entryByKey(selectedKey);
        if (entry) await renderAttachmentList(entry);
      }
      if (DB_KEY in changes && document.visibilityState === "visible" && !dirty && !nextcloudSyncInProgress) {
        await loadDatabase();
        selectedKey = entries.some((entry) => entry.key === selectedKey) ? selectedKey : entries[0]?.key || "";
        selectedKeys = new Set([...selectedKeys].filter((key) => entries.some((entry) => entry.key === key)));
        renderAll();
      }
    });

    window.addEventListener("pagehide", () => {
      flushAutoSave().catch(() => {});
      if (activeWorkspaceTab !== "bibliography") savePdfNotes().catch(() => {});
    });
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "hidden") {
        flushAutoSave().catch(() => {});
        if (activeWorkspaceTab !== "bibliography") savePdfNotes().catch(() => {});
      }
    });
  }

  async function initialize() {
    await globalThis.SmartCitationsPrivacy.ensureAccepted();
    const manualOrcidCheck = new URLSearchParams(location.search).get("orcidCheck") === "1";
    setListLoading(true);
    setBusy(true, "Loading…");
    try {
      const manuscriptWorkflow = manuscriptWorkflowParameters();
      if (manuscriptWorkflow) {
        history.replaceState(null, "", `${location.pathname}${location.hash || ""}`);
      }
      await loadDatabase();
      selectedKey = "";
      selectedKeys.clear();
      bindEvents();
      $(".ctca-category-remove", root).textContent = "Delete";
      await ensureAuthorshipUserName();
      initializeTableColumns();
      initializeResizers();
      window.addEventListener("focus", () => scheduleNextcloudSync(100));
      window.setInterval(() => scheduleNextcloudSync(50), 5 * 60 * 1000);
      renderAll();
      renderWorkspaceTabs();
      connectStandaloneManager();
      const hashKey = decodeURIComponent(location.hash.replace(/^#entry=/, ""));
      if (hashKey && entries.some((entry) => entry.key === hashKey)) {
        selectedKey = hashKey;
        selectedKeys = new Set([hashKey]);
        renderAll();
      }
      if (manuscriptWorkflow) {
        await runManuscriptPdfWorkflow(manuscriptWorkflow);
      } else {
        setStatus(entries.length ? "Global bibliography loaded." : "No global bibliography entries yet.");
      }
      globalThis.CollabTeXAttachmentStore.getConfig().then((config) => {
        if (!config.nextcloud?.appPassword) return;
        return synchronizeNextcloud().then(() => {
          const entry = entryByKey(selectedKey);
          if (entry) renderAttachmentList(entry).catch(() => {});
        });
      }).catch((error) => setStatus(`Bibliography loaded, but Nextcloud synchronization failed: ${error.message || String(error)}`, true));
    } catch (error) {
      setStatus(error.message || String(error), true);
    } finally {
      setListLoading(false);
      setBusy(false);
    }
    window.setTimeout(() => {
      offerOrcidWorks(null, {
        force: manualOrcidCheck,
        announceEmpty: manualOrcidCheck
      }).catch((error) => setStatus(error?.message || String(error), true));
    }, 0);
  }

  initialize();
})();
