<?php
/**
 * FaceTube - Admin Country-wise Video Counts API
 * GET /api/admin/video-country-counts.php
 *
 * Strictly restricted to authenticated administrators.
 * Aggregates directly on `uploaded_videos` via SQL GROUP BY without joining 1:N tables.
 *
 * Locked business rules:
 * - Include public, unlisted, and private videos.
 * - Include blocked videos (reported separately as an overlapping metric).
 * - Include eligible Free videos (payment_status IN ('not_required', 'paid') or legacy blank).
 * - Include Premium videos ONLY when payment_status = 'paid' (exclude pending/failed).
 * - Free + eligible Premium = totalVideos.
 * - Active Ads = overlapping non-additive count (is_promoted = 1 AND promotion_expires_at > NOW()).
 * - NULL/blank/invalid country codes map to UNKNOWN ("Unknown / Unassigned").
 */

require_once __DIR__ . '/../config/database.php';
require_once __DIR__ . '/../response.php';
require_once __DIR__ . '/../country-utils.php';

if (($_SERVER['REQUEST_METHOD'] ?? '') !== 'GET') {
    jsonResponse(['success' => false, 'error' => 'Method Not Allowed'], 405);
}

$pdo = getDatabaseConnection();

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

try {
    $authUser = getAuthUser($pdo, true);
} catch (Throwable $authErr) {
    error_log('[admin/video-country-counts.php][AUTH] Database error: ' . $authErr->getMessage());
    if ($isConnectionUnavailable($authErr)) {
        jsonResponse([
            'success' => false,
            'error' => 'Database connection unavailable during authentication check.'
        ], 503);
    }
    jsonResponse([
        'success' => false,
        'error' => 'Authentication service error while verifying admin access.'
    ], 500);
}

if (!$authUser || empty($authUser['user_id'])) {
    jsonResponse([
        'success' => false,
        'error' => 'Authentication required. Please provide a valid Bearer session token.'
    ], 401);
}

if (strtolower(trim((string)($authUser['role'] ?? ''))) !== 'admin') {
    jsonResponse([
        'success' => false,
        'error' => 'Admin authorization required. Only verified administrators can access country analytics.'
    ], 403);
}

try {
    $hasCountryCodeCol = false;
    try {
        $colStmt = $pdo->query("
            SELECT 1
            FROM INFORMATION_SCHEMA.COLUMNS
            WHERE TABLE_SCHEMA = DATABASE()
              AND TABLE_NAME = 'uploaded_videos'
              AND COLUMN_NAME = 'country_code'
            LIMIT 1
        ");
        if ($colStmt && $colStmt->fetchColumn()) {
            $hasCountryCodeCol = true;
        }
    } catch (Throwable $_eCol) {
        $hasCountryCodeCol = false;
    }

    $countryExpr = $hasCountryCodeCol
        ? "COALESCE(NULLIF(UPPER(TRIM(country_code)), ''), 'UNKNOWN')"
        : "'UNKNOWN'";

    $sql = "
        SELECT
            {$countryExpr} AS country_code,
            COUNT(*) AS total_videos,
            COALESCE(SUM(CASE WHEN video_type = 'free' THEN 1 ELSE 0 END), 0) AS free_videos,
            COALESCE(SUM(CASE WHEN video_type = 'premium' THEN 1 ELSE 0 END), 0) AS premium_videos,
            COALESCE(SUM(CASE WHEN is_promoted = 1 AND promotion_expires_at IS NOT NULL AND promotion_expires_at > NOW() THEN 1 ELSE 0 END), 0) AS active_ads_videos,
            COALESCE(SUM(CASE WHEN COALESCE(is_blocked, 0) = 1 THEN 1 ELSE 0 END), 0) AS blocked_videos
        FROM uploaded_videos
        WHERE (
            (video_type = 'free' AND COALESCE(NULLIF(LOWER(TRIM(payment_status)), ''), 'not_required') IN ('not_required', 'paid'))
            OR
            (video_type = 'premium' AND LOWER(TRIM(payment_status)) = 'paid')
        )
        GROUP BY {$countryExpr}
    ";

    $stmt = $pdo->query($sql);
    $rows = $stmt ? $stmt->fetchAll(PDO::FETCH_ASSOC) : [];

    // Canonicalize & merge any unexpected non-ISO keys into UNKNOWN
    $grouped = [];
    foreach ($rows as $row) {
        $normCode = ftNormalizeCountryCode($row['country_code'] ?? '');
        $free = (int)($row['free_videos'] ?? 0);
        $premium = (int)($row['premium_videos'] ?? 0);
        $total = $free + $premium;
        $activeAds = (int)($row['active_ads_videos'] ?? 0);
        $blocked = (int)($row['blocked_videos'] ?? 0);

        if (!isset($grouped[$normCode])) {
            $grouped[$normCode] = [
                'countryCode' => $normCode,
                'countryName' => ftGetCountryName($normCode),
                'totalVideos' => 0,
                'freeVideos' => 0,
                'premiumVideos' => 0,
                'activeAdsVideos' => 0,
                'blockedVideos' => 0,
            ];
        }

        $grouped[$normCode]['totalVideos'] += $total;
        $grouped[$normCode]['freeVideos'] += $free;
        $grouped[$normCode]['premiumVideos'] += $premium;
        $grouped[$normCode]['activeAdsVideos'] += $activeAds;
        $grouped[$normCode]['blockedVideos'] += $blocked;
    }

    $countries = array_values($grouped);
    usort($countries, static function (array $a, array $b): int {
        if ($a['totalVideos'] !== $b['totalVideos']) {
            return $b['totalVideos'] <=> $a['totalVideos'];
        }
        $aIsUnknown = $a['countryCode'] === FT_UNKNOWN_COUNTRY_CODE;
        $bIsUnknown = $b['countryCode'] === FT_UNKNOWN_COUNTRY_CODE;
        if ($aIsUnknown !== $bIsUnknown) {
            return $aIsUnknown ? 1 : -1;
        }
        return strcmp($a['countryCode'], $b['countryCode']);
    });

    $summaryTotal = 0;
    $summaryFree = 0;
    $summaryPremium = 0;
    $summaryActiveAds = 0;
    $summaryBlocked = 0;
    $identifiedCountries = 0;
    $unknownVideos = 0;

    foreach ($countries as $entry) {
        $summaryTotal += $entry['totalVideos'];
        $summaryFree += $entry['freeVideos'];
        $summaryPremium += $entry['premiumVideos'];
        $summaryActiveAds += $entry['activeAdsVideos'];
        $summaryBlocked += $entry['blockedVideos'];
        if ($entry['countryCode'] === FT_UNKNOWN_COUNTRY_CODE) {
            $unknownVideos += $entry['totalVideos'];
        } else {
            $identifiedCountries++;
        }
    }

    jsonResponse([
        'success' => true,
        'countries' => $countries,
        'summary' => [
            'totalCountries' => $identifiedCountries,
            'hasUnknown' => $unknownVideos > 0,
            'unknownVideos' => $unknownVideos,
            'totalVideos' => $summaryTotal,
            'freeVideos' => $summaryFree,
            'premiumVideos' => $summaryPremium,
            'activeAdsVideos' => $summaryActiveAds,
            'blockedVideos' => $summaryBlocked,
        ],
        'migrationPending' => !$hasCountryCodeCol,
    ]);
} catch (Throwable $e) {
    error_log('[admin/video-country-counts.php] Database Exception: ' . $e->getMessage());
    if ($isConnectionUnavailable($e)) {
        jsonResponse([
            'success' => false,
            'error' => 'Database connection unavailable while fetching country video counts.'
        ], 503);
    }
    jsonResponse([
        'success' => false,
        'error' => 'Database error while fetching country video counts.'
    ], 500);
}
