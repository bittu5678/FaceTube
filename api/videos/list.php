<?php
/**
 * FaceTube - List Videos API
 * GET /api/videos/list.php
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

// Optional authentication: supports public visitors while propagating DB auth errors
try {
    $authUser = getAuthUser($pdo, true);
} catch (Throwable $authErr) {
    error_log('[videos/list.php] Auth Database Exception: ' . $authErr->getMessage());
    if ($isConnectionUnavailable($authErr)) {
        jsonResponse(['success' => false, 'error' => 'Database connection unavailable during authentication. Please try again.'], 503);
    }
    jsonResponse(['success' => false, 'error' => 'Authentication service error while listing videos.'], 500);
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
$videoType = strtolower(trim((string)($_GET['videoType'] ?? ($_GET['video_type'] ?? ''))));
$contentType = strtolower(trim((string)($_GET['contentType'] ?? ($_GET['content_type'] ?? ''))));
$category = trim((string)($_GET['category'] ?? ''));
$search = trim((string)($_GET['search'] ?? ($_GET['q'] ?? '')));
$limit = max(1, min(100, intval($_GET['limit'] ?? 50)));
$offset = max(0, intval($_GET['offset'] ?? 0));

$isOwnerFilter = false;
if ($authUser && $userId !== '') {
    $isOwnerFilter = strcasecmp($userId, $authUserId) === 0
        || (!empty($authUser['id']) && strcasecmp($userId, (string)$authUser['id']) === 0);
}
$filterUserId = ($isOwnerFilter && $authUserId !== '') ? $authUserId : $userId;

$where = [];
$params = [];

if (!$includeBlocked) {
    $where[] = 'COALESCE(v.is_blocked, 0) = 0';
}

// Public and cross-user discovery: restrict to public, non-blocked, payment-eligible videos
if (!$isAdmin && !$isOwnerFilter) {
    $where[] = "COALESCE(NULLIF(v.visibility, ''), 'public') = 'public'";
    $where[] = "((v.video_type = 'free' AND COALESCE(NULLIF(v.payment_status, ''), 'not_required') IN ('not_required', 'paid')) OR (v.video_type = 'premium' AND v.payment_status = 'paid'))";
}

if ($filterUserId !== '') {
    $where[] = 'UPPER(v.user_id) = UPPER(?)';
    $params[] = $filterUserId;
}

if ($videoType !== '' && in_array($videoType, ['free', 'premium'], true)) {
    $where[] = 'v.video_type = ?';
    $params[] = $videoType;
}

if ($contentType !== '' && in_array($contentType, ['short', 'long'], true)) {
    $where[] = 'v.content_type = ?';
    $params[] = $contentType;
}

if ($category !== '' && strcasecmp($category, 'All') !== 0) {
    $where[] = 'LOWER(v.category) = LOWER(?)';
    $params[] = $category;
}

if ($search !== '') {
    $where[] = '(v.title LIKE ? OR v.description LIKE ? OR v.creator_name LIKE ? OR COALESCE(u.channel_name, "") LIKE ?)';
    $like = "%{$search}%";
    $params[] = $like;
    $params[] = $like;
    $params[] = $like;
    $params[] = $like;
}

$whereSql = !empty($where) ? 'WHERE ' . implode(' AND ', $where) : '';

try {
    $sql = "
        SELECT 
            v.id, v.user_id, v.creator_name, v.title, v.description, v.video_url, v.thumbnail_url,
            v.video_type, v.content_type, v.category, v.duration, v.views, v.likes,
            v.payment_status, v.payment_id, v.payment_amount, v.is_promoted, v.visibility,
            COALESCE(v.is_blocked, 0) AS is_blocked, v.block_reason, v.blocked_at,
            v.promotion_plan, v.promotion_expires_at, v.created_at, v.updated_at,
            (v.is_promoted = 1 AND v.promotion_expires_at IS NOT NULL AND v.promotion_expires_at > NOW()) AS is_active_promoted,
            u.channel_logo_url AS creator_channel_logo_url,
            u.channel_name AS creator_channel_name
        FROM uploaded_videos v
        LEFT JOIN users u ON UPPER(u.user_id) = UPPER(v.user_id)
        {$whereSql}
        ORDER BY is_active_promoted DESC, v.created_at DESC
        LIMIT {$limit} OFFSET {$offset}
    ";

    $stmt = $pdo->prepare($sql);
    $stmt->execute($params);
    $rows = $stmt->fetchAll();

    $videos = array_map(function ($row) {
        $expiryTime = !empty($row['promotion_expires_at']) ? strtotime($row['promotion_expires_at']) : false;
        $isActivePromoted = !empty($row['is_promoted']) && $expiryTime !== false && $expiryTime > time();
        $channelLogoUrl = !empty($row['creator_channel_logo_url'])
            ? toAbsoluteMediaUrl($row['creator_channel_logo_url'], 'logos')
            : null;
        $channelName = !empty($row['creator_channel_name'])
            ? $row['creator_channel_name']
            : ($row['creator_name'] ?? 'FaceTube Creator');
        $visibility = strtolower(trim((string)($row['visibility'] ?? 'public')));
        if (!in_array($visibility, ['public', 'unlisted', 'private'], true)) {
            $visibility = 'public';
        }
        $isBlocked = !empty($row['is_blocked']);

        return [
            'id' => $row['id'],
            'userId' => $row['user_id'],
            'user_id' => $row['user_id'],
            'creatorName' => $channelName,
            'creator_name' => $channelName,
            'channelName' => $channelName,
            'channel_name' => $channelName,
            'channelLogoUrl' => $channelLogoUrl,
            'channel_logo_url' => $channelLogoUrl,
            'title' => $row['title'],
            'description' => $row['description'] ?? '',
            'videoUrl' => toAbsoluteMediaUrl($row['video_url'], 'videos'),
            'video_url' => toAbsoluteMediaUrl($row['video_url'], 'videos'),
            'thumbnailUrl' => toAbsoluteMediaUrl($row['thumbnail_url'] ?? '', 'images'),
            'thumbnail_url' => toAbsoluteMediaUrl($row['thumbnail_url'] ?? '', 'images'),
            'videoType' => $row['video_type'],
            'video_type' => $row['video_type'],
            'contentType' => $row['content_type'],
            'content_type' => $row['content_type'],
            'category' => $row['category'] ?? 'General',
            'duration' => $row['duration'] ?? '0:00',
            'visibility' => $visibility,
            'views' => (int)$row['views'],
            'likes' => (int)$row['likes'],
            'paymentStatus' => $row['payment_status'],
            'payment_status' => $row['payment_status'],
            'paymentId' => $row['payment_id'],
            'payment_id' => $row['payment_id'],
            'paymentAmount' => (float)$row['payment_amount'],
            'payment_amount' => (float)$row['payment_amount'],
            'isPromoted' => (bool)$isActivePromoted,
            'is_promoted' => (bool)$isActivePromoted,
            'isActivePromoted' => (bool)$isActivePromoted,
            'is_active_promoted' => (bool)$isActivePromoted,
            'rawIsPromoted' => (bool)$row['is_promoted'],
            'raw_is_promoted' => (bool)$row['is_promoted'],
            'isBlocked' => $isBlocked,
            'is_blocked' => $isBlocked,
            'blockReason' => $row['block_reason'] ?? null,
            'block_reason' => $row['block_reason'] ?? null,
            'blockedAt' => $row['blocked_at'] ?? null,
            'blocked_at' => $row['blocked_at'] ?? null,
            'promotionPlan' => $row['promotion_plan'],
            'promotion_plan' => $row['promotion_plan'],
            'promotionExpiresAt' => $row['promotion_expires_at'],
            'promotion_expires_at' => $row['promotion_expires_at'],
            'createdAt' => $row['created_at'],
            'created_at' => $row['created_at'],
            'updatedAt' => $row['updated_at'],
            'updated_at' => $row['updated_at'],
        ];
    }, $rows);

    jsonResponse([
        'success' => true,
        'videos' => $videos,
        'total' => count($videos),
        'limit' => $limit,
        'offset' => $offset,
    ]);
} catch (Throwable $e) {
    error_log('[videos/list.php] Database Exception: ' . $e->getMessage());
    if ($isConnectionUnavailable($e)) {
        jsonResponse(['success' => false, 'error' => 'Database connection unavailable while listing videos.'], 503);
    }
    jsonResponse(['success' => false, 'error' => 'Database error while fetching videos.'], 500);
}
