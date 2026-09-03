<p align="center">
  <img src="pages/images/logo-512.png" width="160" alt="GOTTA.BIKE Sauce Lunatic">
</p>

<h1 align="center">GOTTA.BIKE Sauce Lunatic</h1>

<p align="center"><em>Like having Phil Liggett announcing your Zwift race, if he was a lunatic.</em></p>

A [Sauce4Zwift](https://github.com/SauceLLC/sauce4zwift) mod that calls your Zwift
race live — as a TV commentator would — and reads it aloud while you ride.

It watches the riders around you at 1&nbsp;Hz, detects what actually *changes* on the
road (attacks, riders cracking, gaps opening, catches), and asks Claude for a
one-line race call. Lines fire when something happens, not on a timer.

## Features

- **Event-driven commentary.** Attacks, splits, catches and riders going backwards
  trigger a call. A fixed clock does not.
- **Spoken aloud.** Sentences are spoken as they stream in, so audio starts at the
  first sentence. Uses your Mac's built-in voices — no extra API, no round trip.
- **Race aware.** Distance to go, your placing, gradient, route and event name.
- **Storyline memory.** An attack is remembered, so the catch two minutes later
  gets a callback.
- **Won't repeat itself.** Lines that restate a recent one are dropped.

## Requires your own Anthropic API key

This mod calls the Claude API **directly from the overlay** with a key you enter in
its settings. Usage is billed to **your** Anthropic account. Rider data and your API
key are sent from the browser overlay to `api.anthropic.com`.

Default model is Claude Haiku 4.5 — the fastest and cheapest, which is what live
commentary wants. Roughly $0.15–0.35 per hour of racing at the default cadence.

## Install

1. Download the latest zip from [Releases](https://github.com/vincentdavis/GOTTA_BIKE_Sauce_Lunatic/releases).
2. Unzip into `~/Documents/SauceMods/` so you have
   `SauceMods/GOTTA_BIKE_Sauce_Lunatic/manifest.json`.
3. Restart Sauce4Zwift, enable the mod, open the **Lunatic Announcer** window.
4. Open its settings (gear icon) → **Claude API** tab → paste your key.
5. Click the speaker button in the titlebar to unmute. Audio is off by default.

## Controls

| Button | What it does |
|---|---|
| ⟳ | Generate a line right now |
| ▮▮ | Pause / resume (also stops the voice) |
| 🔊 | Mute / unmute spoken commentary |
| ⧉ | Copy the current line |

## Optional: GOTTA.BIKE rider data

If you also run [GOTTA.BIKE sauce](https://github.com/vincentdavis/GOTTA_BIKE_sauce)
and have imported rider data there, this mod reads it automatically to enrich the
commentary with FTP, phenotype, race rating and win counts. It is entirely
optional — the announcer works from live Zwift data alone.

## Development

```bash
./local_build.sh          # build zip + install to ~/Documents/SauceMods
./local_build.sh --no-install
```

Releases are tag-driven. Bump `version` in `manifest.json`, then:

```bash
git tag v0.2.0 && git push origin v0.2.0
```

CI refuses to publish if the tag and the manifest version disagree, or if a
full release is tagged on a commit that never reached `main`.

A `-rc` suffix publishes a pre-release against the same manifest version
(`v0.2.0-rc1` -> manifest `0.2.0`), and is exempt from the `main` check.
To exercise the whole build without spending a tag, run the **Release**
workflow manually from any branch: it validates, builds the zip and uploads
it as a workflow artifact instead of publishing.

## License

MIT — see [LICENSE](LICENSE).
