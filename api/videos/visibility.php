<?php
/**
 * FaceTube - Update Video Visibility API
 * POST /api/videos/visibility.php
 * Allows video owner or verified admin to update individual video visibility (public, unlisted, private).
 */

require_once __DIR__ . '/../config/database.php';
require_once __DIR__ . '/../response.php';

if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
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
    error_log('[videos/visibility.php] Auth Database Exception: ' . $authErr->getMessage());
    if ($isConnectionUnavailable($authErr)) {
        jsonResponse(['success' => false, 'error' => 'Database connection unavailable during authentication. Please try again.'], 503);
    }
    jsonResponse(['success' => false, 'error' => 'Authentication service error during visibility update.'], 500);
}

if (!$authUser) {
    jsonResponse(['success' => false, 'error' => 'Authentication required. Please provide a valid Bearer session token.'], 401);
}

$input = getRequestPayload();
$videoId = trim((string)($input['videoId'] ?? ($input['video_id'] ?? ($input['id'] ?? ''))));
$visibility = strtolower(trim((string)($input['visibility'] ?? '')));

if ($videoId === '') {
    jsonResponse(['success' => false, 'error' => 'Video ID is required.'], 400);
}
if (!in_array($visibility, ['public', 'unlisted', 'private'], true)) {
    jsonResponse(['success' => false, 'error' => 'Invalid visibility value. Allowed values: public, unlisted, private.'], 400);
}

$safeRollback = static function (PDO $conn): void {
    try {
        if ($conn->inTransaction()) {
            $conn->rollBack();
        }
    } catch (Throwable $_rollbackErr) {
        error_log('[videos/visibility.php][ROLLBACK] Rollback failed: ' . $_rollbackErr->getMessage());
    }
};

$isAdmin = isset($authUser['role']) && strtolower(trim((string)$authUser['role'])) === 'admin';
$authUserId = trim((string)($authUser['user_id'] ?? ''));

try {
    $pdo->beginTransaction();

    $stmtSelect = $pdo->prepare('SELECT * FROM uploaded_videos WHERE id = ? LIMIT 1 FOR UPDATE');
    $stmtSelect->execute([$videoId]);
    $row = $stmtSelect->fetch();

    if (!$row) {
        $safeRollback($pdo);
        jsonResponse(['success' => false, 'error' => 'Video not found.'], 404);
    }

    $rowOwner = trim((string)($row['user_id'] ?? ''));
    $isOwner = $rowOwner !== '' && (
        ($authUserId !== '' && strcasecmp($rowOwner, $authUserId) === 0)
        || (!empty($authUser['id']) && strcasecmp($rowOwner, trim((string)$authUser['id'])) === 0)
    );

    if (!$isOwner && !$isAdmin) {
        $safeRollback($pdo);
        jsonResponse(['success' => false, 'error' => 'Unauthorized: You can only update visibility for your own videos.'], 403);
    }

    $isBlocked = !empty($row['is_blocked']);
    if ($isBlocked) {
        if (!$isAdmin) {
            $safeRollback($pdo);
            jsonResponse([
                'success' => false,
                'error' => 'Blocked videos cannot have their visibility changed or be published by their owners.'
            ], 403);
        }
        if ($visibility === 'public') {
            $safeRollback($pdo);
            jsonResponse([
                'success' => false,
                'error' => 'Blocked videos must be unblocked via the Admin Moderation workflow before publishing.'
            ], 409);
        }
    }

    // Update ONLY visibility and updated_at — never mutate payment_status, video_type, user_id, promotion, or block fields.
    $stmtUpdate = $pdo->prepare('UPDATE uploaded_videos SET visibility = ?, updated_at = NOW() WHERE id = ?');
    $stmtUpdate->execute([$visibility, $videoId]);

    $pdo->commit();

    $updatedAtIso = date('c');
    $videoType = strtolower(trim((string)($row['video_type'] ?? 'free')));
    $paymentStatus = strtolower(trim((string)($row['payment_status'] ?? '')));
    if ($paymentStatus === '') {
        $paymentStatus = $videoType === 'free' ? 'not_required' : 'pending';
    }

    jsonResponse([
        'success' => true,
        'video' => [
            'id' => $row['id'],
            'userId' => $row['user_id'],
            'user_id' => $row['user_id'],
            'creatorName' => $row['creator_name'] ?? 'FaceTube Creator',
            'creator_name' => $row['creator_name'] ?? 'FaceTube Creator',
            'title' => $row['title'],
            'description' => $row['description'] ?? '',
            'videoUrl' => $row['video_url'],
            'video_url' => $row['video_url'],
            'thumbnailUrl' => $row['thumbnail_url'] ?? '',
            'thumbnail_url' => $row['thumbnail_url'] ?? '',
            'videoType' => $videoType,
            'video_type' => $videoType,
            'contentType' => $row['content_type'] ?? 'long',
            'content_type' => $row['content_type'] ?? 'long',
            'category' => $row['category'] ?? 'General',
            'duration' => $row['duration'] ?? '0:00',
            'visibility' => $visibility,
            'views' => (int)($row['views'] ?? 0),
            'likes' => (int)($row['likes'] ?? 0),
            'paymentStatus' => $paymentStatus,
            'payment_status' => $paymentStatus,
            'paymentId' => $row['payment_id'] ?? null,
            'payment_id' => $row['payment_id'] ?? null,
            'paymentAmount' => (float)($row['payment_amount'] ?? 0),
            'payment_amount' => (float)($row['payment_amount'] ?? 0),
            'isPromoted' => !empty($row['is_promoted']),
            'is_promoted' => !empty($row['is_promoted']),
            'promotionPlan' => $row['promotion_plan'] ?? null,
            'promotion_plan' => $row['promotion_plan'] ?? null,
            'promotionExpiresAt' => $row['promotion_expires_at'] ?? null,
            'promotion_expires_at' => $row['promotion_expires_at'] ?? null,
            'isBlocked' => $isBlocked,
            'is_blocked' => $isBlocked,
            'blockReason' => $row['block_reason'] ?? null,
            'block_reason' => $row['block_reason'] ?? null,
            'createdAt' => $row['created_at'] ?? $updatedAtIso,
            'created_at' => $row['created_at'] ?? $updatedAtIso,
            'updatedAt' => $updatedAtIso,
            'updated_at' => $updatedAtIso,
        ]
    ]);
} catch (Throwable $e) {
    $safeRollback($pdo);
    error_log('[videos/visibility.php] Database Exception: ' . $e->getMessage());
    if ($isConnectionUnavailable($e)) {
        jsonResponse(['success' => false, 'error' => 'Database connection unavailable during visibility update. Please try again.'], 503);
    }
    jsonResponse(['success' => false, 'error' => 'Database error while updating video visibility.'], 500);
}
