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

if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    jsonResponse(['success' => false, 'error' => 'Method Not Allowed. POST is required.'], 405);
}

$pdo = getDatabaseConnection();
$authUser = getAuthUser($pdo);

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
        SELECT id, user_id, title, status, started_at
        FROM live_streams
        WHERE id = ?
        LIMIT 1
    ');
    $stmt->execute([$streamId]);
    $stream = $stmt->fetch();
} catch (Exception $e) {
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

// 2. Idempotent check
if ($stream['status'] === 'ended') {
    jsonResponse([
        'success' => true,
        'stream_id' => $streamId,
        'status' => 'ended',
        'message' => 'Live stream was already marked as ended.'
    ], 200);
}

// 3. Mark stream as ended (preserves chat & SuperChat records in live_chat_messages)
try {
    $pdo->beginTransaction();

    $upStmt = $pdo->prepare('
        UPDATE live_streams
        SET status = "ended",
            ended_at = NOW(),
            viewers_count = 0,
            updated_at = NOW()
        WHERE id = ?
    ');
    $upStmt->execute([$streamId]);

    // Clean up transient active viewer sessions
    try {
        $delViewers = $pdo->prepare('DELETE FROM live_stream_viewers WHERE stream_id = ?');
        $delViewers->execute([$streamId]);
    } catch (Exception $ve) {
        // Safe if table not created yet
    }

    $pdo->commit();

    jsonResponse([
        'success' => true,
        'stream_id' => $streamId,
        'status' => 'ended',
        'message' => 'Live broadcast ended successfully.'
    ], 200);
} catch (Exception $e) {
    if ($pdo->inTransaction()) {
        $pdo->rollBack();
    }
    jsonResponse(['success' => false, 'error' => 'Failed to end stream: ' . $e->getMessage()], 500);
}
