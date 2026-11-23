<?php
/**
 * FaceTube - End Live Stream API
 * POST /api/live/end-stream.php
 *
 * Secure stream termination:
 * - Restricted to stream owner or FaceTube administrator
 * - Updates status to 'ended' and sets ended_at = NOW()
 * - Preserves existing Live Chat and SuperChat history
 * - Cleans up active viewer presence records
 */

require_once __DIR__ . '/../config/database.php';
require_once __DIR__ . '/../response.php';

if (($_SERVER['REQUEST_METHOD'] ?? '') !== 'POST') {
    jsonResponse(['success' => false, 'error' => 'Method Not Allowed. POST is required.'], 405);
}

$isConnectionUnavailable = static function (Throwable $e): bool {
    if (function_exists('isDatabaseConnectionUnavailableError')) {
        return isDatabaseConnectionUnavailableError($e);
    }
    $sqlState = $e instanceof PDOException ? (string)$e->getCode() : '';
    $driverCode = ($e instanceof PDOException && isset($e->errorInfo[1])) ? (int)$e->errorInfo[1] : 0;
    return str_starts_with($sqlState, '08') || in_array($driverCode, [1040, 1042, 1053, 1129, 1203, 2002, 2003, 2005, 2006, 2013], true);
};

$pdo = getDatabaseConnection();
try {
    $authUser = getAuthUser($pdo, true);
} catch (Throwable $e) {
    error_log('[live/end-stream.php][AUTH] Database error: ' . $e->getMessage());
    if ($isConnectionUnavailable($e)) {
        jsonResponse(['success' => false, 'error' => 'Database connection unavailable during authentication check.'], 503);
    }
    jsonResponse(['success' => false, 'error' => 'Database error during authentication check.'], 500);
}

if (!$authUser) {
    jsonResponse([
        'success' => false,
        'error' => 'Authentication required to end a live stream.'
    ], 401);
}

$payload = getRequestPayload();
$streamId = trim((string)($payload['stream_id'] ?? ($payload['streamId'] ?? '')));

if (empty($streamId)) {
    jsonResponse(['success' => false, 'error' => 'Stream ID (stream_id) is required.'], 400);
}

// 1. Fetch stream record and verify ownership
$stream = null;
try {
    $stmt = $pdo->prepare('
        SELECT id, user_id, title, status, started_at, ended_at
        FROM live_streams
        WHERE id = ?
        LIMIT 1
    ');
    $stmt->execute([$streamId]);
    $stream = $stmt->fetch(PDO::FETCH_ASSOC);
} catch (Throwable $e) {
    error_log('[live/end-stream.php][SELECT] Database error: ' . $e->getMessage());
    if ($isConnectionUnavailable($e)) {
        jsonResponse(['success' => false, 'error' => 'Database connection unavailable while loading stream.'], 503);
    }
    jsonResponse(['success' => false, 'error' => 'Database error loading stream.'], 500);
}

if (!$stream) {
    jsonResponse(['success' => false, 'error' => "Live stream '{$streamId}' not found."], 404);
}

$streamOwner = strtoupper((string)$stream['user_id']);
$requestUser = strtoupper((string)$authUser['user_id']);
$userRole = strtolower((string)($authUser['role'] ?? 'user'));

if ($streamOwner !== $requestUser && $userRole !== 'admin') {
    jsonResponse([
        'success' => false,
        'error' => 'Unauthorized. Only the stream creator or an administrator can end this broadcast.'
    ], 403);
}

$actualStreamId = (string)$stream['id'];

// 2. Idempotent check
if ($stream['status'] === 'ended') {
    jsonResponse([
        'success' => true,
        'stream_id' => $actualStreamId,
        'status' => 'ended',
        'message' => 'Live stream was already marked as ended.',
        'stream' => [
            'id' => $actualStreamId,
            'status' => 'ended',
            'ended_at' => (string)($stream['ended_at'] ?? date('c')),
            'viewers_count' => 0,
        ],
    ], 200);
}

// 3. Mark stream as ended (preserves chat & SuperChat records in live_chat_messages)
try {
    $pdo->beginTransaction();

    try {
        $upStmt = $pdo->prepare("
            UPDATE live_streams
            SET status = 'ended',
                ended_at = NOW(),
                viewers_count = 0,
                updated_at = NOW()
            WHERE id = ?
        ");
        $upStmt->execute([$actualStreamId]);
    } catch (Throwable $updErr) {
        $sqlState = $updErr instanceof PDOException ? (string)($updErr->errorInfo[0] ?? $updErr->getCode()) : '';
        $driverCode = ($updErr instanceof PDOException && isset($updErr->errorInfo[1])) ? (int)$updErr->errorInfo[1] : 0;
        $isMissingUpdatedAt = ($sqlState === '42S22' || $driverCode === 1054)
            && stripos($updErr->getMessage(), 'updated_at') !== false;
        if (!$isMissingUpdatedAt) {
            throw $updErr;
        }
        $upStmt = $pdo->prepare("
            UPDATE live_streams
            SET status = 'ended',
                ended_at = NOW(),
                viewers_count = 0
            WHERE id = ?
        ");
        $upStmt->execute([$actualStreamId]);
    }

    // Clean up transient active viewer sessions (tolerate only missing optional live_stream_viewers table)
    try {
        $delViewers = $pdo->prepare('DELETE FROM live_stream_viewers WHERE stream_id = ?');
        $delViewers->execute([$actualStreamId]);
    } catch (Throwable $ve) {
        $sqlState = $ve instanceof PDOException ? (string)($ve->errorInfo[0] ?? $ve->getCode()) : '';
        $driverCode = ($ve instanceof PDOException && isset($ve->errorInfo[1])) ? (int)$ve->errorInfo[1] : 0;
        if ($sqlState !== '42S02' && $driverCode !== 1146) {
            throw $ve;
        }
    }

    $pdo->commit();

    jsonResponse([
        'success' => true,
        'stream_id' => $actualStreamId,
        'status' => 'ended',
        'message' => 'Live broadcast ended successfully.',
        'stream' => [
            'id' => $actualStreamId,
            'status' => 'ended',
            'ended_at' => date('c'),
            'viewers_count' => 0,
        ],
    ], 200);
} catch (Throwable $e) {
    if ($pdo->inTransaction()) {
        $pdo->rollBack();
    }
    error_log('[live/end-stream.php][UPDATE] Database error: ' . $e->getMessage());
    if ($isConnectionUnavailable($e)) {
        jsonResponse(['success' => false, 'error' => 'Database connection unavailable while ending live stream.'], 503);
    }
    jsonResponse(['success' => false, 'error' => 'Failed to end live stream.'], 500);
}
