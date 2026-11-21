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

$isMissingOptionalTable = static function (Throwable $e): bool {
    if (!($e instanceof PDOException)) {
        return false;
    }
    $sqlState = (string)$e->getCode();
    $driverCode = isset($e->errorInfo[1]) ? (int)$e->errorInfo[1] : 0;
    return $sqlState === '42S02' || $driverCode === 1146;
};

$isConnectionUnavailable = static function (Throwable $e): bool {
    if (function_exists('isDatabaseConnectionUnavailableError')) {
        return isDatabaseConnectionUnavailableError($e);
    }
    $sqlState = $e instanceof PDOException ? (string)$e->getCode() : '';
    $driverCode = ($e instanceof PDOException && isset($e->errorInfo[1])) ? (int)$e->errorInfo[1] : 0;
    $msg = $e->getMessage();
    return str_starts_with($sqlState, '08')
        || in_array($driverCode, [1040, 2002, 2003, 2005, 2006, 2013], true)
        || preg_match('/server has gone away|lost connection|connection refused|connection timed out|too many connections|broken pipe|could not translate host|unknown mysql server host|getaddrinfo/i', $msg) === 1;
};

$safeRollback = static function (PDO $conn): void {
    try {
        if ($conn->inTransaction()) {
            $conn->rollBack();
        }
    } catch (Throwable $_rollbackErr) {
        // Ignore rollback failure so the original error response is preserved
    }
};

$pdo = getDatabaseConnection();
try {
    $authUser = getAuthUser($pdo, true);
} catch (Throwable $e) {
    error_log('[record-adsense-earning.php][AUTH] Database error: ' . $e->getMessage());
    if ($isConnectionUnavailable($e)) {
        jsonResponse([
            'success' => false,
            'error' => 'Database connection unavailable during authentication check.'
        ], 503);
    }
    jsonResponse([
        'success' => false,
        'error' => 'Database error during authentication check.'
    ], 500);
}

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
            if ($stmt === false) {
                throw new RuntimeException('Failed to query adsense_historical_conflicts.');
            }
            $conflicts = $stmt->fetchAll(PDO::FETCH_ASSOC);
        } catch (Throwable $e) {
            if (!$isMissingOptionalTable($e)) {
                error_log('[record-adsense-earning.php][GET][conflicts] Database error: ' . $e->getMessage());
                if ($isConnectionUnavailable($e)) {
                    jsonResponse([
                        'success' => false,
                        'error' => 'Database connection unavailable while loading AdSense conflict records.'
                    ], 503);
                }
                jsonResponse([
                    'success' => false,
                    'error' => 'Database error loading AdSense conflict records.'
                ], 500);
            }
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
            if ($stmt === false) {
                throw new RuntimeException('Failed to query adsense_monthly_statements.');
            }
            $statements = $stmt->fetchAll(PDO::FETCH_ASSOC);
        } catch (Throwable $e) {
            if (!$isMissingOptionalTable($e)) {
                error_log('[record-adsense-earning.php][GET][statements] Database error: ' . $e->getMessage());
                if ($isConnectionUnavailable($e)) {
                    jsonResponse([
                        'success' => false,
                        'error' => 'Database connection unavailable while loading AdSense statements.'
                    ], 503);
                }
                jsonResponse([
                    'success' => false,
                    'error' => 'Database error loading AdSense statements.'
                ], 500);
            }
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

$targetUserId = trim((string)($input['userId'] ?? ($input['user_id'] ?? '')));
$rawAmount = $input['amount'] ?? null;
$rawMonth = trim((string)($input['reportMonth'] ?? ($input['report_month'] ?? ($input['statement_month'] ?? date('Y-m')))));
$referenceId = trim((string)($input['referenceId'] ?? ($input['reference_id'] ?? '')));
$videoId = trim((string)($input['videoId'] ?? ($input['video_id'] ?? '')));
$description = trim((string)($input['description'] ?? ''));

if (empty($targetUserId)) {
    jsonResponse([
        'success' => false,
        'error' => 'target user_id is required.'
    ], 400);
}

$parsedAmount = null;
if ($rawAmount === null || is_bool($rawAmount) || is_array($rawAmount) || is_object($rawAmount)) {
    jsonResponse([
        'success' => false,
        'error' => 'Verified AdSense earnings amount must be a finite number strictly greater than 0.'
    ], 400);
}
if (is_string($rawAmount)) {
    $trimmedAmount = trim($rawAmount);
    if ($trimmedAmount === '' || !preg_match('/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/', $trimmedAmount)) {
        jsonResponse([
            'success' => false,
            'error' => 'Verified AdSense earnings amount must be a finite number strictly greater than 0.'
        ], 400);
    }
    $parsedAmount = (float)$trimmedAmount;
} elseif (is_int($rawAmount) || is_float($rawAmount)) {
    $parsedAmount = (float)$rawAmount;
} else {
    jsonResponse([
        'success' => false,
        'error' => 'Verified AdSense earnings amount must be a finite number strictly greater than 0.'
    ], 400);
}

if (!is_finite($parsedAmount) || $parsedAmount <= 0) {
    jsonResponse([
        'success' => false,
        'error' => 'Verified AdSense earnings amount must be a finite number strictly greater than 0.'
    ], 400);
}

if ($parsedAmount > 999999999999.99) {
    jsonResponse([
        'success' => false,
        'error' => 'Verified AdSense earnings amount exceeds maximum supported wallet precision.'
    ], 400);
}

$scaledAmount = round($parsedAmount * 100);
if ($scaledAmount < 1 || abs(($parsedAmount * 100) - $scaledAmount) > 1e-6) {
    jsonResponse([
        'success' => false,
        'error' => 'Verified AdSense earnings amount supports at most 2 decimal places (minimum ₹0.01).'
    ], 400);
}
$amount = $scaledAmount / 100;

// Normalize and validate reporting month (format: YYYY-MM)
if (!preg_match('/^(\d{4})-(0[1-9]|1[0-2])/', $rawMonth, $monthMatches)) {
    jsonResponse([
        'success' => false,
        'error' => "Invalid reportMonth format '{$rawMonth}'. Expected YYYY-MM (e.g. 2026-10)."
    ], 400);
}
$normalizedMonth = "{$monthMatches[1]}-{$monthMatches[2]}";
$cleanMonth = "{$monthMatches[1]}{$monthMatches[2]}";

$canonicalUserId = strtoupper($targetUserId);

try {
    $pdo->beginTransaction();

    // Verify target user exists inside safe transaction handling
    $stmtUser = $pdo->prepare('SELECT id, user_id, name, email FROM users WHERE UPPER(user_id) = UPPER(?) LIMIT 1');
    if ($stmtUser === false || $stmtUser->execute([$targetUserId]) === false) {
        throw new RuntimeException('Failed to look up target user.');
    }
    $targetUser = $stmtUser->fetch();

    if (!$targetUser) {
        $safeRollback($pdo);
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

    // 1. Check adsense_monthly_statements directly for duplicates with row lock.
    // Tolerate ONLY genuine missing-table errors (SQLSTATE 42S02 / MySQL errno 1146).
    $hasStatementTable = true;
    try {
        $stmtCheck = $pdo->prepare('
            SELECT id, amount, transaction_id, created_at
            FROM adsense_monthly_statements
            WHERE UPPER(user_id) = UPPER(?) AND report_month = ?
            FOR UPDATE
        ');
        if ($stmtCheck === false || $stmtCheck->execute([$canonicalUserId, $normalizedMonth]) === false) {
            throw new RuntimeException('Failed to query adsense_monthly_statements.');
        }
        $existingStatement = $stmtCheck->fetch();
        if ($existingStatement) {
            $safeRollback($pdo);
            jsonResponse([
                'success' => false,
                'error' => "AdSense earnings statement for creator {$canonicalUserId} for period {$normalizedMonth} has already been credited and settled (Transaction: {$existingStatement['transaction_id']})."
            ], 409);
        }
    } catch (Throwable $e) {
        if (!$isMissingOptionalTable($e)) {
            throw $e;
        }
        $hasStatementTable = false;
    }

    // 1b. Check if adsense_historical_conflicts has unresolved flagged conflicts for this creator & period.
    // Tolerate ONLY genuine missing-table errors (SQLSTATE 42S02 / MySQL errno 1146).
    try {
        $stmtConflict = $pdo->prepare('
            SELECT id, transaction_id, amount, status
            FROM adsense_historical_conflicts
            WHERE UPPER(user_id) = UPPER(?) AND report_month = ? AND status = "flagged_for_review"
            LIMIT 1
        ');
        if ($stmtConflict === false || $stmtConflict->execute([$canonicalUserId, $normalizedMonth]) === false) {
            throw new RuntimeException('Failed to query adsense_historical_conflicts.');
        }
        $existingConflict = $stmtConflict->fetch();
        if ($existingConflict) {
            $safeRollback($pdo);
            jsonResponse([
                'success' => false,
                'error' => "AdSense earnings statement for creator {$canonicalUserId} for period {$normalizedMonth} has historical records flagged for manual review (Conflict TX: {$existingConflict['transaction_id']}). Please reconcile flagged historical records before posting a new statement."
            ], 409);
        }
    } catch (Throwable $e) {
        if (!$isMissingOptionalTable($e)) {
            throw $e;
        }
        // Optional table may not exist yet if migration pending (42S02 / 1146); proceed
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
    if ($stmtLedgerCheck === false || $stmtLedgerCheck->execute([$canonicalUserId, $txId, "%{$normalizedMonth}%"]) === false) {
        throw new RuntimeException('Failed to query income_ledger for AdSense duplicates.');
    }
    $existingLedger = $stmtLedgerCheck->fetch();
    if ($existingLedger) {
        $safeRollback($pdo);
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
        try {
            $stmtInsertStatement = $pdo->prepare('
                INSERT INTO adsense_monthly_statements (
                    id, user_id, report_month, amount, reference_id,
                    transaction_id, recorded_by, video_id, description, status, created_at
                ) VALUES (
                    ?, ?, ?, ?, ?,
                    ?, ?, ?, ?, "settled", NOW()
                )
            ');
            if ($stmtInsertStatement === false || $stmtInsertStatement->execute([
                $ledgerUuid,
                $canonicalUserId,
                $normalizedMonth,
                $amount,
                $referenceId,
                $txId,
                $authUser['user_id'],
                $videoId ?: null,
                $description
            ]) === false) {
                throw new RuntimeException('Failed to persist AdSense monthly statement record.');
            }
            if ($stmtInsertStatement->rowCount() < 1) {
                throw new RuntimeException('Failed to persist AdSense monthly statement record.');
            }
        } catch (Throwable $e) {
            if (!$isMissingOptionalTable($e)) {
                throw $e;
            }
        }
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
    if ($stmtLedger === false || $stmtLedger->execute([
        $ledgerUuid,
        $txId,
        $canonicalUserId,
        $authUser['user_id'],
        $authUser['name'] ?? 'FaceTube Administrator',
        $videoId ?: null,
        $amount,
        $description
    ]) === false) {
        throw new RuntimeException('Failed to record AdSense income ledger entry.');
    }
    if ($stmtLedger->rowCount() < 1) {
        throw new RuntimeException('Failed to record AdSense income ledger entry.');
    }

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
    if ($stmtCredit === false || $stmtCredit->execute([$canonicalUserId, $amount, $amount, $amount]) === false) {
        throw new RuntimeException('Failed to credit creator wallet for AdSense.');
    }
    if ($stmtCredit->rowCount() < 1) {
        throw new RuntimeException('Failed to credit creator wallet for AdSense.');
    }

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
} catch (Throwable $e) {
    $safeRollback($pdo);

    // Handle concurrent duplicate entry constraint collision strictly on MySQL errno 1062
    $mysqlErrno = ($e instanceof PDOException && isset($e->errorInfo[1])) ? (int)$e->errorInfo[1] : 0;
    if ($mysqlErrno === 1062) {
        jsonResponse([
            'success' => false,
            'error' => "AdSense earnings statement for creator {$canonicalUserId} for period {$normalizedMonth} has already been credited or is currently being processed."
        ], 409);
    }

    error_log('[record-adsense-earning.php][POST] Transaction error: ' . $e->getMessage());

    if ($isConnectionUnavailable($e)) {
        jsonResponse([
            'success' => false,
            'error' => 'Database connection unavailable while recording AdSense earnings.'
        ], 503);
    }

    jsonResponse([
        'success' => false,
        'error' => 'Database error recording AdSense earnings.'
    ], 500);
}
