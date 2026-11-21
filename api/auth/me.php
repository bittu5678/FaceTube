<?php
/**
 * FaceTube - Current Authenticated User API
 * GET /api/auth/me.php
 */

require_once __DIR__ . '/../config/database.php';
require_once __DIR__ . '/../response.php';

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

$pdo = getDatabaseConnection();
$suppliedBearerToken = getBearerToken();

if ($suppliedBearerToken === null) {
    jsonResponse(['authenticated' => false, 'user' => null], 200);
}

$user = null;
try {
    $user = getAuthUser($pdo, true);
} catch (Throwable $e) {
    error_log('[auth/me.php][AUTH] Database error: ' . $e->getMessage());
    if ($isConnectionUnavailable($e)) {
        jsonResponse([
            'success' => false,
            'authenticated' => false,
            'user' => null,
            'error' => 'Database connection unavailable during authentication check.'
        ], 503);
    }
    jsonResponse([
        'success' => false,
        'authenticated' => false,
        'user' => null,
        'error' => 'Database error during authentication check.'
    ], 500);
}

if (!$user || !is_array($user) || empty($user['user_id'])) {
    jsonResponse(['authenticated' => false, 'user' => null], 200);
}

jsonResponse([
    'authenticated' => true,
    'user' => $user
]);
