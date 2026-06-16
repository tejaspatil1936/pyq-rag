/**
 * Query-time embeddings for semantic search.
 *
 * The corpus was embedded by the pipeline with sentence-transformers
 * all-MiniLM-L6-v2 (384-dim, normalized). Cosine similarity is only
 * meaningful inside ONE embedding space, so the query MUST go through the
 * same model — a Gemini embedding would be a different space entirely.
 * sentence-transformers (PyTorch) can't run on Vercel serverless, so we run
 * the same model as quantized ONNX via transformers.js: ~23 MB, downloaded
 * on cold start and cached in /tmp (the only writable path on Vercel).
 *
 * Parity with the Python-side vectors is asserted by an integration test
 * (tests/embed-parity.test.ts).
 */

import {
  pipeline as hfPipeline,
  env,
  type FeatureExtractionPipeline,
} from "@huggingface/transformers";

// transformers.js' overloaded pipeline() signature explodes into a union too
// complex for tsc (TS2590); collapse it to the one call shape we use.
const pipeline = hfPipeline as (
  task: "feature-extraction",
  model: string,
  options?: { dtype: string },
) => Promise<FeatureExtractionPipeline>;

env.cacheDir = process.env.TRANSFORMERS_CACHE_DIR ?? "/tmp/transformers-cache";

export const EMBED_DIM = 384;

// Same weights as sentence-transformers/all-MiniLM-L6-v2, converted to ONNX.
const MODEL_ID = "Xenova/all-MiniLM-L6-v2";

let extractorPromise: Promise<FeatureExtractionPipeline> | null = null;

function getExtractor(): Promise<FeatureExtractionPipeline> {
  extractorPromise ??= pipeline("feature-extraction", MODEL_ID, { dtype: "q8" });
  return extractorPromise;
}

export async function embedQuery(text: string): Promise<number[]> {
  const extractor = await getExtractor();
  // mean pooling + L2 normalize matches the pipeline's
  // encode(..., normalize_embeddings=True)
  const out = await extractor(text, { pooling: "mean", normalize: true });
  const vec = Array.from(out.data as Float32Array);
  if (vec.length !== EMBED_DIM) {
    throw new Error(`expected ${EMBED_DIM}-dim embedding, got ${vec.length}`);
  }
  return vec;
}

/** pgvector text literal, e.g. "[0.1,-0.2,...]" — pass as $n::vector. */
export function toVectorLiteral(vec: number[]): string {
  return `[${vec.map((x) => x.toFixed(6)).join(",")}]`;
}
