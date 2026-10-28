export type Role = 'planner' | 'quarantine' | 'vanilla';

export interface LlmParams {
  temperature?: number;
  seed?: number;
  max_tokens?: number;
  reasoning?: 'low';
}

export interface LlmOpts {
  role: Role;
  /** the requested model id: the allowlist is checked against it and it is the id sent on the wire */
  model: string;
  system: string;
  user: string;
  jsonSchema?: object;
  params?: LlmParams;
}

export interface LlmResult {
  text: string;
  /** the provider's response id, only for a route that is an attested TEE route */
  chatId?: string;
  /** the requested id; the provider's own echo stays in `raw` */
  model: string;
  /** the service that produced the text: `nearai` for this client's own calls */
  route: string;
  /** the id that route served */
  sourceModel: string;
  /** true for every route that is not an attested TEE route: the text is a stand-in, never attested output */
  isStandIn: boolean;
  requestHash: string;
  /** sha256 of the exact response body text */
  responseHash: string;
  usage: { prompt: number; completion: number };
  finishReason: string | null;
  raw: unknown;
  recordedAt: string;
  latencyMs: number;
}

export type Complete = (o: LlmOpts) => Promise<LlmResult>;
