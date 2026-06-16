(() => {
  "use strict";

  const extensionApi = globalThis.browser ?? globalThis.chrome;
  const DOI_PATTERN = /^10\.\d{4,9}\/\S+$/i;
  const activeDoiRequests = new Map();
  const PDF_DB_NAME = "ctca-pdf-attachments-v2";
  const PDF_STORE_NAME = "files";
  const sessionPdfFiles = new Map();

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

  function normalizeDoi(value) {
    return String(value ?? "")
      .trim()
      .replace(/^doi\s*:\s*/i, "")
      .replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, "")
      .replace(/[\s<>]+/g, "")
      .replace(/[),.;]+$/, "");
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


  async function nextcloudFetchResponse(message) {
    const url = new URL(String(message.url || ""));
    if (!/^https?:$/.test(url.protocol)) throw new Error("Only HTTP or HTTPS Nextcloud requests are allowed.");
    const headers = new Headers(message.headers || {});
    let body;
    if (message.bodyBytes) body = message.bodyBytes instanceof ArrayBuffer ? message.bodyBytes : new Uint8Array(message.bodyBytes);
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
    return {
      ok: true,
      status: response.status,
      statusText: response.statusText,
      headers: responseHeaders,
      bodyBytes: await response.arrayBuffer()
    };
  }

  extensionApi.runtime.onMessage.addListener((message, sender, sendResponse) => {
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

    if (message?.type === "ctca-request-local-file-permission") {
      Promise.resolve()
        .then(async () => {
          const isAllowed = async () => {
            try {
              if (typeof extensionApi.extension?.isAllowedFileSchemeAccess === "function") {
                if (await extensionApi.extension.isAllowedFileSchemeAccess()) return true;
              }
            } catch (_error) {}
            try {
              if (extensionApi.permissions?.contains) {
                if (await extensionApi.permissions.contains({ origins: ["file:///*"] })) return true;
                if (await extensionApi.permissions.contains({ origins: ["<all_urls>"] })) return true;
              }
            } catch (_error) {}
            return false;
          };
          if (await isAllowed()) return true;
          if (!extensionApi.permissions?.request) return false;
          for (const origins of [["file:///*"], ["<all_urls>"]]) {
            try {
              const granted = await extensionApi.permissions.request({ origins });
              if (granted && await isAllowed()) return true;
            } catch (_error) {}
          }
          return false;
        })
        .then((granted) => sendResponse({ ok: true, granted: granted === true }))
        .catch((error) => sendResponse({ ok: false, error: error?.message || String(error) }));
      return true;
    }

    if (message?.type === "ctca-pdf-get-local-url") {
      const url = String(message.url || "");
      if (!/^file:\/\//i.test(url)) {
        sendResponse({ ok: false, error: "Only file:// URLs can be loaded through the local-file bridge." });
        return false;
      }
      fetch(url, { cache: "no-store" })
        .then(async (response) => {
          if (!response.ok && response.status !== 0) {
            throw new Error(`Could not read linked PDF (${response.status}).`);
          }
          const blob = await response.blob();
          if (!blob.size) throw new Error("The linked PDF is empty or could not be read.");
          return pdfBlobResponse(blob);
        })
        .then(sendResponse)
        .catch((error) => sendResponse({ ok: false, error: error?.message || String(error) }));
      return true;
    }

    if (message?.type === "ctca-open-standalone-manager-entry") {
      const key = encodeURIComponent(String(message.key || ""));
      extensionApi.tabs.create({ url: `${extensionApi.runtime.getURL("manager.html")}#entry=${key}` })
        .then(() => sendResponse({ ok: true }))
        .catch((error) => sendResponse({ ok: false, error: error?.message || String(error) }));
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

  function isSupportedEditorUrl(url) {
    const value = String(url || "");
    return /^https:\/\/collabtex\./i.test(value) || /^https:\/\/(?:[^/]+\.)?overleaf\.com\//i.test(value);
  }

  async function openStandaloneManager() {
    await extensionApi.tabs.create({ url: extensionApi.runtime.getURL("manager.html") });
  }

  async function openManagerFromAction(clickedTab) {
    const activeEditorTab = clickedTab?.active && isSupportedEditorUrl(clickedTab.url)
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

  extensionApi.action?.onClicked?.addListener((tab) => {
    openManagerFromAction(tab).catch(() => openStandaloneManager());
  });
})();
