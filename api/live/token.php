<?php
/**
 * FaceTube - LiveKit Cloud WebRTC Access Token API
 * POST /api/live/token.php
 *
 * Secure server-side LiveKit JWT access-token generation:
 * - Validates user authentication & stream ownership
 * - Broadcaster: room join + camera/microphone publishing (canPublish: true)
 * - Viewer: room join + subscribe only (canPublish: false)
 * - Short-lived tokens (15-30 minutes)
 * - Never trusts client-supplied user IDs or role claims
 */

require_once __DIR__ . '/../config/database.php';
require_once __DIR__ . '/../response.php';

if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    jsonResponse(['success' => false, 'error' => 'Method Not Allowed. POST is required.'], 405);
}

$pdo = getDatabaseConnection();

// 1. Load LiveKit Cloud credentials from direct config file or server environment
$livekitUrl = getenv('LIVEKIT_URL') ?: ($_ENV['LIVEKIT_URL'] ?? ($_SERVER['LIVEKIT_URL'] ?? ''));
$apiKey = getenv('LIVEKIT_API_KEY') ?: ($_ENV['LIVEKIT_API_KEY'] ?? ($_SERVER['LIVEKIT_API_KEY'] ?? ''));
$apiSecret = getenv('LIVEKIT_API_SECRET') ?: ($_ENV['LIVEKIT_API_SECRET'] ?? ($_SERVER['LIVEKIT_API_SECRET'] ?? ''));

// Check for livekit.php strictly inside the intended domain directory, directly beside the public document root:
// - /domains/facetube.online/public_html/api   -> /domains/facetube.online/livekit.php
// - /domains/api.facetube.online/public_html   -> /domains/api.facetube.online/livekit.php
// - /domains/facetube.online/api               -> /domains/facetube.online/livekit.php
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

    // If API root is nested inside public_html (e.g. /domains/facetube.online/public_html/api),
    // forbid the enclosing public_html as well and step directly to /domains/facetube.online.
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

    // Reject parent container directories (e.g. /domains) or public web roots
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

    // Enforce exact containment in $allowedDomainDir (blocks symlink escapes to /domains or elsewhere)
    if ($candidateDir !== $allowedDomainDir || strpos($normalizedCandidate, $allowedDomainDir . '/') !== 0) {
        continue;
    }

    // Enforce exclusion from all public web roots
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
    $customLivekit = include $livekitConfigPath;
    if (is_array($customLivekit)) {
        $livekitUrl = $customLivekit['LIVEKIT_URL'] ?? ($customLivekit['livekit_url'] ?? ($customLivekit['url'] ?? $livekitUrl));
        $apiKey = $customLivekit['LIVEKIT_API_KEY'] ?? ($customLivekit['livekit_api_key'] ?? ($customLivekit['apiKey'] ?? ($customLivekit['api_key'] ?? $apiKey)));
        $apiSecret = $customLivekit['LIVEKIT_API_SECRET'] ?? ($customLivekit['livekit_api_secret'] ?? ($customLivekit['apiSecret'] ?? ($customLivekit['api_secret'] ?? $apiSecret)));
    }
    if (empty($livekitUrl) && defined('LIVEKIT_URL')) $livekitUrl = constant('LIVEKIT_URL');
    if (empty($apiKey) && defined('LIVEKIT_API_KEY')) $apiKey = constant('LIVEKIT_API_KEY');
    if (empty($apiSecret) && defined('LIVEKIT_API_SECRET')) $apiSecret = constant('LIVEKIT_API_SECRET');
    if (empty($livekitUrl) && isset($LIVEKIT_URL)) $livekitUrl = $LIVEKIT_URL;
    if (empty($apiKey) && isset($LIVEKIT_API_KEY)) $apiKey = $LIVEKIT_API_KEY;
    if (empty($apiSecret) && isset($LIVEKIT_API_SECRET)) $apiSecret = $LIVEKIT_API_SECRET;
}

if (empty($livekitUrl) || empty($apiKey) || empty($apiSecret)) {
    jsonResponse([
        'success' => false,
        'error' => 'LiveKit Cloud streaming service is not configured on this server. Please define LIVEKIT_URL, LIVEKIT_API_KEY, and LIVEKIT_API_SECRET in server environment.'
    ], 503);
}

// 2. Parse request payload
$payload = getRequestPayload();
$streamId = trim((string)($payload['stream_id'] ?? ($payload['streamId'] ?? '')));
$requestedRole = strtolower(trim((string)($payload['role'] ?? 'subscriber')));

if (empty($streamId)) {
    jsonResponse(['success' => false, 'error' => 'Stream ID (stream_id) is required.'], 400);
}

// 3. Verify stream existence and status in database
$stream = null;
try {
    $stmt = $pdo->prepare('
        SELECT id, user_id, title, status, stream_key,
               COALESCE(livekit_room_name, CONCAT("room_", id)) as room_name
        FROM live_streams
        WHERE id = ?
        LIMIT 1
    ');
    $stmt->execute([$streamId]);
    $stream = $stmt->fetch();
} catch (Exception $e) {
    // If livekit_room_name column not migrated yet, query without it
    try {
        $stmt = $pdo->prepare('
            SELECT id, user_id, title, status, stream_key, CONCAT("room_", id) as room_name
            FROM live_streams
            WHERE id = ?
            LIMIT 1
        ');
        $stmt->execute([$streamId]);
        $stream = $stmt->fetch();
    } catch (Exception $fallbackErr) {
        jsonResponse(['success' => false, 'error' => 'Database error loading stream.'], 500);
    }
}

if (!$stream) {
    jsonResponse(['success' => false, 'error' => "Live stream '{$streamId}' not found."], 404);
}

if ($stream['status'] === 'ended') {
    jsonResponse(['success' => false, 'error' => 'This live broadcast has ended.'], 410);
}

// 4. Role validation and permission check
$authUser = getAuthUser($pdo);
$roomName = $stream['room_name'] ?: ("room_" . $stream['id']);

$isBroadcaster = false;
$participantIdentity = '';
$participantName = '';

if ($requestedRole === 'publisher' || $requestedRole === 'broadcaster') {
    // Broadcaster MUST be authenticated
    if (!$authUser) {
        jsonResponse([
            'success' => false,
            'error' => 'Authentication required to obtain broadcaster publishing permissions.'
        ], 401);
    }

    // Verify stream ownership (only the stream creator or verified admin can publish)
    $streamOwner = strtoupper((string)$stream['user_id']);
    $requestUser = strtoupper((string)$authUser['user_id']);
    $userRole = strtolower((string)($authUser['role'] ?? 'user'));

    if ($streamOwner !== $requestUser && $userRole !== 'admin') {
        jsonResponse([
            'success' => false,
            'error' => 'Unauthorized. You do not own this live stream and cannot broadcast to it.'
        ], 403);
    }

    $isBroadcaster = true;
    $participantIdentity = $authUser['user_id'];
    $participantName = $authUser['name'] ?: 'Broadcaster';
} else {
    // Subscriber / Viewer role
    if ($authUser) {
        $participantIdentity = $authUser['user_id'];
        $participantName = $authUser['name'] ?: 'Viewer';
    } else {
        // Safe, deterministic guest identity
        $ip = $_SERVER['REMOTE_ADDR'] ?? '127.0.0.1';
        $ua = $_SERVER['HTTP_USER_AGENT'] ?? 'browser';
        $guestHash = substr(hash('sha256', $ip . '|' . $ua . '|' . session_id()), 0, 12);
        $participantIdentity = 'guest_' . $guestHash;
        $participantName = 'Viewer';
    }
}

// 5. Construct VideoGrant claims according to official LiveKit specifications
$now = time();
$expirySeconds = 1800; // 30 minutes (short-lived)

if ($isBroadcaster) {
    $videoGrant = [
        'room' => $roomName,
        'roomJoin' => true,
        'canPublish' => true,
        'canPublishSources' => ['camera', 'microphone'],
        'canSubscribe' => true,
        'canPublishData' => true,
    ];
} else {
    $videoGrant = [
        'room' => $roomName,
        'roomJoin' => true,
        'canPublish' => false,
        'canSubscribe' => true,
        'canPublishData' => true,
    ];
}

$jwtHeader = [
    'alg' => 'HS256',
    'typ' => 'JWT',
];

$jwtPayload = [
    'iss' => $apiKey,
    'sub' => $participantIdentity,
    'name' => $participantName,
    'nbf' => $now,
    'exp' => $now + $expirySeconds,
    'video' => $videoGrant,
];

// 6. Base64URL-encode and sign JWT
function base64UrlEncode($data) {
    return rtrim(strtr(base64_encode($data), '+/', '-_'), '=');
}

$encodedHeader = base64UrlEncode(json_encode($jwtHeader, JSON_UNESCAPED_SLASHES));
$encodedPayload = base64UrlEncode(json_encode($jwtPayload, JSON_UNESCAPED_SLASHES));
$signature = hash_hmac('sha256', "{$encodedHeader}.{$encodedPayload}", $apiSecret, true);
$encodedSignature = base64UrlEncode($signature);

$jwtToken = "{$encodedHeader}.{$encodedPayload}.{$encodedSignature}";

// Return verified LiveKit connection details
jsonResponse([
    'success' => true,
    'token' => $jwtToken,
    'url' => $livekitUrl,
    'room' => $roomName,
    'stream_id' => $stream['id'],
    'identity' => $participantIdentity,
    'role' => $isBroadcaster ? 'publisher' : 'subscriber',
    'can_publish' => $isBroadcaster,
    'expires_in' => $expirySeconds,
], 200);
