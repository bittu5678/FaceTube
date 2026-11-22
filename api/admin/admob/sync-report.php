<?php
/**
 * FaceTube - Admin AdMob Company Report Sync API (Staging Only)
 * POST /api/admin/admob/sync-report.php
 *
 * Strictly restricted to verified Administrators.
 * Fetches official Google AdMob networkReport:generate estimates for the FaceTube Android app,
 * verifies Google's live publisher account currency === INR, and upserts into admob_report_snapshots.
 *
 * NEVER credits creator wallets or income_ledger.
 * NEVER invokes record-admob-earning.php.
 */

require_once __DIR__ . '/admob-reporting.php';

if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    jsonResponse(['success' => false, 'error' => 'Method Not Allowed'], 405);
}

$pdo = getDatabaseConnection();
try {
    $authUser = getAuthUser($pdo, true);
} catch (Throwable $e) {
    error_log('[admob/sync-report.php][AUTH] Database error: ' . $e->getMessage());
    jsonResponse([
        'success' => false,
        'error' => isAdmobConnectionUnavailableError($e)
            ? 'Database connection unavailable during authentication check.'
            : 'Database error during authentication check.'
    ], isAdmobConnectionUnavailableError($e) ? 503 : 500);
}

if (!$authUser) {
    jsonResponse([
        'success' => false,
        'error' => 'Authentication required. Please provide a valid Bearer session token.'
    ], 401);
}

if (strtolower(trim((string)($authUser['role'] ?? ''))) !== 'admin') {
    jsonResponse([
        'success' => false,
        'error' => 'Admin authorization required.'
    ], 403);
}

$secretKey = getAdmobEncryptionKey();
if (empty($secretKey)) {
    jsonResponse([
        'success' => false,
        'error' => 'ADMOB_ENCRYPTION_KEY is not configured on the server.'
    ], 500);
}

$oauthConfig = getAdmobOAuthConfig();
if (!$oauthConfig['isConfigured']) {
    jsonResponse([
        'success' => false,
        'error' => 'Google AdMob OAuth client credentials are not configured on the server.'
    ], 500);
}

$payloadRes = readStrictAdmobJsonPayload();
if (!$payloadRes['ok']) {
    jsonResponse(['success' => false, 'error' => $payloadRes['error']], $payloadRes['status']);
}
$input = $payloadRes['data'];

$hasExplicitMonth = array_key_exists('reportMonth', $input) || array_key_exists('report_month', $input);
$rawMonth = trim((string)($input['reportMonth'] ?? ($input['report_month'] ?? '')));
if ($hasExplicitMonth && $rawMonth !== '' && !preg_match('/^(\d{4})-(0[1-9]|1[0-2])$/', $rawMonth)) {
    jsonResponse([
        'success' => false,
        'error' => "Invalid reportMonth format '{$rawMonth}'. Expected YYYY-MM."
    ], 400);
}
if ($hasExplicitMonth && $rawMonth === '') {
    // Explicitly passed empty string is invalid format
    jsonResponse([
        'success' => false,
        'error' => "Invalid reportMonth format ''. Expected YYYY-MM."
    ], 400);
}

$requestedAppId = isset($input['appId']) ? (string)$input['appId'] : (isset($input['app_id']) ? (string)$input['app_id'] : null);
$appRes = resolveFaceTubeAdmobAppId($requestedAppId);
if (!$appRes['ok']) {
    jsonResponse(['success' => false, 'error' => $appRes['error']], $appRes['status']);
}
$appId = $appRes['appId'];

// 1. Load active encrypted OAuth credential
try {
    $stmtCred = $pdo->query('
        SELECT id, publisher_id, account_name, currency_code,
               encrypted_refresh_token, refresh_token_iv, refresh_token_tag, is_active
        FROM admob_oauth_credentials
        WHERE is_active = 1
        ORDER BY updated_at DESC
        LIMIT 1
    ');
    $credRow = $stmtCred ? $stmtCred->fetch(PDO::FETCH_ASSOC) : null;
} catch (Throwable $e) {
    error_log('[admob/sync-report.php] Failed loading OAuth credentials: ' . $e->getMessage());
    jsonResponse([
        'success' => false,
        'error' => isAdmobConnectionUnavailableError($e)
            ? 'Database connection unavailable.'
            : 'AdMob OAuth database table is uninitialized or inaccessible.'
    ], isAdmobConnectionUnavailableError($e) ? 503 : 500);
}

if (!$credRow || empty($credRow['publisher_id'])) {
    jsonResponse([
        'success' => false,
        'error' => 'Google AdMob OAuth account is not connected.'
    ], 409);
}

$publisherId = trim((string)$credRow['publisher_id']);
if ($publisherId === 'pub-3940256099942544' || !preg_match('/^pub-[a-zA-Z0-9]+$/', $publisherId)) {
    jsonResponse([
        'success' => false,
        'error' => 'Connected AdMob publisher ID is missing, invalid, or matched test ID.'
    ], 400);
}

// 2. Refresh OAuth access token server-side
$tokenRes = refreshAdmobAccessToken($pdo, $credRow, $secretKey);
if (!$tokenRes['ok']) {
    jsonResponse(['success' => false, 'error' => $tokenRes['error']], $tokenRes['status']);
}
$accessToken = $tokenRes['accessToken'];

// 3. Verify live Google PublisherAccount currency === INR and valid reportingTimeZone
$accountRes = fetchAndVerifyGoogleAdmobAccount($publisherId, $accessToken);
if (!$accountRes['ok']) {
    jsonResponse(['success' => false, 'error' => $accountRes['error']], $accountRes['status']);
}

$reportingTimeZone = $accountRes['reportingTimeZone'];
if ($rawMonth === '') {
    $defaultMonthRes = resolveDefaultAdmobReportMonth($reportingTimeZone);
    if (!$defaultMonthRes['ok']) {
        jsonResponse(['success' => false, 'error' => $defaultMonthRes['error']], $defaultMonthRes['status']);
    }
    $rawMonth = $defaultMonthRes['reportMonth'];
}

$period = computeAdmobMonthPeriod($rawMonth, $reportingTimeZone, false);
if (!$period['ok']) {
    jsonResponse(['success' => false, 'error' => $period['error']], $period['status']);
}

// Persist verified currencyCode & reportingTimeZone back to admob_oauth_credentials (safe if column exists)
try {
    $stmtUpdCred = $pdo->prepare('UPDATE admob_oauth_credentials SET currency_code = ?, reporting_time_zone = ?, updated_at = NOW() WHERE id = ?');
    $stmtUpdCred->execute(['INR', $reportingTimeZone, $credRow['id']]);
} catch (Throwable $ignoreTzErr) {
    try {
        $stmtUpdCurr = $pdo->prepare('UPDATE admob_oauth_credentials SET currency_code = ?, updated_at = NOW() WHERE id = ?');
        $stmtUpdCurr->execute(['INR', $credRow['id']]);
    } catch (Throwable $ignoreCurrErr) {
        // Non-fatal metadata sync
    }
}

// 4. Query Google AdMob networkReport:generate filtered strictly to FaceTube Android App ID
$reportRes = fetchGoogleAdmobNetworkReport($publisherId, $accessToken, $appId, $period);
if (!$reportRes['ok']) {
    jsonResponse(['success' => false, 'error' => $reportRes['error']], $reportRes['status']);
}

// 5. Idempotently upsert staging snapshot inside bounded-retry transaction (zero wallet/ledger mutations)
$adminUserId = (string)($authUser['user_id'] ?? 'ADMIN');
$maxTxAttempts = 3;
$snapshot = null;

for ($attempt = 1; $attempt <= $maxTxAttempts; $attempt++) {
    try {
        $pdo->beginTransaction();

        $stmtLock = $pdo->prepare('
            SELECT id, status, sync_count
            FROM admob_report_snapshots
            WHERE publisher_id = ? AND app_id = ? AND report_month = ?
            LIMIT 1
            FOR UPDATE
        ');
        $stmtLock->execute([$publisherId, $appId, $period['reportMonth']]);
        $existing = $stmtLock->fetch(PDO::FETCH_ASSOC);

        if ($existing && ($existing['status'] ?? '') === 'verified_finalized') {
            $pdo->rollBack();
            jsonResponse([
                'success' => false,
                'error' => "AdMob company snapshot for {$period['reportMonth']} is already verified_finalized and cannot be overwritten by API sync."
            ], 409);
        }

        if ($existing) {
            $stmtUpd = $pdo->prepare('
                UPDATE admob_report_snapshots
                SET period_start = ?,
                    period_end = ?,
                    reporting_time_zone = ?,
                    currency_code = ?,
                    estimated_earnings_micros = ?,
                    estimated_earnings = ?,
                    impressions = ?,
                    clicks = ?,
                    ad_requests = ?,
                    matched_requests = ?,
                    sync_count = sync_count + 1,
                    synced_by = ?,
                    synced_at = NOW(),
                    updated_at = NOW()
                WHERE id = ?
            ');
            $stmtUpd->execute([
                $period['periodStart'],
                $period['periodEnd'],
                $reportingTimeZone,
                'INR',
                $reportRes['estimatedEarningsMicros'],
                $reportRes['estimatedEarningsDecimal'],
                $reportRes['impressions'],
                $reportRes['clicks'],
                $reportRes['adRequests'],
                $reportRes['matchedRequests'],
                $adminUserId,
                $existing['id'],
            ]);
        } else {
            $stmtIns = $pdo->prepare('
                INSERT INTO admob_report_snapshots (
                    publisher_id, app_id, report_month, period_start, period_end,
                    reporting_time_zone, currency_code, estimated_earnings_micros,
                    estimated_earnings, impressions, clicks, ad_requests, matched_requests,
                    ownership_scope, status, sync_count, synced_by, synced_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, NOW())
            ');
            $stmtIns->execute([
                $publisherId,
                $appId,
                $period['reportMonth'],
                $period['periodStart'],
                $period['periodEnd'],
                $reportingTimeZone,
                'INR',
                $reportRes['estimatedEarningsMicros'],
                $reportRes['estimatedEarningsDecimal'],
                $reportRes['impressions'],
                $reportRes['clicks'],
                $reportRes['adRequests'],
                $reportRes['matchedRequests'],
                'COMPANY_100_PERCENT',
                'staged_estimated',
                $adminUserId,
            ]);
        }

        $stmtRead = $pdo->prepare('
            SELECT id, publisher_id, app_id, report_month, period_start, period_end,
                   reporting_time_zone, currency_code, estimated_earnings_micros,
                   estimated_earnings, impressions, clicks, ad_requests, matched_requests,
                   ownership_scope, status, sync_count, synced_by, synced_at,
                   verified_by, verified_at, verification_notes, created_at, updated_at
            FROM admob_report_snapshots
            WHERE publisher_id = ? AND app_id = ? AND report_month = ?
            LIMIT 1
        ');
        $stmtRead->execute([$publisherId, $appId, $period['reportMonth']]);
        $snapshot = $stmtRead->fetch(PDO::FETCH_ASSOC);

        $pdo->commit();
        break;
    } catch (Throwable $e) {
        try {
            if ($pdo->inTransaction()) {
                $pdo->rollBack();
            }
        } catch (Throwable $_ignored) {}

        if (isAdmobRetryableConcurrencyError($e)) {
            if ($attempt < $maxTxAttempts) {
                usleep(25000 * $attempt);
                continue;
            }
            error_log('[admob/sync-report.php][DB] Concurrency conflict exhausted retries: ' . $e->getMessage());
            jsonResponse([
                'success' => false,
                'error' => 'Concurrent AdMob report sync conflict in progress. Please retry in a moment.'
            ], 409);
        }

        error_log('[admob/sync-report.php][DB] Error persisting snapshot: ' . $e->getMessage());
        jsonResponse([
            'success' => false,
            'error' => isAdmobConnectionUnavailableError($e)
                ? 'Database connection unavailable while saving AdMob staging snapshot.'
                : 'Database error saving AdMob staging snapshot.'
        ], isAdmobConnectionUnavailableError($e) ? 503 : 500);
    }
}

jsonResponse([
    'success' => true,
    'message' => "Synced FaceTube AdMob company staging report for {$period['reportMonth']} (INR).",
    'snapshot' => $snapshot,
    'companyOwnership' => '100% FaceTube',
    'walletCredited' => false,
    'ledgerPosted' => false,
], 200);
