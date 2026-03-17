export class PlanningError extends Error {
  details: Record<string, unknown>;
  constructor(message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = "PlanningError";
    this.details = details;
  }
}

export class GroundingError extends Error {
  details: Record<string, unknown>;
  constructor(message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = "GroundingError";
    this.details = details;
  }
}

export class PolicyError extends Error {
  details: Record<string, unknown>;
  constructor(message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = "PolicyError";
    this.details = details;
  }
}

export class VerificationError extends Error {
  details: Record<string, unknown>;
  constructor(message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = "VerificationError";
    this.details = details;
  }
}

export class RecoverableError extends Error {
  details: Record<string, unknown>;
  constructor(message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = "RecoverableError";
    this.details = details;
  }
}

export class TakeoverRequiredError extends Error {
  details: Record<string, unknown>;
  constructor(message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = "TakeoverRequiredError";
    this.details = details;
  }
}

export class ExecutionStoppedError extends Error {
  details: Record<string, unknown>;
  constructor(message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = "ExecutionStoppedError";
    this.details = details;
  }
}
