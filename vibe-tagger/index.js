// The "Tagged songs" page. Spicetify calls render() when you open the page from the sidebar.
// Tag data and helpers come from vibeTagger.js, which runs at startup and sets window.VibeTagger.

const react = Spicetify.React;
const h = react.createElement;
const { useState, useEffect, useLayoutEffect, useRef } = react;

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
    vt.repairInfo().catch((e) => console.warn("[Vibe Tagger] Repair failed", e));
    return () => window.removeEventListener(vt.CHANGED_EVENT, refresh);
  }, []);
  return data;
}

// The URI of the song playing right now, so its row can be highlighted.
function usePlayingUri() {
  const [uri, setUri] = useState(() => Spicetify.Player.data?.item?.uri);
  useEffect(() => {
    const update = () => setUri(Spicetify.Player.data?.item?.uri);
    Spicetify.Player.addEventListener("songchange", update);
    return () => Spicetify.Player.removeEventListener("songchange", update);
  }, []);
  return uri;
}

function timeAgo(ms) {
  const days = Math.floor((Date.now() - ms) / 86400000);
  if (days < 1) return "Today";
  if (days === 1) return "Yesterday";
  if (days < 30) return `${days} days ago`;
  return new Date(ms).toLocaleDateString();
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
  const playing = usePlayingUri();
  const [selected, setSelected] = useState([]); // vibes to filter by; a song must have all of them
  const [sort, setSort] = useState("recent");
  const [showBackup, setShowBackup] = useState(false);
  const [menu, setMenu] = useState(null); // { x, y, vibe, uri? } while a tag's right-click menu is open

  const vibes = vt.allVibes(data);

  // Drop filters for vibes that were renamed or deleted.
  useEffect(() => {
    const live = selected.filter((v) => data.vibes[v]);
    if (live.length !== selected.length) setSelected(live);
  }, [data]);

  const openMenu = (e, vibe, uri) => {
    e.preventDefault();
    e.stopPropagation();
    setMenu({ x: e.clientX, y: e.clientY, vibe, uri });
  };
  const everything = vt.allTracks(data);
  const tracks = everything
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

  const title = selected.length ? selected.join(" + ") : "Tagged songs";
  const makePlaylist = async () => {
    try {
      await vt.makePlaylist(title, tracks.map((t) => t.uri));
      Spicetify.showNotification(`Created playlist "${title}"`);
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
    h(Hero, { title, tracks, total: everything.length, vibeCount: vibes.length }),

    vibes.length === 0
      ? h("p", { className: "vt-muted" },
          "Nothing tagged yet. Tap the tag button next to the lyrics button, or right-click a song and choose Tag vibe…")
      : h(react.Fragment, null,
          h("div", { className: "vt-toolbar" },
            h("button", {
              className: "vt-play",
              title: `Play ${tracks.length} songs`,
              onClick: () => vt.playAll(tracks.map((t) => t.uri)),
            }, "▶"),
            h("button", { className: "vt-btn ghost", onClick: makePlaylist }, "Make playlist"),
            h("div", { className: "vt-spacer" }),
            h("span", { className: "vt-sub" }, "Sort by"),
            h("select", {
              className: "vt-select",
              value: sort,
              onChange: (e) => setSort(e.target.value),
            }, Object.entries(SORTS).map(([key, s]) => h("option", { key, value: key }, s.label)))
          ),
          h(FilterBar, { vibes, selected, toggleFilter, clear: () => setSelected([]), recolor, openMenu }),
          groups.map((g) =>
            h("div", { key: g.vibe ? g.vibe.name : "all" },
              g.vibe && h("div", { className: "vt-group", onContextMenu: (e) => openMenu(e, g.vibe.name) },
                h("span", { className: "vt-dot", style: { background: g.vibe.color } }),
                g.vibe.name,
                h("span", { className: "vt-sub" }, `${g.tracks.length} songs`)),
              h(SongTable, { data, tracks: g.tracks, untag, vt, playing, openMenu })
            )
          )
        ),

    h("div", { className: "vt-row" },
      h("button", { className: "vt-btn ghost", onClick: () => setShowBackup(!showBackup) },
        showBackup ? "Hide backup" : "Backup / restore")
    ),
    showBackup && h(Backup, { data, vt }),
    menu && h(VibeMenu, {
      menu,
      vt,
      color: vt.colorOf(data, menu.vibe),
      close: () => setMenu(null),
      showOnly: () => setSelected([menu.vibe]),
      play: () => vt.playAll(everything.filter((t) => t.vibes.includes(menu.vibe)).map((t) => t.uri)),
      recolor,
      untag,
    })
  );
}

// Right-click menu for a vibe chip. Picking a color keeps it open so you can try a few.
function VibeMenu({ menu, vt, color, close, showOnly, play, recolor, untag }) {
  const ref = useRef(null);
  const [pos, setPos] = useState({ left: menu.x, top: menu.y });

  // Keep the menu on screen when the click is near the right or bottom edge.
  useLayoutEffect(() => {
    const r = ref.current.getBoundingClientRect();
    setPos({
      left: Math.max(8, Math.min(menu.x, window.innerWidth - r.width - 8)),
      top: Math.max(8, Math.min(menu.y, window.innerHeight - r.height - 8)),
    });
  }, [menu.x, menu.y]);

  useEffect(() => {
    const onDown = (e) => !ref.current?.contains(e.target) && close();
    const onKey = (e) => e.key === "Escape" && close();
    document.addEventListener("mousedown", onDown, true);
    document.addEventListener("keydown", onKey);
    document.addEventListener("scroll", close, true);
    window.addEventListener("blur", close);
    return () => {
      document.removeEventListener("mousedown", onDown, true);
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("scroll", close, true);
      window.removeEventListener("blur", close);
    };
  }, []);

  const item = (label, onClick, danger) =>
    h("button", {
      className: danger ? "vt-menu-item danger" : "vt-menu-item",
      onClick: () => {
        close();
        onClick();
      },
    }, label);

  return h("div", {
    ref,
    className: "vt-menu",
    style: pos,
    onContextMenu: (e) => e.preventDefault(),
  },
    h("div", { className: "vt-menu-title" }, menu.vibe),
    item("Show only this vibe", showOnly),
    item("Play these songs", play),
    h("div", { className: "vt-menu-sep" }),
    h("div", { className: "vt-menu-title" }, "Color"),
    h("div", { className: "vt-swatches" },
      vt.PALETTE.map((c) =>
        h("button", {
          key: c,
          className: c === color ? "vt-swatch on" : "vt-swatch",
          style: { background: c },
          title: c,
          onClick: () => recolor(menu.vibe, c),
        })),
      h("input", {
        type: "color",
        className: "vt-color-input",
        value: color,
        title: "Pick any color",
        onChange: (e) => recolor(menu.vibe, e.target.value),
      })
    ),
    h("div", { className: "vt-menu-sep" }),
    item("Rename…", () => vt.openRenameDialog(menu.vibe)),
    menu.uri && item("Remove from this song", () => untag(menu.uri, menu.vibe)),
    item("Delete vibe…", () => vt.openDeleteDialog(menu.vibe), true)
  );
}

// Header like a playlist page: a cover collage from the first four songs, then the title.
function Hero({ title, tracks, total, vibeCount }) {
  const covers = [...new Set(tracks.map((t) => t.image).filter(Boolean))].slice(0, 4);
  const art = covers.length >= 4 ? covers : covers.slice(0, 1);
  return h("div", { className: "vt-hero" },
    h("div", { className: art.length === 1 ? "vt-hero-art single" : "vt-hero-art" },
      art.map((src) => h("img", { key: src, src }))),
    h("div", null,
      h("div", { className: "vt-eyebrow" }, "Vibe Tagger"),
      h("h1", null, title),
      h("div", { className: "vt-muted" },
        title === "Tagged songs" ? `${total} songs · ${vibeCount} vibes` : `${tracks.length} songs`)
    )
  );
}

function FilterBar({ vibes, selected, toggleFilter, clear, recolor, openMenu }) {
  return h("div", { className: "vt-chips" },
    h("button", { className: selected.length ? "vt-chip" : "vt-chip on", onClick: clear }, "All"),
    vibes.map((v) =>
      h("span", { key: v.name, className: "vt-filter" },
        h("button", {
          className: selected.includes(v.name) ? "vt-chip on" : "vt-chip",
          style: { "--vt-color": v.color },
          onClick: () => toggleFilter(v.name),
          onContextMenu: (e) => openMenu(e, v.name),
          title: "Right-click for more options",
        }, `${v.name} · ${v.count}`),
        h("input", {
          type: "color",
          className: "vt-color-input",
          value: v.color,
          title: `Change the color of "${v.name}"`,
          onChange: (e) => recolor(v.name, e.target.value),
        })
      )
    )
  );
}

function SongTable({ data, tracks, untag, vt, playing, openMenu }) {
  return h("div", { className: "vt-table" },
    h("div", { className: "vt-tr vt-th" },
      h("span", { className: "vt-num" }, "#"),
      h("span", null, "Title"),
      h("span", null, "Vibes"),
      h("span", null, "Tagged"),
      h("span", null, "")),
    tracks.map((t, i) => {
      const play = () => Spicetify.Player.playUri(t.uri);
      return h("div", {
        key: t.uri,
        className: t.uri === playing ? "vt-tr playing" : "vt-tr",
        onDoubleClick: play,
      },
        h("span", { className: "vt-num" }, i + 1),
        h("div", { className: "vt-song" },
          t.image
            ? h("img", { className: "vt-cover", src: t.image, onClick: play, title: "Play" })
            : h("div", { className: "vt-cover", onClick: play, title: "Play" }),
          h("div", { className: "vt-song-text" },
            h("div", { className: "vt-name", title: "Play", onClick: play }, t.name),
            h("div", { className: "vt-sub vt-artist" }, t.artist)
          )
        ),
        h("div", { className: "vt-chips", style: { gap: "4px" } },
          t.vibes.map((v) =>
            h("span", {
              key: v,
              className: "vt-chip small on",
              style: { "--vt-color": vt.colorOf(data, v) },
              onContextMenu: (e) => openMenu(e, v, t.uri),
            }, v, h("span", {
              className: "vt-x",
              title: `Remove "${v}"`,
              onClick: () => untag(t.uri, v),
            }, "×"))
          )
        ),
        h("span", { className: "vt-sub" }, timeAgo(t.taggedAt)),
        h("button", {
          className: "vt-icon-btn",
          title: "Edit vibes",
          onClick: () => vt.openTagPicker([t.uri]),
        }, "✎")
      );
    })
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
