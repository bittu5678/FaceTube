<?php
/**
 * FaceTube - Live Stream Heartbeat API
 * POST /api/live/heartbeat.php
 *
 * Authenticated stream heartbeat & presence tracking:
 * - Verifies stream ownership for broadcasters (prevents unauthorized keep-alive)
 * - Updates broadcaster_last_ping_at
 * - Records viewer telemetry without treating browser heartbeats as authoritative count
 * - Validates stream status and reports if stream has ended
 */

require_once __DIR__ . '/../config/database.php';
require_once __DIR__ . '/../response.php';

if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    jsonResponse(['success' => false, 'error' => 'Method Not Allowed. POST is required.'], 405);
}

$pdo = getDatabaseConnection();
$payload = getRequestPayload();

$streamId = trim((string)($payload['stream_id'] ?? ($payload['streamId'] ?? '')));
$role = strtolower(trim((string)($payload['role'] ?? 'viewer')));

if (empty($streamId)) {
    jsonResponse(['success' => false, 'error' => 'Stream ID (stream_id) is required.'], 400);
}

// 1. Fetch current stream record
$stream = null;
try {
    $stmt = $pdo->prepare('
        SELECT id, user_id, status, viewers_count, started_at,
               COALESCE(broadcaster_last_ping_at, started_at) as broadcaster_last_ping_at
        FROM live_streams
        WHERE id = ?
        LIMIT 1
    ');
    $stmt->execute([$streamId]);
    $stream = $stmt->fetch();
} catch (Exception $e) {
    // Fallback if broadcaster_last_ping_at column is pending migration
    try {
        $stmt = $pdo->prepare('
            SELECT id, user_id, status, viewers_count, started_at, started_at as broadcaster_last_ping_at
            FROM live_streams
            WHERE id = ?
            LIMIT 1
        ');
        $stmt->execute([$streamId]);
        $stream = $stmt->fetch();
    } catch (Exception $err2) {
        jsonResponse(['success' => false, 'error' => 'Database error loading stream.'], 500);
    }
}

if (!$stream) {
    jsonResponse(['success' => false, 'error' => "Live stream '{$streamId}' not found."], 404);
}

if ($stream['status'] === 'ended') {
    jsonResponse([
        'success' => false,
        'stream_status' => 'ended',
        'error' => 'Stream has already ended.'
    ], 410);
}

$authUser = getAuthUser($pdo);

// 2. Handle Broadcaster Heartbeat
if ($role === 'broadcaster' || $role === 'publisher') {
    if (!$authUser) {
        jsonResponse([
            'success' => false,
            'error' => 'Authentication required for broadcaster heartbeat.'
        ], 401);
    }

    $streamOwner = strtoupper((string)$stream['user_id']);
    $requestUser = strtoupper((string)$authUser['user_id']);
    $userRole = strtolower((string)($authUser['role'] ?? 'user'));

    if ($streamOwner !== $requestUser && $userRole !== 'admin') {
        jsonResponse([
            'success' => false,
            'error' => 'Unauthorized. You do not own this live stream and cannot send broadcaster heartbeats.'
        ], 403);
    }

    // Update broadcaster last ping timestamp
    try {
        $upStmt = $pdo->prepare('
            UPDATE live_streams
            SET broadcaster_last_ping_at = NOW()
            WHERE id = ?
        ');
        $upStmt->execute([$streamId]);
    } catch (Exception $e) {
        // Ignored if column not present
    }

    jsonResponse([
        'success' => true,
        'stream_id' => $streamId,
        'role' => 'broadcaster',
        'stream_status' => $stream['status'],
        'viewers_count' => intval($stream['viewers_count']),
        'ping_received_at' => date('c'),
    ], 200);
}

// 3. Handle Viewer Telemetry Presence (Supplementary only, not authoritative)
$viewerId = $authUser['user_id'] ?? null;
if (empty($viewerId)) {
    $ip = $_SERVER['REMOTE_ADDR'] ?? '127.0.0.1';
    $ua = $_SERVER['HTTP_USER_AGENT'] ?? 'browser';
    $viewerId = 'guest_' . substr(hash('sha256', $ip . '|' . $ua . '|' . session_id()), 0, 16);
}

try {
    $rowId = 'vw_' . substr(md5($streamId . '|' . $viewerId), 0, 32);
    $vStmt = $pdo->prepare('
        INSERT INTO live_stream_viewers (id, stream_id, viewer_identifier, user_id, joined_at, last_ping_at)
        VALUES (?, ?, ?, ?, NOW(), NOW())
        ON DUPLICATE KEY UPDATE last_ping_at = NOW()
    ');
    $vStmt->execute([$rowId, $streamId, $viewerId, $authUser ? $authUser['user_id'] : null]);
} catch (Exception $e) {
    // Fail safe if table pending migration
}

jsonResponse([
    'success' => true,
    'stream_id' => $streamId,
    'role' => 'viewer',
    'stream_status' => $stream['status'],
    'viewers_count' => intval($stream['viewers_count']),
    'ping_received_at' => date('c'),
], 200);
