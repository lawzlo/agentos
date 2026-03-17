import {
  daemonInstall,
  daemonLogs,
  daemonRestart,
  daemonStart,
  daemonStatus,
  daemonStop,
  daemonUninstall
} from "../cli-utils.js";

export async function handleDaemonCommand(subcommand: string | undefined, options: Record<string, any>) {
  if (subcommand === "start") {
    await daemonStart(options);
    return true;
  }
  if (subcommand === "stop") {
    await daemonStop(options);
    return true;
  }
  if (subcommand === "status") {
    await daemonStatus(options);
    return true;
  }
  if (subcommand === "logs") {
    await daemonLogs(options);
    return true;
  }
  if (subcommand === "restart") {
    await daemonRestart(options);
    return true;
  }
  if (subcommand === "install") {
    await daemonInstall(options);
    return true;
  }
  if (subcommand === "uninstall") {
    await daemonUninstall(options);
    return true;
  }

  return false;
}
