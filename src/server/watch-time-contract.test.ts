import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import * as nodeWt from "./watch-time.ts";

describe("FaceTube Phase 2: PHP & Node.js Watch Time Contract Parity Tests", () => {
  const apiDir = path.resolve(process.cwd(), "api/watch-time");
  const sharedPhp = fs.readFileSync(path.join(apiDir, "_shared.php"), "utf-8");
  const sessionPhp = fs.readFileSync(path.join(apiDir, "session.php"), "utf-8");
  const heartbeatPhp = fs.readFileSync(path.join(apiDir, "heartbeat.php"), "utf-8");
  const analyticsPhp = fs.readFileSync(path.join(apiDir, "analytics.php"), "utf-8");

  const phpProbe = spawnSync("php", ["-v"], { encoding: "utf-8" });
  const hasPhpCli = phpProbe.status === 0;

  it("1. Enforces identical canonical constants across src/server/watch-time.ts and api/watch-time/_shared.php", () => {
    const constantPairs: Array<[string, number]> = [
      ["WT_HEARTBEAT_INTERVAL_SEC", nodeWt.WT_HEARTBEAT_INTERVAL_SEC],
      ["WT_MAX_DELTA_SEC", nodeWt.WT_MAX_DELTA_SEC],
      ["WT_MIN_QUALIFIED_WATCH_SECONDS", nodeWt.WT_MIN_QUALIFIED_WATCH_SECONDS],
      ["WT_SESSION_TTL_SECONDS", nodeWt.WT_SESSION_TTL_SECONDS],
      ["WT_WALL_CLOCK_JITTER_TOLERANCE_SEC", nodeWt.WT_WALL_CLOCK_JITTER_TOLERANCE_SEC],
      ["WT_MAX_FUTURE_CLIENT_SKEW_SEC", nodeWt.WT_MAX_FUTURE_CLIENT_SKEW_SEC],
      ["WT_SHORT_SESSION_CAP_MAX_SEC", nodeWt.WT_SHORT_SESSION_CAP_MAX_SEC],
      ["WT_SHORT_SESSION_CAP_MIN_SEC", nodeWt.WT_SHORT_SESSION_CAP_MIN_SEC],
      ["WT_SHORT_DAILY_CAP_SEC", nodeWt.WT_SHORT_DAILY_CAP_SEC],
      ["WT_LONG_SESSION_CAP_MAX_SEC", nodeWt.WT_LONG_SESSION_CAP_MAX_SEC],
      ["WT_LONG_SESSION_CAP_MIN_SEC", nodeWt.WT_LONG_SESSION_CAP_MIN_SEC],
      ["WT_LONG_SESSION_CAP_UNKNOWN_DURATION_SEC", nodeWt.WT_LONG_SESSION_CAP_UNKNOWN_DURATION_SEC],
      ["WT_LONG_DAILY_CAP_SEC", nodeWt.WT_LONG_DAILY_CAP_SEC],
      ["WT_GLOBAL_60S_VELOCITY_CAP_SEC", nodeWt.WT_GLOBAL_60S_VELOCITY_CAP_SEC],
      ["WT_GLOBAL_3600S_VELOCITY_CAP_SEC", nodeWt.WT_GLOBAL_3600S_VELOCITY_CAP_SEC],
      ["WT_MAX_CONCURRENT_ACTIVE_SESSIONS", nodeWt.WT_MAX_CONCURRENT_ACTIVE_SESSIONS],
      ["WT_MAX_SESSIONS_PER_MINUTE", nodeWt.WT_MAX_SESSIONS_PER_MINUTE],
      ["WT_SUPERSEDED_FLUSH_WINDOW_SEC", nodeWt.WT_SUPERSEDED_FLUSH_WINDOW_SEC],
    ];

    for (const [name, expectedVal] of constantPairs) {
      const rx = new RegExp(`const\\s+${name}\\s*=\\s*(\\d+)\\s*;`);
      const match = sharedPhp.match(rx);
      assert.ok(match, `PHP _shared.php must define ${name}`);
      assert.equal(
        Number(match[1]),
        expectedVal,
        `Constant parity mismatch for ${name}: PHP=${match[1]} vs Node=${expectedVal}`,
      );
    }

    for (const ev of nodeWt.WT_VALID_EVENT_TYPES) {
      assert.ok(
        sharedPhp.includes(`'${ev}'`),
        `PHP _shared.php WT_VALID_EVENT_TYPES must include '${ev}'`,
      );
    }
  });

  it("2. Verifies PHP session.php & heartbeat.php implement fail-closed auth, strict viewer->session FOR UPDATE locking, idempotency, bounded superseded grace, and midnight split", () => {
    // Shared fail-closed auth & helpers
    assert.match(sharedPhp, /getAuthUser\(\$pdo,\s*true\)/);
    assert.match(sharedPhp, /wtHasSuppliedAuthHeader/);
    assert.match(sharedPhp, /jsonResponse\(\[\s*'success'\s*=>\s*false[\s\S]*?\],\s*401\)/);
    assert.match(sharedPhp, /function wtParseStrictInt/);
    assert.match(sharedPhp, /function wtIsRetryableTransactionError/);
    assert.match(sharedPhp, /function wtSplitWatchSecondsAcrossUtcMidnight/);
    assert.match(sharedPhp, /function wtComputeAverageViewDurationSeconds/);

    // session.php checks (viewer row lock BEFORE watch_sessions lock/insert + indexed viewer_user_id)
    assert.match(sessionPhp, /wtRequireAuthenticatedUser\(\$pdo\)/);
    assert.match(sessionPhp, /\$pdo->beginTransaction\(\)/);
    assert.match(sessionPhp, /SELECT id FROM users WHERE user_id = \? FOR UPDATE/);
    const sessUserLockIdx = sessionPhp.indexOf("SELECT id FROM users WHERE user_id = ? FOR UPDATE");
    const sessWsLockIdx = sessionPhp.indexOf("FROM watch_sessions");
    assert.ok(sessUserLockIdx >= 0 && sessWsLockIdx > sessUserLockIdx);
    assert.match(sessionPhp, /FROM uploaded_videos/);
    assert.match(sessionPhp, /is_blocked/);
    assert.match(sessionPhp, /visibility === 'private'/);
    assert.match(sessionPhp, /ORDER BY last_heartbeat_at ASC, started_at ASC\s+FOR UPDATE/);
    assert.match(sessionPhp, /close_reason = 'superseded'/);
    assert.match(sessionPhp, /'TRANSACTION_CONFLICT'/);
    assert.doesNotMatch(sessionPhp, /UPPER\(\s*[a-zA-Z_.]*viewer_user_id\s*\)/i);
    assert.match(sessionPhp, /,\s*201\);/);

    // heartbeat.php checks (strict integer parsing, viewer lock BEFORE watch_sessions lock, bounded grace, idempotency conflict, indexed viewer_user_id)
    assert.match(heartbeatPhp, /wtRequireAuthenticatedUser\(\$pdo\)/);
    assert.match(heartbeatPhp, /wtParseStrictInt\(\$rawSeq\)/);
    assert.match(heartbeatPhp, /wtParseStrictInt\(\$rawDelta\)/);
    assert.match(heartbeatPhp, /SELECT id FROM users WHERE user_id = \? FOR UPDATE/);
    assert.match(heartbeatPhp, /SELECT \* FROM watch_sessions WHERE id = \? FOR UPDATE/);
    const hbUserLockIdx = heartbeatPhp.indexOf("SELECT id FROM users WHERE user_id = ? FOR UPDATE");
    const hbWsLockIdx = heartbeatPhp.indexOf(
      "SELECT * FROM watch_sessions WHERE id = ? FOR UPDATE",
    );
    assert.ok(hbUserLockIdx >= 0 && hbWsLockIdx > hbUserLockIdx);
    assert.match(heartbeatPhp, /WHERE idempotency_key = \?[\s\S]*?LIMIT 1/);
    assert.match(heartbeatPhp, /'IDEMPOTENCY_CONFLICT'/);
    assert.match(heartbeatPhp, /'TRANSACTION_CONFLICT'/);
    assert.match(heartbeatPhp, /WT_SUPERSEDED_FLUSH_WINDOW_SEC/);
    assert.match(heartbeatPhp, /'deduplicated'\s*=>\s*true/);
    assert.match(heartbeatPhp, /'SESSION_EXPIRED'/);
    assert.match(heartbeatPhp, /'SEQUENCE_CONFLICT'/);
    assert.match(heartbeatPhp, /'SESSION_ENDED'/);
    assert.match(heartbeatPhp, /'INVALID_CLIENT_TIMESTAMP'/);
    assert.match(heartbeatPhp, /'DELTA_EXCEEDS_ELAPSED_TIME'/);
    assert.match(heartbeatPhp, /'SESSION_CAP_REACHED'/);
    assert.match(heartbeatPhp, /'VIEWER_VELOCITY_LIMIT'/);
    assert.match(heartbeatPhp, /'VIEWER_HOURLY_LIMIT'/);
    assert.match(heartbeatPhp, /'DAILY_VIDEO_CAP_REACHED'/);
    assert.match(heartbeatPhp, /wtSplitWatchSecondsAcrossUtcMidnight/);
    assert.match(heartbeatPhp, /ON DUPLICATE KEY UPDATE/);
    assert.match(
      heartbeatPhp,
      /qualified_watched_seconds = qualified_watched_seconds \+ VALUES\(qualified_watched_seconds\)/,
    );
    assert.match(
      heartbeatPhp,
      /qualified_sessions = qualified_sessions \+ VALUES\(qualified_sessions\)/,
    );
    assert.doesNotMatch(heartbeatPhp, /UPPER\(\s*[a-zA-Z_.]*viewer_user_id\s*\)/i);
    assert.doesNotMatch(heartbeatPhp, /UPDATE\s+uploaded_videos\s+SET\s+views/i);
    assert.doesNotMatch(sessionPhp, /UPDATE\s+uploaded_videos\s+SET\s+views/i);
  });

  it("3. Verifies PHP analytics.php matches Node.js response schema, creator isolation, and zero-safe AVD", () => {
    assert.match(analyticsPhp, /wtRequireAuthenticatedUser\(\$pdo\)/);
    assert.match(analyticsPhp, /Cross-user access is restricted to verified administrators/);
    assert.match(
      analyticsPhp,
      /wtComputeAverageViewDurationSeconds\(\$currQualifiedSec,\s*\$currQualifiedSessions\)/,
    );
    assert.match(
      analyticsPhp,
      /wtComputeAverageViewDurationSeconds\(\$lifetimeQualifiedSec,\s*\$lifetimeQualifiedSessions\)/,
    );
    assert.match(analyticsPhp, /'timezone'\s*=>\s*'UTC'/);
    assert.match(analyticsPhp, /'has_data'\s*=>\s*\$lifetimeTotalSec > 0/);
    assert.match(analyticsPhp, /'avg_view_duration_seconds'/);
    assert.match(analyticsPhp, /'avg_view_duration_formatted'/);
    assert.match(analyticsPhp, /'qualified_watched_seconds'/);
    assert.match(analyticsPhp, /'qualified_sessions'/);
    assert.match(analyticsPhp, /'growth_percent'\s*=>\s*\$growthPercent/);
    assert.match(analyticsPhp, /'top_videos'\s*=>\s*\$topVideos/);
  });

  it("4. Executes live PHP runtime parity when PHP CLI is available (skips cleanly if php binary is absent)", (t) => {
    if (!hasPhpCli) {
      t.skip(
        "PHP CLI binary is not installed in this container; static PHP contract checks verified above.",
      );
      return;
    }

    // Lint PHP syntax & run pure helper parity checks via PHP CLI
    for (const file of ["_shared.php", "session.php", "heartbeat.php", "analytics.php"]) {
      const lint = spawnSync("php", ["-l", path.join(apiDir, file)], { encoding: "utf-8" });
      assert.equal(lint.status, 0, `PHP syntax check failed for ${file}: ${lint.stderr}`);
    }

    const endEpoch = Math.floor(Date.parse("2026-11-28T00:00:05Z") / 1000);
    const nodeSplit = nodeWt.splitWatchSecondsAcrossUtcMidnight(endEpoch, 15);
    const phpEval = spawnSync(
      "php",
      [
        "-r",
        `require ${JSON.stringify(path.join(apiDir, "_shared.php"))};
         echo json_encode([
           'split' => wtSplitWatchSecondsAcrossUtcMidnight(${endEpoch}, 15),
           'avdZero' => wtComputeAverageViewDurationSeconds(0, 0),
           'avdNonZero' => wtComputeAverageViewDurationSeconds(90, 3),
           'capShort' => wtComputeSessionCapSeconds('short', 42),
           'capLong' => wtComputeSessionCapSeconds('long', 600),
         ]);`,
      ],
      { encoding: "utf-8" },
    );
    assert.equal(phpEval.status, 0, phpEval.stderr);
    const phpOut = JSON.parse(phpEval.stdout);
    assert.deepEqual(phpOut.split, nodeSplit);
    assert.equal(phpOut.avdZero, nodeWt.computeAverageViewDurationSeconds(0, 0));
    assert.equal(phpOut.avdNonZero, nodeWt.computeAverageViewDurationSeconds(90, 3));
    assert.equal(phpOut.capShort, nodeWt.computeSessionCapSeconds("short", 42));
    assert.equal(phpOut.capLong, nodeWt.computeSessionCapSeconds("long", 600));
  });
});
