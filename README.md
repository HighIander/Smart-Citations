# Smart Citations

**Current version: 2.0**

Smart Citations is a browser extension for building a personal BibTeX library, reusing it in CollabTeX and Overleaf, and keeping the papers behind those citations close at hand. It combines citation autocomplete, bibliography management, PDF capture, a built-in reader, annotations, notes, and optional Nextcloud synchronization.

The central idea is simple: a journal link should not make you start over. Once a paper is in Smart Citations, you can return to your own attached PDF—with your highlights, comments, drawings, and notes—instead of repeatedly opening a clean copy on the publisher site.

## Highlights

- **Citation autocomplete in CollabTeX and Overleaf.** Type inside a supported `\cite{...}` command and search by citation key, author, title, keyword, abstract text, or DOI.
- **A central personal bibliography.** Browse, edit, import, export, categorize, tag, star, search, and reuse BibTeX entries across projects.
- **Add entries directly from PDFs.** Smart Citations reads each PDF, finds its DOI, retrieves metadata, generates a citation key, and attaches the file.
- **Fast PDF attachment.** Attach multiple named PDFs from a file picker, or drag a PDF directly onto an existing bibliography row.
- **Journal PDF handoff.** On configured journal pages, PDF links can open your existing annotated attachment or create a new entry and capture the journal PDF.
- **Integrated PDF reading and annotation.** Highlight text, insert visible text, draw, add sticky-note comments, navigate comments, undo or redo changes, and save annotations into the PDF.
- **Separate research notes.** Each PDF has a notes pane for longer personal notes, saved automatically alongside the attachment.
- **Flexible storage.** Keep PDFs in the browser profile, synchronize them through Nextcloud, or link to files on the local disk.
- **DOI metadata tools.** Update one, several, or all bibliography entries through Crossref, DataCite, and DOI metadata.
- **Optional synchronization.** Keep a project bibliography synchronized with the central database, and optionally synchronize the central database, PDFs, and notes through Nextcloud.

## Getting started

### Start with a new CollabTeX or Overleaf document

1. Install the extension and open the project’s main TeX document.
2. If the project has no bibliography—or still uses `sample.bib`—accept the bibliography setup prompt.
3. Choose whether this project should remain synchronized with the Smart Citations central database.
4. Smart Citations will then:

   - populate the project from the central database when it already contains entries; or
   - ask for an existing `.bib` file when the central database is still empty;
   - create or reuse `bibliography.bib`; and
   - update the main document to use that bibliography.

5. Start typing a citation, for example `\cite{`, and select a result from the Smart Citations completion list.
6. Open the bibliography manager with the **bib** button to add or edit entries, import another `.bib` file, update metadata from DOI records, or attach PDFs.
7. Open an attached PDF inside the manager to read and annotate it without leaving the project.

Project synchronization is optional. You can keep a project bibliography independent, or let changes move between the project and the central library. Existing bibliography content is merged carefully, and automatic safety backups are created before substantial project bibliography rewrites.

### Start with the standalone library and PDF viewer

1. Click the Smart Citations browser-toolbar button while you are outside a CollabTeX or Overleaf project. The standalone bibliography manager opens in its own tab.
2. If the library is empty, choose one of the starting points:

   - **Upload a `.bib` file**
   - **Sync with an existing Nextcloud backup**
   - **Add a new entry manually**
   - **Add a new entry from PDF**

3. For the quickest PDF-first workflow, open the **+** menu and choose **Add new entry from PDF**.
4. Drop one or more PDFs into the import area, or select them from the computer. Smart Citations scans each file for a DOI, retrieves its bibliography metadata, and creates or updates the matching entry.
5. Organize the library with categories, nested categories, tags, stars, and advanced search filters.
6. Open any attached PDF in a workspace tab. Add highlights, text, drawings, comments, or longer notes, then save the annotated PDF.
7. Use the launcher button in the manager header if you want a bookmarkable direct link or a Windows desktop shortcut for the standalone library.

## Working with PDFs

### Create an entry from a PDF

Choose **+ → Add new entry from PDF** in either manager. The importer accepts multiple PDFs and lets you choose where they should be stored. For each file, Smart Citations:

1. reads PDF metadata and page text;
2. extracts a DOI;
3. checks whether the DOI already exists in the central bibliography;
4. retrieves bibliographic metadata;
5. creates a citation key for a new paper, or attaches the PDF to the existing entry; and
6. reports created, updated, skipped, and failed imports.

PDFs without a detectable DOI are reported rather than silently creating unreliable metadata. You can still add their bibliography entry manually and attach the file afterward.

### Attach PDFs to an existing entry

There are two quick paths:

- Select an entry and choose **+ Attach PDF** in its PDF attachments section.
- Drag one or more PDF files directly onto the entry’s row in the bibliography list.

An entry can have several named PDF attachments—for example, a manuscript, supplement, or supporting information. Attachments can be opened, downloaded, renamed, replaced, removed, and reordered.

When an entry contains a DOI or web URL, **Get from web** can inspect the article page, find downloadable PDFs, and attach the selected files. Some sites may require an access permission, an institutional login, or a human-verification step. After verification, Smart Citations returns to its own tab when the journal URL changes and automatically continues PDF discovery. The same journal tab remains open between discovery and download, then closes after the selected download attempts finish. On any site that blocks direct PDF reads, the extension can retry from that article-page tab and then save the journal link through the browser download manager. This last fallback requires local-file access so Smart Citations can read the saved bytes back; use the displayed **Grant / check local-file access** control, or in Chrome or Edge enable **Allow access to file URLs** on the extension’s Details page. The temporary transport file uses an enforced neutral extension to avoid launching an external PDF reader and is removed after a successful import.

### Return to your annotated copy from a journal site

Smart Citations can turn supported journal PDF links into a round trip back to your personal research copy:

1. Open the extension options and add the relevant journal hostnames or URL patterns. `*.nature.com` is included by default.
2. On a matching article page, click its PDF link.
3. Smart Citations extracts the article DOI and checks the central bibliography.
4. If the paper already has an attached PDF, choose **Open in Smart Citations** to open that copy with your existing annotations and notes.
5. If the paper is new, choose **Attach in Smart Citations**. The extension retrieves the DOI metadata, creates the entry, downloads and preselects the journal PDF, asks where to store it, and opens the attached copy.
6. Select **Remember my choice** if journal PDF links should always open on the journal site or always use Smart Citations. The preference can be changed later in the extension options.

This keeps the annotated attachment as the place you return to, even when you rediscover the paper through the publisher website.

### Read, comment, and annotate

The built-in PDF workspace provides:

- page navigation, zoom, fit-to-width, download, and maximize controls;
- text selection and highlighting;
- visible text annotations;
- freehand drawing with configurable color and width;
- sticky-note comments with a navigable comments pane;
- undo and redo; and
- saving annotations and comments directly into the PDF.

The adjacent **PDF notes** pane is intended for longer working notes and saves automatically. PDF comments are accepted with **Done** and embedded when **Save PDF** is used.

## Bibliography management

The standalone and in-project managers provide the same core library tools:

- import and export BibTeX;
- add and edit common or custom BibTeX fields;
- update selected entries or the whole library from DOI metadata;
- automatic citation-key generation with duplicate protection;
- categories, nested categories, drag-and-drop assignment, tags, aliases, and stars;
- sortable and configurable result columns;
- bulk selection and removal;
- exact phrases, exclusions, field operators, and filters for type, year, DOI, and tags;
- optional searching of abstracts and PDF-related text; and
- synchronization between a project bibliography and the central database.

The central library is stored in the browser profile and is available to both the standalone manager and supported project pages in that browser profile.

## PDF storage choices

| Storage | What it does | Best for |
| --- | --- | --- |
| **Browser storage** | Keeps a persistent PDF copy inside the current browser profile. | A simple, local setup used from one browser profile. |
| **Nextcloud** | Uploads PDFs, synchronizes inline annotations, and stores separate PDF notes alongside the attachment metadata. | Access across browsers or computers through a personal Nextcloud account. |
| **Local disk link** | Stores a path or file handle instead of copying the PDF. Local-file permission may be required. | Large local libraries that should remain in their existing folders. |

Browser extensions cannot silently overwrite an arbitrary path-only local file. If you annotate a path-linked PDF and save it, Smart Citations preserves the edited copy in browser storage instead of overwriting the original file without permission.

## Nextcloud integration

After connecting a Nextcloud account, Smart Citations can:

- synchronize the central bibliography through a BibTeX file;
- synchronize PDFs and their separate notes;
- resolve bibliography conflicts entry by entry, with local, remote, and last-synchronized details;
- restore an empty central library from an existing Nextcloud backup; and
- in CollabTeX, import personal Nextcloud files through the native project upload flow and refresh linked project files individually or in bulk.

Nextcloud synchronization is optional. Existing attachments keep their selected storage type when the default is changed.

## Installation

### Firefox 128 or newer

1. Extract the extension package.
2. Open `about:debugging#/runtime/this-firefox`.
3. Select **Load Temporary Add-on…**.
4. Select `manifest.json`.
5. Reload the CollabTeX or Overleaf project page.

The supplied XPI is unsigned and intended for temporary or developer installation. Permanent installation in a standard Firefox build requires Mozilla signing.

### Chrome, Chromium, or Edge

1. Extract the extension package.
2. Open the browser’s extensions page and enable developer mode.
3. Choose **Load unpacked**.
4. Select the extracted extension directory.
5. Reload the CollabTeX or Overleaf project page.

## Privacy and network access

Bibliography data, categories, tags, settings, project synchronization state, backups, and browser-stored PDFs remain in the browser profile unless Nextcloud synchronization is enabled.

Network access is used for:

- explicit DOI metadata retrieval from Crossref, DataCite, and `doi.org`;
- a connected Nextcloud server;
- journal-page inspection and PDF download when the user invokes or remembers the Smart Citations journal workflow; and
- opening ordinary publisher or DOI links selected by the user.

See the [data-protection statement](https://www.smartioz.com/smartcitations/dataprotection.php) and [Impressum](https://www.smartioz.com/smartcitations/impressum.php) for the published legal information.

## License

Except for bundled third-party components, the first-party source code is licensed under the [Creative Commons Attribution-NonCommercial-ShareAlike 4.0 International License](https://creativecommons.org/licenses/by-nc-sa/4.0/) (`CC-BY-NC-SA-4.0`). You may share and adapt it for non-commercial purposes with attribution, an indication of changes, and distribution of adaptations under the same license. See [LICENSE](LICENSE) for the project notice and the upstream license files under `pdfjs/` and `pdf-lib/` for third-party terms.

The name **Smart Citations** and its associated branding are not part of this license. They belong exclusively to the owner identified in the [Impressum](https://www.smartioz.com/smartcitations/impressum.php).
