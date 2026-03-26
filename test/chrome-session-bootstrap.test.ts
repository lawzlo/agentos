import test from "node:test";
import assert from "node:assert/strict";

import { ensureAttachableChromeSession } from "../src/runtime/chrome-session-bootstrap.js";

test("ensureAttachableChromeSession reuses an existing local CDP endpoint without relaunching Chrome", async () => {
  let spawnCalls = 0;
  let execCalls = 0;

  const session = await ensureAttachableChromeSession(
    {
      browserExecutable: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      browserCdpUrl: null
    },
    {
      fetchImpl: async () => ({
        ok: true,
        async json() {
          return {
            webSocketDebuggerUrl: "ws://127.0.0.1:9222/devtools/browser/existing"
          };
        }
      }) as Response,
      spawnImpl: () => {
        spawnCalls += 1;
        return { unref() {} } as never;
      },
      execFileImpl: async () => {
        execCalls += 1;
      },
      waitImpl: async () => {}
    }
  );

  assert.equal(session.bootstrapped, false);
  assert.equal(session.cdpBaseUrl, "http://127.0.0.1:9222");
  assert.equal(session.cdpUrl, "ws://127.0.0.1:9222/devtools/browser/existing");
  assert.equal(spawnCalls, 0);
  assert.equal(execCalls, 0);
});

test("ensureAttachableChromeSession bootstraps a local Chrome session when the CDP endpoint is unavailable", async () => {
  let launched = false;
  let execArgs: { file: string; args: readonly string[] } | null = null;
  let spawnArgs: { command: string; args: readonly string[] } | null = null;

  const session = await ensureAttachableChromeSession(
    {
      browserExecutable: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      browserCdpUrl: null
    },
    {
      fetchImpl: async () => {
        if (!launched) {
          throw new Error("ECONNREFUSED");
        }
        return {
          ok: true,
          async json() {
            return {
              webSocketDebuggerUrl: "ws://127.0.0.1:9222/devtools/browser/bootstrapped"
            };
          }
        } as Response;
      },
      execFileImpl: async (file, args) => {
        execArgs = { file, args };
      },
      spawnImpl: (command, args) => {
        launched = true;
        spawnArgs = { command, args };
        return { unref() {} } as never;
      },
      waitImpl: async () => {},
      resolveChromeProfileSourceImpl: async () => ({
        userDataDir: "/Users/test/Library/Application Support/Google/Chrome",
        profileDirectory: "Profile 7",
        profilePath: "/Users/test/Library/Application Support/Google/Chrome/Profile 7",
        source: "system_last_used"
      }),
      platform: "darwin"
    }
  );

  assert.equal(session.bootstrapped, true);
  assert.equal(session.cdpBaseUrl, "http://127.0.0.1:9222");
  assert.equal(session.cdpUrl, "ws://127.0.0.1:9222/devtools/browser/bootstrapped");
  assert.equal(execArgs?.file, "osascript");
  assert.match(String(execArgs?.args?.[1] ?? ""), /Google Chrome/u);
  assert.equal(spawnArgs?.command, "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome");
  assert.ok(spawnArgs?.args.includes("--remote-debugging-port=9222"));
  assert.ok(spawnArgs?.args.includes("--remote-debugging-address=127.0.0.1"));
  assert.ok(spawnArgs?.args.includes("--restore-last-session"));
  assert.ok(spawnArgs?.args.includes("--user-data-dir=/Users/test/Library/Application Support/Google/Chrome"));
  assert.ok(spawnArgs?.args.includes("--profile-directory=Profile 7"));
});

test("ensureAttachableChromeSession does not bootstrap unavailable remote CDP endpoints", async () => {
  await assert.rejects(
    () =>
      ensureAttachableChromeSession(
        {
          browserExecutable: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
          browserCdpUrl: "http://10.0.0.8:9222"
        },
        {
          fetchImpl: async () => {
            throw new Error("ECONNREFUSED");
          },
          spawnImpl: () => {
            throw new Error("spawn should not run for remote endpoints");
          },
          waitImpl: async () => {}
        }
      ),
    /cannot be bootstrapped because it is not local/iu
  );
});
