<?php
/**
 * FaceTube - Admin Verified Google AdMob Earnings Recording API
 * POST /api/admin/record-admob-earning.php
 *
 * Strictly restricted to verified Administrators.
 * Records verified, finalized Google AdMob performance report earnings from
 * the FaceTube Android application into the creator's income_ledger (type: admob_income)
 * and wallet_balances.
 *
 * AdMob Compliance & Anti-Duplication Rule:
 * Ad impressions and clicks are NOT confirmed financial earnings.
 * Earnings must only be credited after Google issues the monthly finalized statement.
 * Strictly prevents duplicate statement credits for the same creator and reporting month.
 */

require_once __DIR__ . '/../config/database.php';
require_once __DIR__ . '/../response.php';

if ($_SERVER['REQUEST_METHOD'] !== 'POST' && $_SERVER['REQUEST_METHOD'] !== 'GET') {
    jsonResponse(['success' => false, 'error' => 'Method Not Allowed'], 405);
}

$isConnectionUnavailable = static function (Throwable $e): bool {
    if (function_exists('isDatabaseConnectionUnavailableError')) {
        return isDatabaseConnectionUnavailableError($e);
    }
    $sqlState = $e instanceof PDOException ? (string)$e->getCode() : '';
    $driverCode = ($e instanceof PDOException && isset($e->errorInfo[1])) ? (int)$e->errorInfo[1] : 0;
    $msg = $e->getMessage();
    return str_starts_with($sqlState, '08')
        || in_array($driverCode, [1040, 1042, 1053, 1129, 1203, 1927, 2002, 2003, 2005, 2006, 2013, 2026], true)
        || preg_match('/server has gone away|lost connection|connection refused|connection timed out|too many connections|max_user_connections|too many user connections|server shutdown in progress|host .* is blocked|broken pipe|could not translate host|unknown mysql server host|getaddrinfo/i', $msg) === 1;
};

$safeRollback = static function (PDO $conn): void {
    try {
        if ($conn->inTransaction()) {
            $conn->rollBack();
        }
    } catch (Throwable $_rollbackErr) {
        // Log rollback failure server-side while preserving the original error response
        error_log('[record-admob-earning.php][ROLLBACK] Rollback failed: ' . $_rollbackErr->getMessage());
    }
};

$pdo = getDatabaseConnection();
try {
    $authUser = getAuthUser($pdo, true);
} catch (Throwable $e) {
    error_log('[record-admob-earning.php][AUTH] Database error: ' . $e->getMessage());
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
        'error' => 'Admin authorization required. Only verified administrators can record AdMob earnings.'
    ], 403);
}

// Handle GET: Reporting on monthly AdMob statements
if ($_SERVER['REQUEST_METHOD'] === 'GET') {
    try {
        $stmt = $pdo->query('
            SELECT id, statement_id, user_id, report_month, gross_amount, net_amount,
                   impressions, ecpm, app_id, transaction_id, verified_by, status, created_at
            FROM admob_monthly_statements
            ORDER BY report_month DESC, created_at DESC
        ');
        if ($stmt === false) {
            throw new RuntimeException('Failed to query admob_monthly_statements.');
        }
        $statements = $stmt->fetchAll(PDO::FETCH_ASSOC);
    } catch (Throwable $e) {
        error_log('[record-admob-earning.php][GET] Database error: ' . $e->getMessage());
        if ($isConnectionUnavailable($e)) {
            jsonResponse([
                'success' => false,
                'error' => 'Database connection unavailable while loading AdMob statements.'
            ], 503);
        }
        jsonResponse([
            'success' => false,
            'error' => 'Database error loading AdMob statements.'
        ], 500);
    }
    jsonResponse([
        'success' => true,
        'count' => count($statements),
        'statements' => $statements,
    ]);
}

$input = getRequestPayload();

$targetUserId = trim((string)($input['userId'] ?? ($input['user_id'] ?? '')));
$rawAmount = $input['amount'] ?? null;
$rawMonth = trim((string)($input['reportMonth'] ?? ($input['report_month'] ?? date('Y-m'))));
$rawImpressions = $input['impressions'] ?? null;
$rawEcpm = $input['ecpm'] ?? null;
$description = trim((string)($input['description'] ?? ''));

$rawAppEnv = getenv('APP_ENV');
if ($rawAppEnv === false) {
    $rawAppEnv = $_ENV['APP_ENV'] ?? ($_SERVER['APP_ENV'] ?? '');
}
$rawNodeEnv = getenv('NODE_ENV');
if ($rawNodeEnv === false) {
    $rawNodeEnv = $_ENV['NODE_ENV'] ?? ($_SERVER['NODE_ENV'] ?? '');
}
$appEnv = strtolower(trim((string)$rawAppEnv));
$nodeEnv = strtolower(trim((string)$rawNodeEnv));
$nonProdEnvs = ['development', 'dev', 'local', 'test'];
$presentEnvs = array_values(array_filter([$appEnv, $nodeEnv], static fn($v) => $v !== ''));
$isProduction = ($appEnv === 'production' || $nodeEnv === 'production')
    || count($presentEnvs) === 0
    || count(array_filter($presentEnvs, static fn($v) => !in_array($v, $nonProdEnvs, true))) > 0;

$requestedAppId = trim((string)($input['appId'] ?? ($input['app_id'] ?? '')));
$configuredAppId = trim((string)(getenv('ADMOB_APP_ID') ?: ($_ENV['ADMOB_APP_ID'] ?? ($_SERVER['ADMOB_APP_ID'] ?? ''))));
$resolvedAppId = $requestedAppId !== '' ? $requestedAppId : $configuredAppId;
$appId = null;

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
        'error' => 'Verified AdMob earnings amount must be a finite number strictly greater than 0.'
    ], 400);
}
if (is_string($rawAmount)) {
    $trimmedAmount = trim($rawAmount);
    if ($trimmedAmount === '' || !preg_match('/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/', $trimmedAmount)) {
        jsonResponse([
            'success' => false,
            'error' => 'Verified AdMob earnings amount must be a finite number strictly greater than 0.'
        ], 400);
    }
    $parsedAmount = (float)$trimmedAmount;
} elseif (is_int($rawAmount) || is_float($rawAmount)) {
    $parsedAmount = (float)$rawAmount;
} else {
    jsonResponse([
        'success' => false,
        'error' => 'Verified AdMob earnings amount must be a finite number strictly greater than 0.'
    ], 400);
}

if (!is_finite($parsedAmount) || $parsedAmount <= 0) {
    jsonResponse([
        'success' => false,
        'error' => 'Verified AdMob earnings amount must be a finite number strictly greater than 0.'
    ], 400);
}

if ($parsedAmount > 999999999999.99) {
    jsonResponse([
        'success' => false,
        'error' => 'Verified AdMob earnings amount exceeds maximum supported wallet precision.'
    ], 400);
}

$scaledAmount = round($parsedAmount * 100);
if ($scaledAmount < 1 || abs(($parsedAmount * 100) - $scaledAmount) > 1e-6) {
    jsonResponse([
        'success' => false,
        'error' => 'Verified AdMob earnings amount supports at most 2 decimal places (minimum ₹0.01).'
    ], 400);
}
$amount = $scaledAmount / 100;

$impressions = 0;
if ($rawImpressions !== null && (!is_string($rawImpressions) || trim($rawImpressions) !== '')) {
    if (is_bool($rawImpressions) || is_array($rawImpressions) || is_object($rawImpressions)) {
        jsonResponse(['success' => false, 'error' => 'AdMob impressions must be a finite non-negative integer.'], 400);
    }
    if (is_string($rawImpressions)) {
        $trimmedImp = trim($rawImpressions);
        if (!preg_match('/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/', $trimmedImp)) {
            jsonResponse(['success' => false, 'error' => 'AdMob impressions must be a finite non-negative integer.'], 400);
        }
        $impNum = (float)$trimmedImp;
    } elseif (is_int($rawImpressions) || is_float($rawImpressions)) {
        $impNum = (float)$rawImpressions;
    } else {
        jsonResponse(['success' => false, 'error' => 'AdMob impressions must be a finite non-negative integer.'], 400);
    }
    if (!is_finite($impNum) || $impNum < 0 || floor($impNum) !== $impNum) {
        jsonResponse(['success' => false, 'error' => 'AdMob impressions must be a finite non-negative integer.'], 400);
    }
    if ($impNum > 4294967295) {
        jsonResponse(['success' => false, 'error' => 'AdMob impressions exceeds maximum supported range.'], 400);
    }
    $impressions = (int)$impNum;
}

$ecpm = 0.0;
if ($rawEcpm !== null && (!is_string($rawEcpm) || trim($rawEcpm) !== '')) {
    if (is_bool($rawEcpm) || is_array($rawEcpm) || is_object($rawEcpm)) {
        jsonResponse(['success' => false, 'error' => 'AdMob ecpm must be a finite non-negative number.'], 400);
    }
    if (is_string($rawEcpm)) {
        $trimmedEcpm = trim($rawEcpm);
        if (!preg_match('/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/', $trimmedEcpm)) {
            jsonResponse(['success' => false, 'error' => 'AdMob ecpm must be a finite non-negative number.'], 400);
        }
        $ecpmNum = (float)$trimmedEcpm;
    } elseif (is_int($rawEcpm) || is_float($rawEcpm)) {
        $ecpmNum = (float)$rawEcpm;
    } else {
        jsonResponse(['success' => false, 'error' => 'AdMob ecpm must be a finite non-negative number.'], 400);
    }
    if (!is_finite($ecpmNum) || $ecpmNum < 0) {
        jsonResponse(['success' => false, 'error' => 'AdMob ecpm must be a finite non-negative number.'], 400);
    }
    if ($ecpmNum > 999999.9999) {
        jsonResponse(['success' => false, 'error' => 'AdMob ecpm exceeds maximum supported range.'], 400);
    }
    $ecpm = $ecpmNum;
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

// Validate AdMob App ID before any DB write or transaction
if ($resolvedAppId === '') {
    if ($isProduction) {
        jsonResponse([
            'success' => false,
            'error' => 'Production AdMob App ID is not configured (ADMOB_APP_ID) and no appId was provided.'
        ], 500);
    }
} else {
    if (preg_match('/^ca-app-pub-3940256099942544(?:~|\/|$)/i', $resolvedAppId)) {
        jsonResponse([
            'success' => false,
            'error' => 'Google reserved test AdMob App ID cannot be used for monthly statement recording.'
        ], 400);
    }
    if (!preg_match('/^ca-app-pub-\d{16}~\d{10}$/', $resolvedAppId)) {
        jsonResponse([
            'success' => false,
            'error' => "Invalid AdMob appId format '{$resolvedAppId}'. Expected ca-app-pub-XXXXXXXXXXXXXXXX~YYYYYYYYYY."
        ], 400);
    }
    $appId = $resolvedAppId;
}

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

    // Generate deterministic transaction and statement IDs
    $txId = 'TX_ADMOB_' . $cleanUserId . '_' . $cleanMonth;
    $statementId = 'STMT-ADMOB-' . $cleanMonth . '-' . $cleanUserId;
    $defaultDesc = "Google AdMob Finalized Statement ({$normalizedMonth}) - Android Native App";
    $finalDesc = !empty($description) ? $description : $defaultDesc;

    // 1. Race-safe Anti-Duplication Check inside transaction
    $stmtDup = $pdo->prepare('
        SELECT id, statement_id, gross_amount, transaction_id, created_at
        FROM admob_monthly_statements
        WHERE user_id = ? AND report_month = ?
        LIMIT 1
        FOR UPDATE
    ');
    if ($stmtDup === false || $stmtDup->execute([$canonicalUserId, $normalizedMonth]) === false) {
        throw new RuntimeException('Failed to query admob_monthly_statements.');
    }
    $existingStatement = $stmtDup->fetch();

    if ($existingStatement) {
        $safeRollback($pdo);
        jsonResponse([
            'success' => false,
            'error' => "AdMob statement already finalized for creator '{$canonicalUserId}' in month '{$normalizedMonth}'. Duplicate credits blocked.",
            'existingStatement' => $existingStatement,
        ], 409);
    }

    // 1b. Race-safe Anti-Duplication Check on income_ledger by deterministic transaction ID
    $stmtLedgerDup = $pdo->prepare('
        SELECT id, transaction_id
        FROM income_ledger
        WHERE transaction_id = ?
        LIMIT 1
        FOR UPDATE
    ');
    if ($stmtLedgerDup === false || $stmtLedgerDup->execute([$txId]) === false) {
        throw new RuntimeException('Failed to query income_ledger for AdMob duplicates.');
    }
    $existingLedger = $stmtLedgerDup->fetch();

    if ($existingLedger) {
        $safeRollback($pdo);
        jsonResponse([
            'success' => false,
            'error' => "AdMob statement already finalized for creator '{$canonicalUserId}' in month '{$normalizedMonth}'. Duplicate credits blocked.",
        ], 409);
    }

    // 2. Insert into income_ledger
    $ledgerId = 'led_' . bin2hex(random_bytes(16));
    $stmtLedger = $pdo->prepare('
        INSERT INTO income_ledger (
            id, transaction_id, user_id, income_type, amount,
            status, special_tag, description, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NOW())
    ');
    if ($stmtLedger === false || $stmtLedger->execute([
        $ledgerId,
        $txId,
        $canonicalUserId,
        'admob_income',
        $amount,
        'settled',
        'ADMOB_FINALIZED_STATEMENT',
        $finalDesc,
    ]) === false) {
        throw new RuntimeException('Failed to record AdMob income ledger entry.');
    }
    if ($stmtLedger->rowCount() < 1) {
        throw new RuntimeException('Failed to record AdMob income ledger entry.');
    }

    // 3. Insert into admob_monthly_statements (atomic with ledger and wallet)
    $stmtStmt = $pdo->prepare('
        INSERT INTO admob_monthly_statements (
            statement_id, user_id, report_month, gross_amount, net_amount,
            impressions, ecpm, app_id, ledger_id, transaction_id, verified_by, status, notes
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ');
    if ($stmtStmt === false || $stmtStmt->execute([
        $statementId,
        $canonicalUserId,
        $normalizedMonth,
        $amount,
        $amount,
        $impressions,
        $ecpm,
        $appId,
        $ledgerId,
        $txId,
        $authUser['user_id'] ?? 'ADMIN',
        'finalized',
        $finalDesc,
    ]) === false) {
        throw new RuntimeException('Failed to persist AdMob monthly statement record.');
    }
    if ($stmtStmt->rowCount() < 1) {
        throw new RuntimeException('Failed to persist AdMob monthly statement record.');
    }

    // 4. Atomically credit creator wallet_balances
    $stmtWallet = $pdo->prepare('
        INSERT INTO wallet_balances (user_id, balance, total_earned, total_withdrawn, admob_income, updated_at)
        VALUES (?, ?, ?, 0.00, ?, NOW())
        ON DUPLICATE KEY UPDATE
            balance = balance + VALUES(balance),
            total_earned = total_earned + VALUES(total_earned),
            admob_income = admob_income + VALUES(admob_income),
            updated_at = NOW()
    ');
    if ($stmtWallet === false || $stmtWallet->execute([
        $canonicalUserId,
        $amount,
        $amount,
        $amount,
    ]) === false) {
        throw new RuntimeException('Failed to credit creator wallet for AdMob.');
    }
    if ($stmtWallet->rowCount() < 1) {
        throw new RuntimeException('Failed to credit creator wallet for AdMob.');
    }

    $pdo->commit();

    jsonResponse([
        'success' => true,
        'message' => 'Successfully credited ₹' . number_format($amount, 2) . " Google AdMob earnings to creator {$canonicalUserId}.",
        'transactionId' => $txId,
        'statementId' => $statementId,
        'userId' => $canonicalUserId,
        'reportMonth' => $normalizedMonth,
        'amount' => $amount,
        'incomeType' => 'admob_income',
        'creditedAt' => date('Y-m-d H:i:s'),
    ], 201);
} catch (Throwable $e) {
    $safeRollback($pdo);
    $mysqlErrno = ($e instanceof PDOException && isset($e->errorInfo[1])) ? (int)$e->errorInfo[1] : 0;
    if ($mysqlErrno === 1062) {
        jsonResponse([
            'success' => false,
            'error' => "AdMob statement already finalized for creator '{$canonicalUserId}' in month '{$normalizedMonth}'. Duplicate credits blocked."
        ], 409);
    }
    error_log('[record-admob-earning.php][POST] Transaction error: ' . $e->getMessage());
    if ($isConnectionUnavailable($e)) {
        jsonResponse([
            'success' => false,
            'error' => 'Database connection unavailable while recording AdMob earnings.'
        ], 503);
    }
    jsonResponse([
        'success' => false,
        'error' => 'Database error recording AdMob earnings.'
    ], 500);
}
