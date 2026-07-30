/* SPDX-License-Identifier: CC-BY-NC-SA-4.0 */

(() => {
  "use strict";

  const extensionApi = globalThis.browser ?? globalThis.chrome;
  const workCache = new Map();
  let requestSequence = 0;

  function stripBibValue(value) {
    let text = String(value ?? "").trim();
    for (let depth = 0; depth < 4 && text.length >= 2; depth += 1) {
      const braced = text.startsWith("{") && text.endsWith("}");
      const quoted = text.startsWith('"') && text.endsWith('"');
      if (!braced && !quoted) break;
      text = text.slice(1, -1).trim();
    }
    return text;
  }

  function normalizeDoi(value) {
    return stripBibValue(value)
      .replace(/^doi\s*:\s*/i, "")
      .replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, "")
      .replace(/[\s<>]+/g, "")
      .replace(/[),.;]+$/, "")
      .toLowerCase();
  }

  function normalizeTitle(value) {
    return stripBibValue(value)
      .replace(/\\[a-z]+\*?(?:\[[^\]]*\])?\{([^{}]*)\}/gi, "$1")
      .replace(/[{}\\]/g, " ")
      .normalize("NFKD")
      .replace(/\p{M}/gu, "")
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  function authorText(record, fields) {
    if (Array.isArray(record?.authors)) {
      return record.authors.map((author) =>
        typeof author === "string"
          ? author
          : author?.name || [author?.given, author?.family].filter(Boolean).join(" ")
      ).filter(Boolean).join(" and ");
    }
    return stripBibValue(record?.author || fields?.author || "");
  }

  function descriptor(record, lookupKey = "") {
    const fields = record?.fields || {};
    const doi = normalizeDoi(record?.doi || fields.doi || "");
    const title = stripBibValue(record?.title || fields.title || "");
    const year = String(record?.year || fields.year || "").match(/\d{4}/)?.[0] || "";
    const authors = authorText(record, fields);
    const identity = doi
      ? `doi:${doi}`
      : title
        ? `title:${normalizeTitle(title)}|${year}`
        : "";
    return {
      lookupKey: String(lookupKey || record?.id || record?.key || identity),
      identity,
      doi,
      title,
      year,
      authors
    };
  }

  function uniqueDescriptors(items) {
    const byIdentity = new Map();
    for (const item of items || []) {
      if (!item?.identity || byIdentity.has(item.identity)) continue;
      byIdentity.set(item.identity, item);
    }
    return [...byIdentity.values()];
  }

  async function fetchWorks(items) {
    const unique = uniqueDescriptors(items);
    const missing = unique.filter((item) => !workCache.has(item.identity));
    if (missing.length) {
      const response = await extensionApi.runtime.sendMessage({
        type: "ctca-openalex-fetch-works",
        items: missing
      });
      if (!response?.ok) {
        const error = new Error(response?.error || "OpenAlex citation data could not be retrieved.");
        error.configurationRequired = response?.configurationRequired === true;
        throw error;
      }
      for (const result of response.results || []) {
        if (result?.identity) workCache.set(result.identity, result.work || null);
      }
      for (const item of missing) {
        if (!workCache.has(item.identity)) workCache.set(item.identity, null);
      }
    }
    return new Map(unique.map((item) => [item.identity, workCache.get(item.identity) || null]));
  }

  function citationLabel(count) {
    const value = Number(count) || 0;
    return `Citations: ${value.toLocaleString()}`;
  }

  async function hydrateCitations(root, rawDescriptors) {
    if (!root) return;
    const descriptors = (rawDescriptors || []).map((item) =>
      item?.identity ? item : descriptor(item)
    ).filter((item) => item.identity);
    if (!descriptors.length) return;
    const byLookupKey = new Map(descriptors.map((item) => [item.lookupKey, item]));
    let works;
    try {
      works = await fetchWorks(descriptors);
    } catch (error) {
      root.querySelectorAll(".ctca-openalex-citation[data-openalex-lookup-key]").forEach((element) => {
        if (!byLookupKey.has(element.dataset.openalexLookupKey || "")) return;
        element.textContent = "Citations: —";
        element.hidden = false;
        element.title = error.configurationRequired
          ? "Add a free OpenAlex API key in Smart Citations options to show citation counts."
          : error.message;
      });
      return;
    }
    root.querySelectorAll(".ctca-openalex-citation[data-openalex-lookup-key]").forEach((element) => {
      const item = byLookupKey.get(element.dataset.openalexLookupKey || "");
      if (!item) return;
      const work = works.get(item.identity);
      if (!work || !Number.isFinite(Number(work.citedByCount))) {
        element.textContent = "Citations: —";
        element.hidden = false;
        element.title = "No reliable OpenAlex match was found for this reference.";
        return;
      }
      element.textContent = citationLabel(work.citedByCount);
      element.title = `OpenAlex citation count, updated ${work.fetchedDate || "recently"}. Citation counts vary between databases.`;
      element.hidden = false;
    });
  }

  function impactPlaceholderHtml() {
    return `
      <section class="ctca-openalex-impact" aria-label="OpenAlex author impact">
        <div class="ctca-openalex-impact-head">
          <div>
            <span class="ctca-openalex-kicker">OpenAlex</span>
            <h3>Author impact</h3>
          </div>
          <span class="ctca-openalex-impact-state" role="status">Loading…</span>
          <button type="button" class="ctca-openalex-impact-toggle" aria-expanded="true" title="Minimize Author impact" aria-label="Minimize Author impact">−</button>
        </div>
        <div class="ctca-openalex-impact-body"></div>
      </section>
      <div class="ctca-openalex-impact-resizer" role="separator" aria-orientation="horizontal" tabindex="0" title="Drag to resize author impact"></div>
    `;
  }

  function bindImpactResize(slot, { height = 300, onChange = null } = {}) {
    if (!slot) return;
    const handle = slot.querySelector(".ctca-openalex-impact-resizer");
    if (!handle) return;
    const clamp = (value) => {
      const parentHeight = slot.parentElement?.getBoundingClientRect().height || window.innerHeight;
      return Math.max(120, Math.min(Math.max(160, parentHeight - 180), Number(value) || 300));
    };
    const apply = (value) => {
      const next = clamp(value);
      slot.parentElement?.style.setProperty("--ctca-openalex-impact-height", `${next}px`);
      slot.style.removeProperty("height");
      return next;
    };
    let currentHeight = apply(height);
    handle.addEventListener("pointerdown", (event) => {
      if (event.button !== 0) return;
      event.preventDefault();
      const startY = event.clientY;
      const startHeight = slot.getBoundingClientRect().height;
      handle.setPointerCapture?.(event.pointerId);
      slot.classList.add("ctca-openalex-impact-resizing");
      const move = (moveEvent) => {
        currentHeight = apply(startHeight + moveEvent.clientY - startY);
      };
      const finish = () => {
        document.removeEventListener("pointermove", move, true);
        document.removeEventListener("pointerup", finish, true);
        document.removeEventListener("pointercancel", finish, true);
        slot.classList.remove("ctca-openalex-impact-resizing");
        if (typeof onChange === "function") onChange(currentHeight);
      };
      document.addEventListener("pointermove", move, true);
      document.addEventListener("pointerup", finish, true);
      document.addEventListener("pointercancel", finish, true);
    });
    handle.addEventListener("keydown", (event) => {
      if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
      event.preventDefault();
      currentHeight = apply(currentHeight + (event.key === "ArrowDown" ? 1 : -1) * (event.shiftKey ? 40 : 10));
      if (typeof onChange === "function") onChange(currentHeight);
    });
  }

  function bindImpactCollapse(slot, { collapsed = false, onChange = null } = {}) {
    if (!slot) return;
    const button = slot.querySelector(".ctca-openalex-impact-toggle");
    if (!button) return;
    const apply = (value) => {
      const next = Boolean(value);
      slot.classList.toggle("ctca-openalex-impact-collapsed", next);
      slot.parentElement?.classList.toggle("ctca-openalex-impact-collapsed", next);
      button.textContent = next ? "+" : "−";
      button.title = next ? "Expand Author impact" : "Minimize Author impact";
      button.setAttribute("aria-label", button.title);
      button.setAttribute("aria-expanded", next ? "false" : "true");
      return next;
    };
    let current = apply(collapsed);
    button.addEventListener("click", () => {
      current = apply(!current);
      if (typeof onChange === "function") onChange(current);
    });
  }

  function appendMetric(container, label, value, explanation) {
    const metric = document.createElement("div");
    metric.className = "ctca-openalex-metric";
    metric.tabIndex = 0;
    metric.title = explanation;
    const valueNode = document.createElement("strong");
    valueNode.textContent = value;
    const labelNode = document.createElement("span");
    labelNode.textContent = label;
    metric.append(valueNode, labelNode);
    container.appendChild(metric);
  }

  function fillYears(countsByYear) {
    const byYear = new Map(
      (countsByYear || [])
        .map((item) => [Number(item?.year), Number(item?.citedByCount) || 0])
        .filter(([year]) => Number.isInteger(year))
    );
    const nonzeroYears = [...byYear.entries()]
      .filter(([, count]) => count > 0)
      .map(([year]) => year);
    if (!nonzeroYears.length) return [];
    const firstYear = Math.min(...nonzeroYears);
    const lastYear = Math.max(new Date().getFullYear(), ...byYear.keys());
    const result = [];
    for (let year = firstYear; year <= lastYear; year += 1) {
      result.push({ year, citedByCount: byYear.get(year) || 0 });
    }
    return result;
  }

  function appendChart(container, countsByYear) {
    const section = document.createElement("div");
    section.className = "ctca-openalex-chart-section";
    const heading = document.createElement("div");
    heading.className = "ctca-openalex-chart-heading";
    const title = document.createElement("strong");
    title.textContent = "Citations per year";
    const note = document.createElement("span");
    note.textContent = "Available OpenAlex history";
    note.title = "OpenAlex supplies annual author counts for its available recent history. Years without citations are shown as zero.";
    heading.append(title, note);
    section.appendChild(heading);

    const years = fillYears(countsByYear);
    if (!years.length) {
      const empty = document.createElement("div");
      empty.className = "ctca-openalex-chart-empty";
      empty.textContent = "No annual citation history is available yet.";
      section.appendChild(empty);
      container.appendChild(section);
      return;
    }

    const maximum = Math.max(1, ...years.map((item) => item.citedByCount));
    const chart = document.createElement("div");
    chart.className = "ctca-openalex-chart";
    chart.setAttribute("role", "img");
    chart.setAttribute(
      "aria-label",
      years.map((item) => `${item.year}: ${item.citedByCount} citations`).join("; ")
    );
    for (const item of years) {
      const column = document.createElement("div");
      column.className = "ctca-openalex-chart-column";
      column.title = `${item.year}: ${item.citedByCount.toLocaleString()} ${item.citedByCount === 1 ? "citation" : "citations"}`;
      const count = document.createElement("span");
      count.className = "ctca-openalex-chart-count";
      count.textContent = item.citedByCount.toLocaleString();
      const track = document.createElement("span");
      track.className = "ctca-openalex-chart-track";
      const bar = document.createElement("span");
      bar.className = "ctca-openalex-chart-bar";
      bar.style.height = item.citedByCount
        ? `${Math.max(4, (item.citedByCount / maximum) * 100)}%`
        : "0";
      track.appendChild(bar);
      const year = document.createElement("span");
      year.className = "ctca-openalex-chart-year";
      year.textContent = String(item.year).slice(-2);
      column.append(count, track, year);
      chart.appendChild(column);
    }
    section.appendChild(chart);
    container.appendChild(section);
  }

  function showImpactMessage(section, message, { configurationRequired = false } = {}) {
    const state = section.querySelector(".ctca-openalex-impact-state");
    const body = section.querySelector(".ctca-openalex-impact-body");
    if (state) state.textContent = configurationRequired ? "Setup needed" : "Unavailable";
    if (!body) return;
    body.replaceChildren();
    const messageNode = document.createElement("p");
    messageNode.className = "ctca-openalex-impact-message";
    messageNode.textContent = message;
    body.appendChild(messageNode);
    if (configurationRequired) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "ctca-openalex-options-button";
      button.textContent = "Open options";
      button.addEventListener("click", () => extensionApi.runtime.openOptionsPage());
      body.appendChild(button);
    }
  }

  function renderImpact(section, profile) {
    const state = section.querySelector(".ctca-openalex-impact-state");
    const body = section.querySelector(".ctca-openalex-impact-body");
    if (!body) return;
    body.replaceChildren();
    if (state) {
      const matchLabel = profile.matchSource === "configured"
        ? "Linked profile"
        : `Matched from ${profile.matchCount || 1} reference${profile.matchCount === 1 ? "" : "s"}`;
      const filterLabel = profile.affiliationFiltered ? " · filtered" : "";
      const cacheLabel = profile.cacheStatus === "cached" ? " · cached" : " · daily refresh";
      state.textContent = `${matchLabel}${filterLabel}${cacheLabel}`;
    }

    const identity = document.createElement("div");
    identity.className = "ctca-openalex-author-identity";
    const name = document.createElement("a");
    name.textContent = profile.displayName || "OpenAlex author";
    name.href = profile.id || "#";
    name.target = "_blank";
    name.rel = "noopener noreferrer";
    identity.appendChild(name);
    if (profile.orcid) {
      const orcid = document.createElement("a");
      const orcidId = profile.orcid.replace(/^https?:\/\/orcid\.org\//i, "");
      orcid.textContent = `ORCID ${orcidId}`;
      orcid.href = `https://orcid.org/${orcidId}`;
      orcid.target = "_blank";
      orcid.rel = "noopener noreferrer";
      identity.appendChild(orcid);
    }
    body.appendChild(identity);

    const metrics = document.createElement("div");
    metrics.className = "ctca-openalex-metrics";
    const stats = profile.summaryStats || {};
    appendMetric(
      metrics,
      "h-index",
      Number(stats.hIndex || 0).toLocaleString(),
      "The largest number h for which the author has at least h works that have each been cited at least h times."
    );
    appendMetric(
      metrics,
      "i10-index",
      Number(stats.i10Index || 0).toLocaleString(),
      "The number of the author's works that have each received at least 10 citations."
    );
    appendMetric(
      metrics,
      "Citations",
      Number(profile.citedByCount || 0).toLocaleString(),
      "The total citation count recorded for this OpenAlex author profile. Counts can differ from other databases."
    );
    appendMetric(
      metrics,
      "Works",
      Number(profile.worksCount || 0).toLocaleString(),
      "The number of scholarly works assigned to this OpenAlex author profile."
    );
    const citationsPerWork = Number(profile.worksCount) > 0
      ? Number(profile.citedByCount || 0) / Number(profile.worksCount)
      : 0;
    appendMetric(
      metrics,
      "Citations / work",
      citationsPerWork.toLocaleString(undefined, { maximumFractionDigits: 1 }),
      "Total OpenAlex citations divided by the number of works assigned to this author profile."
    );
    if (Number.isFinite(Number(stats.twoYearMeanCitedness))) {
      appendMetric(
        metrics,
        "2-year mean",
        Number(stats.twoYearMeanCitedness).toLocaleString(undefined, { maximumFractionDigits: 2 }),
        "OpenAlex's mean citedness measure for the author's works over the most recent two-year window."
      );
    }
    body.appendChild(metrics);
    appendChart(body, profile.countsByYear);

    const footnote = document.createElement("p");
    footnote.className = "ctca-openalex-impact-footnote";
    const filterText = profile.affiliationFiltered
      ? ` Filtered to works where this author is affiliated with: ${(profile.filterInstitutions || []).join("; ")}.`
      : "";
    const updatedAt = profile.cacheUpdatedAt
      ? new Date(profile.cacheUpdatedAt).toLocaleString()
      : profile.fetchedDate || "recently";
    const refreshAfter = profile.cacheRefreshAfter
      ? new Date(profile.cacheRefreshAfter).toLocaleString()
      : "";
    footnote.textContent = `OpenAlex is queried at most once every 24 hours. Showing cached data refreshed ${updatedAt}${refreshAfter ? `; eligible for refresh after ${refreshAfter}` : ""}. Metrics use OpenAlex coverage and may differ from Google Scholar, Web of Science, or Scopus.${filterText}`;
    body.appendChild(footnote);
  }

  async function hydrateAuthorImpact(section, rawDescriptors, userName) {
    if (!section) return;
    const token = String(++requestSequence);
    section.dataset.openalexRequest = token;
    const descriptors = (rawDescriptors || []).map((item) =>
      item?.identity ? item : descriptor(item)
    ).filter((item) => item.identity);
    try {
      const response = await extensionApi.runtime.sendMessage({
        type: "ctca-openalex-author-impact",
        items: uniqueDescriptors(descriptors),
        userName: String(userName || "")
      });
      if (section.dataset.openalexRequest !== token) return;
      if (!response?.ok) {
        showImpactMessage(
          section,
          response?.configurationRequired
            ? "Add your free OpenAlex API key in Smart Citations options. You can optionally link an OpenAlex author ID or ORCID for exact author matching."
            : response?.error || "The OpenAlex author profile could not be loaded.",
          { configurationRequired: response?.configurationRequired === true }
        );
        return;
      }
      if (!response.profile) {
        showImpactMessage(
          section,
          "No OpenAlex author profile could be matched confidently. Add an OpenAlex author ID or ORCID in Smart Citations options."
        );
        return;
      }
      renderImpact(section, response.profile);
    } catch (error) {
      if (section.dataset.openalexRequest === token) {
        showImpactMessage(section, error?.message || String(error));
      }
    }
  }

  globalThis.SmartCitationsOpenAlex = Object.freeze({
    descriptor,
    hydrateCitations,
    hydrateAuthorImpact,
    bindImpactResize,
    bindImpactCollapse,
    impactPlaceholderHtml,
    isAuthorCategory: (categoryId) => categoryId === "authorships" || categoryId === "coauthorships"
  });
})();
