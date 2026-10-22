# Spotify Mood Tagger

I always associate songs with feelings, so whenever I make playlists I tend to find songs that all fit a specific mood. Becuase I don't want to keep a tracker separate, I'm creating a [Spicetify](https://spicetify.app/) extension for the Spotify desktop app that lets you tag songs with vibes, browse your songs by a tag, and turn any feeling into a playlist. 

Applying a tag:
!(applying a tag)[images/apply_tag.png]

Seeing your tagged songs:
!(tagged songs)[images/tagged_v1.png]

> Your tags will stay on your own computer. Use **backup** in the Vibes window to copy them to another device.

### Requirements

- The spotify desktop app from spotify.com.
- Install Spicetify:
Windows (powershell): `iwr -useb https://raw.githubusercontent.com/spicetify/cli/main/install.ps1 | iex`

macOs/Linux: `curl -fsSL https://raw.githubusercontent.com/spicetify/cli/main/install.sh | sh`

### Install this extension
Windows (powershell):
```shell
iwr -useb https://raw.githubusercontent.com/vickycye/spotify_mood_tagger/main/vibeTagger.js -OutFile "$env:APPDATA\spicetify\Extensions\vibeTagger.js"
spicetify config extensions vibeTagger.js
spicetify apply
```

macOS/Linux:
```shell
mkdir -p ~/.config/spicetify/Extensions
curl -fsSL https://raw.githubusercontent.com/vickycye/spotify_mood_tagger/main/vibeTagger.js -o ~/.config/spicetify/Extensions/vibeTagger.js
spicetify config extensions vibeTagger.js
spicetify apply
```

When Spotify restarts, you'll see a vibes button in the top bar.

### Update
Run the download command again (the `iwr` or `curl` line), then run `spicetify apply`.

### Uninstall
```shell
spicetify config extensions vibeTagger.js-
spicetify apply
```