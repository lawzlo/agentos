import { handleAdminRoutes } from "./routes/admin-routes.js";
import { handleSystemRoutes } from "./routes/system-routes.js";
import { handleTaskRoutes } from "./routes/task-routes.js";
import { handleWatchRoutes } from "./routes/watch-routes.js";
import type { ApiRouteContext, ApiRouteHandler } from "./types.js";

const routeHandlers: ApiRouteHandler[] = [
  handleSystemRoutes,
  handleTaskRoutes,
  handleWatchRoutes,
  handleAdminRoutes
];

export async function dispatchApiRoute(context: ApiRouteContext): Promise<boolean> {
  for (const handler of routeHandlers) {
    if (await handler(context)) {
      return true;
    }
  }

  return false;
}
