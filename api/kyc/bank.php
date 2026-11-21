<?php
/**
 * FaceTube - Bank KYC API
 * GET/POST /api/kyc/bank.php
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
        error_log('[kyc/bank.php][ROLLBACK] Rollback failed: ' . $_rollbackErr->getMessage());
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
    error_log('[kyc/bank.php][AUTH] Database error: ' . $e->getMessage());
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
        $stmt = $pdo->prepare('SELECT * FROM kyc_bank_details WHERE UPPER(user_id) = UPPER(?) LIMIT 1');
        if ($stmt === false) {
            throw new RuntimeException('Failed to prepare Bank KYC lookup query.');
        }
        if ($stmt->execute([$userId]) === false) {
            throw new RuntimeException('Failed to execute Bank KYC lookup query.');
        }
        $row = $stmt->fetch();

        if ($row) {
            jsonResponse([
                'success' => true,
                'kyc' => [
                    'accountHolderName' => $row['account_holder_name'],
                    'bankName' => $row['bank_name'],
                    'accountNumber' => $row['account_number'],
                    'ifscCode' => $row['ifsc_code'],
                    'branchName' => $row['branch_name'],
                    'accountType' => $row['account_type'],
                    'upiId' => $row['upi_id'],
                    'status' => $row['status'],
                    'submittedAt' => $row['created_at'],
                ]
            ]);
        }

        jsonResponse(['success' => true, 'kyc' => null]);
    } catch (Throwable $e) {
        $safeRollback($pdo);
        error_log('[kyc/bank.php][GET] Database error: ' . $e->getMessage());
        if ($isConnectionUnavailable($e)) {
            jsonResponse([
                'success' => false,
                'error' => 'Database connection unavailable while loading Bank KYC.'
            ], 503);
        }
        jsonResponse([
            'success' => false,
            'error' => 'Failed to load Bank KYC due to a server error.'
        ], 500);
    }
} else {
    $input = getRequestPayload();
    $requestedUserId = $readStringField($input['userId'] ?? ($input['user_id'] ?? ''));
    $userId = $resolveTargetUserId($authUser, $requestedUserId);

    $accountHolderName = $readStringField($input['accountHolderName'] ?? ($input['account_holder_name'] ?? ''));
    $bankName = $readStringField($input['bankName'] ?? ($input['bank_name'] ?? ''));
    $accountNumber = $readStringField($input['accountNumber'] ?? ($input['account_number'] ?? ''));
    $ifscCode = $readStringField($input['ifscCode'] ?? ($input['ifsc_code'] ?? ''));
    $branchName = $readStringField($input['branchName'] ?? ($input['branch_name'] ?? ''));
    $accountType = $readStringField($input['accountType'] ?? ($input['account_type'] ?? 'Savings'), 'Savings');
    $upiId = $readStringField($input['upiId'] ?? ($input['upi_id'] ?? ''));

    try {
        $stmt = $pdo->prepare('
            INSERT INTO kyc_bank_details (
                user_id, account_holder_name, bank_name, account_number, ifsc_code,
                branch_name, account_type, upi_id, status, created_at, updated_at
            ) VALUES (
                ?, ?, ?, ?, ?,
                ?, ?, ?, "Submitted", NOW(), NOW()
            )
            ON DUPLICATE KEY UPDATE
                account_holder_name = VALUES(account_holder_name),
                bank_name = VALUES(bank_name),
                account_number = VALUES(account_number),
                ifsc_code = VALUES(ifsc_code),
                branch_name = VALUES(branch_name),
                account_type = VALUES(account_type),
                upi_id = VALUES(upi_id),
                status = "Submitted",
                updated_at = NOW()
        ');
        if ($stmt === false) {
            throw new RuntimeException('Failed to prepare Bank KYC save query.');
        }

        if ($stmt->execute([
            $userId, $accountHolderName, $bankName, $accountNumber, $ifscCode,
            $branchName, $accountType, $upiId
        ]) === false) {
            throw new RuntimeException('Failed to execute Bank KYC save query.');
        }

        jsonResponse(['success' => true, 'message' => 'Bank KYC submitted successfully.']);
    } catch (Throwable $e) {
        $safeRollback($pdo);
        error_log('[kyc/bank.php][POST] Database error: ' . $e->getMessage());
        if ($isConnectionUnavailable($e)) {
            jsonResponse([
                'success' => false,
                'error' => 'Database connection unavailable while saving Bank KYC.'
            ], 503);
        }
        jsonResponse([
            'success' => false,
            'error' => 'Failed to save Bank KYC due to a server error.'
        ], 500);
    }
}
