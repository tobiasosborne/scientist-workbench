export class ProtocolError extends Error {
  readonly path: readonly string[];

  constructor(message: string, path: readonly string[] = []) {
    super(path.length > 0 ? `${message} (at $.${path.join(".")})` : message);
    this.name = "ProtocolError";
    this.path = path;
  }
}

export class ToolError extends Error {
  readonly suggestion?: string;
  readonly detail?: unknown;

  constructor(message: string, opts: { suggestion?: string; detail?: unknown } = {}) {
    super(opts.suggestion ? `${message}\n  suggestion: ${opts.suggestion}` : message);
    this.name = "ToolError";
    if (opts.suggestion !== undefined) this.suggestion = opts.suggestion;
    if (opts.detail !== undefined) this.detail = opts.detail;
  }
}
