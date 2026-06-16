(() => {
  "use strict";

  const extensionApi = globalThis.browser ?? globalThis.chrome;
  const PREFIX = "collabtex-citation-assistant:";
  const DB_KEY = `${PREFIX}global-bibliography:v1`;
  const PENDING_KEY = `${PREFIX}global-bibliography-pending:v1`;
  const UI_KEY = `${PREFIX}global-manager-ui:v2`;
  const CTCA_TAGS_FIELD = "ctca_tags";

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
    "address", "annote", "annotation", "archiveprefix", "booktitle", "chapter",
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
  let selectedKey = "";
  let selectedKeys = new Set();
  let selectionAnchorKey = "";
  let query = "";
  let sortState = { field: "year", direction: "desc" };
  let searchFields = {
    key: true,
    authors: true,
    journal: true,
    year: true,
    abstract: true,
    others: true
  };
  let searchOptions = { includeAbstract: true, includePdfText: false };
  let searchFilters = { type: "", yearFrom: "", yearTo: "", doi: "any", tagged: "any" };
  let categoryWidth = 190;
  let detailsWidth = 430;
  let dirty = false;
  let changeRevision = 0;
  let savedRevision = 0;
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
  let activeWorkspaceTab = "bibliography";
  const openPdfTabs = new Map();
  let currentPdfObjectUrl = "";
  let pdfNoteSaveTimer = null;
  let pdfNotesWidth = 360;
  let pdfDetailsWidth = 390;
  const pendingPdfSaveRequests = new Map();
  let bibliographyDetailsCollapsed = false;
  let nextcloudSyncTimer = null;
  let nextcloudSyncInProgress = false;

  function escapeHtml(value) {
    return String(value ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
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

  function normalizeEntry(entry) {
    const fields = Object.fromEntries(
      Object.entries(entry?.fields || {}).map(([name, value]) => [name, stripBibValue(value)])
    );
    const tags = globalThis.CollabTeXSearchTools.splitTags(entry?.tags || fields[CTCA_TAGS_FIELD] || "");
    delete fields[CTCA_TAGS_FIELD];
    return {
      key: String(entry?.key || "Reference"),
      type: String(entry?.type || "misc"),
      fields,
      aliases: [...new Set(Array.isArray(entry?.aliases) ? entry.aliases.filter(Boolean) : [])],
      tags,
      updatedAt: entry?.updatedAt || "",
      doiSyncedAt: entry?.doiSyncedAt || ""
    };
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

  function markKnownDocumentsPending(changeCount = 1) {
    const sync = normalizeDocumentSyncState(documentSyncState);
    const now = new Date().toISOString();
    const increment = Math.max(1, Number(changeCount) || 1);
    sync.revision += 1;
    for (const flag of Object.values(sync.documents)) {
      flag.pending = true;
      flag.pendingCount = Math.max(0, Number(flag.pendingCount) || 0) + increment;
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
            order: Number.isFinite(Number(category.order)) ? Number(category.order) : index
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
    node.classList.toggle("ctca-manager-error", Boolean(error));
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
      ".ctca-manager-select-visible-checkbox, .ctca-manager-global-sync-checkbox, [data-manager-sort]"
    );
    controls.forEach((control) => { control.disabled = value; });
    updateNextcloudSyncToggle();
    const exportButton = $(".ctca-manager-update", root);
    if (exportButton) exportButton.disabled = value || entries.length === 0;
    updateSelectionControls(filteredEntries().map((entry) => entry.key));
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
    selectedCategoryId = ui.selectedCategoryId && (
      ui.selectedCategoryId === "all" || ui.selectedCategoryId === "uncategorized" ||
      categoryState.categories.some((category) => category.id === ui.selectedCategoryId)
    ) ? ui.selectedCategoryId : "all";
    if (ui.searchFields && typeof ui.searchFields === "object") {
      searchFields = { ...searchFields, ...ui.searchFields };
      if (!Object.values(searchFields).some(Boolean)) searchFields.key = true;
    }
    if (ui.searchOptions && typeof ui.searchOptions === "object") {
      searchOptions = { ...searchOptions, ...ui.searchOptions };
    }
    searchFilters = globalThis.CollabTeXSearchTools.normalizeFilterState(ui.searchFilters || searchFilters);
    applyColumnWidths();
    applySearchFieldSettings();
    applyAdvancedSearchUi();
  }

  async function saveUiState() {
    await extensionApi.storage.local.set({
      [UI_KEY]: {
        categoryWidth,
        detailsWidth,
        selectedCategoryId,
        searchFields,
        searchOptions,
        searchFilters
      }
    });
  }

  function databaseSnapshot({ markChanged = false, changeCount = 1 } = {}) {
    const presentIdentities = new Set(entries.map(deletionIdentity));
    deletionTombstones = normalizeDeletionTombstones(
      deletionTombstones.filter((item) => !presentIdentities.has(item.identity))
    );
    if (markChanged) markKnownDocumentsPending(changeCount);
    return {
      version: 3,
      entries: entries.map((entry) => ({
        key: entry.key,
        type: entry.type,
        fields: { ...(entry.fields || {}) },
        aliases: [...new Set(entry.aliases || [])],
        tags: globalThis.CollabTeXSearchTools.splitTags(entry.tags || []),
        updatedAt: entry.updatedAt || "",
        doiSyncedAt: entry.doiSyncedAt || ""
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
    const snapshot = databaseSnapshot({
      markChanged: dirty || revision > savedRevision,
      changeCount: Math.max(1, revision - savedRevision)
    });
    saveQueue = saveQueue.catch(() => {}).then(async () => {
      await extensionApi.storage.local.set({ [DB_KEY]: snapshot });
      await extensionApi.storage.local.remove(PENDING_KEY);
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
    return String(entry?.fields?.author || entry?.fields?.editor || "Authors not specified")
      .replace(/\s+and\s+/gi, "; ");
  }

  function firstAuthor(entry) {
    const value = String(entry?.fields?.author || entry?.fields?.editor || "");
    const first = value.split(/\s+and\s+/i)[0]?.trim() || "";
    if (first.includes(",")) return first.split(",")[0].trim();
    return first.split(/\s+/).pop() || "";
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
    if (selectedCategoryId === "uncategorized") return ids.length === 0;
    const accepted = categoryDescendants(selectedCategoryId);
    return ids.some((id) => accepted.has(id));
  }

  function categoryCount(categoryId) {
    if (categoryId === "all") return entries.length;
    if (categoryId === "uncategorized") {
      return entries.filter((entry) => entryCategoryIds(entry.key).length === 0).length;
    }
    const accepted = categoryDescendants(categoryId);
    return entries.filter((entry) => entryCategoryIds(entry.key).some((id) => accepted.has(id))).length;
  }

  function entrySearchModel(entry) {
    return {
      ...entry,
      tags: globalThis.CollabTeXSearchTools.splitTags(entry.tags || []),
      categoryPaths: entryCategoryIds(entry.key).map(categoryPath).filter(Boolean)
    };
  }

  function filteredEntries() {
    const ranked = entries.map((entry) => ({
      entry,
      ...globalThis.CollabTeXSearchTools.matchEntry(entrySearchModel(entry), query, {
        includeAbstract: searchOptions.includeAbstract,
        includePdfText: searchOptions.includePdfText,
        filters: searchFilters
      })
    })).filter((item) => item.matched && entryMatchesCategory(item.entry));
    const direction = sortState.direction === "asc" ? 1 : -1;
    const value = (entry) => {
      if (sortState.field === "year") return Number(String(entry.fields?.year || "").match(/\d{4}/)?.[0] || -Infinity);
      if (sortState.field === "author") return firstAuthor(entry).toLowerCase();
      return entry.key.toLowerCase();
    };
    return ranked.sort((left, right) => {
      if (query.trim() && left.rank !== right.rank) return left.rank - right.rank;
      const leftValue = value(left.entry);
      const rightValue = value(right.entry);
      if (typeof leftValue === "number" && typeof rightValue === "number") {
        return (leftValue - rightValue) * direction;
      }
      return String(leftValue).localeCompare(String(rightValue), undefined, { numeric: true, sensitivity: "base" }) * direction;
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
        selectedCategoryId = id;
        renderCategories();
        renderList();
        saveUiState().catch(() => {});
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
            renderDetails();
          } catch (_error) {}
        });
      }
      container.appendChild(button);
    };

    createFixed("all", "All");

    const renderBranch = (parentId, depth) => {
      for (const category of categoryChildren(parentId)) {
        const row = document.createElement("div");
        row.className = "ctca-manager-category-row";
        row.classList.toggle("ctca-manager-category-selected", selectedCategoryId === category.id);
        row.dataset.categoryId = category.id;
        row.draggable = true;
        row.style.setProperty("--ctca-category-depth", String(depth));
        row.innerHTML = `
          <span class="ctca-manager-category-handle" title="Drag to reorder or nest" aria-hidden="true">⋮⋮</span>
          <button type="button" class="ctca-manager-category-name" title="${escapeHtml(categoryPath(category.id))}">${escapeHtml(category.name)}</button>
          <span class="ctca-manager-category-count">${categoryCount(category.id)}</span>
        `;
        $(".ctca-manager-category-name", row).addEventListener("click", () => {
          selectedCategoryId = category.id;
          renderCategories();
          renderList();
          saveUiState().catch(() => {});
        });
        row.addEventListener("contextmenu", (event) => {
          event.preventDefault();
          const menu = $(".ctca-category-context-menu", root);
          menu.dataset.categoryId = category.id;
          menu.style.left = `${Math.min(event.clientX, window.innerWidth - 220)}px`;
          menu.style.top = `${Math.min(event.clientY, window.innerHeight - 90)}px`;
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
    for (const key of keys) {
      const memberships = new Set(entryCategoryIds(key));
      memberships.add(categoryId);
      setEntryCategoryIds(key, [...memberships]);
    }
    markDirty("Saving category assignments automatically…");
    renderCategories();
    renderList();
    renderDetails();
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

  function renderList() {
    const list = $(".ctca-manager-list", root);
    const visible = filteredEntries();
    const visibleKeys = visible.map((entry) => entry.key);
    if (visible.length && !visible.some((entry) => entry.key === selectedKey)) {
      selectedKey = visible[0].key;
    } else if (!visible.length) {
      selectedKey = "";
    }
    list.replaceChildren();

    root.querySelectorAll("[data-manager-sort]").forEach((button) => {
      const active = button.dataset.managerSort === sortState.field;
      button.classList.toggle("ctca-manager-sort-active", active);
      $("span", button).textContent = active ? (sortState.direction === "asc" ? "↑" : "↓") : "↕";
    });

    $(".ctca-global-empty", root).hidden = entries.length !== 0;

    if (!visible.length && entries.length) {
      const empty = document.createElement("div");
      empty.className = "ctca-manager-empty-list";
      empty.textContent = "No entries match this search or category.";
      list.appendChild(empty);
    }

    for (const entry of visible) {
      const row = document.createElement("div");
      row.className = "ctca-manager-row";
      row.dataset.managerRecordId = entry.key;
      row.setAttribute("role", "option");
      row.setAttribute("tabindex", "0");
      row.setAttribute("aria-selected", selectedKeys.has(entry.key) ? "true" : "false");
      row.draggable = true;
      row.classList.toggle("ctca-manager-row-active", selectedKey === entry.key);
      row.classList.toggle("ctca-manager-row-selected", selectedKeys.has(entry.key));
      const title = entry.fields?.title || "Untitled reference";
      const authors = allAuthors(entry);
      const year = entry.fields?.year || "";
      const journal = publication(entry);
      const volume = entry.fields?.volume || "";
      const pages = entry.fields?.pages || "";
      const publicationText = [journal, volume, pages].filter(Boolean).join(", ");
      row.innerHTML = `
        <span class="ctca-manager-row-firstline">
          <input type="checkbox" class="ctca-manager-row-checkbox" aria-label="Select ${escapeHtml(entry.key)}" ${selectedKeys.has(entry.key) ? "checked" : ""}>
          <span class="ctca-manager-row-title" title="${escapeHtml(title)}">${escapeHtml(title)}</span>
          ${year ? `<span class="ctca-manager-row-year" title="${escapeHtml(year)}">${escapeHtml(year)}</span>` : "<span></span>"}
          <span class="ctca-manager-row-meta">
            ${entry.doiSyncedAt ? `<span class="ctca-manager-row-doi-sync" title="DOI synchronized ${escapeHtml(entry.doiSyncedAt)}">🌐</span>` : ""}
            <span class="ctca-manager-row-key" title="${escapeHtml(entry.key)}">${escapeHtml(entry.key)}</span>
          </span>
        </span>
        <span class="ctca-manager-row-author" title="${escapeHtml(authors)}">${escapeHtml(authors)}</span>
        <span class="ctca-manager-row-publication" title="${escapeHtml(publicationText)}">${escapeHtml(publicationText)}</span>
      `;

      const activate = (event) => {
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
        renderList();
        renderDetails();
      };

      row.addEventListener("click", (event) => {
        if (event.target.closest(".ctca-manager-row-checkbox")) return;
        activate(event);
      });
      row.addEventListener("keydown", (event) => {
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        activate(event);
      });
      $(".ctca-manager-row-checkbox", row).addEventListener("click", (event) => {
        event.stopPropagation();
        if (event.target.checked) selectedKeys.add(entry.key);
        else selectedKeys.delete(entry.key);
        selectedKey = entry.key;
        selectionAnchorKey = entry.key;
        renderList();
        renderDetails();
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
      list.appendChild(row);
    }

    selectedKeys = new Set([...selectedKeys].filter((key) => entries.some((entry) => entry.key === key)));
    updateSelectionControls(visibleKeys);
    updateCount(visible.length);
    renderDetails();
  }

  function managerInput(label, field, value, options = {}) {
    const wide = options.wide ? " ctca-manager-field-wide" : "";
    if (options.multiline) {
      return `<label class="ctca-manager-field${wide}"><span>${escapeHtml(label)}</span><textarea data-manager-field="${escapeHtml(field)}" rows="${options.rows || 3}">${escapeHtml(value || "")}</textarea></label>`;
    }
    return `<label class="ctca-manager-field${wide}"><span>${escapeHtml(label)}</span><input data-manager-field="${escapeHtml(field)}" value="${escapeHtml(value || "")}"></label>`;
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
      .slice(0, 10);
    container.innerHTML = suggestions.map((tag) => `<button type="button" data-manager-action="add-tag" data-tag="${escapeHtml(tag)}" role="option">${escapeHtml(tag)}</button>`).join("");
    container.hidden = suggestions.length === 0;
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

  function tagInputKeydown(event) {
    const input = event.target.closest(".ctca-tag-input");
    if (!input) return;
    const entry = entryByKey(selectedKey);
    if (!entry) return;
    if (event.key === "Enter" || event.key === ",") {
      event.preventDefault();
      if (addTagToEntry(entry, input.value)) {
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
        renderDetails();
        requestAnimationFrame(() => $(".ctca-tag-input", root)?.focus());
      }
    } else if (event.key === "Escape") {
      input.closest(".ctca-tag-input-wrap")?.querySelector(".ctca-tag-suggestions")?.setAttribute("hidden", "");
    }
  }

  function renderDetails() {
    const container = $(".ctca-manager-details", root);
    const entry = entryByKey(selectedKey);
    if (!entry) {
      container.innerHTML = `<div class="ctca-manager-empty-details">Select a bibliography entry.</div>`;
      return;
    }

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
        <div class="ctca-manager-detail-heading-text">
          <div class="ctca-manager-detail-title" title="${escapeHtml(title)}">${escapeHtml(title)}</div>
          <div class="ctca-manager-detail-authors" title="${escapeHtml(authors)}">${escapeHtml(authors)}</div>
          ${entry.doiSyncedAt ? `<div class="ctca-manager-detail-doi-sync">🌐✓ DOI synchronized ${escapeHtml(entry.doiSyncedAt)}</div>` : ""}
        </div>
        <div class="ctca-manager-detail-actions" data-detail-entry-key="${escapeHtml(entry.key)}"></div>
      </div>
      <div class="ctca-manager-form-grid">
        <label class="ctca-manager-field"><span>Entry type</span>
          <select data-manager-property="type">${ENTRY_TYPES.map((type) => `<option value="${type}" ${entry.type === type ? "selected" : ""}>${type}</option>`).join("")}</select>
        </label>
        <label class="ctca-manager-field"><span>Citation key</span><input data-manager-property="key" value="${escapeHtml(entry.key)}"></label>
        ${managerInput("Title", "title", fields.title, { multiline: true, rows: 2, wide: true })}
        ${managerInput("Authors", "author", fields.author, { multiline: true, rows: 3, wide: true })}
        ${managerInput("Editors", "editor", fields.editor, { multiline: true, rows: 2, wide: true })}
        ${managerInput(journalLabel, journalField, fields[journalField], { wide: true })}
        ${managerInput("Year", "year", fields.year)}
        ${managerInput("Volume", "volume", fields.volume)}
        ${managerInput("Pages / article number", "pages", fields.pages)}
        <label class="ctca-manager-field ctca-manager-field-wide"><span>DOI</span>
          <div class="ctca-manager-doi-row">
            <input data-manager-field="doi" value="${escapeHtml(fields.doi || "")}">
            <button type="button" data-manager-action="update-doi" title="Update this entry from DOI metadata">🌐</button>
          </div>
        </label>
        ${managerInput("URL", "url", fields.url, { wide: true })}
        ${managerInput("Abstract", "abstract", fields.abstract, { multiline: true, rows: 8, wide: true })}
        ${managerInput("Keywords", "keywords", fields.keywords, { multiline: true, rows: 3, wide: true })}
        ${managerInput("Publisher", "publisher", fields.publisher, { wide: true })}
        ${managerInput("Institution", "institution", fields.institution, { wide: true })}
        ${managerInput("BibTeX note", "note", fields.note, { multiline: true, rows: 3, wide: true })}
        ${managerInput("Custom note", "annotation", fields.annotation, { multiline: true, rows: 4, wide: true })}
      </div>
      ${tagEditorHtml(entry)}
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
        <div class="ctca-manager-pdf-attachments-head"><h3>PDF attachments</h3><button type="button" class="ctca-manager-add-pdf" data-manager-action="add-pdf">+ Attach PDF</button></div>
        <div class="ctca-manager-pdf-list"><div class="ctca-manager-no-pdf">Loading attachments…</div></div>
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
    renderAttachmentList(entry).catch((error) => setStatus(error.message || String(error), true));
    syncPdfEntryDetails();
  }

  function attachmentProviderLabel(attachment) {
    if (attachment?.provider === "nextcloud") return "Nextcloud";
    if (attachment?.provider === "local") return attachment.sessionOnly ? "Local disk link · temporary" : "Local disk link";
    return "Browser storage";
  }

  async function renderAttachmentList(entry) {
    const attachments = await globalThis.CollabTeXAttachmentStore.list(entry);
    if (selectedKey !== entry.key) return;

    const detailActionsHtml = attachments.length
      ? `<button type="button" data-manager-action="open-pdf" data-attachment-id="${escapeHtml(attachments[0].id)}">Open PDF ↗</button>`
      : "";
    root.querySelectorAll(`.ctca-manager-detail-actions[data-detail-entry-key="${CSS.escape(entry.key)}"]`).forEach((detailActions) => {
      detailActions.innerHTML = detailActionsHtml;
    });

    const listHtml = attachments.length
      ? attachments.map((attachment) => `
        <div class="ctca-manager-pdf-row" data-attachment-id="${escapeHtml(attachment.id)}">
          <div class="ctca-manager-pdf-name" title="${escapeHtml(attachment.name)}">${escapeHtml(attachment.name)}</div>
          <div class="ctca-manager-pdf-meta">${escapeHtml(attachmentProviderLabel(attachment))}${attachment.fileName ? ` · ${escapeHtml(attachment.fileName)}` : ""}${attachment.size ? ` · ${(attachment.size / 1024 / 1024).toFixed(1)} MB` : ""}</div>
          <div class="ctca-manager-pdf-actions">
            <button type="button" data-manager-action="open-pdf" data-attachment-id="${escapeHtml(attachment.id)}">Open</button>
            <button type="button" data-manager-action="rename-pdf" data-attachment-id="${escapeHtml(attachment.id)}">Rename</button>
            ${attachment.provider !== "local" ? `<button type="button" data-manager-action="replace-pdf" data-attachment-id="${escapeHtml(attachment.id)}">Replace</button>` : ""}
            <button type="button" data-manager-action="remove-pdf" data-attachment-id="${escapeHtml(attachment.id)}">Remove</button>
          </div>
        </div>`).join("")
      : `<div class="ctca-manager-no-pdf">No PDF attachments. Multiple named PDFs can be attached to each entry.</div>`;

    root.querySelectorAll(`.ctca-manager-pdf-attachments[data-entry-key="${CSS.escape(entry.key)}"] .ctca-manager-pdf-list`).forEach((list) => {
      list.innerHTML = listHtml;
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
      if (showSuccess) setStatus("Nextcloud synchronization completed.");
      return result;
    } catch (error) {
      setStatus(`Nextcloud synchronization failed: ${error.message || String(error)}`, true);
      return null;
    } finally {
      nextcloudSyncInProgress = false;
    }
  }

  function scheduleNextcloudSync(delay = 900) {
    window.clearTimeout(nextcloudSyncTimer);
    nextcloudSyncTimer = window.setTimeout(() => {
      nextcloudSyncTimer = null;
      synchronizeNextcloud().catch(() => {});
    }, delay);
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

  async function openAddPdfDialog(entry) {
    const config = await globalThis.CollabTeXAttachmentStore.getConfig();
    let selectedProvider = config.provider || "browser";
    let fileInput = null;
    let fileRows = null;
    let localPanel = null;
    let localPathInput = null;
    let localNameRows = null;
    let localPermissionButton = null;
    let localPermissionStatus = null;
    let selectedFiles = [];
    let localNames = [];

    const result = await showDialog({
      title: `Attach PDF to ${entry.key}`,
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
          <div class="ctca-pdf-browse-row">
            <button type="button" class="ctca-pdf-browse">Browse PDF file(s)…</button>
            <span class="ctca-pdf-browse-summary">No PDF selected</span>
            <input type="file" accept=".pdf,application/pdf,application/x-pdf" multiple hidden>
          </div>
          <div class="ctca-pdf-file-name-list"></div>
          <div class="ctca-local-path-panel" hidden>
            <label class="ctca-app-dialog-field ctca-local-path-field">
              <span>Local PDF path(s)</span>
              <textarea class="ctca-local-path-input" rows="4" wrap="soft" spellcheck="false" placeholder="C:\\Users\\Name\\Documents\\paper.pdf&#10;/home/name/Documents/paper.pdf"></textarea>
            </label>
            <p class="ctca-local-path-instruction"><strong>How to get the path:</strong> On Windows, browse to the PDF in File Explorer, right-click it, choose <em>Properties</em>, copy the file location, paste it here, and append the PDF filename. You can also use <em>Shift + right-click → Copy as path</em>. Paste one complete PDF path per line. Backslashes are accepted; do not add <code>file://</code>.</p>
            <p class="ctca-local-link-warning">Only the path is stored; the PDF is not copied. In Chrome or Edge, enable <strong>Allow access to file URLs</strong> on the extension’s Details page. In Firefox 153 and newer, enable <strong>Access local files on your computer</strong>. In older Firefox versions there is no separate local-files row; the relevant permission is <strong>Access your data for all websites</strong>.</p>
            <div class="ctca-local-permission-row"><button type="button" class="ctca-local-permission-button">Check / grant local-file access</button><span class="ctca-local-permission-status" aria-live="polite"></span></div>
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
          localPermissionStatus.textContent = "Requesting permission…";
          try {
            const granted = await globalThis.CollabTeXAttachmentStore.ensureLocalFilePermission();
            localPermissionStatus.textContent = granted
              ? "Local-file access is granted."
              : "Permission was not granted. In older Firefox versions, enable ‘Access your data for all websites’.";
            localPermissionStatus.classList.toggle("ctca-local-permission-granted", granted);
          } catch (error) {
            localPermissionStatus.textContent = error?.message || String(error);
          } finally {
            localPermissionButton.disabled = false;
          }
        });
        refreshLocalPermissionStatus();

        const renderSelectedFiles = () => {
          summary.textContent = selectedFiles.length ? `${selectedFiles.length} PDF${selectedFiles.length === 1 ? "" : "s"} selected` : "No PDF selected";
          fileRows.replaceChildren();
          selectedFiles.forEach((file, index) => {
            const label = document.createElement("label");
            label.className = "ctca-app-dialog-field";
            label.innerHTML = `<span>Name for ${escapeHtml(file.name)}</span><input type="text" data-pdf-name-index="${index}" value="${escapeHtml(file.name.replace(/\.pdf$/i, ""))}">`;
            fileRows.appendChild(label);
          });
        };
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
          browseRow.hidden = local;
          fileRows.hidden = local;
          localPanel.hidden = !local;
          if (resetFiles) {
            selectedFiles = [];
            fileInput.value = "";
            renderSelectedFiles();
          }
          if (local) window.setTimeout(() => localPathInput.focus(), 0);
        };
        providerButtons.forEach((button) => button.addEventListener('click', () => updateProvider(button.dataset.provider)));
        wrapper.querySelector('.ctca-pdf-browse').addEventListener('click', () => fileInput.click());
        fileInput.addEventListener('change', () => {
          selectedFiles = [...fileInput.files];
          renderSelectedFiles();
        });
        localPathInput.addEventListener('input', renderLocalPaths);
        updateProvider(selectedProvider, false);
      },
      buttons: [
        { label: "Cancel", value: null },
        { label: "Attach", primary: true, getValue: () => ({
          provider: selectedProvider,
          files: selectedFiles,
          paths: String(localPathInput?.value || "").split(/\r?\n/).map((value) => value.trim()).filter(Boolean),
          names: selectedProvider === "local"
            ? [...localNameRows.querySelectorAll('[data-local-name-index]')].map((input) => input.value.trim())
            : [...fileRows.querySelectorAll('[data-pdf-name-index]')].map((input) => input.value.trim())
        }) }
      ],
      closeValue: null
    });
    if (!result) return;
    setBusy(true, "Attaching…");
    try {
      if (result.provider === "local") {
        if (!result.paths.length) throw new Error("Enter at least one complete local PDF path.");
        let permitted = true;
        try { permitted = await globalThis.CollabTeXAttachmentStore.ensureLocalFilePermission(); } catch (_error) { permitted = false; }
        for (let index = 0; index < result.paths.length; index += 1) {
          await globalThis.CollabTeXAttachmentStore.addLocalLink(entry, result.paths[index], result.names[index]);
        }
        setStatus(permitted
          ? "Local PDF link saved. The PDF remains at its current disk location."
          : "Local PDF link saved. Enable local-file access for this extension before opening the PDF.");
      } else {
        if (!result.files.length) throw new Error("Choose at least one PDF file.");
        if (result.provider === "nextcloud") {
          const cfg = await globalThis.CollabTeXAttachmentStore.getConfig();
          if (!cfg.nextcloud?.appPassword) throw new Error("Connect Nextcloud in PDF storage settings first.");
        }
        const failures = [];
        let attached = 0;
        for (let index = 0; index < result.files.length; index += 1) {
          const file = result.files[index];
          const name = result.names[index] || file.name.replace(/\.pdf$/i, "");
          try {
            if (result.provider === "nextcloud") await globalThis.CollabTeXAttachmentStore.addNextcloud(entry, file, name);
            else await globalThis.CollabTeXAttachmentStore.addBrowser(entry, file, name);
            attached += 1;
          } catch (error) {
            failures.push(`${file.name}: ${error.message || String(error)}`);
          }
        }
        if (!attached) throw new Error(failures.join("; ") || "No PDF could be attached.");
        setStatus(failures.length
          ? `${attached} PDF${attached === 1 ? "" : "s"} attached; ${failures.length} failed: ${failures.join("; ")}`
          : `${attached} PDF${attached === 1 ? "" : "s"} attached${result.provider === "nextcloud" ? " and uploaded to Nextcloud" : ""}.`,
          failures.length > 0);
      }
      await renderAttachmentList(entry);
    } catch (error) {
      setStatus(error.message || String(error), true);
    } finally {
      setBusy(false);
    }
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
      button.innerHTML = `<span>${escapeHtml(data.attachment.name)}</span><span class="ctca-manager-tab-close" title="Close PDF tab" aria-label="Close PDF tab">×</span>`;
      tabs.insertBefore(button, spacer);
    }
    tabs.querySelectorAll(".ctca-manager-tab").forEach((tab) => {
      const active = tab.dataset.tabId === activeWorkspaceTab;
      tab.classList.toggle("ctca-manager-tab-active", active); tab.setAttribute("aria-selected", active ? "true" : "false");
    });
  }

  async function openPdfTab(entry, attachment) {
    const tabId = `pdf:${attachment.id}`;
    const previous = openPdfTabs.get(tabId);
    openPdfTabs.set(tabId, {
      entryKey: entry.key,
      attachment,
      notesCollapsed: previous?.notesCollapsed || false,
      detailsCollapsed: previous?.detailsCollapsed || false
    });
    activeWorkspaceTab = tabId;
    renderWorkspaceTabs();
    await activateWorkspaceTab(tabId);
  }

  async function activateWorkspaceTab(tabId) {
    if (activeWorkspaceTab !== "bibliography" && activeWorkspaceTab !== tabId) {
      await requestPdfFrameSave(activeWorkspaceTab);
      window.clearTimeout(pdfNoteSaveTimer);
      await savePdfNotes().catch(() => {});
    }
    activeWorkspaceTab = tabId;
    renderWorkspaceTabs();
    const bibliography = $(".ctca-manager-bibliography-view", root);
    const pdfView = $(".ctca-manager-pdf-view", root);
    bibliography.hidden = tabId !== "bibliography";
    pdfView.hidden = tabId === "bibliography";
    if (tabId === "bibliography") { setPdfMaximized(false); return; }
    const data = openPdfTabs.get(tabId);
    if (!data) return activateWorkspaceTab("bibliography");
    const entry = entryByKey(data.entryKey);
    if (entry) selectedKey = entry.key;
    await loadPdfView(data.attachment, entry);
  }

  async function closePdfTab(tabId) {
    if (activeWorkspaceTab === tabId) {
      await requestPdfFrameSave(tabId);
      window.clearTimeout(pdfNoteSaveTimer);
      await savePdfNotes().catch(() => {});
      activeWorkspaceTab = "bibliography";
    }
    openPdfTabs.delete(tabId);
    renderWorkspaceTabs();
    await activateWorkspaceTab(activeWorkspaceTab);
  }

  function syncPdfEntryDetails() {
    if (activeWorkspaceTab === "bibliography") return;
    const source = $(".ctca-manager-details", root);
    const target = $(".ctca-pdf-entry-details", root);
    if (source && target) target.innerHTML = source.innerHTML;
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
    const frame = $(".ctca-pdf-frame", root);
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

  async function persistAnnotatedPdf(frame, message) {
    const data = openPdfTabs.get(activeWorkspaceTab);
    if (!data || message.attachmentId !== data.attachment.id) return;
    const originalProvider = data.attachment.provider;
    try {
      const fileName = data.attachment.fileName || `${data.attachment.name || "annotated"}.pdf`;
      const file = new File([message.bytes], fileName, { type: "application/pdf" });
      const updated = await globalThis.CollabTeXAttachmentStore.replaceFile(data.attachment.id, file);
      data.attachment = updated;
      data.pdfDirty = false;
      $(".ctca-pdf-provider", root).textContent = attachmentProviderLabel(updated);
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

  async function loadPdfView(attachment, entry) {
    if (currentPdfObjectUrl) { URL.revokeObjectURL(currentPdfObjectUrl); currentPdfObjectUrl = ""; }
    $(".ctca-pdf-tab-title", root).textContent = attachment.name;
    $(".ctca-pdf-provider", root).textContent = attachmentProviderLabel(attachment);
    $(".ctca-pdf-note", root).value = attachment.notes || "";
    const tabState = openPdfTabs.get(activeWorkspaceTab) || {};
    tabState.viewerReady = false;
    tabState.pdfDirty = false;
    const layout = $(".ctca-pdf-layout", root);
    layout.classList.toggle("ctca-pdf-notes-collapsed", Boolean(tabState.notesCollapsed));
    layout.classList.toggle("ctca-pdf-details-collapsed", Boolean(tabState.detailsCollapsed));
    const frame = $(".ctca-pdf-frame", root), unavailable = $(".ctca-pdf-unavailable", root);
    frame.hidden = false; unavailable.hidden = true;
    try {
      const viewerUrl = extensionApi.runtime.getURL(`pdf-viewer.html?attachment=${encodeURIComponent(attachment.id)}`);
      frame.src = viewerUrl;
    } catch (error) {
      frame.hidden = true; unavailable.hidden = false;
      unavailable.textContent = error.message || String(error);
    }
    if (entry) { renderDetails(); syncPdfEntryDetails(); }
  }

  async function activePdfAttachment() {
    return openPdfTabs.get(activeWorkspaceTab)?.attachment || null;
  }

  async function savePdfNotes() {
    const attachment = await activePdfAttachment(); if (!attachment) return;
    const updated = await globalThis.CollabTeXAttachmentStore.update(attachment.id, { notes: $(".ctca-pdf-note", root).value });
    openPdfTabs.get(activeWorkspaceTab).attachment = updated;
    setStatus(updated.provider === "nextcloud" ? "PDF notes saved and uploaded to Nextcloud." : "PDF notes saved.");
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

  function detailInputChanged(event) {
    if (busy) return;
    const entry = entryByKey(selectedKey);
    if (!entry) return;
    const field = event.target.dataset.managerField;
    const property = event.target.dataset.managerProperty;
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
      if (categoryState.memberships[oldKey]) {
        categoryState.memberships[newKey] = categoryState.memberships[oldKey];
        delete categoryState.memberships[oldKey];
      }
      if (selectedKeys.delete(oldKey)) selectedKeys.add(newKey);
      if (selectedKey === oldKey) selectedKey = newKey;
      if (selectionAnchorKey === oldKey) selectionAnchorKey = newKey;
    } else {
      return;
    }
    entry.updatedAt = new Date().toISOString();
    markDirty();
    scheduleListRender();
    if (event.type === "change") flushAutoSave().catch(() => {});
  }

  async function detailActionClicked(event) {
    const button = event.target.closest("button[data-manager-action]");
    if (!button || busy) return;
    event.preventDefault();
    const entry = entryByKey(selectedKey);
    if (!entry) return;
    const action = button.dataset.managerAction;

    if (action === "open-paper") {
      const url = paperUrl(entry);
      if (url) window.open(url, "_blank", "noopener,noreferrer");
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
        message: "This entry will be removed from the global bibliography database.",
        buttons: [
          { label: "Keep entry", value: false },
          { label: "Remove entry", value: true, danger: true }
        ],
        closeValue: false,
        danger: true
      });
      if (!confirmed) return;
      removeEntryKeys([entry.key]);
      await saveDatabase(`Removed ${entry.key}.`);
      renderAll();
      return;
    }
    if (action === "add-pdf") {
      await openAddPdfDialog(entry);
      return;
    }
    if (["open-pdf", "rename-pdf", "replace-pdf", "remove-pdf"].includes(action)) {
      const attachments = await globalThis.CollabTeXAttachmentStore.list(entry);
      const attachment = attachments.find((item) => item.id === button.dataset.attachmentId);
      if (!attachment) return;
      if (action === "open-pdf") {
        await openPdfTab(entry, attachment);
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
          if (activeWorkspaceTab === `pdf:${updated.id}`) $(".ctca-pdf-tab-title", root).textContent = updated.name;
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
        await globalThis.CollabTeXAttachmentStore.remove(attachment.id);
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

  async function updateEntriesFromDoi(targets) {
    const doiTargets = targets.filter((entry) => normalizeDoi(entry.fields?.doi));
    if (!doiTargets.length) {
      setStatus("None of the selected entries contains a DOI.", true);
      return;
    }
    const confirmed = await showDialog({
      title: doiTargets.length === 1 ? "Update entry from DOI" : "Update entries from DOI",
      message: `${doiTargets.length} entr${doiTargets.length === 1 ? "y" : "ies"} will be updated. Existing fields not supplied by the DOI service are preserved.`,
      buttons: [
        { label: "Cancel", value: false },
        { label: "Start DOI update", value: true, primary: true }
      ],
      closeValue: false
    });
    if (!confirmed) return;

    bulkAbortRequested = false;
    let updated = 0;
    let failed = 0;
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
      if (updated) await saveDatabase(`DOI update completed: ${updated} updated${failed ? `, ${failed} failed` : ""}.`);
      else setStatus(`DOI update completed: 0 updated${failed ? `, ${failed} failed` : ""}.`, failed > 0);
      renderAll();
    } finally {
      activeDoiRequestId = "";
      bulkAbortRequested = false;
      setBusy(false);
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
    for (const entry of entries) {
      if (removal.has(entry.key)) rememberGlobalDeletion(entry);
    }
    entries = entries.filter((entry) => !removal.has(entry.key));
    for (const key of removal) delete categoryState.memberships[key];
    selectedKeys = new Set([...selectedKeys].filter((key) => !removal.has(key)));
    if (removal.has(selectedKey)) selectedKey = entries[0]?.key || "";
    markDirty("Saving removals automatically…");
  }

  async function removeSelected() {
    if (selectedKeys.size < 2) return;
    const count = selectedKeys.size;
    const confirmed = await showDialog({
      title: `Remove ${count} selected entries?`,
      message: "The selected entries will be removed from the global bibliography database.",
      buttons: [
        { label: "Keep entries", value: false },
        { label: `Remove ${count} entries`, value: true, danger: true }
      ],
      closeValue: false,
      danger: true
    });
    if (!confirmed) return;
    removeEntryKeys([...selectedKeys]);
    await saveDatabase(`Removed ${count} entries.`);
    renderAll();
  }

  function createCategoryId() {
    return `category-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
  }

  async function createCategory() {
    let input;
    const name = await showDialog({
      title: "Create bibliography category",
      message: "Create a top-level category. Drag it onto another category later to make it a subcategory.",
      controls: (container) => {
        const label = document.createElement("label");
        label.className = "ctca-app-dialog-field";
        label.innerHTML = `<span>Category name</span><input type="text" maxlength="120" placeholder="e.g. Plasma instabilities">`;
        input = $("input", label);
        container.appendChild(label);
      },
      buttons: [
        { label: "Cancel", value: null },
        { label: "Create category", primary: true, getValue: () => input?.value.trim() || "" }
      ],
      closeValue: null
    });
    if (!name) return;
    categoryState.categories.push({
      id: createCategoryId(),
      name,
      parentId: "",
      order: categoryChildren("").length
    });
    markDirty("Saving new category automatically…");
    renderCategories();
  }

  async function removeCategory(categoryId) {
    const category = categoryById(categoryId);
    if (!category) return;
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

  function showDialog({ title, message = "", controls = null, buttons = [{ label: "Close", value: null }], closeValue = null, danger = false }) {
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
      <label class="ctca-app-dialog-field"><span>Entry type</span><select data-add-property="type">${ENTRY_TYPES.map((type) => `<option value="${type}" ${type === "article" ? "selected" : ""}>${type}</option>`).join("")}</select></label>
      <label class="ctca-app-dialog-field"><span>Citation key</span><input data-add-property="key" placeholder="Generated if empty"></label>
      <label class="ctca-app-dialog-field ctca-app-dialog-field-wide"><span>Title</span><textarea rows="2" data-add-field="title"></textarea></label>
      <label class="ctca-app-dialog-field ctca-app-dialog-field-wide"><span>Authors</span><textarea rows="3" data-add-field="author" placeholder="Family, Given and Family, Given"></textarea></label>
      <label class="ctca-app-dialog-field ctca-app-dialog-field-wide"><span>Journal / book title</span><input data-add-field="journal"></label>
      <label class="ctca-app-dialog-field"><span>Year</span><input data-add-field="year"></label>
      <label class="ctca-app-dialog-field"><span>Volume</span><input data-add-field="volume"></label>
      <label class="ctca-app-dialog-field"><span>Pages / article number</span><input data-add-field="pages"></label>
      <label class="ctca-app-dialog-field ctca-app-dialog-field-wide"><span>URL</span><input data-add-field="url"></label>
      <label class="ctca-app-dialog-field ctca-app-dialog-field-wide"><span>Abstract</span><textarea rows="5" data-add-field="abstract"></textarea></label>
      <label class="ctca-app-dialog-field ctca-app-dialog-field-wide"><span>Keywords</span><textarea rows="2" data-add-field="keywords"></textarea></label>
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
    let form;
    const result = await showDialog({
      title: "Add bibliography entry",
      message: "DOI metadata can fill the form before saving.",
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
      doiSyncedAt: result.fields.doi ? new Date().toISOString() : ""
    };
    entries.push(entry);
    if (selectedCategoryId !== "all" && selectedCategoryId !== "uncategorized") {
      setEntryCategoryIds(key, [selectedCategoryId]);
    }
    selectedKey = key;
    selectedKeys = new Set([key]);
    await saveDatabase(`Added ${key}.`);
    renderAll();
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
    if (abstractToggle) abstractToggle.checked = searchOptions.includeAbstract !== false;
    if (pdfToggle) pdfToggle.checked = searchOptions.includePdfText === true;
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
    query = input.value;
    $(".ctca-manager-search-clear", root).hidden = !query;
    renderList();
    input.focus();
  }

  function renderAll() {
    renderCategories();
    renderList();
    renderDetails();
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
    const tags = globalThis.CollabTeXSearchTools.splitTags(entry.tags || []);
    if (tags.length) fields.ctca_tags = tags.join(", ");
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
      "abstract", "keywords", "ctca_meta_version", "ctca_doi_synced", "ctca_tags",
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
      .map((index) => ({ ...normalizeEntry(plan.incoming[index]), updatedAt: plan.incoming[index]?.updatedAt || now }));

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

  function setPdfMaximized(maximized) {
    const value = Boolean(maximized && activeWorkspaceTab !== "bibliography");
    root.classList.toggle("ctca-pdf-maximized", value);
    const button = $(".ctca-pdf-fullscreen", root);
    if (button) {
      button.setAttribute("aria-pressed", value ? "true" : "false");
      button.setAttribute("aria-label", value ? "Reduce PDF view" : "Maximize PDF view");
      button.title = value ? "Reduce PDF view" : "Maximize PDF view";
    }
    const frame = $(".ctca-pdf-frame", root);
    frame?.contentWindow?.postMessage({
      type: "ctca-pdf-host-layout",
      attachmentId: openPdfTabs.get(activeWorkspaceTab)?.attachment?.id || "",
      maximized: value
    }, "*");
  }

  function bindEvents() {
    $(".ctca-manager-close", root).addEventListener("click", () => {
      closeStandaloneManager().catch((error) => setStatus(error?.message || String(error), true));
    });
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
    $(".ctca-manager-update-all-doi", root).addEventListener("click", () => updateEntriesFromDoi(entries));
    $(".ctca-manager-update-selected", root).addEventListener("click", () => updateEntriesFromDoi([...selectedKeys].map(entryByKey).filter(Boolean)));
    $(".ctca-manager-remove-selected", root).addEventListener("click", removeSelected);
    $(".ctca-manager-abort-doi", root).addEventListener("click", abortDoiUpdate);
    $(".ctca-manager-cloud-settings", root).addEventListener("click", () => openPdfStorageSettings().catch((error) => setStatus(error.message || String(error), true)));
    $(".ctca-manager-collapse-details", root).addEventListener("click", () => {
      bibliographyDetailsCollapsed = !bibliographyDetailsCollapsed;
      root.classList.toggle("ctca-details-collapsed", bibliographyDetailsCollapsed);
      $(".ctca-manager-collapse-details", root).title = bibliographyDetailsCollapsed ? "Expand detail pane" : "Collapse detail pane";
    });
    window.addEventListener("message", (event) => {
      const frame = $(".ctca-pdf-frame", root);
      if (!frame || event.source !== frame.contentWindow) return;
      const message = event.data || {};
      const data = openPdfTabs.get(activeWorkspaceTab);
      const attachment = data?.attachment;
      if (!attachment || (message.attachmentId && message.attachmentId !== attachment.id)) return;

      if (message.type === "ctca-pdf-viewer-ready") {
        data.viewerReady = true;
        frame.contentWindow.postMessage({
          type: "ctca-pdf-host-layout",
          attachmentId: attachment.id,
          maximized: root.classList.contains("ctca-pdf-maximized")
        }, "*");
        return;
      }
      if (message.type === "ctca-pdf-request-data") {
        sendPdfDataToFrame(frame, attachment).catch(() => {});
        return;
      }
      if (message.type === "ctca-pdf-dirty-state") {
        data.pdfDirty = Boolean(message.dirty);
        data.pdfSaving = Boolean(message.saving);
        return;
      }
      if (message.type === "ctca-pdf-save-data") {
        persistAnnotatedPdf(frame, message).catch((error) => setStatus(error?.message || String(error), true));
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
    const setPdfPaneCollapsed = (pane, collapsed) => {
      const layout = $(".ctca-pdf-layout", root);
      const className = pane === "notes" ? "ctca-pdf-notes-collapsed" : "ctca-pdf-details-collapsed";
      layout.classList.toggle(className, collapsed);
      const state = openPdfTabs.get(activeWorkspaceTab);
      if (state) state[pane === "notes" ? "notesCollapsed" : "detailsCollapsed"] = collapsed;
      const collapseButton = $(pane === "notes" ? ".ctca-pdf-collapse-notes" : ".ctca-pdf-collapse-details", root);
      if (collapseButton) collapseButton.title = collapsed ? `Expand ${pane === "notes" ? "notes pane" : "entry details"}` : `Collapse ${pane === "notes" ? "notes pane" : "entry details"}`;
    };
    $(".ctca-pdf-collapse-notes", root).addEventListener("click", () => setPdfPaneCollapsed("notes", true));
    $(".ctca-pdf-restore-notes", root).addEventListener("click", () => setPdfPaneCollapsed("notes", false));
    $(".ctca-pdf-collapse-details", root).addEventListener("click", () => setPdfPaneCollapsed("details", true));
    $(".ctca-pdf-restore-details", root).addEventListener("click", () => setPdfPaneCollapsed("details", false));
    $(".ctca-pdf-note", root).addEventListener("input", () => {
      window.clearTimeout(pdfNoteSaveTimer); pdfNoteSaveTimer = window.setTimeout(() => savePdfNotes().catch((error) => setStatus(error.message || String(error), true)), 500);
    });
    $(".ctca-pdf-note", root).addEventListener("change", () => savePdfNotes().catch((error) => setStatus(error.message || String(error), true)));
    $(".ctca-pdf-download", root).addEventListener("click", async () => {
      const attachment = await activePdfAttachment(); if (!attachment) return;
      const blob = await globalThis.CollabTeXAttachmentStore.getBlob(attachment); if (!blob) return;
      const url = URL.createObjectURL(blob), link = document.createElement("a"); link.href = url; link.download = attachment.fileName || `${attachment.name}.pdf`; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
    });
    $(".ctca-pdf-fullscreen", root).addEventListener("click", () => setPdfMaximized(!root.classList.contains("ctca-pdf-maximized")));
    initializePdfResizer($(".ctca-pdf-resizer-notes", root), "notes");
    initializePdfResizer($(".ctca-pdf-resizer-details", root), "details");
    root.addEventListener("keydown", (event) => { if (event.key === "Escape" && root.classList.contains("ctca-pdf-maximized")) { event.preventDefault(); setPdfMaximized(false); } });
    $(".ctca-manager-select-visible-checkbox", root).addEventListener("change", (event) => {
      const visibleKeys = filteredEntries().map((entry) => entry.key);
      if (event.target.checked) visibleKeys.forEach((key) => selectedKeys.add(key));
      else visibleKeys.forEach((key) => selectedKeys.delete(key));
      renderList();
    });
    $(".ctca-category-remove", root).addEventListener("click", () => {
      const menu = $(".ctca-category-context-menu", root);
      const categoryId = menu.dataset.categoryId || "";
      menu.hidden = true;
      removeCategory(categoryId);
    });

    const searchInput = $(".ctca-manager-search", root);
    const searchClear = $(".ctca-manager-search-clear", root);
    searchInput.addEventListener("input", () => {
      query = searchInput.value || "";
      searchClear.hidden = !query;
      renderList();
    });
    searchClear.addEventListener("click", () => {
      searchInput.value = "";
      query = "";
      searchClear.hidden = true;
      renderList();
      searchInput.focus();
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
      searchFilters = globalThis.CollabTeXSearchTools.normalizeFilterState({
        type: $(".ctca-search-filter-type", root).value,
        yearFrom: $(".ctca-search-filter-year-from", root).value,
        yearTo: $(".ctca-search-filter-year-to", root).value,
        doi: $(".ctca-search-filter-doi", root).value,
        tagged: $(".ctca-search-filter-tagged", root).value
      });
      updateSearchFilterBadge();
      renderList();
      saveUiState().catch(() => {});
    };
    root.querySelectorAll(".ctca-search-include-abstract, .ctca-search-include-pdf, .ctca-search-filter-type, .ctca-search-filter-year-from, .ctca-search-filter-year-to, .ctca-search-filter-doi, .ctca-search-filter-tagged").forEach((control) => {
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

    root.addEventListener("click", (event) => {
      if (!event.target.closest(".ctca-manager-search-composite")) {
        setSearchMenuOpen(false);
      }
      if (!event.target.closest(".ctca-manager-add-menu-wrap")) closeAddMenu();
      if (!event.target.closest(".ctca-category-context-menu")) {
        $(".ctca-category-context-menu", root).hidden = true;
      }
    });

    root.querySelectorAll("[data-manager-sort]").forEach((button) => {
      button.addEventListener("click", () => {
        const field = button.dataset.managerSort;
        if (sortState.field === field) sortState.direction = sortState.direction === "asc" ? "desc" : "asc";
        else sortState = { field, direction: "asc" };
        renderList();
      });
    });

    const details = $(".ctca-manager-details", root);
    details.addEventListener("input", (event) => {
      if (event.target.matches(".ctca-tag-input")) {
        const entry = entryByKey(selectedKey);
        if (entry) renderTagSuggestions(entry, event.target);
        return;
      }
      detailInputChanged(event);
    });
    details.addEventListener("change", detailInputChanged);
    details.addEventListener("keydown", tagInputKeydown);
    details.addEventListener("focusin", (event) => {
      if (event.target.matches(".ctca-tag-input")) {
        const entry = entryByKey(selectedKey);
        if (entry) renderTagSuggestions(entry, event.target);
      }
    });
    details.addEventListener("focusout", (event) => {
      if (event.target.matches(".ctca-tag-input")) {
        window.setTimeout(() => event.target.closest(".ctca-tag-input-wrap")?.querySelector(".ctca-tag-suggestions")?.setAttribute("hidden", ""), 120);
      }
    });
    details.addEventListener("click", detailActionClicked);

    const pdfDetails = $(".ctca-pdf-entry-details", root);
    pdfDetails.addEventListener("input", (event) => {
      if (event.target.matches(".ctca-tag-input")) { const entry = entryByKey(selectedKey); if (entry) renderTagSuggestions(entry, event.target); return; }
      detailInputChanged(event);
    });
    pdfDetails.addEventListener("change", detailInputChanged);
    pdfDetails.addEventListener("keydown", tagInputKeydown);
    pdfDetails.addEventListener("click", detailActionClicked);

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
      if (globalThis.CollabTeXAttachmentStore.CONFIG_KEY in changes) {
        const config = changes[globalThis.CollabTeXAttachmentStore.CONFIG_KEY]?.newValue || {};
        await refreshNextcloudSyncState(config);
      }
      if (globalThis.CollabTeXAttachmentStore.INDEX_KEY in changes && document.visibilityState === "visible") {
        const entry = entryByKey(selectedKey);
        if (entry) await renderAttachmentList(entry);
      }
      if (DB_KEY in changes && document.visibilityState === "visible" && !dirty) {
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
    setBusy(true, "Loading…");
    try {
      await loadDatabase();
      selectedKey = entries[0]?.key || "";
      if (selectedKey) selectedKeys = new Set([selectedKey]);
      bindEvents();
      initializeResizers();
      window.addEventListener("focus", () => scheduleNextcloudSync(100));
      window.setInterval(() => scheduleNextcloudSync(50), 5 * 60 * 1000);
      renderAll();
      renderWorkspaceTabs();
      const hashKey = decodeURIComponent(location.hash.replace(/^#entry=/, ""));
      if (hashKey && entries.some((entry) => entry.key === hashKey)) { selectedKey = hashKey; renderAll(); }
      setStatus(entries.length ? "Global bibliography loaded." : "No global bibliography entries yet.");
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
      setBusy(false);
    }
  }

  initialize();
})();
