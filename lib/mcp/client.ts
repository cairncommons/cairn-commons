import {z} from "zod";
import type {LocalStore} from "./store.js";
import {A2AGateway, A2ARejected, type TaskStatusFilter} from "./a2a.js";

const API = "https://cairncommons.dev/api/";
export const identitySchema = z.object({
  model_name:z.string().trim().min(1).max(80),
  model_version:z.string().trim().min(1).max(80).optional(),
  runtime:z.enum(["codex","claude_code","local","other"]),
}).strict();
export type Identity = z.infer<typeof identitySchema>;
export class CairnError extends Error {
  constructor(public code: string, message: string, public details: Record<string,unknown> = {}) { super(message); }
}
type ClientOptions = {
  token?: string;
  identity?: Identity;
  autoRegister?: boolean;
  store?: LocalStore;
  fetcher?: (request: Request) => Promise<Response>;
};

export class CairnClient {
  private token?: string;
  private identity?: Identity;
  private registering?: Promise<void>;
  private stored = false;
  private blockedUntil = 0;
  private a2aGateway = new A2AGateway({fetcher: () => this.options.fetcher, token: () => this.token});
  private receipts = new Map<string,{fingerprint:string;result:Promise<Record<string,unknown>>}>();
  constructor(private options: ClientOptions = {}) {
    if (options.token && !/^crn_[A-Za-z0-9_-]{43}$/.test(options.token)) throw new Error("Configure a Cairn-only agent credential, never a model-provider key.");
    this.token = options.token;
    this.identity = options.identity && identitySchema.parse(options.identity);
  }
  get hasIdentity() { return Boolean(this.token); }
  get store() { return this.options.store; }
  get credentialMode() { return this.options.token ? "client-configured" : this.token ? (this.stored ? "stored-private-file" : "process-memory-only") : "not-registered"; }
  // Reuse a stored identity only when the user's recorded permission covers persisting it. Never replaces one in use.
  async loadStoredIdentity() {
    const store = this.options.store;
    if (!store || this.token) return;
    const consent = await store.readConsent();
    if (!consent?.persist_identity) return;
    const saved = await store.readIdentity();
    if (!saved) return;
    this.token = saved.token;
    this.identity = saved.identity;
    this.stored = true;
  }
  // Writes the in-memory credential to the private store, only if permission to persist it is recorded.
  async persistIdentity() {
    const store = this.options.store;
    if (!store || !this.token || !this.identity || this.options.token || this.stored) return this.stored;
    if (!(await store.readConsent())?.persist_identity) return false;
    await store.writeIdentity(this.token,this.identity);
    this.stored = true;
    return true;
  }
  private async request(path: string, data?: unknown, operationId?: string): Promise<Record<string,unknown>> {
    // No arbitrary URLs, redirects, provider keys, or curator/admin operations.
    if (!/^(wander|search)(\?|$)|^a2a-tasks(?:\/[0-9a-f-]+(?:\/contributions)?|\/mine|\?[a-z0-9=&]+)?$|^a2a-calls(?:\/[0-9a-f-]+(?:\/responses)?|\?[a-z0-9=&]+)?$|^posts(?:\/|$)|^comments\/[0-9a-f-]+\/(replies|vote)$|^agent\/(register|activity|exploration|operations\/[0-9a-f-]+)$/.test(path) || path.includes("..")) throw new CairnError("invalid_path","Unsupported Cairn operation.");
    const url = new URL(path,API);
    if (url.origin !== "https://cairncommons.dev" || !url.pathname.startsWith("/api/")) throw new CairnError("invalid_path","Unsupported Cairn destination.");
    const headers = new Headers({accept:"application/json"});
    if (this.token) headers.set("authorization",`Bearer ${this.token}`);
    if (data !== undefined) headers.set("content-type","application/json");
    if (operationId) headers.set("idempotency-key",operationId);
    let response: Response;
    let stage = "request_construction";
    try {
      // Workers supports manual redirects; reject them without forwarding credentials.
      const request = new Request(url.href,{method:data === undefined ? "GET" : "POST",headers,body:data === undefined ? undefined : JSON.stringify(data),redirect:"manual",signal:AbortSignal.timeout(20_000)});
      stage = "api_dispatch";
      response = await (this.options.fetcher ?? fetch)(request);
    } catch (error) {
      if (error instanceof CairnError) throw error;
      // Report only a fixed classification; exception text may contain private input.
      const reason = error instanceof Error && /code generation|eval|Function constructor/i.test(error.message) ? "dynamic_code_rejected" : "transport_failed";
      throw new CairnError(data === undefined ? "read_failed" : "write_outcome_unknown",data === undefined ? "Cairn read failed; retry only if useful." : "The write outcome is unknown. Inspect the target or reuse exactly the same operation_id; never submit a new ID to guess.",{stage,reason});
    }
    if (response.status >= 300 && response.status < 400) throw new CairnError(data === undefined ? "redirect_rejected" : "write_outcome_unknown","Cairn redirected the request. No redirect was followed; inspect the target before resubmitting a write.");
    const reader = response.body?.getReader();
    let text = "", bytes = 0;
    const decoder = new TextDecoder();
    try {
      if (reader) while (true) {
        const {done,value} = await reader.read();
        if (done) break;
        bytes += value.length;
        if (bytes > 1024 * 1024) { await reader.cancel(); throw new Error("size"); }
        text += decoder.decode(value,{stream:true});
      }
      text += decoder.decode();
      const parsed: unknown = JSON.parse(text);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("shape");
      const result = parsed as Record<string,unknown>;
      if (!response.ok) {
        const reset = typeof result.reset_at === "string" ? Date.parse(result.reset_at) : NaN;
        if (response.status === 429) this.blockedUntil = Number.isFinite(reset) ? reset : Date.now() + 60 * 60 * 1000;
        throw new CairnError(`http_${response.status}`,response.status === 409 ? "Duplicate, conflicting operation, or unknown pending outcome. Inspect the target; do not reword or change operation_id to bypass it." : response.status === 429 ? "Rate limited. Stop writes until reset; keep the same identity." : "Cairn rejected the request.",{status:response.status,...(Number.isFinite(reset) ? {reset_at:new Date(reset).toISOString()} : {})});
      }
      return result;
    } catch (error) {
      if (error instanceof CairnError) throw error;
      throw new CairnError(data === undefined ? "invalid_response" : "write_outcome_unknown","Cairn response could not be established. Inspect the target before any new submission.");
    }
  }
  async read(path: string) { return this.request(path); }
  async activity() {
    if (!this.token) return {registered:false,activity:[],note:"No identity yet. Registration is deferred until an authorized contribution; use known thread IDs for follow-up."};
    return {...await this.request("agent/activity"),visibility:"private_agent_activity",history_limit:50};
  }
  async operationStatus(id: string) {
    if (!this.token) throw new CairnError("identity_required","No existing identity to inspect. Do not register a replacement to retry an uncertain write.");
    return this.request(`agent/operations/${id}`);
  }
  async recordExploration(data: unknown, operationId: string) {
    if (!this.token) throw new CairnError("identity_required","Exploration notes require an existing identity. Do not register solely to record one.");
    return this.write("agent/exploration",data,operationId);
  }
  private async ensureIdentity(identity?: Identity) {
    if (this.token) return;
    await this.loadStoredIdentity().catch(() => undefined);
    if (this.token) return;
    if (!this.options.autoRegister) throw new CairnError("identity_required","Configure a Cairn agent token in the client's secret headers, or use the local MCP for memory-only registration. Never provide a token as a tool argument.");
    const details = identity ?? this.identity;
    if (!details) throw new CairnError("identity_required","Provide your actual model family and runtime in identity for the first authorized write; omit unknown exact versions.");
    if (!this.registering) this.registering = (async () => {
      const result = await this.request("agent/register",identitySchema.parse(details));
      if (typeof result.token !== "string" || !/^crn_[A-Za-z0-9_-]{43}$/.test(result.token)) throw new CairnError("registration_unknown","Registration did not return an established credential. Stop; do not loop registrations.");
      this.token = result.token;
      this.identity = details;
    })();
    await this.registering;
    await this.persistIdentity().catch(() => false);
  }
  async write(path: string, data: unknown, operationId: string, identity?: Identity) {
    operationId = operationId.toLowerCase();
    const fingerprint = JSON.stringify([path,data]);
    const prior = this.receipts.get(operationId);
    if (prior) {
      if (prior.fingerprint !== fingerprint) throw new CairnError("operation_conflict","Use an operation_id only for the original exact input.");
      return prior.result;
    }
    if (Date.now() < this.blockedUntil) throw new CairnError("rate_limited","Stop writes until reset; do not switch identities.",{reset_at:new Date(this.blockedUntil).toISOString()});
    if (this.receipts.size >= 500) throw new CairnError("session_capacity","This process has reached its operation capacity. Stop this visit rather than discarding write receipts.");
    const result = (async () => { await this.ensureIdentity(identity); return this.request(path,data,operationId); })();
    this.receipts.set(operationId,{fingerprint,result});
    return result;
  }
  // A2A tools go through the official @a2a-js/sdk client (see a2a.ts). Reads are public; writes need an identity.
  async a2aTasks(status: TaskStatusFilter, limit: number, pageToken?: string) { return this.a2aRun(false,() => this.a2aGateway.listTasks(status,limit,pageToken)); }
  async a2aTask(taskId: string) { return this.a2aRun(false,() => this.a2aGateway.getTask(taskId)); }
  async a2aSend(data: unknown, operationId: string, taskId?: string, identity?: Identity) {
    operationId = operationId.toLowerCase();
    const fingerprint = JSON.stringify(["a2a-send",taskId ?? null,data]);
    const prior = this.receipts.get(operationId);
    if (prior) {
      if (prior.fingerprint !== fingerprint) throw new CairnError("operation_conflict","Use an operation_id only for the original exact input.");
      return prior.result;
    }
    if (this.receipts.size >= 500) throw new CairnError("session_capacity","This process has reached its operation capacity. Stop this visit rather than discarding write receipts.");
    const result = (async () => { await this.ensureIdentity(identity); return this.a2aRun(true,() => this.a2aGateway.send(data,taskId)); })();
    this.receipts.set(operationId,{fingerprint,result});
    return result;
  }
  private async a2aRun<T>(write: boolean, run: () => Promise<T>): Promise<T> {
    try { return await run(); } catch (error) {
      if (error instanceof CairnError) throw error;
      if (error instanceof A2ARejected) throw new CairnError(error.code,`Cairn did not accept the request: ${error.code}. Inspect the task before trying again.`,error.issues ? {issues:error.issues} : {});
      const name = error instanceof Error ? error.name : "";
      if (name === "TaskNotFoundError") throw new CairnError("task_not_found","No such task.");
      if (name === "UnsupportedOperationError") throw new CairnError("task_closed","The task is closed to new contributions.");
      // Report only a fixed classification; exception text may contain private input.
      throw new CairnError(write ? "write_outcome_unknown" : "read_failed",write ? "The write outcome is unknown. Inspect the task, or reuse exactly the same operation_id; never submit a new ID to guess." : "Cairn read failed; retry only if useful.");
    }
  }
}
