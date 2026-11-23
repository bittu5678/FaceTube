<?php
/**
 * FaceTube - Admin Video Moderation API
 * GET /api/admin/videos.php  - List all videos with moderation status
 * POST /api/admin/videos.php - Block/Unblock a video
 */

require_once __DIR__ . '/../config/database.php';
require_once __DIR__ . '/../response.php';

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
    error_log('[admin/videos.php] Auth Database Exception: ' . $authErr->getMessage());
    if ($isConnectionUnavailable($authErr)) {
        jsonResponse(['success' => false, 'error' => 'Database connection unavailable during authentication.'], 503);
    }
    jsonResponse(['success' => false, 'error' => 'Authentication service error.'], 500);
}

if (!$authUser) {
    jsonResponse(['success' => false, 'error' => 'Authentication required'], 401);
}

if (strtolower((string)($authUser['role'] ?? '')) !== 'admin') {
    jsonResponse(['success' => false, 'error' => 'Admin authorization required'], 403);
}

$method = $_SERVER['REQUEST_METHOD'];

if ($method === 'GET') {
    try {
        $stmt = $pdo->query('
            SELECT id, user_id, creator_name, title, description, video_url, thumbnail_url,
                   video_type, content_type, category, duration, views, likes,
                   payment_status, visibility, is_promoted,
                   COALESCE(is_blocked, 0) AS is_blocked, block_reason, blocked_at, created_at
            FROM uploaded_videos
            ORDER BY created_at DESC
        ');
        $rows = $stmt->fetchAll(PDO::FETCH_ASSOC);

        $videos = array_map(static function (array $row): array {
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
            return array_merge($row, [
                'visibility' => $visibility,
                'payment_status' => $paymentStatus,
                'is_blocked' => !empty($row['is_blocked']),
            ]);
        }, $rows);

        jsonResponse([
            'success' => true,
            'videos' => $videos,
            'counts' => [
                'total' => count($videos),
                'blocked' => count(array_filter($videos, fn($v) => !empty($v['is_blocked']))),
                'shorts' => count(array_filter($videos, fn($v) => ($v['content_type'] ?? '') === 'short')),
                'long' => count(array_filter($videos, fn($v) => ($v['content_type'] ?? '') === 'long')),
            ]
        ]);
    } catch (Throwable $e) {
        error_log('[admin/videos.php][GET] Database Exception: ' . $e->getMessage());
        if ($isConnectionUnavailable($e)) {
            jsonResponse(['success' => false, 'error' => 'Database connection unavailable while listing admin videos.'], 503);
        }
        jsonResponse(['success' => false, 'error' => 'Database error while listing admin videos.'], 500);
    }
}

if ($method === 'POST') {
    $input = getRequestPayload();
    $videoId = trim((string)($input['videoId'] ?? ($input['video_id'] ?? '')));
    $isBlocked = !empty($input['is_blocked']) || !empty($input['isBlocked']) || (($input['action'] ?? '') === 'block');
    $blockReason = trim((string)($input['block_reason'] ?? ($input['reason'] ?? 'Content policy violation')));

    if (empty($videoId)) {
        jsonResponse(['success' => false, 'error' => 'Video ID is required'], 400);
    }

    try {
        $stmt = $pdo->prepare('
            UPDATE uploaded_videos
            SET is_blocked = ?,
                block_reason = ?,
                blocked_at = ?
            WHERE id = ?
        ');
        $blockedAt = $isBlocked ? date('Y-m-d H:i:s') : null;
        $stmt->execute([
            $isBlocked ? 1 : 0,
            $isBlocked ? $blockReason : null,
            $blockedAt,
            $videoId
        ]);

        jsonResponse([
            'success' => true,
            'message' => $isBlocked ? 'Video has been blocked' : 'Video has been unblocked',
            'video_id' => $videoId,
            'is_blocked' => $isBlocked,
        ]);
    } catch (Throwable $e) {
        error_log('[admin/videos.php][POST] Database Exception: ' . $e->getMessage());
        if ($isConnectionUnavailable($e)) {
            jsonResponse(['success' => false, 'error' => 'Database connection unavailable while updating moderation status.'], 503);
        }
        jsonResponse(['success' => false, 'error' => 'Database error while updating moderation status.'], 500);
    }
}

jsonResponse(['success' => false, 'error' => 'Method Not Allowed'], 405);
