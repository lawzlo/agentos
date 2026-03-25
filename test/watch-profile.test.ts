import test from "node:test";
import assert from "node:assert/strict";

import { materializeWatchActionTemplate, materializeWatchValue } from "../src/runtime/watch-profile.js";

test("materializeWatchValue preserves explicit empty-string runtime inputs", () => {
  assert.equal(materializeWatchValue("{{typeTarget}}", { typeTarget: "" }, []), "");
});

test("materializeWatchActionTemplate can clear optional target queries with explicit empty strings", () => {
  const [step] = materializeWatchActionTemplate(
    [
      {
        action: "waitForTarget",
        params: {
          targetQuery: "{{typeTarget}}"
        }
      }
    ],
    { typeTarget: "" },
    []
  );

  assert.equal(step?.params?.targetQuery, "");
});
