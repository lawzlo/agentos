import type { IncomingMessage, ServerResponse } from "node:http";

import type { AgentOsConfig } from "../config.js";
import type { ControlPlane } from "../runtime/control-plane.js";

export interface ApiRouteContext {
  req: IncomingMessage;
  res: ServerResponse<IncomingMessage>;
  url: URL;
  controlPlane: ControlPlane;
  config: AgentOsConfig;
  activePort: number;
  startedAt: string;
}

export type ApiRouteHandler = (context: ApiRouteContext) => Promise<boolean>;
