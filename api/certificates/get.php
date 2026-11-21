<?php
/**
 * FaceTube - Get Digital Certificate API
 * GET /api/certificates/get.php
 */

require_once __DIR__ . '/../config/database.php';
require_once __DIR__ . '/../response.php';

$method = $_SERVER['REQUEST_METHOD'] ?? '';
if ($method !== 'GET') {
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
        error_log('[certificates/get.php][ROLLBACK] Rollback failed: ' . $_rollbackErr->getMessage());
    }
};

$readStringField = static function ($val, string $default = ''): string {
    if (is_string($val) || is_int($val) || is_float($val)) {
        return trim((string)$val);
    }
    return $default;
};

$pdo = getDatabaseConnection();

try {
    $authUser = getAuthUser($pdo, true);
} catch (Throwable $e) {
    $safeRollback($pdo);
    error_log('[certificates/get.php][AUTH] Database error: ' . $e->getMessage());
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

$requestedUserId = $readStringField($_GET['userId'] ?? ($_GET['user_id'] ?? ''));
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
            'error' => 'Unauthorized: Cross-user certificate access is restricted to verified administrators.'
        ], 403);
    }
    $userId = $requestedUserId;
}

try {
    $stmt = $pdo->prepare('SELECT * FROM certificates WHERE UPPER(user_id) = UPPER(?) LIMIT 1');
    if ($stmt === false) {
        throw new RuntimeException('Failed to prepare certificate lookup query.');
    }
    if ($stmt->execute([$userId]) === false) {
        throw new RuntimeException('Failed to execute certificate lookup query.');
    }
    $cert = $stmt->fetch();

    if ($cert) {
        jsonResponse([
            'success' => true,
            'certificate' => [
                'certificateId' => $cert['certificate_id'],
                'userId' => $cert['user_id'],
                'name' => $cert['name'],
                'issueDate' => $cert['issue_date'],
                'verified' => (bool)$cert['verified'],
                'pdfUrl' => $cert['pdf_url'],
            ]
        ]);
    }

    // Default verified certificate response for authorized user
    $stmtUser = $pdo->prepare('SELECT name FROM users WHERE UPPER(user_id) = UPPER(?) LIMIT 1');
    if ($stmtUser === false) {
        throw new RuntimeException('Failed to prepare certificate user lookup query.');
    }
    if ($stmtUser->execute([$userId]) === false) {
        throw new RuntimeException('Failed to execute certificate user lookup query.');
    }
    $u = $stmtUser->fetch();
    $name = $u ? $u['name'] : 'FaceTube Creator';

    jsonResponse([
        'success' => true,
        'certificate' => [
            'certificateId' => 'FT-CERT-' . strtoupper($userId),
            'userId' => $userId,
            'name' => $name,
            'issueDate' => date('Y-m-d'),
            'verified' => true,
        ]
    ]);
} catch (Throwable $e) {
    $safeRollback($pdo);
    error_log('[certificates/get.php] Database error: ' . $e->getMessage());
    if ($isConnectionUnavailable($e)) {
        jsonResponse([
            'success' => false,
            'error' => 'Database connection unavailable while loading certificate.'
        ], 503);
    }
    jsonResponse([
        'success' => false,
        'error' => 'Failed to load certificate due to a server error.'
    ], 500);
}
