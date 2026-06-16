(() => {
  "use strict";

  const FIELD_ALIASES = Object.freeze({
    title: "title",
    author: "author",
    authors: "author",
    year: "year",
    abstract: "abstract",
    pdf: "pdf",
    tag: "tag",
    tags: "tag",
    citekey: "citekey",
    key: "citekey",
    journal: "journal",
    doi: "doi",
    type: "type",
    category: "category",
    categories: "category"
  });

  function normalizeText(value) {
    return String(value ?? "").toLocaleLowerCase();
  }

  function splitTags(value) {
    const input = Array.isArray(value) ? value : String(value ?? "").split(/[,;\n]+/);
    const seen = new Set();
    const tags = [];
    for (const raw of input) {
      const tag = String(raw ?? "").trim().replace(/\s+/g, " ");
      const key = tag.toLocaleLowerCase();
      if (!tag || seen.has(key)) continue;
      seen.add(key);
      tags.push(tag);
    }
    return tags;
  }

  function parseQuery(value) {
    const source = String(value ?? "");
    const tokens = [];
    let index = 0;

    const skipSpace = () => {
      while (index < source.length && /\s/.test(source[index])) index += 1;
    };

    while (index < source.length) {
      skipSpace();
      if (index >= source.length) break;

      let exclude = false;
      if (source[index] === "!") {
        exclude = true;
        index += 1;
        skipSpace();
      }

      const start = index;
      let field = "";
      let probe = index;
      while (probe < source.length && /[A-Za-z]/.test(source[probe])) probe += 1;
      if (probe > index && source[probe] === ":") {
        const alias = source.slice(index, probe).toLocaleLowerCase();
        if (FIELD_ALIASES[alias]) {
          field = FIELD_ALIASES[alias];
          index = probe + 1;
        }
      }

      let exact = false;
      let text = "";
      if (source[index] === '"') {
        exact = true;
        index += 1;
        const valueStart = index;
        while (index < source.length && source[index] !== '"') index += 1;
        text = source.slice(valueStart, index);
        if (source[index] === '"') index += 1;
      } else {
        const valueStart = index;
        while (index < source.length && !/\s/.test(source[index])) index += 1;
        text = source.slice(valueStart, index);
      }

      text = text.trim();
      if (!text && field) {
        tokens.push({ field, text: "", exclude, exact, raw: source.slice(start, index) });
      } else if (text) {
        tokens.push({ field, text, exclude, exact, raw: source.slice(start, index) });
      }
    }
    return tokens;
  }

  function entryFieldTexts(entry) {
    const fields = entry?.fields || {};
    const tags = splitTags(entry?.tags || fields.ctca_tags || "");
    const categories = Array.isArray(entry?.categoryPaths) ? entry.categoryPaths : [];
    const rawUrl = String(fields.url || "");
    const pdfUrl = /\.pdf(?:$|[?#])/i.test(rawUrl) ? rawUrl : "";
    const pdfText = [
      entry?.pdfText,
      fields.ctca_pdf_text,
      fields.pdftext,
      fields.pdf_text,
      fields.pdf,
      fields.file,
      fields.attachment,
      pdfUrl
    ].filter(Boolean).join("\n");
    const url = pdfUrl ? "" : rawUrl;
    const title = fields.title || "";
    const author = [fields.author, fields.editor].filter(Boolean).join("\n");
    const journal = [fields.journal, fields.journaltitle, fields.booktitle, fields.publisher].filter(Boolean).join("\n");
    const citekey = [entry?.key, ...(entry?.aliases || []), fields.ids].filter(Boolean).join("\n");
    const year = [fields.year, fields.date].filter(Boolean).join("\n");
    const doi = fields.doi || "";
    const abstract = fields.abstract || "";
    const type = entry?.type || "";
    const tag = tags.join("\n");
    const category = categories.join("\n");
    const categorized = new Set([
      "title", "author", "editor", "journal", "journaltitle", "booktitle", "publisher",
      "year", "date", "doi", "abstract", "ids", "url", "ctca_tags", "ctca_pdf_text",
      "pdftext", "pdf_text", "pdf", "file", "attachment"
    ]);
    const other = [];
    for (const [name, fieldValue] of Object.entries(fields)) {
      if (!categorized.has(String(name).toLocaleLowerCase())) other.push(name, fieldValue);
    }
    return { title, author, journal, citekey, year, doi, abstract, pdf: pdfText, url, tag, category, type, other: other.join("\n") };
  }

  function tokenMatches(text, token) {
    const haystack = normalizeText(text);
    const needle = normalizeText(token.text);
    if (!needle) return true;
    return haystack.includes(needle);
  }

  function yearNumber(value) {
    const match = String(value ?? "").match(/(?:19|20)\d{2}/);
    return match ? Number(match[0]) : null;
  }

  function normalizeFilterState(filters = {}) {
    return {
      type: String(filters.type || ""),
      yearFrom: String(filters.yearFrom || ""),
      yearTo: String(filters.yearTo || ""),
      doi: ["any", "with", "without"].includes(filters.doi) ? filters.doi : "any",
      tagged: ["any", "tagged", "untagged"].includes(filters.tagged) ? filters.tagged : "any"
    };
  }

  function matchesFilters(entry, filters = {}) {
    const state = normalizeFilterState(filters);
    const fields = entry?.fields || {};
    if (state.type && String(entry?.type || "").toLocaleLowerCase() !== state.type.toLocaleLowerCase()) return false;
    const year = yearNumber(fields.year || fields.date);
    const from = yearNumber(state.yearFrom);
    const to = yearNumber(state.yearTo);
    if (from !== null && (year === null || year < from)) return false;
    if (to !== null && (year === null || year > to)) return false;
    const hasDoi = Boolean(String(fields.doi || "").trim());
    if (state.doi === "with" && !hasDoi) return false;
    if (state.doi === "without" && hasDoi) return false;
    const hasTags = splitTags(entry?.tags || fields.ctca_tags || "").length > 0;
    if (state.tagged === "tagged" && !hasTags) return false;
    if (state.tagged === "untagged" && hasTags) return false;
    return true;
  }

  function matchEntry(entry, query, options = {}) {
    if (!matchesFilters(entry, options.filters)) return { matched: false, rank: 99 };
    const texts = entryFieldTexts(entry);
    const tokens = parseQuery(query);
    const includeAbstract = options.includeAbstract !== false;
    const includePdfText = options.includePdfText === true;
    const generalFields = [
      texts.citekey, texts.title, texts.author, texts.journal, texts.year, texts.doi,
      texts.tag, texts.category, texts.type, texts.url, texts.other,
      includeAbstract ? texts.abstract : "",
      includePdfText ? texts.pdf : ""
    ].join("\n");

    let bestRank = 4;
    for (const token of tokens) {
      const target = token.field ? texts[token.field] : generalFields;
      const matched = tokenMatches(target, token);
      if (token.exclude ? matched : !matched) return { matched: false, rank: 99 };
      if (!token.exclude) {
        if (token.field === "citekey" || (!token.field && tokenMatches(texts.citekey, token))) bestRank = Math.min(bestRank, 0);
        else if (token.field === "title" || (!token.field && tokenMatches(texts.title, token))) bestRank = Math.min(bestRank, 1);
        else if (token.field === "author" || (!token.field && tokenMatches(texts.author, token))) bestRank = Math.min(bestRank, 2);
        else bestRank = Math.min(bestRank, 3);
      }
    }
    return { matched: true, rank: tokens.length ? bestRank : 4 };
  }

  function activeFilterCount(filters = {}) {
    const state = normalizeFilterState(filters);
    return [state.type, state.yearFrom, state.yearTo, state.doi !== "any", state.tagged !== "any"].filter(Boolean).length;
  }

  globalThis.CollabTeXSearchTools = Object.freeze({
    FIELD_ALIASES,
    splitTags,
    parseQuery,
    entryFieldTexts,
    normalizeFilterState,
    matchesFilters,
    matchEntry,
    activeFilterCount
  });
})();
