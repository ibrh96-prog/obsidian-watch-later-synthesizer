// Core domain types for the Watch Later Synthesizer plugin.

/**
 * One YouTube video from the watch-later pile, parsed from a vault note.
 * Every metadata field is nullable because clipper/import templates vary and
 * any field may be absent.
 */
export interface VideoRecord {
	videoId: string;
	url: string;
	title: string | null;
	channel: string | null;
	published: string | null;
	duration: string | null;
	sourceFile: string; // the note path this video came from
	descriptionText: string | null; // body "## Description" content, if present
}

/**
 * Per-video triage decision produced by the synthesizer: keep it in the pile
 * to watch, or skip it.
 */
export interface VideoVerdict {
	videoId: string;
	verdict: "watch" | "skip";
	likelyTopic: string;
	reason: string; // short justification
	// Model output: does the video's value depend on WHEN it was made? The model
	// classifies content type only — it does no date math.
	timeSensitivity: "time-sensitive" | "evergreen";
	// Engine-computed, NOT cached as authoritative: recomputed each render from
	// timeSensitivity + published + today, so a video correctly becomes stale as
	// time passes without re-calling the LLM. `stale` is true only for
	// time-sensitive content older than the staleness threshold.
	stale: boolean;
	stalenessReason: string; // engine-written; "" unless stale
}

/**
 * Full synthesis output across the whole watch-later pile: a verdict per video,
 * the themes that recur across the pile, and the videos safe to delete.
 */
export interface TriageResult {
	verdicts: VideoVerdict[];
	recurringThemes: string[]; // cross-pile recurring themes
	safeToDelete: string[]; // videoIds safe to remove
}

/**
 * Persisted synthesis state. Two incremental layers, both keyed by djb2
 * signatures so unchanged work is never re-sent to the LLM:
 *   - `verdicts`: per-video verdict cache keyed by videoId. `signature` hashes
 *     the verdict-affecting fields (title + channel + duration + published +
 *     descriptionText); an unchanged signature means reuse, zero LLM cost.
 *   - `themes`: cross-pile synthesis, reused while `memberSignature` (a hash of
 *     the sorted videoIds plus their per-video signatures) is unchanged.
 */
export interface SynthesisCache {
	verdicts: Record<string, { signature: string; verdict: VideoVerdict }>;
	themes: {
		memberSignature: string;
		recurringThemes: string[];
		safeToDelete: string[];
	};
	lastSynced: string;
}
