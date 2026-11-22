<?php
/**
 * FaceTube - Admin AdMob Closed-Month Staging Verification API
 * POST /api/admin/admob/verify-report.php
 *
 * Strictly restricted to verified Administrators.
 * Resolves the active publisher_id from admob_oauth_credentials and enforces
 * (publisher_id, app_id, report_month) scoping + valid reportingTimeZone.
 * Verifies a closed-month snapshot in admob_report_snapshots ONLY.
 * Does NOT write to wallet_balances, income_ledger, or admob_monthly_statements.
 */

require_once __DIR__ . '/admob-reporting.php';

if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    jsonResponse(['success' => false, 'error' => 'Method Not Allowed'], 405);
}

$pdo = getDatabaseConnection();
try {
    $authUser = getAuthUser($pdo, true);
} catch (Throwable $e) {
    error_log('[admob/verify-report.php][AUTH] Database error: ' . $e->getMessage());
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

$payloadRes = readStrictAdmobJsonPayload();
if (!$payloadRes['ok']) {
    jsonResponse(['success' => false, 'error' => $payloadRes['error']], $payloadRes['status']);
}
$input = $payloadRes['data'];

$rawMonth = trim((string)($input['reportMonth'] ?? ($input['report_month'] ?? '')));
$verificationNotes = trim((string)($input['verificationNotes'] ?? ($input['verification_notes'] ?? '')));
$requestedAppId = isset($input['appId']) ? (string)$input['appId'] : (isset($input['app_id']) ? (string)$input['app_id'] : null);
$requestedPublisherId = trim((string)($input['publisherId'] ?? ($input['publisher_id'] ?? '')));

if (!preg_match('/^(\d{4})-(0[1-9]|1[0-2])$/', $rawMonth)) {
    jsonResponse([
        'success' => false,
        'error' => "Invalid reportMonth format '{$rawMonth}'. Expected YYYY-MM."
    ], 400);
}

$appRes = resolveFaceTubeAdmobAppId($requestedAppId);
if (!$appRes['ok']) {
    jsonResponse(['success' => false, 'error' => $appRes['error']], $appRes['status']);
}
$appId = $appRes['appId'];

// Resolve active connected publisher_id from AdMob OAuth credentials
try {
    $stmtCred = $pdo->query('
        SELECT id, publisher_id, is_active
        FROM admob_oauth_credentials
        WHERE is_active = 1
        ORDER BY updated_at DESC
        LIMIT 1
    ');
    $credRow = $stmtCred ? $stmtCred->fetch(PDO::FETCH_ASSOC) : null;
} catch (Throwable $e) {
    error_log('[admob/verify-report.php] Failed loading OAuth credentials: ' . $e->getMessage());
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

$activePublisherId = trim((string)$credRow['publisher_id']);
if ($activePublisherId === 'pub-3940256099942544' || !preg_match('/^pub-[a-zA-Z0-9]+$/', $activePublisherId)) {
    jsonResponse([
        'success' => false,
        'error' => 'Connected AdMob publisher ID is missing, invalid, or matched test ID.'
    ], 400);
}

if ($requestedPublisherId !== '' && $requestedPublisherId !== $activePublisherId) {
    jsonResponse([
        'success' => false,
        'error' => 'Cannot verify AdMob snapshot for a different publisher account than the active connected publisher.'
    ], 403);
}

$adminUserId = (string)($authUser['user_id'] ?? 'ADMIN');

try {
    $pdo->beginTransaction();

    $stmtLock = $pdo->prepare('
        SELECT id, publisher_id, app_id, report_month, reporting_time_zone,
               currency_code, status
        FROM admob_report_snapshots
        WHERE publisher_id = ? AND app_id = ? AND report_month = ?
        LIMIT 1
        FOR UPDATE
    ');
    $stmtLock->execute([$activePublisherId, $appId, $rawMonth]);
    $row = $stmtLock->fetch(PDO::FETCH_ASSOC);

    if (!$row) {
        $stmtOther = $pdo->prepare('
            SELECT id, publisher_id
            FROM admob_report_snapshots
            WHERE app_id = ? AND report_month = ?
            LIMIT 1
        ');
        $stmtOther->execute([$appId, $rawMonth]);
        $otherRow = $stmtOther->fetch(PDO::FETCH_ASSOC);
        $pdo->rollBack();

        if ($otherRow) {
            jsonResponse([
                'success' => false,
                'error' => "AdMob snapshot for {$rawMonth} belongs to a different publisher account and cannot be verified under the active publisher."
            ], 403);
        }

        jsonResponse([
            'success' => false,
            'error' => "No staged AdMob report snapshot found for {$rawMonth}. Sync the report first."
        ], 404);
    }

    if (strtoupper((string)($row['currency_code'] ?? '')) !== 'INR') {
        $pdo->rollBack();
        jsonResponse([
            'success' => false,
            'error' => 'Cannot verify snapshot: currency_code is not INR.'
        ], 422);
    }

    // Never silently fall back to UTC when stored reporting_time_zone is invalid or missing
    $period = computeAdmobMonthPeriod($rawMonth, $row['reporting_time_zone'] ?? null, false);
    if (!$period['ok']) {
        $pdo->rollBack();
        jsonResponse(['success' => false, 'error' => $period['error']], $period['status']);
    }
    if (!$period['isClosedMonth']) {
        $pdo->rollBack();
        jsonResponse([
            'success' => false,
            'error' => "Reporting month '{$rawMonth}' has not closed yet in {$period['reportingTimeZone']}. Admin verification is only permitted after month-end close."
        ], 400);
    }

    if (($row['status'] ?? '') === 'verified_finalized') {
        $pdo->rollBack();
        jsonResponse([
            'success' => false,
            'error' => "AdMob staging snapshot for {$rawMonth} is already verified_finalized."
        ], 409);
    }

    $stmtUpd = $pdo->prepare('
        UPDATE admob_report_snapshots
        SET status = ?,
            verified_by = ?,
            verified_at = NOW(),
            verification_notes = ?,
            updated_at = NOW()
        WHERE id = ?
    ');
    $stmtUpd->execute([
        'verified_finalized',
        $adminUserId,
        $verificationNotes !== '' ? $verificationNotes : null,
        $row['id'],
    ]);

    $stmtRead = $pdo->prepare('
        SELECT id, publisher_id, app_id, report_month, period_start, period_end,
               reporting_time_zone, currency_code, estimated_earnings_micros,
               estimated_earnings, impressions, clicks, ad_requests, matched_requests,
               ownership_scope, status, sync_count, synced_by, synced_at,
               verified_by, verified_at, verification_notes, created_at, updated_at
        FROM admob_report_snapshots
        WHERE id = ?
        LIMIT 1
    ');
    $stmtRead->execute([$row['id']]);
    $snapshot = $stmtRead->fetch(PDO::FETCH_ASSOC);

    $pdo->commit();

    jsonResponse([
        'success' => true,
        'message' => "AdMob company staging snapshot for {$rawMonth} marked verified_finalized (no creator wallet or ledger posting performed).",
        'snapshot' => $snapshot,
        'walletCredited' => false,
        'ledgerPosted' => false,
    ], 200);
} catch (Throwable $e) {
    try {
        if ($pdo->inTransaction()) {
            $pdo->rollBack();
        }
    } catch (Throwable $_ignored) {}
    error_log('[admob/verify-report.php][DB] Error verifying snapshot: ' . $e->getMessage());
    jsonResponse([
        'success' => false,
        'error' => isAdmobConnectionUnavailableError($e)
            ? 'Database connection unavailable while verifying AdMob snapshot.'
            : 'Database error verifying AdMob snapshot.'
    ], isAdmobConnectionUnavailableError($e) ? 503 : 500);
}
