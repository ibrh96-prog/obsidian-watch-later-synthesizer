# Watch Later Synthesizer

An Obsidian plugin that turns your web-clippings backlog into reading memory: batch summaries, cross-article themes, and weekly digests.

## The Problem

You clip dozens of articles into Obsidian with the Web Clipper and never process them. A month later you have 40 unread clippings and no idea which ones still matter. This plugin reads the whole backlog and gives you one synthesis note: what each clipping says, which themes run across them, what you saved this week, and what has gone stale.

## Features

- **Reading inbox** — Every clipping at a glance with its topics and estimated read time
- **Themes** — Topics shared across two or more clippings, with an AI-written consensus and the tension between sources
- **This week** — What you saved in the current week (Monday start)
- **Needs attention** — Clippings that have sat unread past your stale threshold, oldest first
- **Summaries** — A short summary and the key claims of every synced clipping

## How It Works

1. Clip articles into Obsidian as you normally would (the official Web Clipper works out of the box)
2. Run **Sync clippings** from the command palette to extract summaries, claims, and topics
3. Run **Generate reading report** from the command palette or the ribbon icon
4. A `Reading Synthesis.md` note is written to your vault root and opened
5. Re-run either command any time — syncing is incremental, so unchanged clippings are never re-processed

## Setup

1. Install the plugin from Obsidian Community Plugins
2. Go to **Settings → Watch Later Synthesizer**
3. Select your AI provider (Anthropic, OpenAI, OpenRouter, or custom)
4. Enter your API key
5. Set your clippings folder (default `Clippings`) or clipping tag (default `clipping`)
6. Run **Sync clippings**, then **Generate reading report**

## Supported AI Providers

- **Anthropic** — Claude models (recommended: `claude-sonnet-4-6`)
- **OpenAI** — GPT models (recommended: `gpt-4o-mini`)
- **OpenRouter** — Access to many models including free options (recommended: `meta-llama/llama-4-maverick`)
- **Custom** — Any OpenAI-compatible endpoint

## Free vs Pro

| Feature | Free | Pro |
|---|---|---|
| Clipping syncs | 3 total | Unlimited |
| Reading report | Unlimited | Unlimited |
| All AI providers | ✅ | ✅ |
| Cross-article themes | ✅ | ✅ |

The free tier allows 3 total syncs (a one-time allowance, not a monthly reset). Generating the reading report from already-synced clippings is always free. Upgrade to Pro at [ibrh96.gumroad.com/l/yeulsi](https://ibrh96.gumroad.com/l/yeulsi) for unlimited syncing.

## Privacy

- Your clippings never leave your device except to your chosen AI provider
- No servers, no databases, no telemetry
- Your API key is stored locally in Obsidian's data storage

## License

See [EULA.md](EULA.md) for terms of use.
