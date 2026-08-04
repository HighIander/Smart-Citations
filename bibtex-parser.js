/* SPDX-License-Identifier: CC-BY-NC-SA-4.0 */

(() => {
  "use strict";

  function matchingBraceIndex(text, startIndex = 0) {
    const source = String(text || "");
    if (source[startIndex] !== "{") return -1;
    let depth = 0;
    let escaped = false;
    for (let index = startIndex; index < source.length; index += 1) {
      const char = source[index];
      if (escaped) {
        escaped = false;
        continue;
      }
      if (char === "\\") {
        escaped = true;
        continue;
      }
      if (char === "{") depth += 1;
      else if (char === "}") {
        depth -= 1;
        if (depth === 0) return index;
        if (depth < 0) return -1;
      }
    }
    return -1;
  }

  function matchingQuoteIndex(text, startIndex = 0) {
    const source = String(text || "");
    if (source[startIndex] !== '"') return -1;
    let escaped = false;
    for (let index = startIndex + 1; index < source.length; index += 1) {
      const char = source[index];
      if (escaped) {
        escaped = false;
        continue;
      }
      if (char === "\\") {
        escaped = true;
        continue;
      }
      if (char === '"') return index;
    }
    return -1;
  }

  function stripSingleBalancedOuterDelimiter(value) {
    const text = String(value ?? "").trim();
    if (text.length < 2) return text;
    if (text.startsWith("{") && matchingBraceIndex(text, 0) === text.length - 1) {
      return text.slice(1, -1).trim();
    }
    if (text.startsWith('"') && matchingQuoteIndex(text, 0) === text.length - 1) {
      return text.slice(1, -1).trim();
    }
    return text;
  }

  function stripOuterDelimiters(value) {
    let result = String(value || "").trim();
    for (let depth = 0; depth < 8; depth += 1) {
      const next = stripSingleBalancedOuterDelimiter(result);
      if (next === result) break;
      result = next;
    }
    return result;
  }

  function repairBibBraceBalance(value) {
    const source = String(value ?? "").replace(/\r\n?/g, "\n").trim();
    let result = "";
    let depth = 0;
    let escaped = false;

    for (let index = 0; index < source.length; index += 1) {
      const char = source[index];
      if (escaped) {
        result += char;
        escaped = false;
        continue;
      }
      if (char === "\\") {
        result += char;
        escaped = true;
        continue;
      }
      if (char === "{") {
        depth += 1;
        result += char;
        continue;
      }
      if (char === "}") {
        if (depth > 0) {
          depth -= 1;
          result += char;
        } else {
          // An unmatched closing brace would terminate the field value. Keep
          // the literal character, but escape it so the generated BibTeX stays
          // syntactically valid.
          result += "\\}";
        }
        continue;
      }
      result += char;
    }

    if (depth > 0) result += "}".repeat(depth);
    return result.trim();
  }

  function splitAuthorContentAtTopLevel(value) {
    const source = String(value ?? "").trim();
    const parts = [];
    let current = "";
    let depth = 0;
    let escaped = false;
    for (let index = 0; index < source.length;) {
      const char = source[index];
      if (escaped) {
        current += char;
        escaped = false;
        index += 1;
        continue;
      }
      if (char === "\\") {
        current += char;
        escaped = true;
        index += 1;
        continue;
      }
      if (char === "{") {
        depth += 1;
        current += char;
        index += 1;
        continue;
      }
      if (char === "}") {
        depth = Math.max(0, depth - 1);
        current += char;
        index += 1;
        continue;
      }
      if (depth === 0 && source.slice(index, index + 5).toLowerCase() === " and ") {
        if (current.trim()) parts.push(current.trim());
        current = "";
        index += 5;
        continue;
      }
      current += char;
      index += 1;
    }
    if (current.trim()) parts.push(current.trim());
    return parts;
  }

  function normalizeBibAuthorContent(value) {
    const repaired = repairBibBraceBalance(value);
    const authors = splitAuthorContentAtTopLevel(repaired);
    if (authors.length < 2) return repaired;

    return authors.map((author) => {
      const inner = stripSingleBalancedOuterDelimiter(author);
      // Braces around a comma-form personal name make BibTeX treat the whole
      // token as a corporate author. Remove that accidental wrapper. Braced
      // institutional names without a comma remain protected.
      return inner !== author && inner.includes(",") ? inner : author;
    }).join(" and ");
  }

  function normalizeBibFieldContent(name, value) {
    const fieldName = String(name || "").trim().toLowerCase();
    const repaired = repairBibBraceBalance(value);
    if (fieldName === "author" || fieldName === "editor") {
      return normalizeBibAuthorContent(repaired);
    }
    return repaired;
  }

  function serializeBibFieldValue(name, value) {
    const content = normalizeBibFieldContent(name, value);
    return content ? `{${content}}` : "";
  }

  function extractBibFieldContent(value) {
    const text = String(value ?? "").trim();
    if (!text) return "";
    const balanced = stripSingleBalancedOuterDelimiter(text);
    if (balanced !== text) return balanced;

    // Callers use this helper for values that are intended to be complete
    // serialized field values. Recover gracefully from a damaged outer wrapper
    // such as `{{Title}` or `{Title` before applying the canonical wrapper.
    if (text.startsWith("{")) {
      const closeIndex = matchingBraceIndex(text, 0);
      // A complete brace group followed by more content (for example
      // `{Smith, John} and {Doe, Jane}`) is field content, not an outer field
      // wrapper. The canonical serializer will add the one required wrapper.
      if (closeIndex >= 0 && closeIndex < text.length - 1) return text;
      let inner = text.slice(1);
      if (inner.endsWith("}")) inner = inner.slice(0, -1);
      return inner.trim();
    }
    if (text.startsWith('"')) {
      const closeIndex = matchingQuoteIndex(text, 0);
      if (closeIndex >= 0 && closeIndex < text.length - 1) return text;
      let inner = text.slice(1);
      if (inner.endsWith('"')) inner = inner.slice(0, -1);
      return inner.trim();
    }
    return text;
  }

  function canonicalizeSerializedBibFieldValue(name, value) {
    return serializeBibFieldValue(name, extractBibFieldContent(value));
  }

  function latexToText(value) {
    return stripOuterDelimiters(value)
      .replace(/\\(?:textit|textbf|emph|mathrm|mathbf|mathit|textrm|mbox|url)\s*\{([^{}]*)\}/g, "$1")
      .replace(/\\(?:['`^\"~=Hckrubvd])\s*\{?([A-Za-z])\}?/g, "$1")
      .replace(/\\(?:ae|AE|oe|OE|aa|AA|o|O|l|L|ss)\b/g, (match) => {
        const replacements = {
          "\\ae": "æ",
          "\\AE": "Æ",
          "\\oe": "œ",
          "\\OE": "Œ",
          "\\aa": "å",
          "\\AA": "Å",
          "\\o": "ø",
          "\\O": "Ø",
          "\\l": "ł",
          "\\L": "Ł",
          "\\ss": "ß"
        };
        return replacements[match] || match;
      })
      .replace(/\\&/g, "&")
      .replace(/\\%/g, "%")
      .replace(/\\_/g, "_")
      .replace(/&amp;/gi, "&")
      .replace(/~/g, " ")
      .replace(/---/g, "—")
      .replace(/--/g, "–")
      .replace(/[{}]/g, "")
      .replace(/\\[A-Za-z]+\*?/g, "")
      .replace(/\\(.)/g, "$1")
      .replace(/\s+/g, " ")
      .trim();
  }

  function normalizeAbstract(value) {
    return latexToText(value)
      .replace(/^\s*abstract\b\s*[:.\-–—]?\s*/i, "")
      .trim();
  }

  function splitAuthorsRaw(value) {
    const normalizedValue = stripOuterDelimiters(value);
    const authors = [];
    let current = "";
    let depth = 0;
    let index = 0;

    while (index < normalizedValue.length) {
      const char = normalizedValue[index];
      if (char === "{") {
        depth += 1;
        current += char;
        index += 1;
        continue;
      }
      if (char === "}") {
        depth = Math.max(0, depth - 1);
        current += char;
        index += 1;
        continue;
      }

      if (
        depth === 0 &&
        normalizedValue.slice(index, index + 5).toLowerCase() === " and "
      ) {
        if (current.trim()) {
          authors.push(current.trim());
        }
        current = "";
        index += 5;
        continue;
      }

      current += char;
      index += 1;
    }

    if (current.trim()) {
      authors.push(current.trim());
    }

    return authors.filter(Boolean);
  }

  function splitAuthors(value) {
    const toText = window.CollabTeXLatex?.toText || latexToText;
    return splitAuthorsRaw(value).map(formatAuthorNameRaw).map(toText).filter(Boolean);
  }

  function formatAuthorNameRaw(value) {
    const name = String(value || "").trim();
    if (!name) return "";

    const parts = splitTopLevel(name).map((part) => part.trim());
    if (parts.length < 2) return name;

    const family = parts[0];
    const suffix = parts.length > 2 ? parts.slice(1, -1).filter(Boolean).join(", ") : "";
    const given = parts[parts.length - 1];
    if (!given) return [family, suffix].filter(Boolean).join(", ");
    return `${given} ${family}${suffix ? `, ${suffix}` : ""}`.trim();
  }

  function formatAuthorName(value) {
    const toText = window.CollabTeXLatex?.toText || latexToText;
    return toText(formatAuthorNameRaw(value));
  }

  function authorFamilyName(value) {
    const name = String(value || "").trim();
    if (!name) return "";
    const parts = splitTopLevel(name).map((part) => part.trim());
    if (parts.length > 1) return latexToText(parts[0]);
    const plain = latexToText(name);
    return plain.split(/\s+/).pop() || plain;
  }

  function splitAuthorsDisplayRaw(value) {
    return splitAuthorsRaw(value).map(formatAuthorNameRaw).filter(Boolean);
  }

  function createAuthorIndex(values) {
    const byValue = new Map();
    for (const value of values || []) {
      for (const author of splitAuthorsRaw(value)) {
        const normalized = author.replace(/\s+/g, " ").trim();
        const key = normalized.toLocaleLowerCase();
        if (!normalized || byValue.has(key)) continue;
        const label = formatAuthorName(normalized);
        byValue.set(key, {
          value: normalized,
          label,
          matchText: `${normalized}\n${label}`.toLocaleLowerCase()
        });
      }
    }
    return [...byValue.values()].sort((left, right) =>
      left.label.localeCompare(right.label, undefined, { sensitivity: "base" })
    );
  }

  function authorTokenAt(value, caret) {
    const text = String(value || "");
    const position = Math.max(0, Math.min(text.length, Number(caret) || 0));
    let depth = 0;
    let start = 0;
    let end = text.length;

    for (let index = 0; index < text.length;) {
      const char = text[index];
      if (char === "{") {
        depth += 1;
        index += 1;
        continue;
      }
      if (char === "}") {
        depth = Math.max(0, depth - 1);
        index += 1;
        continue;
      }
      if (depth === 0 && text.slice(index, index + 5).toLowerCase() === " and ") {
        if (index < position) {
          start = index + 5;
        } else {
          end = index;
          break;
        }
        index += 5;
        continue;
      }
      index += 1;
    }

    const raw = text.slice(start, end);
    const leading = raw.match(/^\s*/)?.[0].length || 0;
    const trailing = raw.match(/\s*$/)?.[0].length || 0;
    return {
      start: start + leading,
      end: Math.max(start + leading, end - trailing),
      value: raw.trim()
    };
  }

  function findAuthorCompletions(index, value, caret, limit = 8) {
    const token = authorTokenAt(value, caret);
    const query = token.value.replace(/\s+/g, " ").trim().toLocaleLowerCase();
    if (!query || caret < token.end) return [];
    return (index || [])
      .filter((candidate) =>
        candidate.value.toLocaleLowerCase() !== query &&
        (candidate.value.toLocaleLowerCase().startsWith(query) ||
          candidate.label.toLocaleLowerCase().startsWith(query) ||
          candidate.matchText.split(/\s+/).some((part) => part.startsWith(query)))
      )
      .slice(0, Math.max(1, Number(limit) || 8))
      .map((suggestion) => ({ ...suggestion, start: token.start, end: token.end }));
  }

  function findAuthorCompletion(index, value, caret) {
    return findAuthorCompletions(index, value, caret, 1)[0] || null;
  }

  function readBalanced(text, startIndex, openChar, closeChar) {
    let depth = 0;
    let quoted = false;
    let escaped = false;

    for (let index = startIndex; index < text.length; index += 1) {
      const char = text[index];

      if (escaped) {
        escaped = false;
        continue;
      }
      if (char === "\\") {
        escaped = true;
        continue;
      }
      if (char === '"' && depth <= 1) {
        quoted = !quoted;
        continue;
      }
      if (quoted) {
        continue;
      }
      if (char === openChar) {
        depth += 1;
      } else if (char === closeChar) {
        depth -= 1;
        if (depth === 0) {
          return index;
        }
      }
    }

    return -1;
  }

  function splitTopLevel(text, delimiter = ",") {
    const parts = [];
    let current = "";
    let braceDepth = 0;
    let parenDepth = 0;
    let quoted = false;
    let escaped = false;

    for (const char of text) {
      if (escaped) {
        current += char;
        escaped = false;
        continue;
      }
      if (char === "\\") {
        current += char;
        escaped = true;
        continue;
      }
      if (char === '"') {
        current += char;
        quoted = !quoted;
        continue;
      }
      if (!quoted) {
        if (char === "{") braceDepth += 1;
        if (char === "}") braceDepth = Math.max(0, braceDepth - 1);
        if (char === "(") parenDepth += 1;
        if (char === ")") parenDepth = Math.max(0, parenDepth - 1);
      }
      if (
        char === delimiter &&
        !quoted &&
        braceDepth === 0 &&
        parenDepth === 0
      ) {
        parts.push(current);
        current = "";
      } else {
        current += char;
      }
    }

    parts.push(current);
    return parts;
  }

  function parseFieldsStrict(body) {
    const fields = {};
    const parts = splitTopLevel(body);

    for (const rawPart of parts) {
      const part = rawPart.trim();
      if (!part) continue;

      let braceDepth = 0;
      let quoted = false;
      let escaped = false;
      let equalsIndex = -1;

      for (let index = 0; index < part.length; index += 1) {
        const char = part[index];
        if (escaped) {
          escaped = false;
          continue;
        }
        if (char === "\\") {
          escaped = true;
          continue;
        }
        if (char === '"') {
          quoted = !quoted;
          continue;
        }
        if (!quoted) {
          if (char === "{") braceDepth += 1;
          if (char === "}") braceDepth = Math.max(0, braceDepth - 1);
          if (char === "=" && braceDepth === 0) {
            equalsIndex = index;
            break;
          }
        }
      }

      if (equalsIndex < 0) continue;

      const name = part.slice(0, equalsIndex).trim().toLowerCase();
      const value = part.slice(equalsIndex + 1).trim();
      if (name) {
        fields[name] = value;
      }
    }

    return fields;
  }

  function parseFieldsByLine(body) {
    const fields = {};
    const starts = [];
    const pattern = /^[\t ]*([A-Za-z][A-Za-z0-9_:.+-]*)[\t ]*=/gm;
    let match;

    while ((match = pattern.exec(body)) !== null) {
      starts.push({
        name: match[1].toLowerCase(),
        valueStart: pattern.lastIndex,
        assignmentStart: match.index
      });
    }

    starts.forEach((field, index) => {
      const next = starts[index + 1];
      const end = next ? next.assignmentStart : body.length;
      const value = body
        .slice(field.valueStart, end)
        .replace(/,\s*$/, "")
        .trim();

      if (value) {
        fields[field.name] = value;
      }
    });

    return fields;
  }

  function parseFields(body) {
    const strict = parseFieldsStrict(body);
    const lineBased = parseFieldsByLine(body);
    return { ...strict, ...lineBased };
  }

  function findEntryStarts(text) {
    const starts = [];
    const pattern = /^[\t ]*@([A-Za-z]+)\s*([({])/gm;
    let match;

    while ((match = pattern.exec(text)) !== null) {
      const atOffset = match[0].indexOf("@");
      starts.push({
        start: match.index + atOffset,
        type: match[1].toLowerCase(),
        openChar: match[2],
        openIndex: pattern.lastIndex - 1
      });
    }

    return starts;
  }

  function normalizeDoi(value) {
    return latexToText(value)
      .replace(/^doi\s*:\s*/i, "")
      .replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, "")
      .replace(/\s+/g, "")
      .trim();
  }

  function extractUrl(value) {
    const normalized = stripOuterDelimiters(value)
      .replace(/&amp;/gi, "&")
      .replace(/\\url\s*\{([^{}]+)\}/gi, "$1");
    const match = normalized.match(/https?:\/\/[^\s{}"<>]+/i);
    return match ? match[0].replace(/[),.;]+$/, "") : "";
  }

  function parseEntrySegment(text, entry, nextStart, sourceFile) {
    if (["comment", "preamble", "string"].includes(entry.type)) {
      return null;
    }

    const segmentEnd = Number.isInteger(nextStart) ? nextStart : text.length;
    const segment = text.slice(entry.start, segmentEnd);
    const localOpenIndex = entry.openIndex - entry.start;
    const closeChar = entry.openChar === "{" ? "}" : ")";
    const balancedClose = readBalanced(segment, localOpenIndex, entry.openChar, closeChar);
    const fallbackClose = segment.lastIndexOf(closeChar);
    const closeIndex = balancedClose >= 0 ? balancedClose : fallbackClose;
    const bodyEnd = closeIndex > localOpenIndex ? closeIndex : segment.length;
    const entryBody = segment.slice(localOpenIndex + 1, bodyEnd);
    const commaIndex = entryBody.indexOf(",");

    if (commaIndex < 0) {
      return null;
    }

    const key = entryBody.slice(0, commaIndex).trim();
    if (!key) {
      return null;
    }

    const fields = parseFields(entryBody.slice(commaIndex + 1));
    const title = latexToText(fields.title || key);
    const journal = latexToText(
      fields.journal || fields.journaltitle || fields.booktitle || fields.publisher || ""
    );
    const pages = latexToText(
      fields.pages || fields.eid || fields.article_number || fields.articleno || ""
    );
    const volume = latexToText(fields.volume || "");
    const number = latexToText(fields.number || fields.issue || "");
    const publisher = latexToText(fields.publisher || fields.institution || "");
    const keywords = latexToText(fields.keywords || fields.keyword || fields.subject || "");
    const year = latexToText(fields.year || fields.date || "").match(/\d{4}/)?.[0] || "";
    const authorValue = fields.author || fields.editor || "";
    const authors = splitAuthors(authorValue);
    const abstract = normalizeAbstract(fields.abstract || "");
    const doi = normalizeDoi(fields.doi || "");
    const url = extractUrl(fields.url || fields.link || "");
    const entryEnd = balancedClose >= 0
      ? entry.start + balancedClose + 1
      : segmentEnd;

    return {
      key,
      type: entry.type,
      title,
      journal,
      pages,
      volume,
      number,
      publisher,
      keywords,
      year,
      authors,
      abstract,
      doi,
      url,
      sourceFile,
      entryStart: entry.start,
      entryEnd,
      fields
    };
  }

  function validateBibTeXFormatting(text) {
    const source = String(text || "");
    const starts = findEntryStarts(source);
    const errors = [];
    let parsedEntryCount = 0;

    starts.forEach((entry, index) => {
      const nextStart = starts[index + 1]?.start ?? source.length;
      const segment = source.slice(entry.start, nextStart);
      const localOpenIndex = entry.openIndex - entry.start;
      const closeChar = entry.openChar === "{" ? "}" : ")";
      const closeIndex = readBalanced(segment, localOpenIndex, entry.openChar, closeChar);
      if (closeIndex < 0) {
        errors.push(`Unbalanced ${entry.openChar}${closeChar} delimiters near character ${entry.start}.`);
        return;
      }
      const trailing = segment.slice(closeIndex + 1).trim();
      if (trailing && !trailing.startsWith("%")) {
        errors.push(`Unexpected text after the BibTeX entry near character ${entry.start}.`);
      }
      if (["comment", "preamble", "string"].includes(entry.type)) return;
      const record = parseEntrySegment(source, entry, nextStart, "");
      if (!record) {
        errors.push(`The BibTeX entry near character ${entry.start} has no valid citation key or field body.`);
        return;
      }
      parsedEntryCount += 1;
      for (const [fieldName, rawValue] of Object.entries(record.fields || {})) {
        const value = String(rawValue || "").trim();
        if (!value) continue;
        const first = value[0];
        if (first === "{") {
          if (matchingBraceIndex(value, 0) !== value.length - 1) {
            errors.push(`${record.key}.${fieldName} is not one balanced braced value.`);
          }
        } else if (first === '"') {
          if (matchingQuoteIndex(value, 0) !== value.length - 1) {
            errors.push(`${record.key}.${fieldName} is not one balanced quoted value.`);
          }
        } else if (!/^(?:[+-]?\d+(?:\.\d+)?|[A-Za-z][A-Za-z0-9_:.+-]*)$/.test(value)) {
          errors.push(`${record.key}.${fieldName} is not a single valid BibTeX value.`);
        }
      }
    });

    return {
      valid: errors.length === 0,
      errors,
      entryCount: parsedEntryCount,
      detectedEntryCount: starts.filter((entry) => !["comment", "preamble", "string"].includes(entry.type)).length
    };
  }

  function parseBibTeX(text, sourceFile = "") {
    const source = String(text || "");
    const starts = findEntryStarts(source);
    const records = [];

    starts.forEach((entry, index) => {
      const nextStart = starts[index + 1]?.start;
      try {
        const record = parseEntrySegment(source, entry, nextStart, sourceFile);
        if (record) {
          records.push(record);
        }
      } catch (error) {
        console.warn(
          `[Smart Citations] Skipped malformed BibTeX entry near character ${entry.start}:`,
          error
        );
      }
    });

    return records;
  }

  window.CollabTeXBibTeX = {
    parseBibTeX,
    latexToText,
    splitAuthors,
    splitAuthorsRaw,
    splitAuthorsDisplayRaw,
    formatAuthorName,
    formatAuthorNameRaw,
    authorFamilyName,
    createAuthorIndex,
    findAuthorCompletions,
    findAuthorCompletion,
    normalizeDoi,
    normalizeAbstract,
    extractUrl,
    stripSingleBalancedOuterDelimiter,
    repairBibBraceBalance,
    normalizeBibFieldContent,
    serializeBibFieldValue,
    extractBibFieldContent,
    canonicalizeSerializedBibFieldValue,
    validateBibTeXFormatting
  };
})();
