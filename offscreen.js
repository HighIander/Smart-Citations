/* SPDX-License-Identifier: CC-BY-NC-SA-4.0 */

(() => {
  "use strict";

  const extensionApi = globalThis.browser ?? globalThis.chrome;
  const PDF_DB_NAME = "ctca-pdf-attachments-v2";
  const PDF_STORE_NAME = "files";

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

  async function storeBlob(id, blob) {
    const db = await openPdfDb();
    try {
      await new Promise((resolve, reject) => {
        const transaction = db.transaction(PDF_STORE_NAME, "readwrite");
        transaction.objectStore(PDF_STORE_NAME).put(blob, String(id));
        transaction.oncomplete = resolve;
        transaction.onerror = () => reject(transaction.error);
        transaction.onabort = () => reject(transaction.error || new Error("Local PDF storage was aborted."));
      });
    } finally {
      db.close();
    }
  }

  function loadLocalBlob(url) {
    return new Promise((resolve, reject) => {
      const request = new XMLHttpRequest();
      request.open("GET", url, true);
      request.responseType = "blob";
      request.onload = () => {
        if (request.status !== 0 && (request.status < 200 || request.status >= 300)) {
          reject(new Error(`Local-file access returned ${request.status}.`));
          return;
        }
        if (!(request.response instanceof Blob)) {
          reject(new Error("Chrome did not return the downloaded file."));
          return;
        }
        resolve(request.response);
      };
      request.onerror = () => reject(new Error("Chrome blocked the downloaded local file."));
      request.send();
    });
  }

  extensionApi.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.target !== "ctca-offscreen" || message?.type !== "ctca-read-local-file") return false;
    Promise.resolve()
      .then(() => loadLocalBlob(String(message.url || "")))
      .then(async (blob) => {
        if (!blob.size) throw new Error("The downloaded local file is empty.");
        await storeBlob(message.storageId, blob);
        sendResponse({ ok: true, byteLength: blob.size, mimeType: blob.type || "" });
      })
      .catch((error) => sendResponse({ ok: false, error: error?.message || String(error) }));
    return true;
  });
})();
