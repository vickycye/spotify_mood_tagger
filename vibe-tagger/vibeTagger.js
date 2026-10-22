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
  const PALETTE = ["#f47c7c", "#f7b267", "#f9e076", "#9ad98c", "#6fd0c5", "#7fb3ff", "#b39cff", "#f598d6"];

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
      for (const v of track.vibes) if (!data.vibes[v]) data.vibes[v] = { color: nextColor(data) };
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

  function nextColor(data) {
    return PALETTE[Object.keys(data.vibes).length % PALETTE.length];
  }

  function colorOf(data, vibe) {
    return data.vibes[vibe]?.color || PALETTE[0];
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
    if (on && !data.vibes[vibe]) data.vibes[vibe] = { color: color || nextColor(data) };
    let track = data.tracks[uri];
    if (!track) {
      if (!on) return;
      track = data.tracks[uri] = { ...info, vibes: [], taggedAt: Date.now() };
    }
    if (on && !track.vibes.includes(vibe)) track.vibes.push(vibe);
    if (!on) track.vibes = track.vibes.filter((v) => v !== vibe);
    if (track.vibes.length === 0) delete data.tracks[uri];
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

    const current = Spicetify.Player.data?.item;
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
    .vt-color-input { width: 28px; height: 24px; border: none; background: none; padding: 0; cursor: pointer; }
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

    .vt-page { padding: 32px; color: var(--spice-text, #fff); display: flex; flex-direction: column; gap: 20px; }
    .vt-page h1 { font-size: 48px; font-weight: 900; margin: 0; }
    .vt-table { display: flex; flex-direction: column; }
    .vt-tr { display: grid; grid-template-columns: 32px minmax(180px, 2fr) minmax(200px, 3fr) 90px; gap: 12px;
      align-items: center; padding: 8px; border-radius: 6px; }
    .vt-tr:hover { background: var(--spice-main-elevated, #2a2a2a); }
    .vt-th { color: var(--spice-subtext, #b3b3b3); font-size: 12px; text-transform: uppercase;
      border-bottom: 1px solid #333; border-radius: 0; }
    .vt-th:hover { background: none; }
    .vt-title { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; cursor: pointer; }
    .vt-title:hover { text-decoration: underline; }
    .vt-group { font-size: 20px; font-weight: 700; margin: 16px 0 4px; display: flex; gap: 8px; align-items: center; }
    .vt-dot { width: 12px; height: 12px; border-radius: 50%; display: inline-block; }
    .vt-x { margin-left: 4px; opacity: 0.6; }
    .vt-x:hover { opacity: 1; }
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

  async function openTagPicker(uris) {
    if (!uris || uris.length === 0) {
      notify("Play a song first, then tap the heart.", true);
      return;
    }
    const data = load();
    const info = await fetchInfo(uris, data);
    const root = el("div", "vt-root");
    let newColor = nextColor(data);

    // A vibe is "on" only if every selected song already has it.
    function isOn(vibe) {
      return uris.every((u) => data.tracks[u]?.vibes.includes(vibe));
    }

    function toggle(vibe, on, color) {
      for (const uri of uris) setVibe(data, uri, info[uri], vibe, on, color);
      save(data);
      render();
    }

    function render() {
      root.replaceChildren();

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
        if (data.vibes[vibe]) setColor(data, vibe, newColor);
        toggle(vibe, true, newColor);
        newColor = nextColor(data);
        notify(`Tagged "${vibe}"`);
      };
      input.addEventListener("keydown", (e) => e.key === "Enter" && add());
      const row = el("div", "vt-row");
      row.append(input, button("Add", add));
      root.appendChild(row);

      const swatches = el("div", "vt-swatches");
      swatches.appendChild(el("span", "vt-sub", "Color:"));
      for (const c of PALETTE) {
        const s = el("button", c === newColor ? "vt-swatch on" : "vt-swatch");
        s.style.background = c;
        s.title = c;
        s.addEventListener("click", () => {
          newColor = c;
          render();
        });
        swatches.appendChild(s);
      }
      const custom = el("input", "vt-color-input");
      custom.type = "color";
      custom.value = newColor;
      custom.title = "Pick any color";
      custom.addEventListener("change", () => {
        newColor = custom.value;
        render();
      });
      swatches.appendChild(custom);
      root.appendChild(swatches);

      // Existing vibes as colored toggle chips.
      const vibes = allVibes(data);
      if (vibes.length === 0) {
        root.appendChild(el("div", "vt-muted", "No vibes yet. Type your first one above."));
      } else {
        root.appendChild(el("div", "vt-sub", "Click a vibe to add or remove it"));
        const chips = el("div", "vt-chips");
        for (const { name, color } of vibes) {
          const on = isOn(name);
          const chip = el("button", on ? "vt-chip on" : "vt-chip", name);
          chip.style.setProperty("--vt-color", color);
          chip.addEventListener("click", () => toggle(name, !on));
          chips.appendChild(chip);
        }
        root.appendChild(chips);
      }

      const footer = el("div", "vt-row");
      footer.appendChild(button("Open Tagged songs", () => {
        Spicetify.PopupModal.hide();
        openPage();
      }, true));
      root.appendChild(footer);

      setTimeout(() => input.focus(), 0);
    }

    render();
    Spicetify.PopupModal.display({ title: "Tag vibe", content: root });
  }

  function openPage() {
    Spicetify.Platform.History.push(PAGE_PATH);
  }

  // ---------- Entry points ----------

  const isTrack = (uri) => Spicetify.URI.fromString(uri).type === Spicetify.URI.Type.TRACK;

  new Spicetify.ContextMenu.Item(
    "Tag vibe…",
    (uris) => openTagPicker(uris),
    (uris) => uris.length > 0 && uris.every(isTrack),
    "heart"
  ).register();

  new Spicetify.ContextMenu.Item("Open Tagged songs", openPage, () => true, "heart").register();

  // Heart in the player bar: tags whatever is playing right now.
  const heart = new Spicetify.Playbar.Button("Tag vibe", "heart", () => {
    const uri = Spicetify.Player.data?.item?.uri;
    openTagPicker(uri && isTrack(uri) ? [uri] : []);
  });

  // Spicetify puts playbar buttons at the start of the right-hand controls.
  // Move the heart so it sits directly left of the lyrics button when we can find it.
  function placeHeart() {
    const lyrics = document.querySelector('[data-testid="lyrics-button"]');
    const node = heart.element;
    if (lyrics && node && lyrics.previousElementSibling !== node) {
      lyrics.parentElement.insertBefore(node, lyrics);
    }
  }
  new MutationObserver(placeHeart).observe(document.body, { childList: true, subtree: true });
  placeHeart();

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
  };
})();
