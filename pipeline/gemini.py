"""Question extraction from paper text via Gemini Flash.

Every call goes through the KeyManager pool (never the reserved runtime
key). JSON output is forced via responseMimeType; a parse failure is logged
and retried ONCE with a repair prompt per the quality gates. The REST API is
used directly so per-call key rotation stays trivial.
"""

import json
import logging
import re
import time

import requests

import config

log = logging.getLogger(__name__)

API_URL = "https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent"

EXTRACTION_PROMPT = """\
You are extracting exam questions from the raw text of a university question paper.

Return ONLY a JSON array. Each element must be an object with exactly these keys:
  "question_text": string  — the complete text of one individual question
  "marks": integer or null — the marks allotted to it, if stated
  "sub_question_label": string or null — its label like "Q1a", "2(b)", if present

Rules:
- Extract EVERY individual question and sub-question as its own element.
- Clean numbering artifacts out of question_text, but never paraphrase or shorten it.
- Do NOT include instructions, headers, course/exam metadata, or page furniture.
- Do NOT invent questions that are not in the text.
- If the text contains no questions, return [].

Paper text follows:
"""

REPAIR_PROMPT = """\
The following text was supposed to be a JSON array of objects with keys
"question_text", "marks", "sub_question_label", but it failed to parse.
Return ONLY the corrected, valid JSON array — no commentary, no markdown.

"""


class GeminiError(Exception):
    """Permanent failure for this input; the paper is marked failed, run continues."""


def _call(km, prompt):
    """Send one prompt, rotating keys on rate limits. Returns (text, key_index)."""
    max_attempts = max(km.pool_size * 2, 4)
    for attempt in range(1, max_attempts + 1):
        idx, key = km.acquire()
        try:
            resp = requests.post(
                API_URL.format(model=config.GEMINI_MODEL),
                params={"key": key},
                json={
                    "contents": [{"parts": [{"text": prompt}]}],
                    "generationConfig": {
                        "temperature": 0.0,
                        "responseMimeType": "application/json",
                    },
                },
                timeout=config.GEMINI_TIMEOUT_S,
            )
        except requests.RequestException as exc:
            log.warning("key[%d] network error (attempt %d): %s", idx, attempt, exc)
            time.sleep(5)
            continue

        if resp.status_code == 200:
            time.sleep(config.GEMINI_CALL_DELAY_S)  # stay under per-minute limits
            try:
                body = resp.json()
                return body["candidates"][0]["content"]["parts"][0]["text"], idx
            except (KeyError, IndexError, TypeError, ValueError) as exc:
                # Empty/blocked candidate: not retryable for this input.
                raise GeminiError(f"unexpected response shape: {exc}") from exc

        if resp.status_code == 429:
            body = resp.text
            retry_m = re.search(r'"retryDelay"\s*:\s*"(\d+)', body)
            retry_s = int(retry_m.group(1)) + 1 if retry_m else None
            if "PerDay" in body or "daily" in body.lower():
                log.warning("key[%d] daily quota exhausted", idx)
                km.mark_quota_exhausted(idx)
            else:
                log.warning("key[%d] rate limited (per-minute)", idx)
                km.mark_rate_limited(idx, retry_s)
            continue

        if resp.status_code in (500, 502, 503, 504):
            log.warning("key[%d] server error %d, retrying", idx, resp.status_code)
            time.sleep(5)
            continue

        if resp.status_code in (401, 403):
            log.error("key[%d] rejected (%d) — removing from this run", idx, resp.status_code)
            km.mark_quota_exhausted(idx)
            continue

        # 400 etc: problem with the request itself, other keys won't help.
        raise GeminiError(f"HTTP {resp.status_code}: {resp.text[:300]}")

    raise GeminiError(f"no successful response after {max_attempts} attempts")


def _parse_questions(raw):
    data = json.loads(raw)
    if isinstance(data, dict):
        # Model occasionally wraps the array in an object; take the first list.
        data = next((v for v in data.values() if isinstance(v, list)), None)
    if not isinstance(data, list):
        raise ValueError("response is not a JSON array")

    out = []
    for item in data:
        if not isinstance(item, dict):
            continue
        text = str(item.get("question_text") or "").strip()
        if len(text) < config.MIN_QUESTION_CHARS:
            continue
        marks = item.get("marks")
        try:
            marks = int(marks) if marks is not None else None
        except (TypeError, ValueError):
            marks = None
        label = item.get("sub_question_label")
        label = (str(label).strip()[:50] or None) if label else None
        out.append({
            "question_text": text[: config.MAX_QUESTION_CHARS],
            "marks": marks,
            "sub_label": label,
        })
    return out


def extract_questions(km, paper_text):
    """Extract questions from one paper's text. Raises GeminiError on permanent failure."""
    raw, idx = _call(km, EXTRACTION_PROMPT + paper_text[: config.MAX_PROMPT_CHARS])
    try:
        questions = _parse_questions(raw)
        log.info("key[%d] extracted %d questions", idx, len(questions))
        return questions
    except (ValueError, json.JSONDecodeError) as exc:
        # Quality gate: log every parse failure, retry once with a repair prompt.
        log.warning("Gemini JSON parse failure (%s); retrying with repair prompt", exc)

    raw2, idx2 = _call(km, REPAIR_PROMPT + raw[: config.MAX_PROMPT_CHARS])
    try:
        questions = _parse_questions(raw2)
        log.info("key[%d] repair prompt recovered %d questions", idx2, len(questions))
        return questions
    except (ValueError, json.JSONDecodeError) as exc:
        raise GeminiError(f"JSON parse failed even after repair: {exc}") from exc
