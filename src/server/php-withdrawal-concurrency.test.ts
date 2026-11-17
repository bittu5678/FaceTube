import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

describe("Hostinger PHP Withdrawal Concurrency & Daily Limit Validation (Task 1)", () => {
  const phpFilePath = path.resolve(process.cwd(), "api/wallet/withdraw.php");
  const phpCode = fs.readFileSync(phpFilePath, "utf-8");

  it("api/wallet/withdraw.php exists and is readable", () => {
    assert.ok(fs.existsSync(phpFilePath), "File api/wallet/withdraw.php must exist");
    assert.ok(phpCode.length > 0, "File content should not be empty");
  });

  it("Acquires pessimistic row lock (FOR UPDATE) inside transaction BEFORE cumulative daily limit check", () => {
    const beginTxPos = phpCode.indexOf("$pdo->beginTransaction()");
    assert.ok(beginTxPos !== -1, "Must contain $pdo->beginTransaction()");

    const rowLockPos = phpCode.indexOf("FOR UPDATE", beginTxPos);
    assert.ok(rowLockPos !== -1, "Row lock 'FOR UPDATE' must be executed inside the transaction");

    // Cumulative check query position
    const dailyQueryPos = phpCode.indexOf("income_type = 'withdrawal'", rowLockPos);
    assert.ok(
      dailyQueryPos !== -1 && dailyQueryPos > rowLockPos,
      "Daily cumulative withdrawal calculation must occur AFTER acquiring the row lock (FOR UPDATE)",
    );

    // Ensure the old premature check outside the transaction is removed
    const preTxDailyPos = phpCode.indexOf("income_type = 'withdrawal'");
    assert.ok(
      preTxDailyPos > beginTxPos,
      "No cumulative withdrawal calculation should run prior to $pdo->beginTransaction()",
    );
  });

  it("Correctly filters for non-failed withdrawals (including pending and settled)", () => {
    assert.ok(
      phpCode.includes("status != 'failed'"),
      "Daily limit query must include pending and settled withdrawals by filtering status != 'failed'",
    );
    assert.ok(
      phpCode.includes("DATE(created_at) = CURDATE()"),
      "Daily limit query must scope to current day (CURDATE())",
    );
  });

  it("Rolls back transaction immediately when ₹10,000 daily limit is exceeded", () => {
    const dailyCheckBlock = phpCode.substring(
      phpCode.indexOf("$stmtDaily = $pdo->prepare"),
      phpCode.indexOf("$chargesBreakdown = ["),
    );

    assert.ok(
      dailyCheckBlock.includes("$pdo->rollBack()"),
      "Must roll back transaction when daily withdrawal limit is exceeded",
    );
    assert.ok(
      dailyCheckBlock.includes("Daily withdrawal limit of ₹10,000 reached"),
      "Must return exact limit reached message",
    );
    assert.ok(
      dailyCheckBlock.includes("Daily limit exceeded. You have already withdrawn ₹"),
      "Must return exact daily limit exceeded message",
    );
  });

  it("Preserves exact financial fee rules (18% GST, 2% PG, 20% Total Deduction, 80% Net Payout, 0 Admin Fee)", () => {
    assert.ok(
      phpCode.includes("$gstAmount = round($amount * 0.18, 2);"),
      "Must calculate GST as 18% of full amount",
    );
    assert.ok(
      phpCode.includes("$pgFeeAmount = round($amount * 0.02, 2);"),
      "Must calculate PG fee as 2% of full amount",
    );
    assert.ok(
      phpCode.includes("$fee = round($gstAmount + $pgFeeAmount, 2);"),
      "Must calculate total fee as exactly GST (18%) + PG fee (2%) = 20%",
    );
    assert.ok(
      phpCode.includes("$netAmount = round($amount - $fee, 2);"),
      "Must calculate net payout as 80% of requested amount",
    );
    assert.ok(
      !phpCode.includes("12.00") && !phpCode.includes("admin_charge"),
      "No ₹12 admin charge must exist in calculation",
    );
  });

  it("Preserves server-side Personal KYC and Bank KYC verification before debit", () => {
    assert.ok(phpCode.includes("personal_kyc"), "Must verify Personal KYC authoritative status");
    assert.ok(phpCode.includes("bank_kyc"), "Must verify Bank KYC authoritative status");
  });
});
