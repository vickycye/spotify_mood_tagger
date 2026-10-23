// NAME: Vibe Tagger
// AUTHOR: Vicky
// DESCRIPTION: Tag songs with colored vibes. Loads at startup; the "Tagged songs" page lives in index.js.

(function vibeTagger() {
  // Spotify loads extensions before Spicetify is fully ready, so wait for the parts we use.
  if (
    !Spicetify?.ContextMenu ||
    !Spicetify?.PopupModal ||
    !Spicetify?.Playbar ||
    !Spicetify?.Player ||
    !Spicetify?.Platform?.History ||
    !Spicetify?.LocalStorage ||
    !Spicetify?.CosmosAsync ||
    !Spicetify?.URI
  ) {
    setTimeout(vibeTagger, 300);
    return;
  }

  const STORAGE_KEY = "vibe-tagger:data";
  const CHANGED_EVENT = "vibe-tagger:changed";
  const PAGE_PATH = "/vibe-tagger";
  const API = "https://api.spotify.com/v1";
  const DEFAULT_COLOR = "#a0a0a0";
  // Grey first: new vibes start grey until you pick something else.
  const PALETTE = [DEFAULT_COLOR, "#f47c7c", "#f7b267", "#f9e076", "#9ad98c", "#6fd0c5", "#7fb3ff", "#b39cff", "#f598d6"];

  // ---------- Store ----------
  // { version: 2, tracks: { uri: { name, artist, vibes: [..], taggedAt } }, vibes: { name: { color } } }

  function emptyData() {
    return { version: 2, tracks: {}, vibes: {} };
  }

  function load() {
    let data;
    try {
      const raw = Spicetify.LocalStorage.get(STORAGE_KEY);
      data = raw ? JSON.parse(raw) : emptyData();
    } catch (e) {
      console.error("[Vibe Tagger] Could not read saved tags", e);
      data = emptyData();
    }
    if (!data || typeof data.tracks !== "object") data = emptyData();
    // Version 1 saves had no colors, so give every existing vibe one.
    if (!data.vibes) data.vibes = {};
    for (const track of Object.values(data.tracks)) {
      for (const v of track.vibes) if (!data.vibes[v]) data.vibes[v] = { color: DEFAULT_COLOR };
    }
    data.version = 2;
    return data;
  }

  function save(data) {
    // Forget colors of vibes no song uses any more.
    const used = new Set(Object.values(data.tracks).flatMap((t) => t.vibes));
    for (const v of Object.keys(data.vibes)) if (!used.has(v)) delete data.vibes[v];
    Spicetify.LocalStorage.set(STORAGE_KEY, JSON.stringify(data));
    window.dispatchEvent(new Event(CHANGED_EVENT));
  }

  function normalize(vibe) {
    return vibe.trim().replace(/\s+/g, " ").toLowerCase();
  }

  function colorOf(data, vibe) {
    return data.vibes[vibe]?.color || DEFAULT_COLOR;
  }

  function setColor(data, vibe, color) {
    data.vibes[vibe] = { ...(data.vibes[vibe] || {}), color };
  }

  // Returns [{ name, count, color }] sorted by most-used vibe first.
  function allVibes(data) {
    const counts = {};
    for (const track of Object.values(data.tracks)) {
      for (const v of track.vibes) counts[v] = (counts[v] || 0) + 1;
    }
    return Object.entries(counts)
      .map(([name, count]) => ({ name, count, color: colorOf(data, name) }))
      .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
  }

  function allTracks(data) {
    return Object.entries(data.tracks).map(([uri, t]) => ({ uri, ...t }));
  }

  function setVibe(data, uri, info, vibe, on, color) {
    if (on && !data.vibes[vibe]) data.vibes[vibe] = { color: color || DEFAULT_COLOR };
    let track = data.tracks[uri];
    if (!track) {
      if (!on) return;
      track = data.tracks[uri] = { ...info, vibes: [], taggedAt: Date.now() };
    }
    if (on && !track.vibes.includes(vibe)) track.vibes.push(vibe);
    if (!on) track.vibes = track.vibes.filter((v) => v !== vibe);
    if (track.vibes.length === 0) delete data.tracks[uri];
  }

  // Renames a vibe on every song. If the new name already exists, the two merge.
  function renameVibe(data, from, to) {
    if (!to || from === to) return;
    if (!data.vibes[to]) data.vibes[to] = { ...data.vibes[from] };
    for (const track of Object.values(data.tracks)) {
      if (!track.vibes.includes(from)) continue;
      track.vibes = track.vibes.filter((v) => v !== from);
      if (!track.vibes.includes(to)) track.vibes.push(to);
    }
    delete data.vibes[from];
  }

  // Removes a vibe from every song.
  function deleteVibe(data, vibe) {
    for (const [uri, track] of Object.entries(data.tracks)) {
      track.vibes = track.vibes.filter((v) => v !== vibe);
      if (track.vibes.length === 0) delete data.tracks[uri];
    }
    delete data.vibes[vibe];
  }

  function importBackup(text) {
    const incoming = JSON.parse(text);
    const data = load();
    for (const [uri, t] of Object.entries(incoming.tracks || {})) {
      for (const v of t.vibes || []) {
        const name = normalize(v);
        setVibe(data, uri, { name: t.name, artist: t.artist }, name, true, incoming.vibes?.[v]?.color);
      }
    }
    save(data);
  }

  // ---------- Spotify lookups ----------

  const UNKNOWN = "Unknown song";

  function trackId(uri) {
    return uri.split(":").pop();
  }

  // "spotify:image:abc" -> "https://i.scdn.co/image/abc"
  function imageUrl(src) {
    if (!src) return "";
    return src.startsWith("spotify:image:") ? `https://i.scdn.co/image/${src.split(":").pop()}` : src;
  }

  // Picks the smallest cover that is still at least 64px wide.
  function pickImage(images) {
    if (!Array.isArray(images) || images.length === 0) return "";
    const sorted = [...images].sort((a, b) => (a.width || a.maxWidth || 0) - (b.width || b.maxWidth || 0));
    const img = sorted.find((i) => (i.width || i.maxWidth || 0) >= 64) || sorted[sorted.length - 1];
    return imageUrl(img.url);
  }

  function joinArtists(list) {
    return (list || []).map((a) => a?.profile?.name || a?.name).filter(Boolean).join(", ");
  }

  function needsLookup(i) {
    return !i || i.name === UNKNOWN || !i.image;
  }

  // Merge, keeping any field we already know when the new source lacks it.
  function merge(old, add) {
    return {
      name: add.name || old.name,
      artist: add.artist || old.artist,
      image: add.image || old.image || "",
    };
  }

  // Looks up name, artist and cover for each URI. Spotify blocks some lookups for
  // extensions, so this tries several sources and keeps whatever it finds.
  async function fetchInfo(uris, data, contextUri) {
    const info = {};
    for (const uri of uris) {
      const known = data.tracks[uri];
      info[uri] = known
        ? { name: known.name, artist: known.artist, image: known.image || "" }
        : { name: UNKNOWN, artist: "", image: "" };
    }
    const missing = () => uris.filter((u) => needsLookup(info[u]));

    // 1. The song that is playing right now.
    const current = Spicetify.Player.data?.item;
    if (current && info[current.uri]) {
      info[current.uri] = merge(info[current.uri], {
        name: current.metadata?.title || current.name,
        artist: current.metadata?.artist_name || joinArtists(current.artists),
        image: imageUrl(current.metadata?.image_url) || pickImage(current.images),
      });
    }

    // 2. The playlist you right-clicked in already knows its songs.
    if (missing().length && contextUri?.startsWith("spotify:playlist:")) {
      try {
        const res = await Spicetify.Platform.PlaylistAPI.getContents(contextUri, { limit: 10000 });
        for (const item of res?.items || []) {
          if (!info[item.uri]) continue;
          info[item.uri] = merge(info[item.uri], {
            name: item.name,
            artist: joinArtists(item.artists),
            image: pickImage(item.album?.images),
          });
        }
      } catch (e) {
        console.warn("[Vibe Tagger] Playlist lookup failed", e);
      }
    }

    // 3. Spotify's own GraphQL lookup, the same one the app uses to draw track lists.
    if (missing().length && Spicetify.GraphQL?.Definitions?.decorateContextTracks) {
      try {
        const res = await Spicetify.GraphQL.Request(Spicetify.GraphQL.Definitions.decorateContextTracks, {
          uris: missing(),
        });
        for (const t of res?.data?.tracks || []) {
          const d = t?.data || t;
          const uri = t?._uri || t?.uri || d?.uri;
          if (!info[uri] || !d) continue;
          info[uri] = merge(info[uri], {
            name: d.name,
            artist: joinArtists(d.artists?.items || d.firstArtist?.items),
            image: pickImage(d.albumOfTrack?.coverArt?.sources),
          });
        }
      } catch (e) {
        console.warn("[Vibe Tagger] GraphQL lookup failed", e);
      }
    }

    // 4. The public Web API, one song at a time.
    for (const uri of missing()) {
      try {
        const t = await Spicetify.CosmosAsync.get(`${API}/tracks/${trackId(uri)}`);
        if (!t?.name) continue;
        info[uri] = merge(info[uri], {
          name: t.name,
          artist: joinArtists(t.artists),
          image: pickImage(t.album?.images),
        });
      } catch (e) {
        console.warn("[Vibe Tagger] Web API lookup failed", uri, e);
        break; // usually means the endpoint is blocked; don't try every song
      }
    }
    return info;
  }

  // Fills in names and covers for songs saved without them (for example, older tags).
  async function repairInfo() {
    const data = load();
    const uris = Object.keys(data.tracks).filter((u) => needsLookup(data.tracks[u]));
    if (uris.length === 0) return;
    const info = await fetchInfo(uris, data);
    const fresh = load();
    let changed = false;
    for (const uri of uris) {
      const t = fresh.tracks[uri];
      if (!t) continue;
      const merged = merge(t, info[uri]);
      if (merged.name !== t.name || merged.artist !== t.artist || merged.image !== (t.image || "")) {
        Object.assign(t, merged);
        changed = true;
      }
    }
    if (changed) save(fresh);
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

  async function makePlaylist(name, uris) {
    const me = await Spicetify.CosmosAsync.get(`${API}/me`);
    const playlist = await postFirstWorking(
      [`${API}/me/playlists`, `${API}/users/${me.id}/playlists`],
      { name, description: `Songs tagged "${name}" with Vibe Tagger`, public: false }
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

  async function playAll(uris) {
    const [first, ...rest] = uris;
    if (!first) return;
    await Spicetify.Player.playUri(first);
    if (rest.length) await Spicetify.addToQueue(rest.map((uri) => ({ uri })));
  }

  // ---------- Styles (shared with the Tagged songs page) ----------

  const style = document.createElement("style");
  style.textContent = `
    .vt-root { display: flex; flex-direction: column; gap: 12px; }
    .vt-chips { display: flex; flex-wrap: wrap; gap: 8px; }
    .vt-chip { --vt-color: #888; border: 2px solid var(--vt-color); background: transparent;
      color: var(--spice-text, #fff); border-radius: 999px; padding: 4px 12px; cursor: pointer; font-size: 14px; }
    .vt-chip.on { background: var(--vt-color); color: #000; }
    .vt-chip.small { padding: 1px 8px; font-size: 12px; border-width: 1px; }
    .vt-swatches { display: flex; gap: 6px; align-items: center; }
    .vt-swatch { width: 22px; height: 22px; border-radius: 50%; border: 2px solid transparent; cursor: pointer; padding: 0; }
    .vt-swatch.on { border-color: var(--spice-text, #fff); }
    .vt-row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
    .vt-input, .vt-textarea, .vt-select { padding: 8px 10px; border-radius: 6px; border: 1px solid #535353;
      background: var(--spice-main-elevated, #242424); color: var(--spice-text, #fff); font-size: 14px; }
    .vt-input { flex: 1; }
    .vt-textarea { width: 100%; min-height: 160px; font-family: monospace; font-size: 12px; box-sizing: border-box; }
    .vt-btn { padding: 8px 14px; border-radius: 999px; border: none; cursor: pointer; font-weight: 700;
      background: var(--spice-button, #1db954); color: #000; }
    .vt-btn.ghost { background: transparent; color: var(--spice-text, #fff); border: 1px solid #535353; }
    .vt-muted { color: var(--spice-subtext, #b3b3b3); }
    .vt-sub { color: var(--spice-subtext, #b3b3b3); font-size: 12px; }

    .vt-color-input { -webkit-appearance: none; appearance: none; width: 18px; height: 18px; border-radius: 50%;
      border: 2px solid rgba(255,255,255,0.4); padding: 0; overflow: hidden; cursor: pointer; background: none; }
    .vt-color-input::-webkit-color-swatch-wrapper { padding: 0; }
    .vt-color-input::-webkit-color-swatch { border: none; border-radius: 50%; }

    .vt-page { padding: 24px 32px 48px; color: var(--spice-text, #fff); display: flex; flex-direction: column; gap: 20px; }
    .vt-hero { display: flex; align-items: flex-end; gap: 24px; padding: 24px 0 8px; }
    .vt-hero-art { width: 160px; height: 160px; border-radius: 6px; flex-shrink: 0; display: grid;
      grid-template-columns: 1fr 1fr; overflow: hidden; background: #333; box-shadow: 0 8px 24px rgba(0,0,0,.5); }
    .vt-hero-art img { width: 100%; height: 100%; object-fit: cover; display: block; }
    .vt-hero-art.single { grid-template-columns: 1fr; }
    .vt-eyebrow { font-size: 12px; font-weight: 700; }
    .vt-page h1 { font-size: 56px; font-weight: 900; margin: 4px 0 8px; line-height: 1; }
    .vt-toolbar { display: flex; gap: 12px; align-items: center; flex-wrap: wrap; }
    .vt-play { width: 52px; height: 52px; border-radius: 50%; border: none; cursor: pointer; font-size: 20px;
      background: var(--spice-button, #1db954); color: #000; display: grid; place-items: center; }
    .vt-play:hover { transform: scale(1.05); }
    .vt-spacer { flex: 1; }
    .vt-table { display: flex; flex-direction: column; }
    .vt-tr { display: grid; grid-template-columns: 28px minmax(200px, 4fr) minmax(160px, 3fr) 110px 40px; gap: 16px;
      align-items: center; padding: 6px 12px; border-radius: 6px; }
    .vt-tr:hover { background: rgba(255,255,255,0.08); }
    .vt-tr.playing .vt-name, .vt-tr.playing .vt-num { color: var(--spice-button, #1db954); }
    .vt-th { color: var(--spice-subtext, #b3b3b3); font-size: 12px; text-transform: uppercase; letter-spacing: .05em;
      border-bottom: 1px solid rgba(255,255,255,0.1); border-radius: 0; margin-bottom: 8px; }
    .vt-th:hover { background: none; }
    .vt-num { color: var(--spice-subtext, #b3b3b3); text-align: right; font-variant-numeric: tabular-nums; }
    .vt-song { display: flex; align-items: center; gap: 12px; min-width: 0; }
    .vt-cover { width: 40px; height: 40px; border-radius: 4px; object-fit: cover; flex-shrink: 0; background: #333;
      cursor: pointer; }
    .vt-song-text { min-width: 0; }
    .vt-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; cursor: pointer; font-size: 16px; }
    .vt-name:hover { text-decoration: underline; }
    .vt-artist { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .vt-icon-btn { width: 32px; height: 32px; border-radius: 50%; border: none; background: transparent; cursor: pointer;
      color: var(--spice-subtext, #b3b3b3); font-size: 16px; opacity: 0; }
    .vt-tr:hover .vt-icon-btn { opacity: 1; }
    .vt-icon-btn:hover { color: var(--spice-text, #fff); background: rgba(255,255,255,0.1); }
    .vt-group { font-size: 22px; font-weight: 700; margin: 20px 0 8px; display: flex; gap: 10px; align-items: center; }
    .vt-dot { width: 14px; height: 14px; border-radius: 50%; display: inline-block; }
    .vt-x { margin-left: 4px; opacity: 0; cursor: pointer; }
    .vt-tr:hover .vt-x { opacity: 0.7; }
    .vt-x:hover { opacity: 1 !important; }
    .vt-filter { display: flex; align-items: center; gap: 4px; }

    /* The PNG icons are grey; turn them white on hover or when active, like Spotify's own icons. */
    button:hover .vt-icon image, a:hover .vt-icon image, a[aria-current="page"] .vt-icon image,
    .vt-icon.active image { filter: brightness(0) invert(1); }

    .vt-menu { position: fixed; z-index: 9999; min-width: 200px; padding: 4px; border-radius: 4px;
      background: #282828; box-shadow: 0 16px 24px rgba(0,0,0,.3), 0 6px 8px rgba(0,0,0,.2);
      color: var(--spice-text, #fff); font-size: 14px; }
    .vt-menu-title { padding: 8px 12px 4px; color: var(--spice-subtext, #b3b3b3); font-size: 12px; }
    .vt-menu-item { display: block; width: 100%; text-align: left; padding: 10px 12px; border: none;
      background: none; color: inherit; cursor: pointer; border-radius: 2px; font-size: 14px; }
    .vt-menu-item:hover { background: rgba(255,255,255,0.1); }
    .vt-menu-item.danger { color: #f47c7c; }
    .vt-menu-sep { height: 1px; margin: 4px 0; background: rgba(255,255,255,0.1); }
    .vt-menu .vt-swatches { padding: 6px 12px 8px; flex-wrap: wrap; }
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

  // ---------- Tag picker ----------

  // A row of color swatches plus a custom picker. It updates itself in place rather
  // than being rebuilt, because Spotify closes the modal when the clicked element
  // disappears from the page.
  function colorPicker(current, onPick) {
    const row = el("div", "vt-swatches");
    const swatches = [];
    const custom = el("input", "vt-color-input");
    const select = (c) => {
      current = c;
      for (const s of swatches) s.classList.toggle("on", s.dataset.color === c);
      custom.value = c;
      onPick(c);
    };
    for (const c of PALETTE) {
      const s = el("button", c === current ? "vt-swatch on" : "vt-swatch");
      s.style.background = c;
      s.title = c === DEFAULT_COLOR ? "Grey (default)" : c;
      s.dataset.color = c;
      s.addEventListener("click", () => select(c));
      swatches.push(s);
      row.appendChild(s);
    }
    custom.type = "color";
    custom.value = current;
    custom.title = "Pick any color";
    custom.addEventListener("change", () => select(custom.value));
    row.appendChild(custom);
    return row;
  }

  async function openTagPicker(uris, contextUri) {
    if (!uris || uris.length === 0) {
      notify("Play a song first, then tap the tag button.", true);
      return;
    }
    const data = load();
    const info = await fetchInfo(uris, data, contextUri);
    const root = el("div", "vt-root");
    let newColor = DEFAULT_COLOR;
    let colorPicked = false;

    // A vibe is "on" only if every selected song already has it.
    function isOn(vibe) {
      return uris.every((u) => data.tracks[u]?.vibes.includes(vibe));
    }

    function toggle(vibe, on, color) {
      for (const uri of uris) {
        setVibe(data, uri, info[uri], vibe, on, color);
        const t = data.tracks[uri];
        if (t) Object.assign(t, merge(t, info[uri]));
      }
      save(data);
    }

    const first = info[uris[0]];
    const label =
      uris.length === 1
        ? `${first.name}${first.artist ? " · " + first.artist : ""}`
        : `${uris.length} songs selected`;
    root.appendChild(el("div", "vt-muted", label));

    // New vibe: name + color.
    const input = el("input", "vt-input");
    input.placeholder = "New vibe, e.g. rainy 2am";
    const add = () => {
      const vibe = normalize(input.value);
      if (!vibe) return;
      // Retyping an existing vibe keeps its color unless you picked a new one.
      if (data.vibes[vibe] && colorPicked) setColor(data, vibe, newColor);
      toggle(vibe, true, newColor);
      input.value = "";
      renderChips();
      notify(`Tagged "${vibe}"`);
    };
    input.addEventListener("keydown", (e) => e.key === "Enter" && add());
    const row = el("div", "vt-row");
    row.append(input, button("Add", add));
    root.appendChild(row);

    const swatches = colorPicker(newColor, (c) => {
      newColor = c;
      colorPicked = true;
    });
    swatches.prepend(el("span", "vt-sub", "Color:"));
    root.appendChild(swatches);

    // Existing vibes as colored toggle chips. Chips flip in place so the list
    // doesn't reshuffle (or close the modal) while you click through it.
    const chipsBox = el("div", "vt-root");
    root.appendChild(chipsBox);
    function renderChips() {
      chipsBox.replaceChildren();
      const vibes = allVibes(data);
      if (vibes.length === 0) {
        chipsBox.appendChild(el("div", "vt-muted", "No vibes yet. Type your first one above."));
        return;
      }
      chipsBox.appendChild(el("div", "vt-sub", "Click a vibe to add or remove it"));
      const chips = el("div", "vt-chips");
      for (const { name, color } of vibes) {
        const chip = el("button", isOn(name) ? "vt-chip on" : "vt-chip", name);
        chip.style.setProperty("--vt-color", color);
        chip.addEventListener("click", () => {
          const on = !isOn(name);
          toggle(name, on);
          chip.classList.toggle("on", on);
        });
        chips.appendChild(chip);
      }
      chipsBox.appendChild(chips);
    }
    renderChips();

    const footer = el("div", "vt-row");
    footer.appendChild(button("Open Tagged songs", () => {
      Spicetify.PopupModal.hide();
      openPage();
    }, true));
    root.appendChild(footer);

    Spicetify.PopupModal.display({ title: "Tag vibe", content: root });
    setTimeout(() => input.focus(), 0);
  }

  function openRenameDialog(vibe) {
    const root = el("div", "vt-root");
    const input = el("input", "vt-input");
    input.value = vibe;
    const done = () => {
      const to = normalize(input.value);
      if (!to) return;
      const data = load();
      const merging = to !== vibe && data.vibes[to];
      renameVibe(data, vibe, to);
      save(data);
      Spicetify.PopupModal.hide();
      notify(merging ? `Merged "${vibe}" into "${to}"` : `Renamed to "${to}"`);
    };
    input.addEventListener("keydown", (e) => e.key === "Enter" && done());
    const row = el("div", "vt-row");
    row.append(input, button("Rename", done));
    root.append(row, el("div", "vt-sub", "Using a name that already exists merges the two vibes."));
    Spicetify.PopupModal.display({ title: `Rename "${vibe}"`, content: root });
    setTimeout(() => input.select(), 0);
  }

  function openDeleteDialog(vibe) {
    const data = load();
    const count = Object.values(data.tracks).filter((t) => t.vibes.includes(vibe)).length;
    const root = el("div", "vt-root");
    root.appendChild(el("div", "vt-muted",
      `This removes "${vibe}" from ${count} ${count === 1 ? "song" : "songs"}. The songs themselves stay in Spotify.`));
    const row = el("div", "vt-row");
    row.append(
      button("Cancel", () => Spicetify.PopupModal.hide(), true),
      button("Delete vibe", () => {
        const d = load();
        deleteVibe(d, vibe);
        save(d);
        Spicetify.PopupModal.hide();
        notify(`Deleted "${vibe}"`);
      })
    );
    root.appendChild(row);
    Spicetify.PopupModal.display({ title: `Delete "${vibe}"?`, content: root });
  }

  function openPage() {
    Spicetify.Platform.History.push(PAGE_PATH);
  }

  // ---------- Entry points ----------

  const isTrack = (uri) => Spicetify.URI.fromString(uri).type === Spicetify.URI.Type.TRACK;

  new Spicetify.ContextMenu.Item(
    "Tag vibe…",
    (uris, uids, contextUri) => openTagPicker(uris, contextUri),
    (uris) => uris.length > 0 && uris.every(isTrack),
    "heart"
  ).register();

  new Spicetify.ContextMenu.Item("Open Tagged songs", openPage, () => true, "heart").register();

  // images/tag_song.png, inlined because extensions can't load files of their own.
  const TAG_ICON =
    '<svg class="vt-icon" width="16" height="16" viewBox="0 0 24 24"><image width="24" height="24" ' +
    'href="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABgAAAAYCAYAAADgdz34AAABjElEQVR4AbyV21GEMBSGFyrQDrYE7cB3YEY6sAS3ArWCtQNLcIbL8GgJawdbghbAgP/HGIaFQJIH3eGfnJzbB0lg490f//4P0DTNvizL3qWqqh5DHnp8grZtzz6Ffd8fdRPPPrnkjAAmKMuyaE1xHN+SIz35QhYAFe+0DNxlz8jcKEmSz1CIFaBlGNbZjAbAGAqxAqIoeqWZGbGnCoFYAWmaHtgHxmnjqe0LsQKmjbZsH4g3oCiKB52cOwPElu5dkAWgrusb08SMOk1n7ceb5h/YCFt6F+RrDlF8OCSK70aAGhxwdF13mkN0mvbEEDbC/tUV4xSi+BEfGgHaUE7OC04bBL9LquMpL9JGAF6dHD4BC4j8EXGbTExLdVJ8WF59dq5lD9cFAI8KvCHKHcDz5nmef9MLLQA4VeiEKMfZnF5WAAE1WIUo5tWcPqsAgmpkhRDbWhbiRpsAkmwQ3+bUOwEkzSHyjadluqHyLy4vAFVAzMvInKPoak6eN4BkXkaBhn88n+bUBAEoCNUPAAAA//+t9qLCAAAABklEQVQDAAnsI0Cj5zvRAAAAAElFTkSuQmCC"/></svg>';

  // Tag button in the player bar: tags whatever is playing right now.
  const tagButton = new Spicetify.Playbar.Button("Tag vibe", TAG_ICON, () => {
    const uri = Spicetify.Player.data?.item?.uri;
    openTagPicker(uri && isTrack(uri) ? [uri] : []);
  });

  // Spicetify puts playbar buttons at the start of the right-hand controls.
  // Move the tag button so it sits directly left of the lyrics button when we can find it.
  function placeTagButton() {
    const lyrics = document.querySelector('[data-testid="lyrics-button"]');
    const node = tagButton.element;
    if (lyrics && node && lyrics.previousElementSibling !== node) {
      lyrics.parentElement.insertBefore(node, lyrics);
    }
  }
  new MutationObserver(placeTagButton).observe(document.body, { childList: true, subtree: true });
  placeTagButton();

  setTimeout(() => repairInfo().catch((e) => console.warn("[Vibe Tagger] Repair failed", e)), 5000);

  // Shared with the Tagged songs page (index.js), which loads later in the same window.
  window.VibeTagger = {
    CHANGED_EVENT,
    PALETTE,
    load,
    save,
    normalize,
    allVibes,
    allTracks,
    colorOf,
    setColor,
    setVibe,
    importBackup,
    makePlaylist,
    playAll,
    openTagPicker,
    openRenameDialog,
    openDeleteDialog,
    renameVibe,
    deleteVibe,
    repairInfo,
  };
})();
