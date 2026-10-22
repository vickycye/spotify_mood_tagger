// The "Tagged songs" page. Spicetify calls render() when you open the page from the sidebar.
// Tag data and helpers come from vibeTagger.js, which runs at startup and sets window.VibeTagger.

const react = Spicetify.React;
const h = react.createElement;
const { useState, useEffect } = react;

const SORTS = {
  recent: { label: "Recently tagged", compare: (a, b) => b.taggedAt - a.taggedAt },
  title: { label: "Title", compare: (a, b) => a.name.localeCompare(b.name) },
  artist: { label: "Artist", compare: (a, b) => a.artist.localeCompare(b.artist) },
  tag: { label: "Tag (grouped)", compare: (a, b) => a.name.localeCompare(b.name) },
};

function render() {
  return h(TaggedSongsPage);
}

// Re-reads the store whenever a tag changes anywhere in the app.
function useStore() {
  const vt = window.VibeTagger;
  const [data, setData] = useState(() => vt.load());
  useEffect(() => {
    const refresh = () => setData(vt.load());
    window.addEventListener(vt.CHANGED_EVENT, refresh);
    return () => window.removeEventListener(vt.CHANGED_EVENT, refresh);
  }, []);
  return data;
}

function TaggedSongsPage() {
  if (!window.VibeTagger) {
    return h("div", { className: "vt-page" },
      h("h1", null, "Tagged songs"),
      h("p", null, "The Vibe Tagger extension didn't load. Run spicetify apply and restart Spotify.")
    );
  }
  return h(Page);
}

function Page() {
  const vt = window.VibeTagger;
  const data = useStore();
  const [selected, setSelected] = useState([]); // vibes to filter by; a song must have all of them
  const [sort, setSort] = useState("recent");
  const [showBackup, setShowBackup] = useState(false);

  const vibes = vt.allVibes(data);
  const tracks = vt
    .allTracks(data)
    .filter((t) => selected.every((v) => t.vibes.includes(v)))
    .sort(SORTS[sort].compare);

  const toggleFilter = (vibe) =>
    setSelected(selected.includes(vibe) ? selected.filter((v) => v !== vibe) : [...selected, vibe]);

  const untag = (uri, vibe) => {
    const d = vt.load();
    vt.setVibe(d, uri, null, vibe, false);
    vt.save(d);
  };

  const recolor = (vibe, color) => {
    const d = vt.load();
    vt.setColor(d, vibe, color);
    vt.save(d);
  };

  const playlistName = selected.length ? selected.join(" + ") : "All tagged songs";
  const makePlaylist = async () => {
    try {
      await vt.makePlaylist(playlistName, tracks.map((t) => t.uri));
      Spicetify.showNotification(`Created playlist "${playlistName}"`);
    } catch (e) {
      console.error("[Vibe Tagger] Playlist failed", e);
      Spicetify.showNotification("Could not create the playlist. See the console for details.", true);
    }
  };

  // "Tag (grouped)" shows one section per vibe; a song with two vibes appears in both.
  const groups =
    sort === "tag"
      ? vibes
          .filter((v) => selected.length === 0 || selected.includes(v.name))
          .map((v) => ({ vibe: v, tracks: tracks.filter((t) => t.vibes.includes(v.name)) }))
          .filter((g) => g.tracks.length)
      : [{ vibe: null, tracks }];

  return h("div", { className: "vt-page" },
    h("div", null,
      h("h1", null, "Tagged songs"),
      h("div", { className: "vt-muted" },
        `${vt.allTracks(data).length} songs · ${vibes.length} vibes`)
    ),

    vibes.length === 0
      ? h("p", { className: "vt-muted" },
          "Nothing tagged yet. Tap the heart next to the lyrics button, or right-click a song and choose Tag vibe…")
      : h(react.Fragment, null,
          h(FilterBar, { vibes, selected, toggleFilter, clear: () => setSelected([]), recolor }),
          h("div", { className: "vt-row" },
            h("span", { className: "vt-sub" }, "Sort by"),
            h("select", {
              className: "vt-select",
              value: sort,
              onChange: (e) => setSort(e.target.value),
            }, Object.entries(SORTS).map(([key, s]) => h("option", { key, value: key }, s.label))),
            h("button", { className: "vt-btn", onClick: () => vt.playAll(tracks.map((t) => t.uri)) },
              `Play ${tracks.length}`),
            h("button", { className: "vt-btn ghost", onClick: makePlaylist }, "Make playlist")
          ),
          groups.map((g) =>
            h("div", { key: g.vibe ? g.vibe.name : "all" },
              g.vibe && h("div", { className: "vt-group" },
                h("span", { className: "vt-dot", style: { background: g.vibe.color } }), g.vibe.name),
              h(SongTable, { data, tracks: g.tracks, untag, vt })
            )
          )
        ),

    h("div", { className: "vt-row" },
      h("button", { className: "vt-btn ghost", onClick: () => setShowBackup(!showBackup) },
        showBackup ? "Hide backup" : "Backup / restore")
    ),
    showBackup && h(Backup, { data, vt })
  );
}

function FilterBar({ vibes, selected, toggleFilter, clear, recolor }) {
  return h("div", { className: "vt-root" },
    h("div", { className: "vt-sub" },
      "Filter by vibe (pick several to find songs that have all of them). Use the color dot to recolor."),
    h("div", { className: "vt-chips" },
      h("button", { className: selected.length ? "vt-chip" : "vt-chip on", onClick: clear }, "All"),
      vibes.map((v) =>
        h("span", { key: v.name, className: "vt-row", style: { gap: "2px" } },
          h("button", {
            className: selected.includes(v.name) ? "vt-chip on" : "vt-chip",
            style: { "--vt-color": v.color },
            onClick: () => toggleFilter(v.name),
          }, `${v.name} · ${v.count}`),
          h("input", {
            type: "color",
            className: "vt-color-input",
            value: v.color,
            title: `Color for "${v.name}"`,
            onChange: (e) => recolor(v.name, e.target.value),
          })
        )
      )
    )
  );
}

function SongTable({ data, tracks, untag, vt }) {
  return h("div", { className: "vt-table" },
    h("div", { className: "vt-tr vt-th" },
      h("span", null, "#"), h("span", null, "Title"), h("span", null, "Vibes"), h("span", null, "")),
    tracks.map((t, i) =>
      h("div", { key: t.uri, className: "vt-tr" },
        h("span", { className: "vt-sub" }, i + 1),
        h("div", { style: { minWidth: 0 } },
          h("div", {
            className: "vt-title",
            title: "Play",
            onClick: () => Spicetify.Player.playUri(t.uri),
          }, t.name),
          h("div", { className: "vt-sub" }, t.artist)
        ),
        h("div", { className: "vt-chips", style: { gap: "4px" } },
          t.vibes.map((v) =>
            h("span", {
              key: v,
              className: "vt-chip small on",
              style: { "--vt-color": vt.colorOf(data, v) },
            }, v, h("span", {
              className: "vt-x",
              title: `Remove "${v}"`,
              style: { cursor: "pointer" },
              onClick: () => untag(t.uri, v),
            }, "×"))
          )
        ),
        h("button", { className: "vt-btn ghost", onClick: () => vt.openTagPicker([t.uri]) }, "Edit")
      )
    )
  );
}

function Backup({ data, vt }) {
  const [text, setText] = useState(() => JSON.stringify(data, null, 2));
  const importIt = () => {
    try {
      vt.importBackup(text);
      Spicetify.showNotification("Backup imported");
    } catch (e) {
      Spicetify.showNotification("That text is not a valid backup.", true);
    }
  };
  return h("div", { className: "vt-root" },
    h("div", { className: "vt-muted" },
      "Copy this text somewhere safe, or paste a backup here and press Import."),
    h("textarea", { className: "vt-textarea", value: text, onChange: (e) => setText(e.target.value) }),
    h("div", { className: "vt-row" },
      h("button", {
        className: "vt-btn ghost",
        onClick: async () => {
          await navigator.clipboard.writeText(text);
          Spicetify.showNotification("Backup copied");
        },
      }, "Copy"),
      h("button", { className: "vt-btn", onClick: importIt }, "Import (merge)")
    )
  );
}
