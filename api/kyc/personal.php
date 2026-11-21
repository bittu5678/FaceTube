<?php
/**
 * FaceTube - Personal KYC API
 * GET/POST /api/kyc/personal.php
 */

require_once __DIR__ . '/../config/database.php';
require_once __DIR__ . '/../response.php';

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
        error_log('[kyc/personal.php][ROLLBACK] Rollback failed: ' . $_rollbackErr->getMessage());
    }
};

$readStringField = static function ($val, string $default = ''): string {
    if (is_string($val) || is_int($val) || is_float($val)) {
        return trim((string)$val);
    }
    return $default;
};

$resolveTargetUserId = static function (array $authUser, string $requestedUserId): string {
    $authPublicId = trim((string)($authUser['user_id'] ?? ''));
    $authInternalId = trim((string)($authUser['id'] ?? ''));

    if ($requestedUserId === '') {
        return $authPublicId;
    }

    $matchesPublicId = $authPublicId !== '' && strcasecmp($requestedUserId, $authPublicId) === 0;
    $matchesInternalId = $authInternalId !== '' && strcasecmp($requestedUserId, $authInternalId) === 0;
    if ($matchesPublicId || $matchesInternalId) {
        return $authPublicId;
    }

    $isAdmin = isset($authUser['role']) && strtolower(trim((string)$authUser['role'])) === 'admin';
    if (!$isAdmin) {
        jsonResponse([
            'success' => false,
            'error' => 'Unauthorized: Cross-user KYC access is restricted to verified administrators.'
        ], 403);
    }

    return $requestedUserId;
};

$pdo = getDatabaseConnection();

try {
    $authUser = getAuthUser($pdo, true);
} catch (Throwable $e) {
    $safeRollback($pdo);
    error_log('[kyc/personal.php][AUTH] Database error: ' . $e->getMessage());
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

if ($method === 'GET') {
    $requestedUserId = $readStringField($_GET['userId'] ?? ($_GET['user_id'] ?? ''));
    $userId = $resolveTargetUserId($authUser, $requestedUserId);

    try {
        $stmt = $pdo->prepare('SELECT * FROM kyc_records WHERE UPPER(user_id) = UPPER(?) LIMIT 1');
        if ($stmt === false) {
            throw new RuntimeException('Failed to prepare Personal KYC lookup query.');
        }
        if ($stmt->execute([$userId]) === false) {
            throw new RuntimeException('Failed to execute Personal KYC lookup query.');
        }
        $row = $stmt->fetch();

        if ($row) {
            jsonResponse([
                'success' => true,
                'kyc' => [
                    'fullName' => $row['full_name'],
                    'mobile' => $row['mobile'],
                    'dob' => $row['dob'],
                    'address' => $row['address'],
                    'city' => $row['city'],
                    'state' => $row['state'],
                    'pincode' => $row['pincode'],
                    'nomineeName' => $row['nominee_name'],
                    'nomineeRelation' => $row['nominee_relation'],
                    'nomineeMobile' => $row['nominee_mobile'],
                    'status' => $row['status'],
                    'submittedAt' => $row['created_at'],
                ]
            ]);
        }

        jsonResponse(['success' => true, 'kyc' => null]);
    } catch (Throwable $e) {
        $safeRollback($pdo);
        error_log('[kyc/personal.php][GET] Database error: ' . $e->getMessage());
        if ($isConnectionUnavailable($e)) {
            jsonResponse([
                'success' => false,
                'error' => 'Database connection unavailable while loading Personal KYC.'
            ], 503);
        }
        jsonResponse([
            'success' => false,
            'error' => 'Failed to load Personal KYC due to a server error.'
        ], 500);
    }
} else {
    $input = getRequestPayload();
    $requestedUserId = $readStringField($input['userId'] ?? ($input['user_id'] ?? ''));
    $userId = $resolveTargetUserId($authUser, $requestedUserId);

    $fullName = $readStringField($input['fullName'] ?? ($input['full_name'] ?? ''));
    $mobile = $readStringField($input['mobile'] ?? '');
    $dob = $readStringField($input['dob'] ?? '');
    $address = $readStringField($input['address'] ?? '');
    $city = $readStringField($input['city'] ?? '');
    $state = $readStringField($input['state'] ?? '');
    $pincode = $readStringField($input['pincode'] ?? '');
    $nomineeName = $readStringField($input['nomineeName'] ?? ($input['nominee_name'] ?? ''));
    $nomineeRelation = $readStringField($input['nomineeRelation'] ?? ($input['nominee_relation'] ?? ''));
    $nomineeMobile = $readStringField($input['nomineeMobile'] ?? ($input['nominee_mobile'] ?? ''));

    try {
        $stmt = $pdo->prepare('
            INSERT INTO kyc_records (
                user_id, full_name, mobile, dob, address, city, state, pincode,
                nominee_name, nominee_relation, nominee_mobile, status, created_at, updated_at
            ) VALUES (
                ?, ?, ?, ?, ?, ?, ?, ?,
                ?, ?, ?, "Submitted", NOW(), NOW()
            )
            ON DUPLICATE KEY UPDATE
                full_name = VALUES(full_name),
                mobile = VALUES(mobile),
                dob = VALUES(dob),
                address = VALUES(address),
                city = VALUES(city),
                state = VALUES(state),
                pincode = VALUES(pincode),
                nominee_name = VALUES(nominee_name),
                nominee_relation = VALUES(nominee_relation),
                nominee_mobile = VALUES(nominee_mobile),
                status = "Submitted",
                updated_at = NOW()
        ');
        if ($stmt === false) {
            throw new RuntimeException('Failed to prepare Personal KYC save query.');
        }

        if ($stmt->execute([
            $userId, $fullName, $mobile, $dob, $address, $city, $state, $pincode,
            $nomineeName, $nomineeRelation, $nomineeMobile
        ]) === false) {
            throw new RuntimeException('Failed to execute Personal KYC save query.');
        }

        jsonResponse(['success' => true, 'message' => 'Personal KYC submitted successfully.']);
    } catch (Throwable $e) {
        $safeRollback($pdo);
        error_log('[kyc/personal.php][POST] Database error: ' . $e->getMessage());
        if ($isConnectionUnavailable($e)) {
            jsonResponse([
                'success' => false,
                'error' => 'Database connection unavailable while saving Personal KYC.'
            ], 503);
        }
        jsonResponse([
            'success' => false,
            'error' => 'Failed to save Personal KYC due to a server error.'
        ], 500);
    }
}
