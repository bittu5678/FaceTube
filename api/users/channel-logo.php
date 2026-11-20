<?php
/**
 * FaceTube - Update Channel Logo & Details API
 * POST /api/users/channel-logo.php
 */

require_once __DIR__ . '/../config/database.php';
require_once __DIR__ . '/../response.php';

if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    jsonResponse(['success' => false, 'error' => 'Method Not Allowed'], 405);
}

$pdo = getDatabaseConnection();
$input = getRequestPayload();
$requestedUserId = trim((string)($input['userId'] ?? ($input['user_id'] ?? ($input['id'] ?? ''))));

[$authUser, $effectiveUserId] = requireAuthUser($pdo, $requestedUserId !== '' ? $requestedUserId : null);

$hasLogoKey = array_key_exists('channel_logo_url', $input) || array_key_exists('channelLogoUrl', $input);
$rawLogoField = array_key_exists('channel_logo_url', $input)
    ? $input['channel_logo_url']
    : (array_key_exists('channelLogoUrl', $input) ? $input['channelLogoUrl'] : null);
$removeLogoFlag = (isset($input['removeLogo']) && $input['removeLogo'] === true)
    || (isset($input['remove_logo']) && $input['remove_logo'] === true);

if ($hasLogoKey && $rawLogoField !== null && !is_string($rawLogoField)) {
    jsonResponse(['success' => false, 'error' => 'Invalid channel logo URL format'], 400);
}

$rawLogoUrl = is_string($rawLogoField) ? trim($rawLogoField) : '';
if ($rawLogoUrl !== '' && preg_match('/^(https?:\/\/[^\/]+)(https?:\/\/.+)$/i', $rawLogoUrl, $dupMatches)) {
    $rawLogoUrl = trim($dupMatches[2]);
}

$shouldRemoveLogo = $removeLogoFlag || ($hasLogoKey && ($rawLogoField === null || $rawLogoUrl === ''));
$hasLogoUpdate = $shouldRemoveLogo || ($hasLogoKey && $rawLogoUrl !== '');
$channelLogoUrl = $shouldRemoveLogo ? null : $rawLogoUrl;
$channelName = trim((string)($input['channel_name'] ?? ($input['channelName'] ?? '')));

$hasDescriptionKey = array_key_exists('channel_description', $input) || array_key_exists('channelDescription', $input);
$rawDescriptionField = array_key_exists('channel_description', $input)
    ? $input['channel_description']
    : (array_key_exists('channelDescription', $input) ? $input['channelDescription'] : null);
$channelDescription = null;

if ($hasDescriptionKey && $rawDescriptionField !== null) {
    if (!is_string($rawDescriptionField)) {
        jsonResponse(['success' => false, 'error' => 'Invalid channel_description format'], 400);
    }
    $normalizedDescription = str_replace(["\r\n", "\r"], "\n", $rawDescriptionField);
    if (preg_match('/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/', $normalizedDescription)) {
        jsonResponse(['success' => false, 'error' => 'Channel description contains invalid control characters'], 400);
    }
    $trimmedDescription = trim($normalizedDescription);
    $descLen = function_exists('mb_strlen')
        ? mb_strlen($trimmedDescription, 'UTF-8')
        : strlen($trimmedDescription);
    if ($descLen > 1000) {
        jsonResponse(['success' => false, 'error' => 'Channel description must be 1000 characters or fewer'], 400);
    }
    if (
        $trimmedDescription !== '' && (
            preg_match('/<\/?[a-zA-Z!\/?]/', $trimmedDescription) ||
            preg_match('/\b(?:javascript|vbscript)\s*:/i', $trimmedDescription) ||
            preg_match('/data\s*:\s*text\/html/i', $trimmedDescription) ||
            preg_match('/\bon[a-z]+\s*=/i', $trimmedDescription)
        )
    ) {
        jsonResponse(['success' => false, 'error' => 'Channel description must be plain text without HTML tags or scripts'], 400);
    }
    $channelDescription = $trimmedDescription !== '' ? $trimmedDescription : null;
}

if (!$hasLogoUpdate && $channelName === '' && !$hasDescriptionKey) {
    jsonResponse(['success' => false, 'error' => 'No channel updates provided'], 400);
}

if ($hasLogoUpdate && !$shouldRemoveLogo && $channelLogoUrl !== '') {
    if (strlen($channelLogoUrl) > 500) {
        jsonResponse(['success' => false, 'error' => 'Channel logo URL must be 500 characters or fewer'], 400);
    }
    if (preg_match('/[\s\x00-\x1f\x7f\\\\]/', $channelLogoUrl)) {
        jsonResponse(['success' => false, 'error' => 'Invalid channel logo URL format'], 400);
    }
    $isSafeUrl = false;
    if (str_starts_with($channelLogoUrl, '/uploads/')) {
        $isSafeUrl = !str_contains($channelLogoUrl, '..')
            && strlen($channelLogoUrl) > strlen('/uploads/')
            && (bool)preg_match('/^\/uploads\/[A-Za-z0-9._\-\/]+$/', $channelLogoUrl);
    } elseif (preg_match('/^https?:\/\//i', $channelLogoUrl) && filter_var($channelLogoUrl, FILTER_VALIDATE_URL)) {
        $parts = parse_url($channelLogoUrl);
        $scheme = strtolower($parts['scheme'] ?? '');
        $host = $parts['host'] ?? '';
        $isSafeUrl = in_array($scheme, ['http', 'https'], true) && $host !== '';
    }
    if (!$isSafeUrl) {
        jsonResponse(['success' => false, 'error' => 'Invalid channel logo URL format'], 400);
    }
}

if ($channelName !== '' && mb_strlen($channelName) > 255) {
    jsonResponse(['success' => false, 'error' => 'Channel name must be 255 characters or fewer'], 400);
}

try {
    $stmtFind = $pdo->prepare('
        SELECT id, user_id, channel_logo_url, channel_name, channel_description
        FROM users
        WHERE UPPER(id) = UPPER(?) OR UPPER(user_id) = UPPER(?)
        LIMIT 1
    ');
    $stmtFind->execute([$effectiveUserId, $effectiveUserId]);
    $targetUser = $stmtFind->fetch();

    if (!$targetUser) {
        jsonResponse(['success' => false, 'error' => 'Target user not found'], 404);
    }

    $canonicalId = $targetUser['id'];
    $canonicalUserId = $targetUser['user_id'];

    $updates = [];
    $params = [];

    if ($hasLogoUpdate) {
        $updates[] = '`channel_logo_url` = ?';
        $params[] = $shouldRemoveLogo ? null : $channelLogoUrl;
    }

    if ($channelName !== '') {
        $updates[] = '`channel_name` = ?';
        $params[] = $channelName;
    }

    if ($hasDescriptionKey) {
        $updates[] = '`channel_description` = ?';
        $params[] = $channelDescription;
    }

    $updates[] = '`updated_at` = NOW()';
    $params[] = $canonicalId;
    $params[] = $canonicalUserId;

    $sql = 'UPDATE `users` SET ' . implode(', ', $updates) . ' WHERE `id` = ? OR UPPER(`user_id`) = UPPER(?)';
    $stmt = $pdo->prepare($sql);
    $stmt->execute($params);

    $stmtGet = $pdo->prepare('
        SELECT channel_logo_url, channel_name, channel_description
        FROM users
        WHERE id = ? OR UPPER(user_id) = UPPER(?)
        LIMIT 1
    ');
    $stmtGet->execute([$canonicalId, $canonicalUserId]);
    $updated = $stmtGet->fetch();

    $resolvedLogoUrl = !empty($updated['channel_logo_url'])
        ? toAbsoluteMediaUrl($updated['channel_logo_url'], 'logos')
        : null;
    $resolvedChannelName = $updated['channel_name'] ?? ($channelName !== '' ? $channelName : null);
    $resolvedChannelDescription = array_key_exists('channel_description', $updated ?: [])
        ? $updated['channel_description']
        : $channelDescription;

    jsonResponse([
        'success' => true,
        'message' => $shouldRemoveLogo && $channelName === '' && !$hasDescriptionKey
            ? 'Channel logo removed successfully'
            : 'Channel details updated successfully',
        'channel_logo_url' => $resolvedLogoUrl,
        'channel_name' => $resolvedChannelName,
        'channel_description' => $resolvedChannelDescription,
        'channelLogoUrl' => $resolvedLogoUrl,
        'channelName' => $resolvedChannelName,
        'channelDescription' => $resolvedChannelDescription,
    ]);
} catch (PDOException $e) {
    jsonResponse(['success' => false, 'error' => 'Database error: ' . $e->getMessage()], 500);
}
