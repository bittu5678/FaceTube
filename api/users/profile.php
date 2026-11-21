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

$method = $_SERVER['REQUEST_METHOD'] ?? '';
if ($method !== 'GET' && $method !== 'POST') {
    jsonResponse(['success' => false, 'error' => 'Method Not Allowed'], 405);
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

$safeRollback = static function (PDO $conn): void {
    try {
        if ($conn->inTransaction()) {
            $conn->rollBack();
        }
    } catch (Throwable $_rollbackErr) {
        error_log('[users/profile.php][ROLLBACK] Rollback failed: ' . $_rollbackErr->getMessage());
    }
};

$readStringField = static function ($val, string $default = ''): string {
    if (is_string($val) || is_int($val) || is_float($val)) {
        return trim((string)$val);
    }
    return $default;
};

$pdo = getDatabaseConnection();

if ($method === 'GET') {
    $raw = $readStringField($_GET['userId'] ?? ($_GET['user_id'] ?? ($_GET['identifier'] ?? '')));
    $suppliedBearerToken = getBearerToken();

    try {
        $authUser = getAuthUser($pdo, true);
    } catch (Throwable $e) {
        $safeRollback($pdo);
        error_log('[users/profile.php][AUTH] Database error: ' . $e->getMessage());
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

    // Never silently downgrade an invalid or expired supplied Bearer token to anonymous access
    if ($suppliedBearerToken !== null && trim($suppliedBearerToken) !== '' && (!$authUser || empty($authUser['user_id']))) {
        jsonResponse([
            'success' => false,
            'error' => 'Invalid or expired authentication session. Please log in again.'
        ], 401);
    }

    if ($raw === '') {
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
        if ($stmt === false) {
            throw new RuntimeException('Failed to prepare profile lookup query.');
        }
        if ($stmt->execute([$raw, $raw, $raw]) === false) {
            throw new RuntimeException('Failed to execute profile lookup query.');
        }
        $profile = $stmt->fetch(PDO::FETCH_ASSOC);

        if (!$profile) {
            jsonResponse(['success' => false, 'error' => 'Profile not found.'], 404);
        }

        if (!empty($profile['channel_logo_url'])) {
            $profile['channel_logo_url'] = toAbsoluteMediaUrl($profile['channel_logo_url'], 'logos');
        }

        $authRole = strtolower(trim((string)($authUser['role'] ?? '')));
        $authPublicId = trim((string)($authUser['user_id'] ?? ''));
        $authInternalId = trim((string)($authUser['id'] ?? ''));
        $targetPublicId = trim((string)($profile['user_id'] ?? ''));
        $targetInternalId = trim((string)($profile['id'] ?? ''));

        $isSelfOrAdmin = $authUser && (
            $authRole === 'admin' ||
            ($authPublicId !== '' && $targetPublicId !== '' && strcasecmp($authPublicId, $targetPublicId) === 0) ||
            ($authInternalId !== '' && $targetInternalId !== '' && strcasecmp($authInternalId, $targetInternalId) === 0)
        );

        jsonResponse([
            'success' => true,
            'profile' => $isSelfOrAdmin ? $profile : sanitizePublicProfile($profile)
        ]);
    } catch (Throwable $e) {
        $safeRollback($pdo);
        error_log('[users/profile.php][GET] Database error: ' . $e->getMessage());
        if ($isConnectionUnavailable($e)) {
            jsonResponse([
                'success' => false,
                'error' => 'Database connection unavailable while loading profile.'
            ], 503);
        }
        jsonResponse([
            'success' => false,
            'error' => 'Failed to load profile due to a server error.'
        ], 500);
    }
} elseif ($method === 'POST') {
    try {
        $authUser = getAuthUser($pdo, true);
    } catch (Throwable $e) {
        $safeRollback($pdo);
        error_log('[users/profile.php][POST][AUTH] Database error: ' . $e->getMessage());
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
            'error' => 'Authentication required. Please provide a valid Bearer session token.'
        ], 401);
    }

    $input = getRequestPayload();
    $requestedUserId = $readStringField($input['userId'] ?? ($input['user_id'] ?? ($input['id'] ?? '')));
    $authPublicId = trim((string)$authUser['user_id']);
    $authInternalId = trim((string)($authUser['id'] ?? ''));

    if ($requestedUserId === '') {
        $userId = $authPublicId;
    } elseif (
        strcasecmp($requestedUserId, $authPublicId) === 0 ||
        ($authInternalId !== '' && strcasecmp($requestedUserId, $authInternalId) === 0)
    ) {
        $userId = $authPublicId;
    } else {
        $isAdmin = isset($authUser['role']) && strtolower(trim((string)$authUser['role'])) === 'admin';
        if (!$isAdmin) {
            jsonResponse([
                'success' => false,
                'error' => 'Unauthorized: Cross-user access is restricted to verified administrators.'
            ], 403);
        }
        $userId = $requestedUserId;
    }

    $updates = [];
    $params = [];

    if (array_key_exists('name', $input)) {
        $cleanName = $readStringField($input['name']);
        if (strlen($cleanName) >= 2) {
            $updates[] = 'name = ?';
            $params[] = $cleanName;
        }
    }

    if (array_key_exists('mobile', $input)) {
        $cleanMobile = $readStringField($input['mobile']);
        if (strlen($cleanMobile) >= 7) {
            $updates[] = 'mobile = ?';
            $params[] = $cleanMobile;
        }
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
            $nameLen = function_exists('mb_strlen')
                ? mb_strlen($trimmedChannelName, 'UTF-8')
                : strlen($trimmedChannelName);
            if ($nameLen > 255) {
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
        if ($stmt === false) {
            throw new RuntimeException('Failed to prepare profile update query.');
        }
        if ($stmt->execute($params) === false) {
            throw new RuntimeException('Failed to execute profile update query.');
        }
        $affectedRows = $stmt->rowCount();

        $stmtGet = $pdo->prepare('
            SELECT id, user_id, name, mobile, email, role, referral_code, avatar_url, channel_logo_url, channel_name, channel_description, created_at
            FROM users
            WHERE id = ? OR UPPER(user_id) = UPPER(?)
            LIMIT 1
        ');
        if ($stmtGet === false) {
            throw new RuntimeException('Failed to prepare updated profile lookup query.');
        }
        if ($stmtGet->execute([$userId, $userId]) === false) {
            throw new RuntimeException('Failed to execute updated profile lookup query.');
        }
        $updatedProfile = $stmtGet->fetch(PDO::FETCH_ASSOC);

        if (!$updatedProfile) {
            if ($affectedRows === 0) {
                jsonResponse(['success' => false, 'error' => 'User not found.'], 404);
            }
            throw new RuntimeException('Updated user profile could not be retrieved.');
        }

        if (!empty($updatedProfile['channel_logo_url'])) {
            $updatedProfile['channel_logo_url'] = toAbsoluteMediaUrl($updatedProfile['channel_logo_url'], 'logos');
        }

        jsonResponse([
            'success' => true,
            'profile' => $updatedProfile,
            'message' => 'Profile updated successfully.'
        ]);
    } catch (Throwable $e) {
        $safeRollback($pdo);
        error_log('[users/profile.php][POST] Database error: ' . $e->getMessage());
        if ($isConnectionUnavailable($e)) {
            jsonResponse([
                'success' => false,
                'error' => 'Database connection unavailable while updating profile.'
            ], 503);
        }
        jsonResponse([
            'success' => false,
            'error' => 'Failed to update profile due to a server error.'
        ], 500);
    }
} else {
    jsonResponse(['success' => false, 'error' => 'Method Not Allowed'], 405);
}
