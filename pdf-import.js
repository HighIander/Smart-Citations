/* SPDX-License-Identifier: CC-BY-NC-SA-4.0 */

(() => {
  "use strict";

  const extensionApi = globalThis.browser ?? globalThis.chrome;
  const DOI_PATTERN = /10\.\d{4,9}\/[-._;()/:A-Z0-9]+/ig;
  let pdfModulePromise = null;

  function normalizeDoi(value) {
    return String(value || "")
      .trim()
      .replace(/^doi\s*:\s*/i, "")
      .replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, "")
      .replace(/[\s<>]+/g, "")
      .replace(/[\])},.;:'"]+$/g, "")
      .toLowerCase();
  }

  function pdfFiles(value) {
    return [...(value || [])].filter((file) => globalThis.CollabTeXAttachmentStore?.isPdfFile(file));
  }

  function hasPdfFiles(dataTransfer) {
    if (!dataTransfer) return false;
    if (pdfFiles(dataTransfer.files).length) return true;
    return [...(dataTransfer.items || [])].some((item) => {
      if (item.kind !== "file") return false;
      const type = String(item.type || "").toLowerCase();
      return type === "application/pdf" || type === "application/x-pdf";
    });
  }

  function filesFromDataTransfer(dataTransfer) {
    return pdfFiles(dataTransfer?.files);
  }

  function findDoi(text) {
    const source = String(text || "");
    DOI_PATTERN.lastIndex = 0;
    for (const match of source.matchAll(DOI_PATTERN)) {
      const doi = normalizeDoi(match[0]);
      if (/^10\.\d{4,9}\/\S+$/i.test(doi)) return doi;
    }
    return "";
  }

  async function pdfModule() {
    if (!pdfModulePromise) {
      pdfModulePromise = import(extensionApi.runtime.getURL("pdfjs/pdf.mjs")).then((module) => {
        module.GlobalWorkerOptions.workerSrc = extensionApi.runtime.getURL("pdfjs/pdf.worker.mjs");
        return module;
      });
    }
    return pdfModulePromise;
  }

  async function extractDoi(file) {
    if (!globalThis.CollabTeXAttachmentStore?.isPdfFile(file)) {
      throw new Error("Choose a PDF file.");
    }
    const module = await pdfModule();
    const loadingTask = module.getDocument({ data: new Uint8Array(await file.arrayBuffer()) });
    let documentHandle = null;
    try {
      documentHandle = await loadingTask.promise;
      try {
        const metadata = await documentHandle.getMetadata();
        const metadataValues = [
          ...Object.values(metadata?.info || {}),
          ...Object.values(metadata?.metadata?.getAll?.() || {})
        ];
        const metadataDoi = findDoi(metadataValues.join(" "));
        if (metadataDoi) return metadataDoi;
      } catch (_error) {}

      for (let pageNumber = 1; pageNumber <= documentHandle.numPages; pageNumber += 1) {
        const page = await documentHandle.getPage(pageNumber);
        const content = await page.getTextContent();
        const parts = (content.items || []).map((item) => String(item?.str || "")).filter(Boolean);
        const doi = findDoi(parts.join(" ")) || findDoi(parts.join(""));
        page.cleanup();
        if (doi) return doi;
      }
      return "";
    } finally {
      try { await documentHandle?.destroy(); } catch (_error) {}
      try { await loadingTask.destroy(); } catch (_error) {}
    }
  }

  function createSelectionControls(container, options = {}) {
    let provider = options.provider || "browser";
    let items = pdfFiles(options.files).map((file) => ({ file, handle: null }));
    const wrapper = document.createElement("div");
    wrapper.className = "ctca-pdf-import-dialog";
    wrapper.innerHTML = `
      <div class="ctca-pdf-provider-choices" role="group" aria-label="PDF location">
        <button type="button" class="ctca-pdf-provider-choice" data-provider="nextcloud" aria-pressed="false">
          <span class="ctca-pdf-provider-icon">☁</span><span><strong>Nextcloud</strong><small>Upload and synchronize the PDF.</small></span>
        </button>
        <button type="button" class="ctca-pdf-provider-choice" data-provider="browser" aria-pressed="false">
          <span class="ctca-pdf-provider-icon">▣</span><span><strong>Cache</strong><small>Keep a persistent copy in this browser profile.</small></span>
        </button>
        <button type="button" class="ctca-pdf-provider-choice" data-provider="local" aria-pressed="false">
          <span class="ctca-pdf-provider-icon">↗</span><span><strong>Link</strong><small>Link to the selected file without uploading it.</small></span>
        </button>
      </div>
      <div class="ctca-pdf-import-dropzone" tabindex="0">
        <span>Drop PDF file(s) here or <button type="button" class="ctca-pdf-import-browse">select from your computer</button></span>
        <input type="file" accept=".pdf,application/pdf,application/x-pdf" multiple hidden>
      </div>
      <div class="ctca-pdf-import-selection" aria-live="polite"></div>
      <p class="ctca-pdf-import-link-note" hidden>Files dropped here are linked for this browser session. Selecting files may create persistent links when the browser supports them.</p>
    `;
    container.appendChild(wrapper);

    const input = wrapper.querySelector('input[type="file"]');
    const dropzone = wrapper.querySelector(".ctca-pdf-import-dropzone");
    const selection = wrapper.querySelector(".ctca-pdf-import-selection");
    const linkNote = wrapper.querySelector(".ctca-pdf-import-link-note");
    const providerButtons = [...wrapper.querySelectorAll(".ctca-pdf-provider-choice")];

    const render = () => {
      providerButtons.forEach((button) => {
        const selected = button.dataset.provider === provider;
        button.classList.toggle("ctca-pdf-provider-choice-selected", selected);
        button.setAttribute("aria-pressed", selected ? "true" : "false");
      });
      linkNote.hidden = provider !== "local";
      selection.replaceChildren();
      if (!items.length) {
        const empty = document.createElement("div");
        empty.className = "ctca-pdf-import-empty";
        empty.textContent = "No PDFs selected.";
        selection.appendChild(empty);
        return;
      }
      items.forEach((item, index) => {
        const row = document.createElement("div");
        row.className = "ctca-pdf-import-file";
        const name = document.createElement("span");
        name.textContent = item.file.name;
        const size = document.createElement("small");
        size.textContent = item.file.size ? `${(item.file.size / 1024 / 1024).toFixed(1)} MB` : "";
        const remove = document.createElement("button");
        remove.type = "button";
        remove.setAttribute("aria-label", `Remove ${item.file.name}`);
        remove.title = "Remove";
        remove.textContent = "×";
        remove.addEventListener("click", () => {
          items.splice(index, 1);
          render();
        });
        row.append(name, size, remove);
        selection.appendChild(row);
      });
    };

    const addFiles = (files, handles = []) => {
      const candidates = pdfFiles(files);
      for (let index = 0; index < candidates.length; index += 1) {
        const file = candidates[index];
        const duplicate = items.some((item) =>
          item.file.name === file.name &&
          item.file.size === file.size &&
          item.file.lastModified === file.lastModified
        );
        if (!duplicate) items.push({ file, handle: handles[index] || null });
      }
      render();
    };

    providerButtons.forEach((button) => button.addEventListener("click", () => {
      provider = button.dataset.provider || "browser";
      render();
    }));
    wrapper.querySelector(".ctca-pdf-import-browse").addEventListener("click", async () => {
      if (provider === "local" && typeof globalThis.showOpenFilePicker === "function") {
        try {
          const handles = await globalThis.showOpenFilePicker({
            multiple: true,
            types: [{ description: "PDF files", accept: { "application/pdf": [".pdf"] } }]
          });
          const files = await Promise.all(handles.map((handle) => handle.getFile()));
          addFiles(files, handles);
          return;
        } catch (error) {
          if (error?.name === "AbortError") return;
        }
      }
      input.click();
    });
    input.addEventListener("change", () => {
      addFiles(input.files);
      input.value = "";
    });
    for (const eventName of ["dragenter", "dragover"]) {
      dropzone.addEventListener(eventName, (event) => {
        if (!hasPdfFiles(event.dataTransfer)) return;
        event.preventDefault();
        event.stopPropagation();
        event.dataTransfer.dropEffect = "copy";
        dropzone.classList.add("ctca-pdf-import-drop-active");
      });
    }
    dropzone.addEventListener("dragleave", (event) => {
      if (!dropzone.contains(event.relatedTarget)) dropzone.classList.remove("ctca-pdf-import-drop-active");
    });
    dropzone.addEventListener("drop", (event) => {
      if (!hasPdfFiles(event.dataTransfer)) return;
      event.preventDefault();
      event.stopPropagation();
      dropzone.classList.remove("ctca-pdf-import-drop-active");
      addFiles(filesFromDataTransfer(event.dataTransfer));
    });
    dropzone.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      wrapper.querySelector(".ctca-pdf-import-browse").click();
    });
    render();

    return {
      value: () => ({ provider, items: items.map((item) => ({ ...item })) }),
      count: () => items.length
    };
  }

  async function attach(entry, item, provider, name = "") {
    const file = item?.file;
    const attachmentName = name || file?.name?.replace(/\.pdf$/i, "") || "PDF";
    if (provider === "nextcloud") {
      return globalThis.CollabTeXAttachmentStore.addNextcloud(entry, file, attachmentName);
    }
    if (provider === "local") {
      if (item?.handle) {
        try {
          return await globalThis.CollabTeXAttachmentStore.addLocalHandle(entry, item.handle, attachmentName);
        } catch (_error) {}
      }
      return globalThis.CollabTeXAttachmentStore.addLocalSession(entry, file, attachmentName);
    }
    return globalThis.CollabTeXAttachmentStore.addBrowser(entry, file, attachmentName);
  }

  globalThis.CollabTeXPdfImport = {
    normalizeDoi,
    pdfFiles,
    hasPdfFiles,
    filesFromDataTransfer,
    extractDoi,
    createSelectionControls,
    attach
  };
})();
