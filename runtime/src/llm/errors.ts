// The closed set of errors of the LLM client. No message carries request text, a header or the key: the hash, the role and
// the model id are the most a message or a property holds.

/** Replay found no recording for the request. The message is exactly `NoRecording: <requestHash>`. */
export class NoRecording extends Error {
  constructor(
    readonly hash: string,
    readonly role: string,
    readonly model: string,
  ) {
    super(`NoRecording: ${hash}`);
    this.name = 'NoRecording';
  }
}

/** A recording that is unreadable, hand edited, renamed, or whose hashes or labels do not recompute. */
export class BadRecording extends Error {
  constructor(readonly hash: string) {
    super(`BadRecording: ${hash}`);
    this.name = 'BadRecording';
  }
}

/** The model is not on the allowlist of the role. Raised before any file or network access. */
export class ModelNotAllowed extends Error {
  constructor(role: string, model: string) {
    super(`ModelNotAllowed: ${role} may not use ${model.slice(0, 80)}`);
    this.name = 'ModelNotAllowed';
  }
}

/** A network call was about to be made and NEARAI_API_KEY is missing or empty. */
export class MissingKey extends Error {
  constructor() {
    super('MissingKey: NEARAI_API_KEY is not set');
    this.name = 'MissingKey';
  }
}

/** The provider answered with a failure status (0 for a timeout or a connection error) after the retries. */
export class LlmHttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'LlmHttpError';
  }
}

/** A 2xx body that does not hold a chat completion with integer token counts. */
export class LlmBadResponse extends Error {
  constructor(reason: string) {
    super(`LlmBadResponse: ${reason}`);
    this.name = 'LlmBadResponse';
  }
}

/** LLM_MODE is set to something other than live, record or replay. */
export class BadMode extends Error {
  constructor() {
    super('BadMode: LLM_MODE must be live, record or replay');
    this.name = 'BadMode';
  }
}

/** costOf was asked for a model without a price. */
export class UnknownPrice extends Error {
  constructor(model: string) {
    super(`UnknownPrice: no price for ${model.slice(0, 80)}`);
    this.name = 'UnknownPrice';
  }
}
