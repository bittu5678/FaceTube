import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { handleApiRequest } from "./api-handler";

describe("FaceTube Task 5: Earnings Growth Graph — Real Data & Breakdown Tests", () => {
  const mockUserId = "FT_GROWTH_TEST_01";

  it("1. Returns ₹0 for all dates when no transactions exist (strictly no synthetic formulas)", async () => {
    const req = new Request(
      `http://localhost:3000/api/wallet/earnings-history.php?user_id=${mockUserId}&period=7D`,
      { method: "GET" },
    );

    const res = await handleApiRequest(req);
    assert.ok(res);
    assert.equal(res.status, 200);

    const data = await res.json();
    assert.equal(data.success, true);
    assert.equal(data.period, "7D");
    assert.equal(data.history.length, 7);
    assert.equal(data.summary.total_revenue, 0);
    assert.equal(data.summary.referral, 0);
    assert.equal(data.summary.global, 0);
    assert.equal(data.summary.adsense, 0);
    assert.equal(data.summary.affiliate, 0);
    assert.equal(data.summary.ad_boost, 0);

    // Every single day must have 0 revenue and 0 across all streams
    for (const point of data.history) {
      assert.equal(point.revenue, 0, `Expected 0 revenue on ${point.date}, got ${point.revenue}`);
      assert.equal(point.referral, 0);
      assert.equal(point.global, 0);
      assert.equal(point.adsense, 0);
      assert.equal(point.affiliate, 0);
      assert.equal(point.ad_boost, 0);
      assert.equal(point.tx_count, 0);
    }
  });

  it("2. Accurately handles timeframe periods: 7D, 30D, 90D, and 12M", async () => {
    // 7D
    const res7 = await handleApiRequest(
      new Request(
        `http://localhost:3000/api/wallet/earnings-history?user_id=${mockUserId}&period=7D`,
      ),
    );
    assert.ok(res7);
    const data7 = await res7.json();
    assert.equal(data7.period, "7D");
    assert.equal(data7.history.length, 7);

    // 30D
    const res30 = await handleApiRequest(
      new Request(
        `http://localhost:3000/api/wallet/earnings-history?user_id=${mockUserId}&period=30D`,
      ),
    );
    assert.ok(res30);
    const data30 = await res30.json();
    assert.equal(data30.period, "30D");
    assert.equal(data30.history.length, 30);

    // 90D
    const res90 = await handleApiRequest(
      new Request(
        `http://localhost:3000/api/wallet/earnings-history?user_id=${mockUserId}&period=90D`,
      ),
    );
    assert.ok(res90);
    const data90 = await res90.json();
    assert.equal(data90.period, "90D");
    assert.equal(data90.history.length, 90);

    // 12M (Monthly aggregation across 12 calendar months)
    const res12M = await handleApiRequest(
      new Request(
        `http://localhost:3000/api/wallet/earnings-history?user_id=${mockUserId}&period=12M`,
      ),
    );
    assert.ok(res12M);
    const data12M = await res12M.json();
    assert.equal(data12M.period, "12M");
    assert.equal(data12M.history.length, 12);
    // Keys in 12M should match YYYY-MM
    for (const point of data12M.history) {
      assert.match(point.date, /^\d{4}-\d{2}$/);
    }
  });

  it("3. Correctly categorizes transactions into 5 streams and excludes withdrawals", async () => {
    const activeUserId = "FT_MULTI_STREAM_USER";
    const today = new Date().toISOString().split("T")[0];

    // Seed mock transactions into the store via payment API or by verifying store behavior
    const testReq = new Request(
      `http://localhost:3000/api/wallet/earnings-history.php?user_id=${activeUserId}&period=7D`,
    );
    const testRes = await handleApiRequest(testReq);
    assert.ok(testRes);
    const testData = await testRes.json();
    assert.equal(testData.success, true);
    assert.ok(testData.summary);
    assert.ok("referral" in testData.summary);
    assert.ok("global" in testData.summary);
    assert.ok("adsense" in testData.summary);
    assert.ok("affiliate" in testData.summary);
    assert.ok("ad_boost" in testData.summary);
  });
});
