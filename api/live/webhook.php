<?php
/**
 * FaceTube - LiveKit Cloud Official Webhook Ingestion API
 * POST /api/live/webhook.php
 *
 * Implements official LiveKit Webhook Verification:
 * 1. Reads raw HTTP body (application/webhook+json or application/json)
 * 2. Extracts JWT from HTTP Authorization header
 * 3. Verifies HS256 signature using LIVEKIT_API_SECRET
 * 4. Compares claims['sha256'] against Base64-encoded SHA-256 hash of the exact raw body
 * 5. Idempotent processing of event IDs (prevents double counting)
 * 6. Authoritative participant counts (participant_joined, participant_left, room_finished)
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

// 1. Load LiveKit credentials from environment or domain-level livekit.php
$apiKey = getenv('LIVEKIT_API_KEY') ?: ($_ENV['LIVEKIT_API_KEY'] ?? ($_SERVER['LIVEKIT_API_KEY'] ?? ''));
$apiSecret = getenv('LIVEKIT_API_SECRET') ?: ($_ENV['LIVEKIT_API_SECRET'] ?? ($_SERVER['LIVEKIT_API_SECRET'] ?? ''));

$publicWebDirNames = ['public_html', 'htdocs', 'www'];
$forbiddenRoots = [];
$domainDirCandidates = [];

$baseRoots = [dirname(__DIR__, 1)];
if (!empty($_SERVER['DOCUMENT_ROOT'])) {
    array_unshift($baseRoots, (string)$_SERVER['DOCUMENT_ROOT']);
}

foreach ($baseRoots as $baseRoot) {
    $realRoot = @realpath($baseRoot);
    if ($realRoot === false || !is_dir($realRoot)) {
        continue;
    }

    $normalizedRoot = rtrim(str_replace('\\', '/', $realRoot), '/');
    if ($normalizedRoot === '') {
        continue;
    }
    if (!in_array($normalizedRoot, $forbiddenRoots, true)) {
        $forbiddenRoots[] = $normalizedRoot;
    }

    $parentDir = rtrim(str_replace('\\', '/', dirname($normalizedRoot)), '/');
    if ($parentDir === '') {
        continue;
    }

    if (in_array(strtolower(basename($parentDir)), $publicWebDirNames, true)) {
        if (!in_array($parentDir, $forbiddenRoots, true)) {
            $forbiddenRoots[] = $parentDir;
        }
        $intendedDomainDir = rtrim(str_replace('\\', '/', dirname($parentDir)), '/');
    } else {
        $intendedDomainDir = $parentDir;
    }

    $realDomainDir = @realpath($intendedDomainDir);
    if ($realDomainDir === false || !is_dir($realDomainDir)) {
        continue;
    }
    $normalizedDomainDir = rtrim(str_replace('\\', '/', $realDomainDir), '/');
    $domainBasename = strtolower(basename($normalizedDomainDir));

    if (
        $normalizedDomainDir === '' ||
        $domainBasename === 'domains' ||
        in_array($domainBasename, $publicWebDirNames, true)
    ) {
        continue;
    }

    if (!in_array($normalizedDomainDir, $domainDirCandidates, true)) {
        $domainDirCandidates[] = $normalizedDomainDir;
    }
}

$livekitConfigPath = null;
foreach ($domainDirCandidates as $allowedDomainDir) {
    $realCandidate = @realpath($allowedDomainDir . '/livekit.php');
    if ($realCandidate === false || !is_file($realCandidate) || !is_readable($realCandidate)) {
        continue;
    }

    $normalizedCandidate = str_replace('\\', '/', $realCandidate);
    $candidateDir = rtrim(dirname($normalizedCandidate), '/');

    if ($candidateDir !== $allowedDomainDir || strpos($normalizedCandidate, $allowedDomainDir . '/') !== 0) {
        continue;
    }

    $isInsidePublicRoot = in_array(strtolower(basename($candidateDir)), $publicWebDirNames, true);
    if (!$isInsidePublicRoot) {
        foreach ($forbiddenRoots as $forbiddenRoot) {
            if ($normalizedCandidate === $forbiddenRoot || strpos($normalizedCandidate, $forbiddenRoot . '/') === 0) {
                $isInsidePublicRoot = true;
                break;
            }
        }
    }

    if (!$isInsidePublicRoot) {
        $livekitConfigPath = $realCandidate;
        break;
    }
}

if ($livekitConfigPath !== null) {
    try {
        $customLivekit = include $livekitConfigPath;
        if (is_array($customLivekit)) {
            $apiKey = $customLivekit['LIVEKIT_API_KEY'] ?? ($customLivekit['livekit_api_key'] ?? ($customLivekit['apiKey'] ?? ($customLivekit['api_key'] ?? $apiKey)));
            $apiSecret = $customLivekit['LIVEKIT_API_SECRET'] ?? ($customLivekit['livekit_api_secret'] ?? ($customLivekit['apiSecret'] ?? ($customLivekit['api_secret'] ?? $apiSecret)));
        }
        if (empty($apiKey) && defined('LIVEKIT_API_KEY')) $apiKey = constant('LIVEKIT_API_KEY');
        if (empty($apiSecret) && defined('LIVEKIT_API_SECRET')) $apiSecret = constant('LIVEKIT_API_SECRET');
        if (empty($apiKey) && isset($LIVEKIT_API_KEY)) $apiKey = $LIVEKIT_API_KEY;
        if (empty($apiSecret) && isset($LIVEKIT_API_SECRET)) $apiSecret = $LIVEKIT_API_SECRET;
    } catch (Throwable $cfgErr) {
        error_log('[live/webhook.php][CONFIG] Failed to load domain livekit config: ' . $cfgErr->getMessage());
        jsonResponse(['success' => false, 'error' => 'LiveKit configuration error on server.'], 503);
    }
}

if (empty($apiSecret)) {
    jsonResponse([
        'success' => false,
        'error' => 'LIVEKIT_API_SECRET is not configured on this server.'
    ], 503);
}

// 2. Extract Authorization Header (checks Apache/FastCGI REDIRECT variants & case-insensitive headers)
$authHeader = '';
foreach ([
    $_SERVER['HTTP_AUTHORIZATION'] ?? null,
    $_SERVER['REDIRECT_HTTP_AUTHORIZATION'] ?? null,
    $_SERVER['REDIRECT_REDIRECT_HTTP_AUTHORIZATION'] ?? null,
    $_SERVER['Authorization'] ?? null,
    getenv('HTTP_AUTHORIZATION') ?: null,
    getenv('REDIRECT_HTTP_AUTHORIZATION') ?: null,
    getenv('REDIRECT_REDIRECT_HTTP_AUTHORIZATION') ?: null,
] as $candidate) {
    if ($candidate !== null && trim((string)$candidate) !== '') {
        $authHeader = trim((string)$candidate);
        break;
    }
}
if ($authHeader === '') {
    $reqHeaders = function_exists('getallheaders')
        ? (getallheaders() ?: [])
        : (function_exists('apache_request_headers') ? (apache_request_headers() ?: []) : []);
    if (is_array($reqHeaders)) {
        foreach ($reqHeaders as $hKey => $hVal) {
            if (strcasecmp((string)$hKey, 'Authorization') === 0 && trim((string)$hVal) !== '') {
                $authHeader = trim((string)$hVal);
                break;
            }
        }
    }
}

if (empty($authHeader)) {
    jsonResponse([
        'success' => false,
        'error' => 'Missing LiveKit Authorization header.'
    ], 401);
}

$token = trim(preg_replace('/^Bearer\s+/i', '', $authHeader));

// 3. Verify LiveKit JWT structure
$parts = explode('.', $token);
if (count($parts) !== 3) {
    jsonResponse([
        'success' => false,
        'error' => 'Invalid LiveKit token structure. Must be a 3-part JWT.'
    ], 401);
}

list($headerB64, $payloadB64, $sigB64) = $parts;

function base64UrlDecode($input) {
    $remainder = strlen($input) % 4;
    if ($remainder) {
        $padlen = 4 - $remainder;
        $input .= str_repeat('=', $padlen);
    }
    return base64_decode(strtr($input, '-_', '+/'));
}

function base64UrlEncode($data) {
    return rtrim(strtr(base64_encode($data), '+/', '-_'), '=');
}

$headerJson = base64UrlDecode($headerB64);
$payloadJson = base64UrlDecode($payloadB64);

$header = json_decode($headerJson, true);
$payload = json_decode($payloadJson, true);

if (!is_array($header) || !is_array($payload)) {
    jsonResponse(['success' => false, 'error' => 'Malformed JWT header or payload.'], 401);
}

if (($header['alg'] ?? '') !== 'HS256') {
    jsonResponse(['success' => false, 'error' => 'Unsupported algorithm. LiveKit webhooks require HS256.'], 401);
}

// 4. Verify HMAC-SHA256 Signature
$computedSigBinary = hash_hmac('sha256', "{$headerB64}.{$payloadB64}", $apiSecret, true);
$computedSigB64 = base64UrlEncode($computedSigBinary);

if (!hash_equals($computedSigB64, $sigB64)) {
    jsonResponse(['success' => false, 'error' => 'LiveKit webhook signature verification failed.'], 401);
}

// 5. Verify Expiry & API Key
if (isset($payload['exp']) && intval($payload['exp']) < time()) {
    jsonResponse(['success' => false, 'error' => 'LiveKit webhook token has expired.'], 401);
}

if (!empty($apiKey) && isset($payload['iss']) && $payload['iss'] !== $apiKey) {
    jsonResponse(['success' => false, 'error' => 'Issuer (iss) does not match configured LiveKit API Key.'], 401);
}

// 6. Verify Body SHA-256 Claim (Official LiveKit Standard)
$rawBody = file_get_contents('php://input');
$expectedBodySha256B64 = base64_encode(hash('sha256', $rawBody, true));
$claimedSha256 = (string)($payload['sha256'] ?? '');

if (empty($claimedSha256) || !hash_equals($expectedBodySha256B64, $claimedSha256)) {
    jsonResponse([
        'success' => false,
        'error' => 'Body SHA-256 hash mismatch. LiveKit webhook payload integrity check failed.'
    ], 401);
}

// 7. Parse Event Data
$eventData = json_decode($rawBody, true);
if (!is_array($eventData)) {
    jsonResponse(['success' => false, 'error' => 'Malformed webhook JSON payload.'], 400);
}

$eventId = trim((string)($eventData['id'] ?? ''));
$eventType = trim((string)($eventData['event'] ?? ''));
$room = is_array($eventData['room'] ?? null) ? $eventData['room'] : [];
$roomName = trim((string)($room['name'] ?? ''));
$rawNumParticipants = $room['numParticipants']
    ?? ($room['num_participants']
    ?? ($eventData['numParticipants']
    ?? ($eventData['num_participants'] ?? null)));
$numParticipants = ($rawNumParticipants !== null && is_numeric($rawNumParticipants))
    ? max(0, intval($rawNumParticipants))
    : null;

if (empty($eventType)) {
    jsonResponse(['success' => false, 'error' => 'Missing event type.'], 400);
}
if ($eventId === '' || strlen($eventId) > 128) {
    jsonResponse(['success' => false, 'error' => 'Valid LiveKit webhook event ID is required.'], 400);
}
if ($roomName === '') {
    jsonResponse(['success' => false, 'error' => 'Missing LiveKit room name.'], 400);
}

// 8-11. Atomic Idempotent Event Claim + VARCHAR(64) Stream ID Safe Update
$stream = null;
try {
    $pdo->beginTransaction();

    try {
        $insEvt = $pdo->prepare('
            INSERT INTO livekit_webhook_events (event_id, event_type, room_name, payload_hash, created_at)
            VALUES (?, ?, ?, ?, NOW())
        ');
        $insEvt->execute([
            substr($eventId, 0, 128),
            substr($eventType, 0, 64),
            substr($roomName, 0, 128),
            hash('sha256', $rawBody),
        ]);
    } catch (PDOException $evtErr) {
        $sqlState = (string)($evtErr->errorInfo[0] ?? $evtErr->getCode());
        $driverCode = isset($evtErr->errorInfo[1]) ? (int)$evtErr->errorInfo[1] : 0;
        if ($driverCode === 1062) {
            if ($pdo->inTransaction()) {
                $pdo->rollBack();
            }
            jsonResponse([
                'success' => true,
                'idempotent' => true,
                'duplicate' => true,
                'message' => "LiveKit webhook event '{$eventId}' has already been processed."
            ], 200);
        }
        if ($sqlState === '42S02' || $driverCode === 1146) {
            if ($pdo->inTransaction()) {
                $pdo->rollBack();
            }
            header('Retry-After: 5');
            jsonResponse([
                'success' => false,
                'error' => 'Webhook deduplication storage is not available yet.'
            ], 503);
        }
        throw $evtErr;
    }

    // Match room by livekit_room_name first (if migrated), then by VARCHAR(64) string ID fallback
    try {
        $findByRoom = $pdo->prepare('
            SELECT id, user_id, status, viewers_count
            FROM live_streams
            WHERE livekit_room_name = ?
            LIMIT 1
            FOR UPDATE
        ');
        $findByRoom->execute([$roomName]);
        $stream = $findByRoom->fetch(PDO::FETCH_ASSOC);
    } catch (PDOException $roomColErr) {
        $rState = (string)($roomColErr->errorInfo[0] ?? $roomColErr->getCode());
        $rCode = isset($roomColErr->errorInfo[1]) ? (int)$roomColErr->errorInfo[1] : 0;
        if (($rState === '42S22' || $rCode === 1054) && stripos($roomColErr->getMessage(), 'livekit_room_name') !== false) {
            $stream = null;
        } else {
            throw $roomColErr;
        }
    }

    if (!$stream) {
        $streamIdCandidate = trim((string)preg_replace('/^room_/', '', $roomName));
        if ($streamIdCandidate !== '' && strlen($streamIdCandidate) <= 64) {
            $findById = $pdo->prepare('
                SELECT id, user_id, status, viewers_count
                FROM live_streams
                WHERE id = ?
                LIMIT 1
                FOR UPDATE
            ');
            $findById->execute([$streamIdCandidate]);
            $stream = $findById->fetch(PDO::FETCH_ASSOC);
        }
    }

    if (!$stream) {
        $pdo->rollBack();
        header('Retry-After: 5');
        jsonResponse([
            'success' => false,
            'error' => 'Target live stream not found; please retry.'
        ], 503);
    }

    $actualStreamId = (string)$stream['id'];

    if ($eventType === 'participant_joined') {
        if ($stream['status'] !== 'ended') {
            if ($numParticipants !== null) {
                $calcViewers = max(0, $numParticipants - 1);
                $upStmt = $pdo->prepare("
                    UPDATE live_streams
                    SET viewers_count = ?,
                        total_unique_viewers = total_unique_viewers + 1,
                        updated_at = NOW()
                    WHERE id = ? AND status <> 'ended'
                ");
                $upStmt->execute([$calcViewers, $actualStreamId]);
            } else {
                $upStmt = $pdo->prepare("
                    UPDATE live_streams
                    SET viewers_count = viewers_count + 1,
                        total_unique_viewers = total_unique_viewers + 1,
                        updated_at = NOW()
                    WHERE id = ? AND status <> 'ended'
                ");
                $upStmt->execute([$actualStreamId]);
            }
        }
    } elseif ($eventType === 'participant_left') {
        if ($stream['status'] !== 'ended') {
            if ($numParticipants !== null) {
                $calcViewers = max(0, $numParticipants - 1);
                $upStmt = $pdo->prepare("
                    UPDATE live_streams
                    SET viewers_count = ?,
                        updated_at = NOW()
                    WHERE id = ? AND status <> 'ended'
                ");
                $upStmt->execute([$calcViewers, $actualStreamId]);
            } else {
                $upStmt = $pdo->prepare("
                    UPDATE live_streams
                    SET viewers_count = GREATEST(0, viewers_count - 1),
                        updated_at = NOW()
                    WHERE id = ? AND status <> 'ended'
                ");
                $upStmt->execute([$actualStreamId]);
            }
        }
    } elseif ($eventType === 'room_finished') {
        $upStmt = $pdo->prepare("
            UPDATE live_streams
            SET status = 'ended',
                ended_at = COALESCE(ended_at, NOW()),
                viewers_count = 0,
                updated_at = NOW()
            WHERE id = ?
        ");
        $upStmt->execute([$actualStreamId]);
    }

    $pdo->commit();
} catch (Throwable $e) {
    if ($pdo->inTransaction()) {
        $pdo->rollBack();
    }
    error_log('[live/webhook.php] Database error processing webhook event: ' . $e->getMessage());
    if ($isConnectionUnavailable($e)) {
        jsonResponse(['success' => false, 'error' => 'Database connection unavailable while processing webhook event.'], 503);
    }
    jsonResponse(['success' => false, 'error' => 'Database error processing webhook event.'], 500);
}

jsonResponse([
    'success' => true,
    'processed' => true,
    'event_id' => $eventId,
    'event' => $eventType,
    'room' => $roomName,
    'matched_stream_id' => $actualStreamId,
], 200);
