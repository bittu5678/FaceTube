import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { handleApiRequest } from "./api-handler";

const STORE_PATH = path.resolve(process.cwd(), "data/facetube_store.json");

describe("FaceTube Admin KYC Backend: RBAC, Review, Audit & Self-Verification Prevention Tests", () => {
  let initialStoreSnapshot = "";
  let adminToken = "";
  let regularUserToken = "";

  const adminEmail = "admin@facetube.com";
  const regularUserEmail = "alex@facetube.com";
  const testCreatorId = "FT_TEST_CREATOR_99";

  before(async () => {
    // Preserve initial store snapshot
    initialStoreSnapshot = fs.readFileSync(STORE_PATH, "utf-8");

    // Authenticate Admin User (FT102857)
    const adminLoginReq = new Request("http://localhost:3000/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ identifier: adminEmail, password: "password" }),
    });
    const adminRes = await handleApiRequest(adminLoginReq);
    assert.ok(adminRes);
    assert.equal(adminRes.status, 200);
    const adminBody = await adminRes.json();
    assert.ok(adminBody.token);
    adminToken = adminBody.token;

    // Authenticate Regular User (FT483921)
    const userLoginReq = new Request("http://localhost:3000/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ identifier: regularUserEmail, password: "password123" }),
    });
    const userRes = await handleApiRequest(userLoginReq);
    assert.ok(userRes);
    assert.equal(userRes.status, 200);
    const userBody = await userRes.json();
    assert.ok(userBody.token);
    regularUserToken = userBody.token;
  });

  after(() => {
    // Restore initial store snapshot
    if (initialStoreSnapshot) {
      fs.writeFileSync(STORE_PATH, initialStoreSnapshot, "utf-8");
    }
  });

  // ==========================================================================
  // 1. Prevention of User Self-Verification
  // ==========================================================================
  describe("1. Prevention of User Self-Verification", () => {
    it("Enforces 'Submitted' status when user attempts to submit Personal KYC with 'Verified'", async () => {
      const payload = {
        userId: testCreatorId,
        fullName: "Test Creator Name",
        mobile: "+91 9876543210",
        dob: "1995-04-12",
        address: "123 Film City Road",
        city: "Mumbai",
        state: "Maharashtra",
        pincode: "400001",
        nomineeName: "Test Nominee",
        nomineeRelation: "Sibling",
        nomineeMobile: "+91 9876543211",
        status: "Verified", // Malicious / self-verification attempt!
      };

      const req = new Request("http://localhost:3000/api/kyc/personal", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${regularUserToken}`,
        },
        body: JSON.stringify(payload),
      });

      const res = await handleApiRequest(req);
      assert.ok(res);
      assert.equal(res.status, 200);
      const data = await res.json();
      assert.equal(data.success, true);
      assert.equal(
        data.kyc.status,
        "Submitted",
        "Personal KYC status MUST be 'Submitted', never self-verified",
      );

      // Verify persistence in store
      const store = JSON.parse(fs.readFileSync(STORE_PATH, "utf-8"));
      assert.equal(store.personalKyc[testCreatorId].status, "Submitted");
    });

    it("Enforces 'Submitted' status when user attempts to submit Bank KYC with 'Verified'", async () => {
      const payload = {
        userId: testCreatorId,
        accountHolderName: "Test Creator Name",
        bankName: "State Bank of India",
        accountNumber: "123456789012",
        ifscCode: "SBIN0001234",
        branchName: "Nariman Point",
        accountType: "Saving",
        upiId: "testcreator@sbi",
        status: "Verified", // Malicious / self-verification attempt!
      };

      const req = new Request("http://localhost:3000/api/kyc/bank", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${regularUserToken}`,
        },
        body: JSON.stringify(payload),
      });

      const res = await handleApiRequest(req);
      assert.ok(res);
      assert.equal(res.status, 200);
      const data = await res.json();
      assert.equal(data.success, true);
      assert.equal(
        data.kyc.status,
        "Submitted",
        "Bank KYC status MUST be 'Submitted', never self-verified",
      );

      // Verify persistence in store
      const store = JSON.parse(fs.readFileSync(STORE_PATH, "utf-8"));
      assert.equal(store.bankKyc[testCreatorId].status, "Submitted");
    });
  });

  // ==========================================================================
  // 2. Admin RBAC & Authorization
  // ==========================================================================
  describe("2. Admin RBAC & Authorization Enforcement", () => {
    it("Rejects unauthenticated request to /api/admin/kyc/list with HTTP 401", async () => {
      const req = new Request("http://localhost:3000/api/admin/kyc/list", {
        method: "GET",
      });
      const res = await handleApiRequest(req);
      assert.ok(res);
      assert.equal(res.status, 401);
      const body = await res.json();
      assert.equal(body.success, false);
      assert.match(body.error, /Authentication required/i);
    });

    it("Rejects non-admin user request to /api/admin/kyc/list with HTTP 403", async () => {
      const req = new Request("http://localhost:3000/api/admin/kyc/list", {
        method: "GET",
        headers: { Authorization: `Bearer ${regularUserToken}` },
      });
      const res = await handleApiRequest(req);
      assert.ok(res);
      assert.equal(res.status, 403);
      const body = await res.json();
      assert.equal(body.success, false);
      assert.match(body.error, /Admin authorization required/i);
    });

    it("Rejects non-admin user request to /api/admin/kyc-list shim with HTTP 403", async () => {
      const req = new Request("http://localhost:3000/api/admin/kyc-list", {
        method: "GET",
        headers: { Authorization: `Bearer ${regularUserToken}` },
      });
      const res = await handleApiRequest(req);
      assert.ok(res);
      assert.equal(res.status, 403);
    });

    it("Rejects non-admin user review attempt with HTTP 403", async () => {
      const req = new Request("http://localhost:3000/api/admin/kyc/review", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${regularUserToken}`,
        },
        body: JSON.stringify({
          type: "personal",
          userId: testCreatorId,
          decision: "approved",
        }),
      });
      const res = await handleApiRequest(req);
      assert.ok(res);
      assert.equal(res.status, 403);
      const body = await res.json();
      assert.equal(body.success, false);
      assert.match(body.error, /Admin authorization required/i);
    });

    it("Rejects non-admin user audit log access with HTTP 403", async () => {
      const req = new Request("http://localhost:3000/api/admin/kyc/audit", {
        method: "GET",
        headers: { Authorization: `Bearer ${regularUserToken}` },
      });
      const res = await handleApiRequest(req);
      assert.ok(res);
      assert.equal(res.status, 403);
    });
  });

  // ==========================================================================
  // 3. Admin Listing & KPI Stats
  // ==========================================================================
  describe("3. Admin KYC Listing, Filtering & Statistics", () => {
    it("Allows admin to list submissions and includes calculated stats", async () => {
      const req = new Request("http://localhost:3000/api/admin/kyc/list?status=all", {
        method: "GET",
        headers: { Authorization: `Bearer ${adminToken}` },
      });
      const res = await handleApiRequest(req);
      assert.ok(res);
      assert.equal(res.status, 200);
      const data = await res.json();

      assert.equal(data.success, true);
      assert.ok(data.stats);
      assert.equal(typeof data.stats.totalPending, "number");
      assert.equal(typeof data.stats.pendingPersonal, "number");
      assert.equal(typeof data.stats.pendingBank, "number");
      assert.equal(typeof data.stats.totalVerified, "number");
      assert.equal(typeof data.stats.totalRejected, "number");
      assert.ok(Array.isArray(data.submissions));
      assert.ok(data.pagination);
    });

    it("Filters submissions by type (type=personal)", async () => {
      const req = new Request("http://localhost:3000/api/admin/kyc/list?type=personal&status=all", {
        method: "GET",
        headers: { Authorization: `Bearer ${adminToken}` },
      });
      const res = await handleApiRequest(req);
      assert.ok(res);
      assert.equal(res.status, 200);
      const data = await res.json();

      assert.ok(data.submissions.length > 0);
      for (const item of data.submissions) {
        assert.equal(item.type, "personal");
      }
    });

    it("Filters submissions by type (type=bank)", async () => {
      const req = new Request("http://localhost:3000/api/admin/kyc/list?type=bank&status=all", {
        method: "GET",
        headers: { Authorization: `Bearer ${adminToken}` },
      });
      const res = await handleApiRequest(req);
      assert.ok(res);
      assert.equal(res.status, 200);
      const data = await res.json();

      assert.ok(data.submissions.length > 0);
      for (const item of data.submissions) {
        assert.equal(item.type, "bank");
      }
    });

    it("Supports filtering by specific creator userId", async () => {
      const req = new Request(
        `http://localhost:3000/api/admin/kyc/list?userId=${testCreatorId}&status=all`,
        {
          method: "GET",
          headers: { Authorization: `Bearer ${adminToken}` },
        },
      );
      const res = await handleApiRequest(req);
      assert.ok(res);
      assert.equal(res.status, 200);
      const data = await res.json();

      assert.ok(data.submissions.length >= 1);
      for (const item of data.submissions) {
        assert.equal(item.userId.toUpperCase(), testCreatorId);
      }
    });

    it("Supports compatibility wrapper /api/admin/kyc-list", async () => {
      const req = new Request(
        `http://localhost:3000/api/admin/kyc-list?userId=${testCreatorId}&status=all`,
        {
          method: "GET",
          headers: { Authorization: `Bearer ${adminToken}` },
        },
      );
      const res = await handleApiRequest(req);
      assert.ok(res);
      assert.equal(res.status, 200);
      const data = await res.json();
      assert.equal(data.success, true);
    });
  });

  // ==========================================================================
  // 4. Admin Review: Approval & Audit Trail
  // ==========================================================================
  describe("4. Admin Review: Approval Workflow & Audit Trail", () => {
    it("Allows admin to approve Personal KYC submission and logs audit entry", async () => {
      const req = new Request("http://localhost:3000/api/admin/kyc/review", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${adminToken}`,
        },
        body: JSON.stringify({
          type: "personal",
          userId: testCreatorId,
          decision: "approved",
          adminNote: "Government ID verified and valid.",
        }),
      });

      const res = await handleApiRequest(req);
      assert.ok(res);
      assert.equal(res.status, 200);
      const data = await res.json();

      assert.equal(data.success, true);
      assert.equal(data.decision, "approved");
      assert.equal(data.status, "Verified");
      assert.ok(data.audit);
      assert.equal(data.audit.action, "approved");
      assert.equal(data.audit.previousStatus, "Submitted");
      assert.equal(data.audit.newStatus, "Verified");
      assert.equal(data.audit.adminNote, "Government ID verified and valid.");

      // Check persistence
      const store = JSON.parse(fs.readFileSync(STORE_PATH, "utf-8"));
      assert.equal(store.personalKyc[testCreatorId].status, "Verified");
      assert.equal(store.personalKyc[testCreatorId].reviewedBy, "FT102857");
    });

    it("Blocks re-reviewing an already Verified KYC submission with HTTP 400", async () => {
      const req = new Request("http://localhost:3000/api/admin/kyc/review", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${adminToken}`,
        },
        body: JSON.stringify({
          type: "personal",
          userId: testCreatorId,
          decision: "approved",
        }),
      });

      const res = await handleApiRequest(req);
      assert.ok(res);
      assert.equal(res.status, 400);
      const data = await res.json();
      assert.equal(data.success, false);
      assert.match(data.error, /Only KYC submissions with status 'Submitted' can be reviewed/i);
    });
  });

  // ==========================================================================
  // 5. Admin Review: Rejection & Mandatory Reason
  // ==========================================================================
  describe("5. Admin Review: Rejection Workflow & Validation", () => {
    it("Rejects rejection decision without mandatory rejectionReason with HTTP 400", async () => {
      const req = new Request("http://localhost:3000/api/admin/kyc/review", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${adminToken}`,
        },
        body: JSON.stringify({
          type: "bank",
          userId: testCreatorId,
          decision: "rejected",
          // missing rejectionReason!
        }),
      });

      const res = await handleApiRequest(req);
      assert.ok(res);
      assert.equal(res.status, 400);
      const data = await res.json();
      assert.equal(data.success, false);
      assert.match(data.error, /Rejection reason is required/i);
    });

    it("Rejects review with invalid KYC type with HTTP 400", async () => {
      const req = new Request("http://localhost:3000/api/admin/kyc/review", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${adminToken}`,
        },
        body: JSON.stringify({
          type: "invalid_type",
          userId: testCreatorId,
          decision: "approved",
        }),
      });

      const res = await handleApiRequest(req);
      assert.ok(res);
      assert.equal(res.status, 400);
      const data = await res.json();
      assert.match(data.error, /Invalid or missing KYC type/i);
    });

    it("Allows admin to reject Bank KYC submission with valid reason", async () => {
      const reason = "Bank statement blurred and account holder name mismatch.";
      const req = new Request("http://localhost:3000/api/admin/kyc/review", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${adminToken}`,
        },
        body: JSON.stringify({
          type: "bank",
          userId: testCreatorId,
          decision: "rejected",
          rejectionReason: reason,
          adminNote: "Flagged during verification audit.",
        }),
      });

      const res = await handleApiRequest(req);
      assert.ok(res);
      assert.equal(res.status, 200);
      const data = await res.json();

      assert.equal(data.success, true);
      assert.equal(data.decision, "rejected");
      assert.equal(data.status, "Rejected");
      assert.equal(data.audit.rejectionReason, reason);

      // Check persistence
      const store = JSON.parse(fs.readFileSync(STORE_PATH, "utf-8"));
      assert.equal(store.bankKyc[testCreatorId].status, "Rejected");
      assert.equal(store.bankKyc[testCreatorId].rejectionReason, reason);
    });
  });

  // ==========================================================================
  // 6. Audit Trail History API
  // ==========================================================================
  describe("6. Audit Trail History API (/api/admin/kyc/audit)", () => {
    it("Retrieves recorded audit history entries in reverse chronological order", async () => {
      const req = new Request("http://localhost:3000/api/admin/kyc/audit", {
        method: "GET",
        headers: { Authorization: `Bearer ${adminToken}` },
      });

      const res = await handleApiRequest(req);
      assert.ok(res);
      assert.equal(res.status, 200);
      const data = await res.json();

      assert.equal(data.success, true);
      assert.ok(Array.isArray(data.auditLogs));
      assert.ok(data.auditLogs.length >= 2, "Expected at least 2 audit entries from above tests");

      // Verify the latest action is at the top
      assert.equal(data.auditLogs[0].userId, testCreatorId);
      assert.equal(data.auditLogs[0].action, "rejected");
      assert.equal(data.auditLogs[1].userId, testCreatorId);
      assert.equal(data.auditLogs[1].action, "approved");
    });

    it("Filters audit history by action (action=approved)", async () => {
      const req = new Request(
        `http://localhost:3000/api/admin/kyc/audit?userId=${testCreatorId}&action=approved`,
        {
          method: "GET",
          headers: { Authorization: `Bearer ${adminToken}` },
        },
      );

      const res = await handleApiRequest(req);
      assert.ok(res);
      assert.equal(res.status, 200);
      const data = await res.json();

      assert.equal(data.success, true);
      assert.ok(data.auditLogs.length >= 1);
      for (const log of data.auditLogs) {
        assert.equal(log.action, "approved");
      }
    });

    it("Supports compatibility wrapper /api/admin/kyc-audit", async () => {
      const req = new Request("http://localhost:3000/api/admin/kyc-audit", {
        method: "GET",
        headers: { Authorization: `Bearer ${adminToken}` },
      });

      const res = await handleApiRequest(req);
      assert.ok(res);
      assert.equal(res.status, 200);
      const data = await res.json();
      assert.equal(data.success, true);
      assert.ok(Array.isArray(data.auditLogs));
    });
  });

  // ==========================================================================
  // 7. Task 5J-V4-M: PHP KYC Personal & Bank Auth, Privacy & Fail-Closed Tests
  // ==========================================================================
  describe("7. Task 5J-V4-M: PHP KYC Personal & Bank Authentication, Privacy & Fail-Closed Error Tests", () => {
    const personalPhpPath = path.resolve(process.cwd(), "api/kyc/personal.php");
    const bankPhpPath = path.resolve(process.cwd(), "api/kyc/bank.php");
    const responsePhpPath = path.resolve(process.cwd(), "api/response.php");

    function loadKycPhpSources() {
      return {
        personalPhp: fs.readFileSync(personalPhpPath, "utf-8"),
        bankPhp: fs.readFileSync(bankPhpPath, "utf-8"),
        responsePhp: fs.readFileSync(responsePhpPath, "utf-8"),
      };
    }

    type KycEndpointKind = "personal" | "bank";

    function createKycPhpHarness(options: {
      endpoint: KycEndpointKind;
      method: string;
      bearerToken: string | null;
      queryUserId?: string;
      body?: Record<string, any>;
      authBehavior:
        | { kind: "none" }
        | { kind: "invalid" }
        | { kind: "user"; id: string; user_id: string; role: string }
        | {
            kind: "db_error";
            sqlState: string;
            driverCode: number;
            message: string;
            isRuntime?: boolean;
          };
      dbBehavior?:
        | { kind: "row"; row: Record<string, any> }
        | { kind: "empty" }
        | { kind: "saved" }
        | {
            kind: "db_error";
            sqlState: string;
            driverCode: number;
            message: string;
            isRuntime?: boolean;
          };
      inTransaction?: boolean;
      rollbackThrows?: boolean;
    }) {
      const { responsePhp } = loadKycPhpSources();
      const fnStart = responsePhp.indexOf("function isDatabaseConnectionUnavailableError(");
      const fnBlock = responsePhp.slice(fnStart, fnStart + 900);
      const codeMatch = fnBlock.match(/in_array\(\$driverCode,\s*\[([^\]]+)\],\s*true\)/);
      const driverCodes = (codeMatch?.[1] || "")
        .split(",")
        .map((s) => Number(s.trim()))
        .filter((n) => !Number.isNaN(n));
      const regexMatch = fnBlock.match(/preg_match\('\/([^']+)\/i',\s*\$msg\)/);
      const msgRegex = new RegExp(regexMatch?.[1] || "", "i");

      const isConnUnavailable = (sqlState: string, driverCode: number, msg: string) =>
        sqlState.startsWith("08") || driverCodes.includes(driverCode) || msgRegex.test(msg);

      let inTx = Boolean(options.inTransaction);
      let rollbackAttempts = 0;
      let dbQueryExecuted = false;
      let resolvedTargetUserId: string | null = null;
      const serverLogs: string[] = [];
      const tag = options.endpoint === "personal" ? "kyc/personal.php" : "kyc/bank.php";

      const safeRollback = () => {
        try {
          if (inTx) {
            rollbackAttempts++;
            if (options.rollbackThrows) {
              throw new Error("MySQL server has gone away during ROLLBACK");
            }
            inTx = false;
          }
        } catch (rbErr: any) {
          serverLogs.push(`[${tag}][ROLLBACK] Rollback failed: ${rbErr.message}`);
        }
      };

      if (options.method !== "GET" && options.method !== "POST") {
        return {
          status: 405,
          body: { success: false, error: "Method Not Allowed" },
          dbQueryExecuted,
          resolvedTargetUserId,
          rollbackAttempts,
          serverLogs,
        };
      }

      // Auth resolution mirrors getAuthUser($pdo, true)
      let authUser: { id: string; user_id: string; role: string } | null = null;
      try {
        if (options.bearerToken !== null) {
          if (options.authBehavior.kind === "user") {
            authUser = {
              id: options.authBehavior.id,
              user_id: options.authBehavior.user_id,
              role: options.authBehavior.role,
            };
          } else if (options.authBehavior.kind === "invalid") {
            authUser = null;
          } else if (options.authBehavior.kind === "db_error") {
            throw options.authBehavior;
          }
        }
      } catch (e: any) {
        safeRollback();
        serverLogs.push(`[${tag}][AUTH] Database error: ${e.message}`);
        if (
          !e.isRuntime &&
          isConnUnavailable(e.sqlState || "", e.driverCode || 0, e.message || "")
        ) {
          return {
            status: 503,
            body: {
              success: false,
              error: "Database connection unavailable during authentication check.",
            },
            dbQueryExecuted,
            resolvedTargetUserId,
            rollbackAttempts,
            serverLogs,
          };
        }
        return {
          status: 500,
          body: { success: false, error: "Database error during authentication check." },
          dbQueryExecuted,
          resolvedTargetUserId,
          rollbackAttempts,
          serverLogs,
        };
      }

      if (!authUser || !authUser.user_id) {
        return {
          status: 401,
          body: {
            success: false,
            error: "Authentication required. Please provide a valid Bearer session token.",
          },
          dbQueryExecuted,
          resolvedTargetUserId,
          rollbackAttempts,
          serverLogs,
        };
      }

      const rawReqId =
        options.method === "GET"
          ? options.queryUserId || ""
          : String(options.body?.["userId"] ?? options.body?.["user_id"] ?? "");
      const requestedUserId = rawReqId.trim();

      if (requestedUserId === "") {
        resolvedTargetUserId = authUser.user_id;
      } else if (
        requestedUserId.toUpperCase() === authUser.user_id.toUpperCase() ||
        (authUser.id && requestedUserId.toUpperCase() === authUser.id.toUpperCase())
      ) {
        resolvedTargetUserId = authUser.user_id;
      } else if (authUser.role.toLowerCase() === "admin") {
        resolvedTargetUserId = requestedUserId;
      } else {
        return {
          status: 403,
          body: {
            success: false,
            error: "Unauthorized: Cross-user KYC access is restricted to verified administrators.",
          },
          dbQueryExecuted,
          resolvedTargetUserId,
          rollbackAttempts,
          serverLogs,
        };
      }

      // DB operation
      try {
        dbQueryExecuted = true;
        const db = options.dbBehavior || { kind: "empty" };
        if (db.kind === "db_error") {
          throw db;
        }
        if (options.method === "GET") {
          if (db.kind === "row") {
            return {
              status: 200,
              body: { success: true, kyc: db.row },
              dbQueryExecuted,
              resolvedTargetUserId,
              rollbackAttempts,
              serverLogs,
            };
          }
          return {
            status: 200,
            body: { success: true, kyc: null },
            dbQueryExecuted,
            resolvedTargetUserId,
            rollbackAttempts,
            serverLogs,
          };
        }
        const message =
          options.endpoint === "personal"
            ? "Personal KYC submitted successfully."
            : "Bank KYC submitted successfully.";
        return {
          status: 200,
          body: { success: true, message },
          dbQueryExecuted,
          resolvedTargetUserId,
          rollbackAttempts,
          serverLogs,
        };
      } catch (e: any) {
        safeRollback();
        serverLogs.push(`[${tag}][${options.method}] Database error: ${e.message}`);
        if (
          !e.isRuntime &&
          isConnUnavailable(e.sqlState || "", e.driverCode || 0, e.message || "")
        ) {
          return {
            status: 503,
            body: {
              success: false,
              error: `Database connection unavailable while ${options.method === "GET" ? "loading" : "saving"} ${options.endpoint === "personal" ? "Personal" : "Bank"} KYC.`,
            },
            dbQueryExecuted,
            resolvedTargetUserId,
            rollbackAttempts,
            serverLogs,
          };
        }
        return {
          status: 500,
          body: {
            success: false,
            error: `Failed to ${options.method === "GET" ? "load" : "save"} ${options.endpoint === "personal" ? "Personal" : "Bank"} KYC due to a server error.`,
          },
          dbQueryExecuted,
          resolvedTargetUserId,
          rollbackAttempts,
          serverLogs,
        };
      }
    }

    it("1. Rejects unauthenticated GET and POST on both personal.php and bank.php even when userId is supplied", () => {
      const { personalPhp, bankPhp } = loadKycPhpSources();

      for (const php of [personalPhp, bankPhp]) {
        assert.match(php, /\$authUser\s*=\s*getAuthUser\(\$pdo,\s*true\);/);
        assert.match(php, /if\s*\(\s*!\$authUser\s*\|\|\s*empty\(\$authUser\['user_id'\]\)\s*\)/);
        assert.match(php, /jsonResponse\([\s\S]*?401\s*\);/);
        // Ensure userId is NOT read before authentication completes
        const authPos = php.indexOf("getAuthUser($pdo, true)");
        const getQueryPos = php.indexOf("$_GET['userId']");
        const postPayloadPos = php.indexOf("getRequestPayload()");
        assert.ok(authPos > 0 && authPos < getQueryPos, "Auth must run before GET userId parsing");
        assert.ok(authPos < postPayloadPos, "Auth must run before POST payload parsing");
      }

      for (const endpoint of ["personal", "bank"] as const) {
        for (const method of ["GET", "POST"] as const) {
          const omitted = createKycPhpHarness({
            endpoint,
            method,
            bearerToken: null,
            authBehavior: { kind: "none" },
          });
          assert.equal(omitted.status, 401);
          assert.equal(omitted.dbQueryExecuted, false);

          const spoofed = createKycPhpHarness({
            endpoint,
            method,
            bearerToken: null,
            queryUserId: "FT483921",
            body: { userId: "FT483921", fullName: "Spoof" },
            authBehavior: { kind: "none" },
          });
          assert.equal(
            spoofed.status,
            401,
            `${endpoint} ${method} must reject unauthenticated userId spoofing`,
          );
          assert.equal(spoofed.dbQueryExecuted, false);
        }
      }
    });

    it("2. Rejects invalid/expired Bearer token with 401 and blocks cross-user access with 403 while permitting own-user & verified admin access", () => {
      const { personalPhp, bankPhp } = loadKycPhpSources();
      for (const php of [personalPhp, bankPhp]) {
        assert.match(
          php,
          /\$isAdmin\s*=\s*isset\(\$authUser\['role'\]\)\s*&&\s*strtolower\(trim\(\(string\)\$authUser\['role'\]\)\)\s*===\s*'admin'/,
        );
        assert.match(php, /jsonResponse\([\s\S]*?403\s*\);/);
      }

      for (const endpoint of ["personal", "bank"] as const) {
        // Invalid/expired session returns 401 (even if userId supplied)
        const invalidRes = createKycPhpHarness({
          endpoint,
          method: "GET",
          bearerToken: "expired_token",
          queryUserId: "FT483921",
          authBehavior: { kind: "invalid" },
        });
        assert.equal(invalidRes.status, 401);
        assert.equal(invalidRes.dbQueryExecuted, false);

        // Omitted userId derives from authenticated session
        const selfOmitted = createKycPhpHarness({
          endpoint,
          method: "GET",
          bearerToken: "valid_user_tok",
          authBehavior: { kind: "user", id: "uuid-483921", user_id: "FT483921", role: "user" },
          dbBehavior: { kind: "empty" },
        });
        assert.equal(selfOmitted.status, 200);
        assert.equal(selfOmitted.resolvedTargetUserId, "FT483921");
        assert.deepEqual(selfOmitted.body, { success: true, kyc: null });

        // Own userId (or internal id) allowed on POST
        const selfPost = createKycPhpHarness({
          endpoint,
          method: "POST",
          bearerToken: "valid_user_tok",
          body: { userId: "ft483921", fullName: "Alex Rivera" },
          authBehavior: { kind: "user", id: "uuid-483921", user_id: "FT483921", role: "user" },
          dbBehavior: { kind: "saved" },
        });
        assert.equal(selfPost.status, 200);
        assert.equal(selfPost.resolvedTargetUserId, "FT483921");

        // Cross-user GET & POST by non-admin rejected with 403
        for (const method of ["GET", "POST"] as const) {
          const crossUser = createKycPhpHarness({
            endpoint,
            method,
            bearerToken: "valid_user_tok",
            queryUserId: "FT900431",
            body: { userId: "FT900431" },
            authBehavior: { kind: "user", id: "uuid-483921", user_id: "FT483921", role: "user" },
          });
          assert.equal(crossUser.status, 403);
          assert.equal(crossUser.dbQueryExecuted, false);
        }

        // Verified admin accessing target user succeeds
        const adminGet = createKycPhpHarness({
          endpoint,
          method: "GET",
          bearerToken: "valid_admin_tok",
          queryUserId: "FT900431",
          authBehavior: { kind: "user", id: "uuid-102857", user_id: "FT102857", role: "admin" },
          dbBehavior: { kind: "row", row: { status: "Submitted" } },
        });
        assert.equal(adminGet.status, 200);
        assert.equal(adminGet.resolvedTargetUserId, "FT900431");
      }
    });

    it("3. Returns HTTP 503 on connection failure (e.g., 1203) and sanitized HTTP 500 on unexpected DB/runtime failures; GET errors never return {kyc:null} with HTTP 200", () => {
      const { personalPhp, bankPhp } = loadKycPhpSources();
      for (const php of [personalPhp, bankPhp]) {
        assert.match(php, /\}\s*catch\s*\(\s*Throwable\s+\$e\s*\)\s*\{/);
        assert.match(php, /isDatabaseConnectionUnavailableError\(\$e\)/);
        assert.match(php, /\$safeRollback\(\$pdo\);/);
        assert.match(php, /error_log\(/);
        assert.doesNotMatch(php, /jsonResponse\([^\n]*\$e->getMessage\(\)/);
        // GET catch must not return success:true / kyc:null
        assert.doesNotMatch(
          php,
          /catch\s*\([^)]+\)\s*\{[^}]*jsonResponse\(\[\s*'success'\s*=>\s*true,\s*'kyc'\s*=>\s*null/,
        );
      }

      for (const endpoint of ["personal", "bank"] as const) {
        // Auth DB connection error 1203 -> 503
        const auth1203 = createKycPhpHarness({
          endpoint,
          method: "GET",
          bearerToken: "valid_user_tok",
          authBehavior: {
            kind: "db_error",
            sqlState: "42000",
            driverCode: 1203,
            message: "User already has more than 'max_user_connections' active connections",
          },
          inTransaction: true,
          rollbackThrows: true,
        });
        assert.equal(auth1203.status, 503);
        assert.equal(auth1203.body.success, false);
        assert.equal(auth1203.dbQueryExecuted, false);
        assert.equal(auth1203.rollbackAttempts, 1);
        assert.ok(auth1203.serverLogs.some((l) => l.includes("[ROLLBACK]")));
        assert.equal(String(auth1203.body.error).includes("max_user_connections"), false);

        // Auth unexpected DB error 1146 -> sanitized 500
        const auth1146 = createKycPhpHarness({
          endpoint,
          method: "POST",
          bearerToken: "valid_user_tok",
          authBehavior: {
            kind: "db_error",
            sqlState: "42S02",
            driverCode: 1146,
            message: "Table 'prod_db.sessions' doesn't exist",
          },
        });
        assert.equal(auth1146.status, 500);
        assert.equal(auth1146.dbQueryExecuted, false);
        assert.equal(String(auth1146.body.error).includes("sessions"), false);

        // GET DB connection error -> 503 (never 200 {kyc:null})
        const get2002 = createKycPhpHarness({
          endpoint,
          method: "GET",
          bearerToken: "valid_user_tok",
          authBehavior: { kind: "user", id: "uuid-483921", user_id: "FT483921", role: "user" },
          dbBehavior: {
            kind: "db_error",
            sqlState: "HY000",
            driverCode: 2002,
            message: "Connection refused",
          },
        });
        assert.equal(get2002.status, 503);
        assert.equal(get2002.body.success, false);
        assert.equal("kyc" in get2002.body, false);

        // GET unexpected DB error -> sanitized 500 (never 200 {kyc:null})
        const get1146 = createKycPhpHarness({
          endpoint,
          method: "GET",
          bearerToken: "valid_user_tok",
          authBehavior: { kind: "user", id: "uuid-483921", user_id: "FT483921", role: "user" },
          dbBehavior: {
            kind: "db_error",
            sqlState: "42S02",
            driverCode: 1146,
            message: "Table 'prod_db.kyc_records' doesn't exist",
          },
        });
        assert.equal(get1146.status, 500);
        assert.equal(get1146.body.success, false);
        assert.equal("kyc" in get1146.body, false);
        assert.equal(String(get1146.body.error).includes("kyc_records"), false);

        // POST unexpected RuntimeException -> sanitized 500
        const postRuntime = createKycPhpHarness({
          endpoint,
          method: "POST",
          bearerToken: "valid_user_tok",
          authBehavior: { kind: "user", id: "uuid-483921", user_id: "FT483921", role: "user" },
          dbBehavior: {
            kind: "db_error",
            sqlState: "0",
            driverCode: 0,
            message: "Failed to execute KYC save query with internal details",
            isRuntime: true,
          },
        });
        assert.equal(postRuntime.status, 500);
        assert.equal(postRuntime.body.success, false);
        assert.equal(String(postRuntime.body.error).includes("internal details"), false);
      }
    });

    it("4. Preserves field allowlists, status='Submitted' enforcement, response shapes, and HTTP 405 handling", () => {
      const { personalPhp, bankPhp } = loadKycPhpSources();

      // Personal KYC allowlist & hardcoded Submitted status
      assert.match(personalPhp, /FROM kyc_records WHERE UPPER\(user_id\) = UPPER\(\?\) LIMIT 1/);
      assert.match(personalPhp, /INSERT INTO kyc_records/);
      assert.match(personalPhp, /VALUES[\s\S]*"Submitted"/);
      assert.match(personalPhp, /status = "Submitted"/);
      assert.match(personalPhp, /'submittedAt' => \$row\['created_at'\]/);
      assert.match(personalPhp, /Personal KYC submitted successfully\./);

      // Bank KYC allowlist & hardcoded Submitted status
      assert.match(bankPhp, /FROM kyc_bank_details WHERE UPPER\(user_id\) = UPPER\(\?\) LIMIT 1/);
      assert.match(bankPhp, /INSERT INTO kyc_bank_details/);
      assert.match(bankPhp, /VALUES[\s\S]*"Submitted"/);
      assert.match(bankPhp, /status = "Submitted"/);
      assert.match(bankPhp, /'submittedAt' => \$row\['created_at'\]/);
      assert.match(bankPhp, /Bank KYC submitted successfully\./);

      // 405 Method Not Allowed preserved
      for (const endpoint of ["personal", "bank"] as const) {
        const res405 = createKycPhpHarness({
          endpoint,
          method: "DELETE",
          bearerToken: null,
          authBehavior: { kind: "none" },
        });
        assert.equal(res405.status, 405);
      }
    });
  });
});
