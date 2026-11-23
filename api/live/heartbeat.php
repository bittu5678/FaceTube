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

if (($_SERVER['REQUEST_METHOD'] ?? '') !== 'POST') {
    jsonResponse(['success' => false, 'error' => 'Method Not Allowed. POST is required.'], 405);
}

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

$isMissingColumnError = static function (Throwable $e): bool {
    if (!($e instanceof PDOException)) {
        return false;
    }
    $sqlState = (string)$e->getCode();
    $driverCode = isset($e->errorInfo[1]) ? (int)$e->errorInfo[1] : 0;
    return $sqlState === '42S22' || $driverCode === 1054;
};

$isMissingOptionalTable = static function (Throwable $e): bool {
    if (!($e instanceof PDOException)) {
        return false;
    }
    $sqlState = (string)$e->getCode();
    $driverCode = isset($e->errorInfo[1]) ? (int)$e->errorInfo[1] : 0;
    return $sqlState === '42S02' || $driverCode === 1146;
};

// Local auth-header detector because shared getBearerToken() returns null for malformed/empty Authorization headers
$hasSuppliedAuthHeader = static function (): bool {
    $candidates = [
        $_SERVER['HTTP_AUTHORIZATION'] ?? null,
        $_SERVER['REDIRECT_HTTP_AUTHORIZATION'] ?? null,
        $_SERVER['REDIRECT_REDIRECT_HTTP_AUTHORIZATION'] ?? null,
        $_SERVER['Authorization'] ?? null,
        $_SERVER['HTTP_X_AUTHORIZATION'] ?? null,
        $_SERVER['REDIRECT_HTTP_X_AUTHORIZATION'] ?? null,
        $_SERVER['REDIRECT_REDIRECT_HTTP_X_AUTHORIZATION'] ?? null,
        $_SERVER['X-Authorization'] ?? null,
        $_SERVER['X_AUTHORIZATION'] ?? null,
    ];
    foreach ($candidates as $candidate) {
        if ($candidate !== null && trim((string)$candidate) !== '') {
            return true;
        }
    }
    $requestHeaders = [];
    if (function_exists('getallheaders')) {
        $requestHeaders = getallheaders() ?: [];
    } elseif (function_exists('apache_request_headers')) {
        $requestHeaders = apache_request_headers() ?: [];
    }
    if (!empty($requestHeaders) && is_array($requestHeaders)) {
        foreach ($requestHeaders as $key => $val) {
            if (
                (strcasecmp((string)$key, 'Authorization') === 0 || strcasecmp((string)$key, 'X-Authorization') === 0)
                && $val !== null
                && trim((string)$val) !== ''
            ) {
                return true;
            }
        }
    }
    foreach ([
        'HTTP_AUTHORIZATION',
        'REDIRECT_HTTP_AUTHORIZATION',
        'REDIRECT_REDIRECT_HTTP_AUTHORIZATION',
        'HTTP_X_AUTHORIZATION',
        'REDIRECT_HTTP_X_AUTHORIZATION',
        'REDIRECT_REDIRECT_HTTP_X_AUTHORIZATION',
    ] as $envKey) {
        $envVal = getenv($envKey);
        if ($envVal !== false && trim((string)$envVal) !== '') {
            return true;
        }
    }
    return false;
};

$pdo = getDatabaseConnection();
$payload = getRequestPayload();
if (!is_array($payload)) {
    jsonResponse(['success' => false, 'error' => 'Invalid JSON request body.'], 400);
}

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
    if ($stmt === false) {
        throw new RuntimeException('Failed to prepare stream lookup query.');
    }
    if ($stmt->execute([$streamId]) === false) {
        throw new RuntimeException('Failed to execute stream lookup query.');
    }
    $stream = $stmt->fetch(PDO::FETCH_ASSOC);
} catch (Throwable $e) {
    if ($isMissingColumnError($e)) {
        // Fallback if broadcaster_last_ping_at column is pending migration
        try {
            $stmt = $pdo->prepare('
                SELECT id, user_id, status, viewers_count, started_at, started_at as broadcaster_last_ping_at
                FROM live_streams
                WHERE id = ?
                LIMIT 1
            ');
            if ($stmt === false) {
                throw new RuntimeException('Failed to prepare fallback stream lookup query.');
            }
            if ($stmt->execute([$streamId]) === false) {
                throw new RuntimeException('Failed to execute fallback stream lookup query.');
            }
            $stream = $stmt->fetch(PDO::FETCH_ASSOC);
        } catch (Throwable $err2) {
            error_log('[live/heartbeat.php][STREAM] Fallback database error: ' . $err2->getMessage());
            if ($isConnectionUnavailable($err2)) {
                jsonResponse(['success' => false, 'error' => 'Database connection unavailable while loading stream.'], 503);
            }
            jsonResponse(['success' => false, 'error' => 'Database error loading stream.'], 500);
        }
    } else {
        error_log('[live/heartbeat.php][STREAM] Database error: ' . $e->getMessage());
        if ($isConnectionUnavailable($e)) {
            jsonResponse(['success' => false, 'error' => 'Database connection unavailable while loading stream.'], 503);
        }
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

// 2. Fail-closed authentication check (never downgrade malformed/invalid/expired Bearer credentials to guest)
$authHeaderSupplied = $hasSuppliedAuthHeader();
$suppliedBearerToken = getBearerToken();

if ($authHeaderSupplied && $suppliedBearerToken === null) {
    jsonResponse([
        'success' => false,
        'error' => 'Malformed or empty Bearer authorization header. Please provide a valid Bearer session token.'
    ], 401);
}

$authUser = null;
if ($suppliedBearerToken !== null) {
    try {
        $authUser = getAuthUser($pdo, true);
    } catch (Throwable $e) {
        error_log('[live/heartbeat.php][AUTH] Database error: ' . $e->getMessage());
        if ($isConnectionUnavailable($e)) {
            jsonResponse([
                'success' => false,
                'error' => 'Database connection unavailable during authentication check.'
            ], 503);
        }
        jsonResponse([
            'success' => false,
            'error' => 'Database error during authentication check.'
        ], 500);
    }

    if (!$authUser || empty($authUser['user_id'])) {
        jsonResponse([
            'success' => false,
            'error' => 'Invalid or expired authentication session. Please log in again.'
        ], 401);
    }
}

// 3. Handle Broadcaster Heartbeat
if ($role === 'broadcaster' || $role === 'publisher') {
    if (!$authUser || empty($authUser['user_id'])) {
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
        if ($upStmt === false) {
            throw new RuntimeException('Failed to prepare broadcaster heartbeat update.');
        }
        if ($upStmt->execute([$streamId]) === false) {
            throw new RuntimeException('Failed to execute broadcaster heartbeat update.');
        }
    } catch (Throwable $e) {
        if (!$isMissingColumnError($e)) {
            error_log('[live/heartbeat.php][BROADCASTER] Database error: ' . $e->getMessage());
            if ($isConnectionUnavailable($e)) {
                jsonResponse([
                    'success' => false,
                    'error' => 'Database connection unavailable while recording broadcaster heartbeat.'
                ], 503);
            }
            jsonResponse([
                'success' => false,
                'error' => 'Failed to record broadcaster heartbeat due to a server error.'
            ], 500);
        }
    }

    jsonResponse([
        'success' => true,
        'stream_id' => $streamId,
        'role' => 'broadcaster',
        'stream_status' => $stream['status'],
        'viewers_count' => intval($stream['viewers_count']),
        'active_viewers' => intval($stream['viewers_count']),
        'ping_received_at' => date('c'),
    ], 200);
}

// 4. Handle Viewer Telemetry Presence (Supplementary only, not authoritative)
// Authoritative identity strictly from authenticated session or deterministic guest hash (never trust client user_id)
$viewerId = $authUser ? (string)$authUser['user_id'] : null;
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
    if ($vStmt === false) {
        throw new RuntimeException('Failed to prepare viewer heartbeat statement.');
    }
    if ($vStmt->execute([$rowId, $streamId, $viewerId, $authUser ? (string)$authUser['user_id'] : null]) === false) {
        throw new RuntimeException('Failed to execute viewer heartbeat statement.');
    }
} catch (Throwable $e) {
    if (!$isMissingOptionalTable($e)) {
        error_log('[live/heartbeat.php][VIEWER] Database error: ' . $e->getMessage());
        if ($isConnectionUnavailable($e)) {
            jsonResponse([
                'success' => false,
                'error' => 'Database connection unavailable while recording viewer heartbeat.'
            ], 503);
        }
        jsonResponse([
            'success' => false,
            'error' => 'Failed to record viewer heartbeat due to a server error.'
        ], 500);
    }
}

jsonResponse([
    'success' => true,
    'stream_id' => $streamId,
    'role' => 'viewer',
    'stream_status' => $stream['status'],
    'viewers_count' => intval($stream['viewers_count']),
    'active_viewers' => intval($stream['viewers_count']),
    'ping_received_at' => date('c'),
], 200);
