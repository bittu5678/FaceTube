<?php
/**
 * FaceTube - Video Counts API
 * GET /api/videos/counts.php
 */

require_once __DIR__ . '/../config/database.php';
require_once __DIR__ . '/../response.php';

if ($_SERVER['REQUEST_METHOD'] !== 'GET') {
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

// Optional authentication: supports public counts while propagating DB auth errors
try {
    $authUser = getAuthUser($pdo, true);
} catch (Throwable $authErr) {
    error_log('[videos/counts.php] Auth Database Exception: ' . $authErr->getMessage());
    if ($isConnectionUnavailable($authErr)) {
        jsonResponse(['success' => false, 'error' => 'Database connection unavailable during authentication. Please try again.'], 503);
    }
    jsonResponse(['success' => false, 'error' => 'Authentication service error while fetching video counts.'], 500);
}

$isAdmin = $authUser && isset($authUser['role']) && strtolower((string)$authUser['role']) === 'admin';
$authUserId = $authUser ? trim((string)($authUser['user_id'] ?? '')) : '';

$rawIncludeBlocked = strtolower(trim((string)($_GET['include_blocked'] ?? ($_GET['includeBlocked'] ?? ''))));
$includeBlocked = in_array($rawIncludeBlocked, ['1', 'true'], true);

if ($includeBlocked) {
    if (!$authUser) {
        jsonResponse(['success' => false, 'error' => 'Authentication required. Admin session required to include blocked videos.'], 401);
    }
    if (!$isAdmin) {
        jsonResponse(['success' => false, 'error' => 'Unauthorized: include_blocked is restricted to verified administrators.'], 403);
    }
}

$userId = trim((string)($_GET['userId'] ?? ($_GET['user_id'] ?? '')));
$isOwnerCounts = false;
if ($authUser && $userId !== '') {
    $isOwnerCounts = strcasecmp($userId, $authUserId) === 0
        || (!empty($authUser['id']) && strcasecmp($userId, (string)$authUser['id']) === 0);
}
$filterUserId = ($isOwnerCounts && $authUserId !== '') ? $authUserId : $userId;

try {
    $where = [];
    $params = [];

    if (!$includeBlocked) {
        $where[] = 'COALESCE(is_blocked, 0) = 0';
    }

    // Public and cross-user counts exclude private, unlisted, blocked, and unpaid/pending/failed videos
    if (!$isAdmin && !$isOwnerCounts) {
        $where[] = "COALESCE(NULLIF(visibility, ''), 'public') = 'public'";
        $where[] = "((video_type = 'free' AND COALESCE(NULLIF(payment_status, ''), 'not_required') IN ('not_required', 'paid')) OR (video_type = 'premium' AND payment_status = 'paid'))";
    }

    if ($filterUserId !== '') {
        $where[] = 'UPPER(user_id) = UPPER(?)';
        $params[] = $filterUserId;
    }

    $whereSql = !empty($where) ? 'WHERE ' . implode(' AND ', $where) : '';

    $sql = "
        SELECT 
            COALESCE(SUM(CASE WHEN video_type = 'free' AND content_type = 'short' THEN 1 ELSE 0 END), 0) AS freeShort,
            COALESCE(SUM(CASE WHEN video_type = 'free' AND content_type = 'long' THEN 1 ELSE 0 END), 0) AS freeLong,
            COALESCE(SUM(CASE WHEN video_type = 'premium' AND content_type = 'short' THEN 1 ELSE 0 END), 0) AS premiumShort,
            COALESCE(SUM(CASE WHEN video_type = 'premium' AND content_type = 'long' THEN 1 ELSE 0 END), 0) AS premiumLong
        FROM uploaded_videos
        {$whereSql}
    ";

    $stmt = $pdo->prepare($sql);
    $stmt->execute($params);
    $counts = $stmt->fetch();

    $freeShort = intval($counts['freeShort'] ?? 0);
    $freeLong = intval($counts['freeLong'] ?? 0);
    $premiumShort = intval($counts['premiumShort'] ?? 0);
    $premiumLong = intval($counts['premiumLong'] ?? 0);

    jsonResponse([
        'success' => true,
        'counts' => [
            'freeShort' => $freeShort,
            'freeLong' => $freeLong,
            'premiumShort' => $premiumShort,
            'premiumLong' => $premiumLong,
            'totalFree' => $freeShort + $freeLong,
            'totalPremium' => $premiumShort + $premiumLong,
            'totalUploaded' => $freeShort + $freeLong + $premiumShort + $premiumLong,
        ]
    ]);
} catch (Throwable $e) {
    error_log('[videos/counts.php] Database Exception: ' . $e->getMessage());
    if ($isConnectionUnavailable($e)) {
        jsonResponse(['success' => false, 'error' => 'Database connection unavailable while fetching video counts.'], 503);
    }
    jsonResponse(['success' => false, 'error' => 'Database error while fetching video counts.'], 500);
}
