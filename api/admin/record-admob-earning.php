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
        'error' => 'Admin authorization required. Only verified administrators can record AdMob earnings.'
    ], 403);
}

// Handle GET: Reporting on monthly AdMob statements
if ($_SERVER['REQUEST_METHOD'] === 'GET') {
    $statements = [];
    try {
        $stmt = $pdo->query('
            SELECT id, statement_id, user_id, report_month, gross_amount, net_amount,
                   impressions, ecpm, app_id, transaction_id, verified_by, status, created_at
            FROM admob_monthly_statements
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

$input = getRequestPayload();

$targetUserId = trim((string)($input['userId'] ?? ($input['user_id'] ?? '')));
$amount = floatval($input['amount'] ?? 0);
$rawMonth = trim((string)($input['reportMonth'] ?? ($input['report_month'] ?? date('Y-m'))));
$impressions = intval($input['impressions'] ?? 0);
$ecpm = floatval($input['ecpm'] ?? 0);
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

if ($amount <= 0) {
    jsonResponse([
        'success' => false,
        'error' => 'Verified AdMob earnings amount must be strictly greater than 0.'
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

// Generate transaction and statement IDs
$txId = 'TX-ADMOB-' . $cleanMonth . '-' . substr(bin2hex(random_bytes(6)), 0, 10);
$statementId = 'STMT-ADMOB-' . $cleanMonth . '-' . $cleanUserId;
$defaultDesc = "Google AdMob Finalized Statement ({$normalizedMonth}) - Android Native App";
$finalDesc = !empty($description) ? $description : $defaultDesc;

try {
    $pdo->beginTransaction();

    // 1. Race-safe Anti-Duplication Check inside transaction
    $stmtDup = $pdo->prepare('
        SELECT id, statement_id, gross_amount, transaction_id, created_at
        FROM admob_monthly_statements
        WHERE user_id = ? AND report_month = ?
        LIMIT 1
        FOR UPDATE
    ');
    $stmtDup->execute([$canonicalUserId, $normalizedMonth]);
    $existingStatement = $stmtDup->fetch();

    if ($existingStatement) {
        $pdo->rollBack();
        jsonResponse([
            'success' => false,
            'error' => "AdMob statement already finalized for creator '{$canonicalUserId}' in month '{$normalizedMonth}'. Duplicate credits blocked.",
            'existingStatement' => $existingStatement,
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
    $stmtLedger->execute([
        $ledgerId,
        $txId,
        $canonicalUserId,
        'admob_income',
        $amount,
        'settled',
        'ADMOB_FINALIZED_STATEMENT',
        $finalDesc,
    ]);

    // 3. Insert into admob_monthly_statements (atomic with ledger and wallet)
    $stmtStmt = $pdo->prepare('
        INSERT INTO admob_monthly_statements (
            statement_id, user_id, report_month, gross_amount, net_amount,
            impressions, ecpm, app_id, ledger_id, transaction_id, verified_by, status, notes
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ');
    $stmtStmt->execute([
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
    ]);

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
    $stmtWallet->execute([
        $canonicalUserId,
        $amount,
        $amount,
        $amount,
    ]);

    $pdo->commit();

    jsonResponse([
        'success' => true,
        'message' => "Successfully credited ₹{$amount} Google AdMob earnings to creator {$canonicalUserId}.",
        'transactionId' => $txId,
        'statementId' => $statementId,
        'userId' => $canonicalUserId,
        'reportMonth' => $normalizedMonth,
        'amount' => $amount,
        'incomeType' => 'admob_income',
        'creditedAt' => date('Y-m-d H:i:s'),
    ], 201);
} catch (Exception $e) {
    if ($pdo->inTransaction()) {
        $pdo->rollBack();
    }
    $mysqlErrno = ($e instanceof PDOException && isset($e->errorInfo[1])) ? (int)$e->errorInfo[1] : 0;
    if ($mysqlErrno === 1062) {
        jsonResponse([
            'success' => false,
            'error' => "AdMob statement already finalized for creator '{$canonicalUserId}' in month '{$normalizedMonth}'. Duplicate credits blocked."
        ], 409);
    }
    jsonResponse([
        'success' => false,
        'error' => 'Database error recording AdMob earnings: ' . $e->getMessage()
    ], 500);
}
