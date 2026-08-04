/* SPDX-License-Identifier: CC-BY-NC-SA-4.0 */

(() => {
  "use strict";

  if (window.top !== window) return;

  // Smart Citations 2.2.2 marked an isolated writer by adding a query
  // parameter to the CollabTeX project URL. Some deployments remain on their
  // application loading screen when that unknown parameter is present. Newer
  // versions identify writer tabs by browser tab ID and therefore never alter
  // the project URL. Remove a stranded legacy marker before the editor app
  // starts so the normal project route can load.
  try {
    const url = new URL(window.location.href);
    if (!url.searchParams.has("ctcaSmartCitationsBibWorker")) return;
    url.searchParams.delete("ctcaSmartCitationsBibWorker");
    window.location.replace(url.href);
  } catch (_error) {
    // A malformed URL should be left to the browser and editor application.
  }
})();
