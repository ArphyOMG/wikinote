import express from "express";
import cors from "cors";
import { z } from "zod";
import LRUCache from "lru-cache";
import OpenAI from "openai";
import dotenv from "dotenv";

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json({ limit: "2mb" }));

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

/**
 * MVP In-memory stores
 * - 실서비스에서는 RDB + (선택) VectorDB/BM25로 교체하세요.
 */
const db = {
  documents: new Map(), // doc_id -> doc
  chunks: new Map(), // chunk_id -> chunk
  claims: new Map(), // claim_id -> claim
  claimsByKey: new Map(), // client_claim_key -> claim_id
  relations: new Map(), // relation_id -> relation
  relationEvidence: new Map(), // relation_id -> evidence[]
};

let _id = 0;
const genId = (p) => `${p}_${(++_id).toString(36)}_${Date.now().toString(36)}`;

const suggestCache = new LRUCache({ max: 500, ttl: 1000 * 60 * 10 }); // 10분

function buildSectionChunks(doc) {
  const sections = ["cue", "notes", "summary"];
  const chunks = [];
  for (const section of sections) {
    const text = String(doc.contentBySection?.[section] ?? "").trim();
    if (!text) continue;
    chunks.push({
      chunk_id: genId("chk"),
      doc_id: doc.doc_id,
      doc_title: doc.title,
      notebook_id: doc.notebook_id ?? "default",
      section,
      text,
      pos_from: 0,
      pos_to: text.length,
      created_at: new Date().toISOString(),
    });
  }
  return chunks;
}

function naiveHybridSearch(seedText, scope, topK = 12) {
  const needle = String(seedText ?? "").toLowerCase();
  const terms = needle.split(/\s+/).filter(Boolean);

  const out = [];
  for (const chunk of db.chunks.values()) {
    if (scope?.notebook_id && chunk.notebook_id !== scope.notebook_id) continue;
    if (scope?.doc_ids?.length && !scope.doc_ids.includes(chunk.doc_id)) continue;
    if (scope?.include_sections?.length && !scope.include_sections.includes(chunk.section)) continue;

    const hay = chunk.text.toLowerCase();
    let hits = 0;
    for (const t of terms) if (hay.includes(t)) hits += 1;

    // 아주 단순한 score: term hit - length penalty
    const score = hits - Math.max(0, hay.length / 5000);
    if (score > 0) {
      out.push({
        chunk_id: chunk.chunk_id,
        doc_id: chunk.doc_id,
        doc_title: chunk.doc_title,
        section: chunk.section,
        snippet: chunk.text.slice(0, 260),
        pos_from: chunk.pos_from,
        pos_to: chunk.pos_to,
        score: Number(score.toFixed(3)),
      });
    }
  }
  out.sort((a, b) => b.score - a.score);
  return out.slice(0, topK);
}

// ---------------------------------------------------------------------
// API: Documents upsert (인덱싱)
// ---------------------------------------------------------------------
app.post("/api/v1/documents:upsert", (req, res) => {
  const schema = z.object({
    doc_id: z.string().min(1),
    title: z.string().min(1),
    notebook_id: z.string().optional(),
    tags: z.array(z.string()).optional(),
    contentBySection: z.object({
      cue: z.string().optional(),
      notes: z.string().optional(),
      summary: z.string().optional(),
    }),
  });

  const body = schema.parse(req.body);
  const doc = {
    ...body,
    notebook_id: body.notebook_id ?? "default",
    tags: body.tags ?? [],
    updated_at: new Date().toISOString(),
  };
  db.documents.set(body.doc_id, doc);

  // 기존 chunks 제거 후 재생성
  for (const [chunkId, chunk] of db.chunks.entries()) {
    if (chunk.doc_id === body.doc_id) db.chunks.delete(chunkId);
  }
  const chunks = buildSectionChunks(doc);
  for (const c of chunks) db.chunks.set(c.chunk_id, c);

  res.json({ ok: true, chunks_created: chunks.length });
});

// ---------------------------------------------------------------------
// API: Claim upsert
// ---------------------------------------------------------------------
app.post("/api/v1/claims:upsert", (req, res) => {
  const schema = z.object({
    doc_id: z.string(),
    section: z.enum(["cue", "notes", "summary"]),
    pos_from: z.number().int().nonnegative(),
    pos_to: z.number().int().nonnegative(),
    sentence_text: z.string().min(3).max(1000),
    client_claim_key: z.string().min(5),
  });
  const body = schema.parse(req.body);

  if (!db.documents.has(body.doc_id)) {
    return res.status(404).json({ error: { code: "DOC_NOT_INDEXED", message: "Document not indexed yet" } });
  }
  if (body.pos_to <= body.pos_from) {
    return res.status(400).json({ error: { code: "INVALID_RANGE", message: "pos_to must be > pos_from" } });
  }

  const existingId = db.claimsByKey.get(body.client_claim_key);
  if (existingId) return res.json({ claim: db.claims.get(existingId), upserted: false });

  const claim = {
    claim_id: genId("clm"),
    doc_id: body.doc_id,
    section: body.section,
    sentence_text: body.sentence_text.trim(),
    pos_from: body.pos_from,
    pos_to: body.pos_to,
    created_by: "user_demo",
    created_at: new Date().toISOString(),
  };
  db.claims.set(claim.claim_id, claim);
  db.claimsByKey.set(body.client_claim_key, claim.claim_id);

  res.json({ claim, upserted: true });
});

// ---------------------------------------------------------------------
// API: Evidence search (MVP hybrid placeholder)
// ---------------------------------------------------------------------
app.post("/api/v1/evidence:search", (req, res) => {
  const schema = z.object({
    seed: z.object({
      type: z.enum(["claim", "text"]),
      claim_id: z.string().optional(),
      text: z.string().optional(),
    }),
    scope: z
      .object({
        notebook_id: z.string().optional(),
        doc_ids: z.array(z.string()).optional(),
        include_sections: z.array(z.enum(["cue", "notes", "summary"])).optional(),
      })
      .optional(),
    top_k: z.number().int().min(1).max(50).default(12),
    strategy: z.enum(["hybrid"]).default("hybrid"),
  });

  const body = schema.parse(req.body);

  let seedText = body.seed.text ?? "";
  if (body.seed.type === "claim") {
    const claim = db.claims.get(body.seed.claim_id);
    if (!claim) return res.status(404).json({ error: { code: "NOT_FOUND", message: "Claim not found" } });
    seedText = claim.sentence_text;
  }

  const results = naiveHybridSearch(seedText, body.scope, body.top_k);
  res.json({ evidence_candidates: results });
});

// ---------------------------------------------------------------------
// API: Relations suggest (LLM)
// ---------------------------------------------------------------------
app.post("/api/v1/relations:suggest", async (req, res) => {
  const schema = z.object({
    from_claim_id: z.string(),
    evidence: z.object({
      include_chunk_ids: z.array(z.string()).min(1).max(20),
      exclude_chunk_ids: z.array(z.string()).optional(),
    }),
    options: z
      .object({
        max_suggestions: z.number().int().min(1).max(10).default(5),
        relation_types: z
          .array(z.enum(["supports", "contradicts", "elaborates", "example", "causal", "prerequisite"]))
          .default(["supports", "contradicts", "elaborates", "example", "causal", "prerequisite"]),
        must_include_evidence: z.boolean().default(true),
        tone: z.enum(["concise"]).default("concise"),
      })
      .optional(),
  });

  const body = schema.parse(req.body);
  const claim = db.claims.get(body.from_claim_id);
  if (!claim) return res.status(404).json({ error: { code: "NOT_FOUND", message: "From-claim not found" } });

  const cacheKey = JSON.stringify({
    from: body.from_claim_id,
    include: body.evidence.include_chunk_ids,
    exclude: body.evidence.exclude_chunk_ids ?? [],
    opt: body.options ?? {},
    pv: "v1",
    mv: process.env.OPENAI_MODEL || "gpt-5-mini",
  });

  const cached = suggestCache.get(cacheKey);
  if (cached) return res.json(cached);

  const includeChunks = body.evidence.include_chunk_ids.map((id) => db.chunks.get(id)).filter(Boolean);
  if (includeChunks.length === 0) {
    return res.status(400).json({ error: { code: "INVALID_EVIDENCE", message: "No valid chunks found" } });
  }

  // 비용을 위해 청크 길이 제한
  const evidencePack = includeChunks.map((c) => ({
    chunk_id: c.chunk_id,
    doc_id: c.doc_id,
    doc_title: c.doc_title,
    section: c.section,
    text: c.text.slice(0, 800),
  }));

  const allowedTypes = body.options?.relation_types ?? [
    "supports",
    "contradicts",
    "elaborates",
    "example",
    "causal",
    "prerequisite",
  ];

  const system = [
    "You propose relationships between a selected sentence (claim) and other sentences in the user's notes.",
    "You MUST ONLY use the provided evidence chunks. Do not invent facts.",
    "Each suggestion MUST include at least one evidence quote taken verbatim from a provided chunk.",
    "Return JSON only. No markdown.",
  ].join("\n");

  const promptPayload = {
    selected_claim: {
      claim_id: claim.claim_id,
      doc_id: claim.doc_id,
      section: claim.section,
      sentence_text: claim.sentence_text,
    },
    constraints: {
      allowed_relation_types: allowedTypes,
      max_suggestions: body.options?.max_suggestions ?? 5,
      one_liner_only: true,
      to_claim_one_sentence_only: true,
    },
    evidence_chunks: evidencePack,
    output_schema: {
      suggestions: [
        {
          type: "supports|contradicts|elaborates|example|causal|prerequisite",
          explanation_one_liner: "string (one sentence)",
          to_claim_draft: { doc_id: "string", section: "cue|notes|summary", sentence_text: "one sentence" },
          evidence: [{ chunk_id: "string", quote: "verbatim quote from that chunk" }],
          confidence: "high|medium|low",
        },
      ],
    },
    notes: [
      "to_claim_draft.sentence_text must be an exact sentence found in evidence text (not invented).",
      "If not enough candidates exist, return fewer suggestions.",
    ],
  };

  try {
    const model = process.env.OPENAI_MODEL || "gpt-5-mini";
    const resp = await openai.responses.create({
      model,
      input: [
        { role: "system", content: system },
        { role: "user", content: JSON.stringify(promptPayload) },
      ],
    });

    const raw = (resp.output_text || "").trim();
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return res.status(502).json({
        error: { code: "LLM_BAD_JSON", message: "Model did not return valid JSON", raw: raw.slice(0, 800) },
      });
    }

    const SuggestSchema = z.object({
      suggestions: z
        .array(
          z.object({
            type: z.enum(["supports", "contradicts", "elaborates", "example", "causal", "prerequisite"]),
            explanation_one_liner: z.string().min(3).max(300),
            to_claim_draft: z.object({
              doc_id: z.string(),
              section: z.enum(["cue", "notes", "summary"]),
              sentence_text: z.string().min(3).max(500),
              pos_from: z.number().int().nullable().optional(),
              pos_to: z.number().int().nullable().optional(),
            }),
            evidence: z.array(z.object({ chunk_id: z.string(), quote: z.string().min(3) })).min(1),
            confidence: z.enum(["high", "medium", "low"]),
          })
        )
        .max(10),
    });

    const safe = SuggestSchema.parse(parsed);

    const payload = {
      from_claim: { claim_id: claim.claim_id, sentence_text: claim.sentence_text },
      suggestions: safe.suggestions.map((s) => ({ suggestion_id: genId("sug"), ...s })),
    };

    suggestCache.set(cacheKey, payload);
    res.json(payload);
  } catch (e) {
    console.error(e);
    res.status(502).json({ error: { code: "LLM_ERROR", message: "LLM call failed" } });
  }
});

// ---------------------------------------------------------------------
// API: Relations approve (to-claim upsert + relation create)
// ---------------------------------------------------------------------
app.post("/api/v1/relations:approve", (req, res) => {
  const schema = z.object({
    from_claim_id: z.string(),
    to_claim: z.object({
      doc_id: z.string(),
      section: z.enum(["cue", "notes", "summary"]),
      pos_from: z.number().int().nullable().optional(),
      pos_to: z.number().int().nullable().optional(),
      sentence_text: z.string().min(3),
      client_claim_key: z.string().min(5),
    }),
    relation: z.object({
      type: z.enum(["supports", "contradicts", "elaborates", "example", "causal", "prerequisite"]),
      explanation: z.string().min(3).max(1000),
      confidence: z.enum(["high", "medium", "low"]).default("medium"),
    }),
    evidence: z
      .array(
        z.object({
          chunk_id: z.string(),
          quote: z.string().min(3),
          pos_from: z.number().int().nullable().optional(),
          pos_to: z.number().int().nullable().optional(),
        })
      )
      .min(1),
  });

  const body = schema.parse(req.body);

  const fromClaim = db.claims.get(body.from_claim_id);
  if (!fromClaim) return res.status(404).json({ error: { code: "NOT_FOUND", message: "From-claim not found" } });
  if (!db.documents.has(body.to_claim.doc_id)) {
    return res.status(404).json({ error: { code: "DOC_NOT_INDEXED", message: "To-document not indexed yet" } });
  }

  // Upsert to-claim
  let toClaimId = db.claimsByKey.get(body.to_claim.client_claim_key);
  if (!toClaimId) {
    const newClaim = {
      claim_id: genId("clm"),
      doc_id: body.to_claim.doc_id,
      section: body.to_claim.section,
      sentence_text: body.to_claim.sentence_text.trim(),
      pos_from: body.to_claim.pos_from ?? 0,
      pos_to: body.to_claim.pos_to ?? body.to_claim.sentence_text.length,
      created_by: "user_demo",
      created_at: new Date().toISOString(),
    };
    db.claims.set(newClaim.claim_id, newClaim);
    db.claimsByKey.set(body.to_claim.client_claim_key, newClaim.claim_id);
    toClaimId = newClaim.claim_id;
  }

  // De-duplicate relation
  for (const r of db.relations.values()) {
    if (r.from_claim_id === body.from_claim_id && r.to_claim_id === toClaimId && r.type === body.relation.type) {
      return res.status(409).json({ error: { code: "DUPLICATE_RELATION", message: "Relation already exists" } });
    }
  }

  const relation = {
    relation_id: genId("rel"),
    from_claim_id: body.from_claim_id,
    to_claim_id: toClaimId,
    type: body.relation.type,
    explanation: body.relation.explanation,
    confidence: body.relation.confidence,
    status: "approved",
    created_by: "user_demo",
    created_at: new Date().toISOString(),
  };

  db.relations.set(relation.relation_id, relation);
  db.relationEvidence.set(
    relation.relation_id,
    body.evidence.map((e) => ({
      chunk_id: e.chunk_id,
      quote: e.quote,
      pos_from: e.pos_from ?? null,
      pos_to: e.pos_to ?? null,
    }))
  );

  res.json({
    to_claim: db.claims.get(toClaimId),
    relation,
    evidence_saved: body.evidence.length,
  });
});

// ---------------------------------------------------------------------
app.get("/api/health", (_, res) => res.json({ ok: true }));

const port = Number(process.env.PORT || 4000);
app.listen(port, () => {
  console.log(`LLM API listening on http://localhost:${port}`);
});
