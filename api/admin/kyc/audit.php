<?php
/**
 * FaceTube - Admin KYC Review Audit History API (Hostinger / cPanel PHP Production)
 * GET /api/admin/kyc/audit.php
 * Strictly restricted to verified administrators.
 */

require_once __DIR__ . '/../../config/database.php';
require_once __DIR__ . '/../../response.php';

if ($_SERVER['REQUEST_METHOD'] !== 'GET') {
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

$userIdFilter = strtoupper(trim($_GET['userId'] ?? ($_GET['user_id'] ?? '')));
$typeFilter = strtolower(trim($_GET['type'] ?? 'all'));
$actionFilter = strtolower(trim($_GET['action'] ?? 'all'));
$page = max(1, (int)($_GET['page'] ?? 1));
$limit = min(100, max(1, (int)($_GET['limit'] ?? 20)));

$allAudit = [];
$seen = [];

// 1. Load from MySQL if table exists
if ($pdo) {
    try {
        $stmt = $pdo->query('
            SELECT id, kyc_type, kyc_id, user_id, action, previous_status, new_status,
                   admin_note, rejection_reason, reviewed_by, reviewed_at, created_at
            FROM kyc_audit_log
            ORDER BY created_at DESC
        ');
        $rows = $stmt ? $stmt->fetchAll(PDO::FETCH_ASSOC) : [];
        foreach ($rows as $r) {
            $id = (string)$r['id'];
            $seen[$id] = true;
            $allAudit[] = [
                'id' => $id,
                'kycType' => (string)$r['kyc_type'],
                'kycId' => (string)$r['kyc_id'],
                'userId' => (string)$r['user_id'],
                'action' => (string)$r['action'],
                'previousStatus' => (string)$r['previous_status'],
                'newStatus' => (string)$r['new_status'],
                'adminNote' => $r['admin_note'] ? (string)$r['admin_note'] : null,
                'rejectionReason' => $r['rejection_reason'] ? (string)$r['rejection_reason'] : null,
                'reviewedBy' => (string)$r['reviewed_by'],
                'reviewedAt' => (string)$r['reviewed_at'],
                'createdAt' => (string)$r['created_at'],
            ];
        }
    } catch (Exception $e) {
        // Table not yet migrated
    }
}

// 2. Load from store file
$storeFile = __DIR__ . '/../../../data/facetube_store.json';
if (file_exists($storeFile)) {
    $store = json_decode(file_get_contents($storeFile), true);
    if (!empty($store['kycAuditLog']) && is_array($store['kycAuditLog'])) {
        foreach ($store['kycAuditLog'] as $r) {
            $id = (string)($r['id'] ?? '');
            if (!empty($id) && empty($seen[$id])) {
                $seen[$id] = true;
                $allAudit[] = [
                    'id' => $id,
                    'kycType' => (string)($r['kycType'] ?? $r['kyc_type'] ?? 'personal'),
                    'kycId' => (string)($r['kycId'] ?? $r['kyc_id'] ?? ''),
                    'userId' => (string)($r['userId'] ?? $r['user_id'] ?? ''),
                    'action' => (string)($r['action'] ?? ''),
                    'previousStatus' => (string)($r['previousStatus'] ?? $r['previous_status'] ?? 'Submitted'),
                    'newStatus' => (string)($r['newStatus'] ?? $r['new_status'] ?? ''),
                    'adminNote' => !empty($r['adminNote']) ? (string)$r['adminNote'] : (!empty($r['admin_note']) ? (string)$r['admin_note'] : null),
                    'rejectionReason' => !empty($r['rejectionReason']) ? (string)$r['rejectionReason'] : (!empty($r['rejection_reason']) ? (string)$r['rejection_reason'] : null),
                    'reviewedBy' => (string)($r['reviewedBy'] ?? $r['reviewed_by'] ?? ''),
                    'reviewedAt' => (string)($r['reviewedAt'] ?? $r['reviewed_at'] ?? ''),
                    'createdAt' => (string)($r['createdAt'] ?? $r['created_at'] ?? ''),
                ];
            }
        }
    }
}

// Filter
$filtered = array_filter($allAudit, function($item) use ($userIdFilter, $typeFilter, $actionFilter) {
    if (!empty($userIdFilter) && strtoupper($item['userId']) !== $userIdFilter) {
        return false;
    }
    if ($typeFilter !== 'all' && strtolower($item['kycType']) !== $typeFilter) {
        return false;
    }
    if ($actionFilter !== 'all' && strtolower($item['action']) !== $actionFilter) {
        return false;
    }
    return true;
});

// Sort newest first
usort($filtered, function($a, $b) {
    return strcmp($b['createdAt'] ?? '', $a['createdAt'] ?? '');
});

$totalItems = count($filtered);
$totalPages = max(1, (int)ceil($totalItems / $limit));
$offset = ($page - 1) * $limit;
$paginated = array_slice($filtered, $offset, $limit);

jsonResponse([
    'success' => true,
    'pagination' => [
        'page' => $page,
        'limit' => $limit,
        'totalItems' => $totalItems,
        'totalPages' => $totalPages,
    ],
    'auditLogs' => array_values($paginated),
]);
