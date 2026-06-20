/**
 * Runtime tunables for the API (the Python pipeline has its own
 * pipeline/config.py — keep the two in sync where concepts overlap).
 */

/**
 * TOPIC_ANALYTICS: minimum cosine similarity between the embedded topic
 * phrase (e.g. "hashing") and a cluster's centroid for that cluster to count
 * as being "about" the topic. Short phrases score lower against full
 * question sentences than question-vs-question pairs do, so this sits well
 * below the pipeline's 0.80 clustering threshold. Calibrated on live data:
 * "hashing" scores 0.39–0.61 against Data Structures' hash clusters, 0.33
 * against the nearest off-topic cluster; cross-subject noise stays < 0.15.
 */
export const TOPIC_MATCH_THRESHOLD = Number(process.env.TOPIC_MATCH_THRESHOLD ?? 0.4);

/**
 * SEMANTIC: retrieval hits below this cosine similarity don't count as
 * coverage; fewer than MIN_GROUNDING_HITS hits at/above it means the papers
 * don't cover the query — the API answers honestly instead of synthesizing.
 * Calibrated on live data: weakest on-topic query ("what is subnetting...")
 * scored 0.395 top-1; strongest off-topic ("quantum entanglement" asked in
 * Computer Networks) scored 0.335; cross-domain noise sits below 0.2.
 */
export const SEMANTIC_MIN_SIMILARITY = Number(process.env.SEMANTIC_MIN_SIMILARITY ?? 0.36);
export const MIN_GROUNDING_HITS = 2;
