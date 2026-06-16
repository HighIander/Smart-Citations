## Version 1.11.1

- Closes the native Collabtex upload modal before opening extension-owned Nextcloud dialogs, preventing the native modal focus trap from blocking text input.
- Hides the Smart Citations directory and bibliography synchronization controls in project-file-only Nextcloud settings.
- Makes the Nextcloud file picker wider and responsive without clipping its directory listing.
- Positions linked-file cloud refresh controls at the right edge of the file name row and ellipsizes long names.
- Adds **Refresh from NextCloud** next to the visible file viewer's **Download** control for linked files.

## Version 1.10.7

## Version 1.10.8

- Places the Overleaf **bib** button in the stable top-right project action bar, next to the existing History, Layout, and Share controls.
- Reattaches the button automatically when Overleaf re-renders its React toolbar.


- Added full in-page activation on Overleaf project editors in addition to ColLabTeX.
- Added a CodeMirror 6 editor bridge for reading the active document, replacing citation keys, positioning the Smart Citations popup, opening project files, and applying BibTeX edits.
- Suppressed Overleaf's native citation autocomplete only while the cursor is inside a supported `\cite{...}` command, so it no longer competes with Smart Citations; other Overleaf completion lists remain available.
- Added Overleaf toolbar, selected-file, file-tree, source-loading, and new-file-dialog compatibility.
- The browser action now opens the in-page manager on an active Overleaf project tab as well as on ColLabTeX.

## Version 1.10.6

- New-project setup now explicitly asks whether the project bibliography should remain synchronized with the Smart Citations extension database, for both missing bibliographies and `sample.bib` projects.
- Added a separate **Sync database with Nextcloud** switch to the ColLabTeX bibliography-manager header, between the project-database switch and the cloud settings button. It is enabled only while Nextcloud is connected and is green only while synchronization is active.
- Reordered PDF attachment sources to **Nextcloud → Browser storage → Local disk link** in both manager views.

## Version 1.10.5

- Renamed the extension to **Smart Citations**.
- Added bulk **Use all from local** and **Use all from cloud** actions to Nextcloud conflict resolution.
- Global-database synchronization is now a per-project preference and defaults to disabled for every newly opened ColLabTeX project.
- Reworked startup initialization to wait for the actual main document, safely create or reuse the configured BibTeX file, verify ACE writes after the bridge response, and update the bibliography declaration only after the target file is ready.

- Nextcloud bibliography synchronization now compares normalized BibTeX content before reporting a conflict. Differences limited to field order, whitespace, DOI notation, tag/alias ordering, capitalization of identifiers, or local synchronization timestamps no longer create false conflicts.
- Every genuine Nextcloud conflict now includes a **Show all details** button with the complete browser, Nextcloud, and—when available—last synchronized entry data.
- The cloud settings icon is blue only while Nextcloud is reachable and bibliography synchronization is enabled.
- Retains the 1.10.2 sticky entry header and compact full-window PDF layout.

# Smart Citations 1.10.7

A Firefox 128+ and Chromium Manifest V3 extension for citation autocomplete and loss-safe BibTeX management on ColLabTeX and Overleaf.

## Installation

### Firefox testing

1. Extract the ZIP archive.
2. Open `about:debugging#/runtime/this-firefox`.
3. Select **Load Temporary Add-on…**.
4. Select `manifest.json`.
5. Reload the ColLabTeX or Overleaf project editor.

The supplied XPI is unsigned and intended for temporary/developer installation. Permanent installation in a standard Firefox build requires Mozilla signing.

### Chrome, Chromium, or Edge

1. Extract the ZIP archive.
2. Open the extensions page and enable developer mode.
3. Choose **Load unpacked**.
4. Select the extracted directory.
5. Reload the ColLabTeX or Overleaf project editor.



## Changes in 1.9.9

- Added a first-run bibliography setup assistant for new ColLabTeX projects. It is offered when the main document has no bibliography declaration or still references `sample.bib`.
- Existing global entries are copied into a newly created or existing `bibliography.bib`; the main document is updated to reference that file.
- When the global database is empty, the assistant requests a `.bib` file and offers a **Sync with global database** switch.
- Added matching empty-state actions in both bibliography manager views: **Upload a .bib file** and **Sync with existing Nextcloud backup**.
- Existing non-empty `bibliography.bib` files receive a browser-side safety backup before setup data is merged.
- A successful project import is confirmed by a green banner.
- Retains the 1.9.8 PDF improvements: comments are committed only with **Done**, the PDF pane fills the workspace, and the PDF pane can be maximized or restored.

## Changes in 1.9.8

- PDF comment text is committed only when **Done** is clicked; closing or switching comments discards uncommitted text.
- The PDF workspace fills the complete area above the manager status bar.
- Added an icon-only maximize/reduce control for the PDF workspace in both manager views.

## Changes in 1.9.7

- Replaced continuous project/global entry comparison with one pending-change flag per known ColLabTeX document in the global database.
- The background checks only the current document flag every 30 seconds. It does not read, merge, or write the project BibTeX file during that check.
- Global changes are written to a project `.bib` file only while that file is active, while the bibliography manager is open, or after selecting **Sync now**.
- Project changes are pushed to the global database only in those same contexts; changes made through temporary/background file access remain deferred.
- Added a red counter badge to the ColLabTeX **bib** button while global changes are waiting for that document.
- Added the banner **New bibliography entries need to be synced to your bib file. Sync now** when a document first receives a pending global-change flag.
- **Sync now** opens the configured BibTeX file, performs the bidirectional merge there, and clears only that document's pending flag after a successful collection.
- Pending global entries are available immediately in citation autocomplete before the project BibTeX file is written.
- Standalone-manager and Nextcloud changes mark all known documents as pending; a document synchronization clears only its own flag.
- Per-document pending flags remain local extension metadata and are not serialized into `global-bibliography.bib` on Nextcloud.

## Changes in 1.9.6

- Fixed project/global synchronization attempting to rewrite or remove large parts of a connected BibTeX file after initially filling the global database.
- Entry synchronization now preserves every citation key as an independent record; DOI is used only for explicit deletion tombstones.
- Global data is merged into a project by exact citation key first. DOI fallback is allowed only for an unambiguous one-to-one match and never renames the document citation key.
- Project entries absent from a merge result remain untouched. Only previously synchronized citation-key records selected by an explicit tombstone can be deleted.
- Category synchronization now marks only entries whose category metadata actually changed instead of serializing the entire bibliography.
- Applied the same citation-key-preserving behavior to `global-bibliography.bib` synchronization through Nextcloud.

## Changes in 1.9.4

- Reworked project/global synchronization so absence from the global database is never interpreted as deletion.
- Added explicit global deletion tombstones identified by normalized DOI, or by citation key when no DOI exists.
- A document entry is removed only when a matching explicit tombstone exists. All other document-only entries are pushed into the global database, including when the global database is empty or was reset.
- Deleting five or more document entries from global tombstones now requires an explicit confirmation showing the affected references.
- Tombstones are stored in the global database and embedded in `global-bibliography.bib` as extension metadata, so Nextcloud synchronization preserves deliberate deletions without reintroducing a JSON database.
- Updated Nextcloud bibliography merging so a missing entry on either side is not treated as a deletion unless a tombstone is present. This prevents empty remote files and initial synchronization from erasing entries.
- In the standalone global manager, the header switch is now **Sync with Nextcloud**. It directly mirrors and controls the BibTeX synchronization checkbox in the Nextcloud configuration dialog.
- Fixed the PDF viewer appearing stuck on **Loading PDF…** after the real-comment feature was added. PDF rendering no longer waits for all pages to be scanned for comments; comment indexing runs incrementally in the background with per-page timeouts.
- Added visible fatal-error reporting in the PDF editor so initialization failures cannot leave only the static loading rectangle.

## Changes in 1.9.3

- Replaced **Always remember my choice**, **Save in global database**, and **Pull from global database** with one **Sync with global database** switch in both manager views.
- When enabled, project BibTeX files and the extension-wide global database synchronize automatically after edits, storage changes, focus changes, and periodic background checks.
- Added a per-project three-way synchronization snapshot. One-sided additions, edits, and deletions propagate in either direction; if both sides changed the same entry differently, the global database wins.
- Removed the former pending-change prompts from the synchronization workflow.
- Renamed the former PDF **Comment** tool to **Insert text**, matching its actual FreeText behavior.
- Added real PDF sticky-note comments as native PDF `Text` annotations, with clickable markers, native PDF popup content, a comment side pane, editing, deletion, page navigation, and permanent storage inside the PDF.
- Added the MIT-licensed `pdf-lib` writer for preserving and updating native PDF comment dictionaries while PDF.js continues to handle highlighting, visible text, drawing, and rendering.
- Kept the standalone and ColLabTeX overlay controls and behavior aligned.

## Changes in 1.9.2

- Fixed Nextcloud setup in the ColLabTeX overlay by opening the Nextcloud login page through the background context instead of calling the unavailable content-script `browser.tabs` API.
- Added a background fallback for optional Nextcloud origin-permission requests so setup behaves the same in the standalone and overlay views.
- Fixed the PDF editor remaining on `Loading PDF…`: PDF.js requires its viewer container to be a `<div>`, while version 1.9.5/1.9.1 accidentally used `<main>` and therefore aborted during initialization.
- Made the PDF editor load browser-cache PDFs directly from extension-wide storage. Cross-realm parent-to-iframe byte transfer is now used only as a legacy fallback.
- Added staged retrieval/decoding/rendering status messages and bounded fallback timeouts so future PDF-loading failures display a concrete error.
- Kept the standalone and ColLabTeX overlay implementations behaviorally identical.

## Changes in 1.9.1

- Fixed Firefox Nextcloud requests failing with `headers.entries() is not iterable` by using cross-realm-safe header serialization.
- Migrated existing connected installations to synchronize the global database through `global-bibliography.bib` by default; the setting can still be disabled explicitly.
- Made browser-cache PDF loading resilient to cross-origin iframe/ArrayBuffer transfer differences.
- Added explicit PDF decode, first-page, and viewer-initialization timeouts so failures are shown instead of remaining on a gray `Loading PDF…` overlay.
- Kept the standalone and ColLabTeX overlay implementations behaviorally identical.

## Changes in 1.9.0

- Replaced the separate **Add annotation/comment** form and JSON annotation list with true inline PDF annotations.
- Added native PDF.js tools for text selection, text highlighting, visible FreeText insertion, freehand drawing, undo, redo, color, line width, and saving.
- Inline annotations are written into the PDF itself through PDF.js `saveDocument()`, so they remain visible in compatible external PDF readers.
- Browser-stored PDFs are replaced atomically with the annotated PDF; Nextcloud PDFs are uploaded back to the same attachment path.
- Annotation changes are auto-saved after a short delay and explicitly saved before switching or closing PDF tabs and before closing either manager view.
- Path-only local PDF links are converted to durable browser storage on the first annotation save, since a browser extension cannot safely overwrite an arbitrary local path.
- The ColLabTeX overlay and standalone manager use the same PDF editor, note pane, save protocol, and attachment-update behavior.
- The separate PDF note field remains available; only the obsolete page/label/comment annotation sidecar UI was removed.

## Changes in 1.8.8

- Fixed the standalone manager close button by closing the extension tab through the background context, with direct tab and window fallbacks.
- Made successful Nextcloud connection and synchronization messages green and more prominent in both manager views.
- Fixed false Nextcloud synchronization errors for successful WebDAV responses with null-body HTTP statuses such as `204 No Content`.

## Changes in 1.8.7

- The PDF workspace entry-details pane now contains the same fields and PDF attachment section as the ordinary bibliography detail pane in both the standalone manager and the ColLabTeX overlay.
- Asynchronously loaded attachment names, metadata, and controls are synchronized across both detail panes.
- The ColLabTeX overlay now provides the same **Open**, **Rename**, **Replace**, and **Remove** PDF actions as the standalone manager. **Replace** remains hidden for local-disk links.
- The standalone **PDF storage** text button was replaced by the same cloud button used in the ColLabTeX overlay and moved immediately to the left of the close button.

## Changes in 1.7.9

### Search-assistance and filter menu

The bibliography search bar now has a slider button immediately to the left of the clear **×** button. It opens a search-assistance panel in both the ColLabTeX manager and the standalone Global Bibliography manager.

The panel supports clickable operators and keyboard navigation:

- quoted exact phrases, for example `"current filamentation"`;
- exclusion with `!`, for example `plasma !fusion`;
- field searches:
  - `title:`
  - `author:`
  - `year:`
  - `abstract:`
  - `pdf:`
  - `tag:`
  - `citekey:`
  - `journal:`
  - `doi:`
  - `type:`
  - `category:`
- `/` focuses the search field and opens the panel;
- **Up/Down** moves through panel controls;
- **Enter** activates the focused control;
- **Esc** closes the panel.

Operators can be combined, such as:

```text
author:Kluge year:2026 !title:review tag:SAXS
```

### Search scope and filters

The panel contains switches controlling whether unqualified searches include:

- abstracts;
- stored PDF text and PDF-related fields.

`abstract:` and `pdf:` searches continue to address those fields explicitly regardless of the unqualified-search switches.

The filter section provides:

- entry type;
- minimum year;
- maximum year;
- entries with or without a DOI;
- tagged or untagged entries;
- one-click filter clearing.

The slider button shows a badge with the number of active filters. Search and filter settings are remembered.

PDF searching covers stored PDF text fields such as `ctca_pdf_text`, plus PDF/file/attachment metadata and PDF URLs. Version 1.9.6 does not automatically download or extract text from linked PDF files.

### Tags and autocomplete

Every bibliography entry now supports independent tags in addition to hierarchical categories.

- Tags appear as removable chips in the details pane.
- Type in **Add tag…** and matching existing tags are suggested automatically.
- Press **Enter** or comma to add a tag.
- Press **Backspace** in an empty tag field to remove the last tag.
- The add-entry dialog also suggests existing tags.
- `tag:` searches tags directly.
- Filters can show only tagged or only untagged entries.

Tags are persisted through:

- the standalone global database;
- document-to-global and global-to-document synchronization;
- the custom BibTeX field `ctca_tags`;
- exported `global-bibliography.bib` files.

### Existing manager behavior retained

- The standalone manager has the same category/list/details layout as the ColLabTeX manager.
- Category and detail columns can be resized by dragging.
- The search field has an **×** clear button.
- Standalone edits are saved automatically.
- **Export as bib file** downloads `global-bibliography.bib`.
- Categories, nested category order, memberships, aliases, tags, and DOI synchronization state are exported.
- Browser-button behavior remains active-tab-only: an active ColLabTeX tab opens its in-page manager; otherwise the standalone manager opens in a new tab.
- First-document import, pending-global-change warnings, remembered push choices, global-conflict precedence, and loss-safe BibTeX writes remain enabled.
- With an empty global database, both manager views offer direct actions to upload a `.bib` file or synchronize an existing Nextcloud bibliography backup.

## Privacy

Bibliography data, tags, categories, pending-change metadata, settings, and backups are stored in the browser profile. Network access is used only for explicit DOI metadata retrieval from Crossref, DataCite, and `doi.org`.
## Changes in 1.8.2

- Restored the prominent three-card storage selector in the PDF attachment dialog for **Browser storage**, **Nextcloud**, and **Local disk link**.
- On browsers without persistent file-handle support, **Local disk link** no longer falls back to Browser storage. The selected PDF is kept as a temporary session-only link and is not copied into persistent browser storage. A warning explains that it must be reattached after the browser or extension restarts.
- Browser-stored PDF binaries now use an extension-wide background IndexedDB bridge, so the standalone manager, ColLabTeX manager, and PDF viewer access the same data. Older context-local binaries are migrated when they are opened.
- The PDF workspace now passes PDF bytes from the parent manager to the bundled PDF.js viewer, fixing the gray viewer followed by **PDF data is not available**.
- Repaired the standalone manager markup so it includes the Bibliography/PDF tab bar, PDF workspace, attachment store script, collapsible notes pane, and collapsible entry-details pane.
- Corrected the notes-pane arrows: **▶** collapses the notes pane and **◀** restores it.

## Changes in 1.8.4

- The search field now occupies only the table/list column.
- **Update all from DOI** and **Update Bib** / **Export as bib file** are aligned on the same top row above the detail pane, eliminating the previous overlap with the detail heading.
- The detail-header **Open PDF** action is shown only when the selected entry actually has at least one PDF attachment; it opens the first attachment, while all attachments remain selectable in the attachment list.
- Long attachment names, local paths, and labels wrap within the attachment dialog. The dialog no longer expands beyond the browser window or creates a horizontal scrollbar for long filenames.
- The local-link instructions now identify the exact browser settings used to grant `file://` access in Edge, Chrome, and Firefox.

## Changes in 1.8.6

### Nextcloud bibliography: BibTeX is the single remote database

- `global-bibliography.bib` is now the only bibliography database synchronized to Nextcloud.
- The redundant remote `bibliography-database.json` is no longer read or written.
- On the next successful bibliography synchronization, a legacy `bibliography-database.json` is deleted from the configured Nextcloud directory.
- Categories, nested ordering, memberships, tags, aliases, DOI synchronization metadata, and other custom `ctca_*` fields remain embedded in the BibTeX entries.
- Entry-level conflicts are detected by parsing the remote BibTeX file and comparing it with the browser copy and the last synchronized base.
- PDF notes and the attachment index remain separate because they describe external PDF files rather than a second bibliography database. Inline annotations are stored directly inside each PDF.

### Local-file access detection

The extension now checks `extension.isAllowedFileSchemeAccess()` before deciding that local-file access is unavailable.

- In Firefox 153 and newer, Firefox exposes a separate **Access local files on your computer** permission.
- In older Firefox versions, that separate row does not exist; local-file access is covered by **Access your data for all websites**.
- The local-link dialog now has a **Check / grant local-file access** button and reports the detected state directly.
- Chrome and Edge continue to use **Allow access to file URLs** on the extension Details page.



## Version 1.9.6

- Restricts project deletions to explicit tombstones for identities present in the project’s previous successful synchronization snapshot.
- Cleans stale tombstones when the corresponding global entry exists and prevents repeated prompts for an unchanged rejected mass-deletion set.
- Prevents no-op Nextcloud bibliography synchronization from rewriting browser storage and retriggering project synchronization.
- Enables and colors the standalone Nextcloud synchronization switch only after a live authenticated connection check succeeds.
- Restores the absolute PDF.js viewer-container positioning required by the annotation editor while retaining the comments side pane.



## Version 1.10.0

- The green add button in both bibliography managers now opens a hover/click menu.
- **Add new entry** retains the existing manual-entry workflow.
- **Import BibTeX file** merges a selected `.bib` file into the current bibliography.
- Matching citation keys or normalized DOIs are shown in a conflict dialog before writing.
- Each conflict allows the current database/project version or a specific imported version to be retained.
- Non-conflicting entries are imported directly; unrelated entries are never rewritten or removed.


## 1.10.5

- Restored the ColLabTeX toolbar-button constructor and project storage-key helper that were accidentally removed in 1.10.4.
- The `bib` button is injected again after the ColLabTeX editor toolbar becomes available.
- The bibliography/PDF tab strip is hidden until at least one PDF is opened, in both the embedded and standalone manager.


## Nextcloud-linked project files (version 1.11.0)

The Collabtex/Overleaf integration now extends the native project upload workflow:

- The native upload dialog gains a **From Nextcloud** source. It opens an extension-owned WebDAV file picker and supports selecting multiple files when the native upload control permits it.
- Imported files retain their Nextcloud source path, file ID, ETag, size, and modification time in the portable `.collabtex-nextcloud-links.json` project file, with project-scoped extension storage used as a local cache.
- Linked files receive a small cloud-refresh action in the project file tree.
- A cloud-refresh action in the file-tree toolbar checks and updates all linked files whose Nextcloud ETag changed.
- A cloud button is inserted immediately before the page's native **Share** action. It opens only the Nextcloud connection settings required for project-file access; it does not expose the bibliography-sync checkbox.
- When Nextcloud is initialized for the first time from the project cloud button, bibliography synchronization defaults to **off**. When initialized from the bibliography manager, it defaults to **on**.

Project-file replacement uses the application's native upload and overwrite workflow. This preserves the server's own permissions, history, and conflict behavior instead of bypassing Collabtex/Overleaf with an undocumented server endpoint.
