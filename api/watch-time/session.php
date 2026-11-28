<?php
/**
 * FaceTube - Start Authenticated Watch Session API
 * POST /api/watch-time/session.php
 *
 * - Authenticated viewers only (guests keep playback & views, do not track watch time)
 * - Resolves video metadata, creator_user_id, visibility/block/payment auth server-side
 * - Enforces per-viewer session rate limits and multi-tab active concurrency limits
 * - Auto-closes superseded prior active sessions with close_reason='superseded'
 */

require_once __DIR__ . '/../config/database.php';
require_once __DIR__ . '/../response.php';
require_once __DIR__ . '/_shared.php';

if (($_SERVER['REQUEST_METHOD'] ?? '') !== 'POST') {
    jsonResponse(['success' => false, 'error' => 'Method Not Allowed'], 405);
}

$pdo = getDatabaseConnection();
$authUser = wtRequireAuthenticatedUser($pdo);

$rawBody = file_get_contents('php://input');
$payload = [];
if ($rawBody !== false && trim($rawBody) !== '') {
    $decoded = json_decode($rawBody, true);
    if (
        json_last_error() !== JSON_ERROR_NONE
        || !is_array($decoded)
        || (!empty($decoded) && array_keys($decoded) === range(0, count($decoded) - 1))
    ) {
        jsonResponse(['success' => false, 'error' => 'Invalid JSON request body.'], 400);
    }
    $payload = $decoded;
} elseif (!empty($_POST)) {
    $payload = $_POST;
}

$videoId = trim((string)($payload['video_id'] ?? ($payload['videoId'] ?? '')));
if ($videoId === '') {
    jsonResponse(['success' => false, 'error' => 'video_id is required.'], 400);
}

$viewerUserId = trim((string)$authUser['user_id']);
$isAdmin = isset($authUser['role']) && strtolower(trim((string)$authUser['role'])) === 'admin';
$maxAttempts = 3;
for ($attempt = 1; $attempt <= $maxAttempts; $attempt++) {
    try {
        $nowEpoch = time();
        $nowSql = wtToMysqlUtcDatetime($nowEpoch);
        $expiresEpoch = $nowEpoch + WT_SESSION_TTL_SECONDS;
        $expiresSql = wtToMysqlUtcDatetime($expiresEpoch);
        $minWindowSql = wtToMysqlUtcDatetime($nowEpoch - 60);

        $pdo->beginTransaction();

        // 0. Lock authenticated viewer's users row first (strict lock hierarchy: users -> watch_sessions)
        $uLockStmt = $pdo->prepare('SELECT id FROM users WHERE user_id = ? FOR UPDATE');
        $uLockStmt->execute([$viewerUserId]);
        $viewerLockRow = $uLockStmt->fetch(PDO::FETCH_ASSOC);
        if (!$viewerLockRow) {
            wtSafeRollback($pdo);
            jsonResponse([
                'success' => false,
                'error' => 'Authentication required. Viewer account not found.'
            ], 401);
        }

        // 1. Resolve authoritative video metadata and enforce access authorization
        $vStmt = $pdo->prepare('
            SELECT id, user_id, video_type, content_type, duration, visibility, payment_status, is_blocked
            FROM uploaded_videos
            WHERE id = ?
            LIMIT 1
        ');
        $vStmt->execute([$videoId]);
        $video = $vStmt->fetch(PDO::FETCH_ASSOC);

        if (!$video) {
            wtSafeRollback($pdo);
            jsonResponse(['success' => false, 'error' => 'Video not found.'], 404);
        }

        if (!empty($video['is_blocked'])) {
            wtSafeRollback($pdo);
            jsonResponse([
                'success' => false,
                'error' => 'This video has been blocked by administrators for content moderation.'
            ], 403);
        }

        $creatorUserId = trim((string)($video['user_id'] ?? ''));
        $isOwner = strcasecmp($creatorUserId, $viewerUserId) === 0
            || (!empty($authUser['id']) && strcasecmp($creatorUserId, trim((string)$authUser['id'])) === 0);

        $visibility = wtResolveVisibilityFailClosed($video['visibility'] ?? null);
        $vType = strtolower(trim((string)($video['video_type'] ?? 'free')));
        $pStatus = strtolower(trim((string)($video['payment_status'] ?? '')));
        if ($pStatus === '') {
            $pStatus = $vType === 'free' ? 'not_required' : 'pending';
        }
        $isPaymentEligible = ($vType === 'free' && in_array($pStatus, ['not_required', 'paid'], true))
            || ($vType === 'premium' && $pStatus === 'paid');

        if ($visibility === 'private' && !$isOwner && !$isAdmin) {
            wtSafeRollback($pdo);
            jsonResponse([
                'success' => false,
                'error' => 'Unauthorized: This private video is only accessible to its creator or administrators.'
            ], 403);
        }

        if (!$isPaymentEligible && !$isOwner && !$isAdmin) {
            wtSafeRollback($pdo);
            jsonResponse([
                'success' => false,
                'error' => 'Unauthorized: Unpaid Sponsor videos are only accessible to their creator or administrators.'
            ], 403);
        }

        // 2. Per-viewer session creation rate limit (30/min) under viewer row lock
        $rateStmt = $pdo->prepare('
            SELECT COUNT(*) AS cnt
            FROM watch_sessions
            WHERE viewer_user_id = ?
              AND started_at >= ?
        ');
        $rateStmt->execute([$viewerUserId, $minWindowSql]);
        $rateRow = $rateStmt->fetch(PDO::FETCH_ASSOC);
        if ((int)($rateRow['cnt'] ?? 0) >= WT_MAX_SESSIONS_PER_MINUTE) {
            wtSafeRollback($pdo);
            jsonResponse([
                'success' => false,
                'code' => 'SESSION_RATE_LIMIT',
                'error' => 'Too many watch sessions started. Please wait before starting another.'
            ], 429);
        }

        // 3. Expire stale sessions and supersede older active sessions
        $expStmt = $pdo->prepare("
            UPDATE watch_sessions
            SET status = 'ended', close_reason = 'expired', ended_at = COALESCE(ended_at, ?)
            WHERE viewer_user_id = ?
              AND status = 'active'
              AND expires_at <= ?
        ");
        $expStmt->execute([$nowSql, $viewerUserId, $nowSql]);

        $supSameStmt = $pdo->prepare("
            UPDATE watch_sessions
            SET status = 'ended', close_reason = 'superseded', ended_at = COALESCE(ended_at, ?)
            WHERE viewer_user_id = ?
              AND video_id = ?
              AND status = 'active'
        ");
        $supSameStmt->execute([$nowSql, $viewerUserId, $videoId]);

        $activeStmt = $pdo->prepare("
            SELECT id
            FROM watch_sessions
            WHERE viewer_user_id = ?
              AND status = 'active'
            ORDER BY last_heartbeat_at ASC, started_at ASC
            FOR UPDATE
        ");
        $activeStmt->execute([$viewerUserId]);
        $activeRows = $activeStmt->fetchAll(PDO::FETCH_ASSOC);

        if (count($activeRows) >= WT_MAX_CONCURRENT_ACTIVE_SESSIONS) {
            $overflowCount = count($activeRows) - WT_MAX_CONCURRENT_ACTIVE_SESSIONS + 1;
            $toCloseIds = [];
            for ($i = 0; $i < $overflowCount; $i++) {
                if (!empty($activeRows[$i]['id'])) {
                    $toCloseIds[] = (string)$activeRows[$i]['id'];
                }
            }
            if (!empty($toCloseIds)) {
                $placeholders = implode(', ', array_fill(0, count($toCloseIds), '?'));
                $closeStmt = $pdo->prepare("
                    UPDATE watch_sessions
                    SET status = 'ended', close_reason = 'superseded', ended_at = COALESCE(ended_at, ?)
                    WHERE id IN ({$placeholders})
                ");
                $closeStmt->execute(array_merge([$nowSql], $toCloseIds));
            }
        }

        // 4. Insert new server-minted watch session
        $sessionId = 'ws_' . bin2hex(random_bytes(16));
        $contentType = strtolower(trim((string)($video['content_type'] ?? 'long'))) === 'short' ? 'short' : 'long';
        $durationSec = wtParseVideoDurationSeconds($video['duration'] ?? 0);
        $isSelfWatch = $isOwner ? 1 : 0;

        $insStmt = $pdo->prepare("
            INSERT INTO watch_sessions (
                id, viewer_user_id, video_id, creator_user_id, content_type,
                video_duration_seconds, is_self_watch, status, close_reason,
                superseded_grace_used, total_watched_seconds, is_qualified,
                qualified_watch_date, last_seq, last_position_seconds,
                expires_at, started_at, last_heartbeat_at, ended_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, 'active', NULL, 0, 0, 0, NULL, 0, 0, ?, ?, ?, NULL)
        ");
        $insStmt->execute([
            $sessionId,
            $viewerUserId,
            $videoId,
            $creatorUserId,
            $contentType,
            $durationSec,
            $isSelfWatch,
            $expiresSql,
            $nowSql,
            $nowSql,
        ]);

        $pdo->commit();

        jsonResponse([
            'success' => true,
            'session_id' => $sessionId,
            'sessionId' => $sessionId,
            'video_id' => $videoId,
            'content_type' => $contentType,
            'is_self_watch' => (bool)$isSelfWatch,
            'heartbeat_interval_seconds' => WT_HEARTBEAT_INTERVAL_SEC,
            'max_delta_seconds' => WT_MAX_DELTA_SEC,
            'expires_at' => gmdate('Y-m-d\TH:i:s.000\Z', $expiresEpoch),
        ], 201);
    } catch (Throwable $e) {
        wtSafeRollback($pdo);
        if (wtIsRetryableTransactionError($e)) {
            if ($attempt < $maxAttempts) {
                usleep(20000 * $attempt);
                continue;
            }
            error_log('[watch-time/session.php] Transient transaction conflict: ' . $e->getMessage());
            jsonResponse([
                'success' => false,
                'code' => 'TRANSACTION_CONFLICT',
                'error' => 'Temporary transaction conflict while starting watch session. Please retry.'
            ], 409);
        }
        error_log('[watch-time/session.php] Error: ' . $e->getMessage());
        if (wtIsConnectionUnavailableError($e)) {
            jsonResponse(['success' => false, 'error' => 'Database connection unavailable while starting watch session.'], 503);
        }
        jsonResponse(['success' => false, 'error' => 'Database error while starting watch session.'], 500);
    }
}
