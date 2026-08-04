/* SPDX-License-Identifier: CC-BY-NC-SA-4.0 */

(() => {
  "use strict";

  function normalizeDoi(value) {
    return String(value ?? "")
      .trim()
      .replace(/^doi\s*:\s*/i, "")
      .replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, "")
      .replace(/[\s<>]+/g, "")
      .replace(/[),.;]+$/, "")
      .toLocaleLowerCase();
  }

  function stripOuterDelimiters(value) {
    let text = String(value ?? "").trim();
    for (let pass = 0; pass < 6 && text.length >= 2; pass += 1) {
      const braced = text.startsWith("{") && text.endsWith("}");
      const quoted = text.startsWith('"') && text.endsWith('"');
      if (!braced && !quoted) break;
      text = text.slice(1, -1).trim();
    }
    return text;
  }

  function normalizeText(value, latexToText = null) {
    let text = stripOuterDelimiters(value).normalize("NFKC");
    if (typeof latexToText === "function") {
      try { text = latexToText(text); } catch (_error) {}
    }
    return String(text ?? "")
      .normalize("NFKC")
      .replace(/\s+/g, " ")
      .trim()
      .toLocaleLowerCase();
  }

  function fieldValue(item, names) {
    const fields = item?.fields || {};
    for (const name of names) {
      const direct = fields[name];
      if (direct != null && String(direct).trim()) return direct;
      const actual = Object.keys(fields).find((candidate) => candidate.toLocaleLowerCase() === name);
      if (actual && String(fields[actual] ?? "").trim()) return fields[actual];
    }
    return "";
  }

  function mainFieldValues(item, latexToText = null) {
    return {
      title: normalizeText(fieldValue(item, ["title"]), latexToText),
      journal: normalizeText(fieldValue(item, ["journal", "journaltitle"]), latexToText),
      number: normalizeText(fieldValue(item, ["number"]), latexToText),
      page: normalizeText(fieldValue(item, ["pages", "page"]), latexToText),
      year: normalizeText(fieldValue(item, ["year", "date"]), latexToText)
    };
  }

  function mainSignature(item, latexToText = null) {
    const fields = mainFieldValues(item, latexToText);
    if (!fields.title) return "";
    if (!fields.journal && !fields.number && !fields.page && !fields.year) return "";
    return [fields.title, fields.journal, fields.number, fields.page, fields.year].join("\u241f");
  }

  function completeness(item, internalFields = null) {
    const excluded = internalFields instanceof Set
      ? internalFields
      : new Set(Array.isArray(internalFields) ? internalFields : []);
    let filled = 0;
    let characters = 0;
    for (const [rawName, rawValue] of Object.entries(item?.fields || {})) {
      const name = String(rawName || "").toLocaleLowerCase();
      if (!name || excluded.has(name) || name === "ids") continue;
      const value = stripOuterDelimiters(rawValue).trim();
      if (!value) continue;
      filled += 1;
      characters += value.length;
    }
    if (Array.isArray(item?.tags) && item.tags.length) filled += 1;
    if (Array.isArray(item?.comments) && item.comments.length) filled += 1;
    if (Array.isArray(item?.crosslinks) && item.crosslinks.length) filled += 1;
    return { filled, characters };
  }

  function findGroups(items, options = {}) {
    const getId = options.getId || ((item, index) => String(item?.id ?? item?.key ?? index));
    const getKey = options.getKey || ((item) => String(item?.key || ""));
    const latexToText = options.latexToText || null;
    const internalFields = options.internalFields || null;
    const values = (items || []).filter(Boolean);
    const parent = values.map((_, index) => index);
    const reasonByRootPair = new Map();

    const find = (index) => {
      let current = index;
      while (parent[current] !== current) {
        parent[current] = parent[parent[current]];
        current = parent[current];
      }
      return current;
    };
    const unite = (left, right, reason) => {
      const first = find(left);
      const second = find(right);
      if (first !== second) parent[second] = first;
      reasonByRootPair.set(`${Math.min(left, right)}:${Math.max(left, right)}`, reason);
    };

    const byDoi = new Map();
    const byMain = new Map();
    values.forEach((item, index) => {
      const doi = normalizeDoi(fieldValue(item, ["doi"]));
      if (doi) {
        if (byDoi.has(doi)) unite(byDoi.get(doi), index, "doi");
        else byDoi.set(doi, index);
      }
      const signature = mainSignature(item, latexToText);
      if (signature) {
        if (byMain.has(signature)) unite(byMain.get(signature), index, "main");
        else byMain.set(signature, index);
      }
    });

    const grouped = new Map();
    values.forEach((item, index) => {
      const root = find(index);
      if (!grouped.has(root)) grouped.set(root, []);
      grouped.get(root).push({ item, index });
    });

    return [...grouped.values()]
      .filter((group) => group.length > 1)
      .map((group, groupIndex) => {
        const decorated = group.map(({ item, index }) => ({
          item,
          id: getId(item, index),
          key: getKey(item),
          index,
          score: completeness(item, internalFields),
          doi: normalizeDoi(fieldValue(item, ["doi"])),
          main: mainFieldValues(item, latexToText)
        }));
        decorated.sort((left, right) =>
          right.score.filled - left.score.filled ||
          right.score.characters - left.score.characters ||
          left.key.localeCompare(right.key)
        );
        const reasons = new Set();
        for (let left = 0; left < decorated.length; left += 1) {
          for (let right = left + 1; right < decorated.length; right += 1) {
            if (decorated[left].doi && decorated[left].doi === decorated[right].doi) reasons.add("doi");
            const leftMain = mainSignature(decorated[left].item, latexToText);
            const rightMain = mainSignature(decorated[right].item, latexToText);
            if (leftMain && leftMain === rightMain) reasons.add("main");
          }
        }
        return {
          id: `duplicate-group-${groupIndex}`,
          items: decorated,
          preferredId: decorated[0].id,
          reasons: [...reasons],
          distinctKeys: [...new Set(decorated.map((entry) => entry.key).filter(Boolean))]
        };
      })
      .sort((left, right) => {
        const leftTitle = left.items[0]?.main?.title || left.items[0]?.key || "";
        const rightTitle = right.items[0]?.main?.title || right.items[0]?.key || "";
        return leftTitle.localeCompare(rightTitle);
      });
  }

  function createReviewControl(groups, options = {}) {
    const doc = options.document || document;
    const wrapper = doc.createElement("div");
    wrapper.className = "ctca-duplicate-review";
    const state = new Map();

    for (const group of groups) {
      const groupState = {
        enabled: true,
        keeperId: group.preferredId,
        keyId: group.preferredId
      };
      state.set(group.id, groupState);

      const card = doc.createElement("section");
      card.className = "ctca-duplicate-group";
      card.dataset.duplicateGroupId = group.id;

      const heading = doc.createElement("label");
      heading.className = "ctca-duplicate-group-toggle";
      const groupToggle = doc.createElement("input");
      groupToggle.type = "checkbox";
      groupToggle.checked = true;
      const reason = group.reasons.includes("doi") && group.reasons.includes("main")
        ? "same DOI and main fields"
        : group.reasons.includes("doi") ? "same DOI" : "same main fields";
      heading.append(groupToggle, doc.createTextNode(` Delete duplicates in this group (${reason})`));
      card.appendChild(heading);

      const rows = doc.createElement("div");
      rows.className = "ctca-duplicate-entries";
      const keepChecks = new Map();
      const keyChecks = new Map();

      const setKeeper = (id) => {
        groupState.keeperId = id;
        for (const [candidateId, input] of keepChecks) input.checked = candidateId === id;
        if (!group.items.some((entry) => entry.id === groupState.keyId)) groupState.keyId = id;
      };
      const setKey = (id) => {
        groupState.keyId = id;
        for (const [candidateId, input] of keyChecks) input.checked = candidateId === id;
      };

      for (const candidate of group.items) {
        const row = doc.createElement("div");
        row.className = "ctca-duplicate-entry";
        const keepLabel = doc.createElement("label");
        keepLabel.className = "ctca-duplicate-keep";
        const keep = doc.createElement("input");
        keep.type = "checkbox";
        keep.checked = candidate.id === group.preferredId;
        keepChecks.set(candidate.id, keep);
        keep.addEventListener("change", () => {
          if (keep.checked) setKeeper(candidate.id);
          else if (groupState.keeperId === candidate.id) keep.checked = true;
        });
        keepLabel.append(keep, doc.createTextNode(" Keep entry"));

        const description = doc.createElement("div");
        description.className = "ctca-duplicate-entry-description";
        const title = options.getTitle?.(candidate.item) || candidate.main.title || "Untitled entry";
        const source = options.getSource?.(candidate.item) || "";
        description.innerHTML = `<strong>${escapeHtml(candidate.key || "(no citation key)")}</strong><span>${escapeHtml(title)}</span><small>${candidate.score.filled} filled fields${source ? ` · ${escapeHtml(source)}` : ""}</small>`;
        row.append(keepLabel, description);
        rows.appendChild(row);
      }
      card.appendChild(rows);

      if (group.distinctKeys.length > 1) {
        const keySection = doc.createElement("div");
        keySection.className = "ctca-duplicate-key-choice";
        const keyHeading = doc.createElement("strong");
        keyHeading.textContent = "Citation key to keep";
        keySection.appendChild(keyHeading);
        for (const candidate of group.items.filter((entry, index, array) =>
          array.findIndex((other) => other.key.toLocaleLowerCase() === entry.key.toLocaleLowerCase()) === index
        )) {
          const label = doc.createElement("label");
          const checkbox = doc.createElement("input");
          checkbox.type = "checkbox";
          checkbox.checked = candidate.id === groupState.keyId;
          keyChecks.set(candidate.id, checkbox);
          checkbox.addEventListener("change", () => {
            if (checkbox.checked) setKey(candidate.id);
            else if (groupState.keyId === candidate.id) checkbox.checked = true;
          });
          label.append(checkbox, doc.createTextNode(` ${candidate.key}`));
          keySection.appendChild(label);
        }
        card.appendChild(keySection);
      }

      groupToggle.addEventListener("change", () => {
        groupState.enabled = groupToggle.checked;
        card.classList.toggle("ctca-duplicate-group-disabled", !groupToggle.checked);
        rows.querySelectorAll("input").forEach((input) => { input.disabled = !groupToggle.checked; });
        card.querySelectorAll(".ctca-duplicate-key-choice input").forEach((input) => { input.disabled = !groupToggle.checked; });
      });
      wrapper.appendChild(card);
    }

    return {
      element: wrapper,
      getSelection() {
        return groups.flatMap((group) => {
          const current = state.get(group.id);
          if (!current?.enabled) return [];
          const keeper = group.items.find((candidate) => candidate.id === current.keeperId) || group.items[0];
          const keySource = group.items.find((candidate) => candidate.id === current.keyId) || keeper;
          return [{
            group,
            keeperId: keeper.id,
            citationKey: keySource.key
          }];
        });
      }
    };
  }

  function escapeHtml(value) {
    return String(value ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  globalThis.SmartCitationsDuplicates = {
    normalizeDoi,
    normalizeText,
    mainFieldValues,
    mainSignature,
    completeness,
    findGroups,
    createReviewControl
  };
})();
