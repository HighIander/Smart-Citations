/* SPDX-License-Identifier: CC-BY-NC-SA-4.0 */

(() => {
  "use strict";

  // The bridge belongs only to a concrete project editor, never to the
  // project overview/dashboard. This also guards against stale broad dynamic
  // content-script registrations left behind by an older extension version.
  if (!/^\/project\/[^/?#]+(?:\/|$)/i.test(window.location.pathname)) return;

  if (globalThis.__smartCitationsEditorBridgeLoaded) return;
  globalThis.__smartCitationsEditorBridgeLoaded = true;

  const hostname = window.location.hostname;
  const IS_OVERLEAF = /(^|\.)overleaf\.com$/i.test(hostname);
  const IS_COLLABTEX = !IS_OVERLEAF;

  const REQUEST_EVENT = "collabtex-cite-assistant:request";
  const RESPONSE_EVENT = "collabtex-cite-assistant:response";
  const STATE_EVENT = "collabtex-cite-assistant:state";
  const CITE_COMMAND = /\\(?:cite|citep|citet|citealp|citealt|citeauthor|citeyear|parencite|textcite|autocite|footcite|smartcite|supercite|nocite)\*?(?:\s*\[[^\]]*\]){0,2}\s*\{([^{}]*)$/i;

  let editorKind = "";
  let editor = null;
  let boundSession = null;
  let scheduledState = false;
  let sessionIdentityCounter = 0;
  let documentIdentityCounter = 0;
  let lastStateFingerprint = "";
  let cmCleanup = null;
  let nativePopupObserver = null;
  const sessionIdentities = new WeakMap();
  const documentIdentities = new WeakMap();

  function objectIdentity(object, map, counterName) {
    if (!object || (typeof object !== "object" && typeof object !== "function")) return "";
    if (!map.has(object)) {
      if (counterName === "session") {
        sessionIdentityCounter += 1;
        map.set(object, `session-${sessionIdentityCounter}`);
      } else {
        documentIdentityCounter += 1;
        map.set(object, `document-${documentIdentityCounter}`);
      }
    }
    return map.get(object);
  }

  function findAceEditor() {
    const candidates = [
      document.querySelector("#editor .ace_editor:not(.ace_autocomplete)"),
      document.querySelector("#editor.ace_editor"),
      document.querySelector(".ace-editor-body.ace_editor:not(.ace_autocomplete)")
    ].filter(Boolean);

    for (const element of candidates) {
      if (element.env?.editor) {
        return element.env.editor;
      }

      if (window.ace?.edit) {
        try {
          return window.ace.edit(element);
        } catch (_error) {
          // The next candidate may still be the actual source editor.
        }
      }
    }

    return null;
  }

  function looksLikeCodeMirrorView(value) {
    return Boolean(
      value &&
      typeof value === "object" &&
      value.state?.doc &&
      typeof value.state.doc.toString === "function" &&
      typeof value.dispatch === "function" &&
      typeof value.focus === "function"
    );
  }

  function discoverCodeMirrorView(value, depth = 0, seen = new Set()) {
    if (!value || depth > 3 || (typeof value !== "object" && typeof value !== "function")) {
      return null;
    }
    if (looksLikeCodeMirrorView(value)) return value;
    if (seen.has(value)) return null;
    seen.add(value);

    const preferredKeys = [
      "view",
      "editorView",
      "cmView",
      "editor",
      "_view",
      "rootView",
      "docView"
    ];
    for (const key of preferredKeys) {
      try {
        const found = discoverCodeMirrorView(value[key], depth + 1, seen);
        if (found) return found;
      } catch (_error) {
        // Some framework-owned properties have guarded accessors.
      }
    }

    if (depth >= 2) return null;
    let keys = [];
    try {
      keys = Object.getOwnPropertyNames(value).slice(0, 80);
    } catch (_error) {
      return null;
    }
    for (const key of keys) {
      if (preferredKeys.includes(key)) continue;
      try {
        const nested = value[key];
        if (!nested || (typeof nested !== "object" && typeof nested !== "function")) continue;
        const found = discoverCodeMirrorView(nested, depth + 1, seen);
        if (found) return found;
      } catch (_error) {
        // Ignore inaccessible framework internals.
      }
    }
    return null;
  }

  function findCodeMirrorEditor() {
    const roots = [
      document.querySelector("#ide-redesign-panel-source-editor .cm-editor"),
      document.querySelector(".ide-redesign-editor-container .cm-editor"),
      document.querySelector(".cm-editor")
    ].filter(Boolean);

    for (const root of roots) {
      const content = root.querySelector(".cm-content");
      const directCandidates = [
        root.cmView?.view,
        root.cmView,
        root.editorView,
        root.view,
        content?.cmView?.view,
        content?.cmView,
        content?.editorView,
        content?.view
      ];
      for (const candidate of directCandidates) {
        if (looksLikeCodeMirrorView(candidate)) return candidate;
      }
      const discovered = discoverCodeMirrorView(content || root);
      if (discovered) return discovered;
    }

    return null;
  }

  function findEditor() {
    if (IS_OVERLEAF) {
      const cm = findCodeMirrorEditor();
      if (cm) return { kind: "codemirror", editor: cm };
    }
    const ace = findAceEditor();
    if (ace) return { kind: "ace", editor: ace };
    if (!IS_OVERLEAF) {
      const cm = findCodeMirrorEditor();
      if (cm) return { kind: "codemirror", editor: cm };
    }
    return null;
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
      const breadcrumb = document.querySelector(".ol-cm-breadcrumbs > div");
      const breadcrumbName = breadcrumb?.textContent?.trim() || "";
      if (/\.[A-Za-z0-9]+$/i.test(breadcrumbName)) return breadcrumbName;
    }

    return "";
  }

  function cursorToIndex(session, cursor) {
    if (!session?.doc?.positionToIndex) {
      return 0;
    }
    return session.doc.positionToIndex(cursor, 0);
  }

  function acePositionToScreen(position) {
    if (!editor || !position) {
      return null;
    }

    const coordinates = editor.renderer.textToScreenCoordinates(
      position.row,
      position.column
    );

    return {
      pageX: Number.isFinite(coordinates?.pageX) ? coordinates.pageX : 0,
      pageY: Number.isFinite(coordinates?.pageY) ? coordinates.pageY : 0,
      lineHeight: editor.renderer.lineHeight || 16
    };
  }

  function codeMirrorPositionToScreen(index) {
    if (!editor || editorKind !== "codemirror") return null;
    const docLength = editor.state.doc.length;
    const bounded = Math.max(0, Math.min(Number(index) || 0, docLength));
    const coordinates = editor.coordsAtPos?.(bounded, 1) || editor.coordsAtPos?.(bounded);
    if (!coordinates) return null;
    return {
      pageX: coordinates.left + window.scrollX,
      pageY: coordinates.top + window.scrollY,
      lineHeight: Math.max(14, coordinates.bottom - coordinates.top)
    };
  }

  function indexToScreen(index) {
    if (!editor) return null;
    if (editorKind === "codemirror") return codeMirrorPositionToScreen(index);
    const session = editor.getSession();
    const boundedIndex = Math.max(0, Math.min(Number(index) || 0, session.getValue().length));
    const position = session.doc.indexToPosition(boundedIndex, 0);
    return acePositionToScreen(position);
  }

  function codeMirrorReadOnly(view) {
    const content = view?.contentDOM || view?.dom?.querySelector?.(".cm-content");
    return content?.getAttribute?.("contenteditable") !== "true";
  }

  function getEditorState() {
    if (!editor) return null;

    if (editorKind === "codemirror") {
      const value = editor.state.doc.toString();
      const cursorIndex = Number(editor.state.selection?.main?.head ?? 0);
      const line = editor.state.doc.lineAt(Math.max(0, Math.min(cursorIndex, editor.state.doc.length)));
      return {
        value,
        cursor: { row: line.number - 1, column: cursorIndex - line.from },
        cursorIndex,
        screen: codeMirrorPositionToScreen(cursorIndex),
        fileName: getSelectedFileName(),
        sessionToken: objectIdentity(editor, sessionIdentities, "session"),
        documentToken: objectIdentity(editor.state.doc, documentIdentities, "document"),
        readOnly: codeMirrorReadOnly(editor),
        editorKind: "codemirror"
      };
    }

    const cursor = editor.getCursorPosition();
    const session = editor.getSession();
    return {
      value: session.getValue(),
      cursor,
      cursorIndex: cursorToIndex(session, cursor),
      screen: acePositionToScreen(cursor),
      fileName: getSelectedFileName(),
      sessionToken: objectIdentity(session, sessionIdentities, "session"),
      documentToken: objectIdentity(session.doc, documentIdentities, "document"),
      readOnly: editor.getReadOnly(),
      editorKind: "ace"
    };
  }

  function citationContextIsActive(state) {
    if (!state?.value || !Number.isInteger(state.cursorIndex)) return false;
    return CITE_COMMAND.test(state.value.slice(0, state.cursorIndex));
  }

  function markNativeCitationPopup(node) {
    if (!(node instanceof Element) || node.closest("#ctca-popup, #ctca-bib-manager")) return;
    const text = String(node.textContent || "").replace(/\s+/g, " ").trim();
    if (!text) return;
    const hasReferenceSearch = /open advanced reference search/i.test(text);
    const completionPopup = node.matches?.(".cm-tooltip-autocomplete") || node.querySelector?.(".cm-tooltip-autocomplete");
    if (!hasReferenceSearch && !completionPopup) return;
    const popup = node.closest?.(".cm-tooltip, [role='tooltip'], [role='listbox']") ||
      node.querySelector?.(".cm-tooltip, [role='tooltip'], [role='listbox']") || node;
    popup.classList?.add("ctca-native-cite-popup");
  }

  function hideNativeAutocomplete() {
    if (!IS_OVERLEAF) {
      try {
        editor?.completer?.detach?.();
        editor?.completer?.popup?.hide?.();
      } catch (_error) {
        // Hiding the native ACE popup is best-effort across versions.
      }
      return;
    }

    document.querySelectorAll(
      ".cm-tooltip-autocomplete, .cm-tooltip, [role='listbox'], [role='tooltip']"
    ).forEach(markNativeCitationPopup);
  }

  function updateNativeCitationAutocomplete(state) {
    if (!IS_OVERLEAF) return;
    const active = citationContextIsActive(state);
    document.body?.classList.toggle("ctca-overleaf-cite-context", active);
    if (active) hideNativeAutocomplete();
  }

  function suppressNativeCitationCompletionKey(event) {
    if (!IS_OVERLEAF || !document.body?.classList.contains("ctca-overleaf-cite-context")) return;
    if (!["ArrowUp", "ArrowDown", "Enter", "Tab"].includes(event.key)) return;
    const smartPopupVisible = document.querySelector("#ctca-popup.ctca-visible");
    if (smartPopupVisible) return;
    const nativePopup = document.querySelector(
      ".cm-tooltip-autocomplete, .ctca-native-cite-popup, .cm-tooltip [role='option']"
    );
    if (!nativePopup) return;
    event.preventDefault();
    event.stopImmediatePropagation();
  }

  document.addEventListener("keydown", suppressNativeCitationCompletionKey, true);

  function emitState() {
    scheduledState = false;
    const state = getEditorState();
    if (!state) return;
    updateNativeCitationAutocomplete(state);
    const fingerprint = `${state.fileName}\n${state.cursorIndex}\n${state.value.length}\n${state.value.slice(Math.max(0, state.cursorIndex - 180), state.cursorIndex + 40)}`;
    lastStateFingerprint = fingerprint;
    window.dispatchEvent(
      new CustomEvent(STATE_EVENT, { detail: JSON.stringify(state) })
    );
  }

  function scheduleState() {
    if (scheduledState) return;
    scheduledState = true;
    window.requestAnimationFrame(emitState);
  }

  function cleanupCodeMirrorBinding() {
    if (typeof cmCleanup === "function") cmCleanup();
    cmCleanup = null;
  }

  function bindCodeMirror(view) {
    cleanupCodeMirrorBinding();
    const content = view.contentDOM || view.dom?.querySelector?.(".cm-content") || document.querySelector(".cm-content");
    const root = view.dom || content?.closest?.(".cm-editor") || document.querySelector(".cm-editor");
    const events = ["input", "keyup", "mouseup", "click", "focus", "paste", "cut", "compositionend"];
    const listener = () => scheduleState();
    for (const eventName of events) content?.addEventListener(eventName, listener, true);
    const selectionListener = () => {
      const selection = document.getSelection();
      if (selection?.anchorNode && content?.contains(selection.anchorNode)) scheduleState();
    };
    document.addEventListener("selectionchange", selectionListener, true);
    const observer = new MutationObserver(scheduleState);
    if (root) observer.observe(root, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ["aria-selected"] });
    cmCleanup = () => {
      for (const eventName of events) content?.removeEventListener(eventName, listener, true);
      document.removeEventListener("selectionchange", selectionListener, true);
      observer.disconnect();
    };
  }

  function bindEditor(found) {
    if (!found?.editor) return;
    if (found.editor === editor && found.kind === editorKind) return;

    if (editorKind === "ace" && boundSession) {
      try { boundSession.off("change", scheduleState); } catch (_error) {}
    }
    cleanupCodeMirrorBinding();
    editor = found.editor;
    editorKind = found.kind;
    boundSession = null;

    if (editorKind === "codemirror") {
      bindCodeMirror(editor);
      scheduleState();
      return;
    }

    bindSession(editor.getSession());
    editor.selection.on("changeCursor", scheduleState);
    editor.selection.on("changeSelection", scheduleState);
    editor.on("changeSession", () => {
      bindSession(editor.getSession());
      scheduleState();
    });
    editor.on("focus", scheduleState);
    editor.renderer.on("afterRender", scheduleState);
    scheduleState();
  }

  function bindSession(session) {
    if (!session || session === boundSession) return;
    if (boundSession) boundSession.off("change", scheduleState);
    boundSession = session;
    boundSession.on("change", scheduleState);
  }

  function replaceRange(start, end, text) {
    if (!editor) return false;
    if (editorKind === "codemirror") {
      if (codeMirrorReadOnly(editor)) return false;
      const docLength = editor.state.doc.length;
      const from = Math.max(0, Math.min(Number(start) || 0, docLength));
      const to = Math.max(from, Math.min(Number(end) || 0, docLength));
      const insertion = String(text ?? "");
      editor.dispatch({
        changes: { from, to, insert: insertion },
        selection: { anchor: from + insertion.length },
        scrollIntoView: true
      });
      editor.focus();
      scheduleState();
      return true;
    }

    if (editor.getReadOnly()) return false;
    const session = editor.getSession();
    const startPosition = session.doc.indexToPosition(start, 0);
    const endPosition = session.doc.indexToPosition(end, 0);
    const Range = window.ace?.require?.("ace/range")?.Range;
    if (!Range) return false;
    session.replace(
      new Range(startPosition.row, startPosition.column, endPosition.row, endPosition.column),
      text
    );
    const newPosition = session.doc.indexToPosition(start + text.length, 0);
    editor.selection.moveCursorToPosition(newPosition);
    editor.clearSelection();
    editor.focus();
    scheduleState();
    return true;
  }

  function findCitationTokenAtCursor() {
    const state = getEditorState();
    if (!state) return null;
    const beforeCursor = state.value.slice(0, state.cursorIndex);
    const match = beforeCursor.match(CITE_COMMAND);
    if (!match) return null;
    const completeArgument = match[1];
    const lastComma = completeArgument.lastIndexOf(",");
    const rawFragmentBeforeCursor = completeArgument.slice(lastComma + 1);
    const leadingWhitespace = rawFragmentBeforeCursor.match(/^\s*/)?.[0] || "";
    const fragmentStart = state.cursorIndex - rawFragmentBeforeCursor.length + leadingWhitespace.length;
    const fragmentAfterCursor = state.value.slice(state.cursorIndex).match(/^[^,{}\s]*/)?.[0] || "";
    return {
      start: fragmentStart,
      end: state.cursorIndex + fragmentAfterCursor.length,
      fragment: rawFragmentBeforeCursor.slice(leadingWhitespace.length) + fragmentAfterCursor
    };
  }

  function replaceCitationToken(text) {
    const token = findCitationTokenAtCursor();
    if (!token) return null;
    const success = replaceRange(token.start, token.end, text);
    return success ? token : null;
  }

  function gotoIndex(index, align = "center") {
    if (!editor) return false;
    if (editorKind === "codemirror") {
      const boundedIndex = Math.max(0, Math.min(Number(index) || 0, editor.state.doc.length));
      editor.dispatch({ selection: { anchor: boundedIndex }, scrollIntoView: true });
      editor.focus();
      if (align === "top") {
        const block = editor.lineBlockAt?.(boundedIndex);
        const scrollDOM = editor.scrollDOM || editor.dom?.querySelector?.(".cm-scroller");
        if (block && scrollDOM) {
          const setTop = () => { scrollDOM.scrollTop = Math.max(0, block.top); };
          setTop();
          window.requestAnimationFrame(setTop);
          window.setTimeout(setTop, 80);
        }
      }
      scheduleState();
      return true;
    }

    const session = editor.getSession();
    const boundedIndex = Math.max(0, Math.min(Number(index) || 0, session.getValue().length));
    const position = session.doc.indexToPosition(boundedIndex, 0);
    editor.selection.moveCursorToPosition(position);
    editor.clearSelection();
    editor.focus();

    const placeTargetAtTop = () => {
      const screenRow = typeof session.documentToScreenRow === "function"
        ? session.documentToScreenRow(position.row, position.column)
        : position.row;
      const lineHeight = editor.renderer?.lineHeight || 16;
      const scrollMarginTop = editor.renderer?.scrollMargin?.top || 0;
      const targetScrollTop = Math.max(0, screenRow * lineHeight - scrollMarginTop);
      editor.scrollToLine?.(position.row, false, false, () => {});
      if (typeof session.setScrollTop === "function") session.setScrollTop(targetScrollTop);
      editor.renderer?.scrollToY?.(targetScrollTop);
    };

    if (align === "top") {
      placeTargetAtTop();
      window.requestAnimationFrame(placeTargetAtTop);
      [50, 140, 300, 600, 1000].forEach((delayMs) => window.setTimeout(placeTargetAtTop, delayMs));
    } else if (align === "center" && typeof editor.scrollToLine === "function") {
      editor.scrollToLine(position.row, true, true, () => {});
    } else {
      editor.renderer?.scrollCursorIntoView?.(position, 0.5);
    }
    scheduleState();
    return true;
  }


  function normalizeProjectPath(value) {
    return String(value || "")
      .replace(/\\/g, "/")
      .replace(/^\.\//, "")
      .replace(/^\/+|\/+$/g, "")
      .toLowerCase();
  }

  function projectTreeItemName(item) {
    return String(
      item?.getAttribute?.("data-path") ||
      item?.getAttribute?.("data-file-path") ||
      item?.getAttribute?.("data-name") ||
      item?.getAttribute?.("aria-label") ||
      item?.getAttribute?.("title") ||
      item?.querySelector?.(
        ".item-name-button span, .item-name span, .entity-name span, [data-testid*=file-name]"
      )?.textContent ||
      item?.textContent ||
      ""
    ).trim();
  }

  function projectTreeRoots() {
    return [...new Set(document.querySelectorAll(
      '.file-tree-list, .file-tree, [role="tree"], [data-testid*="file-tree" i], [class*="file-tree" i], [aria-label*="file tree" i]'
    ))];
  }

  function projectTreeCandidates() {
    const selector = [
      '[role="treeitem"]',
      '[data-path]',
      '[data-file-path]',
      '[data-name]',
      '.item-name-button',
      '.item-name',
      '.entity-name',
      'button[aria-label]',
      'button[title]'
    ].join(',');
    const items = [];
    for (const root of projectTreeRoots()) items.push(root, ...root.querySelectorAll(selector));
    return [...new Set(items)];
  }

  function projectTreeCandidateNames(item) {
    const values = [
      item?.getAttribute?.("data-path"),
      item?.getAttribute?.("data-file-path"),
      item?.getAttribute?.("data-name"),
      item?.getAttribute?.("aria-label"),
      item?.getAttribute?.("title"),
      projectTreeItemName(item)
    ];
    const names = new Set();
    for (const value of values) {
      const text = normalizeProjectPath(value);
      if (!text) continue;
      names.add(text);
      const match = text.match(/(?:^|[\s:/])([^\s:/]+\.[a-z0-9]+)(?:$|[\s,;])/i);
      if (match?.[1]) names.add(normalizeProjectPath(match[1]));
    }
    return [...names];
  }

  function canonicalProjectTreeItem(item) {
    if (!item) return null;
    return item.closest?.(
      '[role="treeitem"], [data-doc-id], [data-document-id], [data-entity-id], ' +
      '[data-file-id], [data-path], [data-file-path], [data-name]'
    ) || item;
  }

  function findProjectTreeItem(fileName) {
    const target = normalizeProjectPath(fileName);
    const targetBase = target.split("/").pop();
    let baseMatch = null;
    for (const rawItem of projectTreeCandidates()) {
      const item = canonicalProjectTreeItem(rawItem);
      const names = projectTreeCandidateNames(item);
      if (names.some((name) => name === target || name.endsWith(`/` + target))) return item;
      if (!baseMatch && names.some((name) => name.split("/").pop() === targetBase)) baseMatch = item;
    }
    return baseMatch;
  }

  function looksLikeEntityId(value) {
    return /^[a-f0-9]{24}$/i.test(String(value || "").trim());
  }

  function entityIdFromObject(value, targetName, depth = 0, seen = new Set()) {
    if (!value || depth > 6 || (typeof value !== "object" && typeof value !== "function")) return "";
    if (seen.has(value)) return "";
    seen.add(value);

    const target = normalizeProjectPath(targetName);
    const targetBase = target.split("/").pop();
    let objectName = "";
    try {
      objectName = normalizeProjectPath(
        value.path || value.filePath || value.fullPath || value.name || value.fileName || value.entityName || ""
      );
    } catch (_error) {}
    const nameMatches = Boolean(objectName) && (
      objectName === target ||
      objectName.endsWith(`/${target}`) ||
      objectName.split("/").pop() === targetBase
    );

    if (nameMatches) {
      for (const key of ["_id", "id", "doc_id", "docId", "document_id", "documentId", "entity_id", "entityId"]) {
        try {
          const candidate = value[key];
          if (looksLikeEntityId(candidate)) return String(candidate);
        } catch (_error) {}
      }
    }

    if (Array.isArray(value)) {
      for (const nested of value.slice(0, 500)) {
        const result = entityIdFromObject(nested, targetName, depth + 1, seen);
        if (result) return result;
      }
      return "";
    }

    const preferredKeys = [
      "entity", "entities", "doc", "docs", "document", "documents", "file", "files",
      "folder", "folders", "children", "items", "root", "rootFolder", "projectRoot",
      "fileTree", "project", "item", "node", "props", "memoizedProps", "pendingProps",
      "return", "child", "sibling", "stateNode", "data", "value"
    ];
    for (const key of preferredKeys) {
      try {
        const result = entityIdFromObject(value[key], targetName, depth + 1, seen);
        if (result) return result;
      } catch (_error) {}
    }

    if (depth >= 3) return "";
    let keys = [];
    try { keys = Object.getOwnPropertyNames(value).slice(0, 100); } catch (_error) { return ""; }
    for (const key of keys) {
      if (preferredKeys.includes(key) || key === "window" || key === "parent" || key === "top") continue;
      try {
        const nested = value[key];
        if (!nested || (typeof nested !== "object" && typeof nested !== "function")) continue;
        const result = entityIdFromObject(nested, targetName, depth + 1, seen);
        if (result) return result;
      } catch (_error) {}
    }
    return "";
  }

  function projectTreeDocumentId(item, fileName) {
    if (!item) return "";

    // The visible file-name element is often nested below the actual tree item.
    // Inspect every ancestor for document/entity IDs before consulting framework
    // internals. Older CollabTeX builds commonly expose the ID only on the row.
    let attributeNode = canonicalProjectTreeItem(item) || item;
    while (attributeNode) {
      for (const attribute of [
        "data-doc-id", "data-document-id", "data-entity-id", "data-file-id", "data-id", "id"
      ]) {
        const value = attributeNode.getAttribute?.(attribute);
        if (looksLikeEntityId(value)) return String(value);
      }
      try {
        for (const attribute of [...(attributeNode.attributes || [])]) {
          if (looksLikeEntityId(attribute?.value)) return String(attribute.value);
        }
      } catch (_error) {}
      attributeNode = attributeNode.parentElement;
    }

    try {
      const angular = globalThis.angular;
      if (angular?.element) {
        let current = item;
        while (current) {
          const wrapped = angular.element(current);
          for (const scope of [wrapped.scope?.(), wrapped.isolateScope?.()]) {
            const result = entityIdFromObject(scope, fileName);
            if (result) return result;
          }
          current = current.parentElement;
        }
      }
    } catch (_error) {}

    let current = item;
    while (current) {
      let keys = [];
      try { keys = Object.getOwnPropertyNames(current); } catch (_error) {}
      for (const key of keys) {
        if (!key.startsWith("__reactProps$") && !key.startsWith("__reactFiber$") && !key.startsWith("__reactInternalInstance$")) continue;
        try {
          const result = entityIdFromObject(current[key], fileName);
          if (result) return result;
        } catch (_error) {}
      }
      current = current.parentElement;
    }
    return "";
  }

  function projectDocumentIdFromModels(fileName) {
    const roots = [
      globalThis._ide?.project?.rootFolder,
      globalThis._ide?.project?.rootDoc,
      globalThis._ide?.project,
      globalThis._ide?.rootFolder,
      globalThis._ide?.fileTree,
      globalThis._ide,
      globalThis.ide?.project?.rootFolder,
      globalThis.ide?.project,
      globalThis.ide?.rootFolder,
      globalThis.ide?.fileTree,
      globalThis.ide,
      globalThis.project,
      globalThis.__INITIAL_STATE__,
      globalThis.__APOLLO_STATE__
    ].filter(Boolean);

    try {
      const angular = globalThis.angular;
      if (angular?.element) {
        const body = angular.element(document.body);
        roots.push(body.scope?.(), body.isolateScope?.());
      }
    } catch (_error) {}

    for (const root of roots.filter(Boolean)) {
      try {
        const result = entityIdFromObject(root, fileName, 0, new Set());
        if (result) return result;
      } catch (_error) {}
    }
    return "";
  }

  function currentProjectId() {
    const pathMatch = window.location.pathname.match(/\/project\/([a-f0-9]{24})(?:\/|$)/i);
    if (pathMatch) return pathMatch[1];
    for (const value of [
      globalThis._ide?.project_id,
      globalThis._ide?.projectId,
      globalThis._ide?.project?._id,
      globalThis._ide?.project?.id,
      globalThis.ide?.project_id,
      globalThis.ide?.projectId
    ]) {
      if (looksLikeEntityId(value)) return String(value);
    }
    return "";
  }

  function projectFileReadDiagnostics(fileName) {
    const target = normalizeProjectPath(fileName);
    const targetBase = target.split("/").pop();
    const item = findProjectTreeItem(fileName);
    const treeDocumentId = projectTreeDocumentId(item, fileName);
    const modelDocumentId = projectDocumentIdFromModels(fileName);
    const visibleCandidates = [];
    for (const candidate of projectTreeCandidates()) {
      const names = projectTreeCandidateNames(candidate);
      if (!names.some((name) => /\.(?:bib|tex)$/i.test(name.split("/").pop() || ""))) continue;
      visibleCandidates.push({
        names: names.slice(0, 8),
        matched: names.some((name) => name === target || name.endsWith(`/${target}`) || name.split("/").pop() === targetBase),
        documentId: projectTreeDocumentId(candidate, names[0] || fileName) || ""
      });
      if (visibleCandidates.length >= 100) break;
    }
    return {
      requestedFileName: String(fileName || ""),
      normalizedRequestedFileName: target,
      targetBaseName: targetBase,
      pageUrl: window.location.href,
      readyState: document.readyState,
      selectedEditorFile: getSelectedFileName() || "",
      projectId: currentProjectId(),
      fileTreeRootCount: projectTreeRoots().length,
      fileTreeCandidateCount: projectTreeCandidates().length,
      matchedTreeItem: Boolean(item),
      matchedTreeItemName: projectTreeItemName(item),
      treeDocumentId,
      modelDocumentId,
      resolvedDocumentId: treeDocumentId || modelDocumentId || "",
      collaborationSocketFound: Boolean(pageSocket()),
      visibleProjectTextFiles: visibleCandidates
    };
  }

  function attachDiagnostics(error, diagnostics) {
    const value = error instanceof Error ? error : new Error(String(error || "Unknown error"));
    value.ctcaDiagnostics = diagnostics;
    return value;
  }

  function findZipEndOfCentralDirectory(bytes) {
    const minimumOffset = Math.max(0, bytes.length - 65557);
    for (let offset = bytes.length - 22; offset >= minimumOffset; offset -= 1) {
      if (
        bytes[offset] === 0x50 && bytes[offset + 1] === 0x4b &&
        bytes[offset + 2] === 0x05 && bytes[offset + 3] === 0x06
      ) return offset;
    }
    return -1;
  }

  function decodeZipFileName(bytes) {
    try { return new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
    catch (_error) { return new TextDecoder("windows-1252").decode(bytes); }
  }

  async function inflateZipEntry(bytes, method) {
    if (method === 0) return bytes;
    if (method !== 8) throw new Error(`Unsupported ZIP compression method ${method}.`);
    if (typeof DecompressionStream !== "function") {
      throw new Error("This browser does not provide the deflate decompressor required for the project-ZIP fallback.");
    }
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }

  async function readProjectFileFromZip(projectId, fileName, timeoutMs = 90000) {
    const diagnostics = {
      method: "project-zip",
      projectId,
      requestedFileName: String(fileName || ""),
      attemptedUrls: [],
      archiveSize: 0,
      matchingEntries: []
    };
    const urls = [
      `/project/${encodeURIComponent(projectId)}/download/zip`,
      `/project/${encodeURIComponent(projectId)}/download/zip?source=editor`
    ];
    let archiveBuffer = null;
    let lastError = null;
    for (const url of urls) {
      diagnostics.attemptedUrls.push(url);
      const controller = new AbortController();
      const timeout = window.setTimeout(() => controller.abort(), Math.max(10000, Number(timeoutMs) || 90000));
      try {
        const response = await fetch(url, {
          method: "GET",
          credentials: "same-origin",
          cache: "no-store",
          signal: controller.signal,
          headers: { Accept: "application/zip, application/octet-stream;q=0.9" }
        });
        if (!response.ok) {
          lastError = new Error(`HTTP ${response.status} while downloading the project source archive.`);
          continue;
        }
        const contentType = String(response.headers.get("content-type") || "").toLowerCase();
        const buffer = await response.arrayBuffer();
        const bytes = new Uint8Array(buffer);
        if (bytes.length < 4 || bytes[0] !== 0x50 || bytes[1] !== 0x4b) {
          lastError = new Error(`The project source endpoint returned ${contentType || "non-ZIP data"} instead of a ZIP archive.`);
          continue;
        }
        archiveBuffer = buffer;
        diagnostics.archiveSize = bytes.length;
        diagnostics.url = url;
        break;
      } catch (error) {
        lastError = error?.name === "AbortError"
          ? new Error("Timed out while downloading the project source archive.")
          : error;
      } finally {
        window.clearTimeout(timeout);
      }
    }
    if (!archiveBuffer) throw attachDiagnostics(lastError || new Error("The project source archive could not be downloaded."), diagnostics);

    const bytes = new Uint8Array(archiveBuffer);
    const view = new DataView(archiveBuffer);
    const eocdOffset = findZipEndOfCentralDirectory(bytes);
    if (eocdOffset < 0) throw attachDiagnostics(new Error("The project source archive has no readable central directory."), diagnostics);
    const entryCount = view.getUint16(eocdOffset + 10, true);
    const centralOffset = view.getUint32(eocdOffset + 16, true);
    diagnostics.entryCount = entryCount;
    diagnostics.centralDirectoryOffset = centralOffset;

    const target = normalizeProjectPath(fileName);
    const targetBase = target.split("/").pop();
    const matches = [];
    let offset = centralOffset;
    for (let index = 0; index < entryCount && offset + 46 <= bytes.length; index += 1) {
      if (view.getUint32(offset, true) !== 0x02014b50) break;
      const method = view.getUint16(offset + 10, true);
      const compressedSize = view.getUint32(offset + 20, true);
      const uncompressedSize = view.getUint32(offset + 24, true);
      const nameLength = view.getUint16(offset + 28, true);
      const extraLength = view.getUint16(offset + 30, true);
      const commentLength = view.getUint16(offset + 32, true);
      const localOffset = view.getUint32(offset + 42, true);
      const name = decodeZipFileName(bytes.slice(offset + 46, offset + 46 + nameLength)).replace(/\\/g, "/");
      const normalized = normalizeProjectPath(name);
      if (normalized === target || normalized.endsWith(`/${target}`) || normalized.split("/").pop() === targetBase) {
        matches.push({ name, normalized, method, compressedSize, uncompressedSize, localOffset });
      }
      offset += 46 + nameLength + extraLength + commentLength;
    }
    diagnostics.matchingEntries = matches.map(({ name, normalized, method, compressedSize, uncompressedSize }) => ({
      name, normalized, method, compressedSize, uncompressedSize
    }));
    if (!matches.length) {
      throw attachDiagnostics(new Error(`${fileName} was not found in the downloaded project source archive.`), diagnostics);
    }
    const exactMatches = matches.filter((entry) => entry.normalized === target || entry.normalized.endsWith(`/${target}`));
    const candidates = exactMatches.length ? exactMatches : matches;
    if (candidates.length > 1) {
      throw attachDiagnostics(new Error(`The project archive contains multiple files matching ${fileName}; the background reader cannot choose safely.`), diagnostics);
    }
    const entry = candidates[0];
    if (entry.localOffset + 30 > bytes.length || view.getUint32(entry.localOffset, true) !== 0x04034b50) {
      throw attachDiagnostics(new Error(`The ZIP entry for ${entry.name} has an invalid local header.`), diagnostics);
    }
    const localNameLength = view.getUint16(entry.localOffset + 26, true);
    const localExtraLength = view.getUint16(entry.localOffset + 28, true);
    const dataStart = entry.localOffset + 30 + localNameLength + localExtraLength;
    const dataEnd = dataStart + entry.compressedSize;
    if (dataEnd > bytes.length) throw attachDiagnostics(new Error(`The ZIP entry for ${entry.name} is truncated.`), diagnostics);
    const uncompressed = await inflateZipEntry(bytes.slice(dataStart, dataEnd), entry.method);
    const text = new TextDecoder("utf-8").decode(uncompressed);
    diagnostics.resolvedFileName = entry.name;
    diagnostics.textLength = text.length;
    diagnostics.uncompressedSize = uncompressed.length;
    return { text, fileName: entry.name, method: "project-zip", diagnostics };
  }

  function textFromDocumentPayload(payload) {
    if (typeof payload === "string") return payload;
    if (Array.isArray(payload) && payload.every((line) => typeof line === "string")) return payload.join("\n");
    if (!payload || typeof payload !== "object") return null;
    for (const key of ["lines", "docLines", "contentLines"]) {
      if (Array.isArray(payload[key]) && payload[key].every((line) => typeof line === "string")) {
        return payload[key].join("\n");
      }
    }
    for (const key of ["text", "content", "value", "source"]) {
      if (typeof payload[key] === "string") return payload[key];
    }
    for (const key of ["doc", "document", "data", "result"]) {
      const nested = textFromDocumentPayload(payload[key]);
      if (nested !== null) return nested;
    }
    return null;
  }

  async function readDocumentThroughHttp(projectId, documentId, timeoutMs = 15000) {
    const urls = [
      `/project/${encodeURIComponent(projectId)}/doc/${encodeURIComponent(documentId)}?format=json`,
      `/project/${encodeURIComponent(projectId)}/doc/${encodeURIComponent(documentId)}`
    ];
    let lastError = null;
    for (const url of urls) {
      const controller = new AbortController();
      const timeout = window.setTimeout(() => controller.abort(), Math.max(3000, Number(timeoutMs) || 15000));
      try {
        const response = await fetch(url, {
          method: "GET",
          credentials: "same-origin",
          cache: "no-store",
          signal: controller.signal,
          headers: { Accept: "application/json, text/plain;q=0.9" }
        });
        if (!response.ok) {
          lastError = new Error(`HTTP ${response.status} while reading the project document`);
          continue;
        }
        const raw = await response.text();
        const contentType = String(response.headers.get("content-type") || "").toLowerCase();
        if (/text\/html/.test(contentType) || /^\s*<!doctype\s+html|^\s*<html/i.test(raw)) {
          lastError = new Error("The project-document endpoint returned an HTML page instead of document text.");
          continue;
        }
        let payload = raw;
        try { payload = JSON.parse(raw); } catch (_error) {}
        const text = textFromDocumentPayload(payload);
        if (text !== null) return decodePackedUtf8Text(String(text));
        lastError = new Error("The project document response did not contain text lines.");
      } catch (error) {
        lastError = error?.name === "AbortError"
          ? new Error("Timed out while reading the project document through HTTP.")
          : error;
      } finally {
        window.clearTimeout(timeout);
      }
    }
    throw lastError || new Error("The project document could not be read through HTTP.");
  }

  function pageSocket() {
    const candidates = [
      globalThis._ide?.socket,
      globalThis._ide?.connection?.socket,
      globalThis.ide?.socket,
      globalThis.socket
    ];
    return candidates.find((candidate) => candidate && typeof candidate.emit === "function") || null;
  }

  function readDocumentThroughSocket(documentId, timeoutMs = 45000) {
    const socket = pageSocket();
    if (!socket) return Promise.reject(new Error("The ColLabTeX collaboration socket was not found."));
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (error, text = null) => {
        if (settled) return;
        settled = true;
        window.clearTimeout(timeout);
        try { socket.emit("leaveDoc", documentId); } catch (_error) {}
        if (error) reject(error);
        else resolve(text);
      };
      const timeout = window.setTimeout(() => finish(new Error("Timed out while reading the project document in the background.")), timeoutMs);
      try {
        socket.emit("joinDoc", documentId, { encodeRanges: true }, (...args) => {
          const first = args[0];
          const explicitError = first instanceof Error || (
            args.length > 1 && typeof first === "string" && Boolean(first)
          ) ? first : null;
          if (explicitError) {
            finish(explicitError instanceof Error ? explicitError : new Error(String(explicitError)));
            return;
          }
          for (const value of args) {
            const text = textFromDocumentPayload(value);
            if (text !== null) {
              finish(null, decodePackedUtf8Text(String(text)));
              return;
            }
          }
          finish(new Error("The collaboration server returned no document text."));
        });
      } catch (error) {
        finish(error);
      }
    });
  }

  function documentVersionFromPayload(payload, depth = 0, seen = new Set()) {
    if (Number.isInteger(payload) && payload >= 0) return payload;
    if (!payload || depth > 5 || typeof payload !== "object") return null;
    if (seen.has(payload)) return null;
    seen.add(payload);

    for (const key of ["v", "version", "docVersion", "documentVersion", "otVersion"]) {
      try {
        const candidate = Number(payload[key]);
        if (Number.isInteger(candidate) && candidate >= 0) return candidate;
      } catch (_error) {}
    }
    for (const key of ["doc", "document", "data", "result", "meta", "metadata"]) {
      try {
        const version = documentVersionFromPayload(payload[key], depth + 1, seen);
        if (version !== null) return version;
      } catch (_error) {}
    }
    return null;
  }

  function collaborationCallbackError(args, { allowLeadingText = false } = {}) {
    const first = args?.[0];
    if (first instanceof Error) return first;
    if (first && typeof first === "object" && typeof first.error === "string" && first.error) {
      return new Error(first.error);
    }
    if (!allowLeadingText && typeof first === "string" && first.trim()) {
      return new Error(first);
    }
    return null;
  }

  function decodePackedUtf8Text(text) {
    const source = String(text ?? "");
    if (!source || [...source].some((character) => character.codePointAt(0) > 255)) return source;
    try {
      const bytes = Uint8Array.from(source, (character) => character.charCodeAt(0));
      return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch (_error) {
      return source;
    }
  }

  function callbackDocumentText(args, expectedText = null) {
    const expected = expectedText === null ? null : String(expectedText);
    const candidates = [];
    for (const value of args || []) {
      if (Array.isArray(value) && value.every((line) => typeof line === "string")) {
        const raw = value.join("\n");
        candidates.push(raw, decodePackedUtf8Text(raw));
      }
      const text = textFromDocumentPayload(value);
      if (text !== null) candidates.push(String(text), decodePackedUtf8Text(text));
    }
    if (expected !== null) {
      const exact = candidates.find((candidate) => candidate === expected);
      if (exact !== undefined) return exact;
    }
    return candidates.find((candidate) => typeof candidate === "string") ?? null;
  }

  function writeDocumentThroughSocket(documentId, expectedText, nextText, timeoutMs = 90000) {
    const socket = pageSocket();
    if (!socket) return Promise.reject(new Error("The ColLabTeX collaboration socket was not found."));

    return new Promise((resolve, reject) => {
      let settled = false;
      let updateStarted = false;
      const finish = (error, result = null) => {
        if (settled) return;
        settled = true;
        window.clearTimeout(timeout);
        try { socket.emit("leaveDoc", documentId); } catch (_error) {}
        if (error) reject(error);
        else resolve(result);
      };
      const timeout = window.setTimeout(
        () => finish(new Error(updateStarted
          ? "Timed out while writing the project document in the background."
          : "Timed out while joining the project document for background writing.")),
        timeoutMs
      );

      try {
        socket.emit("joinDoc", documentId, { encodeRanges: true }, (...args) => {
          const joinError = collaborationCallbackError(args);
          if (joinError) {
            finish(joinError);
            return;
          }

          const currentText = callbackDocumentText(args, expectedText);
          let version = null;
          for (const value of args) {
            if (version === null) version = documentVersionFromPayload(value);
          }
          if (currentText === null) {
            finish(new Error("The collaboration server returned no document text for background writing."));
            return;
          }
          if (String(currentText) !== String(expectedText)) {
            finish(new Error("The project document changed before the background update could be applied."));
            return;
          }
          if (String(currentText) === String(nextText)) {
            finish(null, { changed: false, text: String(currentText), version });
            return;
          }
          if (!Number.isInteger(version) || version < 0) {
            finish(new Error("The collaboration server did not expose a document version for background writing."));
            return;
          }

          const operation = [];
          if (String(currentText).length) operation.push({ p: 0, d: String(currentText) });
          if (String(nextText).length) operation.push({ p: 0, i: String(nextText) });
          const update = { doc: documentId, op: operation, v: version };
          updateStarted = true;

          try {
            socket.emit("applyOtUpdate", documentId, update, (...ackArgs) => {
              const updateError = collaborationCallbackError(ackArgs);
              if (updateError) {
                finish(updateError);
                return;
              }
              finish(null, { changed: true, text: String(nextText), version: version + 1 });
            });
          } catch (error) {
            finish(error);
          }
        });
      } catch (error) {
        finish(error);
      }
    });
  }

  async function writeProjectTextFile(fileName, expectedText, nextText, timeoutMs = 90000) {
    const item = findProjectTreeItem(fileName);
    const documentId = projectTreeDocumentId(item, fileName) || projectDocumentIdFromModels(fileName);
    if (!documentId) throw new Error(`Could not determine the ColLabTeX document ID for ${fileName}.`);
    const resolvedFileName = projectTreeItemName(item) || fileName;
    const expected = String(expectedText ?? "");
    const target = String(nextText ?? "");
    const result = await writeDocumentThroughSocket(documentId, expected, target, timeoutMs);
    // `applyOtUpdate` acknowledges only after the collaboration server has
    // accepted the versioned operation. Rejoining the same large document for
    // synchronous byte-for-byte verification can be throttled for minutes even
    // though the write already succeeded, leaving synchronization apparently
    // stuck. Treat the OT acknowledgement as the transaction boundary. The
    // next normal background parse remains an independent end-to-end check.
    return {
      ...result,
      text: target,
      fileName: resolvedFileName,
      documentId,
      method: "socket-ot",
      verification: result.changed ? "ot-acknowledgement" : "unchanged"
    };
  }

  async function readProjectTextFile(fileName, timeoutMs = 90000) {
    const startedAt = Date.now();
    const diagnostics = projectFileReadDiagnostics(fileName);
    diagnostics.requestedTimeoutMs = Math.max(10000, Number(timeoutMs) || 90000);
    diagnostics.attempts = [];
    const item = findProjectTreeItem(fileName);
    const documentId = diagnostics.resolvedDocumentId;
    const resolvedFileName = projectTreeItemName(item) || fileName;
    const totalTimeout = diagnostics.requestedTimeoutMs;
    const deadline = Date.now() + totalTimeout;

    if (documentId) {
      const socketStartedAt = Date.now();
      try {
        const remaining = Math.max(5000, deadline - Date.now());
        const text = await readDocumentThroughSocket(documentId, Math.min(45000, remaining));
        diagnostics.attempts.push({ method: "socket", ok: true, durationMs: Date.now() - socketStartedAt, textLength: text.length });
        diagnostics.durationMs = Date.now() - startedAt;
        return { text, fileName: resolvedFileName, documentId, method: "socket", diagnostics };
      } catch (error) {
        diagnostics.attempts.push({
          method: "socket",
          ok: false,
          durationMs: Date.now() - socketStartedAt,
          message: error?.message || String(error),
          stack: error?.stack || ""
        });
      }

      const projectId = diagnostics.projectId;
      if (projectId && Date.now() < deadline) {
        const httpStartedAt = Date.now();
        try {
          const remaining = Math.max(5000, deadline - Date.now());
          const text = await readDocumentThroughHttp(projectId, documentId, Math.min(30000, remaining));
          diagnostics.attempts.push({ method: "http", ok: true, durationMs: Date.now() - httpStartedAt, textLength: text.length });
          diagnostics.durationMs = Date.now() - startedAt;
          return { text, fileName: resolvedFileName, documentId, method: "http", diagnostics };
        } catch (error) {
          diagnostics.attempts.push({
            method: "http",
            ok: false,
            durationMs: Date.now() - httpStartedAt,
            message: error?.message || String(error),
            stack: error?.stack || ""
          });
        }
      }
    } else {
      diagnostics.attempts.push({
        method: "document-id-resolution",
        ok: false,
        message: `Could not determine the ColLabTeX document ID for ${fileName}.`
      });
    }

    // A source-archive fetch does not need the document ID and does not change
    // the visible editor or file-tree selection. It is therefore the robust
    // final background fallback for deployments that do not expose their file
    // model or collaboration socket to page scripts.
    if (diagnostics.projectId && Date.now() < deadline) {
      const zipStartedAt = Date.now();
      try {
        const remaining = Math.max(10000, deadline - Date.now());
        const result = await readProjectFileFromZip(diagnostics.projectId, fileName, remaining);
        diagnostics.attempts.push({
          method: "project-zip",
          ok: true,
          durationMs: Date.now() - zipStartedAt,
          textLength: result.text.length,
          resolvedFileName: result.fileName,
          zipDiagnostics: result.diagnostics
        });
        diagnostics.durationMs = Date.now() - startedAt;
        return {
          text: result.text,
          fileName: result.fileName || resolvedFileName,
          documentId: documentId || "",
          method: "project-zip",
          diagnostics
        };
      } catch (error) {
        diagnostics.attempts.push({
          method: "project-zip",
          ok: false,
          durationMs: Date.now() - zipStartedAt,
          message: error?.message || String(error),
          stack: error?.stack || "",
          zipDiagnostics: error?.ctcaDiagnostics || null
        });
      }
    }

    diagnostics.durationMs = Date.now() - startedAt;
    const messages = diagnostics.attempts
      .filter((attempt) => attempt.ok === false && attempt.message)
      .map((attempt) => `${attempt.method}: ${attempt.message}`);
    throw attachDiagnostics(
      new Error(`Could not read ${resolvedFileName} in the background.${messages.length ? ` ${messages.join("; ")}` : ""}`),
      diagnostics
    );
  }

  function respond(requestId, ok, payload = {}) {
    window.dispatchEvent(
      new CustomEvent(RESPONSE_EVENT, {
        detail: JSON.stringify({ requestId, ok, ...payload })
      })
    );
  }

  window.addEventListener(REQUEST_EVENT, (event) => {
    let request = {};
    try {
      request = JSON.parse(String(event.detail || "{}"));
    } catch (_error) {
      return;
    }
    const requestId = request.requestId;

    try {
      if (!editor) bindEditor(findEditor());

      if (request.type === "ping") {
        respond(requestId, Boolean(editor), { ready: Boolean(editor), editorKind });
        return;
      }
      if (request.type === "getState") {
        const state = getEditorState();
        respond(requestId, Boolean(state), { state });
        return;
      }
      if (request.type === "readProjectTextFile") {
        readProjectTextFile(
          String(request.fileName || ""),
          Math.max(1000, Number(request.timeoutMs) || 60000)
        )
          .then((result) => respond(requestId, true, result))
          .catch((error) => respond(requestId, false, {
            error: error?.message || String(error),
            diagnostics: error?.ctcaDiagnostics || null
          }));
        return;
      }
      if (request.type === "writeProjectTextFile") {
        writeProjectTextFile(
          String(request.fileName || ""),
          String(request.expectedText ?? ""),
          String(request.text ?? ""),
          Math.max(1000, Number(request.timeoutMs) || 90000)
        )
          .then((result) => respond(requestId, true, result))
          .catch((error) => respond(requestId, false, { error: error?.message || String(error) }));
        return;
      }
      if (request.type === "replaceRange") {
        const success = replaceRange(Number(request.start), Number(request.end), String(request.text ?? ""));
        respond(requestId, success);
        return;
      }
      if (request.type === "replaceCitationToken") {
        const token = replaceCitationToken(String(request.text ?? ""));
        respond(requestId, Boolean(token), token ? { token } : {});
        return;
      }
      if (request.type === "getCoordinates") {
        const screen = indexToScreen(Number(request.index));
        respond(requestId, Boolean(screen), { screen });
        return;
      }
      if (request.type === "gotoIndex") {
        const legacyAlignment = request.center === false ? "nearest" : "center";
        const alignment = ["top", "center", "nearest"].includes(request.align) ? request.align : legacyAlignment;
        const success = gotoIndex(Number(request.index), alignment);
        respond(requestId, success);
        return;
      }
      if (request.type === "focus") {
        editor?.focus();
        respond(requestId, Boolean(editor));
        return;
      }
      if (request.type === "hideAutocomplete") {
        hideNativeAutocomplete();
        respond(requestId, Boolean(editor));
        return;
      }
      respond(requestId, false, { error: `Unknown request type: ${request.type}` });
    } catch (error) {
      respond(requestId, false, { error: error?.message || String(error) });
    }
  });

  const observer = new MutationObserver((mutations) => {
    const found = findEditor();
    if (found) bindEditor(found);
    if (IS_OVERLEAF && document.body?.classList.contains("ctca-overleaf-cite-context")) {
      for (const mutation of mutations) {
        for (const node of mutation.addedNodes || []) markNativeCitationPopup(node);
      }
      hideNativeAutocomplete();
    }
  });
  observer.observe(document.documentElement, { childList: true, subtree: true });

  if (IS_OVERLEAF) {
    nativePopupObserver = new MutationObserver((mutations) => {
      if (!document.body?.classList.contains("ctca-overleaf-cite-context")) return;
      for (const mutation of mutations) {
        for (const node of mutation.addedNodes || []) markNativeCitationPopup(node);
      }
      hideNativeAutocomplete();
    });
    nativePopupObserver.observe(document.documentElement, { childList: true, subtree: true });
  }

  const poll = window.setInterval(() => {
    const found = findEditor();
    if (found) bindEditor(found);
    if (editorKind === "codemirror" && editor) {
      const state = getEditorState();
      if (state) {
        const fingerprint = `${state.fileName}\n${state.cursorIndex}\n${state.value.length}\n${state.value.slice(Math.max(0, state.cursorIndex - 180), state.cursorIndex + 40)}`;
        if (fingerprint !== lastStateFingerprint) scheduleState();
      }
    }
  }, 250);

  window.addEventListener("pagehide", () => {
    window.clearInterval(poll);
    cleanupCodeMirrorBinding();
    observer.disconnect();
    nativePopupObserver?.disconnect();
    document.removeEventListener("keydown", suppressNativeCitationCompletionKey, true);
  }, { once: true });
})();
