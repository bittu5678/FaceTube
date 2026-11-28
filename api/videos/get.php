<?php
/**
 * FaceTube - Get Single Video API
 * GET /api/videos/get.php
 */

require_once __DIR__ . '/../config/database.php';
require_once __DIR__ . '/../response.php';

if ($_SERVER['REQUEST_METHOD'] !== 'GET') {
    jsonResponse(['success' => false, 'error' => 'Method Not Allowed'], 405);
}

$id = trim((string)($_GET['id'] ?? ''));

if (empty($id)) {
    jsonResponse(['success' => false, 'error' => 'Video ID is required.'], 400);
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
    error_log('[videos/get.php] Auth Database Exception: ' . $authErr->getMessage());
    if ($isConnectionUnavailable($authErr)) {
        jsonResponse(['success' => false, 'error' => 'Database connection unavailable during authentication. Please try again.'], 503);
    }
    jsonResponse(['success' => false, 'error' => 'Authentication service error while loading video.'], 500);
}

try {
    $stmt = $pdo->prepare('
        SELECT
            v.*,
            u.channel_logo_url AS creator_channel_logo_url,
            u.channel_name AS creator_channel_name
        FROM uploaded_videos v
        LEFT JOIN users u ON UPPER(u.user_id) = UPPER(v.user_id)
        WHERE v.id = ?
        LIMIT 1
    ');
    $stmt->execute([$id]);
    $row = $stmt->fetch();

    if (!$row) {
        jsonResponse(['success' => false, 'error' => 'Video not found.'], 404);
    }

    // Blocked videos return 403 for everyone by default (including owners) before incrementing views
    if (!empty($row['is_blocked'])) {
        jsonResponse([
            'success' => false,
            'error' => 'This video has been blocked by administrators for content moderation.',
            'is_blocked' => true,
            'isBlocked' => true,
            'block_reason' => $row['block_reason'] ?? 'Content moderation',
        ], 403);
    }

    $isAdmin = $authUser && isset($authUser['role']) && strtolower((string)$authUser['role']) === 'admin';
    $isOwner = $authUser && (
        strcasecmp((string)($row['user_id'] ?? ''), (string)($authUser['user_id'] ?? '')) === 0
        || (!empty($authUser['id']) && strcasecmp((string)($row['user_id'] ?? ''), (string)$authUser['id']) === 0)
    );

    $rawVisibility = strtolower(trim((string)($row['visibility'] ?? '')));
    if ($rawVisibility === '') {
        $visibility = 'public';
    } elseif (in_array($rawVisibility, ['public', 'unlisted', 'private'], true)) {
        $visibility = $rawVisibility;
    } else {
        $visibility = 'private';
    }

    $videoType = strtolower(trim((string)($row['video_type'] ?? 'free')));
    $paymentStatus = strtolower(trim((string)($row['payment_status'] ?? '')));
    if ($paymentStatus === '') {
        $paymentStatus = $videoType === 'free' ? 'not_required' : 'pending';
    }
    $isPaymentEligible = ($videoType === 'free' && in_array($paymentStatus, ['not_required', 'paid'], true))
        || ($videoType === 'premium' && $paymentStatus === 'paid');

    if ($visibility === 'private' && !$isOwner && !$isAdmin) {
        if (!$authUser) {
            jsonResponse(['success' => false, 'error' => 'Authentication required to access this private video.'], 401);
        }
        jsonResponse(['success' => false, 'error' => 'Unauthorized: This private video is only accessible to its creator or administrators.'], 403);
    }

    if (!$isPaymentEligible && !$isOwner && !$isAdmin) {
        if (!$authUser) {
            jsonResponse(['success' => false, 'error' => 'Authentication required to access this unpaid Sponsor video.'], 401);
        }
        jsonResponse(['success' => false, 'error' => 'Unauthorized: Unpaid Sponsor videos are only accessible to their creator or administrators.'], 403);
    }

    $rawSkipView = strtolower(trim((string)($_GET['skipView'] ?? ($_GET['skip_view'] ?? ''))));
    $skipView = in_array($rawSkipView, ['1', 'true'], true);

    // Increment views ONLY after access authorization succeeds (unless skipView is requested)
    if (!$skipView) {
        $pdo->prepare('UPDATE uploaded_videos SET views = views + 1 WHERE id = ?')->execute([$id]);
    }

    $viewerLiked = false;
    if ($authUser) {
        $authUserId = trim((string)($authUser['user_id'] ?? ''));
        $authAltId = trim((string)($authUser['id'] ?? ''));
        $primaryLikeUid = $authUserId !== '' ? $authUserId : $authAltId;
        if ($primaryLikeUid !== '') {
            try {
                if ($authAltId !== '' && strcasecmp($authAltId, $primaryLikeUid) !== 0) {
                    $stmtLike = $pdo->prepare('SELECT id FROM video_likes WHERE video_id = ? AND (UPPER(user_id) = UPPER(?) OR UPPER(user_id) = UPPER(?)) LIMIT 1');
                    $stmtLike->execute([$id, $primaryLikeUid, $authAltId]);
                } else {
                    $stmtLike = $pdo->prepare('SELECT id FROM video_likes WHERE video_id = ? AND UPPER(user_id) = UPPER(?) LIMIT 1');
                    $stmtLike->execute([$id, $primaryLikeUid]);
                }
                $viewerLiked = (bool)$stmtLike->fetch();
            } catch (Throwable $_likeErr) {
                $viewerLiked = false;
            }
        }
    }

    $expiryTime = !empty($row['promotion_expires_at']) ? strtotime($row['promotion_expires_at']) : false;
    $isActivePromoted = !empty($row['is_promoted']) && $expiryTime !== false && $expiryTime > time();
    $channelLogoUrl = !empty($row['creator_channel_logo_url'])
        ? toAbsoluteMediaUrl($row['creator_channel_logo_url'], 'logos')
        : null;
    $channelName = !empty($row['creator_channel_name'])
        ? $row['creator_channel_name']
        : ($row['creator_name'] ?? 'FaceTube Creator');

    $video = [
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
        'views' => (int)$row['views'] + ($skipView ? 0 : 1),
        'likes' => (int)$row['likes'],
        'viewerLiked' => $viewerLiked,
        'viewer_liked' => $viewerLiked,
        'liked' => $viewerLiked,
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
        'isBlocked' => false,
        'is_blocked' => false,
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

    jsonResponse(['success' => true, 'video' => $video]);
} catch (Throwable $e) {
    error_log('[videos/get.php] Database Exception: ' . $e->getMessage());
    if ($isConnectionUnavailable($e)) {
        jsonResponse(['success' => false, 'error' => 'Database connection unavailable while loading video.'], 503);
    }
    jsonResponse(['success' => false, 'error' => 'Database error while fetching video.'], 500);
}
