/* SPDX-License-Identifier: CC-BY-NC-SA-4.0 */

(() => {
  "use strict";

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
