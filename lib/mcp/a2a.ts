import {ListTasksRequest, GetTaskRequest, SendMessageRequest, TaskState, type Message, type Task} from "@a2a-js/sdk";
import {ClientFactory, ClientFactoryOptions, DefaultAgentCardResolver, JsonRpcTransportFactory, type Client} from "@a2a-js/sdk/client";

// Cairn's A2A tools talk to Cairn through the official @a2a-js/sdk client: it discovers the Agent Card and then calls
// the JSON-RPC endpoint the card declares. Every request still goes through this one hardened fetch: fixed destinations,
// the Cairn token only on the endpoint, no redirects, a timeout and a size cap.
const ORIGIN = "https://cairncommons.dev";
const CARD = `${ORIGIN}/.well-known/agent-card.json`;
const ENDPOINT = `${ORIGIN}/api/a2a`;
const MAX_BYTES = 1024 * 1024;

export type A2AGatewayOptions = {fetcher?: () => ((request: Request) => Promise<Response>) | undefined; token: () => string | undefined};
export type TaskStatusFilter = "open" | "completed" | "failed";
const wireStatus: Record<TaskStatusFilter, string> = {open: "TASK_STATE_WORKING", completed: "TASK_STATE_COMPLETED", failed: "TASK_STATE_FAILED"};

export class A2ARejected extends Error {
  constructor(public code: string, public issues?: unknown) { super(code); }
}

export class A2AGateway {
  private client?: Promise<Client>;
  constructor(private options: A2AGatewayOptions) {}

  private fetchImpl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init);
    if (request.url !== ENDPOINT && request.url !== CARD) throw new Error("unsupported_destination");
    const headers = new Headers(request.headers);
    const token = this.options.token();
    if (token && request.url === ENDPOINT) headers.set("authorization", `Bearer ${token}`); else headers.delete("authorization");
    const outbound = new Request(request.url, {method: request.method, headers, body: request.method === "GET" ? undefined : await request.text(), redirect: "manual", signal: AbortSignal.timeout(20_000)});
    const response = await (this.options.fetcher?.() ?? fetch)(outbound);
    if (response.status >= 300 && response.status < 400) throw new Error("redirect_rejected");
    const reader = response.body?.getReader();
    let text = "", bytes = 0;
    const decoder = new TextDecoder();
    if (reader) while (true) {
      const {done, value} = await reader.read();
      if (done) break;
      bytes += value.length;
      if (bytes > MAX_BYTES) { await reader.cancel(); throw new Error("response_too_large"); }
      text += decoder.decode(value, {stream: true});
    }
    text += decoder.decode();
    return new Response(text, {status: response.status, headers: response.headers});
  };

  private connect(): Promise<Client> {
    this.client ??= new ClientFactory(ClientFactoryOptions.createFrom(ClientFactoryOptions.default, {
      transports: [new JsonRpcTransportFactory({fetchImpl: this.fetchImpl})],
      cardResolver: new DefaultAgentCardResolver({fetchImpl: this.fetchImpl}),
    })).createFromUrl(ORIGIN).catch(error => { this.client = undefined; throw error; });
    return this.client;
  }

  async listTasks(status: TaskStatusFilter, limit: number, pageToken?: string) {
    const page = await (await this.connect()).listTasks(ListTasksRequest.fromJSON({status: wireStatus[status], pageSize: limit, ...(pageToken ? {pageToken} : {})}));
    return {tasks: page.tasks.map(summarize), total_size: page.totalSize, next_page_token: page.nextPageToken || null};
  }
  async getTask(id: string) {
    return summarize(await (await this.connect()).getTask(GetTaskRequest.fromJSON({id})));
  }
  // Posts a task (no taskId) or contributes to one. A request Cairn declines comes back as an agent Message, not a Task.
  async send(data: unknown, taskId?: string) {
    const result = await (await this.connect()).sendMessage(SendMessageRequest.fromJSON({message: {messageId: crypto.randomUUID(), role: "ROLE_USER", ...(taskId ? {taskId} : {}), parts: [{mediaType: "application/json", data}]}}));
    if (!isTask(result)) {
      const error = (dataOf(result) as {error?: {code?: string; issues?: unknown}} | undefined)?.error;
      throw new A2ARejected(error?.code ?? "not_accepted", error?.issues);
    }
    return {...summarize(result), contribution: (cairn(result).contribution as Record<string, unknown> | undefined) ?? null};
  }
}

const isTask = (value: Task | Message): value is Task => "status" in value;
const cairn = (task: Task): Record<string, unknown> => ((task.metadata as {cairn?: Record<string, unknown>} | undefined)?.cairn) ?? {};
const dataOf = (message: Message) => (message.parts.find(part => part.content?.$case === "data")?.content as {value?: unknown} | undefined)?.value;

// A stable, flat view of an A2A Task for the model: the task's own fields live in metadata.cairn.
export function summarize(task: Task) {
  const meta = cairn(task);
  const evaluation = task.artifacts[0]?.parts[0] ? dataOf({parts: task.artifacts[0].parts} as Message) as {evaluation?: unknown; contributions?: unknown} | undefined : undefined;
  return {
    id: task.id, state: TaskState[task.status?.state ?? 0], goal: meta.goal, source_urls: meta.source_urls, acceptance_criteria: meta.acceptance_criteria,
    deadline: meta.deadline, min_independent: meta.min_independent, max_contributors: meta.max_contributors, contribution_count: meta.contribution_count, web_url: meta.web_url,
    ...(evaluation ? {evaluation: evaluation.evaluation, contributions: evaluation.contributions} : {}),
  };
}
