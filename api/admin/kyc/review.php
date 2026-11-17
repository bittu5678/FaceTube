<?php
/**
 * FaceTube - Admin KYC Decision Review API (Hostinger / cPanel PHP Production)
 * POST /api/admin/kyc/review.php
 * Strictly restricted to verified administrators.
 */

require_once __DIR__ . '/../../config/database.php';
require_once __DIR__ . '/../../response.php';

if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    jsonResponse(['success' => false, 'error' => 'Method Not Allowed'], 405);
}

$pdo = getDatabaseConnection();
$authUser = getAuthUser($pdo);

if (!$authUser) {
    jsonResponse([
        'success' => false,
        'error' => 'Authentication required. Please provide a valid Bearer session token.'
    ], 401);
}

if (strtolower($authUser['role'] ?? '') !== 'admin') {
    jsonResponse([
        'success' => false,
        'error' => 'Admin authorization required. Access denied.'
    ], 403);
}

$input = getRequestPayload();
$type = strtolower(trim($input['type'] ?? ''));
$userId = strtoupper(trim($input['userId'] ?? ($input['user_id'] ?? '')));
$decision = strtolower(trim($input['decision'] ?? ''));
$adminNote = trim($input['adminNote'] ?? ($input['admin_note'] ?? ''));
$rejectionReason = trim($input['rejectionReason'] ?? ($input['rejection_reason'] ?? ''));

if (empty($type) || ($type !== 'personal' && $type !== 'bank')) {
    jsonResponse(['success' => false, 'error' => "Invalid or missing KYC type. Must be 'personal' or 'bank'."], 400);
}

if (empty($userId)) {
    jsonResponse(['success' => false, 'error' => 'Target User ID is required.'], 400);
}

if ($decision !== 'approved' && $decision !== 'rejected') {
    jsonResponse(['success' => false, 'error' => "Invalid decision. Must be 'approved' or 'rejected'."], 400);
}

if ($decision === 'rejected' && empty($rejectionReason)) {
    jsonResponse([
        'success' => false,
        'error' => 'Rejection reason is required when rejecting a KYC submission.'
    ], 400);
}

$adminUserId = (string)($authUser['user_id'] ?? 'ADMIN');
$nowIso = gmdate('Y-m-d\TH:i:s\Z');
$newStatus = ($decision === 'approved') ? 'Verified' : 'Rejected';

$targetRecord = null;
$storeFile = __DIR__ . '/../../../data/facetube_store.json';
$store = null;
if (file_exists($storeFile)) {
    $store = json_decode(file_get_contents($storeFile), true);
}

// 1. Locate existing record in MySQL
if ($pdo) {
    try {
        $tableName = ($type === 'personal') ? 'personal_kyc' : 'bank_kyc';
        $stmt = $pdo->prepare("SELECT * FROM {$tableName} WHERE UPPER(user_id) = UPPER(?) LIMIT 1");
        $stmt->execute([$userId]);
        $targetRecord = $stmt->fetch(PDO::FETCH_ASSOC);
    } catch (Exception $e) {
        // Try fallback table
        try {
            $tableName = ($type === 'personal') ? 'kyc_records' : 'kyc_bank_details';
            $stmt = $pdo->prepare("SELECT * FROM {$tableName} WHERE UPPER(user_id) = UPPER(?) LIMIT 1");
            $stmt->execute([$userId]);
            $targetRecord = $stmt->fetch(PDO::FETCH_ASSOC);
        } catch (Exception $e2) {
            // Ignore
        }
    }
}

// 2. Locate existing record in store if MySQL did not find it
if (!$targetRecord && $store) {
    $prop = ($type === 'personal') ? 'personalKyc' : 'bankKyc';
    if (!empty($store[$prop][$userId])) {
        $targetRecord = $store[$prop][$userId];
    }
}

if (!$targetRecord) {
    jsonResponse([
        'success' => false,
        'error' => "No {$type} KYC submission found for user {$userId}."
    ], 404);
}

// Requirement 5: Ensure only records with status 'Submitted' can be reviewed
$currentStatus = (string)($targetRecord['status'] ?? 'Draft');
if (strtolower($currentStatus) !== 'submitted') {
    jsonResponse([
        'success' => false,
        'error' => "Only KYC submissions with status 'Submitted' can be reviewed. Current status is '{$currentStatus}'."
    ], 400);
}

// 3. Update in MySQL Database
if ($pdo) {
    try {
        $tableName = ($type === 'personal') ? 'personal_kyc' : 'bank_kyc';
        // Base update
        $updateStmt = $pdo->prepare("
            UPDATE {$tableName}
            SET status = ?, updated_at = NOW()
            WHERE UPPER(user_id) = UPPER(?)
        ");
        $updateStmt->execute([$newStatus, $userId]);

        // Attempt review columns update (if columns exist)
        try {
            $auditColStmt = $pdo->prepare("
                UPDATE {$tableName}
                SET reviewed_by = ?, reviewed_at = NOW(), admin_note = ?, rejection_reason = ?
                WHERE UPPER(user_id) = UPPER(?)
            ");
            $auditColStmt->execute([
                $adminUserId,
                $adminNote ?: null,
                ($decision === 'rejected') ? $rejectionReason : null,
                $userId
            ]);
        } catch (Exception $colEx) {
            // Review columns not yet migrated; status update above was preserved
        }

        // Attempt writing to kyc_audit_log
        try {
            $auditId = 'kyc_audit_' . time() . '_' . bin2hex(random_bytes(4));
            $logStmt = $pdo->prepare('
                INSERT INTO kyc_audit_log (
                    id, kyc_type, kyc_id, user_id, action, previous_status, new_status,
                    admin_note, rejection_reason, reviewed_by, reviewed_at, created_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW())
            ');
            $logStmt->execute([
                $auditId,
                $type,
                $targetRecord['id'] ?? ($type . '_' . $userId),
                $userId,
                $decision,
                $currentStatus,
                $newStatus,
                $adminNote ?: null,
                ($decision === 'rejected') ? $rejectionReason : null,
                $adminUserId
            ]);
        } catch (Exception $logEx) {
            // Audit table optional until migration executed
        }
    } catch (Exception $dbEx) {
        // Fallback to json if DB write failed
    }
}

// 4. Update in local/preview JSON store
$auditEntry = [
    'id' => 'kyc_audit_' . time() . '_' . bin2hex(random_bytes(4)),
    'kycType' => $type,
    'userId' => $userId,
    'action' => $decision,
    'previousStatus' => $currentStatus,
    'newStatus' => $newStatus,
    'adminNote' => $adminNote ?: null,
    'rejectionReason' => ($decision === 'rejected') ? $rejectionReason : null,
    'reviewedBy' => $adminUserId,
    'reviewedAt' => $nowIso,
    'createdAt' => $nowIso,
];

if ($store) {
    $prop = ($type === 'personal') ? 'personalKyc' : 'bankKyc';
    if (!isset($store[$prop])) $store[$prop] = [];
    if (!isset($store[$prop][$userId])) $store[$prop][$userId] = $targetRecord;

    $store[$prop][$userId]['status'] = $newStatus;
    $store[$prop][$userId]['reviewedBy'] = $adminUserId;
    $store[$prop][$userId]['reviewedAt'] = $nowIso;
    $store[$prop][$userId]['adminNote'] = $adminNote ?: null;
    $store[$prop][$userId]['rejectionReason'] = ($decision === 'rejected') ? $rejectionReason : null;
    $store[$prop][$userId]['updatedAt'] = $nowIso;

    if (!isset($store['kycAuditLog'])) $store['kycAuditLog'] = [];
    array_unshift($store['kycAuditLog'], $auditEntry);

    file_put_contents($storeFile, json_encode($store, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES));
}

$updatedKyc = is_array($targetRecord) ? array_merge($targetRecord, [
    'status' => $newStatus,
    'reviewedBy' => $adminUserId,
    'reviewedAt' => $nowIso,
    'adminNote' => $adminNote ?: null,
    'rejectionReason' => ($decision === 'rejected') ? $rejectionReason : null,
    'updatedAt' => $nowIso,
]) : null;

jsonResponse([
    'success' => true,
    'message' => "KYC {$type} submission for user {$userId} has been {$newStatus} successfully.",
    'decision' => $decision,
    'status' => $newStatus,
    'kyc' => $updatedKyc,
    'audit' => $auditEntry,
]);
