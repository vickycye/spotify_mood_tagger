// Copyright @ vickycye 2026

(function vibeTagger() {
  // Spotify loads extensions before Spicetify is fully ready, so wait for the parts we use.
  if (
    !Spicetify?.ContextMenu ||
    !Spicetify?.PopupModal ||
    !Spicetify?.Topbar ||
    !Spicetify?.LocalStorage ||
    !Spicetify?.CosmosAsync ||
    !Spicetify?.URI
  ) {
    setTimeout(vibeTagger, 300);
    return;
  }

  const STORAGE_KEY = "vibe-tagger:data";
  const API = "https://api.spotify.com/v1";

  // ---------- Store ----------

  function emptyData() {
    return { version: 1, tracks: {} };
  }

  function load() {
    try {
      const raw = Spicetify.LocalStorage.get(STORAGE_KEY);
      if (!raw) return emptyData();
      const data = JSON.parse(raw);
      if (!data || typeof data.tracks !== "object") return emptyData();
      return data;
    } catch (e) {
      console.error("[Vibe Tagger] Could not read saved tags", e);
      return emptyData();
    }
  }

  function save(data) {
    Spicetify.LocalStorage.set(STORAGE_KEY, JSON.stringify(data));
  }

  function normalize(vibe) {
    return vibe.trim().replace(/\s+/g, " ").toLowerCase();
  }

  // Returns [{ name, count }] sorted by most-used vibe first.
  function allVibes(data) {
    const counts = {};
    for (const track of Object.values(data.tracks)) {
      for (const v of track.vibes) counts[v] = (counts[v] || 0) + 1;
    }
    return Object.entries(counts)
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
  }

  function tracksWithVibe(data, vibe) {
    return Object.entries(data.tracks)
      .filter(([, t]) => t.vibes.includes(vibe))
      .map(([uri, t]) => ({ uri, ...t }))
      .sort((a, b) => b.taggedAt - a.taggedAt);
  }

  function setVibe(data, uri, info, vibe, on) {
    let track = data.tracks[uri];
    if (!track) {
      if (!on) return;
      track = data.tracks[uri] = { ...info, vibes: [], taggedAt: Date.now() };
    }
    if (on && !track.vibes.includes(vibe)) track.vibes.push(vibe);
    if (!on) track.vibes = track.vibes.filter((v) => v !== vibe);
    if (track.vibes.length === 0) delete data.tracks[uri];
  }

  // ---------- Spotify lookups ----------

  function trackId(uri) {
    return uri.split(":").pop();
  }

  // Looks up name + artist for each URI. Falls back to what we already have.
  async function fetchInfo(uris, data) {
    const info = {};
    for (const uri of uris) {
      const known = data.tracks[uri];
      info[uri] = known
        ? { name: known.name, artist: known.artist }
        : { name: "Unknown song", artist: "" };
    }

    const current = Spicetify.Player?.data?.item;
    if (current && info[current.uri]) {
      info[current.uri] = {
        name: current.metadata?.title || current.name || info[current.uri].name,
        artist: current.metadata?.artist_name || info[current.uri].artist,
      };
    }

    const missing = uris.filter((u) => info[u].name === "Unknown song");
    for (let i = 0; i < missing.length; i += 50) {
      const batch = missing.slice(i, i + 50);
      try {
        const res = await Spicetify.CosmosAsync.get(
          `${API}/tracks?ids=${batch.map(trackId).join(",")}`
        );
        for (const t of res?.tracks || []) {
          if (!t) continue;
          info[t.uri] = { name: t.name, artist: t.artists.map((a) => a.name).join(", ") };
        }
      } catch (e) {
        console.warn("[Vibe Tagger] Could not look up song names", e);
      }
    }
    return info;
  }

  // Tries the newer endpoint first, then the older one, since Spotify has renamed some.
  async function postFirstWorking(urls, body) {
    let lastError;
    for (const url of urls) {
      try {
        const res = await Spicetify.CosmosAsync.post(url, body);
        if (res && !res.error) return res;
        lastError = res?.error;
      } catch (e) {
        lastError = e;
      }
    }
    throw lastError || new Error("Request failed");
  }

  async function makePlaylist(vibe, uris) {
    const me = await Spicetify.CosmosAsync.get(`${API}/me`);
    const playlist = await postFirstWorking(
      [`${API}/me/playlists`, `${API}/users/${me.id}/playlists`],
      { name: vibe, description: `Songs tagged "${vibe}" with Vibe Tagger`, public: false }
    );
    for (let i = 0; i < uris.length; i += 100) {
      const batch = uris.slice(i, i + 100);
      await postFirstWorking(
        [`${API}/playlists/${playlist.id}/items`, `${API}/playlists/${playlist.id}/tracks`],
        { uris: batch }
      );
    }
    return playlist;
  }

  // ---------- UI helpers ----------

  const style = document.createElement("style");
  style.textContent = `
    .vt-root { display: flex; flex-direction: column; gap: 12px; }
    .vt-chips { display: flex; flex-wrap: wrap; gap: 8px; }
    .vt-chip { border: 1px solid var(--spice-button-disabled, #535353); background: transparent;
      color: var(--spice-text, #fff); border-radius: 999px; padding: 6px 12px; cursor: pointer; font-size: 14px; }
    .vt-chip.on { background: var(--spice-button, #1db954); border-color: var(--spice-button, #1db954); color: #000; }
    .vt-row { display: flex; gap: 8px; align-items: center; }
    .vt-input, .vt-textarea { flex: 1; padding: 8px 10px; border-radius: 6px; border: 1px solid #535353;
      background: var(--spice-main-elevated, #242424); color: var(--spice-text, #fff); font-size: 14px; }
    .vt-textarea { min-height: 160px; font-family: monospace; font-size: 12px; }
    .vt-btn { padding: 8px 14px; border-radius: 999px; border: none; cursor: pointer; font-weight: 700;
      background: var(--spice-button, #1db954); color: #000; }
    .vt-btn.ghost { background: transparent; color: var(--spice-text, #fff); border: 1px solid #535353; }
    .vt-list { display: flex; flex-direction: column; gap: 4px; max-height: 50vh; overflow-y: auto; }
    .vt-item { display: flex; align-items: center; gap: 8px; padding: 6px 8px; border-radius: 6px; }
    .vt-item:hover { background: var(--spice-main-elevated, #2a2a2a); }
    .vt-grow { flex: 1; min-width: 0; }
    .vt-title { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .vt-sub { color: var(--spice-subtext, #b3b3b3); font-size: 12px; }
    .vt-link { background: none; border: none; color: var(--spice-text, #fff); cursor: pointer; text-align: left;
      padding: 0; font-size: 15px; }
    .vt-muted { color: var(--spice-subtext, #b3b3b3); }
  `;
  document.head.appendChild(style);

  // Small helper so building elements reads like a sentence: el("button", "vt-btn", "Save").
  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function button(label, onClick, ghost) {
    const b = el("button", ghost ? "vt-btn ghost" : "vt-btn", label);
    b.addEventListener("click", onClick);
    return b;
  }

  function notify(msg, isError) {
    Spicetify.showNotification(msg, isError);
  }

  // ---------- Tag picker (right-click menu) ----------

  async function openTagPicker(uris) {
    const data = load();
    const info = await fetchInfo(uris, data);
    const root = el("div", "vt-root");

    // A vibe is "on" only if every selected song already has it.
    function isOn(vibe) {
      return uris.every((u) => data.tracks[u]?.vibes.includes(vibe));
    }

    function toggle(vibe, on) {
      for (const uri of uris) setVibe(data, uri, info[uri], vibe, on);
      save(data);
      render();
    }

    function render() {
      root.replaceChildren();

      const label =
        uris.length === 1
          ? `${info[uris[0]].name}${info[uris[0]].artist ? " · " + info[uris[0]].artist : ""}`
          : `${uris.length} songs selected`;
      root.appendChild(el("div", "vt-muted", label));

      const input = el("input", "vt-input");
      input.placeholder = "New vibe, e.g. rainy 2am";
      const add = () => {
        const vibe = normalize(input.value);
        if (!vibe) return;
        toggle(vibe, true);
        notify(`Tagged "${vibe}"`);
      };
      input.addEventListener("keydown", (e) => e.key === "Enter" && add());
      const row = el("div", "vt-row");
      row.append(input, button("Add", add));
      root.appendChild(row);

      const vibes = allVibes(data);
      if (vibes.length === 0) {
        root.appendChild(el("div", "vt-muted", "No vibes yet. Type your first one above."));
      } else {
        root.appendChild(el("div", "vt-sub", "Click a vibe to add or remove it"));
        const chips = el("div", "vt-chips");
        for (const { name } of vibes) {
          const on = isOn(name);
          const chip = el("button", on ? "vt-chip on" : "vt-chip", name);
          chip.addEventListener("click", () => toggle(name, !on));
          chips.appendChild(chip);
        }
        root.appendChild(chips);
      }
      setTimeout(() => input.focus(), 0);
    }

    render();
    Spicetify.PopupModal.display({ title: "Tag vibe", content: root });
  }

  const isTrack = (uri) => Spicetify.URI.fromString(uri).type === Spicetify.URI.Type.TRACK;

  new Spicetify.ContextMenu.Item(
    "Tag vibe…",
    (uris) => openTagPicker(uris),
    (uris) => uris.length > 0 && uris.every(isTrack),
    "heart"
  ).register();

  // ---------- Vibe browser (top bar button) ----------

  function openBrowser() {
    const root = el("div", "vt-root");
    let selected = null; // null = list of vibes, otherwise the vibe being viewed

    function renderVibes() {
      const data = load();
      const vibes = allVibes(data);
      root.replaceChildren();

      if (vibes.length === 0) {
        root.appendChild(
          el("div", "vt-muted", 'No vibes yet. Right-click any song and choose "Tag vibe…".')
        );
      } else {
        const list = el("div", "vt-list");
        for (const { name, count } of vibes) {
          const item = el("div", "vt-item");
          const link = el("button", "vt-link vt-grow", name);
          link.addEventListener("click", () => {
            selected = name;
            render();
          });
          item.append(link, el("span", "vt-sub", `${count} song${count === 1 ? "" : "s"}`));
          list.appendChild(item);
        }
        root.appendChild(list);
      }

      const footer = el("div", "vt-row");
      footer.appendChild(button("Backup / restore", renderBackup, true));
      root.appendChild(footer);
    }

    function renderTracks() {
      const data = load();
      const tracks = tracksWithVibe(data, selected);
      if (tracks.length === 0) {
        selected = null;
        renderVibes();
        return;
      }
      root.replaceChildren();

      const actions = el("div", "vt-row");
      actions.append(
        button("← All vibes", () => {
          selected = null;
          render();
        }, true),
        button("Play all", async () => {
          const [first, ...rest] = tracks;
          await Spicetify.Player.playUri(first.uri);
          if (rest.length) await Spicetify.addToQueue(rest.map((t) => ({ uri: t.uri })));
          notify(`Playing "${selected}"`);
        }),
        button("Make playlist", async () => {
          try {
            await makePlaylist(selected, tracks.map((t) => t.uri));
            notify(`Created playlist "${selected}"`);
          } catch (e) {
            console.error("[Vibe Tagger] Playlist failed", e);
            notify("Could not create the playlist. See the console for details.", true);
          }
        })
      );
      root.appendChild(actions);

      const list = el("div", "vt-list");
      for (const t of tracks) {
        const item = el("div", "vt-item");
        const text = el("div", "vt-grow");
        text.append(el("div", "vt-title", t.name), el("div", "vt-sub", t.artist));
        item.append(
          text,
          button("Play", () => Spicetify.Player.playUri(t.uri), true),
          button("Untag", () => {
            const d = load();
            setVibe(d, t.uri, null, selected, false);
            save(d);
            render();
          }, true)
        );
        list.appendChild(item);
      }
      root.appendChild(list);
    }

    function renderBackup() {
      root.replaceChildren();
      root.appendChild(
        el("div", "vt-muted", "Copy this text somewhere safe, or paste a backup here and press Import.")
      );
      const box = el("textarea", "vt-textarea");
      box.value = JSON.stringify(load(), null, 2);
      root.appendChild(box);

      const row = el("div", "vt-row");
      row.append(
        button("← Back", () => render(), true),
        button("Copy", async () => {
          await navigator.clipboard.writeText(box.value);
          notify("Backup copied");
        }, true),
        button("Import (merge)", () => {
          try {
            const incoming = JSON.parse(box.value);
            const data = load();
            for (const [uri, t] of Object.entries(incoming.tracks || {})) {
              for (const v of t.vibes || []) {
                setVibe(data, uri, { name: t.name, artist: t.artist }, normalize(v), true);
              }
            }
            save(data);
            notify("Backup imported");
            render();
          } catch (e) {
            notify("That text is not a valid backup.", true);
          }
        })
      );
      root.appendChild(row);
    }

    function render() {
      if (selected) renderTracks();
      else renderVibes();
    }

    render();
    Spicetify.PopupModal.display({ title: "Vibes", content: root, isLarge: true });
  }

  new Spicetify.Topbar.Button("Vibes", "heart", openBrowser);
})();
