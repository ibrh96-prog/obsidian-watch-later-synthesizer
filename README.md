# Watch Later Synthesizer

An Obsidian plugin that triages your YouTube watch-later backlog: per-video watch/skip verdicts, recurring themes across the pile, and a clear list of what's safe to delete.

## The Problem

Watch-later lists were supposed to be a promise — "I'll get to this." What shows up consistently in forums and community threads is a different picture: lists of 200, 400, 800 videos that grow faster than anyone watches them, carrying a low-grade guilt that accumulates over months or years. The real question isn't whether you watched everything. It's whether you missed anything that was actually worth your time. This plugin answers that question without requiring you to watch any of it.

## Features

- **Triage at a glance** — Every video with a watch/skip verdict and its likely topic, so you can act on the backlog without opening a single video
- **Recurring themes** — Topics that run across multiple videos in your pile, surfaced as a pattern rather than repeated individual verdicts
- **Time-sensitive flags** — Content that was timely when saved (live events, breaking news) and has likely expired its value at 90+ days old, flagged separately from the watch/skip verdict
- **Safe to delete** — A conservative list of genuinely low-value videos (clickbait, spam) based on metadata signals; stale-but-substantive content is never included here
- **No summaries — triage only** — v1 runs on metadata (title, channel, description, duration); there are no per-video summaries, the output is verdicts and themes, not content recaps

## How It Works

The plugin expects watch-later videos as Obsidian notes produced by the official Web Clipper. Each note should have frontmatter with `url`, `title`, `channel`, `published`, and `duration`, plus a `## Description` section in the body. As a fallback, it also scans a running-list note for bare YouTube URLs. When title or channel are missing, it enriches metadata via oEmbed using Obsidian's built-in `requestUrl` — no browser extension or external server required.

**No transcript fetching.** YouTube's bot-detection reliably blocks client-side caption requests, so triage runs entirely on metadata. Watch/skip verdicts are based on title, channel, description, and duration — not on what was said in the video.

1. Add YouTube videos to Obsidian via the Web Clipper into your Watch Later folder (or tag them `watch-later`)
2. Run **Sync videos** from the command palette to extract and cache per-video metadata
3. Run **Generate triage report** from the command palette or the ribbon icon
4. A `Watch Later Triage.md` note is written to your vault root and opened
5. Re-run either command any time — syncing is incremental, so already-processed videos are not re-sent to the LLM

## Setup

1. Install and enable the plugin from Obsidian Community Plugins
2. Put your YouTube watch-later notes in a **Watch Later** folder, or tag them **watch-later** (both work; you can use either or both)
3. Go to **Settings → Watch Later Synthesizer** and configure your AI provider, API key, Base URL, and model
4. Run **Sync videos**, then **Generate triage report**

## Supported AI Providers

- **Anthropic** — Claude models (recommended: `claude-sonnet-4-6`)
- **OpenAI** — GPT models (recommended: `gpt-4o-mini`)
- **OpenRouter** — Access to many models including free options (recommended: `meta-llama/llama-4-maverick`)
- **Custom** — Any OpenAI-compatible endpoint

Triage quality — especially the watch-vs-skip distinction — depends heavily on the model you use. Small and free models tend to under-skip, marking almost everything as "watch" because they're conservative by default. For verdicts you can actually trust, use a capable model: Claude Sonnet, GPT-4o-mini, or a strong OpenRouter model like Llama 4 Maverick. Tiny free-tier models are fine for testing that the pipeline works, but not for making real calls on a backlog you want to act on.

## Free vs Pro

| Feature | Free | Pro |
|---|---|---|
| Video syncs | 3 total | Unlimited |
| Triage report | Unlimited | Unlimited |
| All AI providers | ✅ | ✅ |

The free tier allows 3 total video syncs (a one-time allowance, not a monthly reset). Generating the triage report from already-synced videos is always free. Pro unlocks unlimited syncing. The Pro license is available on Gumroad: https://ibrh96.gumroad.com/l/lljtqy

## Privacy

Your video metadata stays on your device except for the LLM call: when you run Sync or Generate, metadata (titles, channels, descriptions) is sent directly from your machine to your chosen AI provider using your own API key. The developer has no server, no account system, no telemetry, and receives none of your data. Your API key is stored locally in Obsidian's data storage and is never transmitted anywhere except to the provider you configure.

## License

See [EULA.md](EULA.md) for terms of use.
