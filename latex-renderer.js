/* SPDX-License-Identifier: CC-BY-NC-SA-4.0 */

(function initCollabTeXLatexRenderer(global) {
  "use strict";

  const ACCENTS = {
    "'": "\u0301",
    "`": "\u0300",
    "\"": "\u0308",
    "^": "\u0302",
    "~": "\u0303",
    "=": "\u0304",
    ".": "\u0307",
    u: "\u0306",
    v: "\u030c",
    H: "\u030b",
    c: "\u0327",
    k: "\u0328",
    r: "\u030a",
    b: "\u0331",
    d: "\u0323"
  };

  const SYMBOLS = {
    aa: "å",
    AA: "Å",
    ae: "æ",
    AE: "Æ",
    oe: "œ",
    OE: "Œ",
    o: "ø",
    O: "Ø",
    l: "ł",
    L: "Ł",
    ss: "ß",
    i: "i",
    j: "j",
    LaTeX: "LaTeX",
    TeX: "TeX",
    textbackslash: "\\",
    textasciitilde: "~",
    textasciicircum: "^",
    alpha: "α",
    beta: "β",
    gamma: "γ",
    delta: "δ",
    epsilon: "ε",
    theta: "θ",
    lambda: "λ",
    mu: "μ",
    pi: "π",
    sigma: "σ",
    phi: "φ",
    omega: "ω",
    Gamma: "Γ",
    Delta: "Δ",
    Theta: "Θ",
    Lambda: "Λ",
    Pi: "Π",
    Sigma: "Σ",
    Phi: "Φ",
    Omega: "Ω",
    times: "×",
    cdot: "·",
    pm: "±",
    le: "≤",
    leq: "≤",
    ge: "≥",
    geq: "≥",
    neq: "≠",
    infty: "∞"
  };

  const TEXT_COMMANDS = new Set([
    "emph", "text", "textrm", "textsf", "texttt", "textnormal",
    "textup", "textsl", "textsc", "textbf", "textit", "mathrm",
    "mathbf", "mathit", "mathsf", "mathtt", "operatorname"
  ]);

  function escapeHtml(value) {
    return String(value ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function applyAccents(value) {
    let text = String(value ?? "");
    for (let pass = 0; pass < 4; pass += 1) {
      const previous = text;
      text = text.replace(
        /\\(['`"^~=.\u0061-\u007a])\s*\{\s*\\?([A-Za-z])\s*\}/g,
        (match, accent, letter) => {
          const combining = ACCENTS[accent];
          return combining ? `${letter}${combining}`.normalize("NFC") : match;
        }
      );
      text = text.replace(
        /\\([uvHckrbd])\s*\{\s*\\?([A-Za-z])\s*\}/g,
        (match, accent, letter) => `${letter}${ACCENTS[accent]}`.normalize("NFC")
      );
      text = text.replace(
        /\\(['`"^~=.\u0061-\u007a])\s*\\?([A-Za-z])/g,
        (match, accent, letter) => {
          const combining = ACCENTS[accent];
          return combining ? `${letter}${combining}`.normalize("NFC") : match;
        }
      );
      text = text.replace(
        /\\([uvHckrbd])\s*\\?([A-Za-z])/g,
        (match, accent, letter) => `${letter}${ACCENTS[accent]}`.normalize("NFC")
      );
      if (text === previous) break;
    }
    return text;
  }

  function findClosingBrace(text, start) {
    let depth = 0;
    for (let index = start; index < text.length; index += 1) {
      if (text[index] === "\\") {
        index += 1;
      } else if (text[index] === "{") {
        depth += 1;
      } else if (text[index] === "}") {
        depth -= 1;
        if (depth === 0) return index;
      }
    }
    return -1;
  }

  function readArgument(text, start) {
    let index = start;
    while (index < text.length && /\s/.test(text[index])) index += 1;
    if (text[index] === "{") {
      const end = findClosingBrace(text, index);
      if (end >= 0) return { value: text.slice(index + 1, end), end: end + 1 };
    }
    return { value: text[index] || "", end: Math.min(text.length, index + 1) };
  }

  function renderSegment(text, mathMode = false) {
    let html = "";
    let index = 0;

    while (index < text.length) {
      const character = text[index];

      if (!mathMode && character === "$") {
        const doubleDelimiter = text[index + 1] === "$";
        const delimiter = doubleDelimiter ? "$$" : "$";
        const start = index + delimiter.length;
        const end = text.indexOf(delimiter, start);
        if (end >= 0) {
          html += renderSegment(text.slice(start, end), true);
          index = end + delimiter.length;
          continue;
        }
      }

      if (mathMode && (character === "^" || character === "_")) {
        const argument = readArgument(text, index + 1);
        const tag = character === "^" ? "sup" : "sub";
        html += `<${tag}>${renderSegment(argument.value, true)}</${tag}>`;
        index = argument.end;
        continue;
      }

      if (character === "{" || character === "}") {
        index += 1;
        continue;
      }

      if (character === "\\") {
        const next = text[index + 1] || "";
        if (/[%$&#_{}]/.test(next)) {
          html += escapeHtml(next);
          index += 2;
          continue;
        }
        if (next === "\\") {
          html += "\n";
          index += 2;
          continue;
        }

        const commandMatch = text.slice(index + 1).match(/^([A-Za-z]+)/);
        if (commandMatch) {
          const command = commandMatch[1];
          index += command.length + 1;
          if (Object.prototype.hasOwnProperty.call(SYMBOLS, command)) {
            html += escapeHtml(SYMBOLS[command]);
            continue;
          }
          if (TEXT_COMMANDS.has(command) || command === "textsuperscript" || command === "textsubscript") {
            const argument = readArgument(text, index);
            if (command === "textsuperscript") html += `<sup>${renderSegment(argument.value, mathMode)}</sup>`;
            else if (command === "textsubscript") html += `<sub>${renderSegment(argument.value, mathMode)}</sub>`;
            else html += renderSegment(argument.value, mathMode);
            index = argument.end;
            continue;
          }
          const argument = readArgument(text, index);
          if (argument.value) {
            html += renderSegment(argument.value, mathMode);
            index = argument.end;
          } else {
            html += escapeHtml(command);
          }
          continue;
        }

        html += escapeHtml(next);
        index += next ? 2 : 1;
        continue;
      }

      html += escapeHtml(character);
      index += 1;
    }

    return html;
  }

  function toHtml(value) {
    return renderSegment(applyAccents(value));
  }

  function toText(value) {
    return toHtml(value)
      .replace(/<\/?(?:sup|sub)>/g, "")
      .replace(/&quot;/g, "\"")
      .replace(/&#39;/g, "'")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&amp;/g, "&");
  }

  global.CollabTeXLatex = Object.freeze({ toHtml, toText });
})(globalThis);
