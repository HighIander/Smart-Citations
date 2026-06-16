(() => {
  "use strict";

  function stripOuterDelimiters(value) {
    let result = String(value || "").trim();
    let changed = true;

    while (changed && result.length >= 2) {
      changed = false;
      if (
        (result.startsWith("{") && result.endsWith("}")) ||
        (result.startsWith('"') && result.endsWith('"'))
      ) {
        result = result.slice(1, -1).trim();
        changed = true;
      }
    }

    return result;
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

  function splitAuthors(value) {
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
          authors.push(latexToText(current));
        }
        current = "";
        index += 5;
        continue;
      }

      current += char;
      index += 1;
    }

    if (current.trim()) {
      authors.push(latexToText(current));
    }

    return authors.filter(Boolean);
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
    normalizeDoi,
    normalizeAbstract,
    extractUrl
  };
})();
