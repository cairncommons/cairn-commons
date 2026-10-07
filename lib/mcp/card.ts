import {createHash} from "node:crypto";
import {z} from "zod";

// A local Agent Card for an agent that participates in Cairn A2A tasks. It is generated on the agent's side, kept in
// the user's private storage and shown only when needed (for example if payments are enabled later). It contains no credential,
// and a wallet entry is a PUBLIC address only. Cairn does not host or vouch for it: it is a self-report.
const addressPattern = /^[A-Za-z0-9:_.-]{20,120}$/;
const walletSchema = z.object({
  network: z.string().trim().min(2).max(40).regex(/^[A-Za-z0-9:_.-]+$/),
  address: z.string().trim().regex(addressPattern,"Provide a public address only."),
}).strict().refine(w => !/^(0x)?[0-9a-fA-F]{64}$/.test(w.address),{message:"That looks like a private key. Never put one in a card."});
export const cardInputSchema = z.object({
  model_name: z.string().trim().min(1).max(80),
  model_version: z.string().trim().min(1).max(80).optional(),
  runtime: z.enum(["codex","claude_code","local","other"]),
  tools: z.array(z.string().trim().min(1).max(60)).max(20).default([]),
  categories: z.array(z.enum(["source_review"])).min(1).default(["source_review"]),
  description: z.string().trim().min(5).max(300).optional(),
  wallet: walletSchema.optional(),
}).strict();
export type CardInput = z.infer<typeof cardInputSchema>;

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value as Record<string,unknown>).filter(([,v]) => v !== undefined).sort(([a],[b]) => a < b ? -1 : 1).map(([k,v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
  return JSON.stringify(value);
}

export function buildAgentCard(input: CardInput, now = new Date()) {
  const data = cardInputSchema.parse(input);
  const card = {
    name: `${data.model_name}${data.model_version ? " " + data.model_version : ""} (${data.runtime})`,
    description: data.description ?? "A participant in Cairn A2A open source-review tasks. Self-reported; not proof of ability.",
    version: "1.0.0",
    // A local outbound participant has no inbound endpoint. Work reaches it by it fetching tasks from Cairn.
    supportedInterfaces: [] as unknown[],
    capabilities: {streaming: false, pushNotifications: false, extendedAgentCard: false},
    defaultInputModes: ["application/json"],
    defaultOutputModes: ["application/json"],
    skills: data.categories.map(category => ({id: category.replaceAll("_","-"), name: "Public source review", description: "Reads approved public sources and reports what they state, with conditions and limitations. Does not execute software.", tags: ["verification","source-review"]})),
    extensions: {cairn: {
      transport: "local_outbound",
      self_reported: true,
      declared: {runtime: data.runtime, tools: data.tools},
      ...(data.wallet ? {payout: {unit: "none_yet", wallet: data.wallet, note: "Public address only. Shown on request if payments are enabled later."}} : {}),
      generated_at: now.toISOString(),
    }},
  };
  return {card, digest: "sha256:" + createHash("sha256").update(canonical(card)).digest("hex")};
}
