<?php
/**
 * FaceTube - Admin Verified Google AdSense Earnings Recording API
 * POST /api/admin/record-adsense-earning.php
 *
 * Strictly restricted to verified Administrators.
 * Records verified, finalized Google AdSense performance report earnings
 * into the creator's income_ledger (type: adsense_income) and wallet_balances.
 *
 * AdSense Compliance & Anti-Duplication Rule:
 * Ad impressions and clicks are NOT confirmed financial earnings.
 * Earnings must only be credited after Google issues the monthly finalized performance statement.
 * Strictly prevents duplicate statement credits for the same creator and reporting month.
 */

require_once __DIR__ . '/../config/database.php';
require_once __DIR__ . '/../response.php';

if ($_SERVER['REQUEST_METHOD'] !== 'POST' && $_SERVER['REQUEST_METHOD'] !== 'GET') {
    jsonResponse(['success' => false, 'error' => 'Method Not Allowed'], 405);
}

$pdo = getDatabaseConnection();
$authUser = getAuthUser($pdo);

if (!$authUser) {
    jsonResponse([
        'success' => false,
        'error' => 'Authentication required. Please provide a valid Bearer session token.'
    ], 401);
}

if (strtolower($authUser['role'] ?? '') !== 'admin') {
    jsonResponse([
        'success' => false,
        'error' => 'Admin authorization required. Only verified administrators can record AdSense earnings.'
    ], 403);
}

// Handle GET: Reporting on monthly statements and historical conflicts
if ($_SERVER['REQUEST_METHOD'] === 'GET') {
    $action = strtolower(trim($_GET['action'] ?? 'conflicts'));
    if ($action === 'conflicts') {
        $conflicts = [];
        try {
            $stmt = $pdo->query('
                SELECT id, ledger_id, transaction_id, user_id, report_month, amount,
                       primary_statement_tx_id, conflict_type, conflict_reason, description,
                       status, resolution_notes, reviewed_by, reviewed_at, ledger_created_at, created_at
                FROM adsense_historical_conflicts
                ORDER BY report_month DESC, ledger_created_at ASC
            ');
            $conflicts = $stmt ? $stmt->fetchAll(PDO::FETCH_ASSOC) : [];
        } catch (Exception $e) {
            $conflicts = [];
        }
        jsonResponse([
            'success' => true,
            'count' => count($conflicts),
            'conflicts' => $conflicts,
        ]);
    }

    if ($action === 'statements') {
        $statements = [];
        try {
            $stmt = $pdo->query('
                SELECT id, user_id, report_month, amount, reference_id,
                       transaction_id, recorded_by, video_id, description,
                       status, has_conflicts, created_at
                FROM adsense_monthly_statements
                ORDER BY report_month DESC, created_at DESC
            ');
            $statements = $stmt ? $stmt->fetchAll(PDO::FETCH_ASSOC) : [];
        } catch (Exception $e) {
            $statements = [];
        }
        jsonResponse([
            'success' => true,
            'count' => count($statements),
            'statements' => $statements,
        ]);
    }

    jsonResponse(['success' => false, 'error' => "Invalid action. Supported: 'conflicts', 'statements'"], 400);
}

$input = getRequestPayload();

$targetUserId = trim($input['userId'] ?? ($input['user_id'] ?? ''));
$amount = floatval($input['amount'] ?? 0);
$rawMonth = trim($input['reportMonth'] ?? ($input['report_month'] ?? ($input['statement_month'] ?? date('Y-m'))));
$referenceId = trim($input['referenceId'] ?? ($input['reference_id'] ?? ''));
$videoId = trim($input['videoId'] ?? ($input['video_id'] ?? ''));
$description = trim($input['description'] ?? '');

if (empty($targetUserId)) {
    jsonResponse([
        'success' => false,
        'error' => 'target user_id is required.'
    ], 400);
}

if ($amount <= 0) {
    jsonResponse([
        'success' => false,
        'error' => 'Verified AdSense earnings amount must be strictly greater than 0.'
    ], 400);
}

// Normalize and validate reporting month (format: YYYY-MM)
if (!preg_match('/^(\d{4})-(0[1-9]|1[0-2])/', $rawMonth, $monthMatches)) {
    jsonResponse([
        'success' => false,
        'error' => "Invalid reportMonth format '{$rawMonth}'. Expected YYYY-MM (e.g. 2026-10)."
    ], 400);
}
$normalizedMonth = "{$monthMatches[1]}-{$monthMatches[2]}";
$cleanMonth = "{$monthMatches[1]}{$monthMatches[2]}";

// Verify target user exists
$stmtUser = $pdo->prepare('SELECT id, user_id, name, email FROM users WHERE UPPER(user_id) = UPPER(?) LIMIT 1');
$stmtUser->execute([$targetUserId]);
$targetUser = $stmtUser->fetch();

if (!$targetUser) {
    jsonResponse([
        'success' => false,
        'error' => "User ID '{$targetUserId}' not found in database."
    ], 404);
}

$canonicalUserId = $targetUser['user_id'];
$cleanUserId = preg_replace('/[^0-9A-Z]/', '', strtoupper($canonicalUserId));
$creatorName = $targetUser['name'] ?? $canonicalUserId;

if (empty($referenceId)) {
    $referenceId = "ADS-{$cleanMonth}-{$cleanUserId}";
}

if (empty($description)) {
    $description = "Verified Google AdSense earnings for {$normalizedMonth} (Statement Ref: {$referenceId})";
}

// Generate deterministic transaction ID to enforce idempotency on income_ledger
$txId = "TX_ADSENSE_{$cleanUserId}_{$cleanMonth}";

try {
    $pdo->beginTransaction();

    // 1. Check if adsense_monthly_statements table exists, and check for duplicates with row lock
    $hasStatementTable = false;
    try {
        $chkTable = $pdo->query("SHOW TABLES LIKE 'adsense_monthly_statements'");
        $hasStatementTable = ($chkTable && $chkTable->rowCount() > 0);
    } catch (Exception $e) {
        $hasStatementTable = false;
    }

    if ($hasStatementTable) {
        $stmtCheck = $pdo->prepare('
            SELECT id, amount, transaction_id, created_at
            FROM adsense_monthly_statements
            WHERE UPPER(user_id) = UPPER(?) AND report_month = ?
            FOR UPDATE
        ');
        $stmtCheck->execute([$canonicalUserId, $normalizedMonth]);
        $existingStatement = $stmtCheck->fetch();
        if ($existingStatement) {
            $pdo->rollBack();
            jsonResponse([
                'success' => false,
                'error' => "AdSense earnings statement for creator {$canonicalUserId} for period {$normalizedMonth} has already been credited and settled (Transaction: {$existingStatement['transaction_id']})."
            ], 409);
        }
    }

    // 1b. Check if adsense_historical_conflicts has unresolved flagged conflicts for this creator & period
    try {
        $stmtConflict = $pdo->prepare('
            SELECT id, transaction_id, amount, status
            FROM adsense_historical_conflicts
            WHERE UPPER(user_id) = UPPER(?) AND report_month = ? AND status = "flagged_for_review"
            LIMIT 1
        ');
        $stmtConflict->execute([$canonicalUserId, $normalizedMonth]);
        $existingConflict = $stmtConflict->fetch();
        if ($existingConflict) {
            $pdo->rollBack();
            jsonResponse([
                'success' => false,
                'error' => "AdSense earnings statement for creator {$canonicalUserId} for period {$normalizedMonth} has historical records flagged for manual review (Conflict TX: {$existingConflict['transaction_id']}). Please reconcile flagged historical records before posting a new statement."
            ], 409);
        }
    } catch (Exception $e) {
        // Table may not exist yet if migration pending; proceed
    }

    // 2. Double-check income_ledger for existing AdSense credit for this creator & period
    $stmtLedgerCheck = $pdo->prepare('
        SELECT id, transaction_id, amount, created_at
        FROM income_ledger
        WHERE UPPER(user_id) = UPPER(?)
          AND income_type = "adsense_income"
          AND (
            transaction_id = ?
            OR (special_tag = "VERIFIED_ADSENSE_STATEMENT" AND description LIKE ?)
          )
        FOR UPDATE
    ');
    $stmtLedgerCheck->execute([$canonicalUserId, $txId, "%{$normalizedMonth}%"]);
    $existingLedger = $stmtLedgerCheck->fetch();
    if ($existingLedger) {
        $pdo->rollBack();
        jsonResponse([
            'success' => false,
            'error' => "AdSense earnings statement for creator {$canonicalUserId} for period {$normalizedMonth} has already been credited and settled (Transaction: {$existingLedger['transaction_id']})."
        ], 409);
    }

    $ledgerUuid = sprintf(
        '%04x%04x-%04x-%04x-%04x-%04x%04x%04x',
        mt_rand(0, 0xffff), mt_rand(0, 0xffff), mt_rand(0, 0xffff),
        mt_rand(0, 0x0fff) | 0x4000, mt_rand(0, 0x3fff) | 0x8000,
        mt_rand(0, 0xffff), mt_rand(0, 0xffff), mt_rand(0, 0xffff)
    );

    // 3. Record in adsense_monthly_statements if table exists
    if ($hasStatementTable) {
        $stmtInsertStatement = $pdo->prepare('
            INSERT INTO adsense_monthly_statements (
                id, user_id, report_month, amount, reference_id,
                transaction_id, recorded_by, video_id, description, status, created_at
            ) VALUES (
                ?, ?, ?, ?, ?,
                ?, ?, ?, ?, "settled", NOW()
            )
        ');
        $stmtInsertStatement->execute([
            $ledgerUuid,
            $canonicalUserId,
            $normalizedMonth,
            $amount,
            $referenceId,
            $txId,
            $authUser['user_id'],
            $videoId ?: null,
            $description
        ]);
    }

    // 4. Insert into income_ledger
    $stmtLedger = $pdo->prepare('
        INSERT INTO income_ledger (
            id, transaction_id, user_id, source_user_id, source_user_name, video_id,
            income_type, amount, status, special_tag, description, created_at
        ) VALUES (
            ?, ?, ?, ?, ?, ?,
            "adsense_income", ?, "settled", "VERIFIED_ADSENSE_STATEMENT", ?, NOW()
        )
    ');
    $stmtLedger->execute([
        $ledgerUuid,
        $txId,
        $canonicalUserId,
        $authUser['user_id'],
        $authUser['name'] ?? 'FaceTube Administrator',
        $videoId ?: null,
        $amount,
        $description
    ]);

    // 5. Atomic update to wallet_balances
    $stmtCredit = $pdo->prepare('
        INSERT INTO wallet_balances (user_id, balance, total_earned, total_withdrawn, referral_income, global_income, adsense_income, affiliate_income, updated_at)
        VALUES (?, ?, ?, 0.00, 0.00, 0.00, ?, 0.00, NOW())
        ON DUPLICATE KEY UPDATE
            balance = balance + VALUES(balance),
            total_earned = total_earned + VALUES(total_earned),
            adsense_income = adsense_income + VALUES(adsense_income),
            updated_at = NOW()
    ');
    $stmtCredit->execute([$canonicalUserId, $amount, $amount, $amount]);

    $pdo->commit();

    jsonResponse([
        'success' => true,
        'message' => "Successfully recorded ₹" . number_format($amount, 2) . " verified AdSense income for {$creatorName} ({$canonicalUserId}).",
        'transactionId' => $txId,
        'userId' => $canonicalUserId,
        'amount' => $amount,
        'reportMonth' => $normalizedMonth,
        'referenceId' => $referenceId,
    ]);
} catch (PDOException $e) {
    if ($pdo->inTransaction()) {
        $pdo->rollBack();
    }
    // Handle concurrent duplicate entry constraint collision (MySQL 1062 / SQLSTATE 23000)
    if ($e->getCode() == 23000 || strpos($e->getMessage(), 'Duplicate entry') !== false) {
        jsonResponse([
            'success' => false,
            'error' => "AdSense earnings statement for creator {$canonicalUserId} for period {$normalizedMonth} has already been credited or is currently being processed."
        ], 409);
    }
    error_log('[record-adsense-earning.php] Transaction error: ' . $e->getMessage());
    jsonResponse([
        'success' => false,
        'error' => 'Database error recording AdSense earnings: ' . $e->getMessage()
    ], 500);
} catch (Exception $e) {
    if ($pdo->inTransaction()) {
        $pdo->rollBack();
    }
    error_log('[record-adsense-earning.php] Exception: ' . $e->getMessage());
    jsonResponse([
        'success' => false,
        'error' => 'Error recording AdSense earnings: ' . $e->getMessage()
    ], 500);
}
