// Shared view metadata for the monitor: game modes, mode labels, and the
// per-view configuration (title/lede/requiresMode/requiresLocale).
//
// This file is intentionally a dual-module: `monitor/lib/config.js` requires it
// as CommonJS on the server, and the browser loads it as a static script
// (setting `window.viewMeta`) before `app.js`. Keeping the data in one place
// avoids the server/browser copies drifting apart.
(function () {
  "use strict";

  const DEFAULT_MODES = ["regular", "pve", "pvp-season"];
  const MODE_LABELS = {
    regular: "PvP",
    pve: "PvE",
    "pvp-season": "PvP PvE Seasonal",
    "pvp-pve-seasonal": "PvP PvE Seasonal",
  };

  const VIEW_CONFIG = {
    tasks: {
      title: "Task Overrides",
      lede: "Corrections from the overlay compared to tarkov.dev.",
      requiresMode: true,
    },
    tasksAdd: {
      title: "Task Additions",
      lede: "Task additions compared with upstream adoption.",
      requiresMode: true,
    },
    items: {
      title: "Item Overrides",
      lede: "Item corrections included in the overlay build.",
      requiresMode: true,
    },
    maps: {
      title: "Map Overrides",
      lede: "Map corrections and extract additions compared to tarkov.dev.",
      requiresMode: true,
    },
    hideout: {
      title: "Hideout Overrides",
      lede: "Hideout corrections included in the overlay build.",
      requiresMode: true,
    },
    traders: {
      title: "Trader Overrides",
      lede: "Trader corrections included in the overlay build.",
      requiresMode: true,
    },
    editions: {
      title: "Editions",
      lede: "Game editions defined by the overlay.",
      requiresMode: false,
    },
    storyChapters: {
      title: "Story Chapters",
      lede: "Storyline chapter additions in the overlay.",
      requiresMode: false,
    },
    itemsAdd: {
      title: "Item Additions",
      lede: "Items added by the overlay.",
      requiresMode: true,
    },
    prestige: {
      title: "Prestige Overrides",
      lede: "Prestige-level corrections included in the overlay build.",
      requiresMode: false,
    },
    locales: {
      title: "Locale Corrections",
      lede: "Per-locale translation corrections in the overlay.",
      requiresMode: true,
      requiresLocale: true,
    },
    seasonalPerks: {
      title: "Seasonal Perks",
      lede: "Raw seasonal (pvp-season) effect supplements; perk metadata comes from upstream.",
      requiresMode: true,
    },
    craftsAdd: {
      title: "Craft Additions",
      lede: "Hideout crafts added by the overlay.",
      requiresMode: true,
    },
  };

  function buildViewParams(view, mode, locale) {
    const params = new URLSearchParams({ view });
    const config = VIEW_CONFIG[view];
    if (config?.requiresMode) {
      params.set("mode", mode);
    }
    if (config?.requiresLocale) {
      params.set("locale", locale);
    }
    return params;
  }

  const meta = { DEFAULT_MODES, MODE_LABELS, VIEW_CONFIG, buildViewParams };

  if (typeof module === "object" && module.exports) {
    module.exports = meta;
  }
  if (typeof window !== "undefined") {
    window.viewMeta = meta;
  }
})();
