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
$requestedUserId = trim((string)($input['userId'] ?? ($input['user_id'] ?? '')));

[$authUser, $effectiveUserId] = requireAuthUser($pdo, $requestedUserId !== '' ? $requestedUserId : null);

$channelLogoUrl = trim((string)($input['channel_logo_url'] ?? ($input['channelLogoUrl'] ?? '')));
$channelName = trim((string)($input['channel_name'] ?? ($input['channelName'] ?? '')));

if ($channelLogoUrl === '' && $channelName === '') {
    jsonResponse(['success' => false, 'error' => 'No channel updates provided'], 400);
}

if ($channelLogoUrl !== '') {
    if (strlen($channelLogoUrl) > 500) {
        jsonResponse(['success' => false, 'error' => 'Channel logo URL must be 500 characters or fewer'], 400);
    }
    $isSafeUrl = str_starts_with($channelLogoUrl, '/uploads/') || preg_match('/^https?:\/\/.+/i', $channelLogoUrl);
    if (!$isSafeUrl) {
        jsonResponse(['success' => false, 'error' => 'Invalid channel logo URL format'], 400);
    }
}

if ($channelName !== '' && mb_strlen($channelName) > 255) {
    jsonResponse(['success' => false, 'error' => 'Channel name must be 255 characters or fewer'], 400);
}

try {
    $updates = [];
    $params = [];

    if ($channelLogoUrl !== '') {
        $updates[] = '`channel_logo_url` = ?';
        $params[] = $channelLogoUrl;
    }

    if ($channelName !== '') {
        $updates[] = '`channel_name` = ?';
        $params[] = $channelName;
    }

    $updates[] = '`updated_at` = NOW()';
    $params[] = $effectiveUserId;

    $sql = 'UPDATE `users` SET ' . implode(', ', $updates) . ' WHERE UPPER(`user_id`) = UPPER(?)';
    $stmt = $pdo->prepare($sql);
    $stmt->execute($params);

    $stmtGet = $pdo->prepare('
        SELECT channel_logo_url, channel_name
        FROM users
        WHERE UPPER(user_id) = UPPER(?)
        LIMIT 1
    ');
    $stmtGet->execute([$effectiveUserId]);
    $updated = $stmtGet->fetch();

    $resolvedLogoUrl = !empty($updated['channel_logo_url'])
        ? toAbsoluteMediaUrl($updated['channel_logo_url'], 'logos')
        : null;
    $resolvedChannelName = $updated['channel_name'] ?? ($channelName !== '' ? $channelName : null);

    jsonResponse([
        'success' => true,
        'message' => 'Channel details updated successfully',
        'channel_logo_url' => $resolvedLogoUrl,
        'channel_name' => $resolvedChannelName,
        'channelLogoUrl' => $resolvedLogoUrl,
        'channelName' => $resolvedChannelName,
    ]);
} catch (PDOException $e) {
    jsonResponse(['success' => false, 'error' => 'Database error: ' . $e->getMessage()], 500);
}
