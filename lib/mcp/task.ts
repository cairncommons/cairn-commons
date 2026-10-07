import {createHash, randomUUID} from "node:crypto";
import {z} from "zod";
import {canonical} from "../a2a/canonical.js";

// Local drafting of an open A2A source-review task. Pure: nothing is sent to Cairn until the user has seen the exact
// public request and approved its digest. The server re-validates everything; this only catches mistakes early.
// Keep the host list in step with sourceHosts in lib/a2a/contracts.ts.
const sourceHosts = ["github.com","raw.githubusercontent.com","registry.npmjs.org","docs.python.org","nodejs.org","developers.cloudflare.com","a2a-protocol.org"];
const sourceUrl = z.string().url().max(1500).refine(raw => {
  try { const u = new URL(raw); return u.protocol === "https:" && !u.username && !u.password && (!u.port || u.port === "443") && sourceHosts.includes(u.hostname) && !u.search && !u.hash; } catch { return false; }
},"Only approved public HTTPS sources without query strings or fragments are supported: " + sourceHosts.join(", "));
const criteria = z.array(z.string().trim().min(5).max(300)).min(1).max(5);
export const taskDraftSchema = z.object({
  goal: z.string().trim().min(12).max(1200).describe("What you want done: one public, checkable question about the approved sources."),
  source_urls: z.array(sourceUrl).min(1).max(5),
  acceptance_criteria: criteria.describe("What counts as a finished review."),
  duration_hours: z.number().int().min(1).max(168).describe("How long the task stays open (period). 1 to 168 hours."),
  min_independent: z.number().int().min(2).max(5).default(2),
  max_contributors: z.number().int().min(2).max(10).default(5),
  bounty_usd: z.number().min(0).max(10000).default(0).describe("Declared reward in US dollars. Beta: shown on the task, not paid. At 10 or less the results become public data; above 10 they stay hidden unless you decline to pay or do not answer within 72 hours after evaluation."),
}).strict().refine(t => t.max_contributors >= t.min_independent,{message:"max_contributors must be at least min_independent"});
export type TaskDraft = z.infer<typeof taskDraftSchema>;
export const taskRequestSchema = z.object({
  schema: z.literal("cairn.open_task/0.1"),
  operation_id: z.string().uuid(),
  task_type: z.literal("source_review"),
  goal: z.string().trim().min(12).max(1200),
  source_urls: z.array(sourceUrl).min(1).max(5),
  acceptance_criteria: criteria,
  deadline_at: z.string().datetime(),
  min_independent: z.number().int().min(2).max(5),
  max_contributors: z.number().int().min(2).max(10),
  budget: z.object({currency:z.literal("USD"),max_total_minor:z.literal(0)}).strict(),
  bounty: z.object({currency:z.literal("USD"),amount_minor:z.number().int().min(0).max(1_000_000)}).strict().optional(),
  // Legacy fields: part of the approved digest the server recomputes, so they stay in the request.
  reward_points: z.literal(0),
  min_share_percent: z.number().int().min(10).max(100),
  publication_plan: z.literal("a2a_thread"),
}).strict();
export type TaskRequest = z.infer<typeof taskRequestSchema>;
export const taskDigest = (request: TaskRequest) => "sha256:" + createHash("sha256").update(canonical(request)).digest("hex");

export function buildTaskRequest(input: TaskDraft, now = new Date(), operationId: string = randomUUID()) {
  const draft = taskDraftSchema.parse(input);
  const request = taskRequestSchema.parse({
    schema: "cairn.open_task/0.1", operation_id: operationId, task_type: "source_review",
    goal: draft.goal, source_urls: draft.source_urls, acceptance_criteria: draft.acceptance_criteria,
    deadline_at: new Date(now.getTime() + draft.duration_hours * 3600_000).toISOString(),
    min_independent: draft.min_independent, max_contributors: draft.max_contributors,
    budget: {currency: "USD", max_total_minor: 0}, reward_points: 0, min_share_percent: 10, publication_plan: "a2a_thread",
    // Left out when zero, so a request without a bounty keeps the digest it always had.
    ...(draft.bounty_usd > 0 ? {bounty: {currency: "USD", amount_minor: Math.round(draft.bounty_usd * 100)}} : {}),
  });
  return {request, public_input_digest: taskDigest(request)};
}
