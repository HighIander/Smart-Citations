/* SPDX-License-Identifier: CC-BY-NC-SA-4.0 */

(() => {
  "use strict";
  const api = globalThis.browser ?? globalThis.chrome;
  const PREFIX = "collabtex-citation-assistant:";
  const INDEX_KEY = `${PREFIX}pdf-attachments:v1`;
  const CONFIG_KEY = `${PREFIX}pdf-storage-config:v1`;
  const GLOBAL_DATABASE_KEY = `${PREFIX}global-bibliography:v1`;
  const GLOBAL_PENDING_KEY = `${PREFIX}global-bibliography-pending:v1`;
  const BIB_SYNC_BASE_KEY = `${PREFIX}nextcloud-bibliography-sync-base:v1`;
  const REMOTE_BIB_FILE = "global-bibliography.bib";
  const LEGACY_REMOTE_BIB_DATABASE = "bibliography-database.json";
  const DELETION_COMMENT_PREFIX = "ctca_deleted_entries:";
  const CONFIG_SCHEMA_VERSION = 2;
  const DB_NAME = "ctca-pdf-attachments-v1";
  const STORE_NAME = "files";
  const HANDLE_STORE_NAME = "handles";
  const sessionLocalFiles = new Map();
  let attachmentIndexCache = null;
  let attachmentIndexLoadPromise = null;
  let attachmentIndexCacheRevision = 0;

  const now = () => new Date().toISOString();
  const uuid = () => globalThis.crypto?.randomUUID?.() || `att-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const normalizeDoi = (value) => String(value || "").trim().replace(/^doi\s*:\s*/i, "").replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, "").toLowerCase();
  const sanitizeFileName = (value) => String(value || "attachment.pdf").replace(/[\\/:*?"<>|\u0000-\u001f]+/g, "_").replace(/\s+/g, " ").trim() || "attachment.pdf";
  const encodePath = (path) => String(path || "").split("/").filter(Boolean).map(encodeURIComponent).join("/");
  const basicAuth = (user, password) => `Basic ${btoa(unescape(encodeURIComponent(`${user}:${password}`)))}`;

  function entryRef(entry) {
    const doi = normalizeDoi(entry?.fields?.doi || entry?.doi || "");
    const key = String(entry?.key || "Reference").trim();
    const keys = [...new Set([
      key,
      entry?.originalKey,
      ...(Array.isArray(entry?.aliases) ? entry.aliases : []),
      ...String(entry?.fields?.ids || "").split(/[;,\s]+/)
    ]
      .map((value) => String(value || "").trim().toLowerCase())
      .filter(Boolean))];
    return {
      identity: doi ? `doi:${doi}` : `key:${key.toLowerCase()}`,
      identities: [
        ...(doi ? [`doi:${doi}`] : []),
        ...keys.map((value) => `key:${value}`)
      ],
      keys,
      key,
      doi,
      title: String(entry?.fields?.title || entry?.title || key || "Reference")
    };
  }

  async function storageGet(key) {
    return (await api.storage.local.get(key))?.[key];
  }
  async function storageSet(key, value) {
    await api.storage.local.set({ [key]: value });
  }

  async function backgroundRequest(message) {
    try {
      const response = await api.runtime.sendMessage(message);
      if (!response?.ok) {
        const error = new Error(response?.error || "The extension PDF storage service did not respond.");
        if (response?.code) error.code = String(response.code);
        throw error;
      }
      return response;
    } catch (error) {
      const wrapped = new Error(error?.message || String(error));
      if (error?.code) wrapped.code = String(error.code);
      throw wrapped;
    }
  }


  function headersToObject(input) {
    const result = {};
    if (!input) return result;

    // Firefox can expose Headers objects from another extension/content-script
    // realm whose entries() result is not recognized as iterable. forEach() is
    // supported across those realms and avoids the "headers.entries() is not
    // iterable" regression.
    if (typeof input.forEach === "function") {
      input.forEach((value, key) => {
        result[String(key)] = String(value);
      });
      return result;
    }
    if (Array.isArray(input)) {
      for (const pair of input) {
        if (Array.isArray(pair) && pair.length >= 2) result[String(pair[0])] = String(pair[1]);
      }
      return result;
    }
    for (const [key, value] of Object.entries(input)) {
      if (value !== undefined && value !== null) result[String(key)] = String(value);
    }
    return result;
  }

  function findHeaderName(headers, name) {
    const target = String(name).toLowerCase();
    return Object.keys(headers).find((key) => key.toLowerCase() === target) || "";
  }

  function hasHeader(headers, name) {
    return Boolean(findHeaderName(headers, name));
  }

  function setHeader(headers, name, value) {
    const existing = findHeaderName(headers, name);
    headers[existing || name] = String(value);
  }

  function arrayBufferToBase64(buffer) {
    const bytes = new Uint8Array(buffer);
    const chunkSize = 0x8000;
    let binary = "";
    for (let offset = 0; offset < bytes.length; offset += chunkSize) {
      binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
    }
    return btoa(binary);
  }

  function base64ToUint8Array(value) {
    const binary = atob(String(value || ""));
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    return bytes;
  }

  async function responseJson(response, context) {
    const text = await response.text();
    if (!text.trim()) throw new Error(`${context} returned an empty response.`);
    try {
      return JSON.parse(text);
    } catch (_) {
      throw new Error(`${context} returned invalid JSON.`);
    }
  }

  async function extensionFetch(url, options = {}) {
    const headers = headersToObject(options.headers);
    let bodyBytes = null;
    let bodyText = null;
    if (options.body instanceof Blob) {
      bodyBytes = await options.body.arrayBuffer();
      if (options.body.type && !hasHeader(headers, "Content-Type")) setHeader(headers, "Content-Type", options.body.type);
    } else if (options.body instanceof ArrayBuffer) {
      bodyBytes = options.body;
    } else if (ArrayBuffer.isView(options.body)) {
      bodyBytes = options.body.buffer.slice(options.body.byteOffset, options.body.byteOffset + options.body.byteLength);
    } else if (options.body instanceof URLSearchParams) {
      bodyText = options.body.toString();
      if (!hasHeader(headers, "Content-Type")) setHeader(headers, "Content-Type", "application/x-www-form-urlencoded;charset=UTF-8");
    } else if (typeof options.body === "string") {
      bodyText = options.body;
    }
    const response = await backgroundRequest({
      type: "ctca-nextcloud-fetch",
      url,
      method: options.method || "GET",
      headers,
      bodyBase64: bodyBytes ? arrayBufferToBase64(bodyBytes) : null,
      bodyText
    });
    const responseInit = {
      status: response.status,
      statusText: response.statusText || "",
      headers: response.headers || {}
    };
    const method = String(options.method || "GET").toUpperCase();
    const hasNullBodyStatus = [204, 205, 304].includes(response.status);
    const responseBytes = typeof response.bodyBase64 === "string"
      ? base64ToUint8Array(response.bodyBase64)
      : response.bodyBytes
        ? new Uint8Array(response.bodyBytes)
        : null;
    const hasBodyBytes = responseBytes && responseBytes.byteLength > 0;
    if (method === "HEAD" || hasNullBodyStatus || !hasBodyBytes) {
      return new Response(undefined, responseInit);
    }
    return new Response(responseBytes, responseInit);
  }

  async function storeBrowserBlob(id, blob) {
    const bytes = await blob.arrayBuffer();
    return backgroundRequest({
      type: "ctca-pdf-store-browser",
      id,
      mimeType: blob.type || "application/pdf",
      bytes
    });
  }

  async function getBackgroundBlob(type, id) {
    const response = await backgroundRequest({ type, id });
    if (!response.found || !response.bytes) return null;
    return new Blob([response.bytes], { type: response.mimeType || "application/pdf" });
  }

  function normalizeAttachmentIndex(value) {
    return value && Array.isArray(value.attachments)
      ? value
      : { version: 1, attachments: [], updatedAt: "" };
  }

  function cloneAttachmentIndex(index) {
    return {
      ...index,
      attachments: index.attachments.map((attachment) => ({
        ...attachment,
        entry: attachment.entry ? { ...attachment.entry } : attachment.entry
      }))
    };
  }

  async function loadIndex() {
    if (!attachmentIndexCache) {
      if (!attachmentIndexLoadPromise) {
        const loadRevision = attachmentIndexCacheRevision;
        const pending = storageGet(INDEX_KEY).then((value) => {
          if (attachmentIndexCacheRevision === loadRevision || !attachmentIndexCache) {
            attachmentIndexCache = normalizeAttachmentIndex(value);
          }
          return attachmentIndexCache;
        });
        attachmentIndexLoadPromise = pending;
        const clearPending = () => {
          if (attachmentIndexLoadPromise === pending) attachmentIndexLoadPromise = null;
        };
        pending.then(clearPending, clearPending);
      }
      await attachmentIndexLoadPromise;
    }
    return cloneAttachmentIndex(attachmentIndexCache);
  }

  async function saveIndex(index) {
    index.updatedAt = now();
    const next = cloneAttachmentIndex(normalizeAttachmentIndex(index));
    await storageSet(INDEX_KEY, next);
    attachmentIndexCache = next;
    attachmentIndexCacheRevision += 1;
  }

  api.storage.onChanged?.addListener((changes, areaName) => {
    if (areaName !== "local" || !Object.prototype.hasOwnProperty.call(changes, INDEX_KEY)) return;
    attachmentIndexCache = normalizeAttachmentIndex(changes[INDEX_KEY]?.newValue);
    attachmentIndexLoadPromise = null;
    attachmentIndexCacheRevision += 1;
  });

  async function getConfig() {
    const stored = await storageGet(CONFIG_KEY);
    const defaults = {
      schemaVersion: CONFIG_SCHEMA_VERSION,
      provider: "browser",
      nextcloud: { server: "", loginName: "", userId: "", appPassword: "", directory: "Smart Citations", syncBibliography: true }
    };
    if (!stored || typeof stored !== "object") return defaults;

    const legacyConfig = Number(stored.schemaVersion || 0) < CONFIG_SCHEMA_VERSION;
    const storedNextcloud = stored.nextcloud && typeof stored.nextcloud === "object" ? stored.nextcloud : {};
    const syncBibliography = legacyConfig && storedNextcloud.appPassword
      ? true
      : typeof storedNextcloud.syncBibliography === "boolean"
        ? storedNextcloud.syncBibliography
        : true;

    return {
      ...defaults,
      ...stored,
      schemaVersion: CONFIG_SCHEMA_VERSION,
      nextcloud: { ...defaults.nextcloud, ...storedNextcloud, syncBibliography }
    };
  }
  async function saveConfig(config) {
    await storageSet(CONFIG_KEY, { ...config, schemaVersion: CONFIG_SCHEMA_VERSION });
  }

  async function checkNextcloudConnection(configOverride = null) {
    const config = configOverride || await getConfig();
    const nc = config?.nextcloud || {};
    if (!nc.server || !nc.loginName || !nc.appPassword) return false;
    try {
      const response = await extensionFetch(`${normalizeServer(nc.server)}/ocs/v2.php/cloud/user?format=json`, {
        headers: {
          Authorization: basicAuth(nc.loginName, nc.appPassword),
          "OCS-APIRequest": "true",
          Accept: "application/json"
        }
      });
      return response.ok;
    } catch (_) {
      return false;
    }
  }

  function openDb() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, 2);
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains(STORE_NAME)) request.result.createObjectStore(STORE_NAME);
        if (!request.result.objectStoreNames.contains(HANDLE_STORE_NAME)) request.result.createObjectStore(HANDLE_STORE_NAME);
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }
  async function idbPut(id, blob) {
    const db = await openDb();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, "readwrite");
      tx.objectStore(STORE_NAME).put(blob, id);
      tx.oncomplete = resolve; tx.onerror = () => reject(tx.error);
    });
    db.close();
  }
  async function idbGet(id) {
    const db = await openDb();
    const value = await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, "readonly");
      const request = tx.objectStore(STORE_NAME).get(id);
      request.onsuccess = () => resolve(request.result || null);
      request.onerror = () => reject(request.error);
    });
    db.close();
    return value;
  }
  async function idbDelete(id) {
    const db = await openDb();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, "readwrite");
      tx.objectStore(STORE_NAME).delete(id);
      tx.oncomplete = resolve; tx.onerror = () => reject(tx.error);
    });
    db.close();
  }
  async function idbHandlePut(id, handle) {
    const db = await openDb();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(HANDLE_STORE_NAME, "readwrite");
      tx.objectStore(HANDLE_STORE_NAME).put(handle, id);
      tx.oncomplete = resolve; tx.onerror = () => reject(tx.error);
    });
    db.close();
  }
  async function idbHandleGet(id) {
    const db = await openDb();
    const value = await new Promise((resolve, reject) => {
      const tx = db.transaction(HANDLE_STORE_NAME, "readonly");
      const request = tx.objectStore(HANDLE_STORE_NAME).get(id);
      request.onsuccess = () => resolve(request.result || null);
      request.onerror = () => reject(request.error);
    });
    db.close();
    return value;
  }
  async function idbHandleDelete(id) {
    const db = await openDb();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(HANDLE_STORE_NAME, "readwrite");
      tx.objectStore(HANDLE_STORE_NAME).delete(id);
      tx.oncomplete = resolve; tx.onerror = () => reject(tx.error);
    });
    db.close();
  }

  async function requestOriginPermission(server) {
    const origin = new URL(server).origin;
    const pattern = `${origin}/*`;

    // Extension pages can request optional permissions directly. ColLabTeX's
    // overlay runs as a content script, where Firefox intentionally does not
    // expose browser.permissions; delegate that case to the background page.
    if (api.permissions?.contains && api.permissions?.request) {
      const contains = await api.permissions.contains({ origins: [pattern] });
      if (contains) return true;
      return api.permissions.request({ origins: [pattern] });
    }

    const response = await backgroundRequest({
      type: "ctca-request-origin-permission",
      server: origin
    });
    return response.granted === true;
  }

  function normalizeServer(server) {
    const url = new URL(String(server || "").trim());
    if (!/^https?:$/.test(url.protocol)) throw new Error("Nextcloud server must use http or https.");
    return url.href.replace(/\/+$/, "");
  }

  async function connectNextcloud(server, directory = "Smart Citations", onStatus = () => {}) {
    server = normalizeServer(server);
    if (!(await requestOriginPermission(server))) throw new Error("Permission for the Nextcloud server was not granted.");
    onStatus("Starting Nextcloud client login flow…");
    const start = await extensionFetch(`${server}/index.php/login/v2`, { method: "POST" });
    if (!start.ok) throw new Error(`Nextcloud login flow could not be started (${start.status}).`);
    const flow = await responseJson(start, "Nextcloud login flow");
    if (!flow?.login || !flow?.poll?.endpoint || !flow?.poll?.token) throw new Error("Nextcloud returned an invalid login-flow response.");
    // browser.tabs is unavailable in Firefox content scripts. Opening the
    // login page through the background context works identically from both
    // the standalone manager and the ColLabTeX overlay.
    await backgroundRequest({ type: "ctca-open-external-tab", url: flow.login, active: true });
    onStatus("Complete the login in the opened Nextcloud tab. Waiting for authorization…");
    const deadline = Date.now() + 20 * 60 * 1000;
    let credentials = null;
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 1800));
      const body = new URLSearchParams({ token: flow.poll.token });
      const response = await extensionFetch(flow.poll.endpoint, { method: "POST", body });
      if (response.status === 404) continue;
      if (!response.ok) throw new Error(`Nextcloud login polling failed (${response.status}).`);
      credentials = await responseJson(response, "Nextcloud login polling");
      break;
    }
    if (!credentials) throw new Error("Nextcloud login timed out.");
    const auth = basicAuth(credentials.loginName, credentials.appPassword);
    let userId = credentials.loginName;
    try {
      const userResponse = await extensionFetch(`${credentials.server}/ocs/v2.php/cloud/user?format=json`, {
        headers: { Authorization: auth, "OCS-APIRequest": "true", Accept: "application/json" }
      });
      if (userResponse.ok) userId = (await responseJson(userResponse, "Nextcloud user lookup"))?.ocs?.data?.id || userId;
    } catch (_) {}
    const config = await getConfig();
    config.provider = "nextcloud";
    config.nextcloud = {
      server: normalizeServer(credentials.server),
      loginName: credentials.loginName,
      userId,
      appPassword: credentials.appPassword,
      directory: String(directory || "Smart Citations").replace(/^\/+|\/+$/g, ""),
      syncBibliography: Boolean(config.nextcloud?.syncBibliography)
    };
    await saveConfig(config);
    await ensureNextcloudFolders(config.nextcloud);
    onStatus(`Connected to Nextcloud as ${credentials.loginName}.`);
    return config;
  }

  function davBase(nc) {
    return `${nc.server}/remote.php/dav/files/${encodeURIComponent(nc.userId || nc.loginName)}`;
  }
  function davUrl(nc, relativePath = "") {
    const parts = [nc.directory, relativePath].filter(Boolean).join("/");
    return `${davBase(nc)}/${encodePath(parts)}`;
  }
  async function davFetch(nc, relativePath, options = {}) {
    const headers = headersToObject(options.headers);
    setHeader(headers, "Authorization", basicAuth(nc.loginName, nc.appPassword));
    return extensionFetch(davUrl(nc, relativePath), { ...options, headers });
  }
  async function ensureNextcloudFolders(nc) {
    const rootParts = String(nc.directory || "").split("/").filter(Boolean);
    const targets = [];
    let current = "";
    for (const part of rootParts) {
      current = current ? `${current}/${part}` : part;
      targets.push(current);
    }
    const root = rootParts.join("/");
    targets.push(`${root}/files`, `${root}/annotations`);
    for (const target of targets.filter(Boolean)) {
      const headers = { Authorization: basicAuth(nc.loginName, nc.appPassword) };
      const response = await extensionFetch(`${davBase(nc)}/${encodePath(target)}`, { method: "MKCOL", headers });
      if (![201, 405].includes(response.status)) throw new Error(`Could not create Nextcloud folder ${target} (${response.status}).`);
    }
  }
  async function remoteIndex(nc) {
    const response = await davFetch(nc, "attachments-index.json");
    if (response.status === 404) return { version: 1, attachments: [], updatedAt: "" };
    if (!response.ok) throw new Error(`Could not read Nextcloud attachment index (${response.status}).`);
    const value = await response.json();
    return value && Array.isArray(value.attachments) ? value : { version: 1, attachments: [] };
  }
  async function writeRemoteIndex(nc, index) {
    const response = await davFetch(nc, "attachments-index.json", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ version: 1, attachments: index.attachments.filter((a) => a.provider === "nextcloud"), updatedAt: now() }, null, 2)
    });
    if (!response.ok) throw new Error(`Could not update Nextcloud attachment index (${response.status}).`);
  }
  async function uploadSidecar(nc, attachment) {
    const body = JSON.stringify({
      version: 1,
      attachmentId: attachment.id,
      entry: attachment.entry,
      name: attachment.name,
      notes: attachment.notes || "",
      updatedAt: attachment.updatedAt
    }, null, 2);
    const response = await davFetch(nc, `annotations/${attachment.id}.json`, { method: "PUT", headers: { "Content-Type": "application/json" }, body });
    if (!response.ok) throw new Error(`Could not upload PDF notes (${response.status}).`);
  }

  async function list(entry) {
    const ref = entryRef(entry);
    const index = await loadIndex();
    return orderedAttachmentsForEntry(index, ref);
  }

  async function listMany(entries) {
    const requested = (Array.isArray(entries) ? entries : [])
      .filter((entry) => entry && entry.key)
      .map((entry) => ({ lookupKey: String(entry.key), ref: entryRef(entry) }));
    const grouped = new Map(requested.map(({ lookupKey }) => [lookupKey, []]));
    if (!requested.length) return grouped;

    const identityLookup = new Map();
    const doiLookup = new Map();
    const keyLookup = new Map();
    const addLookup = (lookup, value, lookupKey) => {
      const normalized = String(value || "").trim().toLowerCase();
      if (!normalized) return;
      if (!lookup.has(normalized)) lookup.set(normalized, new Set());
      lookup.get(normalized).add(lookupKey);
    };
    for (const { lookupKey, ref } of requested) {
      ref.identities.forEach((identity) => addLookup(identityLookup, identity, lookupKey));
      if (ref.doi) addLookup(doiLookup, ref.doi, lookupKey);
      ref.keys.forEach((key) => addLookup(keyLookup, key, lookupKey));
    }

    const index = await loadIndex();
    index.attachments.forEach((attachment, indexPosition) => {
      const matchingKeys = new Set();
      const attachmentIdentity = String(attachment?.entry?.identity || "").trim().toLowerCase();
      const attachmentDoi = normalizeDoi(attachment?.entry?.doi || "");
      const attachmentKey = String(attachment?.entry?.key || "").trim().toLowerCase();
      for (const lookupKey of identityLookup.get(attachmentIdentity) || []) matchingKeys.add(lookupKey);
      for (const lookupKey of doiLookup.get(attachmentDoi) || []) matchingKeys.add(lookupKey);
      for (const lookupKey of keyLookup.get(attachmentKey) || []) matchingKeys.add(lookupKey);
      for (const lookupKey of matchingKeys) grouped.get(lookupKey)?.push({ attachment, indexPosition });
    });

    for (const [lookupKey, matches] of grouped) {
      matches.sort((left, right) => {
        const leftPosition = Number.isFinite(Number(left.attachment.position))
          ? Number(left.attachment.position)
          : 1_000_000 + left.indexPosition;
        const rightPosition = Number.isFinite(Number(right.attachment.position))
          ? Number(right.attachment.position)
          : 1_000_000 + right.indexPosition;
        return leftPosition - rightPosition || left.indexPosition - right.indexPosition;
      });
      grouped.set(lookupKey, matches.map(({ attachment }) => attachment));
    }
    return grouped;
  }

  function attachmentMatchesEntry(attachment, ref) {
    const attachmentIdentity = String(attachment?.entry?.identity || "").toLowerCase();
    const attachmentKey = String(attachment?.entry?.key || "").trim().toLowerCase();
    return ref.identities.includes(attachmentIdentity)
      || (ref.doi && attachment?.entry?.doi === ref.doi)
      || ref.keys.includes(attachmentKey);
  }

  function orderedAttachmentsForEntry(index, ref) {
    return index.attachments
      .map((attachment, indexPosition) => ({ attachment, indexPosition }))
      .filter(({ attachment }) => attachmentMatchesEntry(attachment, ref))
      .sort((left, right) => {
        const leftPosition = Number.isFinite(Number(left.attachment.position))
          ? Number(left.attachment.position)
          : 1_000_000 + left.indexPosition;
        const rightPosition = Number.isFinite(Number(right.attachment.position))
          ? Number(right.attachment.position)
          : 1_000_000 + right.indexPosition;
        return leftPosition - rightPosition || left.indexPosition - right.indexPosition;
      })
      .map(({ attachment }) => attachment);
  }

  async function reorder(entry, orderedIds) {
    const ref = entryRef(entry);
    const index = await loadIndex();
    const current = orderedAttachmentsForEntry(index, ref);
    const currentIds = current.map((item) => item.id);
    const requestedIds = [...new Set((Array.isArray(orderedIds) ? orderedIds : []).map(String))];
    if (
      requestedIds.length !== currentIds.length
      || requestedIds.some((id) => !currentIds.includes(id))
    ) {
      throw new Error("The PDF attachment order is out of date. Reload the entry and try again.");
    }
    if (requestedIds.every((id, index) => id === currentIds[index])) return current;

    const byId = new Map(current.map((item) => [item.id, item]));
    const reordered = requestedIds.map((id) => byId.get(id));
    const changedAt = now();
    reordered.forEach((attachment, position) => {
      attachment.position = position;
      attachment.updatedAt = changedAt;
    });
    let entryIndex = 0;
    index.attachments = index.attachments.map((attachment) =>
      attachmentMatchesEntry(attachment, ref) ? reordered[entryIndex++] : attachment
    );
    await saveIndex(index);
    if (reordered.some((attachment) => attachment.provider === "nextcloud")) {
      await writeRemoteIndex((await getConfig()).nextcloud, index);
    }
    return reordered;
  }

  function isPdfFile(file) {
    if (!file) return false;
    const nameLooksPdf = /\.pdf$/i.test(String(file.name || ""));
    const type = String(file.type || "").toLowerCase();
    const typeLooksPdf = type === "application/pdf" || type === "application/x-pdf" || type.endsWith("/pdf");
    return nameLooksPdf || typeLooksPdf;
  }

  async function addBrowser(entry, file, name) {
    if (!isPdfFile(file)) {
      throw new Error("Choose a PDF file.");
    }
    const ref = entryRef(entry), id = uuid();
    let storageBackend = "background";
    try {
      await storeBrowserBlob(id, file);
    } catch (_error) {
      // Compatibility fallback for environments in which binary extension
      // messages are unavailable. The parent PDF workspace can still read
      // this context-local copy and pass it to the viewer.
      await idbPut(id, file);
      storageBackend = "context";
    }
    const attachment = {
      id, entry: ref, name: String(name || file.name.replace(/\.pdf$/i, "")).trim() || "PDF",
      provider: "browser", storageBackend, fileName: sanitizeFileName(file.name),
      mimeType: file.type || "application/pdf", size: file.size,
      notes: "", createdAt: now(), updatedAt: now()
    };
    const index = await loadIndex(); index.attachments.push(attachment); await saveIndex(index);
    return attachment;
  }

  function stripPathQuotes(value) {
    const text = String(value || "").trim();
    if (text.length >= 2 && ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'")))) {
      return text.slice(1, -1).trim();
    }
    return text;
  }

  function encodePathParts(parts) {
    return parts.map((part) => encodeURIComponent(part)).join("/");
  }

  function normalizeLocalPath(value) {
    let text = stripPathQuotes(value);
    if (!text) throw new Error("Enter the full local PDF path.");

    if (/^file:\/\//i.test(text)) {
      try {
        const url = new URL(text);
        if (url.protocol !== "file:") throw new Error();
        return url.href;
      } catch (_error) {
        throw new Error("The local file URL is invalid.");
      }
    }

    // Keep legacy remote links usable, although this dialog is intended for local paths.
    if (/^https?:\/\//i.test(text)) return text;

    text = text.replace(/\\/g, "/");

    // Windows UNC path: \\server\share\folder\paper.pdf
    if (/^\/\//.test(text)) {
      const pieces = text.replace(/^\/+/, "").split("/").filter(Boolean);
      const host = pieces.shift();
      if (!host || !pieces.length) throw new Error("Enter a complete UNC path including the PDF filename.");
      return `file://${host}/${encodePathParts(pieces)}`;
    }

    // Windows drive path: C:\\Users\\Name\\paper.pdf
    if (/^[A-Za-z]:\//.test(text)) {
      const drive = text.slice(0, 2);
      const rest = text.slice(3).split("/").filter(Boolean);
      if (!rest.length) throw new Error("Enter the complete path including the PDF filename.");
      return `file:///${drive}/${encodePathParts(rest)}`;
    }

    // Unix/macOS absolute path.
    if (text.startsWith("/")) {
      const parts = text.split("/").filter(Boolean);
      if (!parts.length) throw new Error("Enter the complete path including the PDF filename.");
      return `file:///${encodePathParts(parts)}`;
    }

    throw new Error("Enter an absolute path, for example C:\\Users\\Name\\Papers\\paper.pdf or /home/name/Papers/paper.pdf.");
  }

  function localFileName(value) {
    try {
      const url = new URL(value);
      const parts = url.pathname.split("/").filter(Boolean);
      return decodeURIComponent(parts.pop() || "local.pdf");
    } catch (_error) {
      return String(value || "").split(/[\\/]/).pop() || "local.pdf";
    }
  }

  async function isLocalFilePermissionGranted() {
    let fileSchemeAccess = null;
    const firefoxVersion = Number(/\bFirefox\/(\d+)/i.exec(globalThis.navigator?.userAgent || "")?.[1]) || 0;
    try {
      if (typeof api.extension?.isAllowedFileSchemeAccess === "function") {
        fileSchemeAccess = await api.extension.isAllowedFileSchemeAccess();
      }
    } catch (_error) {}
    if (fileSchemeAccess === false && (!firefoxVersion || firefoxVersion >= 153)) return false;
    let declaredAccess = fileSchemeAccess === true;
    try {
      if (api.permissions?.contains) {
        if (await api.permissions.contains({ origins: ["file:///*"] })) declaredAccess = true;
        // Firefox up to version 152 covers local files through the broad
        // “Access your data for all websites” permission rather than a
        // separate local-files switch.
        if (firefoxVersion && firefoxVersion < 153
          && await api.permissions.contains({ origins: ["<all_urls>"] })) declaredAccess = true;
      }
    } catch (_error) {}
    return declaredAccess;
  }

  async function ensureLocalFilePermission() {
    return isLocalFilePermissionGranted();
  }

  async function openLocalFilePermissionSettings() {
    return backgroundRequest({ type: "ctca-open-local-file-permission-settings" });
  }

  function normalizeWebUrl(value) {
    const url = new URL(String(value || "").trim());
    if (!/^https?:$/.test(url.protocol)) throw new Error("The webpage URL must use HTTP or HTTPS.");
    return url.href;
  }

  async function discoverWebPdfs(value, options = {}) {
    const url = normalizeWebUrl(value);
    if (!(await requestOriginPermission(url))) {
      throw new Error("Permission to inspect this webpage was not granted.");
    }
    const response = await backgroundRequest({
      type: "ctca-discover-web-pdfs",
      url,
      tabId: Number.isInteger(options.tabId) ? options.tabId : null,
      preserveTab: options.preserveTab === true
    });
    return {
      finalUrl: response.finalUrl || url,
      candidates: Array.isArray(response.candidates)
        ? response.candidates.slice(0, 4).map((candidate) => ({
            ...candidate,
            tabId: Number.isInteger(candidate.tabId)
              ? candidate.tabId
              : (Number.isInteger(response.tabId) ? response.tabId : null)
          }))
        : [],
      permissionRequired: response.permissionRequired === true,
      humanCheckRequired: response.humanCheckRequired === true,
      pageStillLoading: response.pageStillLoading === true,
      tabId: Number.isInteger(response.tabId) ? response.tabId : null
    };
  }

  async function showWebHumanCheck(tabId, url = "") {
    return backgroundRequest({ type: "ctca-show-web-human-check", tabId, url });
  }

  async function closeWebTab(tabId) {
    if (!Number.isInteger(tabId)) return false;
    try {
      await backgroundRequest({ type: "ctca-close-web-tab", tabId });
      return true;
    } catch (_error) {
      return false;
    }
  }

  async function downloadWebPdf(value, sourceValue = "", tabId = null) {
    const url = normalizeWebUrl(value);
    if (!(await requestOriginPermission(url))) {
      throw new Error("Permission to download this PDF was not granted.");
    }
    const sourceUrl = sourceValue ? normalizeWebUrl(sourceValue) : url;
    const response = await backgroundRequest({
      type: "ctca-download-web-pdf",
      url,
      sourceUrl,
      tabId: Number.isInteger(tabId) ? tabId : null
    });
    const expectedLength = Number(response.byteLength) || 0;
    const bytes = new Uint8Array(expectedLength);
    let offset = 0;
    try {
      while (offset < expectedLength) {
        const chunkResponse = await backgroundRequest({
          type: "ctca-read-web-pdf-chunk",
          downloadId: response.downloadId,
          offset,
          length: Math.min(512 * 1024, expectedLength - offset)
        });
        const chunk = base64ToUint8Array(chunkResponse.bodyBase64 || "");
        if (!chunk.byteLength) throw new Error("The downloaded PDF data was not transferred completely.");
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
      }
    } finally {
      if (response.downloadId) {
        backgroundRequest({ type: "ctca-release-web-pdf-download", downloadId: response.downloadId }).catch(() => {});
      }
    }
    if (!bytes.byteLength || offset !== expectedLength) {
      throw new Error("The downloaded PDF data was not transferred completely.");
    }
    const fileName = String(response.fileName || "document.pdf").replace(/[\\/:*?"<>|]+/g, "_");
    return new File([bytes], fileName, { type: response.mimeType || "application/pdf" });
  }

  async function addLocalLink(entry, url, name) {
    const originalPath = stripPathQuotes(url);
    const value = normalizeLocalPath(originalPath);
    const fileName = localFileName(value);
    if (!/\.pdf$/i.test(fileName)) throw new Error("The local path must point to a PDF file.");
    const attachment = {
      id: uuid(), entry: entryRef(entry), name: String(name || fileName.replace(/\.pdf$/i, "")).trim() || "Local PDF",
      provider: "local", localUrl: value, localPath: originalPath, fileName,
      mimeType: "application/pdf", size: 0, notes: "", createdAt: now(), updatedAt: now()
    };
    const index = await loadIndex(); index.attachments.push(attachment); await saveIndex(index);
    return attachment;
  }
  async function addLocalSession(entry, file, name) {
    if (!isPdfFile(file)) {
      throw new Error("Choose a PDF file.");
    }
    const id = uuid();
    sessionLocalFiles.set(id, file);
    const bytes = await file.arrayBuffer();
    await backgroundRequest({
      type: "ctca-pdf-store-session",
      id,
      mimeType: file.type || "application/pdf",
      bytes
    });
    const attachment = {
      id,
      entry: entryRef(entry),
      name: String(name || file.name.replace(/\.pdf$/i, "")).trim() || "Local PDF",
      provider: "local",
      sessionOnly: true,
      fileName: sanitizeFileName(file.name),
      mimeType: file.type || "application/pdf",
      size: file.size,
      notes: "",
      createdAt: now(),
      updatedAt: now()
    };
    const index = await loadIndex();
    index.attachments.push(attachment);
    await saveIndex(index);
    return attachment;
  }

  async function addLocalHandle(entry, handle, name) {
    if (!handle || typeof handle.getFile !== "function") throw new Error("This browser did not provide a persistent local-file handle.");
    let permission = "granted";
    if (typeof handle.queryPermission === "function") permission = await handle.queryPermission({ mode: "read" });
    if (permission !== "granted" && typeof handle.requestPermission === "function") permission = await handle.requestPermission({ mode: "read" });
    if (permission !== "granted") throw new Error("Permission to read the local PDF was not granted.");
    const file = await handle.getFile();
    if (!isPdfFile(file)) throw new Error("Choose a PDF file.");
    const id = uuid();
    await idbHandlePut(id, handle);
    const attachment = {
      id, entry: entryRef(entry), name: String(name || file.name.replace(/\.pdf$/i, "")).trim() || "Local PDF",
      provider: "local", localHandle: true, fileName: sanitizeFileName(file.name), mimeType: "application/pdf", size: file.size,
      notes: "", createdAt: now(), updatedAt: now()
    };
    const index = await loadIndex(); index.attachments.push(attachment); await saveIndex(index);
    return attachment;
  }

  async function addNextcloud(entry, file, name) {
    if (!isPdfFile(file)) throw new Error("Choose a PDF file.");
    const config = await getConfig(); const nc = config.nextcloud;
    if (!nc?.server || !nc?.appPassword) throw new Error("Connect a Nextcloud account first.");
    await ensureNextcloudFolders(nc);
    const id = uuid(), safe = sanitizeFileName(file.name), remotePath = `files/${id}-${safe}`;
    const response = await davFetch(nc, remotePath, { method: "PUT", headers: { "Content-Type": "application/pdf" }, body: file });
    if (!response.ok) throw new Error(`PDF upload failed (${response.status}).`);
    const attachment = {
      id, entry: entryRef(entry), name: String(name || safe.replace(/\.pdf$/i, "")).trim() || "PDF",
      provider: "nextcloud", remotePath, fileName: safe, mimeType: "application/pdf", size: file.size,
      notes: "", createdAt: now(), updatedAt: now()
    };
    const index = await loadIndex(); index.attachments.push(attachment); await saveIndex(index);
    await uploadSidecar(nc, attachment); await writeRemoteIndex(nc, index);
    return attachment;
  }

  async function getBlob(attachment) {
    if (attachment.provider === "browser") {
      try {
        const central = await getBackgroundBlob("ctca-pdf-get-browser", attachment.id);
        if (central) return central;
      } catch (_error) {}
      const local = await idbGet(attachment.id);
      if (local) {
        // Migrate older context-local files to the extension-wide store so
        // standalone and ColLabTeX PDF tabs can both open them.
        storeBrowserBlob(attachment.id, local).catch(() => {});
        return local;
      }
      return null;
    }
    if (attachment.provider === "nextcloud") {
      const nc = (await getConfig()).nextcloud;
      const response = await davFetch(nc, attachment.remotePath);
      if (!response.ok) throw new Error(`Could not download PDF (${response.status}).`);
      return response.blob();
    }
    if (attachment.provider === "local" && attachment.sessionOnly) {
      const localSessionBlob = sessionLocalFiles.get(attachment.id);
      if (localSessionBlob) return localSessionBlob;
      const blob = await getBackgroundBlob("ctca-pdf-get-session", attachment.id).catch(() => null);
      if (!blob) {
        throw new Error("This temporary local-file link is no longer available. Reattach the PDF to use it in this browser session.");
      }
      return blob;
    }
    if (attachment.provider === "local" && attachment.localHandle) {
      const handle = await idbHandleGet(attachment.id);
      if (!handle) throw new Error("The local-file handle is no longer available. Reattach the PDF.");
      let permission = typeof handle.queryPermission === "function" ? await handle.queryPermission({ mode: "read" }) : "granted";
      if (permission !== "granted" && typeof handle.requestPermission === "function") permission = await handle.requestPermission({ mode: "read" });
      if (permission !== "granted") throw new Error("Permission to read the local PDF was not granted.");
      return handle.getFile();
    }
    if (attachment.provider === "local" && attachment.localUrl) {
      const localUrl = String(attachment.localUrl);
      if (/^file:/i.test(localUrl)) {
        const permitted = await ensureLocalFilePermission().catch(() => false);
        if (!permitted) {
          throw new Error("Access to local file URLs was not granted. Enable local-file access for this extension in the browser's extension settings, then open the PDF again.");
        }
      }
      try {
        if (/^file:/i.test(localUrl)) {
          const response = await backgroundRequest({ type: "ctca-pdf-get-local-url", url: localUrl });
          if (!response.found || !response.bytes) throw new Error("The linked PDF could not be read.");
          return new Blob([response.bytes], { type: response.mimeType || "application/pdf" });
        }
        const response = await fetch(localUrl, { cache: "no-store" });
        if (!response.ok && response.status !== 0) throw new Error(`Could not read linked PDF (${response.status}).`);
        const blob = await response.blob();
        if (!blob.size) throw new Error("The linked PDF is empty or could not be read.");
        return blob;
      } catch (error) {
        if (/^file:/i.test(localUrl)) {
          throw new Error(`Could not load the local PDF from ${attachment.localPath || localUrl}. Check that the file still exists and that local-file access is enabled for the extension. ${error?.message || ""}`.trim());
        }
        throw error;
      }
    }
    return null;
  }

  async function update(id, patch) {
    const index = await loadIndex();
    const attachment = index.attachments.find((item) => item.id === id);
    if (!attachment) throw new Error("Attachment not found.");
    Object.assign(attachment, patch, { updatedAt: now() });
    await saveIndex(index);
    if (attachment.provider === "nextcloud") {
      const nc = (await getConfig()).nextcloud;
      await uploadSidecar(nc, attachment); await writeRemoteIndex(nc, index);
    }
    return attachment;
  }

  async function replaceFile(id, file) {
    if (!isPdfFile(file)) throw new Error("Choose a PDF file.");
    const index = await loadIndex(); const attachment = index.attachments.find((item) => item.id === id);
    if (!attachment) throw new Error("Attachment not found.");
    if (attachment.provider === "browser") {
      try {
        await storeBrowserBlob(id, file);
        attachment.storageBackend = "background";
      } catch (_error) {
        await idbPut(id, file);
        attachment.storageBackend = "context";
      }
    }
    else if (attachment.provider === "nextcloud") {
      const nc = (await getConfig()).nextcloud;
      const response = await davFetch(nc, attachment.remotePath, { method: "PUT", headers: { "Content-Type": "application/pdf" }, body: file });
      if (!response.ok) throw new Error(`PDF replacement failed (${response.status}).`);
    } else if (attachment.provider === "local") {
      // Browser extensions cannot safely overwrite an arbitrary path-only local
      // link. Preserve the edited PDF by converting this attachment to durable
      // browser storage while retaining the former path as provenance metadata.
      try {
        await storeBrowserBlob(id, file);
        attachment.storageBackend = "background";
      } catch (_error) {
        await idbPut(id, file);
        attachment.storageBackend = "context";
      }
      attachment.sourceLocalPath = attachment.localPath || attachment.localUrl || attachment.sourceLocalPath || "";
      if (attachment.sessionOnly) {
        sessionLocalFiles.delete(id);
        await backgroundRequest({ type: "ctca-pdf-delete-session", id }).catch(() => {});
      }
      if (attachment.localHandle) await idbHandleDelete(id).catch(() => {});
      attachment.provider = "browser";
      delete attachment.localUrl;
      delete attachment.localPath;
      delete attachment.localHandle;
      delete attachment.sessionOnly;
    } else {
      throw new Error("This PDF storage provider cannot be updated.");
    }
    attachment.fileName = sanitizeFileName(file.name); attachment.size = file.size; attachment.updatedAt = now();
    await saveIndex(index);
    if (attachment.provider === "nextcloud") await writeRemoteIndex((await getConfig()).nextcloud, index);
    return attachment;
  }

  async function deleteNextcloudResource(nc, relativePath, label) {
    if (!relativePath) throw new Error(`The ${label} path is missing from the attachment record.`);
    const response = await davFetch(nc, relativePath, { method: "DELETE" });
    if (!response.ok && response.status !== 404) {
      throw new Error(`Could not delete the ${label} from Nextcloud (${response.status}).`);
    }
  }

  async function deleteAttachmentStorage(attachment) {
    if (attachment.provider === "browser") {
      const deletions = await Promise.allSettled([
        backgroundRequest({ type: "ctca-pdf-delete-browser", id: attachment.id }),
        idbDelete(attachment.id)
      ]);
      const failure = deletions.find((result) => result.status === "rejected");
      if (failure) {
        throw new Error(`Could not delete the PDF from browser storage: ${failure.reason?.message || String(failure.reason)}`);
      }
    }
    if (attachment.provider === "local" && attachment.sessionOnly) {
      sessionLocalFiles.delete(attachment.id);
      await backgroundRequest({ type: "ctca-pdf-delete-session", id: attachment.id });
    }
    if (attachment.provider === "local" && attachment.localHandle) await idbHandleDelete(attachment.id);
    if (attachment.provider === "nextcloud") {
      const nc = (await getConfig()).nextcloud;
      await Promise.all([
        deleteNextcloudResource(nc, attachment.remotePath, "PDF"),
        deleteNextcloudResource(nc, `annotations/${attachment.id}.json`, "PDF annotation sidecar")
      ]);
    }
  }

  async function remove(id) {
    const index = await loadIndex();
    const attachment = index.attachments.find((item) => item.id === id);
    if (!attachment) return false;

    await deleteAttachmentStorage(attachment);
    index.attachments = index.attachments.filter((item) => item.id !== id);
    if (attachment.provider === "nextcloud") {
      await writeRemoteIndex((await getConfig()).nextcloud, index);
    }
    await saveIndex(index);
    return true;
  }

  async function removeForEntries(entriesInput) {
    const refs = (Array.isArray(entriesInput) ? entriesInput : [entriesInput])
      .filter(Boolean)
      .map(entryRef);
    if (!refs.length) return { removed: 0 };

    const index = await loadIndex();
    const attachmentIds = index.attachments
      .filter((attachment) => refs.some((ref) => attachmentMatchesEntry(attachment, ref)))
      .map((attachment) => attachment.id);
    let removed = 0;
    for (const id of attachmentIds) {
      if (await remove(id)) removed += 1;
    }
    return { removed };
  }

  async function syncNextcloud() {
    const config = await getConfig(), nc = config.nextcloud;
    if (!nc?.server || !nc?.appPassword) throw new Error("Connect a Nextcloud account first.");
    const [local, remote] = await Promise.all([loadIndex(), remoteIndex(nc)]);
    const remoteMap = new Map((remote.attachments || []).map((item) => [item.id, item]));
    const nextcloud = [];
    for (const [id, remoteItem] of remoteMap) {
      const localItem = local.attachments.find((item) => item.id === id && item.provider === "nextcloud");
      nextcloud.push(localItem && String(localItem.updatedAt || "") > String(remoteItem.updatedAt || "") ? localItem : remoteItem);
    }
    local.attachments = [
      ...local.attachments.filter((item) => item.provider !== "nextcloud"),
      ...nextcloud
    ];
    await saveIndex(local);
    await writeRemoteIndex(nc, local);
    return local;
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

  function normalizeDeletionTombstones(value) {
    const byIdentity = new Map();
    for (const item of Array.isArray(value) ? value : []) {
      const identity = String(item?.identity || "").trim().toLowerCase();
      if (!identity || (!identity.startsWith("doi:") && !identity.startsWith("key:"))) continue;
      const candidate = {
        identity,
        doi: String(item?.doi || ""),
        key: String(item?.key || ""),
        title: String(item?.title || ""),
        deletedAt: String(item?.deletedAt || now()),
        source: "global"
      };
      const previous = byIdentity.get(identity);
      if (!previous || candidate.deletedAt > previous.deletedAt) byIdentity.set(identity, candidate);
    }
    return [...byIdentity.values()];
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
    return { version: 1, revision: Math.max(0, Number(source.revision) || 0), documents };
  }

  function markAllDocumentsPending(documentSync, changeCount = 1, changedEntryIdentities = []) {
    const sync = normalizeDocumentSyncState(documentSync);
    const nowValue = now();
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
      flag.updatedAt = nowValue;
    }
    return sync;
  }

  function databaseContentString(databaseInput) {
    const database = normalizeDatabase(databaseInput);
    return stableString({
      entries: database.entries.map(comparableEntry).sort(),
      categories: database.categories,
      memberships: database.memberships,
      deletedEntries: database.deletedEntries
        .map((item) => String(item?.identity || "").toLowerCase())
        .filter(Boolean)
        .sort()
    });
  }

  function changedDatabaseEntryIdentities(previousInput, nextInput) {
    const previous = normalizeDatabase(previousInput);
    const next = normalizeDatabase(nextInput);
    const previousByIdentity = new Map(previous.entries.map((entry) => [databaseEntryIdentity(entry), comparableEntry(entry)]));
    const nextByIdentity = new Map(next.entries.map((entry) => [databaseEntryIdentity(entry), comparableEntry(entry)]));
    const identities = new Set([...previousByIdentity.keys(), ...nextByIdentity.keys()]);
    return [...identities].filter((identity) => previousByIdentity.get(identity) !== nextByIdentity.get(identity));
  }

  function normalizeDatabase(database) {
    const value = database && typeof database === "object" ? database : {};
    const entries = Array.isArray(value.entries) ? value.entries.map((entry) => ({
      key: String(entry?.key || "Reference"),
      type: String(entry?.type || "misc"),
      fields: { ...(entry?.fields || {}) },
      aliases: [...new Set(entry?.aliases || [])],
      tags: [...new Set(entry?.tags || [])],
      updatedAt: String(entry?.updatedAt || ""),
      doiSyncedAt: String(entry?.doiSyncedAt || ""),
      addedOn: String(entry?.addedOn || entry?.createdAt || entry?.updatedAt || ""),
      starred: entry?.starred === true
    })) : [];
    const presentIdentities = new Set(entries.map(databaseDeletionIdentity));
    return {
      version: 3,
      entries,
      categories: Array.isArray(value.categories) ? value.categories.map((category) => ({ ...category })) : [],
      memberships: value.memberships && typeof value.memberships === "object"
        ? Object.fromEntries(Object.entries(value.memberships).map(([key, ids]) => [key, [...new Set(Array.isArray(ids) ? ids : [])]]))
        : {},
      deletedEntries: normalizeDeletionTombstones(value.deletedEntries)
        .filter((item) => !presentIdentities.has(item.identity)),
      documentSync: normalizeDocumentSyncState(value.documentSync),
      updatedAt: String(value.updatedAt || "")
    };
  }

  function databaseEntryIdentity(entry) {
    // Keep each BibTeX citation-key record distinct during synchronization.
    return `key:${String(entry?.key || "").trim().toLowerCase()}`;
  }

  function databaseDeletionIdentity(entry) {
    const doi = normalizeDoi(entry?.fields?.doi || "");
    return doi ? `doi:${doi}` : databaseEntryIdentity(entry);
  }

  function normalizeComparableText(value) {
    return stripBibValue(value)
      .replace(/\r\n?/g, "\n")
      .replace(/[\t ]+/g, " ")
      .replace(/ *\n */g, "\n")
      .trim();
  }

  function comparableEntry(entry) {
    if (!entry) return null;

    // Compare bibliography content rather than synchronization metadata or
    // serialization details. This prevents an existing Nextcloud backup from
    // producing one conflict per entry merely because field order, array order,
    // DOI spelling, or local timestamps differ.
    const fields = {};
    for (const [rawName, rawValue] of Object.entries(entry.fields || {})) {
      const name = String(rawName || "").trim().toLowerCase();
      if (!name || name === "ids" || name.startsWith("ctca_")) continue;
      let value = normalizeComparableText(rawValue);
      if (name === "doi") value = normalizeDoi(value);
      fields[name] = value;
    }

    const normalizedSet = (values, { lower = false } = {}) => [...new Set(
      (Array.isArray(values) ? values : [])
        .map((value) => normalizeComparableText(value))
        .filter(Boolean)
        .map((value) => lower ? value.toLowerCase() : value)
    )].sort((left, right) => left.localeCompare(right));

    return stableString({
      key: normalizeComparableText(entry.key).toLowerCase(),
      type: normalizeComparableText(entry.type || "misc").toLowerCase(),
      fields,
      aliases: normalizedSet(entry.aliases, { lower: true }),
      tags: normalizedSet(entry.tags, { lower: true }),
      addedOn: normalizeComparableText(entry.addedOn),
      starred: entry.starred === true
    });
  }

  function categoryState(database) {
    return { categories: database.categories || [], memberships: database.memberships || {} };
  }

  function mergeCategoryState(local, remote, base) {
    const localState = categoryState(local), remoteState = categoryState(remote), baseState = categoryState(base || {});
    const localChanged = stableString(localState) !== stableString(baseState);
    const remoteChanged = stableString(remoteState) !== stableString(baseState);
    if (localChanged && !remoteChanged) return localState;
    if (remoteChanged && !localChanged) return remoteState;
    if (!localChanged && !remoteChanged) return localState;

    const categories = new Map();
    for (const category of remoteState.categories || []) categories.set(category.id, { ...category });
    for (const category of localState.categories || []) categories.set(category.id, { ...category });
    const memberships = {};
    for (const source of [remoteState.memberships || {}, localState.memberships || {}]) {
      for (const [key, ids] of Object.entries(source)) memberships[key] = [...new Set([...(memberships[key] || []), ...(ids || [])])];
    }
    return { categories: [...categories.values()], memberships };
  }

  function mergeBibliographyDatabases(localInput, remoteInput, baseInput) {
    const local = normalizeDatabase(localInput), remote = normalizeDatabase(remoteInput), base = normalizeDatabase(baseInput);
    const maps = [local, remote, base].map((database) => new Map(database.entries.map((entry) => [databaseEntryIdentity(entry), entry])));
    const [localMap, remoteMap, baseMap] = maps;
    const localDeleted = new Map(local.deletedEntries.map((item) => [item.identity, item]));
    const remoteDeleted = new Map(remote.deletedEntries.map((item) => [item.identity, item]));
    const baseDeleted = new Map(base.deletedEntries.map((item) => [item.identity, item]));
    const identities = new Set([...localMap.keys(), ...remoteMap.keys(), ...baseMap.keys()]);
    const entries = [];
    const deletedEntries = [];
    const conflicts = [];

    for (const identity of identities) {
      const localEntry = localMap.get(identity) || null;
      const remoteEntry = remoteMap.get(identity) || null;
      const baseEntry = baseMap.get(identity) || null;
      const deletionIdentity = databaseDeletionIdentity(localEntry || remoteEntry || baseEntry);
      const localTombstone = localDeleted.get(deletionIdentity) || null;
      const remoteTombstone = remoteDeleted.get(deletionIdentity) || null;
      const localValue = comparableEntry(localEntry), remoteValue = comparableEntry(remoteEntry), baseValue = comparableEntry(baseEntry);

      if (localEntry && remoteEntry) {
        if (localValue === remoteValue) entries.push(localEntry);
        else if (localValue === baseValue) entries.push(remoteEntry);
        else if (remoteValue === baseValue) entries.push(localEntry);
        else if (!baseEntry) {
          conflicts.push({ identity, deletionIdentity, reason: "Added differently in the browser and Nextcloud", local: localEntry, remote: remoteEntry, base: null });
        } else {
          conflicts.push({ identity, deletionIdentity, reason: "Changed differently in the browser and Nextcloud", local: localEntry, remote: remoteEntry, base: baseEntry });
        }
        continue;
      }

      if (localEntry) {
        if (remoteTombstone && baseEntry) {
          conflicts.push({ identity, deletionIdentity, reason: "Deleted in Nextcloud but present in the browser", local: localEntry, remote: null, base: baseEntry, remoteTombstone });
        } else {
          // Mere absence in Nextcloud is not deletion.
          entries.push(localEntry);
        }
        continue;
      }

      if (remoteEntry) {
        if (localTombstone && baseEntry) {
          conflicts.push({ identity, deletionIdentity, reason: "Deleted in the browser but present in Nextcloud", local: null, remote: remoteEntry, base: baseEntry, localTombstone });
        } else {
          // Mere absence in the browser is not deletion.
          entries.push(remoteEntry);
        }
        continue;
      }

      const tombstone = [localTombstone, remoteTombstone, localDeleted.get(databaseDeletionIdentity(baseEntry)), remoteDeleted.get(databaseDeletionIdentity(baseEntry))]
        .filter(Boolean)
        .sort((left, right) => String(right.deletedAt).localeCompare(String(left.deletedAt)))[0];
      if (tombstone) deletedEntries.push(tombstone);
    }

    // A final semantic equality pass protects against false conflicts from
    // legacy database snapshots produced by older extension versions. Entries
    // that normalize to the same bibliography content are retained directly.
    const realConflicts = [];
    for (const conflict of conflicts) {
      if (conflict.local && conflict.remote && comparableEntry(conflict.local) === comparableEntry(conflict.remote)) {
        entries.push(conflict.local);
      } else {
        realConflicts.push(conflict);
      }
    }

    // Preserve explicit tombstones that no longer have a live entry on either
    // side. They are keyed by DOI, or by citation key when no DOI exists.
    const liveDeletionIdentities = new Set(entries.map(databaseDeletionIdentity));
    for (const tombstone of [...localDeleted.values(), ...remoteDeleted.values(), ...baseDeleted.values()]) {
      if (!liveDeletionIdentities.has(tombstone.identity)) deletedEntries.push(tombstone);
    }

    const categories = mergeCategoryState(local, remote, base);
    return {
      merged: {
        version: 3,
        entries,
        categories: categories.categories,
        memberships: categories.memberships,
        deletedEntries: normalizeDeletionTombstones(deletedEntries),
        documentSync: normalizeDocumentSyncState(local.documentSync),
        updatedAt: [local.updatedAt, remote.updatedAt, base.updatedAt].filter(Boolean).sort().at(-1) || now()
      },
      conflicts: realConflicts,
      local,
      remote,
      base
    };
  }

  function bibEscape(value) {
    return String(value ?? "").replace(/\r?\n/g, " ").trim();
  }

  function databaseToBib(databaseInput) {
    const database = normalizeDatabase(databaseInput);
    const memberships = database.memberships || {};
    const categoryTree = database.categories.length
      ? btoa(unescape(encodeURIComponent(JSON.stringify({ version: 1, categories: database.categories, updatedAt: database.updatedAt }))))
      : "";
    const entryText = database.entries.map((entry, index) => {
      const fields = { ...(entry.fields || {}) };
      if ((entry.aliases || []).length) fields.ids = [...new Set(entry.aliases)].join(", ");
      if ((entry.tags || []).length) fields.ctca_tags = [...new Set(entry.tags)].join(",");
      if ((memberships[entry.key] || []).length) fields.ctca_categories = memberships[entry.key].join(",");
      if (index === 0 && categoryTree) fields.ctca_category_tree = categoryTree;
      if (entry.doiSyncedAt) fields.ctca_doi_synced = entry.doiSyncedAt;
      if (entry.addedOn) fields.ctca_added_on = entry.addedOn;
      if (entry.starred) fields.ctca_starred = "true";
      const body = Object.entries(fields)
        .filter(([, value]) => value !== undefined && value !== null && String(value).trim() !== "")
        .map(([name, value]) => `  ${name} = {${bibEscape(value)}}`)
        .join(",\n");
      return `@${entry.type || "misc"}{${entry.key},\n${body}\n}`;
    }).join("\n\n");

    const deletionText = database.deletedEntries.length
      ? `@comment{${DELETION_COMMENT_PREFIX}${btoa(unescape(encodeURIComponent(JSON.stringify({ version: 1, deletedEntries: database.deletedEntries }))))}}`
      : "";
    return [entryText, deletionText].filter(Boolean).join("\n\n") + (entryText || deletionText ? "\n" : "");
  }

  function stripBibValue(value) {
    let text = String(value ?? "").trim();
    for (let depth = 0; depth < 6 && text.length >= 2; depth += 1) {
      const braced = text.startsWith("{") && text.endsWith("}");
      const quoted = text.startsWith('"') && text.endsWith('"');
      if (!braced && !quoted) break;
      text = text.slice(1, -1).trim();
    }
    return text;
  }

  function decodeBibMetadata(value) {
    try {
      const raw = stripBibValue(value).replace(/-/g, "+").replace(/_/g, "/");
      const padded = raw + "=".repeat((4 - raw.length % 4) % 4);
      const binary = atob(padded);
      const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
      return new TextDecoder().decode(bytes);
    } catch (_error) {
      return "";
    }
  }

  function splitMetadataList(value) {
    return [...new Set(stripBibValue(value).split(/[;,]/).map((item) => item.trim()).filter(Boolean))];
  }

  function bibToDatabase(text) {
    const parser = globalThis.CollabTeXBibTeX?.parseBibTeX;
    if (typeof parser !== "function") {
      throw new Error("The bundled BibTeX parser is not available.");
    }
    const sourceText = String(text || "");
    const deletionMatch = sourceText.match(/@comment\s*[({]\s*ctca_deleted_entries:([A-Za-z0-9+/_=-]+)\s*[)}]/i);
    let deletedEntries = [];
    if (deletionMatch?.[1]) {
      try {
        const decoded = JSON.parse(decodeBibMetadata(deletionMatch[1]));
        deletedEntries = normalizeDeletionTombstones(decoded?.deletedEntries);
      } catch (_error) {}
    }
    const records = parser(sourceText, REMOTE_BIB_FILE);
    const memberships = {};
    const entries = [];
    const treeCandidates = [];
    const internalFields = new Set([
      "ctca_meta_version", "ctca_doi_synced", "ctca_tags",
      "ctca_categories", "ctca_category_tree", "ctca_added_on", "ctca_starred"
    ]);

    for (const record of records) {
      const rawFields = record.fields || {};
      const fields = {};
      for (const [name, value] of Object.entries(rawFields)) {
        if (internalFields.has(name) || name === "ids") continue;
        fields[name] = stripBibValue(value);
      }
      const aliases = splitMetadataList(rawFields.ids || "");
      const tags = splitMetadataList(rawFields.ctca_tags || "");
      const categoryIds = splitMetadataList(rawFields.ctca_categories || "");
      if (categoryIds.length) memberships[record.key] = categoryIds;

      const encodedTree = stripBibValue(rawFields.ctca_category_tree || "");
      if (encodedTree) {
        try {
          const decoded = JSON.parse(decodeBibMetadata(encodedTree));
          if (decoded && Array.isArray(decoded.categories)) treeCandidates.push(decoded);
        } catch (_error) {}
      }

      entries.push({
        key: String(record.key || "Reference"),
        type: String(record.type || "misc"),
        fields,
        aliases,
        tags,
        updatedAt: "",
        doiSyncedAt: stripBibValue(rawFields.ctca_doi_synced || ""),
        addedOn: stripBibValue(rawFields.ctca_added_on || ""),
        starred: /^(?:true|1|yes|starred)$/i.test(stripBibValue(rawFields.ctca_starred || ""))
      });
    }

    treeCandidates.sort((left, right) => String(right?.updatedAt || "").localeCompare(String(left?.updatedAt || "")));
    const tree = treeCandidates[0] || {};
    return normalizeDatabase({
      version: 3,
      entries,
      categories: Array.isArray(tree.categories) ? tree.categories : [],
      memberships,
      deletedEntries,
      updatedAt: String(tree.updatedAt || "")
    });
  }

  async function readRemoteBibliography(nc) {
    const response = await davFetch(nc, REMOTE_BIB_FILE);
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(`Could not read the Nextcloud BibTeX file (${response.status}).`);
    return bibToDatabase(await response.text());
  }

  async function writeRemoteBibliography(nc, database) {
    const normalized = normalizeDatabase(database);
    const bibResponse = await davFetch(nc, REMOTE_BIB_FILE, {
      method: "PUT",
      headers: { "Content-Type": "application/x-bibtex; charset=utf-8" },
      body: databaseToBib(normalized)
    });
    if (!bibResponse.ok) throw new Error(`Could not upload the Nextcloud BibTeX file (${bibResponse.status}).`);

    // Version 1.8.6 and later use the BibTeX file as the only remote
    // bibliography database. Remove the redundant legacy JSON copy when it
    // is encountered; a missing file is harmless.
    davFetch(nc, LEGACY_REMOTE_BIB_DATABASE, { method: "DELETE" }).catch(() => null);
  }

  async function saveSyncedDatabase(database, previousLocal, { remoteChanged = false } = {}) {
    const normalized = normalizeDatabase(database);
    const previous = normalizeDatabase(previousLocal);
    const liveEntryIdentities = new Set(normalized.entries.map(databaseEntryIdentity));
    const deletionIdentities = new Set(normalized.deletedEntries.map((item) => item.identity));
    const removedEntries = previous.entries.filter((entry) =>
      !liveEntryIdentities.has(databaseEntryIdentity(entry))
      && deletionIdentities.has(databaseDeletionIdentity(entry))
    );
    if (removedEntries.length) await removeForEntries(removedEntries);
    normalized.documentSync = normalizeDocumentSyncState(previous.documentSync);
    const remoteContentChanged = remoteChanged && databaseContentString(normalized) !== databaseContentString(previous);
    if (remoteContentChanged) {
      const changedEntryIdentities = changedDatabaseEntryIdentities(previous, normalized);
      normalized.documentSync = markAllDocumentsPending(
        normalized.documentSync,
        Math.max(1, changedEntryIdentities.length),
        changedEntryIdentities
      );
    }
    if (stableString(normalized) !== stableString(previous)) {
      await storageSet(GLOBAL_DATABASE_KEY, normalized);
    }
    const previousBase = normalizeDatabase(await storageGet(BIB_SYNC_BASE_KEY));
    const baseValue = { ...normalized, documentSync: normalizeDocumentSyncState(null) };
    if (databaseContentString(baseValue) !== databaseContentString(previousBase)) {
      await storageSet(BIB_SYNC_BASE_KEY, baseValue);
    }
    if (remoteContentChanged) {
      const existing = await storageGet(GLOBAL_PENDING_KEY);
      await storageSet(GLOBAL_PENDING_KEY, {
        version: 1,
        pending: true,
        source: "nextcloud",
        updatedAt: now(),
        backup: existing?.pending ? existing.backup : previous
      });
    }
    return normalized;
  }

  async function syncBibliographyNextcloud() {
    const config = await getConfig();
    const nc = config.nextcloud;
    if (!nc?.syncBibliography) return { status: "disabled" };
    if (!nc?.server || !nc?.appPassword) throw new Error("Connect a Nextcloud account first.");
    await ensureNextcloudFolders(nc);
    const local = normalizeDatabase(await storageGet(GLOBAL_DATABASE_KEY));
    const remote = await readRemoteBibliography(nc);
    const base = normalizeDatabase(await storageGet(BIB_SYNC_BASE_KEY));

    if (!remote) {
      await writeRemoteBibliography(nc, local);
      await storageSet(BIB_SYNC_BASE_KEY, { ...local, documentSync: normalizeDocumentSyncState(null) });
      return { status: "uploaded", database: local, conflicts: [] };
    }

    const result = mergeBibliographyDatabases(local, remote, base);
    if (result.conflicts.length) return { status: "conflict", ...result };
    const merged = await saveSyncedDatabase(result.merged, local, { remoteChanged: databaseContentString(remote) !== databaseContentString(base) });
    if (databaseContentString(merged) !== databaseContentString(remote)) {
      await writeRemoteBibliography(nc, merged);
    }
    return { status: "synchronized", database: merged, conflicts: [] };
  }

  async function deleteBibliographyEntriesNextcloud(entriesInput) {
    const config = await getConfig();
    const nc = config.nextcloud;
    if (!nc?.syncBibliography) return { status: "disabled", deleted: 0 };
    if (!nc?.server || !nc?.appPassword) throw new Error("Connect a Nextcloud account first.");

    const requestedEntries = Array.isArray(entriesInput) ? entriesInput : [];
    const requestedIdentities = new Set(
      requestedEntries
        .map(databaseEntryIdentity)
        .filter((identity) => identity !== "key:")
    );
    if (!requestedIdentities.size) return { status: "unchanged", deleted: 0 };

    await ensureNextcloudFolders(nc);
    const remote = await readRemoteBibliography(nc);
    if (!remote) return { status: "missing", deleted: 0 };

    const removedEntries = remote.entries.filter((entry) =>
      requestedIdentities.has(databaseEntryIdentity(entry))
    );
    if (!removedEntries.length) return { status: "unchanged", deleted: 0 };

    const removedKeys = new Set(
      removedEntries.map((entry) => String(entry.key || "").trim().toLowerCase())
    );
    const memberships = Object.fromEntries(
      Object.entries(remote.memberships || {})
        .filter(([key]) => !removedKeys.has(String(key || "").trim().toLowerCase()))
        .map(([key, categoryIds]) => [key, [...categoryIds]])
    );
    const local = normalizeDatabase(await storageGet(GLOBAL_DATABASE_KEY));
    const requestedTombstones = requestedEntries.map((entry) => ({
      identity: databaseDeletionIdentity(entry),
      doi: normalizeDoi(entry?.fields?.doi || ""),
      key: String(entry?.key || ""),
      title: stripBibValue(entry?.fields?.title || ""),
      deletedAt: now(),
      source: "global"
    }));
    const nextRemote = normalizeDatabase({
      ...remote,
      entries: remote.entries.filter((entry) =>
        !requestedIdentities.has(databaseEntryIdentity(entry))
      ),
      memberships,
      deletedEntries: [
        ...(remote.deletedEntries || []),
        ...(local.deletedEntries || []),
        ...requestedTombstones
      ],
      updatedAt: now()
    });
    await writeRemoteBibliography(nc, nextRemote);
    return { status: "deleted", deleted: removedEntries.length, database: nextRemote };
  }

  async function resolveBibliographyConflicts(syncResult, choices = {}) {
    const mergedEntries = [...(syncResult?.merged?.entries || [])];
    for (const conflict of syncResult?.conflicts || []) {
      const choice = choices[conflict.identity] === "remote" ? conflict.remote : conflict.local;
      if (choice) mergedEntries.push(choice);
    }
    const chosenDeletions = [...(syncResult?.merged?.deletedEntries || [])];
    for (const conflict of syncResult?.conflicts || []) {
      const useRemote = choices[conflict.identity] === "remote";
      const choice = useRemote ? conflict.remote : conflict.local;
      const tombstone = useRemote ? conflict.remoteTombstone : conflict.localTombstone;
      if (!choice && tombstone) chosenDeletions.push(tombstone);
    }
    const database = {
      ...(syncResult?.merged || {}),
      version: 3,
      entries: mergedEntries,
      deletedEntries: normalizeDeletionTombstones(chosenDeletions),
      updatedAt: now()
    };
    const config = await getConfig();
    const nc = config.nextcloud;
    const saved = await saveSyncedDatabase(database, syncResult.local, { remoteChanged: true });
    await writeRemoteBibliography(nc, saved);
    return saved;
  }


  function normalizeNextcloudPath(value) {
    return String(value || "")
      .replace(/\\/g, "/")
      .replace(/^\/+|\/+$/g, "")
      .split("/")
      .filter((part) => part && part !== ".")
      .reduce((parts, part) => {
        if (part === "..") parts.pop();
        else parts.push(part);
        return parts;
      }, [])
      .join("/");
  }

  function davRootUrl(nc, relativePath = "") {
    const normalized = normalizeNextcloudPath(relativePath);
    return normalized ? `${davBase(nc)}/${encodePath(normalized)}` : `${davBase(nc)}/`;
  }

  async function davRootFetch(nc, relativePath, options = {}) {
    const headers = headersToObject(options.headers);
    setHeader(headers, "Authorization", basicAuth(nc.loginName, nc.appPassword));
    return extensionFetch(davRootUrl(nc, relativePath), { ...options, headers });
  }

  function davElementText(root, localName) {
    const nodes = root?.getElementsByTagNameNS?.("*", localName);
    return nodes?.[0]?.textContent?.trim?.() || "";
  }

  function decodeDavRelativePath(nc, href) {
    const basePath = new URL(`${davBase(nc)}/`).pathname;
    const pathName = new URL(String(href || ""), nc.server).pathname;
    const encodedRelative = pathName.startsWith(basePath)
      ? pathName.slice(basePath.length)
      : pathName.replace(/^\/+/, "");
    return encodedRelative
      .split("/")
      .filter(Boolean)
      .map((part) => {
        try { return decodeURIComponent(part); } catch (_) { return part; }
      })
      .join("/");
  }

  function parseDavEntries(nc, xmlText) {
    const documentNode = new DOMParser().parseFromString(String(xmlText || ""), "application/xml");
    if (documentNode.querySelector("parsererror")) {
      throw new Error("Nextcloud returned an invalid WebDAV directory response.");
    }
    const responses = [...documentNode.getElementsByTagNameNS("DAV:", "response")];
    return responses.map((response) => {
      const href = davElementText(response, "href");
      const prop = response.getElementsByTagNameNS("DAV:", "prop")?.[0] || response;
      const resourceType = prop.getElementsByTagNameNS("DAV:", "resourcetype")?.[0];
      const isDirectory = Boolean(resourceType?.getElementsByTagNameNS("DAV:", "collection")?.length);
      const relativePath = normalizeNextcloudPath(decodeDavRelativePath(nc, href));
      const fallbackName = relativePath.split("/").pop() || "/";
      const sizeValue = Number(davElementText(prop, "getcontentlength"));
      return {
        path: relativePath,
        name: davElementText(prop, "displayname") || fallbackName,
        isDirectory,
        etag: davElementText(prop, "getetag"),
        fileId: davElementText(prop, "fileid"),
        size: Number.isFinite(sizeValue) ? sizeValue : 0,
        lastModified: davElementText(prop, "getlastmodified"),
        contentType: davElementText(prop, "getcontenttype") || (isDirectory ? "httpd/unix-directory" : "application/octet-stream")
      };
    });
  }

  async function propfindNextcloud(nc, relativePath = "", depth = 1) {
    const response = await davRootFetch(nc, relativePath, {
      method: "PROPFIND",
      headers: {
        Depth: String(depth),
        "Content-Type": "application/xml; charset=utf-8"
      },
      body: `<?xml version="1.0" encoding="utf-8"?>
        <d:propfind xmlns:d="DAV:" xmlns:oc="http://owncloud.org/ns">
          <d:prop>
            <d:displayname />
            <d:resourcetype />
            <d:getetag />
            <d:getcontentlength />
            <d:getlastmodified />
            <d:getcontenttype />
            <oc:fileid />
          </d:prop>
        </d:propfind>`
    });
    if (response.status === 404) throw new Error("The selected Nextcloud file or directory no longer exists.");
    if (response.status !== 207 && !response.ok) {
      throw new Error(`Could not read the Nextcloud directory (${response.status}).`);
    }
    return parseDavEntries(nc, await response.text());
  }

  async function connectedNextcloudConfig() {
    const config = await getConfig();
    const nc = config?.nextcloud || {};
    if (!nc.server || !nc.loginName || !nc.appPassword) {
      throw new Error("Connect Nextcloud in Smart Citations first.");
    }
    return nc;
  }

  async function listNextcloudDirectory(relativePath = "") {
    const nc = await connectedNextcloudConfig();
    const normalized = normalizeNextcloudPath(relativePath);
    const entries = await propfindNextcloud(nc, normalized, 1);
    return entries
      .filter((entry) => entry.path !== normalized)
      .sort((left, right) => {
        if (left.isDirectory !== right.isDirectory) return left.isDirectory ? -1 : 1;
        return left.name.localeCompare(right.name, undefined, { numeric: true, sensitivity: "base" });
      });
  }

  async function getNextcloudFileInfo(relativePath) {
    const nc = await connectedNextcloudConfig();
    const normalized = normalizeNextcloudPath(relativePath);
    const entries = await propfindNextcloud(nc, normalized, 0);
    const exact = entries.find((entry) => entry.path === normalized) || entries[0];
    if (!exact) throw new Error("Nextcloud did not return metadata for the selected file.");
    return exact;
  }

  async function downloadNextcloudFile(relativePath) {
    const nc = await connectedNextcloudConfig();
    const normalized = normalizeNextcloudPath(relativePath);
    const response = await davRootFetch(nc, normalized, { method: "GET" });
    if (response.status === 404) throw new Error("The selected Nextcloud file no longer exists.");
    if (!response.ok) throw new Error(`Could not download the Nextcloud file (${response.status}).`);
    const blob = await response.blob();
    return {
      blob,
      info: {
        path: normalized,
        name: normalized.split("/").pop() || "file",
        isDirectory: false,
        etag: response.headers.get("etag") || "",
        fileId: response.headers.get("oc-fileid") || "",
        size: blob.size,
        lastModified: response.headers.get("last-modified") || "",
        contentType: blob.type || response.headers.get("content-type") || "application/octet-stream"
      }
    };
  }

  globalThis.CollabTeXAttachmentStore = {
    INDEX_KEY, CONFIG_KEY, GLOBAL_DATABASE_KEY, entryRef, getConfig, saveConfig, checkNextcloudConnection, connectNextcloud, syncNextcloud,
    syncBibliographyNextcloud, deleteBibliographyEntriesNextcloud, resolveBibliographyConflicts, databaseToBib, bibToDatabase, isPdfFile,
    list, listMany, reorder, addBrowser, addLocalLink, addLocalSession, addLocalHandle, addNextcloud, getBlob, update, replaceFile, remove, removeForEntries,
    normalizeLocalPath, ensureLocalFilePermission, isLocalFilePermissionGranted, openLocalFilePermissionSettings,
    discoverWebPdfs, showWebHumanCheck, closeWebTab, downloadWebPdf,
    listNextcloudDirectory, getNextcloudFileInfo, downloadNextcloudFile, normalizeNextcloudPath
  };
})();
