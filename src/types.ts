// Core domain types for the Watch Later Synthesizer plugin.

export interface Clipping {
	path: string;
	title: string;
	mtime: number; // file last-modified time, for incremental sync
	url?: string; // frontmatter "source" or "url"
	author?: string; // frontmatter "author"
	savedDate?: string; // frontmatter "created" or "date saved"
	status?: string; // frontmatter "status" (e.g. unread / read)
}

export interface ClipExtraction {
	id: string; // djb2 hash of the clipping path
	summary: string; // 2-3 sentences, in the article's own language
	keyClaims: string[]; // in the article's own language
	topics: string[]; // lowercase
	language?: string; // ISO 639-1 code of the article
	readTimeMinutes?: number;
}

export interface ThemeSynthesis {
	consensus: string; // 1-2 sentences: what the sources agree on
	tension: string; // 1-2 sentences: where they diverge, or "" if none
	language?: string; // ISO 639-1 of the dominant source language
}

export interface SynthesisCache {
	extractions: Record<string, { mtime: number; extraction: ClipExtraction }>;
	// Per-theme LLM synthesis, keyed by theme (lowercase topic). `signature`
	// is a hash of the member set + their mtimes, so an unchanged theme is
	// never re-synthesized (zero tokens on re-sync).
	themeSyntheses: Record<string, { signature: string; synthesis: ThemeSynthesis }>;
	lastSynced: string;
}
