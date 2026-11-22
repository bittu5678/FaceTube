<?php
/**
 * FaceTube - Admin AdMob Company Staging Snapshots List API
 * GET /api/admin/admob/reports.php
 *
 * Strictly restricted to verified Administrators.
 * Lists staged/verified AdMob company report snapshots from admob_report_snapshots.
 */

require_once __DIR__ . '/admob-reporting.php';

if ($_SERVER['REQUEST_METHOD'] !== 'GET') {
    jsonResponse(['success' => false, 'error' => 'Method Not Allowed'], 405);
}

$pdo = getDatabaseConnection();
try {
    $authUser = getAuthUser($pdo, true);
} catch (Throwable $e) {
    error_log('[admob/reports.php][AUTH] Database error: ' . $e->getMessage());
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

$reportMonth = trim((string)($_GET['reportMonth'] ?? ($_GET['report_month'] ?? '')));
if ($reportMonth !== '' && !preg_match('/^\d{4}-(0[1-9]|1[0-2])$/', $reportMonth)) {
    jsonResponse([
        'success' => false,
        'error' => "Invalid reportMonth filter '{$reportMonth}'. Expected YYYY-MM."
    ], 400);
}

$appRes = resolveFaceTubeAdmobAppId(null);
if (!$appRes['ok']) {
    jsonResponse(['success' => false, 'error' => $appRes['error']], $appRes['status']);
}
$appId = $appRes['appId'];

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
    error_log('[admob/reports.php][OAUTH] Database error: ' . $e->getMessage());
    jsonResponse([
        'success' => false,
        'error' => isAdmobConnectionUnavailableError($e)
            ? 'Database connection unavailable.'
            : 'AdMob OAuth database table is uninitialized or inaccessible.'
    ], isAdmobConnectionUnavailableError($e) ? 503 : 500);
}

$accountingNotice = '100% FaceTube company revenue staging only — no creator wallets or income_ledger entries affected.';

if (!$credRow || empty($credRow['publisher_id'])) {
    jsonResponse([
        'success' => true,
        'count' => 0,
        'snapshots' => [],
        'connected' => false,
        'accountingNotice' => $accountingNotice,
    ], 200);
}

$activePublisherId = trim((string)$credRow['publisher_id']);
if ($activePublisherId === 'pub-3940256099942544' || !preg_match('/^pub-[a-zA-Z0-9]+$/', $activePublisherId)) {
    jsonResponse([
        'success' => false,
        'error' => 'Connected AdMob publisher ID is missing, invalid, or matched test ID.'
    ], 400);
}

try {
    if ($reportMonth !== '') {
        $stmt = $pdo->prepare('
            SELECT id, publisher_id, app_id, report_month, period_start, period_end,
                   reporting_time_zone, currency_code, estimated_earnings_micros,
                   estimated_earnings, impressions, clicks, ad_requests, matched_requests,
                   ownership_scope, status, sync_count, synced_by, synced_at,
                   verified_by, verified_at, verification_notes, created_at, updated_at
            FROM admob_report_snapshots
            WHERE publisher_id = ? AND app_id = ? AND report_month = ?
            ORDER BY report_month DESC, synced_at DESC
        ');
        $stmt->execute([$activePublisherId, $appId, $reportMonth]);
    } else {
        $stmt = $pdo->prepare('
            SELECT id, publisher_id, app_id, report_month, period_start, period_end,
                   reporting_time_zone, currency_code, estimated_earnings_micros,
                   estimated_earnings, impressions, clicks, ad_requests, matched_requests,
                   ownership_scope, status, sync_count, synced_by, synced_at,
                   verified_by, verified_at, verification_notes, created_at, updated_at
            FROM admob_report_snapshots
            WHERE publisher_id = ? AND app_id = ?
            ORDER BY report_month DESC, synced_at DESC
        ');
        $stmt->execute([$activePublisherId, $appId]);
    }

    $snapshots = $stmt ? $stmt->fetchAll(PDO::FETCH_ASSOC) : [];

    jsonResponse([
        'success' => true,
        'count' => count($snapshots),
        'snapshots' => $snapshots,
        'accountingNotice' => $accountingNotice,
    ], 200);
} catch (Throwable $e) {
    error_log('[admob/reports.php][DB] Database error: ' . $e->getMessage());
    jsonResponse([
        'success' => false,
        'error' => isAdmobConnectionUnavailableError($e)
            ? 'Database connection unavailable while loading AdMob staging snapshots.'
            : 'Database error loading AdMob staging snapshots.'
    ], isAdmobConnectionUnavailableError($e) ? 503 : 500);
}
