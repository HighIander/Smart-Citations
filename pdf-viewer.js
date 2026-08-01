/* SPDX-License-Identifier: CC-BY-NC-SA-4.0 */

const earlyStatus = document.querySelector('#pv-status');

function reportViewerFailure(error) {
  if (!earlyStatus) return;
  earlyStatus.hidden = false;
  earlyStatus.classList.add('pv-status-error');
  earlyStatus.textContent = `The PDF editor failed: ${error?.message || String(error)}`;
}

window.addEventListener('error', (event) => reportViewerFailure(event.error || event.message));
window.addEventListener('unhandledrejection', (event) => reportViewerFailure(event.reason));

let pdfjsLib;
let EventBus;
let GenericL10n;
let PDFLinkService;
let PDFViewer;

try {
  pdfjsLib = await import('./pdfjs/pdf.mjs');
  ({ EventBus, GenericL10n, PDFLinkService, PDFViewer } = await import('./pdfjs/pdf_viewer.mjs'));
  globalThis.pdfjsLib = pdfjsLib;
} catch (error) {
  if (earlyStatus) {
    earlyStatus.hidden = false;
    earlyStatus.classList.add('pv-status-error');
    earlyStatus.textContent = `The PDF editor could not be initialized: ${error?.message || String(error)}`;
  }
  throw error;
}

pdfjsLib.GlobalWorkerOptions.workerSrc = './pdfjs/pdf.worker.mjs';

const $ = (selector) => document.querySelector(selector);
const container = $('#pv-container');
const viewerElement = $('#pv-viewer');
const status = $('#pv-status');
const pageInput = $('#pv-page');
const pageCount = $('#pv-pages');
const zoomLabel = $('#pv-zoom');
const downloadButton = $('#pv-download');
const fullscreenButton = $('#pv-fullscreen');
const dirtyBadge = $('#pv-dirty');
const colorInput = $('#pv-color');
const thicknessInput = $('#pv-thickness');
const commentsPane = $('#pv-comments');
const commentsList = $('#pv-comments-list');
const commentsSummary = $('#pv-comments-summary');
const commentCount = $('#pv-comment-count');
const commentEditor = $('#pv-comment-editor');
const commentText = $('#pv-comment-text');
const commentPage = $('#pv-comment-page');
const commentAuthor = $('#pv-comment-author');

const eventBus = new EventBus();
const linkService = new PDFLinkService({ eventBus });
const l10n = new GenericL10n('en-us');
const pdfViewer = new PDFViewer({
  container,
  viewer: viewerElement,
  eventBus,
  linkService,
  l10n,
  annotationMode: pdfjsLib.AnnotationMode.ENABLE_FORMS,
  annotationEditorMode: pdfjsLib.AnnotationEditorType.NONE,
  annotationEditorHighlightColors: 'yellow=#fff066,green=#a8e6a3,blue=#80d8ff,pink=#ffb7d5,red=#ff8a80',
  imageResourcesPath: './pdfjs/images/',
  enableHighlightFloatingButton: true,
  removePageBorders: false,
});
linkService.setViewer(pdfViewer);

let pdfDocument = null;
let editorManager = null;
let dataLoaded = false;
let loadInProgress = false;
let fallbackAttempted = false;
let parentFallbackTimer = null;
let pendingParentLoad = null;
let loadSequence = 0;
let currentMode = 'select';
let dirty = false;
let revision = 0;
let saveInProgress = false;
let queuedSave = false;
let saveToken = '';
let saveRevision = 0;
let autoSaveTimer = null;
let statusTimer = null;
let persistenceMode = 'persistent';
let suppressStorageReset = false;
let pdfComments = [];
let selectedCommentId = '';
let commentsLoaded = false;
let commentDraftId = '';
let commentDraftText = '';
let commentDraftOriginalText = '';
let commentLoadSequence = 0;
const toolColors = { highlight: '#fff066', text: '#111111', comment: '#ffd54f', draw: '#d1242f' };
const toolThickness = { highlight: 12, draw: 3 };
const pendingSaveRequests = new Set();

function attachmentId() {
  return new URLSearchParams(location.search).get('attachment') || '';
}

function createToken(prefix) {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function postToParent(message, transfer = []) {
  try {
    window.parent?.postMessage(message, '*', transfer);
  } catch (_error) {
    // Cross-realm transferable handling differs between Firefox extension
    // pages and content-script parents. A normal structured clone is slower
    // but reliable and keeps annotation saves functional.
    window.parent?.postMessage(message, '*');
  }
}

viewerElement.addEventListener('click', (event) => {
  const link = event.target.closest('a[href]');
  if (!link || !viewerElement.contains(link)) return;
  let url;
  try {
    url = new URL(link.href, location.href);
  } catch (_error) {
    return;
  }
  if (!/^https?:$/.test(url.protocol)) return;
  event.preventDefault();
  event.stopImmediatePropagation();
  postToParent({
    type: 'ctca-pdf-link-request',
    attachmentId: attachmentId(),
    url: url.href
  });
}, true);

function setStatus(message, { error = false, success = false, persistent = false } = {}) {
  window.clearTimeout(statusTimer);
  status.hidden = !message;
  status.textContent = message || '';
  status.classList.toggle('pv-status-inline', Boolean(message) && dataLoaded);
  status.classList.toggle('pv-status-error', error);
  status.classList.toggle('pv-status-success', success);
  if (message && dataLoaded && !persistent) {
    statusTimer = window.setTimeout(() => {
      status.hidden = true;
      status.classList.remove('pv-status-inline', 'pv-status-error', 'pv-status-success');
    }, error ? 6500 : 3200);
  }
}

function modeNumber(mode) {
  switch (mode) {
    case 'highlight': return pdfjsLib.AnnotationEditorType.HIGHLIGHT;
    case 'text': return pdfjsLib.AnnotationEditorType.FREETEXT;
    case 'comment': return pdfjsLib.AnnotationEditorType.NONE;
    case 'draw': return pdfjsLib.AnnotationEditorType.INK;
    default: return pdfjsLib.AnnotationEditorType.NONE;
  }
}

function setMode(mode) {
  if (!pdfDocument) return;
  currentMode = ['select', 'highlight', 'text', 'comment', 'draw'].includes(mode) ? mode : 'select';
  pdfViewer.annotationEditorMode = { mode: modeNumber(currentMode) };
  container.classList.toggle('pv-comment-placement', currentMode === 'comment');
  if (currentMode === 'comment') openCommentsPane();
  document.querySelectorAll('.pv-mode').forEach((button) => {
    button.classList.toggle('pv-mode-active', button.dataset.mode === currentMode);
    button.setAttribute('aria-pressed', button.dataset.mode === currentMode ? 'true' : 'false');
  });
  colorInput.disabled = ['select', 'comment'].includes(currentMode);
  thicknessInput.disabled = !['highlight', 'draw'].includes(currentMode);
  if (toolColors[currentMode]) colorInput.value = toolColors[currentMode];
  if (toolThickness[currentMode]) thicknessInput.value = String(toolThickness[currentMode]);
  applyEditorParameters();
}

function applyEditorParameters() {
  if (!editorManager) return;
  const color = colorInput.value;
  const thickness = Number(thicknessInput.value) || 3;
  if (currentMode === 'highlight') {
    editorManager.updateParams(pdfjsLib.AnnotationEditorParamsType.HIGHLIGHT_DEFAULT_COLOR, color);
    editorManager.updateParams(pdfjsLib.AnnotationEditorParamsType.HIGHLIGHT_COLOR, color);
    editorManager.updateParams(pdfjsLib.AnnotationEditorParamsType.HIGHLIGHT_THICKNESS, thickness);
  } else if (currentMode === 'text') {
    editorManager.updateParams(pdfjsLib.AnnotationEditorParamsType.FREETEXT_COLOR, color);
  } else if (currentMode === 'draw') {
    editorManager.updateParams(pdfjsLib.AnnotationEditorParamsType.INK_COLOR, color);
    editorManager.updateParams(pdfjsLib.AnnotationEditorParamsType.INK_THICKNESS, thickness);
  }
}

function updateSaveUi() {
  dirtyBadge.hidden = !dirty;
  dirtyBadge.textContent = saveInProgress ? 'Saving…' : 'Unsaved';
}

function notifyDirtyState() {
  postToParent({
    type: 'ctca-pdf-dirty-state',
    attachmentId: attachmentId(),
    dirty,
    saving: saveInProgress,
  });
}

function setDirty(value, { increment = false } = {}) {
  if (increment) revision += 1;
  dirty = Boolean(value);
  updateSaveUi();
  notifyDirtyState();
  if (dirty) scheduleAutoSave();
}

function scheduleAutoSave() {
  window.clearTimeout(autoSaveTimer);
  autoSaveTimer = window.setTimeout(() => {
    savePdf().catch((error) => setStatus(error?.message || String(error), { error: true }));
  }, 1800);
}

async function findAttachment(id) {
  const key = globalThis.CollabTeXAttachmentStore.INDEX_KEY;
  const data = await (globalThis.browser ?? globalThis.chrome).storage.local.get(key);
  return data?.[key]?.attachments?.find((item) => item.id === id) || null;
}

function refreshPageUi() {
  pageInput.value = String(pdfViewer.currentPageNumber || 1);
  pageCount.textContent = String(pdfViewer.pagesCount || '—');
  const scale = pdfViewer.currentScale;
  zoomLabel.textContent = Number.isFinite(scale) ? `${Math.round(scale * 100)}%` : '100%';
  $('#pv-prev').disabled = !pdfDocument || pdfViewer.currentPageNumber <= 1;
  $('#pv-next').disabled = !pdfDocument || pdfViewer.currentPageNumber >= pdfViewer.pagesCount;
}

async function normalizePdfBytes(bytes) {
  if (bytes instanceof Uint8Array) return bytes;
  if (bytes instanceof ArrayBuffer) return new Uint8Array(bytes);
  if (ArrayBuffer.isView(bytes)) {
    return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }
  if (bytes instanceof Blob) return new Uint8Array(await bytes.arrayBuffer());
  if (Array.isArray(bytes)) return Uint8Array.from(bytes);
  if (bytes && typeof bytes === 'object') {
    if (bytes.buffer instanceof ArrayBuffer) {
      const offset = Number(bytes.byteOffset) || 0;
      const length = Number(bytes.byteLength) || bytes.buffer.byteLength;
      return new Uint8Array(bytes.buffer, offset, length);
    }
    const numericKeys = Object.keys(bytes).filter((key) => /^\d+$/.test(key)).sort((a, b) => Number(a) - Number(b));
    if (numericKeys.length) return Uint8Array.from(numericKeys.map((key) => Number(bytes[key]) || 0));
  }
  throw new Error('The PDF data received from browser storage has an unsupported format.');
}


function annotationObjectText(value) {
  if (typeof value === 'string') return value;
  if (value && typeof value.str === 'string') return value.str;
  return '';
}

function commentDateLabel(value) {
  if (!value) return '';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString();
}

function commentById(id) {
  return pdfComments.find((comment) => comment.id === id) || null;
}

function visibleComments() {
  return pdfComments.filter((comment) => !comment.deleted);
}

function commentNeedsPdfRewrite() {
  return pdfComments.some((comment) => !comment.draft && (comment.createdInSession || comment.modifiedInSession || comment.deleted));
}

function clearCommentDraft() {
  commentDraftId = '';
  commentDraftText = '';
  commentDraftOriginalText = '';
}

function beginCommentDraft(comment) {
  if (!comment) {
    clearCommentDraft();
    return;
  }
  commentDraftId = comment.id;
  commentDraftText = String(comment.text || '');
  commentDraftOriginalText = String(comment.text || '');
}

function discardCommentDraft({ removeNewComment = true } = {}) {
  if (!commentDraftId) return;
  const comment = commentById(commentDraftId);
  if (removeNewComment && comment?.draft) {
    pdfComments = pdfComments.filter((item) => item.id !== comment.id);
    if (selectedCommentId === comment.id) selectedCommentId = '';
  }
  clearCommentDraft();
}

function openCommentsPane() {
  commentsPane.hidden = false;
  document.querySelector('.pv-workspace')?.classList.add('pv-comments-open');
}

function selectComment(id, { focus = false, navigate = true } = {}) {
  if (selectedCommentId && selectedCommentId !== id) {
    discardCommentDraft({ removeNewComment: true });
  }
  const comment = commentById(id);
  if (!comment || comment.deleted) {
    selectedCommentId = '';
    clearCommentDraft();
    renderPdfComments();
    return;
  }
  selectedCommentId = id;
  if (commentDraftId !== comment.id) beginCommentDraft(comment);
  openCommentsPane();
  if (navigate && pdfDocument) {
    pdfViewer.currentPageNumber = Math.max(1, Math.min(pdfViewer.pagesCount, comment.pageNumber || 1));
  }
  renderPdfComments();
  if (focus) window.setTimeout(() => commentText.focus(), 0);
}

function commentMarkerTitle(comment) {
  const text = String(comment.text || '').trim();
  return text || 'New PDF comment';
}

function renderCommentMarkers() {
  viewerElement.querySelectorAll('.pv-comment-marker').forEach((marker) => marker.remove());
  for (const comment of visibleComments()) {
    if (!comment.createdInSession) continue;
    const pageView = pdfViewer.getPageView((comment.pageNumber || 1) - 1);
    const pageElement = pageView?.div;
    const viewport = pageView?.viewport;
    if (!pageElement || !viewport || !comment.rect) continue;
    const [left, top] = viewport.convertToViewportPoint(comment.rect[0], comment.rect[3]);
    const marker = document.createElement('button');
    marker.type = 'button';
    marker.className = 'pv-comment-marker';
    marker.dataset.commentId = comment.id;
    marker.title = commentMarkerTitle(comment);
    marker.setAttribute('aria-label', `Comment on page ${comment.pageNumber}: ${commentMarkerTitle(comment)}`);
    marker.textContent = '●';
    marker.style.left = `${left}px`;
    marker.style.top = `${top}px`;
    marker.classList.toggle('pv-comment-marker-selected', comment.id === selectedCommentId);
    pageElement.appendChild(marker);
  }

  for (const comment of pdfComments.filter((item) => item.deleted && item.sourceId)) {
    const selector = `[data-annotation-id="${CSS.escape(comment.sourceId)}"]`;
    viewerElement.querySelectorAll(selector).forEach((element) => { element.hidden = true; });
  }
}

function renderPdfComments() {
  const comments = visibleComments();
  commentsSummary.textContent = comments.length
    ? `${comments.length} comment${comments.length === 1 ? '' : 's'}`
    : 'No comments';
  commentCount.hidden = comments.length === 0;
  commentCount.textContent = String(comments.length);
  commentsList.replaceChildren();

  if (!comments.length) {
    const empty = document.createElement('div');
    empty.className = 'pv-comments-empty';
    empty.textContent = 'Choose Comment and click on a page to place a sticky-note marker.';
    commentsList.appendChild(empty);
  } else {
    for (const comment of comments) {
      const item = document.createElement('button');
      item.type = 'button';
      item.className = 'pv-comment-list-item';
      item.classList.toggle('pv-comment-selected', comment.id === selectedCommentId);
      item.dataset.commentId = comment.id;
      const meta = document.createElement('span');
      meta.className = 'pv-comment-list-meta';
      meta.textContent = `Page ${comment.pageNumber}${comment.author ? ` · ${comment.author}` : ''}`;
      const text = document.createElement('span');
      text.className = 'pv-comment-list-text';
      text.textContent = String(comment.text || '').trim() || 'New comment';
      item.append(meta, text);
      commentsList.appendChild(item);
    }
  }

  const selected = commentById(selectedCommentId);
  const showEditor = Boolean(selected && !selected.deleted);
  commentEditor.hidden = !showEditor;
  if (showEditor) {
    commentPage.textContent = `Page ${selected.pageNumber}`;
    const date = commentDateLabel(selected.modifiedAt || selected.createdAt);
    commentAuthor.textContent = [selected.author, date].filter(Boolean).join(' · ');
    if (commentDraftId !== selected.id) beginCommentDraft(selected);
    if (commentText.value !== commentDraftText) commentText.value = commentDraftText;
  }
  renderCommentMarkers();
}

async function loadPdfComments() {
  const sequence = ++commentLoadSequence;
  const documentAtStart = pdfDocument;
  pdfComments = [];
  selectedCommentId = '';
  clearCommentDraft();
  commentsLoaded = false;
  renderPdfComments();
  if (!documentAtStart) return;

  for (let pageNumber = 1; pageNumber <= documentAtStart.numPages; pageNumber += 1) {
    if (sequence !== commentLoadSequence || documentAtStart !== pdfDocument) return;
    try {
      const page = await Promise.race([
        documentAtStart.getPage(pageNumber),
        timeoutPromise(8000, `Timed out while reading comments on page ${pageNumber}.`),
      ]);
      const annotations = await Promise.race([
        page.getAnnotations({ intent: 'display' }),
        timeoutPromise(8000, `Timed out while indexing comments on page ${pageNumber}.`),
      ]);
      if (sequence !== commentLoadSequence || documentAtStart !== pdfDocument) return;
      let added = false;
      for (const annotation of annotations) {
        if (annotation.annotationType !== 1) continue;
        const text = annotationObjectText(annotation.contentsObj) || String(annotation.contents || '');
        const author = annotationObjectText(annotation.titleObj) || String(annotation.title || '');
        const sourceId = String(annotation.id || '');
        pdfComments.push({
          id: `existing-${pageNumber}-${sourceId || pdfComments.length}`,
          sourceId,
          internalId: '',
          pageNumber,
          rect: Array.isArray(annotation.rect) ? annotation.rect.map(Number) : [0, 0, 18, 18],
          text,
          author,
          createdAt: annotation.creationDate || '',
          modifiedAt: annotation.modificationDate || '',
          createdInSession: false,
          modifiedInSession: false,
          deleted: false,
          draft: false,
        });
        added = true;
      }
      if (added) renderPdfComments();
    } catch (error) {
      console.warn(`[Smart Citations] Could not index PDF comments on page ${pageNumber}:`, error);
    }
  }
  if (sequence !== commentLoadSequence || documentAtStart !== pdfDocument) return;
  commentsLoaded = true;
  renderPdfComments();
}

function createCommentAtPointer(event) {
  if (currentMode !== 'comment' || !pdfDocument) return;
  const pageElement = event.target.closest('.page');
  if (!pageElement || !viewerElement.contains(pageElement)) return;
  if (event.target.closest('.pv-comment-marker')) return;

  const pageNumber = Number(pageElement.dataset.pageNumber) || pdfViewer.currentPageNumber || 1;
  const pageView = pdfViewer.getPageView(pageNumber - 1);
  if (!pageView?.viewport) return;
  const bounds = pageElement.getBoundingClientRect();
  const [pdfX, pdfY] = pageView.viewport.convertToPdfPoint(event.clientX - bounds.left, event.clientY - bounds.top);
  const pageBox = pageView.pdfPage?.view || [0, 0, pdfX + 18, pdfY + 18];
  const size = 18;
  const x1 = Math.max(Number(pageBox[0]) || 0, Math.min(pdfX, (Number(pageBox[2]) || pdfX + size) - size));
  const y2 = Math.max((Number(pageBox[1]) || 0) + size, Math.min(pdfY, Number(pageBox[3]) || pdfY));
  const id = createToken('comment');
  const comment = {
    id,
    sourceId: '',
    internalId: `ctca-${id}`,
    pageNumber,
    rect: [x1, y2 - size, x1 + size, y2],
    text: '',
    author: 'Smart Citations',
    createdAt: new Date().toISOString(),
    modifiedAt: new Date().toISOString(),
    createdInSession: true,
    modifiedInSession: false,
    deleted: false,
    draft: true,
  };
  pdfComments.push(comment);
  selectedCommentId = comment.id;
  beginCommentDraft(comment);
  renderPdfComments();
  openCommentsPane();
  window.setTimeout(() => commentText.focus(), 0);
  event.preventDefault();
  event.stopPropagation();
}

function normalizePdfReference(value) {
  const match = String(value || '').match(/(\d+)(?:\s+(\d+))?\s*R?/i);
  return match ? `${match[1]}R` : String(value || '').replace(/\s+/g, '');
}

function pdfObjectText(value) {
  try { return value?.decodeText?.() || ''; } catch (_error) { return ''; }
}

async function applyPdfComments(baseBytes) {
  const data = await normalizePdfBytes(baseBytes);
  if (!commentNeedsPdfRewrite()) return data;
  if (!globalThis.PDFLib?.PDFDocument) {
    throw new Error('The PDF comment writer could not be initialized.');
  }

  const {
    PDFDocument,
    PDFName,
    PDFArray,
    PDFDict,
    PDFString,
    PDFHexString,
  } = globalThis.PDFLib;
  const document = await PDFDocument.load(data, { updateMetadata: false });
  const context = document.context;
  const pages = document.getPages();
  const nameAnnots = PDFName.of('Annots');
  const nameSubtype = PDFName.of('Subtype');
  const nameText = PDFName.of('Text');
  const nameContents = PDFName.of('Contents');
  const nameTitle = PDFName.of('T');
  const nameModified = PDFName.of('M');
  const nameCreated = PDFName.of('CreationDate');
  const nameUnique = PDFName.of('NM');
  const nameIcon = PDFName.of('Name');
  const nameColor = PDFName.of('C');
  const nameOpen = PDFName.of('Open');
  const nameFlags = PDFName.of('F');
  const namePage = PDFName.of('P');

  const getAnnots = (page) => {
    let annots = page.node.lookupMaybe(nameAnnots, PDFArray);
    if (!annots) {
      annots = context.obj([]);
      page.node.set(nameAnnots, annots);
    }
    return annots;
  };

  const findAnnotation = (annots, comment) => {
    const source = normalizePdfReference(comment.sourceId);
    for (let index = 0; index < annots.size(); index += 1) {
      const object = annots.get(index);
      const dictionary = object instanceof PDFDict ? object : context.lookup(object, PDFDict);
      if (!dictionary) continue;
      const subtype = dictionary.lookupMaybe(nameSubtype, PDFName);
      if (subtype?.asString?.() !== nameText.asString()) continue;
      const uniqueObject = dictionary.lookupMaybe(nameUnique, PDFString, PDFHexString);
      const unique = pdfObjectText(uniqueObject);
      const reference = normalizePdfReference(object?.toString?.());
      if ((comment.internalId && unique === comment.internalId) || (source && source === reference)) {
        return { index, dictionary };
      }
    }
    return null;
  };

  for (const comment of pdfComments) {
    if (comment.draft) continue;
    if (!comment.createdInSession && !comment.modifiedInSession && !comment.deleted) continue;
    const page = pages[(comment.pageNumber || 1) - 1];
    if (!page) continue;
    const annots = getAnnots(page);
    const existing = findAnnotation(annots, comment);

    if (comment.deleted || !String(comment.text || '').trim()) {
      if (existing) annots.remove(existing.index);
      continue;
    }

    const modifiedDate = new Date(comment.modifiedAt || Date.now());
    const createdDate = new Date(comment.createdAt || modifiedDate);
    if (existing) {
      existing.dictionary.set(nameContents, PDFHexString.fromText(String(comment.text)));
      existing.dictionary.set(nameTitle, PDFHexString.fromText(String(comment.author || '')));
      existing.dictionary.set(nameModified, PDFString.fromDate(modifiedDate));
      existing.dictionary.set(nameCreated, PDFString.fromDate(createdDate));
      existing.dictionary.set(nameIcon, PDFName.of('Comment'));
      existing.dictionary.set(nameColor, context.obj([1, 0.835, 0.31]));
      existing.dictionary.set(nameOpen, context.obj(false));
      existing.dictionary.set(nameFlags, context.obj(4));
      continue;
    }

    const dictionary = context.obj({
      Type: 'Annot',
      Subtype: 'Text',
      Rect: (comment.rect || [0, 0, 18, 18]).map(Number),
      Contents: PDFHexString.fromText(String(comment.text)),
      T: PDFHexString.fromText(String(comment.author || '')),
      NM: PDFHexString.fromText(String(comment.internalId || comment.id)),
      M: PDFString.fromDate(modifiedDate),
      CreationDate: PDFString.fromDate(createdDate),
      Name: 'Comment',
      C: [1, 0.835, 0.31],
      Open: false,
      F: 4,
      P: page.ref,
    });
    const reference = context.register(dictionary);
    annots.push(reference);
  }

  return document.save({ useObjectStreams: false });
}

function timeoutPromise(milliseconds, message) {
  return new Promise((_, reject) => {
    window.setTimeout(() => reject(new Error(message)), milliseconds);
  });
}

async function loadBytes(bytes, options = {}) {
  if (dataLoaded) return;
  if (loadInProgress) {
    // Keep a parent-provided copy as a fallback while the direct extension
    // storage path is still running. This avoids losing the only usable copy
    // when Firefox delivers the message during an IndexedDB read.
    if (options.fromParent) pendingParentLoad = { bytes, options };
    return;
  }

  const data = await normalizePdfBytes(bytes);
  if (!data.byteLength) throw new Error('The selected PDF file is empty.');

  const sequence = ++loadSequence;
  loadInProgress = true;
  window.clearTimeout(autoSaveTimer);
  window.clearTimeout(parentFallbackTimer);
  setStatus(options.status || 'Decoding PDF…', { persistent: true });

  const previousPage = options.preserveView ? pdfViewer.currentPageNumber : 1;
  const previousScale = options.preserveView ? pdfViewer.currentScaleValue : 'page-width';
  let loadingTask = null;

  try {
    pdfViewer.setDocument(null);
    linkService.setDocument(null);
    editorManager = null;
    if (pdfDocument) {
      try { await pdfDocument.destroy(); } catch (_) {}
      pdfDocument = null;
    }

    loadingTask = pdfjsLib.getDocument({ data });
    const loaded = await Promise.race([
      loadingTask.promise,
      timeoutPromise(30000, 'Timed out while decoding the PDF file.'),
    ]);
    if (sequence !== loadSequence) {
      await loaded.destroy();
      return;
    }

    setStatus('Preparing PDF pages…', { persistent: true });
    await Promise.race([
      loaded.getPage(1),
      timeoutPromise(15000, 'Timed out while reading the first PDF page.'),
    ]);

    pdfDocument = loaded;
    pdfDocument.annotationStorage.onSetModified = () => setDirty(true, { increment: true });
    pdfDocument.annotationStorage.onResetModified = () => {
      if (!suppressStorageReset) setDirty(false);
    };

    const pagesInitialized = new Promise((resolve) => {
      eventBus.on('pagesinit', resolve, { once: true });
    });
    pdfViewer.setDocument(pdfDocument);
    linkService.setDocument(pdfDocument);
    await Promise.race([
      pagesInitialized,
      timeoutPromise(20000, 'Timed out while initializing the PDF page viewer.'),
    ]);

    pdfViewer.currentScaleValue = previousScale || 'page-width';
    pdfViewer.currentPageNumber = Math.max(1, Math.min(pdfViewer.pagesCount, previousPage || 1));
    setMode(currentMode);
    pdfDocument.annotationStorage.resetModified();
    dirty = false;
    dataLoaded = true;
    pendingParentLoad = null;
    window.clearTimeout(parentFallbackTimer);
    updateSaveUi();
    refreshPageUi();
    setStatus('');
    notifyDirtyState();

    // Comment indexing must never block display of the PDF. Large documents or
    // malformed annotation dictionaries can make getAnnotations() slow; the
    // document is therefore shown first and the comments pane is populated in
    // the background with per-page timeouts.
    loadPdfComments().catch((error) => {
      console.warn('[Smart Citations] PDF loaded, but comments could not be indexed:', error);
      setStatus('PDF loaded, but its comments could not be indexed.', { error: true });
    });
  } catch (error) {
    if (loadingTask && !pdfDocument) {
      try { await loadingTask.destroy(); } catch (_) {}
    }
    throw error;
  } finally {
    loadInProgress = false;
    if (!dataLoaded && pendingParentLoad) {
      const pending = pendingParentLoad;
      pendingParentLoad = null;
      queueMicrotask(() => {
        loadBytes(pending.bytes, { ...pending.options, fromParent: false, status: 'Loading PDF from the manager…' })
          .catch((error) => setStatus(error?.message || String(error), { error: true, persistent: true }));
      });
    }
  }
}

async function loadDirectFallback() {
  if (dataLoaded || loadInProgress || fallbackAttempted) return;
  fallbackAttempted = true;
  setStatus('Retrieving PDF from extension storage…', { persistent: true });

  try {
    const attachment = await Promise.race([
      findAttachment(attachmentId()),
      timeoutPromise(10000, 'Timed out while reading the PDF attachment metadata.'),
    ]);
    if (!attachment) throw new Error('Attachment metadata was not found.');
    persistenceMode = attachment.provider === 'local' ? 'local-copy' : 'persistent';
    const blob = await Promise.race([
      globalThis.CollabTeXAttachmentStore.getBlob(attachment),
      timeoutPromise(20000, 'Timed out while retrieving the PDF data.'),
    ]);
    if (!blob) throw new Error('PDF data is not available. Reattach the file or synchronize it again.');
    await loadBytes(blob, { status: 'Decoding PDF from extension storage…' });
  } catch (error) {
    if (dataLoaded) return;

    // Legacy browser-cache files can still live in the ColLabTeX content
    // script's IndexedDB realm. Ask the parent only when the extension-wide
    // storage path cannot provide the file.
    setStatus('Trying the manager PDF cache…', { persistent: true });
    postToParent({
      type: 'ctca-pdf-request-data',
      attachmentId: attachmentId(),
      directError: error?.message || String(error),
    });
    parentFallbackTimer = window.setTimeout(() => {
      if (!dataLoaded && !loadInProgress) {
        setStatus(
          `${error?.message || String(error)}\nThe PDF could not be retrieved from either extension storage or the manager cache.`,
          { error: true, persistent: true },
        );
      }
    }, 12000);
  }
}

function completePendingSaveRequests(ok, message = '') {
  for (const requestId of pendingSaveRequests) {
    postToParent({
      type: 'ctca-pdf-save-request-complete',
      attachmentId: attachmentId(),
      requestId,
      ok,
      error: ok ? '' : message,
    });
  }
  pendingSaveRequests.clear();
}

async function savePdf() {
  if (!pdfDocument) return;
  if (!dirty) {
    completePendingSaveRequests(true);
    return;
  }
  if (saveInProgress) {
    queuedSave = true;
    return;
  }

  window.clearTimeout(autoSaveTimer);
  editorManager?.commitOrRemove();
  saveInProgress = true;
  saveRevision = revision;
  saveToken = createToken('save');
  // Reset only PDF.js's modified latch before serialization. This lets any
  // edits made while the asynchronous save/upload is running trigger a new
  // modification event and therefore a second save instead of being lost.
  suppressStorageReset = true;
  pdfDocument.annotationStorage.resetModified();
  suppressStorageReset = false;
  dirty = true;
  updateSaveUi();
  notifyDirtyState();
  setStatus(persistenceMode === 'local-copy' ? 'Preparing annotated PDF copy…' : 'Saving annotations into the PDF…', { persistent: true });

  try {
    const annotationBytes = await pdfDocument.saveDocument();
    const bytes = await applyPdfComments(annotationBytes);
    const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    postToParent({
      type: 'ctca-pdf-save-data',
      attachmentId: attachmentId(),
      token: saveToken,
      bytes: buffer,
    }, [buffer]);
  } catch (error) {
    saveInProgress = false;
    queuedSave = false;
    updateSaveUi();
    notifyDirtyState();
    completePendingSaveRequests(false, error?.message || String(error));
    throw error;
  }
}

function handleSaveResult(message) {
  if (!saveInProgress || message.token !== saveToken) return;
  saveInProgress = false;
  persistenceMode = message.persistenceMode || persistenceMode;

  if (!message.ok) {
    dirty = true;
    updateSaveUi();
    notifyDirtyState();
    completePendingSaveRequests(false, message.error || 'The annotated PDF could not be saved.');
    setStatus(message.error || 'The annotated PDF could not be saved.', { error: true });
    return;
  }

  if (revision === saveRevision) {
    dirty = false;
  } else {
    dirty = true;
  }
  updateSaveUi();
  notifyDirtyState();
  setStatus(message.message || 'Annotations and comments saved inside the PDF.', { success: true });

  if (dirty || queuedSave) {
    queuedSave = false;
    savePdf().catch((error) => setStatus(error?.message || String(error), { error: true }));
  } else {
    completePendingSaveRequests(true);
  }
}

eventBus.on('annotationeditoruimanager', ({ uiManager }) => {
  editorManager = uiManager;
  applyEditorParameters();
});

eventBus.on('annotationeditorstateschanged', ({ details }) => {
  $('#pv-undo').disabled = !details.hasSomethingToUndo;
  $('#pv-redo').disabled = !details.hasSomethingToRedo;
});

function runEditorHistoryAction(action) {
  const button = action === 'undo' ? $('#pv-undo') : $('#pv-redo');
  if (!editorManager || button.disabled) return false;
  editorManager[action]();
  // PDF.js updates the annotation editors during undo/redo, but does not
  // consistently notify annotationStorage that the document changed.
  // Treat the completed history action as a new revision so the normal
  // autosave path persists it, including when another save is in progress.
  setDirty(true, { increment: true });
  return true;
}

eventBus.on('pagechanging', refreshPageUi);
eventBus.on('scalechanging', refreshPageUi);
eventBus.on('pagesloaded', refreshPageUi);
eventBus.on('pagerendered', renderCommentMarkers);

document.querySelectorAll('.pv-mode').forEach((button) => {
  button.addEventListener('click', () => setMode(button.dataset.mode));
});
colorInput.addEventListener('input', () => {
  if (toolColors[currentMode]) toolColors[currentMode] = colorInput.value;
  applyEditorParameters();
});
thicknessInput.addEventListener('input', () => {
  if (toolThickness[currentMode]) toolThickness[currentMode] = Number(thicknessInput.value) || toolThickness[currentMode];
  applyEditorParameters();
});

commentsList.addEventListener('click', (event) => {
  const item = event.target.closest('[data-comment-id]');
  if (item) selectComment(item.dataset.commentId, { navigate: true });
});

commentText.addEventListener('input', () => {
  const comment = commentById(selectedCommentId);
  if (!comment || comment.deleted) return;
  if (commentDraftId !== comment.id) beginCommentDraft(comment);
  commentDraftText = commentText.value;
});

$('#pv-comment-delete').addEventListener('click', () => {
  const comment = commentById(selectedCommentId);
  if (!comment) return;
  if (comment.draft) {
    pdfComments = pdfComments.filter((item) => item.id !== comment.id);
    clearCommentDraft();
  } else {
    comment.deleted = true;
    comment.modifiedInSession = true;
    comment.modifiedAt = new Date().toISOString();
    setDirty(true, { increment: true });
    clearCommentDraft();
  }
  selectedCommentId = '';
  renderPdfComments();
  container.focus();
});

$('#pv-comment-done').addEventListener('click', () => {
  const comment = commentById(selectedCommentId);
  if (!comment || comment.deleted) return;
  if (commentDraftId !== comment.id) beginCommentDraft(comment);
  const nextText = String(commentDraftText ?? commentText.value ?? '');

  if (!nextText.trim()) {
    if (comment.draft) {
      pdfComments = pdfComments.filter((item) => item.id !== comment.id);
      selectedCommentId = '';
      clearCommentDraft();
      renderPdfComments();
      container.focus();
      return;
    }
    setStatus('A comment cannot be empty. Use Delete to remove it.', { error: true });
    commentText.focus();
    return;
  }

  const changed = comment.draft || nextText !== commentDraftOriginalText;
  if (changed) {
    comment.text = nextText;
    comment.modifiedAt = new Date().toISOString();
    comment.modifiedInSession = true;
    comment.draft = false;
    setDirty(true, { increment: true });
  }
  selectedCommentId = '';
  clearCommentDraft();
  renderPdfComments();
  setStatus(changed ? 'Comment accepted. It will be embedded in the PDF.' : 'Comment closed.', { success: true });
  container.focus();
});

$('#pv-comments-close').addEventListener('click', () => {
  discardCommentDraft({ removeNewComment: true });
  selectedCommentId = '';
  renderPdfComments();
  commentsPane.hidden = true;
  document.querySelector('.pv-workspace')?.classList.remove('pv-comments-open');
  if (currentMode === 'comment') setMode('select');
});

container.addEventListener('click', (event) => {
  const ownMarker = event.target.closest('.pv-comment-marker');
  if (ownMarker) {
    selectComment(ownMarker.dataset.commentId, { navigate: false });
    event.preventDefault();
    event.stopPropagation();
    return;
  }
  const annotationElement = event.target.closest('[data-annotation-id]');
  if (annotationElement) {
    const sourceId = String(annotationElement.dataset.annotationId || '');
    const comment = pdfComments.find((item) => item.sourceId === sourceId && !item.deleted);
    if (comment) selectComment(comment.id, { navigate: false });
    return;
  }
  createCommentAtPointer(event);
});

$('#pv-prev').addEventListener('click', () => pdfViewer.previousPage());
$('#pv-next').addEventListener('click', () => pdfViewer.nextPage());
pageInput.addEventListener('change', () => {
  if (!pdfDocument) return;
  pdfViewer.currentPageNumber = Math.max(1, Math.min(pdfViewer.pagesCount, Number(pageInput.value) || 1));
});
$('#pv-zoom-out').addEventListener('click', () => pdfViewer.decreaseScale());
$('#pv-zoom-in').addEventListener('click', () => pdfViewer.increaseScale());
$('#pv-fit').addEventListener('click', () => { pdfViewer.currentScaleValue = 'page-width'; });
$('#pv-undo').addEventListener('click', () => runEditorHistoryAction('undo'));
$('#pv-redo').addEventListener('click', () => runEditorHistoryAction('redo'));
downloadButton.addEventListener('click', () => {
  postToParent({ type: 'ctca-pdf-download-request', attachmentId: attachmentId() });
});
fullscreenButton.addEventListener('click', () => {
  postToParent({ type: 'ctca-pdf-fullscreen-request', attachmentId: attachmentId() });
});

window.addEventListener('keydown', (event) => {
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
    event.preventDefault();
    savePdf().catch((error) => setStatus(error?.message || String(error), { error: true }));
  } else if (event.key === 'Escape' && document.body.classList.contains('pv-host-maximized')) {
    event.preventDefault();
    postToParent({ type: 'ctca-pdf-fullscreen-request', attachmentId: attachmentId() });
  }
});

window.addEventListener('beforeunload', (event) => {
  if (!dirty) return;
  event.preventDefault();
  event.returnValue = '';
});

window.addEventListener('message', (event) => {
  const message = event.data;
  if (message?.attachmentId && message.attachmentId !== attachmentId()) return;

  if (message?.type === 'ctca-pdf-host-layout') {
    const maximized = Boolean(message.maximized);
    document.body.classList.toggle('pv-host-maximized', maximized);
    fullscreenButton.setAttribute('aria-pressed', maximized ? 'true' : 'false');
    fullscreenButton.setAttribute('aria-label', maximized ? 'Reduce PDF view' : 'Maximize PDF view');
    fullscreenButton.title = maximized ? 'Reduce PDF view' : 'Maximize PDF view';
    return;
  }
  if (message?.type === 'ctca-pdf-goto-page') {
    if (pdfDocument) pdfViewer.currentPageNumber = Number(message.page) || 1;
    return;
  }
  if (message?.type === 'ctca-pdf-load-data') {
    persistenceMode = message.provider === 'local' ? 'local-copy' : 'persistent';
    window.clearTimeout(parentFallbackTimer);
    loadBytes(message.bytes, { fromParent: true, status: 'Loading PDF from the manager cache…' }).catch((error) => {
      setStatus(error?.message || String(error), { error: true, persistent: true });
    });
    return;
  }
  if (message?.type === 'ctca-pdf-load-error') {
    setStatus(message.error || 'PDF data could not be loaded.', { error: true, persistent: true });
    return;
  }
  if (message?.type === 'ctca-pdf-save-result') {
    handleSaveResult(message);
    return;
  }
  if (message?.type === 'ctca-pdf-request-save') {
    if (message.requestId) pendingSaveRequests.add(message.requestId);
    if (!dirty && !saveInProgress) completePendingSaveRequests(true);
    else savePdf().catch((error) => completePendingSaveRequests(false, error?.message || String(error)));
  }
});

status.hidden = false;
status.textContent = 'Retrieving PDF from extension storage…';
updateSaveUi();
postToParent({ type: 'ctca-pdf-viewer-ready', attachmentId: attachmentId() });
// The viewer loads from extension storage itself. This avoids Firefox's
// unreliable cross-realm ArrayBuffer transfer between a content-script parent
// and a moz-extension iframe. The parent is requested only as a legacy fallback.
loadDirectFallback();
