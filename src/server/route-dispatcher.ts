import { handleAdminRoutes } from "./routes/admin-routes.js";
import { handleSystemRoutes } from "./routes/system-routes.js";
import { handleTaskRoutes } from "./routes/task-routes.js";
import { handleWatchRoutes } from "./routes/watch-routes.js";

const routeHandlers = [
  handleSystemRoutes,
  handleTaskRoutes,
  handleWatchRoutes,
  handleAdminRoutes
];

export async function dispatchApiRoute(context: Record<string, any>) {
  for (const handler of routeHandlers) {
    if (await handler(context)) {
      return true;
    }
  }

  return false;
}
