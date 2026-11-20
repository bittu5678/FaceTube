<?php
/**
 * FaceTube - User Profile API
 * GET/POST /api/users/profile.php
 */

require_once __DIR__ . '/../config/database.php';
require_once __DIR__ . '/../response.php';

function validateProfileMediaUrl($rawValue, $fieldName) {
    if ($rawValue === null) {
        return [true, null, null];
    }
    if (!is_string($rawValue)) {
        return [false, null, "Invalid {$fieldName} format."];
    }
    $trimmed = trim($rawValue);
    if ($trimmed === '') {
        return [true, $fieldName === 'channel_logo_url' ? null : '', null];
    }
    if (strlen($trimmed) > 500) {
        return [false, null, "{$fieldName} must be 500 characters or fewer."];
    }
    if (preg_match('/[\s\x00-\x1f\x7f\\\\]/', $trimmed)) {
        return [false, null, "Invalid {$fieldName} URL format."];
    }
    if (str_starts_with($trimmed, '/uploads/')) {
        if (
            str_contains($trimmed, '..') ||
            strlen($trimmed) <= strlen('/uploads/') ||
            !preg_match('/^\/uploads\/[A-Za-z0-9._\-\/]+$/', $trimmed)
        ) {
            return [false, null, "Invalid {$fieldName} path."];
        }
        return [true, $trimmed, null];
    }
    if (preg_match('/^https?:\/\//i', $trimmed) && filter_var($trimmed, FILTER_VALIDATE_URL)) {
        $parts = parse_url($trimmed);
        $scheme = strtolower($parts['scheme'] ?? '');
        $host = $parts['host'] ?? '';
        if (in_array($scheme, ['http', 'https'], true) && $host !== '') {
            return [true, $trimmed, null];
        }
    }
    return [false, null, "Invalid {$fieldName}: must be an HTTP/HTTPS URL or approved /uploads/ path."];
}

function validateChannelDescription($rawValue) {
    if ($rawValue === null) {
        return [true, null, null];
    }
    if (!is_string($rawValue)) {
        return [false, null, 'Invalid channel_description format.'];
    }
    $normalized = str_replace(["\r\n", "\r"], "\n", $rawValue);
    if (preg_match('/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/', $normalized)) {
        return [false, null, 'Channel description contains invalid control characters.'];
    }
    $trimmed = trim($normalized);
    if ($trimmed === '') {
        return [true, null, null];
    }
    $length = function_exists('mb_strlen') ? mb_strlen($trimmed, 'UTF-8') : strlen($trimmed);
    if ($length > 1000) {
        return [false, null, 'Channel description must be 1000 characters or fewer.'];
    }
    if (
        preg_match('/<\/?[a-zA-Z!\/?]/', $trimmed) ||
        preg_match('/\b(?:javascript|vbscript)\s*:/i', $trimmed) ||
        preg_match('/data\s*:\s*text\/html/i', $trimmed) ||
        preg_match('/\bon[a-z]+\s*=/i', $trimmed)
    ) {
        return [false, null, 'Channel description must be plain text without HTML tags or scripts.'];
    }
    return [true, $trimmed, null];
}

function sanitizePublicProfile($row) {
    return [
        'id' => $row['id'],
        'user_id' => $row['user_id'],
        'name' => $row['name'],
        'avatar_url' => $row['avatar_url'] ?? null,
        'channel_logo_url' => $row['channel_logo_url'] ?? null,
        'channel_name' => $row['channel_name'] ?? null,
        'channel_description' => $row['channel_description'] ?? null,
        'created_at' => $row['created_at'],
    ];
}

$pdo = getDatabaseConnection();

if ($_SERVER['REQUEST_METHOD'] === 'GET') {
    $raw = trim($_GET['userId'] ?? ($_GET['user_id'] ?? ($_GET['identifier'] ?? '')));
    $authUser = getAuthUser($pdo);
    if (empty($raw)) {
        if ($authUser) {
            jsonResponse(['success' => true, 'profile' => $authUser]);
        }
        jsonResponse(['success' => false, 'error' => 'User identifier required.'], 400);
    }

    try {
        $stmt = $pdo->prepare('
            SELECT id, user_id, name, mobile, email, role, referral_code, avatar_url, channel_logo_url, channel_name, channel_description, created_at
            FROM users
            WHERE UPPER(user_id) = UPPER(?) OR LOWER(email) = LOWER(?) OR id = ?
            LIMIT 1
        ');
        $stmt->execute([$raw, $raw, $raw]);
        $profile = $stmt->fetch();

        if (!$profile) {
            jsonResponse(['success' => false, 'error' => 'Profile not found.'], 404);
        }

        if (!empty($profile['channel_logo_url'])) {
            $profile['channel_logo_url'] = toAbsoluteMediaUrl($profile['channel_logo_url'], 'logos');
        }

        $isSelfOrAdmin = $authUser && (
            strtolower($authUser['role'] ?? '') === 'admin' ||
            strcasecmp((string)($authUser['user_id'] ?? ''), (string)($profile['user_id'] ?? '')) === 0 ||
            (string)($authUser['id'] ?? '') === (string)($profile['id'] ?? '')
        );

        jsonResponse([
            'success' => true,
            'profile' => $isSelfOrAdmin ? $profile : sanitizePublicProfile($profile)
        ]);
    } catch (PDOException $e) {
        jsonResponse(['success' => false, 'error' => 'Database error: ' . $e->getMessage()], 500);
    }
} elseif ($_SERVER['REQUEST_METHOD'] === 'POST') {
    $input = getRequestPayload();
    $requestedUserId = trim((string)($input['userId'] ?? ($input['user_id'] ?? ($input['id'] ?? ''))));
    $authCheck = getAuthUser($pdo);
    if ($authCheck && $requestedUserId !== '' && (string)$requestedUserId === (string)($authCheck['id'] ?? '')) {
        $requestedUserId = (string)$authCheck['user_id'];
    }
    [$authUser, $effectiveUserId] = requireAuthUser($pdo, $requestedUserId !== '' ? $requestedUserId : null);
    $userId = $effectiveUserId ?: $authUser['id'];

    $updates = [];
    $params = [];

    if (isset($input['name']) && strlen(trim((string)$input['name'])) >= 2) {
        $updates[] = 'name = ?';
        $params[] = trim((string)$input['name']);
    }

    if (isset($input['mobile']) && strlen(trim((string)$input['mobile'])) >= 7) {
        $updates[] = 'mobile = ?';
        $params[] = trim((string)$input['mobile']);
    }

    if (array_key_exists('channel_logo_url', $input) || array_key_exists('channelLogoUrl', $input)) {
        $rawLogo = array_key_exists('channel_logo_url', $input) ? $input['channel_logo_url'] : $input['channelLogoUrl'];
        [$ok, $cleanLogo, $err] = validateProfileMediaUrl($rawLogo, 'channel_logo_url');
        if (!$ok) {
            jsonResponse(['success' => false, 'error' => $err], 400);
        }
        $updates[] = 'channel_logo_url = ?';
        $params[] = $cleanLogo;
    }

    if (array_key_exists('channel_name', $input) || array_key_exists('channelName', $input)) {
        $rawChannelName = array_key_exists('channel_name', $input) ? $input['channel_name'] : $input['channelName'];
        if ($rawChannelName === null) {
            $updates[] = 'channel_name = ?';
            $params[] = null;
        } elseif (!is_string($rawChannelName)) {
            jsonResponse(['success' => false, 'error' => 'Invalid channel_name format.'], 400);
        } else {
            $trimmedChannelName = trim($rawChannelName);
            if (mb_strlen($trimmedChannelName) > 255) {
                jsonResponse(['success' => false, 'error' => 'Channel name must be 255 characters or fewer.'], 400);
            }
            $updates[] = 'channel_name = ?';
            $params[] = $trimmedChannelName;
        }
    }

    if (array_key_exists('channel_description', $input) || array_key_exists('channelDescription', $input)) {
        $rawDescription = array_key_exists('channel_description', $input)
            ? $input['channel_description']
            : $input['channelDescription'];
        [$ok, $cleanDescription, $err] = validateChannelDescription($rawDescription);
        if (!$ok) {
            jsonResponse(['success' => false, 'error' => $err], 400);
        }
        $updates[] = 'channel_description = ?';
        $params[] = $cleanDescription;
    }

    if (array_key_exists('avatar_url', $input) || array_key_exists('avatarUrl', $input)) {
        $rawAvatar = array_key_exists('avatar_url', $input) ? $input['avatar_url'] : $input['avatarUrl'];
        [$ok, $cleanAvatar, $err] = validateProfileMediaUrl($rawAvatar, 'avatar_url');
        if (!$ok) {
            jsonResponse(['success' => false, 'error' => $err], 400);
        }
        $updates[] = 'avatar_url = ?';
        $params[] = $cleanAvatar;
    }

    if (empty($updates)) {
        jsonResponse(['success' => false, 'error' => 'No valid fields provided to update.'], 400);
    }

    $params[] = $userId;
    $params[] = $userId;

    try {
        $sql = 'UPDATE users SET ' . implode(', ', $updates) . ', updated_at = NOW() WHERE id = ? OR UPPER(user_id) = UPPER(?)';
        $stmt = $pdo->prepare($sql);
        $stmt->execute($params);

        $stmtGet = $pdo->prepare('
            SELECT id, user_id, name, mobile, email, role, referral_code, avatar_url, channel_logo_url, channel_name, channel_description, created_at
            FROM users
            WHERE id = ? OR UPPER(user_id) = UPPER(?)
            LIMIT 1
        ');
        $stmtGet->execute([$userId, $userId]);
        $updatedProfile = $stmtGet->fetch();

        if (!$updatedProfile) {
            jsonResponse(['success' => false, 'error' => 'User not found.'], 404);
        }

        if (!empty($updatedProfile['channel_logo_url'])) {
            $updatedProfile['channel_logo_url'] = toAbsoluteMediaUrl($updatedProfile['channel_logo_url'], 'logos');
        }

        jsonResponse([
            'success' => true,
            'profile' => $updatedProfile,
            'message' => 'Profile updated successfully.'
        ]);
    } catch (PDOException $e) {
        jsonResponse(['success' => false, 'error' => 'Database update failed: ' . $e->getMessage()], 500);
    }
} else {
    jsonResponse(['success' => false, 'error' => 'Method Not Allowed'], 405);
}
